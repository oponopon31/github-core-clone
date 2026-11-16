// The shared git object layer: loose objects, refs, trees, commits, merges
// and pack reading. The wire-protocol builder (gitwire.ts) builds on this
// module; the REST contents / pull-request surfaces use it too.
//
// Layout per repository: <dataDir>/<owner>/<repo>.git/
//   objects/xx/<sha>        zlib-deflated "<type> <len>\0<body>"
//   refs/heads/<branch>     plain sha text
//   HEAD                    "ref: refs/heads/main"
// All hashes are SHA-1, as git's classic object format requires.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import type { LogicalClock } from './clock.ts';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  body: Buffer;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  authorEpoch: number;
  committerEpoch: number;
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

const ZERO_SHA = '0000000000000000000000000000000000000000';
const AUTHOR = 'adaiversen <adaiversen@example.invalid>';

export function hashObject(type: ObjectType, body: Buffer): string {
  const header = Buffer.from(`${type} ${body.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(body).digest('hex');
}

function isSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function isBinary(body: Buffer): boolean {
  return body.includes(0);
}

/** LCS-based line diff; returns [additions, deletions]. */
function lineDiff(oldText: string, newText: string): [number, number] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length > 2000 || b.length > 2000) return [b.length, a.length];
  // LCS lengths, one row at a time, keeping the full table small via two rows
  // is not enough to reconstruct; use the classic DP table for small files.
  const n = a.length;
  const m = b.length;
  const dp: number[][] = [];
  for (let i = 0; i <= n; i += 1) dp.push(new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? (dp[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0);
    }
  }
  let i = 0;
  let j = 0;
  let additions = 0;
  let deletions = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      deletions += 1;
      i += 1;
    } else {
      additions += 1;
      j += 1;
    }
  }
  deletions += n - i;
  additions += m - j;
  return [additions, deletions];
}

export class GitStore {
  dataDir: string;
  clock: LogicalClock;
  // Immutable objects are safe to cache: a sha always names the same bytes.
  // Capped and cleared wholesale when full, so memory stays bounded.
  objectCache: Map<string, GitObject> = new Map();

  constructor(dataDir: string, clock: LogicalClock) {
    this.dataDir = dataDir;
    this.clock = clock;
  }

  gitDir(owner: string, repo: string): string {
    return join(this.dataDir, owner, `${repo}.git`);
  }

  ensureRepo(owner: string, repo: string): void {
    const dir = this.gitDir(owner, repo);
    mkdirSync(join(dir, 'objects'), { recursive: true });
    mkdirSync(join(dir, 'refs', 'heads'), { recursive: true });
    const head = join(dir, 'HEAD');
    if (!existsSync(head)) writeFileSync(head, 'ref: refs/heads/main\n');
  }

  objectPath(owner: string, repo: string, sha: string): string {
    return join(this.gitDir(owner, repo), 'objects', sha.slice(0, 2), sha.slice(2));
  }

  hasObject(owner: string, repo: string, sha: string): boolean {
    if (!isSha(sha)) return false;
    return existsSync(this.objectPath(owner, repo, sha));
  }

  readObject(owner: string, repo: string, sha: string): GitObject | null {
    if (!isSha(sha)) return null;
    const cacheKey = `${owner}/${repo}/${sha}`;
    const cached = this.objectCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const path = this.objectPath(owner, repo, sha);
    if (!existsSync(path)) return null;
    try {
      const raw = inflateSync(readFileSync(path));
      const nul = raw.indexOf(0);
      if (nul < 0) return null;
      const header = raw.subarray(0, nul).toString('ascii');
      const [type, len] = header.split(' ');
      if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') return null;
      if (Number(len) !== raw.length - nul - 1) return null;
      const obj: GitObject = { type: type as ObjectType, body: Buffer.from(raw.subarray(nul + 1)) };
      if (this.objectCache.size >= 8192) this.objectCache.clear();
      this.objectCache.set(cacheKey, obj);
      return obj;
    } catch {
      return null;
    }
  }

  writeObject(owner: string, repo: string, type: ObjectType, body: Buffer): string {
    const sha = hashObject(type, body);
    const path = this.objectPath(owner, repo, sha);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      const header = Buffer.from(`${type} ${body.length}\0`, 'ascii');
      writeFileSync(path, deflateSync(Buffer.concat([header, body])));
    }
    if (this.objectCache.size >= 8192) this.objectCache.clear();
    this.objectCache.set(`${owner}/${repo}/${sha}`, { type, body: Buffer.from(body) });
    return sha;
  }

  // ------------------------------------------------------------ refs

  normalizeRef(ref: string): string {
    return ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  }

  getRef(owner: string, repo: string, ref: string): string | null {
    const path = join(this.gitDir(owner, repo), this.normalizeRef(ref));
    if (!existsSync(path)) return null;
    try {
      const text = readFileSync(path, 'utf8').trim();
      return isSha(text) ? text : null;
    } catch {
      return null;
    }
  }

  getBranchTip(owner: string, repo: string, branch: string): string | null {
    return this.getRef(owner, repo, `refs/heads/${branch}`);
  }

  /** Update a ref; refuses a non-fast-forward move unless force is set. */
  updateRef(owner: string, repo: string, ref: string, sha: string, opts: { force?: boolean } = {}): boolean {
    if (!isSha(sha)) return false;
    const fullRef = this.normalizeRef(ref);
    const current = this.getRef(owner, repo, fullRef);
    if (current !== null && current !== sha && opts.force !== true) {
      if (!this.isAncestor(owner, repo, current, sha)) return false;
    }
    const path = join(this.gitDir(owner, repo), fullRef);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${sha}\n`);
    renameSync(tmp, path);
    return true;
  }

  listRefs(owner: string, repo: string): { ref: string; sha: string }[] {
    const out: { ref: string; sha: string }[] = [];
    const refsRoot = join(this.gitDir(owner, repo), 'refs');
    const walk = (dir: string, prefix: string): void => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const child = join(dir, entry.name);
        if (entry.isDirectory()) walk(child, `${prefix}${entry.name}/`);
        else if (entry.isFile()) {
          try {
            const text = readFileSync(child, 'utf8').trim();
            if (isSha(text)) out.push({ ref: `refs/${prefix}${entry.name}`, sha: text });
          } catch {
            // Unreadable ref file: skip it.
          }
        }
      }
    };
    walk(refsRoot, '');
    out.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    return out;
  }

  listBranches(owner: string, repo: string): { name: string; sha: string }[] {
    return this.listRefs(owner, repo)
      .filter((r) => r.ref.startsWith('refs/heads/'))
      .map((r) => ({ name: r.ref.slice('refs/heads/'.length), sha: r.sha }));
  }

  // ------------------------------------------------------------ commits

  readCommit(owner: string, repo: string, sha: string): CommitInfo | null {
    const obj = this.readObject(owner, repo, sha);
    if (obj === null || obj.type !== 'commit') return null;
    const text = obj.body.toString('utf8');
    const blank = text.indexOf('\n\n');
    const header = blank >= 0 ? text.slice(0, blank) : text;
    const message = blank >= 0 ? text.slice(blank + 2) : '';
    const parents: string[] = [];
    let tree = '';
    let authorEpoch = 0;
    let committerEpoch = 0;
    for (const line of header.split('\n')) {
      if (line.startsWith('tree ')) tree = line.slice(5).trim();
      else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
      else if (line.startsWith('author ')) {
        const m = / (\d+) [+-]\d{4}$/.exec(line);
        if (m !== null) authorEpoch = Number(m[1]);
      } else if (line.startsWith('committer ')) {
        const m = / (\d+) [+-]\d{4}$/.exec(line);
        if (m !== null) committerEpoch = Number(m[1]);
      }
    }
    return { tree, parents, message, authorEpoch, committerEpoch };
  }

  /** Commit shas reachable from a tip, newest first (pre-order over parents). */
  walkCommits(owner: string, repo: string, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (seen.has(sha) || !isSha(sha)) continue;
      seen.add(sha);
      const commit = this.readCommit(owner, repo, sha);
      if (commit === null) continue;
      out.push(sha);
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
    }
    return out;
  }

  isAncestor(owner: string, repo: string, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack: string[] = [descendant];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      if (sha === ancestor) return true;
      const commit = this.readCommit(owner, repo, sha);
      if (commit === null) continue;
      for (const parent of commit.parents) stack.push(parent);
    }
    return false;
  }

  mergeBase(owner: string, repo: string, a: string, b: string): string | null {
    if (a === b) return a;
    const ancestorsA = new Set(this.walkCommits(owner, repo, a));
    const queue: string[] = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const sha = queue.shift() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      if (ancestorsA.has(sha)) return sha;
      const commit = this.readCommit(owner, repo, sha);
      if (commit === null) continue;
      for (const parent of commit.parents) queue.push(parent);
    }
    return null;
  }

  // ------------------------------------------------------------ trees

  parseTree(body: Buffer): TreeEntry[] {
    const entries: TreeEntry[] = [];
    let offset = 0;
    while (offset < body.length) {
      const space = body.indexOf(0x20, offset);
      if (space < 0) break;
      const mode = body.subarray(offset, space).toString('ascii');
      const nul = body.indexOf(0, space + 1);
      if (nul < 0) break;
      const name = body.subarray(space + 1, nul).toString('utf8');
      const sha = body.subarray(nul + 1, nul + 21).toString('hex');
      entries.push({ mode, name, sha });
      offset = nul + 21;
    }
    return entries;
  }

  writeTree(owner: string, repo: string, entries: TreeEntry[]): string {
    const sorted = entries.slice().sort((x, y) => {
      const xn = x.mode === '40000' ? `${x.name}/` : x.name;
      const yn = y.mode === '40000' ? `${y.name}/` : y.name;
      return xn < yn ? -1 : xn > yn ? 1 : 0;
    });
    const parts: Buffer[] = [];
    for (const entry of sorted) {
      parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
      parts.push(Buffer.from(entry.sha, 'hex'));
    }
    return this.writeObject(owner, repo, 'tree', Buffer.concat(parts));
  }

  /** Flat path -> {mode, sha} for every blob under a tree (empty map for a null tree). */
  readTreeRecursive(owner: string, repo: string, treeSha: string | null): Map<string, { mode: string; sha: string }> {
    const out = new Map<string, { mode: string; sha: string }>();
    if (treeSha === null || treeSha === ZERO_SHA) return out;
    const walk = (sha: string, prefix: string): void => {
      const obj = this.readObject(owner, repo, sha);
      if (obj === null || obj.type !== 'tree') return;
      for (const entry of this.parseTree(obj.body)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.sha, path);
        else out.set(path, { mode: entry.mode, sha: entry.sha });
      }
    };
    walk(treeSha, '');
    return out;
  }

  writeTreeFromMap(owner: string, repo: string, files: Map<string, { mode: string; sha: string }>): string {
    const build = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, Map<string, { mode: string; sha: string }>>();
      for (const [path, value] of files) {
        if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
        const rest = prefix === '' ? path : path.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash < 0) entries.push({ mode: value.mode, name: rest, sha: value.sha });
        else {
          const dirName = rest.slice(0, slash);
          let sub = dirs.get(dirName);
          if (sub === undefined) {
            sub = new Map();
            dirs.set(dirName, sub);
          }
          sub.set(rest.slice(slash + 1), value);
        }
      }
      for (const [dirName, subFiles] of dirs) {
        // Rebuild full paths for the sub-tree by re-rooting through a temp map.
        const subMap = new Map<string, { mode: string; sha: string }>();
        for (const [p, v] of subFiles) subMap.set(p, v);
        const subTree = this.writeTreeFromMapInner(owner, repo, subMap);
        entries.push({ mode: '40000', name: dirName, sha: subTree });
      }
      return this.writeTree(owner, repo, entries);
    };
    return build('');
  }

  // Helper for nested trees: build a tree from paths relative to one directory.
  writeTreeFromMapInner(owner: string, repo: string, files: Map<string, { mode: string; sha: string }>): string {
    const entries: TreeEntry[] = [];
    const dirs = new Map<string, Map<string, { mode: string; sha: string }>>();
    for (const [path, value] of files) {
      const slash = path.indexOf('/');
      if (slash < 0) entries.push({ mode: value.mode, name: path, sha: value.sha });
      else {
        const dirName = path.slice(0, slash);
        let sub = dirs.get(dirName);
        if (sub === undefined) {
          sub = new Map();
          dirs.set(dirName, sub);
        }
        sub.set(path.slice(slash + 1), value);
      }
    }
    for (const [dirName, subFiles] of dirs) {
      entries.push({ mode: '40000', name: dirName, sha: this.writeTreeFromMapInner(owner, repo, subFiles) });
    }
    return this.writeTree(owner, repo, entries);
  }

  /** Look up one path in a tree without flattening the whole tree. */
  getTreeEntry(owner: string, repo: string, treeSha: string | null, path: string): { mode: string; sha: string } | null {
    if (treeSha === null || treeSha === ZERO_SHA) return null;
    const segments = path.split('/').filter((s) => s !== '');
    let current = treeSha;
    for (let i = 0; i < segments.length; i += 1) {
      const obj = this.readObject(owner, repo, current);
      if (obj === null || obj.type !== 'tree') return null;
      const entry = this.parseTree(obj.body).find((e) => e.name === segments[i]);
      if (entry === undefined) return null;
      if (i === segments.length - 1) return { mode: entry.mode, sha: entry.sha };
      if (entry.mode !== '40000') return null;
      current = entry.sha;
    }
    return null;
  }

  /**
   * Return a new tree with one path set (entry) or removed (entry null),
   * rebuilding only the directories on that path; untouched subtrees are
   * reused by sha, so a commit in a large tree stays O(depth), not O(files).
   */
  updateTreePath(
    owner: string,
    repo: string,
    treeSha: string | null,
    segments: string[],
    entry: { mode: string; sha: string } | null,
  ): string {
    let entries: TreeEntry[] = [];
    if (treeSha !== null && treeSha !== ZERO_SHA) {
      const obj = this.readObject(owner, repo, treeSha);
      if (obj !== null && obj.type === 'tree') entries = this.parseTree(obj.body);
    }
    const [head, ...rest] = segments as [string, ...string[]];
    const idx = entries.findIndex((e) => e.name === head);
    if (rest.length === 0) {
      if (entry === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else if (idx >= 0) {
        entries[idx] = { mode: entry.mode, name: head, sha: entry.sha };
      } else {
        entries.push({ mode: entry.mode, name: head, sha: entry.sha });
      }
    } else {
      const childSha = idx >= 0 && entries[idx]?.mode === '40000' ? (entries[idx] as TreeEntry).sha : null;
      const newChild = this.updateTreePath(owner, repo, childSha, rest, entry);
      if (idx >= 0) entries[idx] = { mode: '40000', name: head, sha: newChild };
      else entries.push({ mode: '40000', name: head, sha: newChild });
    }
    return this.writeTree(owner, repo, entries);
  }

  // ------------------------------------------------------------ diff / merge

  diffTrees(
    owner: string,
    repo: string,
    baseTreeSha: string | null,
    headTreeSha: string | null,
  ): FileChange[] {
    const base = this.readTreeRecursive(owner, repo, baseTreeSha);
    const head = this.readTreeRecursive(owner, repo, headTreeSha);
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    const out: FileChange[] = [];
    for (const path of paths) {
      const b = base.get(path);
      const h = head.get(path);
      if (b !== undefined && h === undefined) {
        const obj = this.readObject(owner, repo, b.sha);
        const deletions = obj !== null && !isBinary(obj.body) ? splitLines(obj.body.toString('utf8')).length : 0;
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (b === undefined && h !== undefined) {
        const obj = this.readObject(owner, repo, h.sha);
        const additions = obj !== null && !isBinary(obj.body) ? splitLines(obj.body.toString('utf8')).length : 0;
        out.push({ filename: path, status: 'added', additions: Math.max(additions, 0), deletions: 0, changes: additions });
      } else if (b !== undefined && h !== undefined && b.sha !== h.sha) {
        const oldObj = this.readObject(owner, repo, b.sha);
        const newObj = this.readObject(owner, repo, h.sha);
        let additions = 0;
        let deletions = 0;
        if (oldObj !== null && newObj !== null && !isBinary(oldObj.body) && !isBinary(newObj.body)) {
          [additions, deletions] = lineDiff(oldObj.body.toString('utf8'), newObj.body.toString('utf8'));
        }
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
    return out;
  }

  mergeTrees(
    owner: string,
    repo: string,
    baseTreeSha: string | null,
    oursTreeSha: string | null,
    theirsTreeSha: string | null,
  ): { treeSha: string; conflicts: string[] } {
    const base = this.readTreeRecursive(owner, repo, baseTreeSha);
    const ours = this.readTreeRecursive(owner, repo, oursTreeSha);
    const theirs = this.readTreeRecursive(owner, repo, theirsTreeSha);
    const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    const result = new Map<string, { mode: string; sha: string }>();
    const conflicts: string[] = [];
    for (const path of paths) {
      const b = base.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      const same = (x: { sha: string } | undefined, y: { sha: string } | undefined): boolean =>
        (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.sha === y.sha);
      if (same(o, t)) {
        if (o !== undefined) result.set(path, o);
      } else if (same(o, b)) {
        if (t !== undefined) result.set(path, t);
      } else if (same(t, b)) {
        if (o !== undefined) result.set(path, o);
      } else {
        conflicts.push(path);
        if (o !== undefined) result.set(path, o);
      }
    }
    conflicts.sort();
    const treeSha = this.writeTreeFromMap(owner, repo, result);
    return { treeSha, conflicts };
  }

  // ------------------------------------------------------------ reachability

  /** All object shas reachable from tips, minus those reachable from haves. */
  walkReachable(owner: string, repo: string, tips: string[], haves: string[]): Set<string> {
    const collect = (roots: string[]): Set<string> => {
      const found = new Set<string>();
      const commits: string[] = [];
      const stack: string[] = roots.slice();
      while (stack.length > 0) {
        const sha = stack.pop() as string;
        if (!isSha(sha) || found.has(sha)) continue;
        const obj = this.readObject(owner, repo, sha);
        if (obj === null) continue;
        found.add(sha);
        if (obj.type === 'commit') {
          commits.push(sha);
          const info = this.readCommit(owner, repo, sha);
          if (info !== null) {
            stack.push(info.tree);
            for (const parent of info.parents) stack.push(parent);
          }
        } else if (obj.type === 'tree') {
          for (const entry of this.parseTree(obj.body)) stack.push(entry.sha);
        }
      }
      return found;
    };
    const wanted = collect(tips);
    const have = collect(haves);
    for (const sha of have) wanted.delete(sha);
    return wanted;
  }

  // ------------------------------------------------------------ commits

  /** Write a commit object and move `branch` to it. Parent may be null (root). */
  createCommit(
    owner: string,
    repo: string,
    branch: string,
    treeSha: string,
    parentSha: string | null,
    message: string,
  ): string {
    const epoch = this.clock.tickEpochSec();
    const lines: string[] = [`tree ${treeSha}`];
    if (parentSha !== null) lines.push(`parent ${parentSha}`);
    lines.push(`author ${AUTHOR} ${epoch} +0000`);
    lines.push(`committer ${AUTHOR} ${epoch} +0000`);
    const body = Buffer.from(`${lines.join('\n')}\n\n${message.endsWith('\n') ? message : `${message}\n`}`, 'utf8');
    const sha = this.writeObject(owner, repo, 'commit', body);
    this.updateRef(owner, repo, `refs/heads/${branch}`, sha, { force: parentSha === null });
    return sha;
  }

  commitFile(
    owner: string,
    repo: string,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; blobSha: string } {
    this.ensureRepo(owner, repo);
    const blobSha = this.writeObject(owner, repo, 'blob', content);
    const parentSha = this.getBranchTip(owner, repo, branch);
    let parentTree: string | null = null;
    if (parentSha !== null) {
      const parent = this.readCommit(owner, repo, parentSha);
      if (parent !== null) parentTree = parent.tree;
    }
    const treeSha = this.updateTreePath(owner, repo, parentTree, path.split('/'), { mode: '100644', sha: blobSha });
    const commitSha = this.createCommit(owner, repo, branch, treeSha, parentSha, message);
    return { commitSha, blobSha };
  }

  deleteFile(
    owner: string,
    repo: string,
    branch: string,
    path: string,
    message: string,
  ): { commitSha: string } {
    this.ensureRepo(owner, repo);
    const parentSha = this.getBranchTip(owner, repo, branch);
    if (parentSha === null) throw new Error(`branch ${branch} does not exist`);
    const parent = this.readCommit(owner, repo, parentSha);
    if (parent === null) throw new Error(`branch ${branch} has no commit`);
    if (this.getTreeEntry(owner, repo, parent.tree, path) === null) {
      throw new Error(`path ${path} does not exist`);
    }
    const treeSha = this.updateTreePath(owner, repo, parent.tree, path.split('/'), null);
    const commitSha = this.createCommit(owner, repo, branch, treeSha, parentSha, message);
    return { commitSha };
  }

  // ------------------------------------------------------------ packs

  /**
   * Parse a pack v2/v3 buffer, resolve OFS_DELTA and REF_DELTA entries, and
   * write every object loose. Returns the shas written.
   */
  readPack(owner: string, repo: string, buf: Buffer): string[] {
    if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
      throw new Error('not a packfile');
    }
    const version = buf.readUInt32BE(4);
    if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
    const count = buf.readUInt32BE(8);
    interface RawEntry {
      type: number;
      body: Buffer;
      baseOffset: number | null;
      baseSha: string | null;
      startOffset: number;
    }
    const entries: RawEntry[] = [];
    const byOffset = new Map<number, RawEntry>();
    let offset = 12;
    for (let i = 0; i < count; i += 1) {
      const startOffset = offset;
      let byte = buf[offset] as number;
      offset += 1;
      const type = (byte >> 4) & 7;
      let size = byte & 0x0f;
      let shift = 4;
      while (byte & 0x80) {
        byte = buf[offset] as number;
        offset += 1;
        size |= (byte & 0x7f) << shift;
        shift += 7;
      }
      let baseOffset: number | null = null;
      let baseSha: string | null = null;
      if (type === 6) {
        byte = buf[offset] as number;
        offset += 1;
        let ofs = byte & 0x7f;
        while (byte & 0x80) {
          byte = buf[offset] as number;
          offset += 1;
          ofs = ((ofs + 1) << 7) | (byte & 0x7f);
        }
        baseOffset = startOffset - ofs;
      } else if (type === 7) {
        baseSha = buf.subarray(offset, offset + 20).toString('hex');
        offset += 20;
      }
      const inflated = inflateSync(buf.subarray(offset), { info: true }) as unknown as {
        buffer: Buffer;
        engine: { bytesWritten: number };
      };
      const consumed = inflated.engine.bytesWritten;
      offset += consumed;
      const entry: RawEntry = { type, body: Buffer.from(inflated.buffer), baseOffset, baseSha, startOffset };
      entries.push(entry);
      byOffset.set(startOffset, entry);
      void size;
    }
    // Resolve deltas. A delta's base may itself be a delta; resolve iteratively.
    const resolved = new Map<RawEntry, { type: ObjectType; body: Buffer }>();
    const resolve = (entry: RawEntry): { type: ObjectType; body: Buffer } => {
      const cached = resolved.get(entry);
      if (cached !== undefined) return cached;
      if (entry.type === 1 || entry.type === 2 || entry.type === 3 || entry.type === 4) {
        const type: ObjectType = entry.type === 1 ? 'commit' : entry.type === 2 ? 'tree' : entry.type === 3 ? 'blob' : 'tag';
        const out = { type, body: entry.body };
        resolved.set(entry, out);
        return out;
      }
      let base: { type: ObjectType; body: Buffer } | null = null;
      if (entry.type === 6 && entry.baseOffset !== null) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (baseEntry !== undefined) base = resolve(baseEntry);
      } else if (entry.type === 7 && entry.baseSha !== null) {
        const obj = this.readObject(owner, repo, entry.baseSha);
        if (obj !== null) base = obj;
      }
      if (base === null) throw new Error('delta base not found in pack');
      const out = { type: base.type, body: applyDelta(base.body, entry.body) };
      resolved.set(entry, out);
      return out;
    };
    const written: string[] = [];
    for (const entry of entries) {
      const obj = resolve(entry);
      written.push(this.writeObject(owner, repo, obj.type, obj.body));
    }
    return written;
  }
}

/** Apply a git binary delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos] as number;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readVarint();
  const dstSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta source size mismatch');
  const parts: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) {
        offset = delta[pos] as number;
        pos += 1;
      }
      if (op & 0x02) {
        offset |= (delta[pos] as number) << 8;
        pos += 1;
      }
      if (op & 0x04) {
        offset |= (delta[pos] as number) << 16;
        pos += 1;
      }
      if (op & 0x08) {
        offset |= (delta[pos] as number) << 24;
        pos += 1;
      }
      if (op & 0x10) {
        size = delta[pos] as number;
        pos += 1;
      }
      if (op & 0x20) {
        size |= (delta[pos] as number) << 8;
        pos += 1;
      }
      if (op & 0x40) {
        size |= (delta[pos] as number) << 16;
        pos += 1;
      }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      parts.push(delta.subarray(pos, pos + op));
      pos += op;
      total += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== dstSize || total !== dstSize) throw new Error('delta result size mismatch');
  return out;
}
