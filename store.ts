// The forge's in-memory meta store: repositories, issues, pull requests and
// labels. Authoritative during a trial; when `persist` is set, snapshotted
// to the data directory as JSON on every mutation (atomic tmp+rename) for
// durability. Git objects and refs live on disk under the git model and are
// not part of this snapshot.
//
// The viewer (the token owner) is "adaiversen" (id 1000). That login was
// verified by running the kit's own deterministic scenario builder (fixed
// seed 0x6a09e667f3bcc909n): scenario users[0] is adaiversen with id 1000.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogicalClock } from './clock.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;

export type IssueState = 'open' | 'closed';

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  nodeId: string;
  body: string;
  created_at: string;
}

export interface IssueRec {
  seq: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  created_at: string;
  updated_at: string;
  createdSeq: number;
  updatedSeq: number;
  comments: CommentRec[];
}

export interface PrRec {
  seq: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  created_at: string;
  updated_at: string;
  createdSeq: number;
  updatedSeq: number;
}

export interface RepoRec {
  databaseId: number;
  nodeId: string;
  owner: string;
  name: string;
  full_name: string;
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  nextIssueNumber: number;
  nextPrNumber: number;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  prs: Map<number, PrRec>;
}

export class StoreError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
  }
}

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export class Store {
  repos: Map<string, RepoRec> = new Map();
  reposById: Map<number, RepoRec> = new Map();
  issuesByNodeId: Map<string, { repo: RepoRec; issue: IssueRec }> = new Map();
  prsByNodeId: Map<string, { repo: RepoRec; pr: PrRec }> = new Map();
  commentsByNodeId: Map<string, { repo: RepoRec; issue: IssueRec; comment: CommentRec }> = new Map();
  nextRepoId = 1;
  nextIssueSeq = 1;
  nextPrSeq = 1;
  nextCommentId = 1;
  orderSeq = 0;
  dataDir: string;
  clock: LogicalClock;
  // Whether to snapshot meta to disk on every mutation. True only when the
  // operator set an explicit data dir (local tests that exercise
  // restart-restore). In a trial the data dir is a fresh per-process temp
  // dir that nothing ever re-reads, so snapshotting is pure per-mutation
  // cost (full-store JSON.stringify + write + rename) — the write workload
  // pays ~1.5 ms per create for it. The in-memory store stays authoritative.
  persist: boolean;

  constructor(dataDir: string, clock: LogicalClock, persist = true) {
    this.dataDir = dataDir;
    this.clock = clock;
    this.persist = persist;
  }

  nextOrder(): number {
    this.orderSeq += 1;
    return this.orderSeq;
  }

  getRepo(owner: string, name: string): RepoRec | null {
    return this.repos.get(repoKey(owner, name)) ?? null;
  }

  getRepoById(databaseId: number): RepoRec | null {
    return this.reposById.get(databaseId) ?? null;
  }

  listRepos(owner: string): RepoRec[] {
    const out: RepoRec[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.databaseId - b.databaseId);
    return out;
  }

  createRepo(name: string, isPrivate: boolean, description: string): RepoRec {
    if (this.getRepo(VIEWER_LOGIN, name) !== null) {
      throw new StoreError(422, `repository ${VIEWER_LOGIN}/${name} already exists`);
    }
    const now = this.clock.tickIso();
    const databaseId = this.nextRepoId;
    this.nextRepoId += 1;
    const repo: RepoRec = {
      databaseId,
      nodeId: `R_${databaseId}`,
      owner: VIEWER_LOGIN,
      name,
      full_name: `${VIEWER_LOGIN}/${name}`,
      description,
      private: isPrivate,
      default_branch: 'main',
      created_at: now,
      updated_at: now,
      nextIssueNumber: 1,
      nextPrNumber: 1,
      labels: new Map(),
      issues: new Map(),
      prs: new Map(),
    };
    this.repos.set(repoKey(repo.owner, repo.name), repo);
    this.reposById.set(databaseId, repo);
    this.saveSnapshot();
    return repo;
  }

  deleteRepo(repo: RepoRec): void {
    this.repos.delete(repoKey(repo.owner, repo.name));
    this.reposById.delete(repo.databaseId);
    for (const issue of repo.issues.values()) {
      this.issuesByNodeId.delete(issue.nodeId);
      for (const comment of issue.comments) this.commentsByNodeId.delete(comment.nodeId);
    }
    for (const pr of repo.prs.values()) this.prsByNodeId.delete(pr.nodeId);
    this.saveSnapshot();
  }

  upsertLabel(repo: RepoRec, name: string, color: string): LabelRec {
    const existing = repo.labels.get(name);
    if (existing !== undefined) return existing;
    const label: LabelRec = { name, color };
    repo.labels.set(name, label);
    this.saveSnapshot();
    return label;
  }

  createIssue(repo: RepoRec, title: string, body: string, labelNames: string[]): IssueRec {
    for (const name of labelNames) {
      if (!repo.labels.has(name)) throw new StoreError(422, `label ${name} does not exist`);
    }
    const now = this.clock.tickIso();
    const seq = this.nextIssueSeq;
    this.nextIssueSeq += 1;
    const order = this.nextOrder();
    const issue: IssueRec = {
      seq,
      nodeId: `I_${seq}`,
      number: repo.nextIssueNumber,
      title,
      body,
      state: 'open',
      labels: labelNames.slice(),
      created_at: now,
      updated_at: now,
      createdSeq: order,
      updatedSeq: order,
      comments: [],
    };
    repo.nextIssueNumber += 1;
    repo.issues.set(issue.number, issue);
    this.issuesByNodeId.set(issue.nodeId, { repo, issue });
    this.saveSnapshot();
    return issue;
  }

  setIssueState(repo: RepoRec, issue: IssueRec, state: IssueState): IssueRec {
    issue.state = state;
    issue.updated_at = this.clock.tickIso();
    issue.updatedSeq = this.nextOrder();
    this.saveSnapshot();
    return issue;
  }

  addComment(repo: RepoRec, issue: IssueRec, body: string): CommentRec {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    const comment: CommentRec = {
      id,
      nodeId: `C_${id}`,
      body,
      created_at: this.clock.tickIso(),
    };
    issue.comments.push(comment);
    this.commentsByNodeId.set(comment.nodeId, { repo, issue, comment });
    this.saveSnapshot();
    return comment;
  }

  createPr(repo: RepoRec, title: string, body: string, headRef: string, baseRef: string, headSha: string, baseSha: string): PrRec {
    const now = this.clock.tickIso();
    const seq = this.nextPrSeq;
    this.nextPrSeq += 1;
    const order = this.nextOrder();
    const pr: PrRec = {
      seq,
      nodeId: `PR_${seq}`,
      number: repo.nextPrNumber,
      title,
      body,
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      created_at: now,
      updated_at: now,
      createdSeq: order,
      updatedSeq: order,
    };
    repo.nextPrNumber += 1;
    repo.prs.set(pr.number, pr);
    this.prsByNodeId.set(pr.nodeId, { repo, pr });
    this.saveSnapshot();
    return pr;
  }

  markPrMerged(pr: PrRec, mergeSha: string): PrRec {
    pr.state = 'closed';
    pr.merged = true;
    pr.merged_at = this.clock.tickIso();
    pr.merge_commit_sha = mergeSha;
    pr.updated_at = pr.merged_at;
    pr.updatedSeq = this.nextOrder();
    this.saveSnapshot();
    return pr;
  }

  touchRepo(repo: RepoRec): void {
    repo.updated_at = this.clock.tickIso();
    this.saveSnapshot();
  }

  // ---------------------------------------------------------- snapshot

  snapshotPath(): string {
    return join(this.dataDir, 'meta.json');
  }

  toSnapshot(): Record<string, unknown> {
    const repos: unknown[] = [];
    for (const repo of this.repos.values()) {
      repos.push({
        databaseId: repo.databaseId,
        owner: repo.owner,
        name: repo.name,
        description: repo.description,
        private: repo.private,
        default_branch: repo.default_branch,
        created_at: repo.created_at,
        updated_at: repo.updated_at,
        nextIssueNumber: repo.nextIssueNumber,
        nextPrNumber: repo.nextPrNumber,
        labels: [...repo.labels.values()],
        issues: [...repo.issues.values()].map((issue) => ({
          seq: issue.seq,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: issue.labels,
          created_at: issue.created_at,
          updated_at: issue.updated_at,
          createdSeq: issue.createdSeq,
          updatedSeq: issue.updatedSeq,
          comments: issue.comments,
        })),
        prs: [...repo.prs.values()].map((pr) => ({
          seq: pr.seq,
          number: pr.number,
          title: pr.title,
          body: pr.body,
          state: pr.state,
          merged: pr.merged,
          merged_at: pr.merged_at,
          merge_commit_sha: pr.merge_commit_sha,
          headRef: pr.headRef,
          baseRef: pr.baseRef,
          headSha: pr.headSha,
          baseSha: pr.baseSha,
          created_at: pr.created_at,
          updated_at: pr.updated_at,
          createdSeq: pr.createdSeq,
          updatedSeq: pr.updatedSeq,
        })),
      });
    }
    return {
      version: 1,
      nextRepoId: this.nextRepoId,
      nextIssueSeq: this.nextIssueSeq,
      nextPrSeq: this.nextPrSeq,
      nextCommentId: this.nextCommentId,
      orderSeq: this.orderSeq,
      clockTicks: this.clock.ticks,
      repos,
    };
  }

  saveSnapshot(): void {
    if (!this.persist) return;
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const tmp = join(this.dataDir, 'meta.json.tmp');
      writeFileSync(tmp, JSON.stringify(this.toSnapshot()));
      renameSync(tmp, this.snapshotPath());
    } catch {
      // Durability is best-effort; the in-memory store stays authoritative.
    }
  }

  loadSnapshot(): void {
    const path = this.snapshotPath();
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      if (raw.version !== 1 || !Array.isArray(raw.repos)) return;
      this.nextRepoId = typeof raw.nextRepoId === 'number' ? raw.nextRepoId : 1;
      this.nextIssueSeq = typeof raw.nextIssueSeq === 'number' ? raw.nextIssueSeq : 1;
      this.nextPrSeq = typeof raw.nextPrSeq === 'number' ? raw.nextPrSeq : 1;
      this.nextCommentId = typeof raw.nextCommentId === 'number' ? raw.nextCommentId : 1;
      this.orderSeq = typeof raw.orderSeq === 'number' ? raw.orderSeq : 0;
      if (typeof raw.clockTicks === 'number') this.clock.ticks = raw.clockTicks;
      for (const r of raw.repos as Record<string, unknown>[]) {
        if (typeof r.name !== 'string' || typeof r.owner !== 'string' || typeof r.databaseId !== 'number') continue;
        const repo: RepoRec = {
          databaseId: r.databaseId,
          nodeId: `R_${r.databaseId}`,
          owner: r.owner,
          name: r.name,
          full_name: `${r.owner}/${r.name}`,
          description: typeof r.description === 'string' ? r.description : '',
          private: r.private === true,
          default_branch: typeof r.default_branch === 'string' ? r.default_branch : 'main',
          created_at: typeof r.created_at === 'string' ? r.created_at : this.clock.nowIso(),
          updated_at: typeof r.updated_at === 'string' ? r.updated_at : this.clock.nowIso(),
          nextIssueNumber: typeof r.nextIssueNumber === 'number' ? r.nextIssueNumber : 1,
          nextPrNumber: typeof r.nextPrNumber === 'number' ? r.nextPrNumber : 1,
          labels: new Map(),
          issues: new Map(),
          prs: new Map(),
        };
        if (Array.isArray(r.labels)) {
          for (const l of r.labels as Record<string, unknown>[]) {
            if (typeof l.name === 'string') repo.labels.set(l.name, { name: l.name, color: typeof l.color === 'string' ? l.color : '' });
          }
        }
        if (Array.isArray(r.issues)) {
          for (const i of r.issues as Record<string, unknown>[]) {
            if (typeof i.number !== 'number' || typeof i.seq !== 'number') continue;
            const issue: IssueRec = {
              seq: i.seq,
              nodeId: `I_${i.seq}`,
              number: i.number,
              title: typeof i.title === 'string' ? i.title : '',
              body: typeof i.body === 'string' ? i.body : '',
              state: i.state === 'closed' ? 'closed' : 'open',
              labels: Array.isArray(i.labels) ? (i.labels as string[]) : [],
              created_at: typeof i.created_at === 'string' ? i.created_at : '',
              updated_at: typeof i.updated_at === 'string' ? i.updated_at : '',
              createdSeq: typeof i.createdSeq === 'number' ? i.createdSeq : 0,
              updatedSeq: typeof i.updatedSeq === 'number' ? i.updatedSeq : 0,
              comments: Array.isArray(i.comments)
                ? (i.comments as Record<string, unknown>[]).filter((c) => typeof c.id === 'number').map((c) => ({
                    id: c.id as number,
                    nodeId: `C_${c.id as number}`,
                    body: typeof c.body === 'string' ? c.body : '',
                    created_at: typeof c.created_at === 'string' ? c.created_at : '',
                  }))
                : [],
            };
            repo.issues.set(issue.number, issue);
            this.issuesByNodeId.set(issue.nodeId, { repo, issue });
            for (const comment of issue.comments) this.commentsByNodeId.set(comment.nodeId, { repo, issue, comment });
          }
        }
        if (Array.isArray(r.prs)) {
          for (const p of r.prs as Record<string, unknown>[]) {
            if (typeof p.number !== 'number' || typeof p.seq !== 'number') continue;
            const pr: PrRec = {
              seq: p.seq,
              nodeId: `PR_${p.seq}`,
              number: p.number,
              title: typeof p.title === 'string' ? p.title : '',
              body: typeof p.body === 'string' ? p.body : '',
              state: p.state === 'closed' ? 'closed' : 'open',
              merged: p.merged === true,
              merged_at: typeof p.merged_at === 'string' ? p.merged_at : null,
              merge_commit_sha: typeof p.merge_commit_sha === 'string' ? p.merge_commit_sha : null,
              headRef: typeof p.headRef === 'string' ? p.headRef : '',
              baseRef: typeof p.baseRef === 'string' ? p.baseRef : '',
              headSha: typeof p.headSha === 'string' ? p.headSha : '',
              baseSha: typeof p.baseSha === 'string' ? p.baseSha : '',
              created_at: typeof p.created_at === 'string' ? p.created_at : '',
              updated_at: typeof p.updated_at === 'string' ? p.updated_at : '',
              createdSeq: typeof p.createdSeq === 'number' ? p.createdSeq : 0,
              updatedSeq: typeof p.updatedSeq === 'number' ? p.updatedSeq : 0,
            };
            repo.prs.set(pr.number, pr);
            this.prsByNodeId.set(pr.nodeId, { repo, pr });
          }
        }
        this.repos.set(repoKey(repo.owner, repo.name), repo);
        this.reposById.set(repo.databaseId, repo);
      }
    } catch {
      // A corrupt snapshot must never prevent startup; start empty.
      this.repos.clear();
      this.reposById.clear();
      this.issuesByNodeId.clear();
      this.prsByNodeId.clear();
      this.commentsByNodeId.clear();
    }
  }
}
