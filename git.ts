// Git smart HTTP: ref advertisement (v0 and v2), ls-refs, fetch (upload-pack) and push
// (receive-pack), implemented against the in-memory object store. No git binary, no disk.

import type { IncomingMessage } from 'node:http';
import { Forge, VIEWER, type Repo } from './store.ts';
import {
  parseCommit, parseTree, ancestors, isAncestor, type ObjectStore, type ObjType,
} from './gitobj.ts';
import { buildPack, ingestPack, pktLine, PKT_FLUSH, PKT_DELIM, parsePackets, splitCommandBlock, type Packet } from './pack.ts';

export interface GitResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const ZERO = '0'.repeat(40);
const AGENT = 'forge/1.0';

const text = (status: number, body: string): GitResult => ({
  status, contentType: 'text/plain; charset=utf-8', body: Buffer.from(body, 'utf8'),
});

function repoRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** Deref an annotated tag chain to the commit it names (for peeled lines). */
function peelToCommit(store: ObjectStore, sha: string): string | null {
  let cur = sha;
  for (let i = 0; i < 10; i += 1) {
    const obj = store.get(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type !== 'tag') return null;
    const m = /^object ([0-9a-f]{40})$/m.exec(obj.payload.toString('utf8'));
    if (!m) return null;
    cur = m[1];
  }
  return null;
}

// ---------- advertisements ----------

// The v2 advertisement names no repo state: build its body once.
const V2_ADVERTISEMENT_BODY = Buffer.concat([
  ...[
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
  ].map((l) => pktLine(l)),
  PKT_FLUSH,
]);

function v2Advertisement(): GitResult {
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-advertisement',
    body: V2_ADVERTISEMENT_BODY,
  };
}

function v0Advertisement(forge: Forge, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): GitResult {
  const isUpload = service === 'git-upload-pack';
  const caps = isUpload
    ? `thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
    : `report-status delete-refs side-band-64k ofs-delta quiet symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = repoRefs(repo);
  const headSha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    if (headSha) {
      parts.push(pktLine(`${headSha} HEAD\0${caps}\n`));
      first = false;
    }
    for (const [ref, sha] of refs) {
      parts.push(pktLine(first ? `${sha} ${ref}\0${caps}\n` : `${sha} ${ref}\n`));
      first = false;
      const peeled = peelToCommit(forge.store, sha);
      if (peeled && peeled !== sha) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
    }
  }
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: Buffer.concat(parts),
  };
}

// ---------- object collection for fetch ----------

interface Collected {
  objects: { sha: string; type: ObjType; payload: Buffer }[];
  shallow: string[];
  unshallow: string[];
}

/** Every object reachable from `root` (any type), via `visit`. */
function walkObjects(store: ObjectStore, root: string, visit: (sha: string) => void, stopCommits?: Set<string>): void {
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = store.get(sha);
    if (!obj) continue;
    visit(sha);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.payload);
      stack.push(info.tree);
      if (!stopCommits || !stopCommits.has(sha)) stack.push(...info.parents);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.payload)) stack.push(e.sha);
    } else if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.payload.toString('utf8'));
      if (m) stack.push(m[1]);
    }
  }
}

function collectFetch(
  store: ObjectStore,
  wants: string[],
  haves: string[],
  clientShallow: Set<string>,
  depth: number | null,
): Collected {
  // Exclusion: everything the client already has. Shallow boundary commits count as
  // present, but their parents do not.
  const excluded = new Set<string>();
  for (const have of haves) {
    walkObjects(store, have, (sha) => excluded.add(sha), clientShallow);
  }
  for (const s of clientShallow) {
    walkObjects(store, s, (sha) => excluded.add(sha), clientShallow);
  }

  const included = new Set<string>();
  const shallow = new Set<string>();
  const unshallow = new Set<string>();

  if (depth === null) {
    for (const want of wants) {
      walkObjects(store, want, (sha) => { if (!excluded.has(sha)) included.add(sha); });
    }
  } else {
    // Commit inclusion by "edges below the deepest client-shallow boundary on the path"
    // (a plain deepen counts edges from the want). Include commit C iff k(C) < depth.
    const k = new Map<string, number>();
    const queue: string[] = [];
    for (const w of wants) {
      if (store.get(w)?.type === 'commit' && !k.has(w)) { k.set(w, 0); queue.push(w); }
    }
    const includedCommits = new Set<string>();
    while (queue.length > 0) {
      queue.sort((a, b) => (k.get(a)! - k.get(b)!));
      const cur = queue.shift()!;
      const curK = k.get(cur)!;
      if (curK >= depth) continue;
      includedCommits.add(cur);
      const info = parseCommit(store.get(cur)!.payload);
      const base = clientShallow.has(cur) ? 0 : curK;
      for (const parent of info.parents) {
        if (store.get(parent)?.type !== 'commit') continue;
        const pk = base + 1;
        if (!k.has(parent) || pk < k.get(parent)!) { k.set(parent, pk); queue.push(parent); }
      }
    }
    for (const c of includedCommits) {
      const info = parseCommit(store.get(c)!.payload);
      walkObjects(store, info.tree, (sha) => { if (!excluded.has(sha)) included.add(sha); });
      if (!excluded.has(c)) included.add(c);
      const missingParent = info.parents.some((p) => !includedCommits.has(p) && store.has(p));
      if (missingParent) shallow.add(c);
      if (clientShallow.has(c) && info.parents.length > 0 && info.parents.every((p) => includedCommits.has(p))) {
        unshallow.add(c);
      }
    }
    // Non-commit wants (tags/blobs) ride along in full.
    for (const want of wants) {
      if (store.get(want)?.type !== 'commit') {
        walkObjects(store, want, (sha) => { if (!excluded.has(sha)) included.add(sha); });
      }
    }
  }

  const objects = [...included]
    .map((sha) => ({ sha, type: store.get(sha)!.type, payload: store.get(sha)!.payload }))
    .sort((a, b) => typeOrder(a.type) - typeOrder(b.type));
  return { objects, shallow: [...shallow], unshallow: [...unshallow] };
}

function typeOrder(t: ObjType): number {
  return { commit: 0, tag: 1, tree: 2, blob: 3 }[t];
}

/** Frame a pack as side-band-64k packets (band 1), optionally with a flush at the end. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const chunk = pack.subarray(i, i + CHUNK);
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(payload));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

// ---------- upload-pack ----------

// ls-refs output is a pure function of (repo refs, default branch, options):
// refsVersion bumps on every ref mutation, so a cached body stays exact.
const lsRefsCache = new Map<string, Buffer>();

function lsRefs(forge: Forge, repo: Repo, packets: Packet[]): GitResult {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const cacheKey = `${repo.owner}/${repo.name}|${repo.refsVersion}|${repo.defaultBranch}|${peel ? 1 : 0}${symrefs ? 1 : 0}${unborn ? 1 : 0}|${prefixes.join(',')}`;
  const cachedBody = lsRefsCache.get(cacheKey);
  if (cachedBody) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: cachedBody };
  }
  const match = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headSha = repo.refs.get(headRef);
  if (match('HEAD')) {
    if (headSha) lines.push(`${headSha} HEAD${symrefs ? ` symref-target:${headRef}` : ''}`);
    else if (unborn) lines.push(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}`);
  }
  for (const [ref, sha] of repoRefs(repo)) {
    if (!match(ref)) continue;
    let line = `${sha} ${ref}`;
    if (peel) {
      const peeled = peelToCommit(forge.store, sha);
      if (peeled && peeled !== sha) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  const body = Buffer.concat([...lines.map((l) => pktLine(`${l}\n`)), PKT_FLUSH]);
  if (lsRefsCache.size > 512) lsRefsCache.clear();
  lsRefsCache.set(cacheKey, body);
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-result',
    body,
  };
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallowLines: string[];
  depth: number | null;
  done: boolean;
}

function fetchV2(forge: Forge, repo: Repo, packets: Packet[]): GitResult {
  const args: FetchArgs = { wants: [], haves: [], shallowLines: [], depth: null, done: false };
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallowLines.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
    else if (line === 'done') args.done = true;
  }
  return runFetch(forge, repo, args, true);
}

function fetchV0(forge: Forge, repo: Repo, packets: Packet[]): GitResult {
  const args: FetchArgs = { wants: [], haves: [], shallowLines: [], depth: null, done: false };
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(/[\0 ]/)[0]);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallowLines.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
    else if (line === 'done') args.done = true;
  }
  return runFetch(forge, repo, args, false);
}

// Fetch responses are a pure function of (wants, haves, depth, shallow set): stored objects
// are content-addressed and immutable, so a computed response stays valid forever. The
// clone workload repeats one shallow fetch many times; caching the framed body makes
// repeats nearly free. Bounded FIFO to cap memory.
const fetchCache = new Map<string, Buffer>();
const FETCH_CACHE_MAX = 64;

function runFetch(forge: Forge, repo: Repo, args: FetchArgs, v2: boolean): GitResult {
  const store = forge.store;
  for (const want of args.wants) {
    if (!store.has(want)) {
      return {
        status: 200,
        contentType: 'application/x-git-upload-pack-result',
        body: Buffer.concat([pktLine(`ERR no such object: ${want}\n`), PKT_FLUSH]),
      };
    }
  }
  const cacheKey = [
    v2 ? 'v2' : 'v0',
    [...args.wants].sort().join(','),
    [...args.haves].sort().join(','),
    String(args.depth),
    [...args.shallowLines].sort().join(','),
  ].join('|');
  const cached = fetchCache.get(cacheKey);
  if (cached) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: cached };
  }
  const result = runFetchUncached(forge, repo, args, v2);
  if (fetchCache.size >= FETCH_CACHE_MAX) {
    const oldest = fetchCache.keys().next().value;
    if (oldest !== undefined) fetchCache.delete(oldest);
  }
  fetchCache.set(cacheKey, result.body);
  return result;
}

function runFetchUncached(forge: Forge, repo: Repo, args: FetchArgs, v2: boolean): GitResult {
  const store = forge.store;
  const clientShallow = new Set(args.shallowLines);
  const collected = collectFetch(store, args.wants, args.haves, clientShallow, args.depth);
  const pack = buildPack(collected.objects);
  const parts: Buffer[] = [];
  if (v2) {
    if (args.haves.length > 0) {
      parts.push(pktLine('acknowledgments\n'));
      const common = args.haves.find((h) => store.has(h));
      if (common) {
        parts.push(pktLine(`ACK ${common}\n`));
        parts.push(pktLine('ready\n'));
      } else {
        parts.push(pktLine('NAK\n'));
      }
      parts.push(PKT_DELIM);
    }
    if (args.depth !== null || args.shallowLines.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const s of collected.shallow) parts.push(pktLine(`shallow ${s}\n`));
      for (const s of collected.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(pack));
    parts.push(PKT_FLUSH);
  } else {
    for (const s of collected.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of collected.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(pktLine('NAK\n'));
    parts.push(sidebandPack(pack));
    parts.push(PKT_FLUSH);
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function uploadPack(forge: Forge, repo: Repo, raw: Buffer): GitResult {
  let packets: Packet[];
  try {
    packets = parsePackets(raw);
  } catch {
    return text(400, 'bad pkt-line stream');
  }
  const first = packets.find((p) => p.kind === 'data');
  const firstLine = first && first.kind === 'data' ? first.payload.toString('utf8') : '';
  if (firstLine.startsWith('command=ls-refs')) return lsRefs(forge, repo, packets);
  if (firstLine.startsWith('command=fetch')) return fetchV2(forge, repo, packets);
  return fetchV0(forge, repo, packets);
}

// ---------- receive-pack ----------

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(forge: Forge, repo: Repo, raw: Buffer): GitResult {
  let packets: Packet[];
  let rest: Buffer;
  try {
    ({ packets, rest } = splitCommandBlock(raw));
  } catch {
    return text(400, 'bad pkt-line stream');
  }
  const commands: RefCommand[] = [];
  let caps = '';
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    let line = p.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      caps = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const fields = line.trim().split(/\s+/);
    if (fields.length === 3) commands.push({ oldOid: fields[0], newOid: fields[1], ref: fields[2] });
  }
  const wantReport = caps.includes('report-status');
  const sideband = caps.includes('side-band-64k');

  let unpackOk = true;
  if (rest.length > 0) {
    try {
      ingestPack(forge.store, rest);
    } catch {
      unpackOk = false;
    }
  }

  const reportLines: string[] = [unpackOk ? 'unpack ok' : 'unpack corrupt pack'];
  for (const cmd of commands) {
    const fail = (msg: string): void => { reportLines.push(`ng ${cmd.ref} ${msg}`); };
    if (!unpackOk) { fail('unpacker error'); continue; }
    const current = repo.refs.get(cmd.ref) ?? ZERO;
    if (cmd.newOid === ZERO) {
      // delete
      if (!repo.refs.has(cmd.ref)) { fail('reference does not exist'); continue; }
      if (cmd.ref === `refs/heads/${repo.defaultBranch}`) { fail('deletion of the current branch prohibited'); continue; }
      if (cmd.oldOid !== ZERO && cmd.oldOid !== current) { fail('stale info'); continue; }
      repo.refs.delete(cmd.ref);
      repo.refsVersion += 1;
      reportLines.push(`ok ${cmd.ref}`);
      continue;
    }
    if (!forge.store.has(cmd.newOid)) { fail('missing object'); continue; }
    if (cmd.oldOid === ZERO) {
      if (repo.refs.has(cmd.ref)) { fail('reference already exists'); continue; }
      repo.refs.set(cmd.ref, cmd.newOid);
      repo.refsVersion += 1;
      reportLines.push(`ok ${cmd.ref}`);
      continue;
    }
    if (cmd.oldOid !== current) { fail('stale info'); continue; }
    if (cmd.oldOid !== cmd.newOid && !isAncestor(forge.store, cmd.oldOid, cmd.newOid)) {
      fail('non-fast-forward');
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    repo.refsVersion += 1;
    reportLines.push(`ok ${cmd.ref}`);
  }
  repo.updatedAt = forge.nowIso();

  if (!wantReport) return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.alloc(0) };
  const reportStream = Buffer.concat([...reportLines.map((l) => pktLine(`${l}\n`)), PKT_FLUSH]);
  if (!sideband) return { status: 200, contentType: 'application/x-git-receive-pack-result', body: reportStream };
  // Wrap each report pkt-line in a band-1 packet.
  const wrapped: Buffer[] = [];
  let i = 0;
  const rawLines = reportLines.map((l) => pktLine(`${l}\n`));
  for (const line of rawLines) {
    wrapped.push(pktLine(Buffer.concat([Buffer.from([1]), line])));
  }
  void i;
  wrapped.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(wrapped) };
}

// ---------- entry point ----------

export function handleGit(
  forge: Forge,
  req: IncomingMessage,
  method: string,
  owner: string,
  repoName: string,
  sub: string,
  query: URLSearchParams,
  raw: Buffer,
): GitResult | undefined {
  const repo = forge.getRepo(owner, repoName);
  if (sub === '/info/refs' && method === 'GET') {
    if (!repo) return text(404, 'repository not found');
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      const version = req.headers['git-protocol'];
      if (version === 'version=2') return v2Advertisement();
      return v0Advertisement(forge, repo, 'git-upload-pack');
    }
    if (service === 'git-receive-pack') return v0Advertisement(forge, repo, 'git-receive-pack');
    return text(400, 'invalid service');
  }
  if (sub === '/git-upload-pack' && method === 'POST') {
    if (!repo) return text(404, 'repository not found');
    return uploadPack(forge, repo, raw);
  }
  if (sub === '/git-receive-pack' && method === 'POST') {
    if (!repo) return text(404, 'repository not found');
    return receivePack(forge, repo, raw);
  }
  return undefined;
}
