// The forge's HTTP server: auth, JSON discipline, request ids, and routing to the REST, git,
// GraphQL and MCP surfaces. main.ts owns the lifecycle; this file is the whole product surface.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest, notFound, type RestResult } from './rest.ts';
import { handleGit } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestSeq = 0;

function requestId(): string {
  requestSeq += 1;
  return `FORGE-${requestSeq.toString(36).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId(),
    ...(text ? { 'content-length': Buffer.byteLength(text) } : {}),
    ...headers,
  });
  res.end(text);
}

function sendResult(res: ServerResponse, result: RestResult): void {
  if (result.noBody) {
    res.writeHead(result.status, { 'x-github-request-id': requestId(), ...(result.headers ?? {}) });
    res.end();
    return;
  }
  sendJson(res, result.status, result.body, result.headers);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authed(req: IncomingMessage): boolean {
  if (TOKEN === '') return true; // local development without a token configured
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

function decodeSeg(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

interface CachedGet {
  epoch: number;
  status: number;
  body: string;
  headers?: Record<string, string>;
}

export function createApp(): Server {
  const forge = new Forge();
  // Read-through cache for REST GET responses. Every state change arrives as
  // a non-GET request and is applied synchronously inside its handler, so the
  // epoch is bumped when such a request finishes: a cached body is served
  // only when no mutation has completed since it was stored, and a GET stores
  // only when no mutation completed while it was being handled.
  let mutationEpoch = 0;
  const getCache = new Map<string, CachedGet>();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const method0 = req.method ?? 'GET';
    const epochAtStart = mutationEpoch;
    const handle = async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://entry');
      const path = url.pathname;
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (!authed(req)) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }

      const raw = await readBody(req);

      if (path === '/api/graphql' && method === 'POST') {
        let gqlBody: unknown;
        try {
          gqlBody = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
          return;
        }
        const result = handleGraphQL(forge, gqlBody);
        res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId() });
        res.end(JSON.stringify(result.body));
        return;
      }

      if (path === '/mcp') {
        const result = handleMcp(forge, raw.toString('utf8'));
        if (result.body === undefined) {
          res.writeHead(result.status);
          res.end();
        } else {
          res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result.body));
        }
        return;
      }

      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        let body: Record<string, unknown> | undefined;
        if (raw.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
          try {
            body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return;
          }
        }
        const cacheKey = method === 'GET' ? `${req.headers.host ?? ''} ${path}${url.search}` : '';
        if (method === 'GET') {
          const hit = getCache.get(cacheKey);
          if (hit && hit.epoch === mutationEpoch) {
            res.writeHead(hit.status, {
              'content-type': JSON_TYPE,
              'x-github-request-id': requestId(),
              'content-length': Buffer.byteLength(hit.body),
              ...(hit.headers ?? {}),
            });
            res.end(hit.body);
            return;
          }
        }
        const seg = path.split('/').filter((s) => s !== '').slice(2).map(decodeSeg);
        const proto = req.headers['x-forwarded-proto'] ?? 'http';
        const baseUrl = `${proto}://${req.headers.host ?? 'localhost'}`;
        const result = handleRest(forge, method, seg, url.searchParams, body, baseUrl) ?? notFound();
        if (method === 'GET' && result.status === 200 && !result.noBody && result.body !== undefined && mutationEpoch === epochAtStart) {
          const text = `${JSON.stringify(result.body)}\n`;
          if (getCache.size > 2048) getCache.clear();
          getCache.set(cacheKey, { epoch: epochAtStart, status: result.status, body: text, headers: result.headers });
          res.writeHead(result.status, {
            'content-type': JSON_TYPE,
            'x-github-request-id': requestId(),
            'content-length': Buffer.byteLength(text),
            ...(result.headers ?? {}),
          });
          res.end(text);
          return;
        }
        sendResult(res, result);
        return;
      }

      const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)$/.exec(path);
      if (gitMatch) {
        const result = handleGit(forge, req, method, decodeSeg(gitMatch[1]), decodeSeg(gitMatch[2]), gitMatch[3], url.searchParams, raw);
        if (result) {
          res.writeHead(result.status, { 'content-type': result.contentType, 'content-length': result.body.length });
          res.end(result.body);
          return;
        }
      }

      sendResult(res, notFound());
    };
    void (async () => {
      try {
        await handle();
      } finally {
        if (method0 !== 'GET') mutationEpoch += 1;
      }
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
    });
  });
}
