// GraphQL v4 subset: a small parser, a schema for the forge's types, validation of field
// existence (GitHub answers unknown fields with an errors array), and an executor covering
// the documents gh and github-mcp-server send: viewer, repository, issues/pullRequests
// connections with cursor pagination, node(id:), introspection of the named types, and the
// issue/pull-request/comment mutations.

import { Forge, VIEWER, type Repo, type Issue } from './store.ts';
import { planSquash, squashMerge, prFiles } from './rest.ts';
import { isAncestor } from './gitobj.ts';

// ---------- global ids ----------

export function gid(type: string, key: string | number): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64url');
}

export function parseGid(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const idx = text.indexOf(':');
    if (idx < 0) return null;
    return { type: text.slice(0, idx), key: text.slice(idx + 1) };
  } catch {
    return null;
  }
}

// ---------- parser ----------

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'int' | 'float' | 'string' | 'enum'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: [string, Value][] };

interface FieldNode {
  kind: 'field';
  name: string;
  alias?: string;
  args: [string, Value][];
  selections: Selection[];
}

type Selection = FieldNode | { kind: 'fragment'; typeCondition: string; selections: Selection[] };

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  selections: Selection[];
}

class Lexer {
  #src: string;
  #i = 0;
  constructor(src: string) { this.#src = src; }

  #skip(): void {
    for (;;) {
      const c = this.#src[this.#i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { this.#i += 1; continue; }
      if (c === '#') { while (this.#i < this.#src.length && this.#src[this.#i] !== '\n') this.#i += 1; continue; }
      break;
    }
  }

  peek(): string {
    this.#skip();
    return this.#src[this.#i] ?? '';
  }

  next(): string {
    this.#skip();
    const c = this.#src[this.#i];
    if (c === undefined) throw new Error('unexpected end of document');
    if ('{}()[]:!$=@'.includes(c) || c === '|') { this.#i += 1; return c; }
    if (c === '.') {
      if (this.#src.startsWith('...', this.#i)) { this.#i += 3; return '...'; }
      throw new Error('unexpected .');
    }
    if (c === '"') {
      if (this.#src.startsWith('"""', this.#i)) {
        const end = this.#src.indexOf('"""', this.#i + 3);
        const text = this.#src.slice(this.#i + 3, end);
        this.#i = end + 3;
        return `"${text}"`;
      }
      let j = this.#i + 1;
      let out = '';
      while (this.#src[j] !== '"') {
        if (this.#src[j] === '\\') { out += this.#src[j] + this.#src[j + 1]; j += 2; }
        else { out += this.#src[j]; j += 1; }
      }
      this.#i = j + 1;
      return `"${out}"`;
    }
    const m = /^[A-Za-z0-9_-]+/.exec(this.#src.slice(this.#i));
    if (!m) throw new Error(`unexpected character ${c}`);
    this.#i += m[0].length;
    return m[0];
  }
}

function parseValue(lex: Lexer): Value {
  const t = lex.next();
  if (t === '$') return { kind: 'var', name: lex.next() };
  if (t === '[') {
    const items: Value[] = [];
    while (lex.peek() !== ']') items.push(parseValue(lex));
    lex.next();
    return { kind: 'list', items };
  }
  if (t === '{') {
    const fields: [string, Value][] = [];
    while (lex.peek() !== '}') {
      const name = lex.next();
      lex.next(); // ':'
      fields.push([name, parseValue(lex)]);
    }
    lex.next();
    return { kind: 'object', fields };
  }
  if (t.startsWith('"')) return { kind: 'string', value: JSON.parse(t) as string };
  if (t === 'true') return { kind: 'bool', value: true };
  if (t === 'false') return { kind: 'bool', value: false };
  if (t === 'null') return { kind: 'null' };
  if (/^-?\d+$/.test(t)) return { kind: 'int', value: t };
  if (/^-?\d*\.\d+/.test(t)) return { kind: 'float', value: t };
  return { kind: 'enum', value: t };
}

function parseSelections(lex: Lexer): Selection[] {
  const out: Selection[] = [];
  lex.next(); // '{'
  while (lex.peek() !== '}') out.push(parseSelection(lex));
  lex.next(); // '}'
  return out;
}

function parseSelection(lex: Lexer): Selection {
  const first = lex.next();
  if (first === '...') {
    const on = lex.next();
    if (on !== 'on') throw new Error('named fragments are not supported');
    const typeCondition = lex.next();
    return { kind: 'fragment', typeCondition, selections: parseSelections(lex) };
  }
  let name = first;
  let alias: string | undefined;
  if (lex.peek() === ':') {
    lex.next();
    alias = name;
    name = lex.next();
  }
  const args: [string, Value][] = [];
  if (lex.peek() === '(') {
    lex.next();
    while (lex.peek() !== ')') {
      const argName = lex.next();
      lex.next(); // ':'
      args.push([argName, parseValue(lex)]);
    }
    lex.next();
  }
  let selections: Selection[] = [];
  if (lex.peek() === '{') selections = parseSelections(lex);
  return { kind: 'field', name, alias, args, selections };
}

function skipVariableDefinitions(lex: Lexer): void {
  if (lex.peek() !== '(') return;
  lex.next();
  let depth = 1;
  while (depth > 0) {
    const t = lex.next();
    if (t === '(' || t === '[' || t === '{') depth += 1;
    else if (t === ')' || t === ']' || t === '}') depth -= 1;
  }
}

export function parseDocument(src: string): Operation[] {
  const lex = new Lexer(src);
  const ops: Operation[] = [];
  while (lex.peek() !== '') {
    const head = lex.peek();
    if (head === '{') {
      ops.push({ type: 'query', selections: parseSelections(lex) });
      continue;
    }
    const keyword = lex.next();
    if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
      let name: string | undefined;
      if (/^[A-Za-z_]/.test(lex.peek())) name = lex.next();
      skipVariableDefinitions(lex);
      // directives (none in the suite's documents) would sit here; parse selections next.
      ops.push({ type: keyword === 'mutation' ? 'mutation' : 'query', name, selections: parseSelections(lex) });
    } else if (keyword === 'fragment') {
      // Named fragments: skip the definition (unused by the suite's documents).
      lex.next(); // name
      lex.next(); // 'on'
      lex.next(); // type
      parseSelections(lex);
    } else {
      throw new Error(`unexpected token ${keyword}`);
    }
  }
  return ops;
}

// ---------- introspection data ----------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'search', 'rateLimit', 'organization', 'user'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'deleteIssue'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'avatarUrl', 'createdAt', 'updatedAt', 'repositories', 'issues', 'pullRequests', 'followers', 'following'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'isFork', 'viewerPermission', 'hasIssuesEnabled', 'defaultBranchRef', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'pushedAt', 'url', 'resourcePath', 'stargazerCount', 'forkCount', 'labels', 'refs', 'object', 'primaryLanguage', 'homepageUrl'],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'bodyText', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'url', 'resourcePath', 'repository', 'viewerCanUpdate', 'assignees', 'milestone', 'locked'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergedBy', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'url', 'resourcePath', 'repository', 'mergeCommit', 'additions', 'deletions', 'changedFiles', 'isDraft', 'labels', 'commits'],
  Comment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Ref: ['name', 'prefix', 'target', 'repository', 'associatedPullRequests'],
  Commit: ['id', 'oid', 'message', 'messageHeadline', 'tree', 'parents', 'author', 'committer', 'authoredDate', 'committedDate', 'url'],
  Label: ['id', 'name', 'color', 'description', 'url'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Tree: ['id', 'oid', 'entries'],
  Blob: ['id', 'oid', 'text', 'byteSize', 'isTruncated'],
};

const ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

// ---------- payloads ----------

type Payload = Record<string, unknown> & { __typename: string };

const userPayload = (): Payload => ({ __typename: 'User' });

function repoPayload(repo: Repo): Payload {
  return { __typename: 'Repository', repo };
}

function issuePayload(repo: Repo, issue: Issue): Payload {
  return { __typename: issue.pullRequest ? 'PullRequest' : 'Issue', repo, issue };
}

function commentPayload(repo: Repo, issue: Issue, commentId: number): Payload {
  const comment = issue.comments.find((c) => c.id === commentId)!;
  return { __typename: 'IssueComment', repo, issue, comment };
}

// ---------- connections ----------

function cursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function decodeCursor(after: unknown): number {
  if (typeof after !== 'string') return -1;
  try {
    const text = Buffer.from(after, 'base64url').toString('utf8');
    const n = Number(text.replace('cursor:', ''));
    return Number.isInteger(n) ? n : -1;
  } catch {
    return -1;
  }
}

interface ConnArgs { first?: number; after?: string }

function makeConnection(typeName: string, edgeType: string, all: Payload[], args: ConnArgs): Payload {
  const start = decodeCursor(args.after) + 1;
  const first = typeof args.first === 'number' ? args.first : all.length;
  const window = all.slice(start, start + first);
  const pageInfo: Payload = {
    __typename: 'PageInfo',
    hasNextPage: start + window.length < all.length,
    hasPreviousPage: start > 0,
    startCursor: window.length > 0 ? cursor(start) : null,
    endCursor: window.length > 0 ? cursor(start + window.length - 1) : null,
  };
  return {
    __typename: typeName,
    __nodes: window,
    __edges: window.map((node, i) => ({ __typename: edgeType, node, cursor: cursor(start + i) })),
    __pageInfo: pageInfo,
    __total: all.length,
  };
}

// ---------- schema ----------

class GqlError extends Error {}

interface Ctx { forge: Forge }

type Resolver = (parent: Payload, args: Record<string, unknown>, ctx: Ctx) => unknown;
interface FieldDef { type: string; resolve?: Resolver }

const F = (type: string, resolve?: Resolver): FieldDef => ({ type, resolve });

function findIssueByGlobalId(forge: Forge, key: string): { repo: Repo; issue: Issue } | null {
  const id = Number(key);
  for (const repo of forge.repos.values()) {
    for (const issue of repo.issues.values()) {
      if (issue.id === id) return { repo, issue };
    }
  }
  return null;
}

function findRepoByDbId(forge: Forge, key: string): Repo | null {
  const id = Number(key);
  for (const repo of forge.repos.values()) if (repo.id === id) return repo;
  return null;
}

function issueStateGql(issue: Issue): string {
  if (issue.pullRequest?.merged) return 'MERGED';
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function sortIssues(list: Issue[], args: Record<string, unknown>): Issue[] {
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const dir = orderBy.direction === 'ASC' ? 1 : -1;
  return [...list].sort((a, b) => {
    const byTime = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number;
    return byTime * dir;
  });
}

function stateFilter(list: Issue[], args: Record<string, unknown>, isPull: boolean): Issue[] {
  const states = (args.states as string[] | undefined) ?? ['OPEN'];
  return list.filter((i) => states.includes(issueStateGql(i)) || (!isPull && states.includes(i.state.toUpperCase())));
}

const SCHEMA: Record<string, Record<string, FieldDef>> = {
  Query: {
    viewer: F('User', () => userPayload()),
    repository: F('Repository', (_p, args, ctx) => {
      const repo = ctx.forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? repoPayload(repo) : null;
    }),
    node: F('Node', (_p, args, ctx) => resolveNode(ctx.forge, String(args.id ?? ''))),
    __type: F('__Type', (_p, args) => ({ __typename: '__Type', name: String(args.name ?? '') })),
    __schema: F('__Schema', () => ({ __typename: '__Schema' })),
  },
  Mutation: {
    createIssue: F('CreateIssuePayload', (_p, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.repositoryId ?? ''));
      const repo = parsed ? findRepoByDbId(ctx.forge, parsed.key) : null;
      if (!repo) throw new GqlError('Could not resolve to a Repository with the given id.');
      const labels: string[] = [];
      if (Array.isArray(input.labelIds)) {
        for (const lid of input.labelIds as string[]) {
          const lp = parseGid(lid);
          if (lp && lp.type === 'Label') labels.push(lp.key.split(':').slice(1).join(':'));
        }
      }
      const issue = ctx.forge.createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : null, labels);
      return { __typename: 'CreateIssuePayload', issue: issuePayload(repo, issue), clientMutationId: input.clientMutationId ?? null };
    }),
    closeIssue: F('CloseIssuePayload', (_p, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.issueId ?? ''));
      const found = parsed ? findIssueByGlobalId(ctx.forge, parsed.key) : null;
      if (!found) throw new GqlError('Could not resolve to an Issue with the given id.');
      found.issue.state = 'closed';
      found.issue.updatedAt = ctx.forge.nowIso();
      return { __typename: 'CloseIssuePayload', issue: issuePayload(found.repo, found.issue), clientMutationId: input.clientMutationId ?? null };
    }),
    createPullRequest: F('CreatePullRequestPayload', (_p, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.repositoryId ?? ''));
      const repo = parsed ? findRepoByDbId(ctx.forge, parsed.key) : null;
      if (!repo) throw new GqlError('Could not resolve to a Repository with the given id.');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) throw new GqlError('Head or base ref does not exist.');
      if (headSha === baseSha || isAncestor(ctx.forge.store, headSha, baseSha)) {
        throw new GqlError('No commits between base and head.');
      }
      const issue = ctx.forge.createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : null, []);
      issue.pullRequest = {
        number: issue.number, headRef: head, headSha, baseRef: base, baseSha,
        merged: false, mergedAt: null, mergeCommitSha: null, draft: input.draft === true,
      };
      return { __typename: 'CreatePullRequestPayload', pullRequest: issuePayload(repo, issue), clientMutationId: input.clientMutationId ?? null };
    }),
    mergePullRequest: F('MergePullRequestPayload', (_p, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.pullRequestId ?? ''));
      const found = parsed ? findIssueByGlobalId(ctx.forge, parsed.key) : null;
      if (!found || !found.issue.pullRequest) throw new GqlError('Could not resolve to a PullRequest with the given id.');
      const result = squashMerge(ctx.forge, found.repo, found.issue);
      if (!result.ok) throw new GqlError(result.reason ?? 'Pull request is not mergeable.');
      return { __typename: 'MergePullRequestPayload', pullRequest: issuePayload(found.repo, found.issue), clientMutationId: input.clientMutationId ?? null };
    }),
    addComment: F('AddCommentPayload', (_p, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.subjectId ?? ''));
      const found = parsed ? findIssueByGlobalId(ctx.forge, parsed.key) : null;
      if (!found) throw new GqlError('Could not resolve to a subject with the given id.');
      const comment = ctx.forge.createComment(found.repo, found.issue, String(input.body ?? ''));
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node: commentPayload(found.repo, found.issue, comment.id), cursor: cursor(0) },
        subject: issuePayload(found.repo, found.issue),
        clientMutationId: input.clientMutationId ?? null,
      };
    }),
  },
  User: {
    id: F('ID', () => gid('User', VIEWER.id)),
    databaseId: F('Int', () => VIEWER.id),
    login: F('String', () => VIEWER.login),
    name: F('String', () => VIEWER.name),
    email: F('String', () => VIEWER.email),
    url: F('URI', () => `/${VIEWER.login}`),
    avatarUrl: F('URI', () => ''),
    createdAt: F('DateTime', () => '2025-01-01T00:00:00Z'),
    updatedAt: F('DateTime', () => '2025-01-01T00:00:00Z'),
  },
  Repository: {
    id: F('ID', (p) => gid('Repository', (p.repo as Repo).id)),
    databaseId: F('Int', (p) => (p.repo as Repo).id),
    name: F('String', (p) => (p.repo as Repo).name),
    nameWithOwner: F('String', (p) => `${(p.repo as Repo).owner}/${(p.repo as Repo).name}`),
    description: F('String', (p) => (p.repo as Repo).description),
    isPrivate: F('Boolean', (p) => (p.repo as Repo).isPrivate),
    isFork: F('Boolean', () => false),
    owner: F('User', () => userPayload()),
    viewerPermission: F('String', () => 'ADMIN'),
    hasIssuesEnabled: F('Boolean', () => true),
    createdAt: F('DateTime', (p) => (p.repo as Repo).createdAt),
    updatedAt: F('DateTime', (p) => (p.repo as Repo).updatedAt),
    pushedAt: F('DateTime', (p) => (p.repo as Repo).updatedAt),
    url: F('URI', (p) => `/${(p.repo as Repo).owner}/${(p.repo as Repo).name}`),
    resourcePath: F('URI', (p) => `/${(p.repo as Repo).owner}/${(p.repo as Repo).name}`),
    stargazerCount: F('Int', () => 0),
    forkCount: F('Int', () => 0),
    defaultBranchRef: F('Ref', (p) => {
      const repo = p.repo as Repo;
      const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
      return { __typename: 'Ref', repo, name: repo.defaultBranch, sha };
    }),
    issue: F('Issue', (p, args) => {
      const repo = p.repo as Repo;
      const issue = repo.issues.get(Number(args.number));
      return issue && !issue.pullRequest ? issuePayload(repo, issue) : null;
    }),
    issues: F('IssueConnection', (p, args) => {
      const repo = p.repo as Repo;
      const list = stateFilter([...repo.issues.values()].filter((i) => !i.pullRequest), args, false);
      return makeConnection('IssueConnection', 'IssueEdge', sortIssues(list, args).map((i) => issuePayload(repo, i)), args as ConnArgs);
    }),
    pullRequest: F('PullRequest', (p, args) => {
      const repo = p.repo as Repo;
      const issue = repo.issues.get(Number(args.number));
      return issue && issue.pullRequest ? issuePayload(repo, issue) : null;
    }),
    pullRequests: F('PullRequestConnection', (p, args) => {
      const repo = p.repo as Repo;
      const list = stateFilter([...repo.issues.values()].filter((i) => i.pullRequest), args, true);
      return makeConnection('PullRequestConnection', 'PullRequestEdge', sortIssues(list, args).map((i) => issuePayload(repo, i)), args as ConnArgs);
    }),
  },
  Issue: {},
  PullRequest: {},
  IssueComment: {
    id: F('ID', (p) => gid('IssueComment', (p.comment as { id: number }).id)),
    databaseId: F('Int', (p) => (p.comment as { id: number }).id),
    body: F('String', (p) => (p.comment as { body: string }).body),
    author: F('User', () => userPayload()),
    createdAt: F('DateTime', (p) => (p.comment as { createdAt: string }).createdAt),
    updatedAt: F('DateTime', (p) => (p.comment as { updatedAt: string }).updatedAt),
    url: F('URI', () => ''),
  },
  Ref: {
    name: F('String', (p) => p.name as string),
    prefix: F('String', () => 'refs/heads/'),
    target: F('GitObject', (p) => (p.sha ? { __typename: 'Commit', sha: p.sha as string } : null)),
    repository: F('Repository', (p) => repoPayload(p.repo as Repo)),
  },
  Commit: {
    id: F('ID', (p) => gid('Commit', p.sha as string)),
    oid: F('GitObjectID', (p) => p.sha as string),
    message: F('String', () => ''),
    messageHeadline: F('String', () => ''),
  },
  __Type: {
    name: F('String', (p) => p.name as string),
    kind: F('String', (p) => typeKind(p.name as string)),
    description: F('String', () => null),
    fields: F('[__Field]', (p) => {
      const fields = TYPE_FIELDS[p.name as string];
      return fields ? fields.map((name) => ({ __typename: '__Field', name })) : null;
    }),
    enumValues: F('[__EnumValue]', (p) => {
      const values = ENUMS[p.name as string];
      return values ? values.map((name) => ({ __typename: '__EnumValue', name })) : null;
    }),
    possibleTypes: F('[__Type]', () => null),
    inputFields: F('[__InputValue]', () => null),
    ofType: F('__Type', () => null),
    specifiedByURL: F('String', () => null),
  },
  __Field: {
    name: F('String', (p) => p.name as string),
    description: F('String', () => null),
    isDeprecated: F('Boolean', () => false),
    deprecationReason: F('String', () => null),
  },
  __EnumValue: {
    name: F('String', (p) => p.name as string),
    description: F('String', () => null),
    isDeprecated: F('Boolean', () => false),
    deprecationReason: F('String', () => null),
  },
  __Schema: {
    queryType: F('__Type', () => ({ __typename: '__Type', name: 'Query' })),
    mutationType: F('__Type', () => ({ __typename: '__Type', name: 'Mutation' })),
    subscriptionType: F('__Type', () => null),
    types: F('[__Type]', () => Object.keys(TYPE_FIELDS).map((name) => ({ __typename: '__Type', name }))),
    directives: F('[__Directive]', () => []),
  },
  PageInfo: {
    hasNextPage: F('Boolean'),
    hasPreviousPage: F('Boolean'),
    startCursor: F('String'),
    endCursor: F('String'),
  },
  Node: {
    id: F('ID'),
  },
  CreateIssuePayload: { issue: F('Issue'), clientMutationId: F('String') },
  CloseIssuePayload: { issue: F('Issue'), clientMutationId: F('String') },
  CreatePullRequestPayload: { pullRequest: F('PullRequest'), clientMutationId: F('String') },
  MergePullRequestPayload: { pullRequest: F('PullRequest'), clientMutationId: F('String') },
  AddCommentPayload: { commentEdge: F('IssueCommentEdge'), subject: F('Issue'), clientMutationId: F('String') },
};

// Issue and PullRequest share most fields; fill both from one table.
const issueFields: Record<string, FieldDef> = {
  id: F('ID', (p) => gid((p.issue as Issue).pullRequest ? 'PullRequest' : 'Issue', (p.issue as Issue).id)),
  databaseId: F('Int', (p) => (p.issue as Issue).id),
  number: F('Int', (p) => (p.issue as Issue).number),
  title: F('String', (p) => (p.issue as Issue).title),
  body: F('String', (p) => (p.issue as Issue).body ?? ''),
  bodyText: F('String', (p) => (p.issue as Issue).body ?? ''),
  state: F('String', (p) => issueStateGql(p.issue as Issue)),
  author: F('User', () => userPayload()),
  createdAt: F('DateTime', (p) => (p.issue as Issue).createdAt),
  updatedAt: F('DateTime', (p) => (p.issue as Issue).updatedAt),
  closedAt: F('DateTime', (p) => ((p.issue as Issue).state === 'closed' ? (p.issue as Issue).updatedAt : null)),
  url: F('URI', (p) => `/api/v3/repos/${(p.repo as Repo).owner}/${(p.repo as Repo).name}/issues/${(p.issue as Issue).number}`),
  resourcePath: F('URI', (p) => `/${(p.repo as Repo).owner}/${(p.repo as Repo).name}/issues/${(p.issue as Issue).number}`),
  repository: F('Repository', (p) => repoPayload(p.repo as Repo)),
  viewerCanUpdate: F('Boolean', () => true),
  locked: F('Boolean', () => false),
  labels: F('LabelConnection', (p, args) => {
    const repo = p.repo as Repo;
    const issue = p.issue as Issue;
    const nodes = issue.labels
      .map((name) => repo.labels.get(name))
      .filter((l) => l !== undefined)
      .map((l) => ({ __typename: 'Label', repo, label: l }));
    return makeConnection('LabelConnection', 'LabelEdge', nodes, args as ConnArgs);
  }),
  comments: F('IssueCommentConnection', (p, args) => {
    const repo = p.repo as Repo;
    const issue = p.issue as Issue;
    const nodes = issue.comments.map((c) => commentPayload(repo, issue, c.id));
    return makeConnection('IssueCommentConnection', 'IssueCommentEdge', nodes, args as ConnArgs);
  }),
};
SCHEMA.Issue = { ...issueFields };
SCHEMA.PullRequest = {
  ...issueFields,
  merged: F('Boolean', (p) => (p.issue as Issue).pullRequest!.merged),
  mergedAt: F('DateTime', (p) => (p.issue as Issue).pullRequest!.mergedAt),
  mergedBy: F('User', (p) => ((p.issue as Issue).pullRequest!.merged ? userPayload() : null)),
  isDraft: F('Boolean', (p) => (p.issue as Issue).pullRequest!.draft),
  headRefName: F('String', (p) => (p.issue as Issue).pullRequest!.headRef),
  baseRefName: F('String', (p) => (p.issue as Issue).pullRequest!.baseRef),
  headRef: F('Ref', (p) => {
    const repo = p.repo as Repo;
    const pr = (p.issue as Issue).pullRequest!;
    return { __typename: 'Ref', repo, name: pr.headRef, sha: repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha };
  }),
  baseRef: F('Ref', (p) => {
    const repo = p.repo as Repo;
    const pr = (p.issue as Issue).pullRequest!;
    return { __typename: 'Ref', repo, name: pr.baseRef, sha: repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha };
  }),
  mergeable: F('String', (p, _a, ctx) => {
    const repo = p.repo as Repo;
    const issue = p.issue as Issue;
    const pr = issue.pullRequest!;
    if (pr.merged) return null;
    const headSha = repo.refs.get(`refs/heads/${pr.headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${pr.baseRef}`);
    if (!headSha || !baseSha) return 'UNKNOWN';
    return planSquash(ctx.forge, repo, baseSha, headSha).ok ? 'MERGEABLE' : 'CONFLICTING';
  }),
  mergeCommit: F('Commit', (p) => {
    const sha = (p.issue as Issue).pullRequest!.mergeCommitSha;
    return sha ? { __typename: 'Commit', sha } : null;
  }),
  files: F('PullRequestChangedFileConnection', (p, args, ctx) => {
    const repo = p.repo as Repo;
    const issue = p.issue as Issue;
    const nodes = prFiles(ctx.forge, repo, issue).map((f) => ({
      __typename: 'PullRequestChangedFile',
      path: f.filename as string,
      additions: f.additions as number,
      deletions: f.deletions as number,
      changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'DELETED' : 'MODIFIED',
    }));
    return makeConnection('PullRequestChangedFileConnection', 'PullRequestChangedFileEdge', nodes, args as ConnArgs);
  }),
  additions: F('Int', (p, _a, ctx) => prFiles(ctx.forge, p.repo as Repo, p.issue as Issue).reduce((s, f) => s + (f.additions as number), 0)),
  deletions: F('Int', (p, _a, ctx) => prFiles(ctx.forge, p.repo as Repo, p.issue as Issue).reduce((s, f) => s + (f.deletions as number), 0)),
  changedFiles: F('Int', (p, _a, ctx) => prFiles(ctx.forge, p.repo as Repo, p.issue as Issue).length),
};
SCHEMA.Label = {
  id: F('ID', (p) => gid('Label', `${(p.repo as Repo).id}:${(p.label as { name: string }).name}`)),
  name: F('String', (p) => (p.label as { name: string }).name),
  color: F('String', (p) => (p.label as { color: string }).color),
  description: F('String', (p) => (p.label as { description: string | null }).description),
};

// Connection types resolve through the __nodes/__edges/__pageInfo/__total slots.
for (const [conn, edge, nodeType] of [
  ['IssueConnection', 'IssueEdge', 'Issue'], ['PullRequestConnection', 'PullRequestEdge', 'PullRequest'],
  ['LabelConnection', 'LabelEdge', 'Label'], ['IssueCommentConnection', 'IssueCommentEdge', 'IssueComment'],
  ['PullRequestChangedFileConnection', 'PullRequestChangedFileEdge', 'PullRequestChangedFile'],
] as const) {
  SCHEMA[conn] = {
    nodes: F(`[${nodeType}]`, (p) => p.__nodes as Payload[]),
    edges: F(`[${edge}]`, (p) => p.__edges as Payload[]),
    pageInfo: F('PageInfo', (p) => p.__pageInfo as Payload),
    totalCount: F('Int', (p) => p.__total as number),
  };
  SCHEMA[edge] = { node: F(nodeType), cursor: F('String') };
}
SCHEMA.PullRequestChangedFile = {
  path: F('String'),
  additions: F('Int'),
  deletions: F('Int'),
  changeType: F('String'),
};

function typeKind(name: string): string {
  if (ENUMS[name]) return 'ENUM';
  if (name === 'Node') return 'INTERFACE';
  if (TYPE_FIELDS[name] || SCHEMA[name]) return 'OBJECT';
  if (['String', 'Int', 'Float', 'Boolean', 'ID'].includes(name)) return 'SCALAR';
  return 'OBJECT';
}

function resolveNode(forge: Forge, id: string): Payload | null {
  const parsed = parseGid(id);
  if (!parsed) return null;
  if (parsed.type === 'Repository') {
    const repo = findRepoByDbId(forge, parsed.key);
    return repo ? repoPayload(repo) : null;
  }
  if (parsed.type === 'User') return userPayload();
  if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
    const found = findIssueByGlobalId(forge, parsed.key);
    return found ? issuePayload(found.repo, found.issue) : null;
  }
  if (parsed.type === 'IssueComment') {
    const cid = Number(parsed.key);
    for (const repo of forge.repos.values()) {
      for (const issue of repo.issues.values()) {
        if (issue.comments.some((c) => c.id === cid)) return commentPayload(repo, issue, cid);
      }
    }
  }
  return null;
}

// ---------- validation + execution ----------

function baseType(type: string): string {
  return type.replace(/[[\]!]/g, '');
}

function validate(typeName: string, selections: Selection[], errors: string[]): void {
  const fields = SCHEMA[typeName];
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      validate(sel.typeCondition, sel.selections, errors);
      continue;
    }
    if (sel.name === '__typename') continue;
    if (!fields || !(sel.name in fields)) {
      errors.push(`Field '${sel.name}' doesn't exist on type '${typeName}'`);
      continue;
    }
    if (sel.selections.length > 0) validate(baseType(fields[sel.name].type), sel.selections, errors);
  }
}

function evalValue(v: Value, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var': return vars[v.name];
    case 'int': case 'float': return Number(v.value);
    case 'string': case 'enum': return v.value;
    case 'bool': return v.value;
    case 'null': return null;
    case 'list': return v.items.map((i) => evalValue(i, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, val] of v.fields) out[k] = evalValue(val, vars);
      return out;
    }
  }
}

function evalArgs(field: FieldNode, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of field.args) out[k] = evalValue(v, vars);
  return out;
}

function executeSelections(
  typeName: string,
  parent: Payload,
  selections: Selection[],
  ctx: Ctx,
  vars: Record<string, unknown>,
  errors: { message: string }[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields = SCHEMA[typeName] ?? {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (parent.__typename === sel.typeCondition || sel.typeCondition === 'Node') {
        Object.assign(out, executeSelections(sel.typeCondition, parent, sel.selections, ctx, vars, errors));
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') { out[key] = parent.__typename; continue; }
    const def = fields[sel.name];
    if (!def) { out[key] = null; continue; } // validation already reported it
    let value: unknown;
    try {
      value = def.resolve ? def.resolve(parent, evalArgs(sel, vars), ctx) : (parent as Record<string, unknown>)[sel.name];
    } catch (e) {
      if (e instanceof GqlError) {
        errors.push({ message: e.message });
        out[key] = null;
        continue;
      }
      throw e;
    }
    if (value === null || value === undefined) { out[key] = null; continue; }
    if (sel.selections.length === 0) { out[key] = value; continue; }
    const childType = baseType(def.type);
    if (Array.isArray(value)) {
      out[key] = value.map((item) => (item && typeof item === 'object'
        ? executeSelections((item as Payload).__typename ?? childType, item as Payload, sel.selections, ctx, vars, errors)
        : item));
    } else if (typeof value === 'object') {
      const payload = value as Payload;
      out[key] = executeSelections(payload.__typename ?? childType, payload, sel.selections, ctx, vars, errors);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export interface GqlHttpResult { status: number; body: unknown }

function runOperation(forge: Forge, query: string, variables: Record<string, unknown>, operationName?: string): Record<string, unknown> {
  let ops: Operation[];
  try {
    ops = parseDocument(query);
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : 'parse error' }] };
  }
  const op = (operationName ? ops.find((o) => o.name === operationName) : undefined) ?? ops[0];
  if (!op) return { data: null, errors: [{ message: 'No operation found' }] };
  const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
  const validationErrors: string[] = [];
  validate(rootType, op.selections, validationErrors);
  if (validationErrors.length > 0) {
    return { data: null, errors: validationErrors.map((message) => ({ message })) };
  }
  const errors: { message: string }[] = [];
  const data = executeSelections(rootType, { __typename: rootType }, op.selections, { forge }, variables, errors);
  return errors.length > 0 ? { data, errors } : { data };
}

/** Handle one GraphQL HTTP body (a single operation or a batch array). */
export function handleGraphQL(forge: Forge, body: unknown): GqlHttpResult {
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((op) => runOperation(forge, String((op as { query?: string }).query ?? ''), ((op as { variables?: Record<string, unknown> }).variables ?? {}) as Record<string, unknown>, (op as { operationName?: string }).operationName)) };
  }
  const op = (body ?? {}) as { query?: string; variables?: Record<string, unknown>; operationName?: string };
  if (typeof op.query !== 'string') return { status: 400, body: { errors: [{ message: 'query is required' }] } };
  return { status: 200, body: runOperation(forge, op.query, op.variables ?? {}, op.operationName) };
}
