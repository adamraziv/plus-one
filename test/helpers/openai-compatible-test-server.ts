import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const Provider = 'openai';
const Model = 'plus-one-test-model';
const CanonicalModel = `${Provider}/${Model}`;

export interface OpenAiCompatibleTestServer {
  environment: NodeJS.ProcessEnv;
  close(): Promise<void>;
}

export async function startOpenAiCompatibleTestServer(): Promise<OpenAiCompatibleTestServer> {
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      sendJson(response, 500, { error: { message: 'Test model server failed.' } });
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
    environment: {
      LLM_ENDPOINT: `http://127.0.0.1:${address.port}/v1`,
      LLM_API_KEY: 'test-api-key',
      ORCHESTRATOR_MODEL: CanonicalModel,
      LEAD_MODEL: CanonicalModel,
      MAKER_MODEL: CanonicalModel,
      CHECKER_MODEL: CanonicalModel,
      RESEARCH_MODEL: CanonicalModel,
    },
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (request.method === 'GET' && path === '/v1/models') {
    sendJson(response, 200, {
      object: 'list',
      data: [{ id: Model, object: 'model', owned_by: Provider }],
    });
    return;
  }
  if (request.method !== 'POST' || path !== '/v1/chat/completions') {
    sendJson(response, 404, { error: { message: 'Not found.' } });
    return;
  }

  const body = asRecord(await readJson(request));
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const toolMessage = [...messages].reverse()
    .find((message) => asRecord(message).role === 'tool');
  const receipt = findReceipt(toolMessage);
  const capabilityProbeRequested = JSON.stringify(messages)
    .includes('call capabilityProbe exactly once');
  if (capabilityProbeRequested && receipt === undefined) {
    sendCompletion(response, {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'capability-probe-call',
        type: 'function',
        function: {
          name: 'capabilityProbe',
          arguments: JSON.stringify({ nonce: 'plus-one-orchestrator-capability-probe' }),
        },
      }],
    }, 'tool_calls');
    return;
  }

  const properties = responseSchemaProperties(body);
  const output = 'body' in properties
    ? {
        body: 'Test orchestrator reply.',
        policyBoundary: 'operational',
        citations: [],
        assumptions: [],
        freshness: ['current invocation only'],
        disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
        unsupportedCapabilities: [],
        recommendationActions: [],
      }
    : {
        status: 'ok',
        evidence: receipt ?? 'direct',
      };
  sendCompletion(response, {
    role: 'assistant',
    content: JSON.stringify(output),
  }, 'stop');
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function responseSchemaProperties(body: Record<string, unknown>): Record<string, unknown> {
  const responseFormat = asRecord(body.response_format);
  const jsonSchema = asRecord(responseFormat.json_schema);
  const schema = asRecord(jsonSchema.schema);
  return asRecord(schema.properties);
}

function findReceipt(value: unknown): string | undefined {
  if (typeof value === 'string') {
    try {
      return findReceipt(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const receipt = findReceipt(item);
      if (receipt !== undefined) return receipt;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (typeof record.receipt === 'string') return record.receipt;
  for (const item of Object.values(record)) {
    const receipt = findReceipt(item);
    if (receipt !== undefined) return receipt;
  }
  return undefined;
}

function sendCompletion(
  response: ServerResponse,
  message: Record<string, unknown>,
  finishReason: 'stop' | 'tool_calls',
): void {
  sendJson(response, 200, {
    id: 'chatcmpl-plus-one-test',
    object: 'chat.completion',
    created: 0,
    model: Model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
