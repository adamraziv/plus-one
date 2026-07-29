import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import {
  InboundChannelMessageSchemaV1,
  MakerInvocationSchemaV1,
  TeamLeadInvocationSchemaV1,
} from '@plus-one/contracts';
import { closeDatabasePools, createDatabasePools } from '@plus-one/database';
import { budgetingTeamDefinition } from '@plus-one/planning';
import { createAgentSystem } from '../../apps/engine/src/agent-catalog.js';
import { createDefaultQueryTools } from '../../apps/engine/src/query-tools.js';
import { createTeamRuntime } from '../../apps/engine/src/team-runtime.js';
import { submitContractResult } from '../helpers/contract-agent-test-double.js';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';

let context: PostgresTestContext | undefined;
let owner: Pool | undefined;
let pools: ReturnType<typeof createDatabasePools> | undefined;

afterEach(async () => {
  if (pools !== undefined) await closeDatabasePools(pools);
  await owner?.end();
  await context?.cleanup();
  pools = undefined;
  owner = undefined;
  context = undefined;
});

describe('team lead supervised retry', () => {
  it('returns a structured maker failure to the budgeting lead before retrying', async () => {
    context = await createPostgresTestContext('team_lead_supervised_retry');
    owner = new Pool({ connectionString: context.migratorUrl });
    await owner.query(
      `INSERT INTO operations.households
         (household_id, reporting_currency, reporting_timezone)
       VALUES ($1, 'USD', 'UTC')`,
      [householdId],
    );
    pools = createDatabasePools(context.roleUrls);

    const callOrder: string[] = [];
    let leadCall = 0;
    let makerCall = 0;
    const agentSystem = createAgentSystem({
      models: {
        lead: { id: 'provider/lead', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
        maker: { id: 'provider/maker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
        checker: { id: 'provider/checker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
        research: { id: 'provider/research', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      },
      queryTools: createDefaultQueryTools(pools),
      queryAgentFactory: () => ({ generate: vi.fn() } as never),
      accountingAgentFactory: () => ({ generate: vi.fn() } as never),
      agentFactory: ({ agentId }) => ({
        generate: vi.fn(async (
          messages: readonly { content: string }[],
          options: unknown,
        ) => {
          callOrder.push(agentId);
          const payload = JSON.parse(messages[0]?.content ?? '{}') as unknown;
          if (agentId === 'budgeting-lead') {
            leadCall += 1;
            const invocation = TeamLeadInvocationSchemaV1.parse(payload);
            expect(invocation).not.toHaveProperty('memory');
            expect(invocation.suggestedPlan?.work[0]?.workCellId).toBe('budgeting-intake');
            if (leadCall === 1) {
              expect(invocation.executionState).toMatchObject({
                remainingAttempts: 2,
                executions: [],
              });
            } else {
              expect(invocation.executionState).toMatchObject({
                remainingAttempts: 1,
                executions: [{
                  executionOrdinal: 1,
                  outcome: 'failed',
                  status: 'failed',
                  work: [{
                    workCellId: 'budgeting-intake',
                    outcome: 'failed',
                    failure: {
                      phase: 'maker_generation',
                      role: { roleName: 'budget-maker', roleVersion: 1 },
                      category: 'validation_rejected',
                      code: 'structured_result_not_submitted',
                      retry: 'safe',
                    },
                  }],
                }],
              });
            }
            return submitContractResult(options, invocation.suggestedPlan);
          }
          if (agentId === 'budget-maker') {
            makerCall += 1;
            const invocation = MakerInvocationSchemaV1.parse(payload);
            expect(invocation).not.toHaveProperty('executionState');
            expect(invocation).not.toHaveProperty('suggestedPlan');
            if (makerCall === 1) {
              return { text: 'I did not submit the required result.', toolResults: [] };
            }
            return submitContractResult(options, {
              schemaName: 'maker-artifact',
              schemaVersion: 1,
              outputSchema: { schemaName: 'planning-clarification', schemaVersion: 1 },
              output: {
                schemaName: 'planning-clarification',
                schemaVersion: 1,
                missingFields: ['priority'],
                questions: ['What monthly income and spending priorities should I use?'],
                reason: 'A checked budget requires the household income and priorities.',
              },
              claims: [],
              assumptions: [],
              uncertainty: [],
            });
          }
          if (agentId === 'budget-checker') {
            const verificationTask = payload as {
              makerArtifact: { artifactId: string; artifactHash: string };
            };
            expect(verificationTask).not.toHaveProperty('executionState');
            return submitContractResult(options, {
              verdict: 'accepted',
              coveredArtifactId: verificationTask.makerArtifact.artifactId,
              coveredArtifactHash: verificationTask.makerArtifact.artifactHash,
              findings: [],
            });
          }
          throw new Error(`Unexpected planning agent call: ${agentId}`);
        }),
      } as never),
    });
    const runtime = createTeamRuntime({ pools, agentSystem });

    const result = await runtime.runTeamLead({
      message: message(),
      team: budgetingTeamDefinition,
      request: {
        schemaName: 'budgeting-lead-request',
        schemaVersion: 1,
        intent: 'budget_plan',
        request: {
          schemaName: 'budget-plan-request-draft',
          schemaVersion: 1,
          instruction: 'Help me create a budget.',
          scopeKey: 'monthly',
        },
      },
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: 'insufficient_evidence',
      outstanding: ['What monthly income and spending priorities should I use?'],
      effect: { state: 'none' },
    });
    expect(callOrder).toEqual([
      'budgeting-lead',
      'budget-maker',
      'budgeting-lead',
      'budget-maker',
      'budget-checker',
    ]);
    expect(leadCall).toBe(2);
    expect(makerCall).toBe(2);
  });
});

function message() {
  return InboundChannelMessageSchemaV1.parse({
    schemaName: 'inbound-channel-message',
    schemaVersion: 1,
    conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    householdId,
    channel: 'telegram',
    externalMessageId: 'telegram:42:supervised-retry',
    receivedAt: '2026-07-29T08:47:01.224Z',
    speaker: { principalRef: 'telegram:user:42' },
    body: 'Help me create a budget.',
    attachments: [],
    metadata: { destination: { chatId: 'telegram-chat-42' } },
  });
}
