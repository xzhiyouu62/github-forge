// Model Context Protocol endpoint (/mcp): JSON-RPC 2.0 over POST, speaking both the modern
// server/discover era (2026-07-28) and the legacy initialize handshake. The six tools mirror
// the REST surface over the same store, so anything created here is visible there.

import { Forge, VIEWER, type Repo } from './store.ts';
import { repoJson, issueJson, pullJson, squashMerge } from './rest.ts';
import { isAncestor } from './gitobj.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const CAPABILITIES = { tools: { listChanged: false } };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The name of the repository.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get the details of a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the issue.' },
      body: { type: 'string', description: 'The body of the issue.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a new pull request in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the pull request.' },
      head: { type: 'string', description: 'The name of the branch to merge from.' },
      base: { type: 'string', description: 'The name of the branch to merge into.' },
      body: { type: 'string', description: 'The body of the pull request.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by squashing its commits onto the base branch.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      pull_number: { type: 'number', description: 'The number of the pull request to merge.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

export interface McpHttpResult {
  status: number;
  body?: unknown;
}

type Json = Record<string, unknown>;

function rpcResult(id: unknown, result: unknown): Json {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolOk(payload: unknown): Json {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Json,
    isError: false,
  };
}

function toolErr(message: string): Json {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function needRepo(forge: Forge, args: Json): Repo | null {
  return forge.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
}

function callTool(forge: Forge, name: string, args: Json): Json {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) throw new ToolRpcError(INVALID_PARAMS, `Unknown tool: ${name}`);
  for (const key of def.required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      throw new ToolRpcError(INVALID_PARAMS, `Missing required argument: ${key}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (forge.getRepo(VIEWER.login, repoName)) return toolErr(`Repository ${repoName} already exists`);
      const repo = forge.createRepo(repoName, {
        description: typeof args.description === 'string' ? args.description : null,
        isPrivate: args.private === true,
      });
      return toolOk(repoJson(repo));
    }
    case 'get_repo': {
      const repo = needRepo(forge, args);
      if (!repo) return toolErr('Repository not found');
      return toolOk(repoJson(repo));
    }
    case 'create_issue': {
      const repo = needRepo(forge, args);
      if (!repo) return toolErr('Repository not found');
      const issue = forge.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : null, []);
      return toolOk(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = needRepo(forge, args);
      if (!repo) return toolErr('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = [...repo.issues.values()]
        .filter((i) => !i.pullRequest)
        .filter((i) => state === 'all' || i.state === state)
        .sort((a, b) => b.number - a.number)
        .map((i) => issueJson(repo, i));
      return toolOk(list);
    }
    case 'create_pull_request': {
      const repo = needRepo(forge, args);
      if (!repo) return toolErr('Repository not found');
      const head = String(args.head).replace(/^refs\/heads\//, '');
      const base = String(args.base).replace(/^refs\/heads\//, '');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return toolErr('Head or base branch does not exist');
      if (headSha === baseSha || isAncestor(forge.store, headSha, baseSha)) {
        return toolErr('No commits between base and head');
      }
      const issue = forge.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : null, []);
      issue.pullRequest = {
        number: issue.number, headRef: head, headSha, baseRef: base, baseSha,
        merged: false, mergedAt: null, mergeCommitSha: null, draft: false,
      };
      return toolOk(pullJson(forge, repo, issue));
    }
    case 'merge_pull_request': {
      const repo = needRepo(forge, args);
      if (!repo) return toolErr('Repository not found');
      const issue = repo.issues.get(Number(args.pull_number));
      if (!issue || !issue.pullRequest) return toolErr('Pull request not found');
      const result = squashMerge(forge, repo, issue);
      if (!result.ok) return toolErr(result.reason ?? 'Pull request is not mergeable');
      return toolOk(pullJson(forge, repo, issue));
    }
  }
  return toolErr('Unsupported tool');
}

class ToolRpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function handleOne(forge: Forge, msg: Json): Json | null {
  const id = msg.id;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const params = (msg.params ?? {}) as Json;
  const isNotification = id === undefined;
  if (isNotification) return null; // notifications get no response body

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        serverInfo: SERVER_INFO,
        capabilities: CAPABILITIES,
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion: version, capabilities: CAPABILITIES, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: { type: 'object', properties: t.properties, required: t.required },
        })),
      });
    case 'tools/call': {
      const toolName = String(params.name ?? '');
      const args = (params.arguments ?? {}) as Json;
      try {
        return rpcResult(id, callTool(forge, toolName, args));
      } catch (e) {
        if (e instanceof ToolRpcError) return rpcError(id, e.code, e.message);
        throw e;
      }
    }
    default:
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/** Handle one MCP HTTP body. Malformed JSON is a 400 with a -32700 parse error. */
export function handleMcp(forge: Forge, rawText: string): McpHttpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { status: 400, body: rpcError(null, PARSE_ERROR, 'Parse error') };
  }
  if (Array.isArray(parsed)) {
    const responses = parsed
      .map((msg) => handleOne(forge, (msg ?? {}) as Json))
      .filter((r) => r !== null);
    return { status: 200, body: responses };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { status: 400, body: rpcError(null, INVALID_REQUEST, 'Invalid request') };
  }
  const response = handleOne(forge, parsed as Json);
  if (response === null) return { status: 202 };
  return { status: 200, body: response };
}
