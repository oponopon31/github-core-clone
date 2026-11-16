// The forge's HTTP server. One process, Node stdlib only: git smart HTTP,
// REST v3, GraphQL v4 and MCP over one store and one git object layer.
//
// Protocol discipline (every reply): application/json, a non-empty
// X-GitHub-Request-Id, and {"message": ...} error bodies. Every route except
// GET /healthz requires `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>` exactly.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogicalClock } from './clock.ts';
import { GitStore } from './gitmodel.ts';
import { handleGraphql } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitwire.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestRequest } from './rest.ts';
import type { ForgeContext } from './service.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function createApp(): Server {
  // A fresh store per process: each trial pass (live, replay) runs its own
  // process, and a replay must start from an empty store — sharing a data dir
  // across passes would resurrect the live pass's repos. An explicit
  // FORGE_DATA_DIR still wins (local tests that rely on restart-restore).
  const dataDir = process.env.FORGE_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'forge-data-'));
  const clock = new LogicalClock(process.env.MAKEFUN_TRIAL_NOW);
  const store = new Store(dataDir, clock);
  store.loadSnapshot();
  const git = new GitStore(dataDir, clock);
  const ctx: ForgeContext = {
    store,
    git,
    clock,
    token: process.env.MAKEFUN_SHOP_TOKEN ?? '',
    dataDir,
  };
  let requestCounter = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res, ctx, () => {
      requestCounter += 1;
      return `req-${requestCounter}`;
    });
  });
  return server;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ForgeContext,
  nextRequestId: () => string,
): Promise<void> {
  res.setHeader('x-github-request-id', nextRequestId());
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://forge');
  } catch {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Auth: every other route needs the exact bearer token.
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${ctx.token}` || ctx.token === '') {
    // Drain the body so the socket stays usable, then answer 401.
    try {
      await readBody(req);
    } catch {
      // Ignore body-read failures on an unauthorized request.
    }
    sendJson(res, 401, { message: 'unauthorized: a valid bearer token is required' });
    return;
  }

  const body = await readBody(req);
  const rawText = body.toString('utf8');

  if (pathname === '/api/graphql' && method === 'POST') {
    handleGraphql(req, res, ctx, rawText);
    return;
  }

  if (pathname === '/mcp' && method === 'POST') {
    handleMcp(req, res, ctx, rawText);
    return;
  }

  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const restPath = pathname === '/api/v3' ? '' : pathname.slice('/api/v3/'.length);
    const rawSegments = restPath === '' ? [] : restPath.split('/');
    const segments: string[] = [];
    for (const segment of rawSegments) {
      if (segment === '') continue;
      const decoded = decodeSegment(segment);
      if (decoded === null) {
        sendJson(res, 400, { message: 'malformed percent-encoding in path' });
        return;
      }
      segments.push(decoded);
    }
    let parsedBody: unknown = undefined;
    if ((method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') && rawText.trim() !== '') {
      try {
        parsedBody = JSON.parse(rawText);
      } catch {
        sendJson(res, 400, { message: 'request body is not valid JSON' });
        return;
      }
    }
    const origin = `http://${req.headers.host ?? 'localhost'}`;
    const restReq: RestRequest = {
      method,
      segments,
      query: url.searchParams,
      body: parsedBody,
      origin,
      pathname,
    };
    const handled = handleRest(req, res, ctx, restReq);
    if (!handled) sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // Git smart HTTP: /<owner>/<repo>[.git]/info/refs, git-upload-pack, git-receive-pack.
  const gitMatch = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (gitMatch !== null) {
    const service = url.searchParams.get('service') ?? '';
    if (gitMatch[3] === 'info/refs') {
      if (service !== '' && service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 400, { message: `unknown service ${service}` });
        return;
      }
      handleInfoRefs(req, res, ctx);
      return;
    }
    if (gitMatch[3] === 'git-upload-pack') {
      handleUploadPack(req, res, ctx, body);
      return;
    }
    handleReceivePack(req, res, ctx, body);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
