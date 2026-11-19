// REST v3 surface: /api/v3/* — repositories, branches, commits, contents,
// labels, issues, comments and pull requests. JSON only.

import { rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GitStore } from './gitmodel.ts';
import {
  commentView,
  createPr,
  deleteContent,
  getContent,
  issueView,
  listCommits,
  mergePr,
  prFiles,
  prView,
  putContent,
  repoView,
  type ForgeContext,
} from './service.ts';
import { StoreError, VIEWER_ID, VIEWER_LOGIN, type IssueRec, type PrRec, type RepoRec } from './store.ts';

export interface RestRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  origin: string;
  pathname: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const buf = status === 204 ? Buffer.alloc(0) : Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  const headers: Record<string, string> = { ...extra };
  if (status !== 204) {
    headers['content-type'] = 'application/json; charset=utf-8';
    headers['content-length'] = String(buf.length);
  }
  res.writeHead(status, headers);
  res.end(buf);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function parsePage(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(Math.floor(perPageRaw), 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  return { perPage, page };
}

function paginate<T>(res: ServerResponse, items: T[], query: URLSearchParams, origin: string, pathname: string): void {
  const { perPage, page } = parsePage(query);
  const total = items.length;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const extra: Record<string, string> = {};
  if (start + perPage < total) {
    const nextQuery = new URLSearchParams(query);
    nextQuery.set('per_page', String(perPage));
    nextQuery.set('page', String(page + 1));
    extra.link = `<${origin}${pathname}?${nextQuery.toString()}>; rel="next"`;
  }
  sendJson(res, 200, slice, extra);
}

function bodyOf(req: RestRequest): JsonRecord {
  return isRecord(req.body) ? req.body : {};
}

function stringField(body: JsonRecord, field: string): string {
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') out.push(entry);
    else if (isRecord(entry) && typeof entry.name === 'string') out.push(entry.name);
  }
  return out;
}

function userView(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: 'U_1000',
    type: 'User',
    name: 'Ada Iversen',
    email: 'adaiversen@example.invalid',
    html_url: `https://example.invalid/${VIEWER_LOGIN}`,
  };
}

/** Load a repo for a repo-scoped route; any non-viewer owner is a 404, never 403. */
function loadRepo(ctx: ForgeContext, owner: string, name: string): RepoRec | null {
  if (owner !== VIEWER_LOGIN) return null;
  return ctx.store.getRepo(owner, name);
}

export function handleRest(req: IncomingMessage, res: ServerResponse, ctx: ForgeContext, r: RestRequest): boolean {
  try {
    return dispatch(req, res, ctx, r);
  } catch (err) {
    if (err instanceof StoreError) {
      sendError(res, err.status, err.message);
      return true;
    }
    sendError(res, 500, err instanceof Error ? err.message : 'internal error');
    return true;
  }
}

function dispatch(_req: IncomingMessage, res: ServerResponse, ctx: ForgeContext, r: RestRequest): boolean {
  const seg = r.segments;
  const method = r.method;

  // GET /api/v3/ and /api/v3 (root)
  if (seg.length === 0) {
    if (method !== 'GET') return false;
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, {
      'x-oauth-scopes': 'repo, read:org',
    });
    return true;
  }

  if (seg[0] === 'meta' && seg.length === 1) {
    if (method !== 'GET') return false;
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  if (seg[0] === 'user' && seg.length === 1) {
    if (method !== 'GET') return false;
    sendJson(res, 200, userView());
    return true;
  }

  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'GET') {
      paginate(res, ctx.store.listRepos(VIEWER_LOGIN).map(repoView), r.query, r.origin, r.pathname);
      return true;
    }
    if (method === 'POST') {
      const body = bodyOf(r);
      const name = stringField(body, 'name');
      if (name === '' || name.includes('/')) {
        sendError(res, 422, 'name is required');
        return true;
      }
      const isPrivate = body.private === true;
      const description = stringField(body, 'description');
      const repo = ctx.store.createRepo(name, isPrivate, description);
      ctx.git.ensureRepo(repo.owner, repo.name);
      sendJson(res, 201, repoView(repo));
      return true;
    }
    return false;
  }

  if (seg[0] === 'repos' && seg.length >= 3) {
    return dispatchRepo(res, ctx, r, seg[1] as string, seg[2] as string, seg.slice(3));
  }

  return false;
}

function dispatchRepo(
  res: ServerResponse,
  ctx: ForgeContext,
  r: RestRequest,
  owner: string,
  name: string,
  rest: string[],
): boolean {
  const method = r.method;
  const repo = loadRepo(ctx, owner, name);

  // Repo object itself.
  if (rest.length === 0) {
    if (method === 'GET') {
      if (repo === null) {
        sendError(res, 404, `repository ${owner}/${name} not found`);
        return true;
      }
      sendJson(res, 200, repoView(repo));
      return true;
    }
    if (method === 'PATCH') {
      if (repo === null) {
        sendError(res, 404, `repository ${owner}/${name} not found`);
        return true;
      }
      const body = bodyOf(r);
      if (typeof body.description === 'string') repo.description = body.description;
      ctx.store.touchRepo(repo);
      sendJson(res, 200, repoView(repo));
      return true;
    }
    if (method === 'DELETE') {
      if (repo === null) {
        sendError(res, 404, `repository ${owner}/${name} not found`);
        return true;
      }
      ctx.store.deleteRepo(repo);
      ctx.git.dropRepo(owner, name);
      if (ctx.git.persist) {
        try {
          rmSync(ctx.git.gitDir(owner, name), { recursive: true, force: true });
        } catch {
          // Best effort.
        }
      }
      sendJson(res, 204, null);
      return true;
    }
    return false;
  }

  if (repo === null) {
    sendError(res, 404, `repository ${owner}/${name} not found`);
    return true;
  }

  const git: GitStore = ctx.git;

  // POST /git/refs — create a branch. GET /git/refs — list refs.
  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2) {
    if (method === 'GET') {
      sendJson(res, 200, git.listRefs(owner, name).map((entry) => ({ ref: entry.ref, object: { sha: entry.sha } })));
      return true;
    }
    if (method !== 'POST') return false;
    const body = bodyOf(r);
    const ref = stringField(body, 'ref');
    const sha = stringField(body, 'sha');
    if (!ref.startsWith('refs/heads/') || !/^[0-9a-f]{40}$/.test(sha)) {
      sendError(res, 422, 'ref must be refs/heads/<branch> and sha a 40-hex commit');
      return true;
    }
    if (git.getRef(owner, name, ref) !== null) {
      sendError(res, 422, `ref ${ref} already exists`);
      return true;
    }
    if (git.readCommit(owner, name, sha) === null) {
      sendError(res, 422, `sha ${sha} is not a commit in this repository`);
      return true;
    }
    git.updateRef(owner, name, ref, sha, { force: true });
    sendJson(res, 201, { ref, object: { sha } });
    return true;
  }

  // GET /git/refs/heads/<branch>
  if (rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads' && rest.length >= 4) {
    if (method !== 'GET') return false;
    const branch = rest.slice(3).join('/');
    const sha = git.getBranchTip(owner, name, branch);
    if (sha === null) {
      sendError(res, 404, `ref refs/heads/${branch} not found`);
      return true;
    }
    sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha } });
    return true;
  }

  // GET /branches and GET /branches/<branch>
  if (rest[0] === 'branches') {
    if (method !== 'GET') return false;
    const branches = git.listBranches(owner, name).map((b) => ({ name: b.name, commit: { sha: b.sha }, protected: false }));
    if (rest.length === 1) {
      sendJson(res, 200, branches);
      return true;
    }
    const branch = rest.slice(1).join('/');
    const found = branches.find((b) => b.name === branch);
    if (found === undefined) {
      sendError(res, 404, `branch ${branch} not found`);
      return true;
    }
    sendJson(res, 200, found);
    return true;
  }

  // GET /commits[?sha=<ref>]
  if (rest[0] === 'commits' && rest.length === 1) {
    if (method !== 'GET') return false;
    const sha = r.query.get('sha') ?? undefined;
    sendJson(res, 200, listCommits(ctx, repo, sha));
    return true;
  }

  // Contents: /contents[/<path...>]
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      const ref = r.query.get('ref') ?? undefined;
      const got = getContent(ctx, repo, path, ref);
      if (got === null) {
        sendError(res, 404, `path ${path === '' ? '(root)' : path} not found`);
        return true;
      }
      if (got.kind === 'file') {
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          content: got.content.toString('base64'),
          sha: got.sha,
          size: got.size,
          name: path.split('/').pop() ?? path,
          path,
        });
        return true;
      }
      sendJson(res, 200, got.entries);
      return true;
    }
    if (method === 'PUT') {
      if (path === '') {
        sendError(res, 422, 'a file path is required');
        return true;
      }
      const body = bodyOf(r);
      const message = stringField(body, 'message');
      const contentB64 = body.content;
      if (typeof contentB64 !== 'string') {
        sendError(res, 422, 'content (base64) is required');
        return true;
      }
      const content = Buffer.from(contentB64, 'base64');
      const branch = typeof body.branch === 'string' ? body.branch : undefined;
      const sha = typeof body.sha === 'string' ? body.sha : undefined;
      const result = putContent(ctx, repo, path, content, message, branch, sha);
      sendJson(res, result.status, {
        content: { name: path.split('/').pop() ?? path, path, sha: result.contentSha, size: content.length, encoding: 'base64' },
        commit: { sha: result.commitSha, message },
      });
      return true;
    }
    if (method === 'DELETE') {
      if (path === '') {
        sendError(res, 422, 'a file path is required');
        return true;
      }
      const body = bodyOf(r);
      const message = stringField(body, 'message');
      const branch = typeof body.branch === 'string' ? body.branch : undefined;
      const sha = typeof body.sha === 'string' ? body.sha : undefined;
      const result = deleteContent(ctx, repo, path, message, branch, sha);
      sendJson(res, 200, { commit: { sha: result.commitSha, message } });
      return true;
    }
    return false;
  }

  // POST /labels
  if (rest[0] === 'labels' && rest.length === 1) {
    if (method !== 'POST') return false;
    const body = bodyOf(r);
    const labelName = stringField(body, 'name');
    if (labelName === '') {
      sendError(res, 422, 'name is required');
      return true;
    }
    const color = stringField(body, 'color');
    const label = ctx.store.upsertLabel(repo, labelName, color);
    sendJson(res, 201, { name: label.name, color: label.color });
    return true;
  }

  // Issues.
  if (rest[0] === 'issues') {
    return dispatchIssues(res, ctx, r, repo, rest.slice(1));
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    return dispatchPulls(res, ctx, r, repo, rest.slice(1));
  }

  return false;
}

function dispatchIssues(
  res: ServerResponse,
  ctx: ForgeContext,
  r: RestRequest,
  repo: RepoRec,
  rest: string[],
): boolean {
  const method = r.method;

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = r.query.get('state') ?? 'open';
      const sort = r.query.get('sort') ?? '';
      const direction = r.query.get('direction') ?? '';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      else if (state !== 'all') {
        sendError(res, 422, `unknown state ${state}`);
        return true;
      }
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      } else if (direction === 'desc') {
        issues.sort((a, b) => b.createdSeq - a.createdSeq);
      }
      paginate(res, issues.map((issue) => issueView(repo, issue)), r.query, r.origin, r.pathname);
      return true;
    }
    if (method === 'POST') {
      const body = bodyOf(r);
      const title = stringField(body, 'title');
      if (title === '') {
        sendError(res, 422, 'title is required');
        return true;
      }
      const issueBody = stringField(body, 'body');
      const issue = ctx.store.createIssue(repo, title, issueBody, labelNames(body.labels));
      sendJson(res, 201, issueView(repo, issue));
      return true;
    }
    return false;
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return false;
  const issue: IssueRec | undefined = repo.issues.get(number);
  if (issue === undefined) {
    sendError(res, 404, `issue #${number} not found`);
    return true;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, issueView(repo, issue));
      return true;
    }
    if (method === 'PATCH') {
      const body = bodyOf(r);
      if (body.state === 'open' || body.state === 'closed') {
        ctx.store.setIssueState(repo, issue, body.state);
      }
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      sendJson(res, 200, issueView(repo, issue));
      return true;
    }
    return false;
  }

  if (rest[1] === 'comments' && rest.length === 2) {
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map(commentView));
      return true;
    }
    if (method === 'POST') {
      const body = bodyOf(r);
      const commentBody = stringField(body, 'body');
      if (commentBody === '') {
        sendError(res, 422, 'body is required');
        return true;
      }
      const comment = ctx.store.addComment(repo, issue, commentBody);
      sendJson(res, 201, commentView(comment));
      return true;
    }
    return false;
  }

  return false;
}

function dispatchPulls(
  res: ServerResponse,
  ctx: ForgeContext,
  r: RestRequest,
  repo: RepoRec,
  rest: string[],
): boolean {
  const method = r.method;

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = r.query.get('state') ?? 'open';
      let prs = [...repo.prs.values()];
      if (state === 'open') prs = prs.filter((p) => p.state === 'open');
      else if (state === 'closed') prs = prs.filter((p) => p.state === 'closed');
      else if (state !== 'all') {
        sendError(res, 422, `unknown state ${state}`);
        return true;
      }
      prs.sort((a, b) => a.createdSeq - b.createdSeq);
      paginate(res, prs.map((pr) => prView(ctx, repo, pr)), r.query, r.origin, r.pathname);
      return true;
    }
    if (method === 'POST') {
      const body = bodyOf(r);
      const title = stringField(body, 'title');
      const head = stringField(body, 'head');
      const base = stringField(body, 'base');
      if (title === '' || head === '' || base === '') {
        sendError(res, 422, 'title, head and base are required');
        return true;
      }
      const prBody = stringField(body, 'body');
      const pr = createPr(ctx, repo, title, prBody, head, base);
      sendJson(res, 201, prView(ctx, repo, pr));
      return true;
    }
    return false;
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return false;
  const pr: PrRec | undefined = repo.prs.get(number);
  if (pr === undefined) {
    sendError(res, 404, `pull request #${number} not found`);
    return true;
  }

  if (rest.length === 1) {
    if (method !== 'GET') return false;
    sendJson(res, 200, prView(ctx, repo, pr));
    return true;
  }

  if (rest[1] === 'files' && rest.length === 2) {
    if (method !== 'GET') return false;
    sendJson(res, 200, prFiles(ctx, repo, pr));
    return true;
  }

  if (rest[1] === 'merge' && rest.length === 2) {
    if (method !== 'PUT') return false;
    const merged = mergePr(ctx, repo, pr);
    sendJson(res, 200, { merged: true, sha: merged.sha, message: merged.message });
    return true;
  }

  return false;
}
