import { afterEach, describe, expect, it } from 'vitest';
import {
  InboundChannelMessageSchemaV1,
  PendingWorkingMemoryMutationSchema,
} from '@plus-one/contracts';
import { OrchestratorAgent } from '../../apps/engine/src/agents/orchestrator.js';
import { SubmitPendingInteractionDispositionToolId } from '../../apps/engine/src/agents/pending-interaction-disposition.js';
import { createOrchestratorSessionMemory } from '../../apps/engine/src/memory/orchestrator-session-memory.js';
import type { OrchestratorTeamRuntime } from '../../apps/engine/src/tools/delegate-team.js';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';
import {
  startOpenAiCompatibleTestServer,
  type OpenAiCompatibleTestServer,
} from '../helpers/openai-compatible-test-server.js';

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const conversationId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K';

let context: PostgresTestContext | undefined;
let modelServer: OpenAiCompatibleTestServer | undefined;
let sessionMemory: ReturnType<typeof createOrchestratorSessionMemory> | undefined;

afterEach(async () => {
  await sessionMemory?.close();
  await modelServer?.close();
  await context?.cleanup();
  sessionMemory = undefined;
  modelServer = undefined;
  context = undefined;
});

describe('pending Working Memory classifier acceptance', () => {
  it('classifies a new intent through real thread-scoped Mastra memory processing', async () => {
    context = await createPostgresTestContext('pending_classifier_memory');
    let requestCount = 0;
    modelServer = await startOpenAiCompatibleTestServer({
      responder: () => {
        requestCount += 1;
        if (requestCount > 1) {
          return {
            message: { role: 'assistant', content: 'Classification recorded.' },
            finishReason: 'stop',
          };
        }
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'pending-disposition-call',
              type: 'function',
              function: {
                name: SubmitPendingInteractionDispositionToolId,
                arguments: JSON.stringify({ disposition: 'new_intent' }),
              },
            }],
          },
          finishReason: 'tool_calls',
        };
      },
    });
    const model = {
      id: modelServer.environment.ORCHESTRATOR_MODEL!,
      endpoint: modelServer.environment.LLM_ENDPOINT!,
      apiKey: modelServer.environment.LLM_API_KEY!,
    };
    sessionMemory = createOrchestratorSessionMemory({
      connectionString: context.roleUrls.memory,
      model,
    });
    const unexpectedTeamCall = async () => {
      throw new Error('The pending classifier must not invoke a specialist team.');
    };
    const teamRuntime: OrchestratorTeamRuntime = {
      runTeamLead: unexpectedTeamCall,
      resumePendingMutation: unexpectedTeamCall,
      cancelPendingMutation: unexpectedTeamCall,
    };
    const orchestrator = new OrchestratorAgent({
      model,
      teams: [],
      teamRuntime,
      sessionMemory,
    });
    const message = InboundChannelMessageSchemaV1.parse({
      schemaName: 'inbound-channel-message',
      schemaVersion: 1,
      conversationId,
      householdId,
      channel: 'telegram',
      externalMessageId: 'telegram:pending-classifier:1',
      receivedAt: '2026-08-03T10:00:00.000Z',
      speaker: { principalRef: 'telegram:user:1' },
      body: '1. Uang makan 2 juta; 2. Transport 1 juta',
      attachments: [],
      metadata: { destination: { chatId: 'live-chat' } },
    });
    const pending = PendingWorkingMemoryMutationSchema.parse({
      proposalId: 'wmproposal_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      householdId,
      conversationId,
      speakerPrincipalRef: 'telegram:user:1',
      mutation: {
        operation: 'create',
        entryId: 'wme_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        entry: {
          kind: 'communication_preference',
          summary: 'Use concise replies.',
          scope: 'household',
          value: { detail: 'concise' },
        },
      },
      basedOnRevision: 'a'.repeat(64),
      createdAt: '2026-08-03T10:00:00.000Z',
      expiresAt: '2026-08-03T10:15:00.000Z',
    });

    await expect(orchestrator.classifyPendingWorkingMemoryInput({ message, pending }))
      .resolves.toBe('new_intent');
    expect(modelServer.requests()).toHaveLength(1);
  }, 60_000);
});
