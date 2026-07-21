import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TelegramApiTestRequest {
  method: string;
  body: Record<string, unknown>;
}

export interface TelegramApiTestServer {
  baseUrl: string;
  requests(): readonly TelegramApiTestRequest[];
  close(): Promise<void>;
}

export async function startTelegramApiTestServer(): Promise<TelegramApiTestServer> {
  const requests: TelegramApiTestRequest[] = [];
  let nextMessageId = 1_000;
  const server = createServer((request, response) => {
    void handleRequest(request, response, requests, () => nextMessageId++).catch(() => {
      sendJson(response, 500, { ok: false, description: 'Telegram test server failed.' });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  let closed = false;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests: () => [...requests],
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: TelegramApiTestRequest[],
  nextMessageId: () => number,
): Promise<void> {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const match = /^\/bot[^/]+\/([^/]+)$/.exec(path);
  if (request.method !== 'POST' || match?.[1] === undefined) {
    sendJson(response, 404, { ok: false, description: 'Not found.' });
    return;
  }
  const body = await readJson(request);
  requests.push({ method: match[1], body });
  sendJson(response, 200, {
    ok: true,
    result: {
      message_id: nextMessageId(),
    },
  });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) return {};
  const value = JSON.parse(text) as unknown;
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
