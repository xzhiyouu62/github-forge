// The forge's HTTP server: auth, JSON discipline, request ids, and routing to the REST, git,
// GraphQL and MCP surfaces. main.ts owns the lifecycle; this file is the whole product surface.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest, notFound, type RestResult } from './rest.ts';

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

export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
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
        const seg = path.split('/').filter((s) => s !== '').slice(2).map(decodeSeg);
        const proto = req.headers['x-forwarded-proto'] ?? 'http';
        const baseUrl = `${proto}://${req.headers.host ?? 'localhost'}`;
        const result = handleRest(forge, method, seg, url.searchParams, body, baseUrl) ?? notFound();
        sendResult(res, result);
        return;
      }

      sendResult(res, notFound());
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
    });
  });
}
