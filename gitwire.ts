// Git smart-HTTP wire layer: info/refs, upload-pack (protocol v2 + v0
// fallback) and receive-pack (v0), speaking pkt-line, sideband and packfile
// through ./pktline.ts and ./packfile.ts.
//
// The object store is the sibling's GitStore (./gitmodel.ts), reached
// through ForgeContext (./service.ts); the repository registry is the
// sibling's Store. This module only depends on the GitStore read/write/ref
// primitives plus Store.getRepo, so a shallow or deep fetch shares one
// selection walk over readObject. (Note: GitStore.walkReachable does not
// follow tag targets, so fetch selection is implemented here directly on
// readObject instead.)
//
// Wiring (app.ts owns auth and the route table; it must pass the buffered
// POST body through as the 4th argument — see the snippet at the bottom of
// this file's report):
//   handleInfoRefs(req, res, ctx)
//   handleUploadPack(req, res, ctx, body)
//   handleReceivePack(req, res, ctx, body)
// A repository that was never created via REST does not exist:
// Store.getRepo returns null and the handlers answer 404 on info/refs and
// on the POST endpoints.
//
// Rules honoured here:
// - Nothing shells out, touches the network, or reads the clock. Malformed
//   input is answered 400 (or ignored) and the server keeps serving;
//   unexpected internal errors are answered 500, never thrown.
// - Pushed objects are stored verbatim; ref updates are fast-forward only
//   and applied per ref (ok refs move, ng refs do not, no atomic rollback),
//   and a refused update still unpacks.
//
// Only Node built-ins are used.

import { unlinkSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import {
  encodeDelim,
  encodeFlush,
  encodePktLine,
  encodePktLines,
  encodeSideband,
  decodePktLines,
  parsePktLineAt,
} from './pktline.ts';
import type { PktLinePacket } from './pktline.ts';
import { emptyPack, parsePack, writePack } from './packfile.ts';
import type { GitObjectType, PackObject } from './packfile.ts';
import type { GitStore } from './gitmodel.ts';
import type { ForgeContext } from './service.ts';

export const ZERO_OID = '0'.repeat(40);
export const GIT_AGENT = 'forge-git/1.0';

const JSON_TYPE = 'application/json; charset=utf-8';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HEX40_RE = /^[0-9a-f]{40}$/;

const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

const UPLOAD_V0_CAPS =
  `symref=HEAD:refs/heads/main side-band-64k thin-pack no-progress ofs-delta ` +
  `multi_ack_detailed agent=${GIT_AGENT} shallow`;
const RECEIVE_V0_CAPS =
  `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${GIT_AGENT}`;

/** A bounded cache of generated packs: the clone workload re-clones one tip. */
const PACK_CACHE_MAX = 8;
const packCache = new Map<string, Buffer>();

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Everything the handlers need about one repository. */
interface RepoCtx {
  git: GitStore;
  ctx: ForgeContext;
  owner: string;
  repo: string;
}

// --------------------------------------------------------------------------------------------
// small HTTP helpers
// --------------------------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Owner/repo/service from a git smart-HTTP request path + query. */
function parseGitPath(req: IncomingMessage): { owner: string; repo: string; service: string } {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://forge');
  } catch {
    throw new HttpError(404, 'Not Found');
  }
  const parts = url.pathname.split('/').filter((part) => part !== '');
  if (parts.length < 3) throw new HttpError(404, 'Not Found');
  const owner = decodeSegment(parts[0] as string);
  let repo = decodeSegment(parts[1] as string);
  if (repo.endsWith('.git')) repo = repo.slice(0, -'.git'.length);
  const tail = parts.slice(2).join('/');
  let service = '';
  if (tail === 'info/refs') service = url.searchParams.get('service') ?? '';
  else if (tail === 'git-upload-pack') service = 'git-upload-pack';
  else if (tail === 'git-receive-pack') service = 'git-receive-pack';
  else throw new HttpError(404, 'Not Found');
  return { owner, repo, service };
}

function gitProtocolIsV2(req: IncomingMessage): boolean {
  const header = req.headers['git-protocol'];
  const value = Array.isArray(header) ? header[0] : header;
  return value === 'version=2' || value === '2';
}

// --------------------------------------------------------------------------------------------
// repo + ref access
// --------------------------------------------------------------------------------------------

function checkRepo(ctx: ForgeContext, owner: string, repo: string): void {
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo) || repo.endsWith('.git')) {
    throw new HttpError(404, 'Not Found');
  }
  if (ctx.store.getRepo(owner, repo) === null) throw new HttpError(404, 'Not Found');
}

interface StoredObject {
  type: GitObjectType;
  body: Buffer;
}

function readStored(rc: RepoCtx, sha: string): StoredObject | null {
  const found = rc.git.readObject(rc.owner, rc.repo, sha);
  return found === null ? null : { type: found.type, body: found.body };
}

interface RefEntry {
  name: string;
  sha: string;
}

function sortedRefs(rc: RepoCtx): RefEntry[] {
  return rc.git
    .listRefs(rc.owner, rc.repo)
    .map((ref) => ({ name: ref.ref, sha: ref.sha }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function mainSha(rc: RepoCtx): string | null {
  const sha = rc.git.getRef(rc.owner, rc.repo, 'refs/heads/main');
  return sha !== null && sha !== ZERO_OID ? sha : null;
}

/** Delete a ref. GitStore has no delete, so remove the ref file itself. */
function deleteRef(rc: RepoCtx, name: string): void {
  const path = join(rc.ctx.dataDir, rc.owner, `${rc.repo}.git`, name);
  try {
    unlinkSync(path);
  } catch {
    // Already gone: the ref is deleted either way.
  }
}

// --------------------------------------------------------------------------------------------
// object parsing (commit parents/tree, tree entries, tag target)
// --------------------------------------------------------------------------------------------

function parseCommit(body: Buffer): { tree: string; parents: string[] } {
  const blank = body.indexOf('\n\n');
  const header = blank < 0 ? body.toString('utf8') : body.subarray(0, blank).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents };
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTreeEntries(body: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = body.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > body.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: body.subarray(offset, space).toString('ascii'),
      name: body.subarray(space + 1, nul).toString('utf8'),
      oid: body.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function parseTagTarget(body: Buffer): { object: string; type: string } | null {
  const blank = body.indexOf('\n\n');
  const header = blank < 0 ? body.toString('utf8') : body.subarray(0, blank).toString('utf8');
  let object = '';
  let type = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
  }
  if (!HEX40_RE.test(object)) return null;
  return { object, type };
}

/** Follow tag objects to their ultimate target; null when it is not a tag chain. */
function peelTarget(rc: RepoCtx, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const object = readStored(rc, current);
    if (!object) return null;
    if (object.type === 'tag') {
      const target = parseTagTarget(object.body);
      if (!target) return null;
      current = target.object;
      continue;
    }
    return current;
  }
}

/** The commit a ref ultimately points at (through tags), or null. */
function resolveToCommit(rc: RepoCtx, oid: string): string | null {
  const target = peelTarget(rc, oid);
  if (!target) return null;
  const object = readStored(rc, target);
  return object !== null && object.type === 'commit' ? target : null;
}

/** True when `ancestor` is `descendant` or one of its commit parents. */
function isAncestorOrEqual(rc: RepoCtx, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack: string[] = [descendant];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = readStored(rc, oid);
    if (!object) continue;
    if (object.type === 'commit') {
      for (const parent of parseCommit(object.body).parents) stack.push(parent);
    } else if (object.type === 'tag') {
      const target = parseTagTarget(object.body);
      if (target) stack.push(target.object);
    }
  }
  return false;
}

/** The commit an annotated tag peels to, or null (lightweight tags: none). */
function peeledCommit(rc: RepoCtx, ref: RefEntry): string | null {
  const object = readStored(rc, ref.sha);
  if (!object || object.type !== 'tag') return null;
  const target = peelTarget(rc, ref.sha);
  if (!target) return null;
  const targetObject = readStored(rc, target);
  return targetObject !== null && targetObject.type === 'commit' ? target : null;
}

// --------------------------------------------------------------------------------------------
// fetch selection: what a fetch delivers, with shallow/deepen semantics
// --------------------------------------------------------------------------------------------

interface FetchSelection {
  objects: PackObject[];
  shallow: string[];
  unshallow: string[];
  ack: string | null;
}

/**
 * The objects a fetch delivers.
 *
 * - Without depth: everything reachable from `wants` minus everything
 *   reachable from `haves` (haves truncated at the client's shallow
 *   boundaries: a shallow commit's own tree is held, its parents are not).
 * - With `depth` N: only commits within N generations of a want (distance
 *   0 is the want itself), with their trees and blobs. The new shallow
 *   boundary is the set of commits at exactly distance N-1 — git marks a
 *   commit shallow when the depth limit, not the end of history, stops the
 *   walk there, so a root at distance N-1 is shallow while a root reached
 *   with depth to spare is not. Old boundaries now inside the delivered
 *   region (distance < N-1) are reported `unshallow`.
 * - ACK: the first have that is an ancestor-or-equal of a want; else NAK.
 */
function selectFetch(
  rc: RepoCtx,
  wants: string[],
  haves: string[],
  shallowIn: string[],
  depth: number | undefined,
): FetchSelection {
  const cache = new Map<string, StoredObject | null>();
  const getObject = (sha: string): StoredObject | null => {
    if (!cache.has(sha)) cache.set(sha, readStored(rc, sha));
    return cache.get(sha) as StoredObject | null;
  };

  const shallowSet = new Set(shallowIn);
  const included = new Set<string>();
  const commitDist = new Map<string, number>();

  // One visited-set per closure: the included walk and the held walk must
  // not share one, or trees visited while collecting wants would be
  // skipped while collecting haves and already-held objects re-sent.
  const treeClosureInto = (treeSha: string, into: Set<string>, seen: Set<string>): void => {
    if (seen.has(treeSha)) return;
    seen.add(treeSha);
    const object = getObject(treeSha);
    if (!object) throw new Error(`object ${treeSha} is missing from the store`);
    if (object.type !== 'tree') throw new Error(`object ${treeSha} is not a tree`);
    into.add(treeSha);
    for (const entry of parseTreeEntries(object.body)) {
      if (entry.mode === '160000') continue; // gitlink: a commit this repo does not hold
      if (entry.mode === '40000') treeClosureInto(entry.oid, into, seen);
      else {
        if (!getObject(entry.oid)) throw new Error(`object ${entry.oid} is missing from the store`);
        into.add(entry.oid);
      }
    }
  };
  const includedTrees = new Set<string>();
  const heldTrees = new Set<string>();

  // Breadth-first over commits from the wants. Distances are non-decreasing
  // in queue order (edges go to the same distance through tags, or +1 to a
  // parent), so the first visit to a commit is its shortest distance.
  const queue: Array<{ oid: string; dist: number }> = wants.map((oid) => ({ oid, dist: 0 }));
  const seenTags = new Set<string>();
  for (let head = 0; head < queue.length; head += 1) {
    const { oid, dist } = queue[head] as { oid: string; dist: number };
    const object = getObject(oid);
    if (!object) throw new Error(`object ${oid} is missing from the store`);
    if (object.type === 'tag') {
      if (seenTags.has(oid)) continue;
      seenTags.add(oid);
      included.add(oid);
      const target = parseTagTarget(object.body);
      if (target) queue.push({ oid: target.object, dist });
      continue;
    }
    if (object.type === 'commit') {
      const previous = commitDist.get(oid);
      if (previous !== undefined && previous <= dist) continue;
      if (depth !== undefined && dist > depth - 1) continue;
      commitDist.set(oid, dist);
      included.add(oid);
      const { tree, parents } = parseCommit(object.body);
      treeClosureInto(tree, included, includedTrees);
      for (const parent of parents) {
        if (depth === undefined || dist + 1 <= depth - 1) queue.push({ oid: parent, dist: dist + 1 });
      }
      continue;
    }
    included.add(oid);
    if (object.type === 'tree') treeClosureInto(oid, included, includedTrees);
  }

  // What the client already holds: reachable from the haves, except that a
  // shallow boundary's parents are not held (the client never received them).
  const held = new Set<string>();
  const heldSeen = new Set<string>();
  const heldStack: string[] = [...haves];
  while (heldStack.length) {
    const oid = heldStack.pop() as string;
    if (heldSeen.has(oid)) continue;
    heldSeen.add(oid);
    const object = getObject(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      held.add(oid);
      const { tree, parents } = parseCommit(object.body);
      treeClosureInto(tree, held, heldTrees);
      if (!shallowSet.has(oid)) {
        for (const parent of parents) heldStack.push(parent);
      }
    } else if (object.type === 'tag') {
      held.add(oid);
      const target = parseTagTarget(object.body);
      if (target) heldStack.push(target.object);
    } else if (object.type === 'tree') {
      treeClosureInto(oid, held, heldTrees);
    } else {
      held.add(oid);
    }
  }

  // ACK: the first have that is an ancestor-or-equal of a want.
  const ancestors = new Set<string>();
  const ancestorStack: string[] = [...wants];
  while (ancestorStack.length) {
    const oid = ancestorStack.pop() as string;
    if (ancestors.has(oid)) continue;
    ancestors.add(oid);
    const object = getObject(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      for (const parent of parseCommit(object.body).parents) ancestorStack.push(parent);
    } else if (object.type === 'tag') {
      const target = parseTagTarget(object.body);
      if (target) ancestorStack.push(target.object);
    }
  }
  const ack = haves.find((have) => ancestors.has(have)) ?? null;

  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== undefined) {
    for (const [sha, dist] of commitDist) {
      if (dist === depth - 1) shallow.push(sha);
    }
    for (const boundary of shallowIn) {
      const dist = commitDist.get(boundary);
      if (dist !== undefined && dist < depth - 1) unshallow.push(boundary);
    }
  }

  const objects: PackObject[] = [];
  for (const sha of included) {
    if (held.has(sha)) continue;
    const object = getObject(sha);
    if (!object) continue;
    objects.push({ sha, type: object.type, body: object.body });
  }
  objects.sort((a, b) => (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0));
  return { objects, shallow, unshallow, ack };
}

function packForFetch(
  rc: RepoCtx,
  wants: string[],
  haves: string[],
  shallowIn: string[],
  depth: number | undefined,
  selection: FetchSelection,
): Buffer {
  const key = [
    rc.owner,
    rc.repo,
    wants.join(','),
    `depth=${depth ?? ''}`,
    [...haves].sort().join(','),
    [...shallowIn].sort().join(','),
  ].join('|');
  const hit = packCache.get(key);
  if (hit) return hit;
  const pack = writePack(selection.objects);
  packCache.set(key, pack);
  while (packCache.size > PACK_CACHE_MAX) {
    const oldest = packCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    packCache.delete(oldest);
  }
  return pack;
}

// --------------------------------------------------------------------------------------------
// request validation
// --------------------------------------------------------------------------------------------

/** Decode a whole request body as pkt-lines; malformed input is a 400. */
function decodeRequest(body: Buffer): PktLinePacket[] {
  try {
    const { packets, consumed } = decodePktLines(body);
    if (consumed !== body.length) throw new Error('trailing bytes after the pkt-line stream');
    return packets;
  } catch (err) {
    throw new HttpError(400, `malformed pkt-line request: ${(err as Error).message}`);
  }
}

function packetLines(packets: readonly PktLinePacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

function requireOid(value: string, what: string): string {
  if (!HEX40_RE.test(value)) throw new HttpError(400, `${what} is not an object id: ${value}`);
  return value;
}

// --------------------------------------------------------------------------------------------
// info/refs
// --------------------------------------------------------------------------------------------

function v0Advertisement(rc: RepoCtx, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const refs = sortedRefs(rc);
  const refLines: string[] = [];
  if (refs.length === 0) {
    refLines.push(`${ZERO_OID} capabilities^{}`);
  } else {
    const head = mainSha(rc);
    refLines.push(`${head ?? ZERO_OID} HEAD`);
    for (const ref of refs) {
      refLines.push(`${ref.sha} ${ref.name}`);
      const peeled = peeledCommit(rc, ref);
      if (peeled) refLines.push(`${peeled} ${ref.name}^{}`);
    }
  }
  refLines[0] = `${refLines[0] as string}\u0000${caps}`;
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), encodeFlush()];
  for (const line of refLines) parts.push(encodePktLine(`${line}\n`));
  parts.push(encodeFlush());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    'fetch=shallow filter\n',
    'ls-refs=unborn\n',
    'object-format=sha1\n',
    `agent=${GIT_AGENT}\n`,
    'flush',
  ]);
}

/**
 * GET /<owner>/<repo>.git/info/refs?service=git-upload-pack|git-receive-pack
 * Upload-pack answers v2 when the request carries `Git-Protocol:
 * version=2`, v0 otherwise; receive-pack is always v0. A missing repo is a
 * JSON 404.
 */
export function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ForgeContext,
): void {
  try {
    const { owner, repo, service } = parseGitPath(req);
    checkRepo(ctx, owner, repo);
    const rc: RepoCtx = { git: ctx.git, ctx, owner, repo };
    const effectiveService = service === '' ? 'git-upload-pack' : service;
    if (effectiveService !== 'git-upload-pack' && effectiveService !== 'git-receive-pack') {
      throw new HttpError(404, 'Not Found');
    }
    if (effectiveService === 'git-upload-pack' && gitProtocolIsV2(req)) {
      sendBuffer(res, 200, UPLOAD_ADVERTISEMENT, v2Advertisement());
      return;
    }
    sendBuffer(
      res,
      200,
      effectiveService === 'git-upload-pack' ? UPLOAD_ADVERTISEMENT : RECEIVE_ADVERTISEMENT,
      v0Advertisement(rc, effectiveService),
    );
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { message: err.message });
      return;
    }
    process.stderr.write(`[gitwire] info/refs failed: ${(err as Error).message}\n`);
    sendJson(res, 500, { message: 'Internal Server Error' });
  }
}

// --------------------------------------------------------------------------------------------
// upload-pack: ls-refs and fetch (v2), fetch (v0)
// --------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  const seenWant = new Set<string>();
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0] as string;
      requireOid(oid, 'want');
      if (!seenWant.has(oid)) {
        seenWant.add(oid);
        wants.push(oid);
      }
    } else if (line.startsWith('have ')) {
      haves.push(requireOid(line.slice(5).trim(), 'have'));
    } else if (line.startsWith('shallow ')) {
      shallow.push(requireOid(line.slice(8).trim(), 'shallow'));
    } else if (line.startsWith('deepen ')) {
      const value = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(value) && value > 0) depth = value;
    }
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not,
    // agent, object-format, done: accepted and (where they carry no
    // selection meaning) ignored.
  }
  return { wants, haves, shallow, depth };
}

function lsRefsResponse(rc: RepoCtx, lines: readonly string[], res: ServerResponse): void {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    // unborn, agent, object-format: accepted, no extra work (unborn refs
    // are always reported when they exist).
  }
  const refs = sortedRefs(rc);
  const main = mainSha(rc);
  interface OutRef {
    oid: string;
    name: string;
    unborn: boolean;
    symrefTarget?: string;
    peeled?: string;
  }
  const out: OutRef[] = [];
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (keep('HEAD')) {
    out.push(
      main
        ? {
            oid: main,
            name: 'HEAD',
            unborn: false,
            ...(symrefs ? { symrefTarget: 'refs/heads/main' } : {}),
          }
        : {
            oid: ZERO_OID,
            name: 'HEAD',
            unborn: true,
            ...(symrefs ? { symrefTarget: 'refs/heads/main' } : {}),
          },
    );
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    const entry: OutRef = { oid: ref.sha, name: ref.name, unborn: false };
    if (peel) {
      const peeled = peeledCommit(rc, ref);
      if (peeled) entry.peeled = peeled;
    }
    out.push(entry);
  }
  const parts: Buffer[] = [];
  for (const ref of out) {
    let line: string;
    if (ref.unborn) line = `unborn ${ref.name}`;
    else line = `${ref.oid} ${ref.name}`;
    if (ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
    if (ref.peeled) line += ` peeled:${ref.peeled}`;
    parts.push(encodePktLine(`${line}\n`));
  }
  parts.push(encodeFlush());
  sendBuffer(res, 200, UPLOAD_RESULT, Buffer.concat(parts));
}

function fetchV2Response(rc: RepoCtx, args: FetchArgs, res: ServerResponse): void {
  for (const want of args.wants) {
    if (!rc.git.hasObject(rc.owner, rc.repo, want)) {
      throw new HttpError(400, `want ${want} is not known`);
    }
  }
  const selection = selectFetch(rc, args.wants, args.haves, args.shallow, args.depth);
  const pack = args.wants.length
    ? packForFetch(rc, args.wants, args.haves, args.shallow, args.depth, selection)
    : emptyPack();
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  parts.push(encodePktLine(selection.ack ? `ACK ${selection.ack}\n` : 'NAK\n'));
  parts.push(encodeDelim());
  if (selection.shallow.length || selection.unshallow.length) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const sha of selection.shallow) parts.push(encodePktLine(`shallow ${sha}\n`));
    for (const sha of selection.unshallow) parts.push(encodePktLine(`unshallow ${sha}\n`));
    parts.push(encodeDelim());
  }
  const wantedRefs = sortedRefs(rc).filter((ref) => args.wants.includes(ref.sha));
  if (wantedRefs.length) {
    parts.push(encodePktLine('wanted-refs\n'));
    for (const ref of wantedRefs) parts.push(encodePktLine(`${ref.sha} ${ref.name}\n`));
    parts.push(encodeDelim());
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(encodeSideband(1, pack));
  parts.push(encodeFlush());
  sendBuffer(res, 200, UPLOAD_RESULT, Buffer.concat(parts));
}

function fetchV0Response(rc: RepoCtx, args: FetchArgs, res: ServerResponse): void {
  for (const want of args.wants) {
    if (!rc.git.hasObject(rc.owner, rc.repo, want)) {
      throw new HttpError(400, `want ${want} is not known`);
    }
  }
  const selection = selectFetch(rc, args.wants, args.haves, args.shallow, args.depth);
  const pack = args.wants.length
    ? packForFetch(rc, args.wants, args.haves, args.shallow, args.depth, selection)
    : emptyPack();
  const parts: Buffer[] = [];
  parts.push(encodePktLine(selection.ack ? `ACK ${selection.ack}\n` : 'NAK\n'));
  for (const sha of selection.shallow) parts.push(encodePktLine(`shallow ${sha}\n`));
  for (const sha of selection.unshallow) parts.push(encodePktLine(`unshallow ${sha}\n`));
  parts.push(encodeSideband(1, pack));
  parts.push(encodeFlush());
  sendBuffer(res, 200, UPLOAD_RESULT, Buffer.concat(parts));
}

/**
 * POST /<owner>/<repo>.git/git-upload-pack. The buffered request body is
 * passed as `body` by the wiring in app.ts (the request stream is already
 * consumed there, so the handler cannot re-read it). Protocol v2 when the
 * request carries `Git-Protocol: version=2`; without the header the body
 * decides — a leading `command=` line is v2, a leading `want ` line is v0.
 */
export function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ForgeContext,
  body?: Buffer,
): void {
  try {
    const { owner, repo } = parseGitPath(req);
    checkRepo(ctx, owner, repo);
    if (body === undefined || body.length === 0) {
      throw new HttpError(400, 'empty upload-pack request');
    }
    const rc: RepoCtx = { git: ctx.git, ctx, owner, repo };
    const packets = decodeRequest(body);
    const lines = packetLines(packets);
    if (!lines.length) throw new HttpError(400, 'empty upload-pack request');
    const first = (lines[0] as string).replace(/\n$/, '');
    const v2 = req.headers['git-protocol'] !== undefined
      ? gitProtocolIsV2(req)
      : first.startsWith('command=');
    if (v2) {
      if (!first.startsWith('command=')) {
        throw new HttpError(400, `expected a command line, got ${JSON.stringify(first.slice(0, 40))}`);
      }
      const command = first.slice('command='.length).trim();
      // Lines after the command, skipping agent=/object-format= (accepted
      // whenever the capability was advertised) and the delim packet.
      const args = lines.slice(1).filter((line) => {
        const text = line.replace(/\n$/, '');
        return text !== '' && !text.startsWith('agent=') && !text.startsWith('object-format=');
      });
      if (command === 'ls-refs') {
        lsRefsResponse(rc, args, res);
        return;
      }
      if (command === 'fetch') {
        fetchV2Response(rc, parseFetchArgs(args), res);
        return;
      }
      throw new HttpError(400, `unknown upload-pack command ${JSON.stringify(command)}`);
    }
    // v0: two sections — wants (+ shallow/deepen), flush, haves + done,
    // flush. The packets were decoded as one stream; section boundaries
    // do not change the meaning of any line, so parse them all together.
    if (!first.startsWith('want ')) {
      throw new HttpError(400, `expected a want line, got ${JSON.stringify(first.slice(0, 40))}`);
    }
    fetchV0Response(rc, parseFetchArgs(lines), res);
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { message: err.message });
      return;
    }
    process.stderr.write(`[gitwire] upload-pack failed: ${(err as Error).message}\n`);
    sendJson(res, 500, { message: 'Internal Server Error' });
  }
}

// --------------------------------------------------------------------------------------------
// receive-pack (v0)
// --------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function isValidRefName(ref: string): boolean {
  if (!ref.startsWith('refs/')) return false;
  if (ref.length > 200) return false;
  if (/[\s\u0000-\u001f~^:?*[\]\\]/.test(ref)) return false;
  if (ref.includes('..') || ref.includes('//') || ref.includes('@{')) return false;
  if (ref.endsWith('/') || ref.endsWith('.') || ref.endsWith('.lock')) return false;
  for (const part of ref.split('/')) {
    if (part.length === 0 || part === '.' || part === '..') return false;
  }
  return true;
}

function sanitizeDetail(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').slice(0, 200).trim() || 'unpack failed';
}

/**
 * POST /<owner>/<repo>.git/git-receive-pack (v0 only). The buffered request
 * body is passed as `body` by the wiring in app.ts. Command list pkt-lines,
 * a flush, then the pack bytes immediately. A command list that creates or
 * updates a ref always carries a pack (even an empty one); a delete-only
 * list carries none. Objects are unpacked and stored before any ref moves,
 * so a refused update still unpacks. Ref updates are fast-forward only and
 * applied per ref: the ok refs move, the ng refs do not, with no atomic
 * rollback.
 */
export function handleReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ForgeContext,
  body?: Buffer,
): void {
  try {
    const { owner, repo } = parseGitPath(req);
    checkRepo(ctx, owner, repo);
    if (body === undefined) {
      throw new HttpError(400, 'empty receive-pack request');
    }
    const rc: RepoCtx = { git: ctx.git, ctx, owner, repo };
    rc.git.ensureRepo(owner, repo);
    // Parse pkt-lines until the flush; everything after it is the pack.
    const packets: PktLinePacket[] = [];
    let offset = 0;
    let sawFlush = false;
    try {
      while (offset < body.length) {
        const { packet, nextOffset } = parsePktLineAt(body, offset);
        packets.push(packet);
        offset = nextOffset;
        if (packet.kind === 'flush') {
          sawFlush = true;
          break;
        }
      }
    } catch (err) {
      throw new HttpError(400, `malformed pkt-line request: ${(err as Error).message}`);
    }
    if (!sawFlush) throw new HttpError(400, 'receive-pack request has no flush packet');
    const pack = body.subarray(offset);

    const commands: PushCommand[] = [];
    let sideband = false;
    let firstLine = true;
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      let text = packet.payload.toString('utf8').replace(/\n$/, '');
      if (firstLine) {
        firstLine = false;
        const nul = text.indexOf('\u0000');
        if (nul >= 0) {
          const caps = text.slice(nul + 1).split(' ');
          if (caps.includes('side-band-64k')) sideband = true;
          text = text.slice(0, nul);
        }
      }
      const firstSpace = text.indexOf(' ');
      const secondSpace = firstSpace < 0 ? -1 : text.indexOf(' ', firstSpace + 1);
      if (firstSpace < 0 || secondSpace < 0) {
        throw new HttpError(400, `bad receive-pack command: ${JSON.stringify(text.slice(0, 60))}`);
      }
      const oldOid = text.slice(0, firstSpace);
      const newOid = text.slice(firstSpace + 1, secondSpace);
      const ref = text.slice(secondSpace + 1);
      if (!HEX40_RE.test(oldOid) || !HEX40_RE.test(newOid)) {
        throw new HttpError(400, 'receive-pack command has a bad object id');
      }
      commands.push({ oldOid, newOid, ref });
    }
    if (!commands.length) throw new HttpError(400, 'receive-pack request has no commands');

    // Unpack first, store verbatim, and only then decide about the refs.
    let unpackOk = true;
    let unpackDetail = 'ok';
    const hasUpdates = commands.some((command) => command.newOid !== ZERO_OID);
    if (pack.length > 0) {
      try {
        const objects = parsePack(
          Buffer.from(pack),
          (sha: string) => readStored(rc, sha),
        );
        for (const object of objects) {
          rc.git.writeObject(owner, repo, object.type, object.body);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = sanitizeDetail((err as Error).message);
      }
    } else if (hasUpdates) {
      unpackOk = false;
      unpackDetail = 'missing packfile';
    }

    const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
    if (!unpackOk) {
      for (const command of commands) {
        results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      }
    } else {
      for (const command of commands) {
        if (!isValidRefName(command.ref)) {
          results.push({ ref: command.ref, ok: false, reason: 'invalid refname' });
          continue;
        }
        const current = rc.git.getRef(owner, repo, command.ref);
        if (command.oldOid === ZERO_OID && command.newOid === ZERO_OID) {
          results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
          continue;
        }
        if (command.oldOid === ZERO_OID) {
          // Create.
          if (current !== null) {
            results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
            continue;
          }
          if (!rc.git.hasObject(owner, repo, command.newOid)) {
            results.push({ ref: command.ref, ok: false, reason: 'object not found' });
            continue;
          }
          if (!rc.git.updateRef(owner, repo, command.ref, command.newOid, { force: true })) {
            results.push({ ref: command.ref, ok: false, reason: 'ref update failed' });
            continue;
          }
          results.push({ ref: command.ref, ok: true, reason: '' });
          continue;
        }
        if (command.newOid === ZERO_OID) {
          // Delete.
          if (current === null || current !== command.oldOid) {
            results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
            continue;
          }
          deleteRef(rc, command.ref);
          results.push({ ref: command.ref, ok: true, reason: '' });
          continue;
        }
        // Update: the old value must match, then the new tip must descend
        // from the old one (tag refs are exempt from the ancestry check).
        if (current === null || current !== command.oldOid) {
          results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
          continue;
        }
        if (command.newOid === command.oldOid) {
          results.push({ ref: command.ref, ok: true, reason: '' });
          continue;
        }
        if (!rc.git.hasObject(owner, repo, command.newOid)) {
          results.push({ ref: command.ref, ok: false, reason: 'object not found' });
          continue;
        }
        if (!command.ref.startsWith('refs/tags/')) {
          const oldCommit = resolveToCommit(rc, command.oldOid);
          const newCommit = resolveToCommit(rc, command.newOid);
          if (
            !oldCommit ||
            !newCommit ||
            !isAncestorOrEqual(rc, oldCommit, newCommit)
          ) {
            results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
            continue;
          }
        }
        if (!rc.git.updateRef(owner, repo, command.ref, command.newOid, { force: true })) {
          results.push({ ref: command.ref, ok: false, reason: 'ref update failed' });
          continue;
        }
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
    }

    const reportLines: string[] = [
      unpackOk ? 'unpack ok' : `unpack ${unpackDetail}`,
    ];
    for (const result of results) {
      reportLines.push(
        result.ok ? `ok ${result.ref}` : `ng ${result.ref} ${result.reason}`,
      );
    }
    const inner = encodePktLines(reportLines.map((line) => `${line}\n`));
    const response = sideband
      ? Buffer.concat([encodeSideband(1, inner), encodeFlush()])
      : Buffer.concat([inner, encodeFlush()]);
    sendBuffer(res, 200, RECEIVE_RESULT, response);
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { message: err.message });
      return;
    }
    process.stderr.write(`[gitwire] receive-pack failed: ${(err as Error).message}\n`);
    sendJson(res, 500, { message: 'Internal Server Error' });
  }
}
