// Packfile and pkt-line machinery: the wire formats of git smart HTTP.
// Writer emits plain (non-delta) objects; the reader resolves OFS_DELTA and REF_DELTA,
// including thin packs whose bases live in the caller's store.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { ObjectStore, ObjType } from './gitobj.ts';

// ---------- pkt-line ----------

export const PKT_MAX_PAYLOAD = 65516; // 65520 including the 4-byte header

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_MAX_PAYLOAD) throw new Error('pkt-line too long');
  const head = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

function parseLen(buf: Buffer, i: number): number {
  const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
  if (Number.isNaN(len)) throw new Error('bad pkt-line length');
  return len;
}

/** Parse a whole buffer of pkt-lines; throws on trailing garbage. */
export function parsePackets(buf: Buffer): Packet[] {
  const out: Packet[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new Error('truncated pkt-line header');
    const len = parseLen(buf, i);
    if (len === 0) { out.push({ kind: 'flush' }); i += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim' }); i += 4; continue; }
    if (len === 2) { out.push({ kind: 'response-end' }); i += 4; continue; }
    if (len < 4 || i + len > buf.length) throw new Error('bad pkt-line length');
    out.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return out;
}

/** Split a receive-pack body: pkt-line command block, then the raw pack bytes after the flush. */
export function splitCommandBlock(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseLen(buf, i);
    if (len === 0) { i += 4; return { packets, rest: buf.subarray(i) }; }
    if (len === 1) { packets.push({ kind: 'delim' }); i += 4; continue; }
    if (len === 2) { packets.push({ kind: 'response-end' }); i += 4; continue; }
    if (len < 4 || i + len > buf.length) throw new Error('bad pkt-line length');
    packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { packets, rest: Buffer.alloc(0) };
}

// ---------- pack writer ----------

const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function packEntryHeader(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_NUM[type] << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    bytes.push(first | 0x80);
    first = size & 0x7f;
    size >>= 7;
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a version-2 pack of the given objects (sha, type, payload), plain entries only. */
export function buildPack(entries: { sha: string; type: ObjType; payload: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length, 8);
  parts.push(head);
  for (const e of entries) {
    parts.push(packEntryHeader(e.type, e.payload.length));
    parts.push(deflateSync(e.payload));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------- delta ----------

/** Apply a git delta payload to a base payload. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[i];
      i += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const dstSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (i < delta.length) {
    const op = delta[i];
    i += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[i]; i += 1; }
      if (op & 0x02) { offset |= delta[i] << 8; i += 1; }
      if (op & 0x04) { offset |= delta[i] << 16; i += 1; }
      if (op & 0x08) { offset |= delta[i] << 24; i += 1; }
      if (op & 0x10) { size = delta[i]; i += 1; }
      if (op & 0x20) { size |= delta[i] << 8; i += 1; }
      if (op & 0x40) { size |= delta[i] << 16; i += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      out.push(delta.subarray(i, i + op));
      produced += op;
      i += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== dstSize || result.length !== dstSize) throw new Error('delta result size mismatch');
  return result;
}

// ---------- pack reader ----------

const NUM_TYPE: Record<number, ObjType | 'ofs' | 'ref'> = {
  1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs', 7: 'ref',
};

interface RawEntry {
  offset: number;
  kind: ObjType | 'ofs' | 'ref';
  data: Buffer; // inflated payload (the object itself, or a delta program)
  baseOffset?: number;
  baseSha?: string;
}

/**
 * Inflate the zlib stream starting at `start`; returns the payload and the offset just past it.
 * inflateSync tolerates trailing bytes, so the exact end is the smallest window that inflates:
 * double to bracket it, then binary-search the boundary.
 */
function inflateAt(pack: Buffer, start: number, exactEnd?: number): { payload: Buffer; end: number } {
  if (exactEnd !== undefined) {
    // The stream is known to end exactly here (the pack's last object, right
    // before the trailer): one inflate, no search.
    return { payload: inflateSync(pack.subarray(start, exactEnd)), end: exactEnd };
  }
  const tryEnd = (end: number): Buffer | null => {
    try {
      return inflateSync(pack.subarray(start, end));
    } catch {
      return null;
    }
  };
  let lo = start + 1; // known (or assumed) too short
  let hi = Math.min(pack.length, start + 128);
  let payload = tryEnd(hi);
  while (payload === null) {
    lo = hi;
    if (hi >= pack.length) throw new Error('corrupt zlib stream in pack');
    hi = Math.min(pack.length, hi * 2);
    payload = tryEnd(hi);
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const attempt = tryEnd(mid);
    if (attempt === null) lo = mid;
    else { hi = mid; payload = attempt; }
  }
  return { payload: payload!, end: hi };
}

function parseEntries(pack: Buffer): { entries: RawEntry[]; count: number } {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack');
  const count = pack.readUInt32BE(8);
  const entries: RawEntry[] = [];
  let offset = 12;
  for (let n = 0; n < count; n += 1) {
    const entryOffset = offset;
    let byte = pack[offset];
    offset += 1;
    const typeNum = (byte >> 4) & 0x07;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
    }
    const kind = NUM_TYPE[typeNum];
    if (!kind) throw new Error(`unknown pack object type ${typeNum}`);
    const entry: RawEntry = { offset: entryOffset, kind, data: Buffer.alloc(0) };
    if (kind === 'ofs') {
      byte = pack[offset];
      offset += 1;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset];
        offset += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      entry.baseOffset = entryOffset - back;
    } else if (kind === 'ref') {
      entry.baseSha = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const { payload, end } = inflateAt(pack, offset, n === count - 1 ? pack.length - 20 : undefined);
    entry.data = payload;
    offset = end;
    entries.push(entry);
  }
  return { entries, count };
}

export interface PackObject {
  sha: string;
  type: ObjType;
  payload: Buffer;
}

/**
 * Parse a pack and resolve all deltas. `external` supplies REF_DELTA bases that are not
 * in the pack (thin packs), looked up by sha.
 */
export function readPack(
  pack: Buffer,
  external?: (sha: string) => { type: ObjType; payload: Buffer } | undefined,
  hashObject?: (type: ObjType, payload: Buffer) => string,
): { objects: PackObject[]; count: number } {
  const { entries, count } = parseEntries(pack);
  const byOffset = new Map<number, number>();
  entries.forEach((e, i) => byOffset.set(e.offset, i));
  const resolved = new Array<{ type: ObjType; payload: Buffer } | undefined>(entries.length);
  const shaCache = new Array<string | undefined>(entries.length);

  const resolve = (idx: number): { type: ObjType; payload: Buffer } => {
    const hit = resolved[idx];
    if (hit) return hit;
    const entry = entries[idx];
    let out: { type: ObjType; payload: Buffer };
    if (entry.kind === 'ofs') {
      const baseIdx = byOffset.get(entry.baseOffset!);
      if (baseIdx === undefined) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseIdx);
      out = { type: base.type, payload: applyDelta(base.payload, entry.data) };
    } else if (entry.kind === 'ref') {
      let base: { type: ObjType; payload: Buffer } | undefined;
      for (let j = 0; j < entries.length; j += 1) {
        if (j !== idx && shaOf(j) === entry.baseSha) { base = resolve(j); break; }
      }
      if (!base) base = external?.(entry.baseSha!);
      if (!base) throw new Error('ref-delta base not found');
      out = { type: base.type, payload: applyDelta(base.payload, entry.data) };
    } else {
      out = { type: entry.kind, payload: entry.data };
    }
    resolved[idx] = out;
    return out;
  };
  const shaOf = (idx: number): string => {
    const hit = shaCache[idx];
    if (hit) return hit;
    const r = resolve(idx);
    const sha = hashObject
      ? hashObject(r.type, r.payload)
      : createHash('sha1').update(Buffer.from(`${r.type} ${r.payload.length}\0`, 'utf8')).update(r.payload).digest('hex');
    shaCache[idx] = sha;
    return sha;
  };

  const objects = entries.map((_, idx) => {
    const r = resolve(idx);
    return { sha: shaOf(idx), type: r.type, payload: r.payload };
  });
  return { objects, count };
}

/** Store every object of a pack into the store; returns the object list. */
export function ingestPack(store: ObjectStore, pack: Buffer): PackObject[] {
  const { objects } = readPack(pack, (sha) => store.get(sha), (t, p) => store.hash(t, p));
  for (const o of objects) store.put(o.type, o.payload);
  return objects;
}
