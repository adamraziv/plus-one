import { describe, expect, it, vi } from 'vitest';
import {
  InboundChannelMessageSchemaV1,
  MakerArtifactSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  TeamResultEnvelopeSchemaV1,
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

describe('OrchestratorAgent', () => {
  it('lets the orchestrator agent delegate through the existing team lead runtime', async () => {
    const runTeamLead = vi.fn(async (input) => {
      expect(input.request).toEqual({ businessQuestion: 'List our accounts.' });
      return teamResult();
    });
    const generate = vi.fn(async (messages) => {
      expect(messages).toContain('List our accounts.');
      const result = await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: { businessQuestion: 'List our accounts.' },
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
        request: { businessQuestion: body },
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
});

async function executeDelegate(
  tool: typeof OrchestratorAgent.prototype.agentTools.delegateTeam,
  input: { team: string; request: unknown },
): Promise<TeamResultEnvelopeV1> {
  const execute = tool.execute as unknown as (input: unknown, options: unknown) => Promise<unknown>;
  return TeamResultEnvelopeSchemaV1.parse(await execute(input, {}));
}
