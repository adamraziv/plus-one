import { afterEach, describe, expect, it } from 'vitest';
import {
  InboundChannelMessageSchemaV1,
  OrchestratorFinalResponseSchemaV1,
} from '@plus-one/contracts';
import { OrchestratorAgent } from '../../apps/engine/src/agents/orchestrator.js';
import { createRuntimeRoutes } from '../../apps/engine/src/runtime-routes.js';
import { startOpenAiCompatibleTestServer, type OpenAiCompatibleTestServer } from '../helpers/openai-compatible-test-server.js';

let modelServer: OpenAiCompatibleTestServer | undefined;

afterEach(async () => {
  await modelServer?.close();
  modelServer = undefined;
});

describe('orchestrator final response acceptance', () => {
  it('retries XML-like raw output and returns only the native final response body', async () => {
    let modelCalls = 0;
    modelServer = await startOpenAiCompatibleTestServer({
      responder: () => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            message: {
              role: 'assistant',
              content: '<invoke name="submitFinalResponse"><parameter name="body">leaked</parameter></invoke>',
            },
            finishReason: 'stop',
          };
        }
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'submit-final-response-1',
              type: 'function',
              function: {
                name: 'submitFinalResponse',
                arguments: JSON.stringify({ body: 'The repaired response is native.' }),
              },
            }],
          },
          finishReason: 'tool_calls',
        };
      },
    });

    const orchestrator = new OrchestratorAgent({
      model: {
        id: modelServer.environment.ORCHESTRATOR_MODEL!,
        endpoint: modelServer.environment.LLM_ENDPOINT!,
        apiKey: modelServer.environment.LLM_API_KEY!,
      },
      teams: [],
      teamRuntime: {
        runTeamLead: async () => { throw new Error('Unexpected team delegation.'); },
        resumePendingMutation: async () => { throw new Error('Unexpected mutation resume.'); },
        cancelPendingMutation: async () => { throw new Error('Unexpected mutation cancellation.'); },
      },
    });
    const [route] = createRuntimeRoutes({
      config: {
        nodeEnv: 'test',
        host: '127.0.0.1',
        port: 4111,
        turnDeadlineMs: 60_000,
        database: { poolUrls: {} },
        models: {
          orchestrator: orchestratorModel(modelServer),
          lead: orchestratorModel(modelServer),
          maker: orchestratorModel(modelServer),
          checker: orchestratorModel(modelServer),
          research: orchestratorModel(modelServer),
        },
      } as never,
      agentSystem: { teams: [] } as never,
      teamRuntime: {
        runTeamLead: async () => { throw new Error('Unexpected team delegation.'); },
        resumePendingMutation: async () => { throw new Error('Unexpected mutation resume.'); },
        cancelPendingMutation: async () => { throw new Error('Unexpected mutation cancellation.'); },
      },
      orchestrator,
    });
    if (route === undefined || !('handler' in route)) throw new Error('Expected runtime route handler');

    const inbound = InboundChannelMessageSchemaV1.parse({
      schemaName: 'inbound-channel-message',
      schemaVersion: 1,
      conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      channel: 'telegram',
      externalMessageId: 'xml-leak-regression-1',
      receivedAt: '2026-08-02T00:00:00.000Z',
      speaker: { principalRef: 'telegram:user:1' },
      body: 'hello',
      attachments: [],
      metadata: { destination: { chatId: 'acceptance-chat' } },
    });
    const response = await route.handler({
      req: { json: async () => inbound },
      json: (body: unknown, status = 200) => Response.json(body, { status }),
    } as never, async () => undefined);
    const parsed = OrchestratorFinalResponseSchemaV1.parse(await response.json());

    expect(response.status).toBe(200);
    expect(modelCalls).toBe(2);
    expect(parsed.body).toBe('The repaired response is native.');
    expect(parsed.body).not.toContain('<invoke');
    expect(parsed.body).not.toContain('<parameter');
  });

  it('preserves the typed protocol error when repair attempts are exhausted', async () => {
    let modelCalls = 0;
    modelServer = await startOpenAiCompatibleTestServer({
      responder: () => {
        modelCalls += 1;
        return {
          message: {
            role: 'assistant',
            content: '<invoke name="mutateWorkingMemory"><parameter name="operation">create</parameter></invoke>',
          },
          finishReason: 'stop',
        };
      },
    });
    const channelEvents: unknown[] = [];
    const orchestrator = new OrchestratorAgent({
      model: orchestratorModel(modelServer),
      teams: [],
      teamRuntime: {
        runTeamLead: async () => { throw new Error('Unexpected team delegation.'); },
        resumePendingMutation: async () => { throw new Error('Unexpected mutation resume.'); },
        cancelPendingMutation: async () => { throw new Error('Unexpected mutation cancellation.'); },
      },
      channelEvents: {
        emit: async (event: unknown) => { channelEvents.push(event); },
      } as never,
    });
    const [route] = createRuntimeRoutes({
      config: {
        nodeEnv: 'test',
        host: '127.0.0.1',
        port: 4111,
        turnDeadlineMs: 60_000,
        database: { poolUrls: {} },
        models: Object.fromEntries(['orchestrator', 'lead', 'maker', 'checker', 'research']
          .map((name) => [name, orchestratorModel(modelServer)])),
      } as never,
      agentSystem: { teams: [] } as never,
      teamRuntime: {
        runTeamLead: async () => { throw new Error('Unexpected team delegation.'); },
        resumePendingMutation: async () => { throw new Error('Unexpected mutation resume.'); },
        cancelPendingMutation: async () => { throw new Error('Unexpected mutation cancellation.'); },
      },
      orchestrator,
    });
    if (route === undefined || !('handler' in route)) throw new Error('Expected runtime route handler');

    const inbound = InboundChannelMessageSchemaV1.parse({
      schemaName: 'inbound-channel-message',
      schemaVersion: 1,
      conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J2K',
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J2K',
      channel: 'telegram',
      externalMessageId: 'xml-leak-regression-exhausted',
      receivedAt: '2026-08-02T00:00:00.000Z',
      speaker: { principalRef: 'telegram:user:2' },
      body: 'remember this preference',
      attachments: [],
      metadata: { destination: { chatId: 'acceptance-chat' } },
    });

    await expect(route.handler({
      req: { json: async () => inbound },
      json: (body: unknown, status = 200) => Response.json(body, { status }),
    } as never, async () => undefined)).rejects.toMatchObject({
      code: 'orchestrator_response_not_submitted',
    });
    expect(modelCalls).toBeGreaterThan(1);
    expect(channelEvents).not.toContainEqual(expect.objectContaining({
      body: expect.stringContaining('<invoke'),
    }));
  });
});

function orchestratorModel(model: OpenAiCompatibleTestServer) {
  return {
    id: model.environment.ORCHESTRATOR_MODEL!,
    endpoint: model.environment.LLM_ENDPOINT!,
    apiKey: model.environment.LLM_API_KEY!,
  };
}
