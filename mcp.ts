// MCP endpoint: POST /mcp, JSON-RPC 2.0 Streamable HTTP, answered as plain
// JSON. Speaks both eras: modern server/discover (2026-07-28) and the legacy
// initialize + notifications/initialized handshake. Six tools, all acting on
// the same store as REST, GraphQL and git.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { StoreError, VIEWER_LOGIN } from './store.ts';
import {
  createPr,
  issueView,
  mergePr,
  prView,
  repoView,
  type ForgeContext,
} from './service.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

// The one tool list, frozen so two tools/list answers are byte-identical.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        owner: { type: 'string', description: 'The repository owner (defaults to the viewer).' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...extra,
  });
  res.end(text);
}

function rpcError(res: ServerResponse, status: number, id: unknown, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function toolResult(result: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    isError,
  };
}

function toolError(message: string): Record<string, unknown> {
  return toolResult({ message }, true);
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function loadRepoForTool(ctx: ForgeContext, args: Record<string, unknown>): { owner: string; repo: string } | { error: string } {
  const owner = stringArg(args, 'owner');
  const repo = stringArg(args, 'repo');
  if (owner !== VIEWER_LOGIN) return { error: `repository ${owner}/${repo} not found` };
  const found = ctx.store.getRepo(owner, repo);
  if (found === null) return { error: `repository ${owner}/${repo} not found` };
  return { owner, repo };
}

function callTool(ctx: ForgeContext, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOL_BY_NAME.get(name) as ToolDef | undefined;
  if (tool === undefined) throw new Error(`unknown tool ${name}`);
  // Required-argument check; the caller turns this into JSON-RPC -32602.
  for (const required of tool.inputSchema.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') {
      throw new StoreError(-32602, `missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const owner = stringArg(args, 'owner');
      if (owner !== '' && owner !== VIEWER_LOGIN) return toolError(`repository owner must be ${VIEWER_LOGIN}`);
      const repoName = stringArg(args, 'name');
      const description = stringArg(args, 'description');
      const repo = ctx.store.createRepo(repoName, args.private === true, description);
      ctx.git.ensureRepo(repo.owner, repo.name);
      return toolResult(repoView(repo));
    }
    case 'get_repo': {
      const loaded = loadRepoForTool(ctx, args);
      if ('error' in loaded) return toolError(loaded.error);
      const repo = ctx.store.getRepo(loaded.owner, loaded.repo) as NonNullable<ReturnType<typeof ctx.store.getRepo>>;
      return toolResult(repoView(repo));
    }
    case 'create_issue': {
      const loaded = loadRepoForTool(ctx, args);
      if ('error' in loaded) return toolError(loaded.error);
      const repo = ctx.store.getRepo(loaded.owner, loaded.repo) as NonNullable<ReturnType<typeof ctx.store.getRepo>>;
      const issue = ctx.store.createIssue(repo, stringArg(args, 'title'), stringArg(args, 'body'), []);
      return toolResult(issueView(repo, issue));
    }
    case 'list_issues': {
      const loaded = loadRepoForTool(ctx, args);
      if ('error' in loaded) return toolError(loaded.error);
      const repo = ctx.store.getRepo(loaded.owner, loaded.repo) as NonNullable<ReturnType<typeof ctx.store.getRepo>>;
      const state = stringArg(args, 'state');
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      else if (state !== '' && state !== 'all') return toolError(`unknown state ${state}`);
      const views = issues.map((issue) => issueView(repo, issue));
      return toolResult(views);
    }
    case 'create_pull_request': {
      const loaded = loadRepoForTool(ctx, args);
      if ('error' in loaded) return toolError(loaded.error);
      const repo = ctx.store.getRepo(loaded.owner, loaded.repo) as NonNullable<ReturnType<typeof ctx.store.getRepo>>;
      const pr = createPr(ctx, repo, stringArg(args, 'title'), stringArg(args, 'body'), stringArg(args, 'head'), stringArg(args, 'base'));
      return toolResult(prView(ctx, repo, pr));
    }
    case 'merge_pull_request': {
      const loaded = loadRepoForTool(ctx, args);
      if ('error' in loaded) return toolError(loaded.error);
      const repo = ctx.store.getRepo(loaded.owner, loaded.repo) as NonNullable<ReturnType<typeof ctx.store.getRepo>>;
      const raw = args.pull_number;
      const number = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
      const pr = repo.prs.get(number);
      if (pr === undefined) return toolError(`pull request #${String(raw)} not found`);
      const merged = mergePr(ctx, repo, pr);
      return toolResult({ ...prView(ctx, repo, pr), merged: true, sha: merged.sha, message: merged.message });
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

export function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ForgeContext,
  rawBody: string,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    rpcError(res, 400, null, -32700, 'Parse error: request body is not valid JSON');
    return;
  }
  if (Array.isArray(parsed)) {
    // Batch of JSON-RPC requests: answer each in order.
    const out: unknown[] = [];
    for (const item of parsed) out.push(handleOne(ctx, item));
    sendJson(res, 200, out);
    return;
  }
  const answered = handleOne(ctx, parsed);
  if (answered === null) {
    // A notification: no reply.
    res.writeHead(202);
    res.end();
    return;
  }
  sendJson(res, 200, answered);
}

/** Handle one JSON-RPC request object. Null means "notification, no reply". */
function handleOne(ctx: ForgeContext, parsed: unknown): Record<string, unknown> | null {
  if (!isRecord(parsed)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const method = typeof parsed.method === 'string' ? parsed.method : '';
  const id = 'id' in parsed ? parsed.id : undefined;
  const isNotification = id === undefined;

  // Notifications never answer.
  if (isNotification) return null;

  const params = isRecord(parsed.params) ? parsed.params : {};

  if (method === 'server/discover') {
    return {
      jsonrpc: '2.0',
      id: id ?? null,
      result: {
        supportedVersions: SUPPORTED_VERSIONS,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
        instructions: 'A standalone GitHub-compatible git forge.',
        _meta: { serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } },
      },
    };
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const chosen = SUPPORTED_VERSIONS.includes(offered) ? offered : '2026-07-28';
    return {
      jsonrpc: '2.0',
      id: id ?? null,
      result: {
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id: id ?? null, result: {} };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id: id ?? null, result: { tools: TOOLS } };
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (!TOOL_BY_NAME.has(toolName)) {
      return { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `unknown tool ${toolName}` } };
    }
    try {
      const result = callTool(ctx, toolName, args);
      return { jsonrpc: '2.0', id: id ?? null, result };
    } catch (err) {
      if (err instanceof StoreError && err.status === -32602) {
        return { jsonrpc: '2.0', id: id ?? null, error: { code: -32602, message: err.message } };
      }
      if (err instanceof StoreError) {
        return { jsonrpc: '2.0', id: id ?? null, result: toolError(err.message) };
      }
      return { jsonrpc: '2.0', id: id ?? null, result: toolError(err instanceof Error ? err.message : 'tool failed') };
    }
  }

  return { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `method not found: ${method}` } };
}
