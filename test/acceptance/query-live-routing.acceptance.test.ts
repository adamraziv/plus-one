import type { MastraDBMessage } from '@mastra/core/agent';
import { describe, expect, it, vi } from 'vitest';
import {
  InboundChannelMessageSchemaV1,
  MakerArtifactSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  QueryResultSchemaV1,
  TeamResultEnvelopeSchemaV2,
  type InboundChannelMessageV1,
  type QueryResultV1,
  type TeamResultEnvelopeV2,
} from '@plus-one/contracts';
import { QueryToolRegistry, ReadOnlySqlValidator, queryTeamDefinition } from '@plus-one/query';
import { createAnalystSandboxTool } from '@plus-one/runtime';
import { OrchestratorAgent } from '../../apps/engine/src/agents/orchestrator.js';
import { bootstrap } from '../../apps/engine/src/bootstrap.js';
import { loadConfig } from '../../apps/engine/src/config.js';
import type { OrchestratorSessionMemoryPort } from '../../apps/engine/src/memory/orchestrator-session-memory.js';
import { createRuntimeRoutes } from '../../apps/engine/src/runtime-routes.js';
import { createTeamRuntime } from '../../apps/engine/src/team-runtime.js';
import type { OrchestratorTeamRuntime } from '../../apps/engine/src/tools/delegate-team.js';
import { createQueryTools } from '../../apps/engine/src/tools/query.js';

const liveIt = process.env.LIVE_LLM === '1' ? it : it.skip;
const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const conversationId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const taskId = 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const accountArtifactId = 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const balanceArtifactId = 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J2K';
const accountArtifactHash = 'a'.repeat(64);
const balanceArtifactHash = 'b'.repeat(64);
const now = '2026-07-14T00:00:00.000Z';
const synthesisFallbackMarker = 'SYNTHESIS_FIXTURE_FALLBACK_MARKER';
type DelegatedTurn = Parameters<OrchestratorTeamRuntime['runTeamLead']>[0];

describe('query live routing acceptance', () => {
  liveIt('answers an account-list question through orchestrator, Query maker tool, checker, and final response', async () => {
    const hits: string[] = [];
    const registry = new QueryToolRegistry({
      allowedRelations: ['reporting.accounts'],
      maxRows: 100,
      validator: new ReadOnlySqlValidator(),
    });
    registry.register({
      toolName: 'account_list',
      relationNames: ['reporting.accounts'],
      sql: 'SELECT account_id, name FROM reporting.accounts WHERE household_id = $1 LIMIT 100',
      parameters: ['$1'],
      limit: 100,
      description: 'List household accounts.',
    });
    const queryTools = createQueryTools({
      registry,
      withEvidenceHandle: async (work) => work({
        runTool: async (toolName, parameters) => {
          hits.push(`${toolName}:${JSON.stringify(parameters)}`);
          return QueryResultSchemaV1.parse({
            schemaName: 'query-result',
            schemaVersion: 1,
            relationName: 'reporting.accounts',
            grain: ['household', 'account'],
            rows: [{ account_id: 'account_live_stub', name: 'Cash' }],
            fieldDefinitions: ['account_id', 'name'],
            sourceReferences: [
              'relation=reporting.accounts',
              'filter=household_id:eq:hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
            ],
            freshness: 'latest available reporting projection',
            coverageWarnings: [],
          });
        },
      }),
      analystSandboxTool: createAnalystSandboxTool(),
    });

    const runtime = await bootstrap({
      queryTools,
    });
    try {
      const liveTeamRuntime = createTeamRuntime({ pools: runtime.pools, agentSystem: runtime.agentSystem });
      const runTeamLead = vi.fn(async (input: Parameters<typeof liveTeamRuntime.runTeamLead>[0]) =>
        liveTeamRuntime.runTeamLead(input));
      const [route] = createRuntimeRoutes({
        config: runtime.config,
        agentSystem: runtime.agentSystem,
        teamRuntime: { runTeamLead },
      });
      if (route === undefined || !('handler' in route)) throw new Error('Expected runtime route handler');

      const message = InboundChannelMessageSchemaV1.parse({
        schemaName: 'inbound-channel-message',
        schemaVersion: 1,
        conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        channel: 'telegram',
        externalMessageId: `live-query-${Date.now()}`,
        receivedAt: new Date().toISOString(),
        speaker: { principalRef: 'telegram:user:live' },
        body: 'List our accounts.',
        attachments: [],
        metadata: { destination: { chatId: 'live-query-chat' } },
      });

      const response = await route.handler({
        req: { json: async () => message },
        json: (body: unknown) => Response.json(body),
      } as never, async () => undefined);
      const parsed = OrchestratorFinalResponseSchemaV1.parse(await response.json());

      expect(response.status).toBe(200);
      expect(parsed.body).toContain('Cash');
      expect(parsed.body).toMatch(/\b(?:(?:1|one)\s+account|only account)\b/i);
      expect(parsed.body).not.toContain('main orchestrator result was not provided');
      expectNoImplementationDetails(parsed.body);
      expect(parsed.citations.some((citation) => typeof citation.artifactId === 'string')).toBe(true);
      expect(runTeamLead).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.objectContaining({ body: 'List our accounts.' }),
        team: expect.objectContaining({ team: 'query' }),
        request: expect.anything(),
      }));
      expect(hits.length).toBeGreaterThan(0);
      expect(new Set(hits)).toEqual(new Set([
        'account_list:["hh_01JNZQ4A9B8C7D6E5F4G3H2J1K"]',
      ]));
    } finally {
      await runtime.close();
    }
  }, 120_000);

  liveIt.each([
    ['can u check my accounts?', 'account list'],
    ['show me which accounts I have', 'account list'],
    ['can u make sure that i dont have accounts setup?', 'account list'],
    ['what are the balances in my accounts?', 'balance snapshot'],
    ['what is our net worth?', 'balance snapshot'],
  ])('routes %s to %s coverage', async (body, expectedCoverage) => {
    const delegated = await runLiveRoutingTurn(body);
    expect(delegated.request).toMatchObject({ coverage: [expectedCoverage] });
  }, 120_000);

  liveIt('keeps account-list coverage after a prior turn establishes that accounts exist', async () => {
    const delegated: DelegatedTurn[] = [];
    const orchestrator = createLiveOrchestrator({
      sessionMemory: createConversationMemory(),
      runTeamLead: async (input) => {
        delegated.push(input);
        return checkedAccountListResult();
      },
    });

    const first = await orchestrator.run({ message: inboundMessage('show me which accounts I have', 1) });
    await orchestrator.run({ message: inboundMessage('can u make sure that i dont have accounts setup?', 2) });

    expect(first.body).toMatch(/\b(?:checking|groceries|accounts?)\b/i);
    expectNoImplementationDetails(first.body);
    expect(delegated).toHaveLength(2);
    expect(delegated[0]?.request).toMatchObject({ coverage: ['account list'] });
    expect(delegated[1]?.request).toMatchObject({ coverage: ['account list'] });
    expect(delegated[1]?.request).not.toMatchObject({ coverage: ['balance snapshot'] });
  }, 120_000);

  liveIt('does not infer missing accounts from an empty current-balance projection', async () => {
    const runTeamLead = vi.fn(async (input: DelegatedTurn) => {
      expect(input.team.team).toBe('query');
      return accountInventoryAndEmptyBalancesResult();
    });
    const orchestrator = createLiveOrchestrator({ runTeamLead });

    const response = await orchestrator.run({
      message: inboundMessage('What are the balances in my accounts? Summarize the checked account inventory and current-balance results.'),
    });

    expect(runTeamLead).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ coverage: expect.arrayContaining(['balance snapshot']) }),
    }));
    expect(response.body).not.toContain(synthesisFallbackMarker);
    expectNoImplementationDetails(response.body);
    expect(response.body).not.toMatch(/no accounts|no accounts set up|do not have accounts/i);
    expect(response.body).toMatch(
      /(?:(?:current(?:[-\s\u2010-\u2015])?balance(?:\s+results?)?|balance snapshot).{0,60}(?:no|zero).{0,20}rows|(?:no|zero).{0,40}(?:current(?:[-\s\u2010-\u2015])?balance(?:\s+results?)?|balance snapshot).{0,60}rows)/i,
    );
  }, 120_000);

  liveIt('never exposes checked account result contracts when answering the reported Telegram wording', async () => {
    const orchestrator = createLiveOrchestrator({
      runTeamLead: async () => checkedAccountListResult(),
    });

    const response = await orchestrator.run({
      message: inboundMessage('can u check my accounts?'),
    });

    expect(response.body).toMatch(/Checking|Groceries/i);
    expectNoImplementationDetails(response.body);
  }, 120_000);
});

function expectNoImplementationDetails(body: string): void {
  expect(body).not.toMatch(
    /reporting\.|QueryResult(?:V\d+)?|(?:maker|checker)|(?:accounting|query) team|team status|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/i,
  );
}

function inboundMessage(body: string, ordinal = 0): InboundChannelMessageV1 {
  return InboundChannelMessageSchemaV1.parse({
    schemaName: 'inbound-channel-message',
    schemaVersion: 1,
    conversationId,
    householdId,
    channel: 'telegram',
    externalMessageId: `live-routing-${ordinal}-${Date.now()}`,
    receivedAt: now,
    speaker: { principalRef: 'telegram:user:live' },
    body,
    attachments: [],
    metadata: { destination: { chatId: 'live-query-chat' } },
  });
}

function createLiveOrchestrator(input: {
  runTeamLead: OrchestratorTeamRuntime['runTeamLead'];
  sessionMemory?: OrchestratorSessionMemoryPort;
}): OrchestratorAgent {
  const config = loadConfig();
  return new OrchestratorAgent({
    model: config.models.orchestrator,
    teams: [queryTeamDefinition],
    teamRuntime: {
      runTeamLead: input.runTeamLead,
      resumePendingMutation: async () => { throw new Error('Unexpected mutation resume'); },
      cancelPendingMutation: async () => { throw new Error('Unexpected mutation cancellation'); },
    },
    ...(input.sessionMemory === undefined ? {} : { sessionMemory: input.sessionMemory }),
  });
}

async function runLiveRoutingTurn(body: string): Promise<DelegatedTurn> {
  const delegated: DelegatedTurn[] = [];
  const orchestrator = createLiveOrchestrator({
    runTeamLead: async (input) => {
      delegated.push(input);
      return checkedAccountListResult();
    },
  });

  await orchestrator.run({ message: inboundMessage(body) });
  const result = delegated[0];
  if (result === undefined) throw new Error('Expected the live orchestrator to delegate to the Query team.');
  return result;
}

function createConversationMemory(): OrchestratorSessionMemoryPort {
  const messages: MastraDBMessage[] = [];
  return {
    prepareInput: async ({ message }) => [
      ...messages,
      conversationMessage('user', message.body, messages.length),
    ],
    persistTurn: async ({ message, assistantText }) => {
      messages.push(
        conversationMessage('user', message.body, messages.length),
        conversationMessage('assistant', assistantText, messages.length + 1),
      );
    },
    close: async () => undefined,
  };
}

function conversationMessage(
  role: 'user' | 'assistant',
  body: string,
  ordinal: number,
): MastraDBMessage {
  return {
    id: `live-routing-${role}-${ordinal}`,
    role,
    createdAt: new Date(now),
    threadId: conversationId,
    resourceId: householdId,
    content: { format: 2, parts: [{ type: 'text', text: body }] },
  };
}

function checkedAccountListResult(): TeamResultEnvelopeV2 {
  const accounts = QueryResultSchemaV1.parse({
    schemaName: 'query-result',
    schemaVersion: 1,
    relationName: 'reporting.accounts',
    grain: ['household', 'account'],
    rows: [{ account_id: 'account_checking', name: 'Checking' }, { account_id: 'account_groceries', name: 'Groceries' }],
    fieldDefinitions: ['account_id', 'name'],
    sourceReferences: ['relation=reporting.accounts', `filter=household_id:eq:${householdId}`],
    freshness: 'latest available reporting projection',
    coverageWarnings: [],
  });
  return TeamResultEnvelopeSchemaV2.parse({
    schemaName: 'team-result',
    schemaVersion: 2,
    householdId,
    taskId,
    team: 'query',
    status: 'verified',
    claims: [{
      claimId: 'account-inventory',
      text: 'Accepted account inventory lists Checking and Groceries.',
      evidenceArtifactIds: [],
      checkedMakerArtifactIds: [accountArtifactId],
    }],
    assumptions: [],
    uncertainty: [],
    freshness: ['reporting.accounts refreshed 2026-07-14T00:00:00.000Z'],
    coverage: ['account list'],
    makerArtifacts: [checkedQueryArtifact({
      artifactId: accountArtifactId,
      artifactHash: accountArtifactHash,
      output: accounts,
      claimId: 'account-inventory',
      claimText: 'Accepted account inventory lists Checking and Groceries.',
    })],
    checkerVerdicts: [{
      verdict: 'accepted',
      coveredArtifactId: accountArtifactId,
      coveredArtifactHash: accountArtifactHash,
      findings: [],
    }],
    selectedSkill: { skillName: 'query-evidence', skillVersion: 1, contentHash: 'c'.repeat(64) },
    strategyName: 'single-maker-checker',
    stopCondition: { code: 'query-answer', description: 'Return one checked query answer.' },
    completionReason: 'Accepted account inventory is ready for synthesis.',
    outstanding: [],
    effect: { state: 'none' },
  });
}

function accountInventoryAndEmptyBalancesResult(): TeamResultEnvelopeV2 {
  const accounts = QueryResultSchemaV1.parse({
    schemaName: 'query-result',
    schemaVersion: 1,
    relationName: 'reporting.accounts',
    grain: ['household', 'account'],
    rows: [{ account_id: 'account_checking', name: 'Checking' }, { account_id: 'account_groceries', name: 'Groceries' }],
    fieldDefinitions: ['account_id', 'name'],
    sourceReferences: ['relation=reporting.accounts', `filter=household_id:eq:${householdId}`],
    freshness: 'latest available reporting projection',
    coverageWarnings: [],
  });
  const balances = QueryResultSchemaV1.parse({
    schemaName: 'query-result',
    schemaVersion: 1,
    relationName: 'reporting.current_balances',
    grain: ['household', 'account'],
    rows: [],
    fieldDefinitions: ['account_id', 'native_amount'],
    sourceReferences: ['relation=reporting.current_balances', `filter=household_id:eq:${householdId}`],
    freshness: 'latest available reporting projection',
    coverageWarnings: [],
  });
  return TeamResultEnvelopeSchemaV2.parse({
    schemaName: 'team-result',
    schemaVersion: 2,
    householdId,
    taskId,
    team: 'query',
    status: 'verified',
    claims: [
      {
        claimId: 'account-inventory',
        text: 'Accepted account inventory lists Checking and Groceries.',
        evidenceArtifactIds: [],
        checkedMakerArtifactIds: [accountArtifactId],
      },
      {
        claimId: 'empty-current-balances',
        text: 'Accepted current-balance projection returned zero rows.',
        evidenceArtifactIds: [],
        checkedMakerArtifactIds: [balanceArtifactId],
      },
    ],
    assumptions: [],
    uncertainty: [],
    freshness: ['reporting projections refreshed 2026-07-14T00:00:00.000Z'],
    coverage: [
      'account inventory: reporting.accounts',
      'balance projection: reporting.current_balances',
    ],
    makerArtifacts: [
      checkedQueryArtifact({
        artifactId: accountArtifactId,
        artifactHash: accountArtifactHash,
        output: accounts,
        claimId: 'account-inventory',
        claimText: 'Accepted account inventory lists Checking and Groceries.',
      }),
      checkedQueryArtifact({
        artifactId: balanceArtifactId,
        artifactHash: balanceArtifactHash,
        output: balances,
        claimId: 'empty-current-balances',
        claimText: 'Accepted current-balance projection returned zero rows.',
      }),
    ],
    checkerVerdicts: [
      {
        verdict: 'accepted',
        coveredArtifactId: accountArtifactId,
        coveredArtifactHash: accountArtifactHash,
        findings: [],
      },
      {
        verdict: 'accepted',
        coveredArtifactId: balanceArtifactId,
        coveredArtifactHash: balanceArtifactHash,
        findings: [],
      },
    ],
    selectedSkill: { skillName: 'query-evidence', skillVersion: 1, contentHash: 'c'.repeat(64) },
    strategyName: 'single-maker-checker',
    stopCondition: { code: 'query-answer', description: 'Return one checked query answer.' },
    completionReason: synthesisFallbackMarker,
    outstanding: ['An empty current-balance projection does not determine account inventory.'],
    effect: { state: 'none' },
  });
}

function checkedQueryArtifact(input: {
  artifactId: string;
  artifactHash: string;
  output: QueryResultV1;
  claimId: string;
  claimText: string;
}) {
  return {
    artifactId: input.artifactId,
    householdId,
    taskId,
    artifactType: 'maker_output',
    schema: { schemaName: 'maker-artifact', schemaVersion: 1 },
    canonicalizationVersion: 'rfc8785-v1',
    hashAlgorithm: 'sha256',
    artifactHash: input.artifactHash,
    payload: MakerArtifactSchemaV1.parse({
      schemaName: 'maker-artifact',
      schemaVersion: 1,
      outputSchema: { schemaName: 'query-result', schemaVersion: 1 },
      output: input.output,
      claims: [{
        claimId: input.claimId,
        text: input.claimText,
        evidenceArtifactIds: [],
      }],
      assumptions: [],
      uncertainty: [],
    }),
    createdAt: now,
  };
}
