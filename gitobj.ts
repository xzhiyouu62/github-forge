// Git object model: content-addressed blobs, trees, commits and tags in memory.
// Pure Node built-ins; object ids are SHA-1 over "<type> <size>\0<payload>", exactly as git computes them.

import { createHash } from 'node:crypto';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: ObjType;
  readonly payload: Buffer;
}

export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  hash(type: ObjType, payload: Buffer): string {
    const head = Buffer.from(`${type} ${payload.length}\0`, 'utf8');
    return createHash('sha1').update(head).update(payload).digest('hex');
  }

  put(type: ObjType, payload: Buffer): string {
    const sha = this.hash(type, payload);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, payload });
    return sha;
  }

  get(sha: string): GitObject | undefined {
    return this.objects.get(sha);
  }

  has(sha: string): boolean {
    return this.objects.has(sha);
  }
}

// ---------- trees ----------

export interface TreeEntry {
  mode: string; // '100644' | '100755' | '120000' | '40000'
  name: string;
  sha: string;
}

/** Git's tree sort key: directories compare as if their name ended in '/'. */
function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : 1));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(payload: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < payload.length) {
    const sp = payload.indexOf(0x20, i);
    const mode = payload.subarray(i, sp).toString('utf8');
    const nul = payload.indexOf(0x00, sp);
    const name = payload.subarray(sp + 1, nul).toString('utf8');
    const sha = payload.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, sha });
    i = nul + 21;
  }
  return out;
}

/** Flatten a tree (recursively) into path -> blob entry. */
export function flattenTree(store: ObjectStore, treeSha: string, prefix = '', out = new Map<string, TreeEntry>()): Map<string, TreeEntry> {
  const obj = store.get(treeSha);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.payload)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(store, e.sha, path, out);
    else out.set(path, e);
  }
  return out;
}

/** Read one path's entry from a tree, or undefined. */
export function treeEntryAt(store: ObjectStore, treeSha: string, path: string): TreeEntry | undefined {
  const parts = path.split('/');
  let cur = treeSha;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = store.get(cur);
    if (!obj || obj.type !== 'tree') return undefined;
    const entry = parseTree(obj.payload).find((e) => e.name === parts[i]);
    if (!entry) return undefined;
    if (i === parts.length - 1) return entry;
    if (entry.mode !== '40000') return undefined;
    cur = entry.sha;
  }
  return undefined;
}

/** Return a new root tree sha with `path` set to `blobSha` (or removed when blobSha is null). */
export function updateTree(store: ObjectStore, rootSha: string | null, path: string, blobSha: string | null, mode = '100644'): string {
  const parts = path.split('/');
  function rec(treeSha: string | null, depth: number): string {
    const entries: TreeEntry[] = treeSha ? parseTree(store.get(treeSha)!.payload) : [];
    const name = parts[depth];
    const idx = entries.findIndex((e) => e.name === name);
    if (depth === parts.length - 1) {
      if (blobSha === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else if (idx >= 0) {
        entries[idx] = { mode, name, sha: blobSha };
      } else {
        entries.push({ mode, name, sha: blobSha });
      }
    } else {
      const childSha = idx >= 0 && entries[idx].mode === '40000' ? entries[idx].sha : null;
      const newChild = rec(childSha, depth + 1);
      const childObj = store.get(newChild);
      const empty = childObj && childObj.type === 'tree' && childObj.payload.length === 0;
      if (idx >= 0) {
        if (empty) entries.splice(idx, 1);
        else entries[idx] = { mode: '40000', name, sha: newChild };
      } else if (!empty) {
        entries.push({ mode: '40000', name, sha: newChild });
      }
    }
    return store.put('tree', serializeTree(entries));
  }
  return rec(rootSha, 0);
}

export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// ---------- commits ----------

export interface Identity {
  name: string;
  email: string;
  epochSec: number;
  tz?: string;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function identLine(id: Identity): string {
  return `${id.name} <${id.email}> ${id.epochSec} ${id.tz ?? '+0000'}`;
}

export function createCommit(
  store: ObjectStore,
  tree: string,
  parents: string[],
  author: Identity,
  committer: Identity,
  message: string,
): string {
  let text = `tree ${tree}\n`;
  for (const p of parents) text += `parent ${p}\n`;
  text += `author ${identLine(author)}\ncommitter ${identLine(committer)}\n\n${message}`;
  return store.put('commit', Buffer.from(text, 'utf8'));
}

export function parseCommit(payload: Buffer): CommitInfo {
  const text = payload.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

/** Parse "Name <email> 1234567890 +0000" into parts. */
export function parseIdent(line: string): { name: string; email: string; epochSec: number; dateIso: string } {
  const m = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!m) return { name: line, email: '', epochSec: 0, dateIso: new Date(0).toISOString() };
  const epochSec = Number(m[3]);
  return { name: m[1], email: m[2], epochSec, dateIso: new Date(epochSec * 1000).toISOString() };
}

/** All ancestors of `tip` (including tip), breadth-first. */
export function ancestors(store: ObjectStore, tip: string): string[] {
  const seen = new Set<string>();
  const queue = [tip];
  const out: string[] = [];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = store.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    out.push(sha);
    for (const p of parseCommit(obj.payload).parents) queue.push(p);
  }
  return out;
}

export function isAncestor(store: ObjectStore, maybeAncestor: string, tip: string): boolean {
  return ancestors(store, tip).includes(maybeAncestor);
}

/** A common ancestor of two commits (the first found walking from b), or null. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const aSet = new Set(ancestors(store, a));
  for (const cand of ancestors(store, b)) {
    if (aSet.has(cand)) return cand;
  }
  return null;
}
