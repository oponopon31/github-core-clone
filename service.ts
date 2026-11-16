// Shared domain logic used by REST, GraphQL and MCP so all three surfaces
// read and write the same store and the same git objects, with identical
// ids, numbers and merge semantics.

import { formatIso, type LogicalClock } from './clock.ts';
import type { FileChange, GitStore } from './gitmodel.ts';
import { Store, StoreError, VIEWER_ID, VIEWER_LOGIN, type IssueRec, type PrRec, type RepoRec } from './store.ts';

export interface ForgeContext {
  store: Store;
  git: GitStore;
  clock: LogicalClock;
  token: string;
  dataDir: string;
}

export function repoView(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.databaseId,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: repo.full_name,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    html_url: `https://example.invalid/${repo.full_name}`,
    url: `/api/v3/repos/${repo.full_name}`,
    clone_url: `https://example.invalid/${repo.full_name}.git`,
    fork: false,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
  };
}

export function issueView(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.seq,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label !== undefined ? label.color : '' };
    }),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length,
    url: `/api/v3/repos/${repo.full_name}/issues/${issue.number}`,
  };
}

export function commentView(comment: { id: number; nodeId: string; body: string; created_at: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.nodeId,
    body: comment.body,
    created_at: comment.created_at,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
  };
}

export function prHeadSha(ctx: ForgeContext, repo: RepoRec, pr: PrRec): string {
  return ctx.git.getBranchTip(repo.owner, repo.name, pr.headRef) ?? pr.headSha;
}

export function prBaseSha(ctx: ForgeContext, repo: RepoRec, pr: PrRec): string {
  return ctx.git.getBranchTip(repo.owner, repo.name, pr.baseRef) ?? pr.baseSha;
}

export function prView(ctx: ForgeContext, repo: RepoRec, pr: PrRec): Record<string, unknown> {
  return {
    id: pr.seq,
    node_id: pr.nodeId,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
    head: { ref: pr.headRef, sha: prHeadSha(ctx, repo, pr), label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: prBaseSha(ctx, repo, pr), label: `${repo.owner}:${pr.baseRef}` },
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    url: `/api/v3/repos/${repo.full_name}/pulls/${pr.number}`,
  };
}

/** Resolve a ref name or a commit sha to a commit sha, or null. */
export function resolveRefToCommit(ctx: ForgeContext, repo: RepoRec, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return ctx.git.getBranchTip(repo.owner, repo.name, repo.default_branch);
  if (/^[0-9a-f]{40}$/.test(ref)) {
    return ctx.git.readCommit(repo.owner, repo.name, ref) !== null ? ref : null;
  }
  const tip = ctx.git.getBranchTip(repo.owner, repo.name, ref);
  if (tip !== null) return tip;
  // A full ref such as refs/heads/main.
  if (ref.startsWith('refs/heads/')) return ctx.git.getBranchTip(repo.owner, repo.name, ref.slice('refs/heads/'.length));
  return null;
}

export function listCommits(ctx: ForgeContext, repo: RepoRec, ref: string | undefined): Record<string, unknown>[] {
  const tip = resolveRefToCommit(ctx, repo, ref);
  if (tip === null) return [];
  const out: Record<string, unknown>[] = [];
  for (const sha of ctx.git.walkCommits(repo.owner, repo.name, tip)) {
    const info = ctx.git.readCommit(repo.owner, repo.name, sha);
    if (info === null) continue;
    const message = info.message.replace(/\n+$/, '');
    out.push({
      sha,
      commit: {
        message,
        author: { name: 'adaiversen', email: 'adaiversen@example.invalid', date: formatIso(info.authorEpoch * 1000) },
        committer: { name: 'adaiversen', email: 'adaiversen@example.invalid', date: formatIso(info.committerEpoch * 1000) },
      },
      author: { login: VIEWER_LOGIN, id: VIEWER_ID },
      parents: info.parents.map((p) => ({ sha: p })),
    });
  }
  return out;
}

// ------------------------------------------------------------ contents

export interface ContentPutResult {
  status: number;
  contentSha: string;
  commitSha: string;
}

export function putContent(
  ctx: ForgeContext,
  repo: RepoRec,
  path: string,
  content: Buffer,
  message: string,
  branch: string | undefined,
  sha: string | undefined,
): ContentPutResult {
  const targetBranch = branch ?? repo.default_branch;
  ctx.git.ensureRepo(repo.owner, repo.name);
  const tip = ctx.git.getBranchTip(repo.owner, repo.name, targetBranch);
  let existingSha: string | null = null;
  if (tip !== null) {
    const commit = ctx.git.readCommit(repo.owner, repo.name, tip);
    if (commit !== null) {
      const files = ctx.git.readTreeRecursive(repo.owner, repo.name, commit.tree);
      existingSha = files.get(path)?.sha ?? null;
    }
  }
  if (sha !== undefined) {
    if (existingSha === null || existingSha !== sha) throw new StoreError(409, 'the sha does not match the current blob');
  }
  const result = ctx.git.commitFile(repo.owner, repo.name, targetBranch, path, content, message);
  ctx.store.touchRepo(repo);
  return { status: existingSha === null ? 201 : 200, contentSha: result.blobSha, commitSha: result.commitSha };
}

export type ContentGet =
  | { kind: 'file'; sha: string; size: number; content: Buffer }
  | { kind: 'dir'; entries: { type: 'file' | 'dir'; name: string; path: string; sha: string }[] };

export function getContent(ctx: ForgeContext, repo: RepoRec, path: string, ref: string | undefined): ContentGet | null {
  const tip = resolveRefToCommit(ctx, repo, ref);
  if (tip === null) return null;
  const commit = ctx.git.readCommit(repo.owner, repo.name, tip);
  if (commit === null) return null;
  const files = ctx.git.readTreeRecursive(repo.owner, repo.name, commit.tree);
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (clean === '') {
    // Root listing.
    return { kind: 'dir', entries: listDirEntries(ctx, repo, commit.tree, '') };
  }
  const file = files.get(clean);
  if (file !== undefined) {
    const obj = ctx.git.readObject(repo.owner, repo.name, file.sha);
    if (obj === null) return null;
    return { kind: 'file', sha: file.sha, size: obj.body.length, content: obj.body };
  }
  // Directory? Any file below this prefix means the directory exists.
  const prefix = `${clean}/`;
  let isDir = false;
  for (const key of files.keys()) {
    if (key.startsWith(prefix)) {
      isDir = true;
      break;
    }
  }
  if (!isDir) return null;
  return { kind: 'dir', entries: listDirEntries(ctx, repo, commit.tree, clean) };
}

function listDirEntries(
  ctx: ForgeContext,
  repo: RepoRec,
  treeSha: string,
  dirPath: string,
): { type: 'file' | 'dir'; name: string; path: string; sha: string }[] {
  let current = treeSha;
  if (dirPath !== '') {
    for (const segment of dirPath.split('/')) {
      const obj = ctx.git.readObject(repo.owner, repo.name, current);
      if (obj === null || obj.type !== 'tree') return [];
      const entry = ctx.git.parseTree(obj.body).find((e) => e.name === segment && e.mode === '40000');
      if (entry === undefined) return [];
      current = entry.sha;
    }
  }
  const obj = ctx.git.readObject(repo.owner, repo.name, current);
  if (obj === null || obj.type !== 'tree') return [];
  const out: { type: 'file' | 'dir'; name: string; path: string; sha: string }[] = [];
  for (const entry of ctx.git.parseTree(obj.body)) {
    const childPath = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
    out.push({ type: entry.mode === '40000' ? 'dir' : 'file', name: entry.name, path: childPath, sha: entry.sha });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

export function deleteContent(
  ctx: ForgeContext,
  repo: RepoRec,
  path: string,
  message: string,
  branch: string | undefined,
  sha: string | undefined,
): { commitSha: string } {
  const targetBranch = branch ?? repo.default_branch;
  const tip = ctx.git.getBranchTip(repo.owner, repo.name, targetBranch);
  if (tip === null) throw new StoreError(404, `path ${path} does not exist`);
  const commit = ctx.git.readCommit(repo.owner, repo.name, tip);
  if (commit === null) throw new StoreError(404, `path ${path} does not exist`);
  const files = ctx.git.readTreeRecursive(repo.owner, repo.name, commit.tree);
  const existing = files.get(path);
  if (existing === undefined) throw new StoreError(404, `path ${path} does not exist`);
  if (sha !== undefined && sha !== existing.sha) throw new StoreError(409, 'the sha does not match the current blob');
  const result = ctx.git.deleteFile(repo.owner, repo.name, targetBranch, path, message);
  ctx.store.touchRepo(repo);
  return { commitSha: result.commitSha };
}

// ------------------------------------------------------------ pull requests

export function createPr(
  ctx: ForgeContext,
  repo: RepoRec,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
): PrRec {
  const headSha = ctx.git.getBranchTip(repo.owner, repo.name, headRef);
  const baseSha = ctx.git.getBranchTip(repo.owner, repo.name, baseRef);
  if (headSha === null) throw new StoreError(422, `head branch ${headRef} does not exist`);
  if (baseSha === null) throw new StoreError(422, `base branch ${baseRef} does not exist`);
  return ctx.store.createPr(repo, title, body, headRef, baseRef, headSha, baseSha);
}

export function prFiles(ctx: ForgeContext, repo: RepoRec, pr: PrRec): FileChange[] {
  const headSha = prHeadSha(ctx, repo, pr);
  const baseSha = prBaseSha(ctx, repo, pr);
  const base = ctx.git.mergeBase(repo.owner, repo.name, headSha, baseSha);
  let baseTree: string | null = null;
  if (base !== null) {
    const info = ctx.git.readCommit(repo.owner, repo.name, base);
    if (info !== null) baseTree = info.tree;
  }
  const headInfo = ctx.git.readCommit(repo.owner, repo.name, headSha);
  const headTree = headInfo !== null ? headInfo.tree : null;
  return ctx.git.diffTrees(repo.owner, repo.name, baseTree, headTree);
}

/** MERGEABLE / CONFLICTING / UNKNOWN for an open pull request (3-way rule). */
export function prMergeable(ctx: ForgeContext, repo: RepoRec, pr: PrRec): string {
  if (pr.state !== 'open') return 'UNKNOWN';
  const headSha = prHeadSha(ctx, repo, pr);
  const baseSha = prBaseSha(ctx, repo, pr);
  const base = ctx.git.mergeBase(repo.owner, repo.name, headSha, baseSha);
  if (base === null) return 'UNKNOWN';
  const baseInfo = ctx.git.readCommit(repo.owner, repo.name, base);
  const headInfo = ctx.git.readCommit(repo.owner, repo.name, headSha);
  const baseTipInfo = ctx.git.readCommit(repo.owner, repo.name, baseSha);
  if (baseInfo === null || headInfo === null || baseTipInfo === null) return 'UNKNOWN';
  const { conflicts } = ctx.git.mergeTrees(repo.owner, repo.name, baseInfo.tree, baseTipInfo.tree, headInfo.tree);
  return conflicts.length > 0 ? 'CONFLICTING' : 'MERGEABLE';
}

export function mergePr(ctx: ForgeContext, repo: RepoRec, pr: PrRec): { sha: string; message: string } {
  if (pr.state !== 'open') throw new StoreError(405, `pull request #${pr.number} is already ${pr.state}`);
  const headSha = prHeadSha(ctx, repo, pr);
  const baseSha = prBaseSha(ctx, repo, pr);
  const base = ctx.git.mergeBase(repo.owner, repo.name, headSha, baseSha);
  if (base === null) throw new StoreError(405, 'no merge base between head and base');
  const baseInfo = ctx.git.readCommit(repo.owner, repo.name, base);
  const headInfo = ctx.git.readCommit(repo.owner, repo.name, headSha);
  const baseTipInfo = ctx.git.readCommit(repo.owner, repo.name, baseSha);
  if (baseInfo === null || headInfo === null || baseTipInfo === null) {
    throw new StoreError(405, 'cannot merge: missing commit');
  }
  const { treeSha, conflicts } = ctx.git.mergeTrees(
    repo.owner,
    repo.name,
    baseInfo.tree,
    baseTipInfo.tree,
    headInfo.tree,
  );
  if (conflicts.length > 0) {
    throw new StoreError(405, `merge conflict in ${conflicts.join(', ')}`);
  }
  const message = `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}\n\n${pr.title}`;
  const sha = ctx.git.createCommit(repo.owner, repo.name, pr.baseRef, treeSha, baseSha, message);
  ctx.store.markPrMerged(pr, sha);
  ctx.store.touchRepo(repo);
  return { sha, message: message.replace(/\n+$/, '') };
}

// ------------------------------------------------------------ global-id lookup

export function resolveRepoByNodeId(ctx: ForgeContext, id: string): RepoRec | null {
  const m = /^R_(\d+)$/.exec(id);
  if (m !== null) return ctx.store.getRepoById(Number(m[1]));
  if (/^\d+$/.test(id)) return ctx.store.getRepoById(Number(id));
  return null;
}

export function resolveIssueByNodeId(
  ctx: ForgeContext,
  id: string,
): { repo: RepoRec; issue: IssueRec } | null {
  return ctx.store.issuesByNodeId.get(id) ?? null;
}

export function resolvePrByNodeId(ctx: ForgeContext, id: string): { repo: RepoRec; pr: PrRec } | null {
  return ctx.store.prsByNodeId.get(id) ?? null;
}
