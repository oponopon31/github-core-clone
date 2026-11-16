// Packfile (version 2) parsing and generation for the git wire layer.
//
// Layout: "PACK", BE32 version (2 or 3), BE32 object count, then one entry
// per object — a type/size varint, optional delta base, zlib-deflated data —
// and a 20-byte trailer holding the SHA-1 of every preceding byte.
// Entry types: 1 commit, 2 tree, 3 blob, 4 tag, 6 OFS_DELTA, 7 REF_DELTA.
//
// Intake verifies the trailer first, then resolves every delta and checks
// that each resolved object re-hashes to its id. Generation writes plain
// objects only (no deltas): deltas are never required by the suite.
//
// Only Node built-ins are used. Malformed input throws; callers turn that
// into a 400 / unpack error and keep serving.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface PackObject {
  readonly sha: string;
  readonly type: GitObjectType;
  readonly body: Buffer;
}

export interface PackObjectInput {
  readonly sha?: string;
  readonly type: GitObjectType;
  readonly body: Buffer;
}

/** A lookup for REF_DELTA bases the pack does not carry (objects already held). */
export type HaveObjects =
  | ReadonlyMap<string, { readonly type: GitObjectType; readonly body: Buffer }>
  | ((sha: string) => { readonly type: GitObjectType; readonly body: Buffer } | null | undefined);

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** git's object id: SHA-1 over "<type> <size>\0" + the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\u0000`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

function lookupHave(
  haveObjects: HaveObjects | undefined,
  sha: string,
): { type: GitObjectType; body: Buffer } | null {
  if (!haveObjects) return null;
  if (typeof haveObjects === 'function') return haveObjects(sha) ?? null;
  return haveObjects.get(sha) ?? null;
}

/**
 * Inflate one zlib stream starting at `offset` in `buf` (which must end at
 * `limit`). Returns the inflated bytes and the offset just past the stream.
 * `inflateSync` with `info: true` reports the compressed bytes the stream
 * consumed through `engine.bytesWritten`.
 */
function inflateAt(buf: Buffer, offset: number, limit: number): { data: Buffer; next: number } {
  if (offset >= limit) throw new Error(`zlib stream at offset ${offset} is truncated`);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(buf.subarray(offset, limit), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) {
    throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  }
  return { data: result.buffer, next: offset + consumed };
}

/** Read a git delta size varint (7 bits per byte, little-endian groups). */
function readDeltaSize(delta: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  for (;;) {
    if (cursor >= delta.length) throw new Error('delta size varint is truncated');
    const byte = delta[cursor];
    cursor += 1;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(byte & 0x80)) break;
    if (shift > 63) throw new Error('delta size varint is too long');
  }
  return { value, next: cursor };
}

/**
 * Apply a git delta to a base object's bytes. Strict: the delta's source
 * size must equal the base size, the produced size must equal the target
 * size exactly, opcode 0 is invalid, and no copy may run past the base.
 */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const source = readDeltaSize(delta, offset);
  offset = source.next;
  const target = readDeltaSize(delta, offset);
  offset = target.next;
  if (source.value !== base.length) {
    throw new Error(`delta expects a ${source.value}-byte base, got ${base.length}`);
  }
  const out = Buffer.alloc(target.value);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset] * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset] * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > target.value) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > target.value) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== target.value) {
    throw new Error(`delta produced ${written} of ${target.value} bytes`);
  }
  return out;
}

/** The type/size varint heading a pack entry. */
function readEntryHeader(
  buf: Buffer,
  start: number,
): { size: number; typeCode: number; next: number } {
  if (start >= buf.length) throw new Error('pack entry has no size header');
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buf.length) throw new Error('pack entry size varint is truncated');
    byte = buf[offset];
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, typeCode: (first >> 4) & 0x07, next: offset };
}

/** The OFS_DELTA base encoding: a negative offset from the entry's own start. */
function readOfsBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buf.length) throw new Error('ofs-delta has no base offset');
  let byte = buf[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buf.length) throw new Error('ofs-delta base offset is truncated');
    byte = buf[offset];
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** SHA-1 of every pack byte before the 20-byte trailer. */
export function packChecksum(pack: Buffer): string {
  if (pack.length < 20) throw new Error('pack is shorter than its trailer');
  return createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
}

/** True when the pack's trailer matches its bytes. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  if (pack.length < 20) return { ok: false, expected: '', actual: '' };
  const actual = pack.subarray(pack.length - 20).toString('hex');
  return { ok: actual === packChecksum(pack), expected: packChecksum(pack), actual };
}

/**
 * Parse a packfile and resolve every object, including OFS_DELTA (base is
 * an earlier in-pack entry) and REF_DELTA (base is in-pack or supplied via
 * `haveObjects`). The trailer is verified before anything else. Every
 * resolved object is checked to re-hash to its id, and its inflated size is
 * checked against its header. Throws on any corruption.
 */
export function parsePack(buf: Buffer, haveObjects?: HaveObjects): PackObject[] {
  if (buf.length < 32) throw new Error(`pack is ${buf.length} bytes, too short`);
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('pack does not start with PACK');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const trailer = buf.subarray(trailerStart).toString('hex');
  if (trailer !== packChecksum(buf)) {
    throw new Error(`pack trailer ${trailer} does not match its bytes`);
  }

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseSha?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    sha?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readEntryHeader(buf, offset);
    offset = header.next;
    const entry: RawEntry = {
      offset: entryOffset,
      typeCode: header.typeCode,
      size: header.size,
      data: Buffer.alloc(0),
    };
    if (header.typeCode === 6) {
      const base = readOfsBase(buf, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (header.typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseSha = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[header.typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${header.typeCode}`);
    }
    const inflated = inflateAt(buf, offset, trailerStart);
    if (inflated.data.length !== header.size) {
      throw new Error(
        `pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`,
      );
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const resolvedBySha = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; sha: string } => {
    if (entry.resolved && entry.resolvedType && entry.sha) {
      return { type: entry.resolvedType, data: entry.resolved, sha: entry.sha };
    }
    if (resolving.has(entry.offset)) {
      throw new Error(`delta cycle at pack offset ${entry.offset}`);
    }
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) {
        throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      }
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseSha as string;
      const baseEntry = resolvedBySha.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = lookupHave(haveObjects, wanted);
        if (!external) {
          throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        }
        type = external.type;
        data = applyDelta(external.body, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const sha = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.sha = sha;
    resolvedBySha.set(sha, entry);
    resolving.delete(entry.offset);
    return { type, data, sha };
  };

  const objects: PackObject[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!seen.has(resolved.sha)) {
      seen.add(resolved.sha);
      objects.push({ sha: resolved.sha, type: resolved.type, body: resolved.data });
    }
  }
  return objects;
}

/** Encode one object's pack header: the type/size varint. */
function writeEntryHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Build a version 2 packfile from plain objects (no deltas). Entries are
 * deduplicated by id; the trailer is the SHA-1 of everything before it.
 * An empty list yields the 32-byte empty pack (12-byte header + trailer).
 */
export function writePack(objects: Iterable<PackObjectInput>): Buffer {
  const seen = new Set<string>();
  const list: PackObjectInput[] = [];
  for (const object of objects) {
    const sha = object.sha ?? hashObject(object.type, object.body);
    if (seen.has(sha)) continue;
    seen.add(sha);
    list.push(object);
  }
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writeEntryHeader(object.type, object.body.length));
    parts.push(deflateSync(object.body));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** The 32-byte empty pack: header (PACK, version 2, count 0) + trailer. */
export function emptyPack(): Buffer {
  return writePack([]);
}
