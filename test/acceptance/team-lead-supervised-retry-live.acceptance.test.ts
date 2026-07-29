import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { InboundChannelMessageSchemaV1 } from '@plus-one/contracts';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';
import {
  startProductionGatewayServer,
  type ProductionGatewayServerHandle,
} from '../helpers/production-gateway-server.js';
import type {
  OpenAiCompatibleTestRequest,
  OpenAiCompatibleTestResponder,
} from '../helpers/openai-compatible-test-server.js';

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';

let context: PostgresTestContext | undefined;
let owner: Pool | undefined;
let server: ProductionGatewayServerHandle | undefined;

afterEach(async () => {
  await server?.stop();
  await owner?.end();
  await context?.cleanup();
  server = undefined;
  owner = undefined;
  context = undefined;
});

describe('team-lead supervised retry through the production gateway', () => {
  it('returns a maker contract failure to the budgeting lead before a new maker runs', async () => {
    context = await createPostgresTestContext('gateway_lead_retry');
    owner = new Pool({ connectionString: context.migratorUrl, max: 1 });
    await owner.query(
      `INSERT INTO operations.households
         (household_id, reporting_currency, reporting_timezone)
       VALUES ($1, 'IDR', 'Asia/Shanghai')`,
      [householdId],
    );
    const responder = budgetingRetryResponder();
    server = await startProductionGatewayServer({
      env: databaseEnvironment(context),
      modelResponder: responder,
    });

    const response = await fetch(`${server.baseUrl}/plus-one/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(InboundChannelMessageSchemaV1.parse({
        schemaName: 'inbound-channel-message',
        schemaVersion: 1,
        conversationId: 'conversation_01KYNZJ66YXP77RPW2BMEV0ZXR',
        householdId,
        channel: 'telegram',
        externalMessageId: 'telegram:budgeting-supervised-retry:1',
        receivedAt: '2026-07-29T08:47:01.224Z',
        speaker: { principalRef: 'telegram:user:42', displayName: 'Rajip' },
        body: 'can u try again',
        attachments: [],
        metadata: { destination: { chatId: 'telegram-chat-42' } },
      })),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      body: 'What monthly income and spending priorities should I use?',
    });

    const invocations = server.modelRequests()
      .map(contractInvocation)
      .filter((invocation): invocation is Record<string, unknown> => invocation !== undefined);
    expect(invocations.map(invocationRole)).toEqual([
      'budgeting-lead',
      'budget-maker',
      'budgeting-lead',
      'budget-maker',
      'budget-checker',
    ]);

    const leads = invocations.filter((invocation) =>
      invocation.schemaName === 'team-lead-invocation');
    expect(leads).toHaveLength(2);
    expect(leads[0]).toMatchObject({
      suggestedPlan: {
        work: [{ workCellId: 'budgeting-intake' }],
      },
      executionState: {
        remainingAttempts: 2,
        executions: [],
      },
    });
    expect(leads[1]).toMatchObject({
      suggestedPlan: {
        work: [{ workCellId: 'budgeting-intake' }],
      },
      executionState: {
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
      },
    });

    const makers = invocations.filter((invocation) => invocation.schemaName === 'maker-invocation');
    expect(makers).toHaveLength(2);
    for (const maker of makers) {
      expect(maker).not.toHaveProperty('executionState');
      expect(maker).not.toHaveProperty('suggestedPlan');
    }
    const checkers = invocations.filter((invocation) => invocation.schemaName === 'verification-task');
    expect(checkers).toHaveLength(1);
    expect(checkers[0]).not.toHaveProperty('executionState');
    expect(checkers[0]).not.toHaveProperty('suggestedPlan');
  }, 180_000);

  it('does not start a fresh delegation after supervised attempts are exhausted', async () => {
    context = await createPostgresTestContext('gateway_lead_exhausted');
    owner = new Pool({ connectionString: context.migratorUrl, max: 1 });
    await owner.query(
      `INSERT INTO operations.households
         (household_id, reporting_currency, reporting_timezone)
       VALUES ($1, 'IDR', 'Asia/Shanghai')`,
      [householdId],
    );
    server = await startProductionGatewayServer({
      env: databaseEnvironment(context),
      modelResponder: persistentBudgetingFailureResponder(),
    });

    const response = await fetch(`${server.baseUrl}/plus-one/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(InboundChannelMessageSchemaV1.parse({
        schemaName: 'inbound-channel-message',
        schemaVersion: 1,
        conversationId: 'conversation_01KYNZJ66YXP77RPW2BMEV0ZXR',
        householdId,
        channel: 'telegram',
        externalMessageId: 'telegram:budgeting-exhausted:1',
        receivedAt: '2026-07-29T08:47:01.224Z',
        speaker: { principalRef: 'telegram:user:42', displayName: 'Rajip' },
        body: 'can u try again',
        attachments: [],
        metadata: { destination: { chatId: 'telegram-chat-42' } },
      })),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      body: 'I could not complete that request safely. Please try again.',
    });
    const invocations = server.modelRequests()
      .map(contractInvocation)
      .filter((invocation): invocation is Record<string, unknown> => invocation !== undefined);
    expect(invocations.map(invocationRole)).toEqual([
      'budgeting-lead',
      'budget-maker',
      'budgeting-lead',
      'budget-maker',
    ]);
    expect(invocations[2]).toMatchObject({
      executionState: {
        remainingAttempts: 1,
        executions: [{
          executionOrdinal: 1,
          outcome: 'failed',
          work: [{
            failure: {
              code: 'structured_result_not_submitted',
              retry: 'safe',
            },
          }],
        }],
      },
    });
  }, 180_000);
});

function budgetingRetryResponder(): OpenAiCompatibleTestResponder {
  let rejectedMaker = false;
  return ({ body }) => {
    const invocation = contractInvocation({ path: '', body });
    if (invocation?.schemaName === 'maker-invocation' && rejectedMaker === false) {
      rejectedMaker = true;
      return {
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: 'I did not submit the required contractual result.',
        },
      };
    }
    if (invocation?.schemaName === 'maker-invocation') {
      return {
        finishReason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'submit-budget-maker-result',
            type: 'function',
            function: {
              name: 'submitResult',
              arguments: JSON.stringify({
                schemaName: 'maker-artifact',
                schemaVersion: 1,
                outputSchema: { schemaName: 'planning-clarification', schemaVersion: 1 },
                output: {
                  schemaName: 'planning-clarification',
                  schemaVersion: 1,
                  missingFields: ['priority'],
                  questions: ['What monthly income and spending priorities should I use?'],
                  reason: 'A checked budget requires household income and spending priorities.',
                },
                claims: [],
                assumptions: [],
                uncertainty: [],
              }),
            },
          }],
        },
      };
    }
    if (invocation?.schemaName === 'verification-task') {
      const makerArtifact = isRecord(invocation.makerArtifact) ? invocation.makerArtifact : {};
      return {
        finishReason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'submit-budget-checker-result',
            type: 'function',
            function: {
              name: 'submitResult',
              arguments: JSON.stringify({
                verdict: 'accepted',
                coveredArtifactId: makerArtifact.artifactId,
                coveredArtifactHash: makerArtifact.artifactHash,
                findings: [],
              }),
            },
          }],
        },
      };
    }
    if (invocation !== undefined) return undefined;
    if (hasFunctionTool(body, 'delegateTeam') && !hasToolResult(body)) {
      return {
        finishReason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'delegate-team-budgeting-supervised-retry',
            type: 'function',
            function: {
              name: 'delegateTeam',
              arguments: JSON.stringify({
                team: 'budgeting',
                request: {
                  schemaName: 'budgeting-lead-request',
                  schemaVersion: 1,
                  intent: 'budget_plan',
                  request: {
                    schemaName: 'budget-plan-request-draft',
                    schemaVersion: 1,
                    instruction: [
                      'Set up a Rp200,000 per month recurring budget for jajan starting July 2026.',
                      'The cycle begins on the 1st and has no end date.',
                      'Normal priority; the user adds the allocation manually.',
                    ].join(' '),
                    scopeKey: 'monthly jajan',
                  },
                },
              }),
            },
          }],
        },
      };
    }
    return {
      finishReason: 'stop',
      message: {
        role: 'assistant',
        content: 'I processed the checked jajan budget request.',
      },
    };
  };
}

function persistentBudgetingFailureResponder(): OpenAiCompatibleTestResponder {
  let delegationOrdinal = 0;
  return ({ body }) => {
    const invocation = contractInvocation({ path: '', body });
    if (invocation?.schemaName === 'maker-invocation') {
      return {
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: 'I did not submit the required contractual result.',
        },
      };
    }
    if (invocation !== undefined) return undefined;
    if (hasFunctionTool(body, 'delegateTeam')) {
      delegationOrdinal += 1;
      return budgetingDelegation(`delegate-team-budgeting-exhausted-${delegationOrdinal}`);
    }
    return {
      finishReason: 'stop',
      message: {
        role: 'assistant',
        content: 'I could not complete that request safely. Please try again.',
      },
    };
  };
}

function budgetingDelegation(toolCallId: string) {
  return {
    finishReason: 'tool_calls' as const,
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: toolCallId,
        type: 'function',
        function: {
          name: 'delegateTeam',
          arguments: JSON.stringify({
            team: 'budgeting',
            request: {
              schemaName: 'budgeting-lead-request',
              schemaVersion: 1,
              intent: 'budget_plan',
              request: {
                schemaName: 'budget-plan-request-draft',
                schemaVersion: 1,
                instruction: 'Set up the confirmed recurring jajan budget.',
                scopeKey: 'monthly jajan',
              },
            },
          }),
        },
      }],
    },
  };
}

function contractInvocation(
  request: OpenAiCompatibleTestRequest,
): Record<string, unknown> | undefined {
  const messages = Array.isArray(request.body.messages) ? request.body.messages : [];
  for (const candidate of [...messages].reverse()) {
    if (!isRecord(candidate) || candidate.role !== 'user' || typeof candidate.content !== 'string') {
      continue;
    }
    try {
      const invocation = JSON.parse(candidate.content) as unknown;
      if (isRecord(invocation) && typeof invocation.schemaName === 'string') return invocation;
    } catch {
      continue;
    }
  }
  return undefined;
}

function invocationRole(invocation: Record<string, unknown>): string {
  if (invocation.schemaName === 'team-lead-invocation') {
    return String(isRecord(invocation.role) ? invocation.role.roleName : '');
  }
  if (invocation.schemaName === 'maker-invocation') {
    return String(isRecord(invocation.role) ? invocation.role.roleName : '');
  }
  if (invocation.schemaName === 'verification-task') {
    return String(isRecord(invocation.checkerRole) ? invocation.checkerRole.roleName : '');
  }
  return String(invocation.schemaName);
}

function hasFunctionTool(body: Record<string, unknown>, name: string): boolean {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools.some((candidate) =>
    isRecord(candidate)
    && isRecord(candidate.function)
    && candidate.function.name === name);
}

function hasToolResult(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.some((candidate) => isRecord(candidate) && candidate.role === 'tool');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function databaseEnvironment(testContext: PostgresTestContext): NodeJS.ProcessEnv {
  return {
    DATABASE_MIGRATOR_URL: testContext.migratorUrl,
    DATABASE_ACCOUNTING_URL: testContext.roleUrls.accounting,
    DATABASE_PLANNING_URL: testContext.roleUrls.planning,
    DATABASE_OPERATIONS_URL: testContext.roleUrls.operations,
    DATABASE_QUERY_URL: testContext.roleUrls.query,
    DATABASE_MEMORY_URL: testContext.roleUrls.memory,
  };
}
