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
  const submitResult = findFunctionTool(body, 'submitResult');
  if (submitResult !== undefined) {
    sendCompletion(response, {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'submit-result-call',
        type: 'function',
        function: {
          name: 'submitResult',
          arguments: JSON.stringify(exampleForSchema(asRecord(submitResult.parameters))),
        },
      }],
    }, 'tool_calls');
    return;
  }

  sendCompletion(response, {
    role: 'assistant',
    content: 'Test model reply.',
  }, 'stop');
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function findFunctionTool(body: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  for (const candidate of tools) {
    const tool = asRecord(candidate);
    const definition = asRecord(tool.function);
    if (definition.name === name) return definition;
  }
  return undefined;
}

function exampleForSchema(schema: Record<string, unknown>): unknown {
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length !== 0) return schema.enum[0];
  if ('default' in schema) return schema.default;

  if (schema.type === 'object' || 'properties' in schema) {
    const properties = asRecord(schema.properties);
    const required = new Set(Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === 'string')
      : Object.keys(properties));
    return Object.fromEntries(Object.entries(properties)
      .filter(([key]) => required.has(key))
      .map(([key, value]) => [key, exampleForSchema(asRecord(value))]));
  }
  if (schema.type === 'array') {
    const minimum = typeof schema.minItems === 'number' ? schema.minItems : 0;
    return Array.from({ length: minimum }, () => exampleForSchema(asRecord(schema.items)));
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    return typeof schema.minimum === 'number' ? schema.minimum : 0;
  }
  if (schema.type === 'boolean') return false;
  return 'test';
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
