// REST v3 surface: meta, user, repositories, branches, commits, contents, labels, issues, pulls.
// Shapes follow GitHub's REST v3 as the contest's wire contract quotes it.

import { Forge, VIEWER, type Repo, type Issue, type Label, type Comment } from './store.ts';
import {
  createCommit, flattenTree, parseCommit, parseIdent, treeEntryAt, updateTree, EMPTY_TREE_SHA,
  ancestors, isAncestor, mergeBase,
} from './gitobj.ts';

export interface RestResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  noBody?: boolean;
}

const ok = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const err = (status: number, message: string): RestResult => ({ status, body: { message } });
export const notFound = (): RestResult => err(404, 'Not Found');

export function userJson(login: string): Record<string, unknown> {
  if (login === VIEWER.login) {
    return { login: VIEWER.login, id: VIEWER.id, type: 'User', name: VIEWER.name, email: VIEWER.email };
  }
  return { login, id: 0, type: 'User' };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `/​${repo.owner}/${repo.name}`.replace('/​', '/'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
  };
}

export function labelJson(l: Label): Record<string, unknown> {
  return { id: l.id, name: l.name, color: l.color, description: l.description, default: false };
}

export function commentJson(c: Comment): Record<string, unknown> {
  return { id: c.id, body: c.body, user: userJson(c.userLogin), created_at: c.createdAt, updated_at: c.updatedAt };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return l ? labelJson(l) : { name };
    }),
    user: userJson(issue.userLogin),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
  if (issue.pullRequest) {
    base.pull_request = { url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${issue.number}` };
  }
  return base;
}

interface RefJson {
  ref: string;
  label: string;
  sha: string;
  user: Record<string, unknown>;
  repo: Record<string, unknown>;
}

function refJson(forge: Forge, repo: Repo, ref: string): RefJson {
  const sha = repo.refs.get(`refs/heads/${ref}`) ?? '';
  return { ref, label: `${repo.owner}:${ref}`, sha, user: userJson(repo.owner), repo: repoJson(repo) };
}

export function pullJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  const pr = issue.pullRequest!;
  const base = issueJson(repo, issue);
  const merged = pr.merged;
  return {
    ...base,
    state: merged ? 'closed' : issue.state,
    draft: pr.draft,
    merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    merged_by: merged ? userJson(VIEWER.login) : null,
    head: refJson(forge, repo, pr.headRef),
    base: refJson(forge, repo, pr.baseRef),
    mergeable: computeMergeable(forge, repo, issue),
    mergeable_state: computeMergeable(forge, repo, issue) ? 'clean' : 'dirty',
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function computeMergeable(forge: Forge, repo: Repo, issue: Issue): boolean | null {
  const pr = issue.pullRequest;
  if (!pr || pr.merged) return null;
  const headSha = repo.refs.get(`refs/heads/${pr.headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (!headSha || !baseSha) return null;
  if (isAncestor(forge.store, headSha, baseSha)) return false; // nothing to merge
  return planSquash(forge, repo, baseSha, headSha).ok;
}

/** The tree changes of head relative to the merge base, applied onto base: a dry-run squash. */
export function planSquash(
  forge: Forge,
  repo: Repo,
  baseSha: string,
  headSha: string,
): { ok: boolean; tree?: string } {
  const store = forge.store;
  const mb = mergeBase(store, baseSha, headSha);
  if (!mb) return { ok: false };
  const mbCommit = store.get(mb);
  const baseCommit = store.get(baseSha);
  const headCommit = store.get(headSha);
  if (!mbCommit || !baseCommit || !headCommit) return { ok: false };
  const mbFiles = flattenTree(store, parseCommit(mbCommit.payload).tree);
  const baseFiles = flattenTree(store, parseCommit(baseCommit.payload).tree);
  const headFiles = flattenTree(store, parseCommit(headCommit.payload).tree);
  let tree = parseCommit(baseCommit.payload).tree;
  const paths = new Set([...mbFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const inMb = mbFiles.get(path)?.sha;
    const inHead = headFiles.get(path)?.sha;
    if (inMb === inHead) continue; // head did not change it
    const inBase = baseFiles.get(path)?.sha;
    if (inBase !== inMb && inBase !== inHead) return { ok: false }; // both sides changed it differently
    tree = updateTree(store, tree, path, inHead ?? null, headFiles.get(path)?.mode ?? '100644');
  }
  return { ok: true, tree };
}

// ---------- pagination ----------

interface Page {
  items: unknown[];
  headers: Record<string, string>;
}

function paginate(items: unknown[], query: URLSearchParams, baseUrl: string): Page {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (page < totalPages) {
    const next = new URL(baseUrl);
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    const last = new URL(baseUrl);
    last.searchParams.set('page', String(totalPages));
    last.searchParams.set('per_page', String(perPage));
    headers.link = `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`;
  }
  return { items: slice, headers };
}

// ---------- handlers ----------

type Body = Record<string, unknown> | undefined;

function str(body: Body, key: string): string | undefined {
  const v = body?.[key];
  return typeof v === 'string' ? v : undefined;
}

export function handleRest(
  forge: Forge,
  method: string,
  seg: string[],
  query: URLSearchParams,
  body: Body,
  baseUrl: string,
): RestResult | undefined {
  // seg: path segments after /api/v3
  if (seg.length === 0) {
    if (method !== 'GET') return undefined;
    return ok(200, {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (seg[0] === 'meta' && seg.length === 1) {
    if (method !== 'GET') return undefined;
    return ok(200, { installed_version: '1.0.0-forge', verifiable_password_authentication: false });
  }
  if (seg[0] === 'user' && seg.length === 1) {
    if (method !== 'GET') return undefined;
    return ok(200, userJson(VIEWER.login));
  }
  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'GET') {
      const page = paginate(forge.viewerRepos().map(repoJson), query, `${baseUrl}/api/v3/user/repos`);
      return ok(200, page.items, page.headers);
    }
    if (method === 'POST') {
      const name = str(body, 'name');
      if (!name) return err(422, 'Repository creation failed: name is required');
      if (forge.getRepo(VIEWER.login, name)) return err(422, 'Repository creation failed: name already exists on this account');
      const repo = forge.createRepo(
        name,
        str(body, 'description') ?? null,
        body?.private === true,
        str(body, 'default_branch') ?? 'main',
      );
      return ok(201, repoJson(repo));
    }
    return undefined;
  }
  if (seg[0] !== 'repos' || seg.length < 3) return undefined;
  const repo = forge.getRepo(seg[1], seg[2]);
  if (!repo) return notFound();
  const rest = seg.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return ok(200, repoJson(repo));
    if (method === 'PATCH') {
      if (str(body, 'description') !== undefined) repo.description = str(body, 'description') ?? null;
      if (str(body, 'name')) {
        forge.repos.delete(`${repo.owner}/${repo.name}`);
        repo.name = str(body, 'name')!;
        forge.repos.set(`${repo.owner}/${repo.name}`, repo);
      }
      if (typeof body?.private === 'boolean') repo.isPrivate = body.private;
      if (str(body, 'default_branch')) repo.defaultBranch = str(body, 'default_branch')!;
      repo.updatedAt = forge.nowIso();
      return ok(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      return { status: 204, noBody: true };
    }
    return undefined;
  }

  if (rest[0] === 'git' && rest[1] === 'refs') return gitRefs(forge, repo, method, rest.slice(2), body);
  if (rest[0] === 'branches') return branches(forge, repo, method, rest.slice(1), query, baseUrl);
  if (rest[0] === 'commits') return commits(forge, repo, method, rest.slice(1), query, baseUrl);
  if (rest[0] === 'contents') return contents(forge, repo, method, rest.slice(1).join('/'), query, body);
  if (rest[0] === 'labels') return labels(forge, repo, method, rest.slice(1), body);
  if (rest[0] === 'issues') return issues(forge, repo, method, rest.slice(1), query, body, baseUrl);
  if (rest[0] === 'pulls') return pulls(forge, repo, method, rest.slice(1), query, body, baseUrl);
  return undefined;
}

/** The git refs API: POST /git/refs creates a ref, GET reads one, DELETE removes one. */
function gitRefs(forge: Forge, repo: Repo, method: string, rest: string[], body: Body): RestResult {
  if (method === 'POST' && rest.length === 0) {
    const ref = str(body, 'ref');
    const sha = str(body, 'sha');
    if (!ref || !sha) return err(422, 'ref and sha are required');
    if (!forge.store.has(sha)) return err(422, 'sha does not name an object');
    if (repo.refs.has(ref)) return err(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    repo.updatedAt = forge.nowIso();
    return ok(201, { ref, object: { sha, type: forge.store.get(sha)!.type } });
  }
  const ref = rest.join('/');
  const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
  const sha = repo.refs.get(full);
  if (method === 'GET') {
    if (!sha) return notFound();
    return ok(200, { ref: full, object: { sha, type: forge.store.get(sha)?.type ?? 'commit' } });
  }
  if (method === 'DELETE') {
    if (!sha) return notFound();
    repo.refs.delete(full);
    return { status: 204, noBody: true };
  }
  return notFound();
}

function branches(forge: Forge, repo: Repo, method: string, rest: string[], query: URLSearchParams, baseUrl: string): RestResult {
  if (method !== 'GET') return notFound();
  const list = [...repo.refs.entries()]
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false }));
  if (rest.length === 0) {
    const page = paginate(list, query, `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/branches`);
    return ok(200, page.items, page.headers);
  }
  const name = rest.join('/');
  const sha = repo.refs.get(`refs/heads/${name}`);
  if (!sha) return notFound();
  const commit = forge.store.get(sha);
  const info = commit ? parseCommit(commit.payload) : null;
  return ok(200, {
    name,
    commit: {
      sha,
      commit: info ? { message: info.message, author: parseIdent(info.author), committer: parseIdent(info.committer), tree: { sha: info.tree } } : {},
      parents: info ? info.parents.map((p) => ({ sha: p })) : [],
    },
    protected: false,
  });
}

function commitJson(forge: Forge, sha: string): Record<string, unknown> {
  const obj = forge.store.get(sha);
  if (!obj) return { sha };
  const info = parseCommit(obj.payload);
  const author = parseIdent(info.author);
  const committer = parseIdent(info.committer);
  return {
    sha,
    commit: {
      message: info.message,
      author: { name: author.name, email: author.email, date: author.dateIso },
      committer: { name: committer.name, email: committer.email, date: committer.dateIso },
      tree: { sha: info.tree },
    },
    author: author.email === VIEWER.email ? userJson(VIEWER.login) : null,
    committer: committer.email === VIEWER.email ? userJson(VIEWER.login) : null,
    parents: info.parents.map((p) => ({ sha: p })),
  };
}

function commits(forge: Forge, repo: Repo, method: string, rest: string[], query: URLSearchParams, baseUrl: string): RestResult {
  if (method !== 'GET') return notFound();
  if (rest.length === 1) {
    if (!forge.store.has(rest[0])) return notFound();
    return ok(200, commitJson(forge, rest[0]));
  }
  if (rest.length !== 0) return notFound();
  const ref = query.get('sha') ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${ref}`) ?? (forge.store.has(ref) ? ref : undefined);
  if (!tip) return ok(200, []);
  const all = ancestors(forge.store, tip).map((sha) => commitJson(forge, sha));
  const page = paginate(all, query, `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/commits`);
  return ok(200, page.items, page.headers);
}

function contents(forge: Forge, repo: Repo, method: string, path: string, query: URLSearchParams, body: Body): RestResult {
  const store = forge.store;
  const ref = query.get('ref') ?? str(body, 'branch') ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${ref}`);
  const tipTree = tip ? parseCommit(store.get(tip)!.payload).tree : EMPTY_TREE_SHA;

  if (method === 'GET') {
    if (!tip) return notFound();
    if (path === '') {
      const flat = flattenTree(store, tipTree);
      const dirs = new Set<string>();
      const out: Record<string, unknown>[] = [];
      for (const p of flat.keys()) {
        const first = p.split('/')[0];
        if (p.includes('/')) dirs.add(first);
      }
      for (const [p, e] of flat) {
        if (!p.includes('/')) out.push(contentEntry(repo, p, e.sha, 'file', store.get(e.sha)?.payload.length ?? 0));
      }
      for (const d of dirs) out.push({ name: d, path: d, sha: '', size: 0, type: 'dir' });
      out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return ok(200, out);
    }
    const entry = treeEntryAt(store, tipTree, path);
    if (!entry) return notFound();
    if (entry.mode === '40000') {
      const flat = flattenTree(store, entry.sha);
      const prefix = `${path}/`;
      const out: Record<string, unknown>[] = [];
      const dirs = new Set<string>();
      for (const [p, e] of flat) {
        const rel = p;
        if (rel.includes('/')) dirs.add(rel.split('/')[0]);
        else out.push(contentEntry(repo, `${prefix}${rel}`, e.sha, 'file', store.get(e.sha)?.payload.length ?? 0));
      }
      for (const d of dirs) out.push({ name: d, path: `${prefix}${d}`, sha: '', size: 0, type: 'dir' });
      out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return ok(200, out);
    }
    const blob = store.get(entry.sha);
    if (!blob) return notFound();
    return ok(200, {
      ...contentEntry(repo, path, entry.sha, 'file', blob.payload.length),
      encoding: 'base64',
      content: blob.payload.toString('base64'),
    });
  }

  if (method === 'PUT' || method === 'DELETE') {
    const message = str(body, 'message');
    if (!message) return err(422, 'commit message is required');
    const existing = tip ? treeEntryAt(store, tipTree, path) : undefined;
    const givenSha = str(body, 'sha');
    if (method === 'PUT') {
      if (existing) {
        if (!givenSha) return err(422, 'sha is required when updating a file');
        if (givenSha !== existing.sha) return err(409, 'sha does not match the current file');
      }
      const contentB64 = str(body, 'content');
      if (contentB64 === undefined) return err(422, 'content is required');
      const blobSha = store.put('blob', Buffer.from(contentB64, 'base64'));
      const newTree = updateTree(store, tip ? tipTree : null, path, blobSha);
      const sha = commitOnBranch(forge, repo, ref, newTree, message);
      return ok(existing ? 200 : 201, {
        content: { ...contentEntry(repo, path, blobSha, 'file', store.get(blobSha)!.payload.length), encoding: 'base64' },
        commit: { sha },
      });
    }
    // DELETE
    if (!existing) return notFound();
    if (givenSha && givenSha !== existing.sha) return err(409, 'sha does not match the current file');
    const newTree = updateTree(store, tipTree, path, null);
    const sha = commitOnBranch(forge, repo, ref, newTree, message);
    return ok(200, { content: null, commit: { sha } });
  }
  return notFound();
}

function contentEntry(repo: Repo, path: string, sha: string, type: string, size: number): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  return { name, path, sha, size, type, url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}` };
}

/** Create a commit on a branch with the given tree; returns the commit sha. */
export function commitOnBranch(forge: Forge, repo: Repo, branch: string, tree: string, message: string): string {
  const store = forge.store;
  const parent = repo.refs.get(`refs/heads/${branch}`);
  const now = Math.floor(Date.now() / 1000);
  const ident = { name: VIEWER.name, email: VIEWER.email, epochSec: now };
  const sha = createCommit(store, tree, parent ? [parent] : [], ident, ident, message);
  repo.refs.set(`refs/heads/${branch}`, sha);
  repo.updatedAt = forge.nowIso();
  return sha;
}

function labels(forge: Forge, repo: Repo, method: string, rest: string[], body: Body): RestResult {
  if (rest.length === 0) {
    if (method === 'GET') return ok(200, [...repo.labels.values()].map(labelJson));
    if (method === 'POST') {
      const name = str(body, 'name');
      if (!name) return err(422, 'name is required');
      if (repo.labels.has(name)) return err(422, 'Label already exists');
      const label = forge.createLabel(repo, name, str(body, 'color') ?? 'ededed', str(body, 'description') ?? null);
      return ok(201, labelJson(label));
    }
    return notFound();
  }
  const name = decodeURIComponent(rest.join('/'));
  const label = repo.labels.get(name);
  if (method === 'GET') return label ? ok(200, labelJson(label)) : notFound();
  if (method === 'PATCH' && label) {
    if (str(body, 'color')) label.color = str(body, 'color')!;
    if (str(body, 'description') !== undefined) label.description = str(body, 'description') ?? null;
    return ok(200, labelJson(label));
  }
  if (method === 'DELETE' && label) {
    repo.labels.delete(name);
    return { status: 204, noBody: true };
  }
  return notFound();
}

function issues(forge: Forge, repo: Repo, method: string, rest: string[], query: URLSearchParams, body: Body, baseUrl: string): RestResult {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.issues.values()].filter((i) => !i.pullRequest);
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      const direction = query.get('direction') ?? 'desc';
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const page = paginate(list.map((i) => issueJson(repo, i)), query, `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues`);
      return ok(200, page.items, page.headers);
    }
    if (method === 'POST') {
      const title = str(body, 'title');
      if (!title) return err(422, 'title is required');
      const labelNames = Array.isArray(body?.labels) ? (body.labels as unknown[]).map(String) : [];
      for (const name of labelNames) {
        if (!repo.labels.has(name)) return err(422, `Label "${name}" does not exist`);
      }
      const issue = forge.createIssue(repo, title, str(body, 'body') ?? null, labelNames);
      return ok(201, issueJson(repo, issue));
    }
    return notFound();
  }
  const num = Number(rest[0]);
  const issue = Number.isInteger(num) ? repo.issues.get(num) : undefined;
  if (!issue) return notFound();
  if (rest.length === 1) {
    if (method === 'GET') return ok(200, issueJson(repo, issue));
    if (method === 'PATCH') {
      if (str(body, 'title') !== undefined) issue.title = str(body, 'title')!;
      if (str(body, 'body') !== undefined) issue.body = str(body, 'body') ?? null;
      if (body?.state === 'open' || body?.state === 'closed') issue.state = body.state;
      if (Array.isArray(body?.labels)) {
        const names = (body.labels as unknown[]).map(String);
        for (const name of names) if (!repo.labels.has(name)) return err(422, `Label "${name}" does not exist`);
        issue.labels = names;
      }
      issue.updatedAt = forge.nowIso();
      return ok(200, issueJson(repo, issue));
    }
    return notFound();
  }
  if (rest[1] === 'comments' && rest.length === 2) {
    if (method === 'GET') {
      const page = paginate(issue.comments.map(commentJson), query, `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${num}/comments`);
      return ok(200, page.items, page.headers);
    }
    if (method === 'POST') {
      const text = str(body, 'body');
      if (!text) return err(422, 'body is required');
      const comment = forge.createComment(repo, issue, text);
      return ok(201, commentJson(comment));
    }
  }
  return notFound();
}

function pulls(forge: Forge, repo: Repo, method: string, rest: string[], query: URLSearchParams, body: Body, baseUrl: string): RestResult {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.issues.values()].filter((i) => i.pullRequest);
      if (state === 'open') list = list.filter((i) => i.state === 'open' && !i.pullRequest!.merged);
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed' || i.pullRequest!.merged);
      const direction = query.get('direction') ?? 'desc';
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const page = paginate(list.map((i) => pullJson(forge, repo, i)), query, `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
      return ok(200, page.items, page.headers);
    }
    if (method === 'POST') {
      const title = str(body, 'title');
      const headRaw = str(body, 'head');
      const baseRaw = str(body, 'base');
      if (!title || !headRaw || !baseRaw) return err(422, 'title, head and base are required');
      const head = headRaw.includes(':') ? headRaw.split(':').pop()! : headRaw;
      const base = baseRaw.includes(':') ? baseRaw.split(':').pop()! : baseRaw;
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return err(422, 'head or base branch does not exist');
      if (headSha === baseSha || isAncestor(forge.store, headSha, baseSha)) {
        return err(422, 'No commits between base and head');
      }
      const issue = forge.createIssue(repo, title, str(body, 'body') ?? null, []);
      issue.pullRequest = {
        number: issue.number,
        headRef: head,
        headSha,
        baseRef: base,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        draft: body?.draft === true,
      };
      return ok(201, pullJson(forge, repo, issue));
    }
    return notFound();
  }
  const num = Number(rest[0]);
  const issue = Number.isInteger(num) ? repo.issues.get(num) : undefined;
  if (!issue || !issue.pullRequest) return notFound();
  const pr = issue.pullRequest;
  if (rest.length === 1) {
    if (method === 'GET') return ok(200, pullJson(forge, repo, issue));
    if (method === 'PATCH') {
      if (str(body, 'title') !== undefined) issue.title = str(body, 'title')!;
      if (str(body, 'body') !== undefined) issue.body = str(body, 'body') ?? null;
      if (body?.state === 'open' || body?.state === 'closed') issue.state = body.state;
      issue.updatedAt = forge.nowIso();
      return ok(200, pullJson(forge, repo, issue));
    }
    return notFound();
  }
  if (rest[1] === 'files' && rest.length === 2 && method === 'GET') {
    return ok(200, prFiles(forge, repo, issue));
  }
  if (rest[1] === 'merge' && rest.length === 2) {
    if (method === 'GET') {
      return pr.merged ? { status: 204, noBody: true } : notFound();
    }
    if (method === 'PUT') {
      const result = squashMerge(forge, repo, issue, str(body, 'commit_title'));
      if (!result.ok) return err(405, result.reason ?? 'Pull Request is not mergeable');
      return ok(200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
    }
  }
  return notFound();
}

/** Squash-merge a pull request onto its base branch. Shared by REST and GraphQL. */
export function squashMerge(
  forge: Forge,
  repo: Repo,
  issue: Issue,
  commitTitle?: string,
): { ok: boolean; sha?: string; reason?: string } {
  const pr = issue.pullRequest!;
  if (pr.merged) return { ok: false, reason: 'Pull Request is already merged' };
  const headSha = repo.refs.get(`refs/heads/${pr.headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (!headSha || !baseSha) return { ok: false, reason: 'Pull Request is not mergeable' };
  const plan = planSquash(forge, repo, baseSha, headSha);
  if (!plan.ok || !plan.tree) return { ok: false, reason: 'Pull Request is not mergeable: conflicts' };
  const now = Math.floor(Date.now() / 1000);
  const ident = { name: VIEWER.name, email: VIEWER.email, epochSec: now };
  const sha = createCommit(forge.store, plan.tree, [baseSha], ident, ident, `${commitTitle ?? issue.title}\n`);
  repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
  pr.merged = true;
  pr.mergedAt = forge.nowIso();
  pr.mergeCommitSha = sha;
  issue.state = 'closed';
  issue.updatedAt = pr.mergedAt;
  repo.updatedAt = pr.mergedAt;
  return { ok: true, sha };
}

/** The PR's changed files: merge-base..head diff with line counts. */
export function prFiles(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown>[] {
  const store = forge.store;
  const pr = issue.pullRequest!;
  const headSha = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
  const mb = mergeBase(store, baseSha, headSha) ?? baseSha;
  const mbTree = parseCommit(store.get(mb)!.payload).tree;
  const headTree = parseCommit(store.get(headSha)!.payload).tree;
  const before = flattenTree(store, mbTree);
  const after = flattenTree(store, headTree);
  const out: Record<string, unknown>[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const b = before.get(path);
    const a = after.get(path);
    if (b?.sha === a?.sha) continue;
    const bText = b ? store.get(b.sha)!.payload.toString('utf8') : '';
    const aText = a ? store.get(a.sha)!.payload.toString('utf8') : '';
    const { additions, deletions } = lineDiff(bText, aText);
    out.push({
      filename: path,
      status: !b ? 'added' : !a ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: a?.sha ?? b!.sha,
    });
  }
  return out;
}

/** Line-level diff counts via LCS over lines (files in the suite are small). */
export function lineDiff(before: string, after: string): { additions: number; deletions: number } {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  const common = dp[b.length];
  return { additions: b.length - common, deletions: a.length - common };
}
