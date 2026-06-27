import { describe, expect, it, vi } from 'vitest';
import {
  InboundChannelMessageSchemaV1,
  MakerArtifactSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  TeamResultEnvelopeSchemaV1,
  type OrchestratorFinalResponseV1,
  type TeamResultEnvelopeV1,
} from '@plus-one/contracts';
import type { TeamDefinition } from '@plus-one/runtime';
import { OrchestratorAgent } from '../src/agents/orchestrator.js';
import type { OrchestratorTeamRuntime } from '../src/tools/delegate-team.js';

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const conversationId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const taskId = 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const artifactId = 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const artifactHash = 'a'.repeat(64);
const now = '2026-06-23T10:00:00.000Z';
const queryTeam = {
  team: 'query',
  lead: {
    identity: { roleName: 'query-lead', roleVersion: 1 },
    kind: 'lead',
    agentId: 'query-lead',
    runtimePolicy: { policyName: 'query-lead', policyVersion: 1 },
  },
  charter: 'Provide checked evidence.',
  prohibitedBehavior: [],
  workCells: [],
  allowedStrategyNames: ['single-maker-checker'],
} as TeamDefinition;

const accountingTeam = {
  team: 'accounting',
  lead: {
    identity: { roleName: 'accounting-lead', roleVersion: 1 },
    kind: 'lead',
    agentId: 'accounting-lead',
    runtimePolicy: { policyName: 'accounting-lead', policyVersion: 1 },
  },
  charter: 'Convert explicit accounting instructions into checked mutation work.',
  prohibitedBehavior: [],
  workCells: [],
  allowedStrategyNames: ['single-maker-checker'],
} as TeamDefinition;

function message(body: string) {
  return InboundChannelMessageSchemaV1.parse({
    schemaName: 'inbound-channel-message',
    schemaVersion: 1,
    conversationId,
    householdId,
    channel: 'telegram',
    externalMessageId: 'telegram-message-1',
    receivedAt: now,
    speaker: { principalRef: 'telegram:user:1' },
    body,
    attachments: [],
    metadata: { destination: { chatId: 'telegram-chat-42' } },
  });
}

function teamResult() {
  return TeamResultEnvelopeSchemaV1.parse({
    schemaName: 'team-result',
    schemaVersion: 1,
    householdId,
    taskId,
    team: 'query',
    status: 'verified',
    claims: [{
      claimId: 'accounts-listed',
      text: 'The checked evidence includes one account row.',
      evidenceArtifactIds: [],
      checkedMakerArtifactIds: [artifactId],
    }],
    assumptions: [],
    uncertainty: [],
    freshness: [`query refreshed ${now}`],
    coverage: ['query'],
    makerArtifacts: [{
      artifactId,
      householdId,
      taskId,
      artifactType: 'maker_output',
      schema: { schemaName: 'maker-artifact', schemaVersion: 1 },
      canonicalizationVersion: 'rfc8785-v1',
      hashAlgorithm: 'sha256',
      artifactHash,
      payload: MakerArtifactSchemaV1.parse({
        schemaName: 'maker-artifact',
        schemaVersion: 1,
        outputSchema: { schemaName: 'query-result', schemaVersion: 1 },
        output: { answer: 'one account' },
        claims: [{ claimId: 'accounts-listed', text: 'one account row', evidenceArtifactIds: [] }],
        assumptions: [],
        uncertainty: [],
      }),
      createdAt: now,
    }],
    checkerVerdicts: [{ verdict: 'accepted', coveredArtifactId: artifactId, coveredArtifactHash: artifactHash, findings: [] }],
    selectedSkill: { skillName: 'query-evidence', skillVersion: 1, contentHash: 'b'.repeat(64) },
    strategyName: 'single-maker-checker',
    stopCondition: { code: 'query-answer', description: 'Return one checked query answer.' },
    completionReason: 'Ready for orchestrator reconciliation.',
    outstanding: [],
  });
}

function insufficientEvidenceResult(team: 'accounting' | 'query' = 'accounting') {
  return TeamResultEnvelopeSchemaV1.parse({
    ...teamResult(),
    team,
    status: 'insufficient_evidence',
    claims: [],
    completionReason: 'Need the payment account before recording this transaction.',
    outstanding: ['Which account was used to pay?'],
  });
}

function finalResponse(body = 'Structured response.'): OrchestratorFinalResponseV1 {
  return OrchestratorFinalResponseSchemaV1.parse({
    schemaName: 'orchestrator-final-response',
    schemaVersion: 1,
    responseId: 'response-structured',
    householdId,
    conversationId,
    body,
    policyBoundary: 'informational_only',
    citations: [{ label: 'orchestrator-policy', sourceRef: 'runtime-instructions' }],
    assumptions: [],
    freshness: ['current invocation only'],
    disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
    unsupportedCapabilities: [],
    recommendationActions: [],
    delivery: { channel: 'telegram', destination: { chatId: 'telegram-chat-42' }, format: 'plain_text' },
    responseHash: 'd'.repeat(64),
    createdAt: now,
  });
}

function queryDraft(businessQuestion: string, extra: Record<string, unknown> = {}) {
  return {
    schemaName: 'query-lead-request-draft',
    schemaVersion: 1,
    businessQuestion,
    requiredCalculations: [],
    ...extra,
  };
}

describe('OrchestratorAgent', () => {
  it('lets the orchestrator agent delegate through the existing team lead runtime', async () => {
    const runTeamLead = vi.fn(async (input) => {
      expect(input.request).toMatchObject({ businessQuestion: 'List our accounts.' });
      return teamResult();
    });
    const generate = vi.fn(async (messages) => {
      expect(messages).toContain('List our accounts.');
      const result = await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.', {
          desiredGrain: ['household', 'account'],
          coverage: ['account list'],
        }),
      });
      return {
        object: OrchestratorFinalResponseSchemaV1.parse({
          schemaName: 'orchestrator-final-response',
          schemaVersion: 1,
          responseId: 'response-1',
          householdId,
          conversationId,
          body: result.claims[0]!.text + '\n\nPlus One is an AI assistant, not a licensed financial professional.',
          policyBoundary: 'personalized_finance',
          citations: [{ label: 'query:accounts-listed', artifactId }],
          assumptions: [],
          freshness: result.freshness,
          disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
          unsupportedCapabilities: [],
          recommendationActions: [],
          delivery: { channel: 'telegram', destination: { chatId: 'telegram-chat-42' }, format: 'plain_text' },
          responseHash: 'c'.repeat(64),
          createdAt: now,
        }),
      };
    });
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate }) as never,
      teams: [queryTeam],
      teamRuntime: { runTeamLead },
    });

    const response = await orchestrator.run({ message: message('List our accounts.') });

    expect(runTeamLead).toHaveBeenCalledWith(expect.objectContaining({ team: queryTeam }));
    expect(generate).toHaveBeenCalledTimes(1);
    expect((orchestrator.agent as unknown as { description: string }).description).toContain('single entrypoint');
    expect(orchestrator.agentTools.delegateTeam.description).toContain('specialist team lead');
    expect(response.body).toContain('one account row');
  });

  it('keeps delegate context isolated across concurrent runs', async () => {
    const runTeamLead = vi.fn(async (_input: Parameters<OrchestratorTeamRuntime['runTeamLead']>[0]) => {
      void _input;
      return teamResult();
    });
    let secondDelegated!: () => void;
    const secondDelegatedPromise = new Promise<void>((resolve) => {
      secondDelegated = resolve;
    });
    let firstEntered!: () => void;
    const firstEnteredPromise = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const generate = vi.fn(async (messages: string) => {
      const body = messages.includes('first') ? 'first' : 'second';
      if (body === 'first') {
        firstEntered();
        await secondDelegatedPromise;
      } else {
        await firstEnteredPromise;
      }
      const result = await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft(body),
      });
      if (body === 'second') secondDelegated();
      return {
        object: OrchestratorFinalResponseSchemaV1.parse({
          schemaName: 'orchestrator-final-response',
          schemaVersion: 1,
          responseId: `response-${body}`,
          householdId,
          conversationId,
          body: result.claims[0]!.text + '\n\nPlus One is an AI assistant, not a licensed financial professional.',
          policyBoundary: 'personalized_finance',
          citations: [{ label: 'query:accounts-listed', artifactId }],
          assumptions: [],
          freshness: result.freshness,
          disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
          unsupportedCapabilities: [],
          recommendationActions: [],
          delivery: { channel: 'telegram', destination: { chatId: 'telegram-chat-42' }, format: 'plain_text' },
          responseHash: 'c'.repeat(64),
          createdAt: now,
        }),
      };
    });
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate }) as never,
      teams: [queryTeam],
      teamRuntime: { runTeamLead },
    });

    await Promise.all([
      orchestrator.run({ message: message('first') }),
      orchestrator.run({ message: message('second') }),
    ]);

    expect(runTeamLead.mock.calls.map(([input]) => input.message.body).sort())
      .toEqual(['first', 'second']);
  });

  it('keeps final schema off the reasoning agent and uses a no-tools finalizer', async () => {
    const mainGenerate = vi.fn(async (_messages: unknown, options: Record<string, unknown>) => {
      expect(options).toEqual({
        memory: {
          thread: conversationId,
          resource: householdId,
        },
      });
      return { text: 'Plus One can help with household finance questions.' };
    });
    const finalizerGenerate = vi.fn(async (_messages: unknown, options: Record<string, unknown>) => {
      expect(options).toMatchObject({
        structuredOutput: expect.objectContaining({ jsonPromptInjection: true }),
        toolChoice: 'none',
      });
      return {
        object: {
          body: 'Plus One can help with household finance questions.',
          policyBoundary: 'informational_only',
          citations: [{ label: 'orchestrator-policy', sourceRef: 'runtime-instructions' }],
          assumptions: [],
          freshness: ['current invocation only'],
          disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
          unsupportedCapabilities: [],
          recommendationActions: [],
        },
      };
    });
    const configs: Array<{ id?: string; tools: Record<string, unknown> | undefined }> = [];
    const orchestrator = new OrchestratorAgent({
      model: { id: 'deepseek/deepseek-v4-flash', endpoint: 'https://api.deepseek.com', apiKey: 'test-api-key' },
      agentFactory: (config) => {
        configs.push({ id: config.id, tools: config.tools as Record<string, unknown> | undefined });
        return {
          ...config,
          generate: Object.keys((config.tools as Record<string, unknown> | undefined) ?? {}).length === 0
            ? finalizerGenerate
            : mainGenerate,
        } as never;
      },
      teams: [queryTeam],
      teamRuntime: { runTeamLead: vi.fn() },
    });

    await expect(orchestrator.run({ message: message('What can you do?') }))
      .resolves.toMatchObject({ body: 'Plus One can help with household finance questions.' });
    expect(mainGenerate).toHaveBeenCalledTimes(1);
    expect(finalizerGenerate).toHaveBeenCalledTimes(1);
    expect(configs).toEqual([
      expect.objectContaining({ id: 'orchestrator', tools: expect.any(Object) }),
      expect.objectContaining({ id: 'orchestrator-finalizer', tools: {} }),
    ]);
  });

  it('returns a non-terminal turn result when a delegated team needs user clarification', async () => {
    const runTeamLead = vi.fn(async () => insufficientEvidenceResult());
    const mainGenerate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'accounting',
        request: {
          schemaName: 'accounting-lead-request',
          schemaVersion: 1,
          intent: 'transaction_capture',
          request: {
            schemaName: 'transaction-capture-request-draft',
            schemaVersion: 1,
            instruction: 'add $10 of buying a burger',
            known: { amount: '10.00', currency: 'USD' },
          },
        },
      });
      return { text: 'The accounting team needs clarification before posting.' };
    });
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate: mainGenerate }) as never,
      teams: [queryTeam, accountingTeam],
      teamRuntime: { runTeamLead },
    });

    const result = await (orchestrator as OrchestratorAgent & {
      runTurn: (input: { message: ReturnType<typeof message> }) => Promise<unknown>;
    }).runTurn({ message: message('add $10 of buying a burger') });

    expect(result).toMatchObject({
      kind: 'ask-user',
      response: {
        body: expect.stringContaining('Which account was used to pay?'),
      },
    });
  });

  it('uses checked team results when a reasoning model returns prose plus fenced JSON after delegation', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const mainGenerate = vi.fn(async () => {
      const result = await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.', {
          desiredGrain: ['household', 'account'],
          coverage: ['account list'],
        }),
      });
      return {
        text: [
          'Here is the answer.',
          '```json',
          JSON.stringify(finalResponse(result.claims[0]!.text)),
          '```',
        ].join('\n'),
      };
    });
    const finalizerGenerate = vi.fn(async () => ({ text: 'still not structured' }));
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({
        ...config,
        generate: Object.keys((config.tools as Record<string, unknown> | undefined) ?? {}).length === 0
          ? finalizerGenerate
          : mainGenerate,
      }) as never,
      teams: [queryTeam],
      teamRuntime: { runTeamLead },
    });

    const response = await orchestrator.run({ message: message('List our accounts.') });

    expect(mainGenerate).toHaveBeenCalledTimes(1);
    expect(finalizerGenerate).toHaveBeenCalledTimes(1);
    expect(runTeamLead).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      schemaName: 'orchestrator-final-response',
      body: expect.stringContaining('Ready for orchestrator reconciliation.'),
      citations: [{ label: 'query:accounts-listed', artifactId }],
    });
  });

  it('uses checked team citations when the finalizer omits citations after delegation', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const mainGenerate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.', {
          desiredGrain: ['household', 'account'],
          coverage: ['account list'],
        }),
      });
      return { text: 'The Query team found one account.' };
    });
    const finalizerGenerate = vi.fn(async () => ({
      object: {
        body: 'The Query team found one account.',
        policyBoundary: 'personalized_finance',
        citations: [],
        assumptions: [],
        freshness: ['current invocation only'],
        disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
        unsupportedCapabilities: [],
        recommendationActions: [],
      },
    }));
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({
        ...config,
        generate: Object.keys((config.tools as Record<string, unknown> | undefined) ?? {}).length === 0
          ? finalizerGenerate
          : mainGenerate,
      }) as never,
      teams: [queryTeam],
      teamRuntime: { runTeamLead },
    });

    const response = await orchestrator.run({ message: message('List our accounts.') });

    expect(runTeamLead).toHaveBeenCalledTimes(1);
    expect(finalizerGenerate).toHaveBeenCalledTimes(1);
    expect(response.citations).toEqual([{ label: 'query:accounts-listed', artifactId }]);
  });

  it('does not let the finalizer rewrite failed team results as successful answers', async () => {
    const failedResult = TeamResultEnvelopeSchemaV1.parse({
      ...teamResult(),
      status: 'failed',
      claims: [],
      makerArtifacts: [],
      checkerVerdicts: [],
      freshness: [],
      completionReason: 'The checker rejected the artifact or revision attempts were exhausted.',
      outstanding: ['grain mismatch'],
    });
    const runTeamLead = vi.fn(async () => failedResult);
    const mainGenerate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('Show our transactions.'),
      });
      return { text: 'The query returned verified transactions.' };
    });
    const finalizerGenerate = vi.fn(async () => ({
      object: {
        body: 'The query returned verified transactions.',
        policyBoundary: 'personalized_finance',
        citations: [],
        assumptions: [],
        freshness: ['current invocation only'],
        disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
        unsupportedCapabilities: [],
        recommendationActions: [],
      },
    }));
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({
        ...config,
        generate: Object.keys((config.tools as Record<string, unknown> | undefined) ?? {}).length === 0
          ? finalizerGenerate
          : mainGenerate,
      }) as never,
      teams: [queryTeam],
      teamRuntime: { runTeamLead },
    });

    const response = await orchestrator.run({ message: message('Show our transactions.') });

    expect(finalizerGenerate).not.toHaveBeenCalled();
    expect(response.body).toContain('Query team status: failed');
    expect(response.body).toContain('grain mismatch');
    expect(response.body).not.toContain('verified transactions');
    expect(response.citations).toEqual([{ label: 'query:team-result', sourceRef: 'team-result:failed' }]);
  });

  it('uses a later verified team result over an earlier failed retry result', async () => {
    const failedResult = TeamResultEnvelopeSchemaV1.parse({
      ...teamResult(),
      status: 'failed',
      claims: [],
      makerArtifacts: [],
      checkerVerdicts: [],
      freshness: [],
      completionReason: 'Agent output failed structured validation',
      outstanding: ['agent_output_schema_failed'],
    });
    const verifiedResult = teamResult();
    const runTeamLead = vi.fn()
      .mockResolvedValueOnce(failedResult)
      .mockResolvedValueOnce(verifiedResult);
    const mainGenerate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.', {
          desiredGrain: ['household', 'account'],
          coverage: ['account list'],
        }),
      });
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.', {
          desiredGrain: ['household', 'account'],
          coverage: ['account list'],
        }),
      });
      return { text: 'The Query team found one account.' };
    });
    const finalizerGenerate = vi.fn();
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({
        ...config,
        generate: Object.keys((config.tools as Record<string, unknown> | undefined) ?? {}).length === 0
          ? finalizerGenerate
          : mainGenerate,
      }) as never,
      teams: [queryTeam],
      teamRuntime: { runTeamLead },
    });

    const response = await orchestrator.run({ message: message('List our accounts.') });

    expect(runTeamLead).toHaveBeenCalledTimes(2);
    expect(finalizerGenerate).not.toHaveBeenCalled();
    expect(response.body).toContain('Query team status: verified');
    expect(response.body).not.toContain('agent_output_schema_failed');
    expect(response.citations).toEqual([{ label: 'query:accounts-listed', artifactId }]);
  });

  it('does not synthesize query delegation when the model returns a direct final response', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const mainGenerate = vi.fn(async () => ({
      object: finalResponse('I can answer directly without a team.'),
    }));
    const finalizerGenerate = vi.fn();
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({
        ...config,
        generate: Object.keys((config.tools as Record<string, unknown> | undefined) ?? {}).length === 0
          ? finalizerGenerate
          : mainGenerate,
      }) as never,
      teams: [queryTeam, accountingTeam],
      teamRuntime: { runTeamLead },
    });

    const response = await orchestrator.run({ message: message('List our accounts.') });

    expect(mainGenerate).toHaveBeenCalledTimes(1);
    expect(finalizerGenerate).not.toHaveBeenCalled();
    expect(runTeamLead).not.toHaveBeenCalled();
    expect(response.body).toBe('I can answer directly without a team.');
  });

  it('uses the Mastra delegate tool for accounting writes instead of regex pre-routing', async () => {
    const runTeamLead = vi.fn(async () => insufficientEvidenceResult());
    const mainGenerate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'accounting',
        request: {
          schemaName: 'accounting-lead-request',
          schemaVersion: 1,
          intent: 'transaction_capture',
          request: {
            schemaName: 'transaction-capture-request-draft',
            schemaVersion: 1,
            instruction: 'Record a USD 10.00 burger purchase from checking on 2026-06-27 in dining out.',
            known: {
              amount: '10.00',
              currency: 'USD',
              occurredOn: '2026-06-27',
              paymentAccountName: 'checking',
              categoryName: 'dining out',
            },
          },
        },
      });
      return { text: 'The accounting team needs clarification before posting.' };
    });
    const finalizerGenerate = vi.fn();
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({
        ...config,
        generate: Object.keys((config.tools as Record<string, unknown> | undefined) ?? {}).length === 0
          ? finalizerGenerate
          : mainGenerate,
      }) as never,
      teams: [queryTeam, accountingTeam],
      teamRuntime: { runTeamLead },
    });

    const result = await orchestrator.runTurn({
      message: message('Record a USD 10.00 burger purchase from checking on 2026-06-27 in dining out.'),
    });

    expect(mainGenerate).toHaveBeenCalledTimes(1);
    expect(finalizerGenerate).not.toHaveBeenCalled();
    expect(runTeamLead).toHaveBeenCalledWith(expect.objectContaining({
      team: accountingTeam,
      request: expect.objectContaining({
        schemaName: 'accounting-lead-request',
        schemaVersion: 1,
        intent: 'transaction_capture',
      }),
    }));
    expect(result).toMatchObject({
      kind: 'ask-user',
      response: {
        body: expect.stringContaining('Which account was used to pay?'),
      },
    });
  });

  it('fails instead of wrapping invalid no-team model output as plain text', async () => {
    const mainGenerate = vi.fn(async () => ({ text: 'I recorded it.' }));
    const finalizerGenerate = vi.fn(async () => ({ text: 'still not structured' }));
    const orchestrator = new OrchestratorAgent({
      model: { id: 'deepseek/deepseek-v4-flash', endpoint: 'https://api.deepseek.com', apiKey: 'test-api-key' },
      agentFactory: (config) => ({
        ...config,
        generate: Object.keys((config.tools as Record<string, unknown> | undefined) ?? {}).length === 0
          ? finalizerGenerate
          : mainGenerate,
      }) as never,
      teams: [queryTeam],
      teamRuntime: { runTeamLead: vi.fn() },
    });

    await expect(orchestrator.run({ message: message('What can you do?') }))
      .rejects.toThrow();
    expect(mainGenerate).toHaveBeenCalledTimes(1);
    expect(finalizerGenerate).toHaveBeenCalledTimes(1);
  });

  it('rejects non-canonical delegate tool input before team execution', async () => {
    const runTeamLead = vi.fn();
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate: vi.fn() }) as never,
      teams: [queryTeam],
      teamRuntime: { runTeamLead },
    });

    const execute = orchestrator.agentTools.delegateTeam.execute as unknown as (
      input: unknown,
      options: unknown,
    ) => Promise<unknown>;
    await expect(execute({ team: 'Query Team', request: 'test' }, {})).resolves.toMatchObject({ error: true });
    await expect(execute({ team: 'query', request: '"test"' }, {})).resolves.toMatchObject({ error: true });
    expect(runTeamLead).not.toHaveBeenCalled();
  });
});

async function executeDelegate(
  tool: typeof OrchestratorAgent.prototype.agentTools.delegateTeam,
  input: { team: string; request: unknown },
): Promise<TeamResultEnvelopeV1> {
  const execute = tool.execute as unknown as (input: unknown, options: unknown) => Promise<unknown>;
  return TeamResultEnvelopeSchemaV1.parse(await execute(input, {}));
}
