import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Agent } from '@mastra/core/agent';
import { TokenLimiter } from '@mastra/core/processors';
import type { Memory } from '@mastra/memory';
import {
  InboundChannelMessageSchemaV1,
  FlexibleWorkingMemorySchema,
  MakerArtifactSchemaV1,
  OpaqueIdentifierDefinitions,
  PlusOneError,
  PendingWorkingMemoryMutationSchema,
  QueryResultSchemaV1,
  TeamResultEnvelopeSchemaV2,
  WorkingMemoryEntryIdSchema,
  WorkingMemoryProposalIdSchema,
  CurrencyCodeSchema,
  type PendingWorkingMemoryMutation,
  type TeamResultEnvelopeV2,
  type UtcInstant,
} from '@plus-one/contracts';
import {
  configureLogging,
  parseLogEnvelope,
  withLogContext,
  type LogEnvelopeV1,
  type TeamDefinition,
} from '@plus-one/runtime';
import { AccountingJournalMutationProposalSchemaV1 } from '@plus-one/accounting';
import { confirmationDecision, OrchestratorAgent } from '../src/agents/orchestrator.js';
import { SubmitPendingInteractionDispositionToolId } from '../src/agents/pending-interaction-disposition.js';
import type { OrchestratorSessionMemoryPort } from '../src/memory/orchestrator-session-memory.js';
import { workingMemoryRevision } from '../src/memory/working-memory-document.js';
import { internalIdentifierMatchCategory } from '../src/safety/internal-identifier.js';
import { finalSynthesisTeamResultView, type OrchestratorTeamRuntime } from '../src/tools/delegate-team.js';
import {
  rawOrchestratorTextLeak,
  submitOrchestratorFinalResponse,
} from '../../../test/helpers/orchestrator-agent-test-double.js';

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const conversationId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const taskId = 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const artifactId = 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const draftId = 'draft_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const artifactHash = 'a'.repeat(64);
const now = '2026-06-23T10:00:00.000Z';
const workingMemoryGoalId = WorkingMemoryEntryIdSchema.parse('wme_01JNZQ4A9B8C7D6E5F4G3H2J1K');
const workingMemoryProposalId = WorkingMemoryProposalIdSchema.parse('wmproposal_01JNZQ4A9B8C7D6E5F4G3H2J1K');

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

function workingMemoryDocument(withGoal = false) {
  return FlexibleWorkingMemorySchema.parse({
    version: 1,
    entries: withGoal ? {
      [workingMemoryGoalId]: {
        kind: 'goal',
        summary: 'Buy a BMW X5.',
        scope: 'household',
        value: { goal: 'BMW X5' },
      },
    } : {},
  });
}

function workingMemoryInspection(document: ReturnType<typeof workingMemoryDocument>) {
  return {
    revision: workingMemoryRevision(document),
    entries: Object.entries(document.entries).map(([entryId, entry]) => ({
      entryId: WorkingMemoryEntryIdSchema.parse(entryId),
      kind: entry.kind,
      summary: entry.summary,
      scope: entry.scope,
      value: entry.value,
    })),
  };
}

async function executeMemoryTool(tool: unknown, input: unknown = {}): Promise<unknown> {
  const executable = tool as { execute?: (input: unknown, context: unknown) => unknown };
  return executable.execute?.(input, {});
}

function pendingWorkingMemory(
  overrides: Omit<Partial<PendingWorkingMemoryMutation>, 'createdAt' | 'expiresAt'> & {
    createdAt?: string;
    expiresAt?: string;
  } = {},
): PendingWorkingMemoryMutation {
  const createdAt = new Date(Date.now() - 1_000).toISOString();
  return PendingWorkingMemoryMutationSchema.parse({
    proposalId: workingMemoryProposalId,
    householdId,
    conversationId,
    speakerPrincipalRef: 'telegram:user:1',
    mutation: {
      operation: 'replace',
      entryId: workingMemoryGoalId,
      entry: {
        kind: 'goal',
        summary: 'Buy a BMW X7.',
        scope: 'household',
        value: { goals: ['BMW X7'] },
      },
    },
    basedOnRevision: 'a'.repeat(64),
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 10 * 60_000).toISOString(),
    ...overrides,
  });
}

function teamResult(team: 'accounting' | 'query' = 'query') {
  return TeamResultEnvelopeSchemaV2.parse({
    schemaName: 'team-result',
    schemaVersion: 2,
    householdId,
    taskId,
    team,
    status: 'verified',
    claims: [{
      claimId: 'accounts-listed',
      text: 'The checked evidence includes one account row.',
      evidenceArtifactIds: [],
      checkedMakerArtifactIds: [artifactId],
    }],
    assumptions: [],
    uncertainty: [],
    freshness: [`${team} refreshed ${now}`],
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
    effect: { state: 'none' },
  });
}

function pendingChartTeamResult(input: {
  name?: string;
  accountingClass?: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  normalBalance?: 'debit' | 'credit';
  nativeCurrency?: string;
  claimText?: string;
} = {}) {
  const base = teamResult('accounting');
  const proposal = {
    schemaName: 'chart-of-accounts-proposal' as const,
    schemaVersion: 1 as const,
    action: 'create_account' as const,
    householdId,
    bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    name: input.name ?? 'Bank ABC',
    accountingClass: input.accountingClass ?? 'asset',
    normalBalance: input.normalBalance ?? 'debit',
    nativeCurrency: input.nativeCurrency ?? 'IDR',
  };
  const claimText = input.claimText ?? 'The chart proposal was checked.';
  const makerArtifacts = [{
    ...base.makerArtifacts[0]!,
    payload: MakerArtifactSchemaV1.parse({
      schemaName: 'maker-artifact',
      schemaVersion: 1,
      outputSchema: { schemaName: 'chart-work-result', schemaVersion: 1 },
      output: proposal,
      claims: [{ claimId: 'chart-proposal', text: claimText, evidenceArtifactIds: [] }],
      assumptions: [],
      uncertainty: [],
    }),
  }];
  return TeamResultEnvelopeSchemaV2.parse({
    ...base,
    status: 'partial',
    claims: [{
      claimId: 'chart-proposal',
      text: claimText,
      evidenceArtifactIds: [],
      checkedMakerArtifactIds: [artifactId],
    }],
    makerArtifacts,
    completionReason: 'The exact chart proposal passed checking.',
    effect: {
      state: 'awaiting_confirmation',
      proposal: { taskId, artifactId, artifactHash },
      command: {
        schemaName: 'checked-command',
        schemaVersion: 1,
        commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        householdId,
        taskId,
        checkedProposalId: artifactId,
        checkedProposalHash: artifactHash,
        commandType: 'apply_chart_of_accounts_change',
        idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        payloadSchema: { schemaName: 'chart-of-accounts-proposal', schemaVersion: 1 },
        payload: proposal,
      },
    },
  });
}

function persistedChartTeamResult() {
  const pending = pendingChartTeamResult();
  if (pending.effect.state !== 'awaiting_confirmation') throw new Error('Expected pending chart result');
  return TeamResultEnvelopeSchemaV2.parse({
    ...pending,
    status: 'verified',
    completionReason: 'The checked chart change was committed and read back successfully.',
    effect: {
      state: 'persisted',
      proposal: pending.effect.proposal,
      receipt: {
        schemaName: 'mutation-receipt',
        schemaVersion: 1,
        receiptId: 'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        commandId: pending.effect.command.commandId,
        householdId,
        taskId,
        checkedProposalId: artifactId,
        checkedProposalHash: artifactHash,
        commandType: pending.effect.command.commandType,
        idempotencyKey: pending.effect.command.idempotencyKey,
        committedRecords: [{
          recordType: 'accounting.account',
          recordId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        }],
        expectedState: pending.effect.command.payload,
        expectedStateHash: 'c'.repeat(64),
        committedAt: now,
      },
      readback: {
        schemaName: 'mutation-readback',
        schemaVersion: 1,
        readbackId: 'readback_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        commandId: pending.effect.command.commandId,
        receiptId: 'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        ok: true,
        checks: [{ kind: 'idempotency_receipt', status: 'passed' }],
        mismatches: [],
        observedStateHash: 'd'.repeat(64),
      },
    },
  });
}

function persistedTransactionTeamResult() {
  const persisted = persistedChartTeamResult();
  const proposal = AccountingJournalMutationProposalSchemaV1.parse({
    schemaName: 'accounting-journal-mutation-proposal',
    schemaVersion: 1,
    operation: 'post',
    draft: {
      draftSeriesId: 'draftseries_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      version: 1,
      journal: {
        schemaName: 'post-journal-proposal',
        schemaVersion: 1,
        householdId,
        bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        journalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        draftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        periodId: 'period_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        taskId,
        journalType: 'ordinary',
        transactionCurrency: 'USD',
        occurredOn: '2026-07-24',
        effectiveOn: '2026-07-24',
        description: 'Dog treats from Everyday Checking.',
        tagIds: [],
        postings: [
          {
            accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
            direction: 'debit',
            transactionAmount: '23.75',
            accountNativeAmount: '23.75',
            accountNativeCurrency: 'USD',
            tagIds: [],
          },
          {
            accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J3K',
            direction: 'credit',
            transactionAmount: '23.75',
            accountNativeAmount: '23.75',
            accountNativeCurrency: 'USD',
            tagIds: [],
          },
        ],
      },
    },
  });
  return TeamResultEnvelopeSchemaV2.parse({
    ...persisted,
    claims: [{
      claimId: 'transaction-capture-persisted',
      text: 'The checked transaction was committed and read back.',
      evidenceArtifactIds: [],
      checkedMakerArtifactIds: [artifactId],
    }],
    makerArtifacts: [{
      ...persisted.makerArtifacts[0]!,
      payload: MakerArtifactSchemaV1.parse({
        schemaName: 'maker-artifact',
        schemaVersion: 1,
        outputSchema: { schemaName: 'accounting-work-result', schemaVersion: 1 },
        output: proposal,
        claims: [{
          claimId: 'transaction-capture-persisted',
          text: 'The checked transaction was committed and read back.',
          evidenceArtifactIds: [],
        }],
        assumptions: [],
        uncertainty: [],
      }),
    }],
  });
}

const addAccountMessage = message('Add Bank ABC as an IDR asset account.');

function finalSynthesisProjectionResult(relationName = 'reporting.categorized_transactions') {
  return TeamResultEnvelopeSchemaV2.parse({
    ...teamResult(),
    claims: [
      {
        claimId: 'checking-account',
        text: 'Checking is configured for this household.',
        evidenceArtifactIds: [],
        checkedMakerArtifactIds: [artifactId],
      },
      {
        claimId: 'unsafe-claim',
        text: 'Use account_private_001 to continue.',
        evidenceArtifactIds: [],
        checkedMakerArtifactIds: [artifactId],
      },
      {
        claimId: 'unsafe-draft-claim',
        text: `Use ${draftId} to continue.`,
        evidenceArtifactIds: [],
        checkedMakerArtifactIds: [artifactId],
      },
    ],
    assumptions: [
      'Amounts are shown in USD.',
      `The household identifier is ${householdId}.`,
    ],
    uncertainty: [
      'No additional uncertainty was reported.',
      'The Book ID is internal-only.',
    ],
    outstanding: [
      'You can review the checked result.',
      'Ask for account_private_001 if clarification is needed.',
      `The checked artifact is ${artifactId}.`,
    ],
    makerArtifacts: [{
      ...teamResult().makerArtifacts[0]!,
      payload: MakerArtifactSchemaV1.parse({
        schemaName: 'maker-artifact',
        schemaVersion: 1,
        outputSchema: { schemaName: 'query-result', schemaVersion: 1 },
        output: QueryResultSchemaV1.parse({
          schemaName: 'query-result',
          schemaVersion: 1,
          relationName,
          grain: ['household', 'posting'],
          rows: [{
            account_id: 'account_private_001',
            household_id: householdId,
            effective_on: '2026-06-23',
            account_name: 'Checking',
            accounting_class: 'asset',
            account_native_amount: '420.00',
            account_native_currency: 'USD',
            description: 'Use account_private_001 to continue.',
            account_private_001: 'internal account-key payload',
            account_secret: 'internal alphabetic account-key payload',
            draft_private_001: 'internal checker payload',
            draft_secret: 'internal alphabetic draft-key payload',
          }],
          fieldDefinitions: [
            'account_id',
            'household_id',
            'effective_on',
            'account_name',
            'accounting_class',
            'account_native_amount',
            'account_native_currency',
            'description',
            'account_private_001',
            'account_secret',
            'draft_private_001',
            'draft_secret',
          ],
          sourceReferences: [
            `relation=${relationName}`,
            `filter=household_id:eq:${householdId}`,
          ],
          freshness: 'latest available reporting projection',
          coverageWarnings: [],
        }),
        claims: [{
          claimId: 'checking-account',
          text: 'Checking is configured for this household.',
          evidenceArtifactIds: [],
        }],
        assumptions: [],
        uncertainty: [],
      }),
    }],
  });
}

function categorizedTransactionResult() {
  const base = teamResult();
  return TeamResultEnvelopeSchemaV2.parse({
    ...base,
    claims: [{
      claimId: 'categorized-transactions',
      text: 'The checked query returned one categorized transaction.',
      evidenceArtifactIds: [],
      checkedMakerArtifactIds: [artifactId],
    }],
    makerArtifacts: [{
      ...base.makerArtifacts[0]!,
      payload: MakerArtifactSchemaV1.parse({
        schemaName: 'maker-artifact',
        schemaVersion: 1,
        outputSchema: { schemaName: 'query-result', schemaVersion: 1 },
        output: QueryResultSchemaV1.parse({
          schemaName: 'query-result',
          schemaVersion: 1,
          relationName: 'reporting.categorized_transactions',
          grain: ['household', 'posting'],
          rows: [
            {
              effective_on: '2026-07-24',
              account_name: 'Dog Treats',
              accounting_class: 'expense',
              direction: 'debit',
              account_native_amount: '23.750000000000',
              account_native_currency: 'USD',
              description: 'Dog treats from Everyday Checking.',
            },
            {
              effective_on: '2026-07-24',
              account_name: 'Everyday Checking',
              accounting_class: 'asset',
              direction: 'credit',
              account_native_amount: '23.750000000000',
              account_native_currency: 'USD',
              description: 'Dog treats from Everyday Checking.',
            },
          ],
          fieldDefinitions: [
            'effective_on',
            'account_name',
            'accounting_class',
            'direction',
            'account_native_amount',
            'account_native_currency',
            'description',
          ],
          sourceReferences: [
            'relation=reporting.categorized_transactions',
            `filter=household_id:eq:${householdId}`,
          ],
          freshness: 'latest available reporting projection',
          coverageWarnings: [],
        }),
        claims: [{
          claimId: 'categorized-transactions',
          text: 'The checked query returned one categorized transaction.',
          evidenceArtifactIds: [],
        }],
        assumptions: [],
        uncertainty: [],
      }),
    }],
  });
}

function emptyCurrentBalancesResult() {
  const currentBalancesArtifactId = 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1M';
  const currentBalancesArtifactHash = 'c'.repeat(64);
  const currentBalances = QueryResultSchemaV1.parse({
    schemaName: 'query-result',
    schemaVersion: 1,
    relationName: 'reporting.current_balances',
    grain: ['household', 'account'],
    rows: [],
    fieldDefinitions: ['account_id', 'native_amount'],
    sourceReferences: [
      'relation=reporting.current_balances',
      `filter=household_id:eq:${householdId}`,
    ],
    freshness: 'latest available reporting projection',
    coverageWarnings: [],
  });

  return TeamResultEnvelopeSchemaV2.parse({
    ...teamResult(),
    claims: [{
      claimId: 'current-balance-rows',
      text: 'The checked current-balance projection returned no rows.',
      evidenceArtifactIds: [],
      checkedMakerArtifactIds: [currentBalancesArtifactId],
    }],
    freshness: ['reporting.current_balances refreshed 2026-06-23T10:00:00.000Z'],
    coverage: ['balance snapshot'],
    makerArtifacts: [{
      artifactId: currentBalancesArtifactId,
      householdId,
      taskId,
      artifactType: 'maker_output',
      schema: { schemaName: 'maker-artifact', schemaVersion: 1 },
      canonicalizationVersion: 'rfc8785-v1',
      hashAlgorithm: 'sha256',
      artifactHash: currentBalancesArtifactHash,
      payload: MakerArtifactSchemaV1.parse({
        schemaName: 'maker-artifact',
        schemaVersion: 1,
        outputSchema: { schemaName: 'query-result', schemaVersion: 1 },
        output: currentBalances,
        claims: [{
          claimId: 'current-balance-rows',
          text: 'The checked current-balance projection returned no rows.',
          evidenceArtifactIds: [],
        }],
        assumptions: [],
        uncertainty: [],
      }),
      createdAt: now,
    }],
    checkerVerdicts: [{
      verdict: 'accepted',
      coveredArtifactId: currentBalancesArtifactId,
      coveredArtifactHash: currentBalancesArtifactHash,
      findings: [],
    }],
    completionReason: 'The checked current-balance projection returned no rows.',
    outstanding: [
      'The account inventory remains established separately from the current-balance projection.',
    ],
  });
}

function insufficientEvidenceResult(team: 'accounting' | 'query' = 'accounting') {
  return TeamResultEnvelopeSchemaV2.parse({
    ...teamResult(team),
    status: 'insufficient_evidence',
    claims: [],
    makerArtifacts: [{
      ...teamResult(team).makerArtifacts[0]!,
      payload: MakerArtifactSchemaV1.parse({
        schemaName: 'maker-artifact',
        schemaVersion: 1,
        outputSchema: { schemaName: 'chart-work-result', schemaVersion: 1 },
        output: {
          schemaName: 'chart-clarification',
          schemaVersion: 1,
          missingFields: ['native_currency'],
          questions: ['What is its native currency?'],
          reason: 'A safe chart-of-accounts proposal requires the unresolved user-owned fields.',
        },
        claims: [],
        assumptions: [],
        uncertainty: [],
      }),
    }],
    completionReason: 'A safe chart-of-accounts proposal requires the unresolved user-owned fields.',
    outstanding: ['What is its native currency?', 'native_currency'],
  });
}

function transactionInsufficientEvidenceResult(question = 'Which account did you pay from?') {
  const base = teamResult('accounting');
  return TeamResultEnvelopeSchemaV2.parse({
    ...base,
    status: 'insufficient_evidence',
    claims: [],
    makerArtifacts: [{
      ...base.makerArtifacts[0]!,
      payload: MakerArtifactSchemaV1.parse({
        schemaName: 'maker-artifact',
        schemaVersion: 1,
        outputSchema: { schemaName: 'accounting-work-result', schemaVersion: 1 },
        output: {
          schemaName: 'accounting-clarification',
          schemaVersion: 1,
          missingFields: ['payment_account'],
          questions: [question],
          reason: 'The transaction still needs a required accounting field.',
        },
        claims: [],
        assumptions: [],
        uncertainty: [],
      }),
    }],
    completionReason: 'The transaction still needs a required accounting field.',
    outstanding: [question],
    effect: { state: 'none' },
  });
}

function unresolvedChartTeamResult(input: Parameters<typeof pendingChartTeamResult>[0] = {}) {
  const pending = pendingChartTeamResult(input);
  if (pending.effect.state !== 'awaiting_confirmation') throw new Error('Expected pending chart result');
  return TeamResultEnvelopeSchemaV2.parse({
    ...pending,
    status: 'failed',
    claims: [],
    completionReason: 'The mutation outcome requires deterministic reconciliation.',
    outstanding: ['The category change needs reconciliation.'],
    effect: {
      state: 'unresolved',
      proposal: pending.effect.proposal,
      commandId: pending.effect.command.commandId,
      reason: 'commit_ambiguous',
    },
  });
}

function failedTeamResult() {
  return TeamResultEnvelopeSchemaV2.parse({
    ...teamResult(),
    status: 'failed',
    claims: [],
    makerArtifacts: [],
    checkerVerdicts: [],
    freshness: [],
    completionReason: 'The checker rejected the artifact or revision attempts were exhausted.',
    outstanding: ['grain mismatch'],
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

function testSessionMemory(overrides: Partial<OrchestratorSessionMemoryPort> = {}): OrchestratorSessionMemoryPort {
  return {
    agentMemory: {} as Memory,
    readWorkingMemoryPromptContext: vi.fn(async () => ({
      status: 'succeeded' as const,
      context: {
        projection: { household: [], member: [] },
        prompt: '<durable-working-memory>\n{"household": [], "member": []}\n</durable-working-memory>',
      },
      outcome: {
        operation: 'read' as const,
        status: 'succeeded' as const,
        code: 'working_memory_prompt_context_succeeded',
      },
    })),
    reviewWorkingMemory: vi.fn(async () => ({
      status: 'succeeded' as const,
      report: {
        status: 'succeeded' as const,
        revision: 'a'.repeat(64),
        reviewedAt: '2026-07-25T10:55:00.000Z' as UtcInstant,
        findings: [],
      },
      outcome: {
        operation: 'review' as const,
        status: 'succeeded' as const,
        code: 'working_memory_review_succeeded',
      },
    })),
    noteWorkingMemoryMutationSuccess: vi.fn(() => ({ reviewDue: false })),
    acknowledgeWorkingMemoryReview: vi.fn(),
    inspectWorkingMemory: vi.fn(async () => { throw new Error('Unexpected Working Memory inspection'); }),
    validateWorkingMemoryMutation: vi.fn(async () => { throw new Error('Unexpected Working Memory validation'); }),
    applyWorkingMemoryMutation: vi.fn(async () => { throw new Error('Unexpected Working Memory mutation'); }),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function singleLoopOrchestrator(input: {
  generate: (...args: unknown[]) => Promise<unknown>;
  runTeamLead: OrchestratorTeamRuntime['runTeamLead'];
  teams: readonly TeamDefinition[];
}) {
  return new OrchestratorAgent({
    model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
    agentFactory: (config) => ({ ...config, generate: input.generate }) as never,
    teams: input.teams,
    teamRuntime: testTeamRuntime(input.runTeamLead),
  });
}

function submitFinalResponse(options: unknown, body: string): Promise<Record<string, unknown>> {
  return submitOrchestratorFinalResponse(options as Record<string, unknown>, body);
}

function testTeamRuntime(runTeamLead: OrchestratorTeamRuntime['runTeamLead']): OrchestratorTeamRuntime {
  return {
    runTeamLead,
    resumePendingMutation: async () => { throw new Error('Unexpected mutation resume'); },
    cancelPendingMutation: async () => { throw new Error('Unexpected mutation cancellation'); },
  };
}

describe('OrchestratorAgent', () => {
  it('classifies pending interaction input with strict direct decisions and an isolated semantic tool', async () => {
    const generate = vi.fn(async (_prompt: unknown, options: unknown) => {
      const call = options as {
        tools: Record<string, { execute?: (input: unknown, context: unknown) => Promise<unknown> }>;
        activeTools: string[];
        toolChoice: unknown;
        prepareStep: () => Promise<{ tools: Record<string, unknown>; activeTools: string[]; toolChoice: unknown }>;
      };
      const tool = call.tools[SubmitPendingInteractionDispositionToolId];
      if (tool?.execute === undefined) throw new Error('Expected the forced disposition tool.');
      await tool.execute({ disposition: 'new_intent' }, {});
      return {};
    });
    const orchestrator = singleLoopOrchestrator({
      generate,
      runTeamLead: vi.fn(),
      teams: [queryTeam],
    });
    const pending = pendingWorkingMemory();

    await expect(orchestrator.classifyPendingWorkingMemoryInput({
      message: message('yes'),
      pending,
    })).resolves.toBe('approve');
    await expect(orchestrator.classifyPendingWorkingMemoryInput({
      message: message('go ahead'),
      pending,
    })).resolves.toBe('approve');
    await expect(orchestrator.classifyPendingWorkingMemoryInput({
      message: message('no'),
      pending,
    })).resolves.toBe('reject');
    await expect(orchestrator.classifyPendingWorkingMemoryInput({
      message: message('cancel'),
      pending,
    })).resolves.toBe('reject');
    await expect(orchestrator.classifyPendingWorkingMemoryInput({
      message: message('yes, but use USD instead'),
      pending,
    })).resolves.toBe('ambiguous');
    await expect(orchestrator.classifyPendingWorkingMemoryInput({
      message: message('Create a monthly food budget.'),
      pending,
    })).resolves.toBe('new_intent');
    await expect(orchestrator.classifyPendingWorkingMemoryInput({
      message: message('Buat anggaran makanan bulanan.'),
      pending,
    })).resolves.toBe('new_intent');

    expect(generate).toHaveBeenCalledTimes(2);
    const options = generate.mock.calls[0]?.[1] as {
      activeTools: string[];
      toolChoice: unknown;
      tools: Record<string, unknown>;
      prepareStep: () => Promise<{ tools: Record<string, unknown>; activeTools: string[]; toolChoice: unknown }>;
    };
    expect(Object.keys(options.tools)).toEqual([SubmitPendingInteractionDispositionToolId]);
    expect(options.activeTools).toEqual([SubmitPendingInteractionDispositionToolId]);
    expect(options.toolChoice).toEqual({ type: 'tool', toolName: SubmitPendingInteractionDispositionToolId });
    await expect(options.prepareStep()).resolves.toMatchObject({
      activeTools: [SubmitPendingInteractionDispositionToolId],
      toolChoice: { type: 'tool', toolName: SubmitPendingInteractionDispositionToolId },
    });
  });

  it('gives final synthesis checked proposal details and forbids past-tense persistence', async () => {
    const pending = pendingChartTeamResult({
      name: 'Bank ABC',
      accountingClass: 'asset',
      normalBalance: 'debit',
      nativeCurrency: 'IDR',
    });
    const prompts: string[] = [];
    const generate = vi.fn(async (prompt: unknown, options: unknown) => {
      prompts.push(JSON.stringify(prompt));
      if (generate.mock.calls.length === 1) {
        await executeDelegate(orchestrator.agentTools.delegateTeam, {
          team: 'accounting',
          request: {
            schemaName: 'accounting-lead-request',
            schemaVersion: 1,
            intent: 'chart_of_accounts',
            request: {
              schemaName: 'chart-work-request-draft',
              schemaVersion: 1,
              action: 'create_account',
              instruction: 'Add Bank ABC as an IDR asset account.',
              known: {
                accountName: 'Bank ABC',
                accountingClass: 'asset',
                normalBalance: 'debit',
                nativeCurrency: 'IDR',
              },
            },
          },
        });
        return submitFinalResponse(options, 'I’ll add Bank ABC as an IDR asset account with a normal debit balance. Would you like me to proceed?');
      }
      return submitFinalResponse(options, 'I’ll add Bank ABC as an IDR asset account with a normal debit balance. Would you like me to proceed?');
    });
    const orchestrator = singleLoopOrchestrator({
      generate,
      runTeamLead: vi.fn(async () => pending),
      teams: [accountingTeam],
    });

    const turn = await orchestrator.runTurn({ message: addAccountMessage });

    expect(turn.kind).toBe('ask-user');
    expect(prompts.at(-1)).toContain('Bank ABC');
    expect(generate).toHaveBeenCalledOnce();
    expect(turn.response.body).toBe(
      'I’ll add Bank ABC as an IDR asset account with a normal debit balance. Would you like me to proceed?',
    );
  });

  it('always synthesizes persisted mutations from checked facts', async () => {
    const persisted = persistedChartTeamResult();
    const generate = vi.fn(async (_prompt: unknown, options: unknown) => {
      if (generate.mock.calls.length === 1) {
        await executeDelegate(orchestrator.agentTools.delegateTeam, {
          team: 'accounting',
          request: {
            schemaName: 'accounting-lead-request',
            schemaVersion: 1,
            intent: 'chart_of_accounts',
            request: {
              schemaName: 'chart-work-request-draft',
              schemaVersion: 1,
              action: 'create_account',
              instruction: 'Add Bank ABC as an IDR asset account.',
              known: {
                accountName: 'Bank ABC',
                accountingClass: 'asset',
                normalBalance: 'debit',
                nativeCurrency: 'IDR',
              },
            },
          },
        });
        return submitFinalResponse(options, 'I added Bank ABC as an IDR asset account with a normal debit balance.');
      }
      return submitFinalResponse(options, 'I added Bank ABC as an IDR asset account with a normal debit balance.');
    });
    const orchestrator = singleLoopOrchestrator({
      generate,
      runTeamLead: vi.fn(async () => persisted),
      teams: [accountingTeam],
    });

    const response = await orchestrator.run({ message: addAccountMessage });

    expect(response.body).toBe('I added Bank ABC as an IDR asset account with a normal debit balance.');
    expect(generate).toHaveBeenCalledOnce();
  });

  it.each([
    ['yes', 'approve'],
    ['go ahead', 'approve'],
    ['yes, go ahead please', 'approve'],
    ['yes please', 'approve'],
    ['sure, please go ahead', 'approve'],
    ['do it please', 'approve'],
    ['CONFIRM', 'approve'],
    ['please do', 'approve'],
    ['sounds good', 'approve'],
    ['no, cancel it', 'reject'],
    ['please cancel', 'reject'],
    ['yes, but use USD instead', 'unclear'],
    ['what does debit mean?', 'unclear'],
  ] as const)('classifies %s as %s for a suspended proposal', (body, expected) => {
    expect(confirmationDecision(body)).toBe(expected);
  });

  it('reports readback-verified account creation after confirmation', async () => {
    const pending = pendingChartTeamResult();
    const resumePendingMutation = vi.fn(async () => persistedChartTeamResult());
    const generate = vi.fn(async (_prompt: unknown, options: unknown) =>
      submitFinalResponse(options, 'I added Bank ABC as an IDR asset account with a normal debit balance.'));
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate }) as never,
      teams: [accountingTeam],
      teamRuntime: {
        runTeamLead: vi.fn(),
        resumePendingMutation,
        cancelPendingMutation: vi.fn(),
      },
    });

    const turn = await orchestrator.resolvePendingMutation({
      message: message('yes'),
      pending,
    });

    expect(turn).toMatchObject({
      kind: 'final',
      response: {
        body: 'I added Bank ABC as an IDR asset account with a normal debit balance.',
      },
    });
    expect(resumePendingMutation).toHaveBeenCalledOnce();
  });

  it('continues the retained transaction after a confirmed new category is created', async () => {
    const pending = pendingChartTeamResult({
      name: 'Dining',
      accountingClass: 'expense',
      normalBalance: 'debit',
      nativeCurrency: 'USD',
    });
    const resumePendingMutation = vi.fn(async () => persistedChartTeamResult());
    const runTeamLead = vi.fn(async () => teamResult('accounting'));
    const generate = vi.fn(async (_prompt: unknown, options: unknown) =>
      submitFinalResponse(options, 'I created Dining and recorded the transaction.'));
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate }) as never,
      teams: [accountingTeam],
      teamRuntime: {
        runTeamLead,
        resumePendingMutation,
        cancelPendingMutation: vi.fn(),
      },
    });

    const result = await orchestrator.resolvePendingMutation({
      message: message('yes'),
      pending,
      transactionContinuation: {
        schemaName: 'transaction-capture-continuation',
        schemaVersion: 1,
        request: {
          schemaName: 'transaction-capture-request-draft',
          schemaVersion: 1,
          instruction: '50 USD yesterday in dining from test wallet',
          known: {
            amount: '50.00',
            currency: CurrencyCodeSchema.parse('USD'),
            paymentAccountName: 'test wallet',
            occurredOn: '2026-07-15',
            categoryName: 'dining',
          },
        },
      },
    });

    expect(result).toMatchObject({ kind: 'final', response: { body: 'I created Dining and recorded the transaction.' } });
    expect(resumePendingMutation).toHaveBeenCalledOnce();
    expect(runTeamLead).toHaveBeenCalledWith(expect.objectContaining({
      team: accountingTeam,
      request: expect.objectContaining({
        intent: 'transaction_capture',
        request: expect.objectContaining({
          known: expect.objectContaining({
            amount: '50.00',
            currency: 'USD',
            paymentAccountName: 'test wallet',
            occurredOn: '2026-07-15',
            categoryName: 'Dining',
          }),
        }),
      }),
    }));
  });

  it('describes a completed transaction prerequisite as a category with checked journal facts', async () => {
    const pending = pendingChartTeamResult({
      name: 'Dog Treats',
      accountingClass: 'expense',
      normalBalance: 'debit',
      nativeCurrency: 'USD',
    });
    const generate = vi.fn(async (_prompt: unknown, options: unknown) =>
      submitFinalResponse(options, 'I added Dog Treats as a new spending category and recorded USD 23.75 from Everyday Checking on 2026-07-24 under Dog Treats.'));
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate }) as never,
      teams: [accountingTeam],
      teamRuntime: {
        runTeamLead: vi.fn(async () => persistedTransactionTeamResult()),
        resumePendingMutation: vi.fn(async () => persistedChartTeamResult()),
        cancelPendingMutation: vi.fn(),
      },
    });

    const result = await orchestrator.resolvePendingMutation({
      message: message('yes'),
      pending,
      transactionContinuation: {
        schemaName: 'transaction-capture-continuation',
        schemaVersion: 1,
        request: {
          schemaName: 'transaction-capture-request-draft',
          schemaVersion: 1,
          instruction: 'Dog treats from Everyday Checking yesterday.',
          known: {
            amount: '23.75',
            currency: CurrencyCodeSchema.parse('USD'),
            paymentAccountName: 'Everyday Checking',
            occurredOn: 'yesterday',
            categoryName: 'Dog Treats',
          },
        },
      },
    });

    expect(result).toMatchObject({
      kind: 'final',
      response: {
        body: 'I added Dog Treats as a new spending category and recorded USD 23.75 from Everyday Checking on 2026-07-24 under Dog Treats.',
      },
    });
    expect(generate).toHaveBeenCalledOnce();
  });

  it('continues the retained transaction after a confirmed new income category is created', async () => {
    const pending = pendingChartTeamResult({
      name: 'Consulting Income',
      accountingClass: 'income',
      normalBalance: 'credit',
      nativeCurrency: 'USD',
    });
    const resumePendingMutation = vi.fn(async () => persistedChartTeamResult());
    const runTeamLead = vi.fn(async () => teamResult('accounting'));
    const generate = vi.fn(async (_prompt: unknown, options: unknown) =>
      submitFinalResponse(options, 'I created Consulting Income and recorded the transaction.'));
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate }) as never,
      teams: [accountingTeam],
      teamRuntime: {
        runTeamLead,
        resumePendingMutation,
        cancelPendingMutation: vi.fn(),
      },
    });

    const result = await orchestrator.resolvePendingMutation({
      message: message('yes'),
      pending,
      transactionContinuation: {
        schemaName: 'transaction-capture-continuation',
        schemaVersion: 1,
        request: {
          schemaName: 'transaction-capture-request-draft',
          schemaVersion: 1,
          instruction: 'USD 1200 yesterday as consulting income into business checking',
          known: {
            amount: '1200',
            currency: CurrencyCodeSchema.parse('USD'),
            paymentAccountName: 'Business Checking',
            occurredOn: 'yesterday',
            categoryName: 'Consulting Income',
          },
        },
      },
    });

    expect(result).toMatchObject({
      kind: 'final',
      response: { body: 'I created Consulting Income and recorded the transaction.' },
    });
    expect(resumePendingMutation).toHaveBeenCalledOnce();
    expect(runTeamLead).toHaveBeenCalledWith(expect.objectContaining({
      team: accountingTeam,
      request: expect.objectContaining({
        intent: 'transaction_capture',
        request: expect.objectContaining({
          known: expect.objectContaining({
            amount: '1200',
            currency: 'USD',
            paymentAccountName: 'Business Checking',
            occurredOn: 'yesterday',
            categoryName: 'Consulting Income',
          }),
        }),
      }),
    }));
  });

  it('does not continue the transaction when category creation is unresolved', async () => {
    const pending = pendingChartTeamResult({
      name: 'Dining',
      accountingClass: 'expense',
      normalBalance: 'debit',
      nativeCurrency: 'USD',
    });
    const resumePendingMutation = vi.fn(async () => unresolvedChartTeamResult({
      name: 'Dining',
      accountingClass: 'expense',
      normalBalance: 'debit',
      nativeCurrency: 'USD',
    }));
    const runTeamLead = vi.fn();
    const generate = vi.fn(async (_prompt: unknown, options: unknown) =>
      submitFinalResponse(options, 'The category is still unresolved, so the confirmation remains pending. Would you like me to retry?'));
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate }) as never,
      teams: [accountingTeam],
      teamRuntime: {
        runTeamLead,
        resumePendingMutation,
        cancelPendingMutation: vi.fn(),
      },
    });

    const result = await orchestrator.resolvePendingMutation({
      message: message('yes'),
      pending,
      transactionContinuation: {
        schemaName: 'transaction-capture-continuation',
        schemaVersion: 1,
        request: {
          schemaName: 'transaction-capture-request-draft',
          schemaVersion: 1,
          instruction: '50 USD yesterday in dining from test wallet',
          known: {
            amount: '50.00',
            currency: CurrencyCodeSchema.parse('USD'),
            paymentAccountName: 'test wallet',
            occurredOn: '2026-07-15',
            categoryName: 'dining',
          },
        },
      },
    });

    expect(result).toMatchObject({
      kind: 'final',
      response: { body: 'The category is still unresolved, so the confirmation remains pending. Would you like me to retry?' },
    });
    expect(resumePendingMutation).toHaveBeenCalledOnce();
    expect(runTeamLead).not.toHaveBeenCalled();
  });

  it('retains the category confirmation and transaction draft when resume throws', async () => {
    const pending = pendingChartTeamResult({
      name: 'Dining',
      accountingClass: 'expense',
      normalBalance: 'debit',
      nativeCurrency: 'USD',
    });
    const resumePendingMutation = vi.fn(async () => {
      throw new Error('journal mutation wiring is unavailable');
    });
    const continuation = {
      schemaName: 'transaction-capture-continuation' as const,
      schemaVersion: 1 as const,
      request: {
        schemaName: 'transaction-capture-request-draft' as const,
        schemaVersion: 1 as const,
        instruction: '50 USD yesterday in dining from test wallet',
        known: {
          amount: '50.00',
          currency: CurrencyCodeSchema.parse('USD'),
          paymentAccountName: 'test wallet',
          occurredOn: '2026-07-15',
          categoryName: 'dining',
        },
      },
    };
    const generate = vi.fn(async (_prompt: unknown, options: unknown) =>
      submitFinalResponse(options, 'I couldn’t complete that safely yet. I’m still waiting to add Dining as a new expense category with a normal debit balance in USD, then record USD 50.00 from test wallet dated 2026-07-15 under Dining. Would you like me to retry?'));
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate }) as never,
      teams: [accountingTeam],
      teamRuntime: {
        runTeamLead: vi.fn(),
        resumePendingMutation,
        cancelPendingMutation: vi.fn(),
      },
    });

    const result = await orchestrator.resolvePendingMutation({
      message: message('yes'),
      pending,
      transactionContinuation: continuation,
    });

    expect(result).toMatchObject({
      kind: 'ask-user',
      pendingMutation: pending,
      transactionContinuation: continuation,
      response: {
        body: 'I couldn’t complete that safely yet. I’m still waiting to add Dining as a new expense category with a normal debit balance in USD, then record USD 50.00 from test wallet dated 2026-07-15 under Dining. Would you like me to retry?',
      },
    });
    expect(resumePendingMutation).toHaveBeenCalledOnce();
  });

  it('retains the transaction continuation when the resumed transaction needs clarification', async () => {
    const pending = pendingChartTeamResult({
      name: 'Dining',
      accountingClass: 'expense',
      normalBalance: 'debit',
      nativeCurrency: 'USD',
    });
    const resumePendingMutation = vi.fn(async () => persistedChartTeamResult());
    const runTeamLead = vi.fn(async () => transactionInsufficientEvidenceResult());
    const generate = vi.fn(async (_prompt: unknown, options: unknown) =>
      submitFinalResponse(options, 'Which account did you pay from?'));
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate }) as never,
      teams: [accountingTeam],
      teamRuntime: {
        runTeamLead,
        resumePendingMutation,
        cancelPendingMutation: vi.fn(),
      },
    });

    const result = await orchestrator.resolvePendingMutation({
      message: message('yes'),
      pending,
      transactionContinuation: {
        schemaName: 'transaction-capture-continuation',
        schemaVersion: 1,
        request: {
          schemaName: 'transaction-capture-request-draft',
          schemaVersion: 1,
          instruction: '50 USD yesterday in dining from test wallet',
          known: {
            amount: '50.00',
            currency: CurrencyCodeSchema.parse('USD'),
            paymentAccountName: 'test wallet',
            occurredOn: '2026-07-15',
            categoryName: 'dining',
          },
        },
      },
    });

    expect(result).toMatchObject({
      kind: 'ask-user',
      response: { body: 'Which account did you pay from?' },
      transactionContinuation: {
        request: { known: { categoryName: 'dining' } },
      },
    });
    expect(runTeamLead).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledOnce();
  });

  it('retains the transaction continuation when category confirmation is unclear', async () => {
    const pending = pendingChartTeamResult({
      name: 'Dining',
      accountingClass: 'expense',
      normalBalance: 'debit',
      nativeCurrency: 'USD',
    });
    const resumePendingMutation = vi.fn();
    const generate = vi.fn(async (_prompt: unknown, options: unknown) =>
      submitFinalResponse(options, 'I’ll add Dining as a new expense category with a normal debit balance in USD, then record USD 50.00 from test wallet dated 2026-07-15 under Dining. Would you like me to proceed?'));
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate }) as never,
      teams: [accountingTeam],
      teamRuntime: {
        runTeamLead: vi.fn(),
        resumePendingMutation,
        cancelPendingMutation: vi.fn(),
      },
    });

    const result = await orchestrator.resolvePendingMutation({
      message: message('I am not sure'),
      pending,
      transactionContinuation: {
        schemaName: 'transaction-capture-continuation',
        schemaVersion: 1,
        request: {
          schemaName: 'transaction-capture-request-draft',
          schemaVersion: 1,
          instruction: '50 USD yesterday in dining from test wallet',
          known: {
            amount: '50.00',
            currency: CurrencyCodeSchema.parse('USD'),
            paymentAccountName: 'test wallet',
            occurredOn: '2026-07-15',
            categoryName: 'dining',
          },
        },
      },
    });

    expect(result).toMatchObject({
      kind: 'ask-user',
      pendingMutation: pending,
      response: {
        body: expect.stringContaining('then record USD 50.00 from test wallet'),
      },
      transactionContinuation: {
        request: { known: { categoryName: 'dining' } },
      },
    });
    expect(resumePendingMutation).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledOnce();
  });

  it('never exposes maker persistence claims while an effect is pending', () => {
    const view = finalSynthesisTeamResultView(pendingChartTeamResult({
      claimText: 'Bank ABC has been created successfully.',
    }));
    expect(view.checkedClaims).toEqual([]);
    expect(view.proposalFacts).toEqual([]);
    expect(view.proposedChange).toMatchObject({ accountName: 'Bank ABC' });
  });

  it('exposes checked non-persistence proposal facts while an effect is pending', () => {
    const claimText = 'Prepared a USD 50 transaction from Test Wallet on 2026-07-19 under Dining.';
    const view = finalSynthesisTeamResultView(pendingChartTeamResult({ claimText }));

    expect(view.checkedClaims).toEqual([]);
    expect(view.proposalFacts).toEqual([claimText]);
  });

  it.each(Object.values(OpaqueIdentifierDefinitions))(
    'recognizes every contract-owned opaque identifier family in user-facing safety checks',
    (definition) => {
      expect(internalIdentifierMatchCategory(
        `Internal token: ${definition.prefix}_01JNZQ4A9B8C7D6E5F4G3H2J1K`,
      )).toBe('identifier_token');
    },
  );

  it('recognizes malformed tokens with a contract-owned opaque identifier prefix', () => {
    expect(internalIdentifierMatchCategory('Internal token: draft_private_001')).toBe('identifier_token');
  });

  it('logs turn lifecycle metadata while preserving inherited request context', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'plus-one-orchestrator-'));
    const logging = configureLogging({ homeDirectory, level: 'DEBUG' });
    const inbound = message('What did we spend this month?');
    const generate = vi.fn(async (_prompt: unknown, options: Record<string, unknown> & { onStepFinish?: (step: unknown) => void }) => {
      options.onStepFinish?.({ usage: { inputTokens: 10, outputTokens: 8 }, toolCalls: [] });
      return submitFinalResponse(options, 'Private final response body');
    });
    const orchestrator = singleLoopOrchestrator({
      generate: generate as (...args: unknown[]) => Promise<unknown>,
      runTeamLead: vi.fn(),
      teams: [],
    });

    try {
      await withLogContext({ requestId: 'req_inherited' }, () => orchestrator.run({ message: inbound }));
      await logging.flush();
      const records = (await readFile(join(homeDirectory, 'logs', 'agent.log'), 'utf8'))
        .trim().split('\n')
        .map((line) => parseLogEnvelope(line))
        .filter((record): record is LogEnvelopeV1 => record !== undefined);
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({ eventName: 'turn.started', severityText: 'INFO' }),
        expect.objectContaining({ eventName: 'turn.context.prepared', severityText: 'INFO' }),
        expect.objectContaining({
          eventName: 'orchestrator.step.completed',
          severityText: 'DEBUG',
          attributes: expect.objectContaining({ 'duration.ms': expect.any(Number) }),
        }),
        expect.objectContaining({ eventName: 'turn.completed', severityText: 'INFO' }),
      ]));
      expect(records.every(({ attributes }) => (
        attributes['request.id'] === 'req_inherited'
        && attributes['plus_one.conversation.id'] === inbound.conversationId
        && attributes['plus_one.household.id'] === inbound.householdId
      ))).toBe(true);
      expect(JSON.stringify(records)).not.toContain('What did we spend this month?');
      expect(JSON.stringify(records)).not.toContain('Private final response body');
    } finally {
      await logging.close();
    }
  });

  it('logs a sanitized failed turn without serializing the thrown message', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'plus-one-orchestrator-'));
    const logging = configureLogging({ homeDirectory });
    const generate = vi.fn(async () => {
      throw new Error('Private model response should not be logged');
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead: vi.fn(), teams: [] });

    try {
      await expect(orchestrator.run({ message: message('What did we spend this month?') }))
        .rejects.toThrow('Private model response should not be logged');
      await logging.flush();
      const records = (await readFile(join(homeDirectory, 'logs', 'agent.log'), 'utf8'))
        .trim().split('\n')
        .map((line) => parseLogEnvelope(line))
        .filter((record): record is LogEnvelopeV1 => record !== undefined);
      expect(records).toContainEqual(expect.objectContaining({
        eventName: 'turn.failed',
        severityText: 'ERROR',
        attributes: expect.objectContaining({
          'failure.category': 'runtime_failure',
        }),
      }));
      expect(JSON.stringify(records)).not.toContain('Private model response should not be logged');
      expect(JSON.stringify(records)).not.toContain('What did we spend this month?');
    } finally {
      await logging.close();
    }
  });

  it('limits model construction to the top-level orchestrator agent', () => {
    const configs: Array<{
      id: string | undefined;
      inputProcessors: unknown;
      tools: unknown;
      maxRetries: number | undefined;
    }> = [];

    new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => {
        configs.push({
          id: config.id,
          inputProcessors: config.inputProcessors,
          tools: config.tools,
          maxRetries: config.maxRetries,
        });
        return { ...config, generate: vi.fn() } as never;
      },
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(vi.fn()),
    });

    expect(configs.map(({ id }) => id)).toEqual(['orchestrator']);
    expect(configs[0]).toMatchObject({ maxRetries: 0 });
    expect(configs[0]?.tools).toEqual(expect.objectContaining({ delegateTeam: expect.anything() }));
    const processors = configs[0]?.inputProcessors;
    expect(Array.isArray(processors)).toBe(true);
    if (!Array.isArray(processors)) throw new Error('Expected orchestrator input processors.');
    expect(processors).toHaveLength(1);
    expect(processors[0]).toBeInstanceOf(TokenLimiter);
    expect((processors[0] as TokenLimiter).getMaxTokens()).toBe(24_000);
  });

  it('defines account routing semantics in its instructions', () => {
    let orchestratorInstructions: string | undefined;

    new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => {
        if (typeof config.instructions !== 'string') throw new Error('Expected orchestrator instructions to be a string.');
        orchestratorInstructions = config.instructions;
        return { ...config, generate: vi.fn() } as never;
      },
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(vi.fn()),
    });

    expect(orchestratorInstructions).toContain(
      'Account existence or account inventory questions use account list coverage.',
    );
    expect(orchestratorInstructions).toContain(
      'Use balance snapshot only when the user explicitly asks for a balance, amount, value, or net worth.',
    );
    expect(orchestratorInstructions).toContain(
      'Coverage labels must be copied verbatim from the coverage map as lowercase space-separated governed strings and must never be converted to underscore aliases; use "balance snapshot", never "balance_snapshot".',
    );
    expect(orchestratorInstructions).toContain(
      'Never ask for, expose, repeat, quote, or include internal household, book, account, or system identifiers in any user-facing response; use user-visible names or safe clarifying questions instead.',
    );
    expect(orchestratorInstructions).toContain(
      'An empty reporting.current_balances result does not prove that no accounts exist.',
    );
    expect(orchestratorInstructions).toContain(
      'Do not infer entity absence from an empty metric projection.',
    );
    expect(orchestratorInstructions).toContain(
      'Account creation and chart changes always require checked specialist work; call delegateTeam instead of answering directly or collecting fields yourself.',
    );
    expect(orchestratorInstructions).toContain(
      'For account creation or chart changes, call delegateTeam with exactly {"team":"accounting","request":{"intent":"chart_of_accounts","request":{"action":"create_account","instruction":"preserve the complete user request","known":{"accountName":"visible name","accountingClass":"asset","normalBalance":"debit","nativeCurrency":"USD","purpose":"visible purpose"}}}}. Use the user-stated action and values; omit unknown known-fields.',
    );
    expect(orchestratorInstructions).toContain(
      'When the current user turn both updates a transaction draft and requests a resolvable prerequisite, you MUST execute those checked substeps in that turn without returning user-facing text between them.',
    );
    expect(orchestratorInstructions).toContain(
      'A missing-category clarification is not terminal when the current user message explicitly chose to create that category.',
    );
    expect(orchestratorInstructions).toContain(
      'For categorized transaction query rows, direction is the ledger posting direction for that exact row and account; never invert or transfer it to another account.',
    );
    expect(orchestratorInstructions).toContain(
      'If the user did not ask about ledger debit or credit direction, omit debit and credit wording from the reply.',
    );
  });

  it('passes flexible memory options and registers only the custom memory tools', async () => {
    const sessionMemory = testSessionMemory();
    let configuredMemory: unknown;
    let configuredTools: unknown;
    const generate = vi.fn(async (messages: unknown, options: unknown) => {
      expect(messages).toEqual([
        expect.objectContaining({
          role: 'system',
          content: expect.objectContaining({
            parts: expect.arrayContaining([
              expect.objectContaining({ text: expect.stringContaining(now) }),
            ]),
          }),
        }),
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({
          role: 'system',
          content: expect.objectContaining({
            parts: expect.arrayContaining([
              expect.objectContaining({ text: expect.stringContaining('<durable-working-memory>') }),
            ]),
          }),
        }),
        expect.objectContaining({ role: 'user' }),
      ]);
      expect(options).toMatchObject({
        memory: {
          thread: conversationId,
          resource: householdId,
          options: { workingMemory: { enabled: false } },
        },
        requestContext: expect.any(Object),
      });
      return submitFinalResponse(options, 'Final clean answer.');
    });
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => {
        configuredMemory = config.memory;
        configuredTools = config.tools;
        return { ...config, generate } as never;
      },
      sessionMemory,
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(vi.fn()),
    });

    await expect(orchestrator.run({ message: message('Use checking for that transfer.') }))
      .resolves.toMatchObject({ body: 'Final clean answer.' });
    expect(typeof configuredMemory).toBe('function');
    expect(Object.keys(configuredTools as Record<string, unknown>).sort()).toEqual([
      'delegateTeam',
      'inspectWorkingMemory',
      'mutateWorkingMemory',
      'proposeWorkingMemory',
      'reviewWorkingMemory',
      'viewWorkingMemory',
    ]);
    expect(sessionMemory.inspectWorkingMemory).not.toHaveBeenCalled();
  });

  it('keeps the same Agent and degrades through a typed Working Memory failure retry', async () => {
    const sessionMemory = testSessionMemory();
    const requestContexts: unknown[] = [];
    let configuredAgent: unknown;
    const generate = vi.fn(async (_prompt: unknown, options: { requestContext?: unknown }) => {
      requestContexts.push(options.requestContext);
      if (generate.mock.calls.length === 1) {
        throw new PlusOneError({
          category: 'storage_unavailable',
          code: 'working_memory_read_failed',
          message: 'Working Memory operation failed.',
          retry: 'after_backoff',
          receiptLookupRequired: false,
        });
      }
      return submitFinalResponse(options, 'I could not use saved context, so I continued without it.');
    });
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => {
        configuredAgent = { ...config, generate };
        return configuredAgent as never;
      },
      sessionMemory,
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(vi.fn()),
    });

    await expect(orchestrator.run({ message: message('What do you remember about me?') }))
      .resolves.toMatchObject({ body: 'I could not use saved context, so I continued without it.' });

    expect(configuredAgent).toBe(orchestrator.agent);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(requestContexts[0]).toBe(requestContexts[1]);
    expect((requestContexts[1] as { get(key: string): unknown }).get('plus-one.orchestrator'))
      .toMatchObject({ memoryDegraded: true });
  });

  it('retries Mastra memory input-processor failures through degraded memory', async () => {
    const requestContexts: unknown[] = [];
    const generate = vi.fn(async (_prompt: unknown, options: { requestContext?: unknown }) => {
      requestContexts.push(options.requestContext);
      if (generate.mock.calls.length === 1) throw new Error('Input processor error');
      return submitFinalResponse(options, 'I continued without unavailable saved context.');
    });
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate }) as never,
      sessionMemory: testSessionMemory(),
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(vi.fn()),
    });

    await expect(orchestrator.run({ message: message('What do you remember about me?') }))
      .resolves.toMatchObject({ body: 'I continued without unavailable saved context.' });
    expect(generate).toHaveBeenCalledTimes(2);
    expect((requestContexts[1] as { get(key: string): unknown }).get('plus-one.orchestrator'))
      .toMatchObject({ memoryDegraded: true });
  });

  it('does not preflight Working Memory for an ordinary turn', async () => {
    const sessionMemory = testSessionMemory();
    let requestState: unknown;
    const generate = vi.fn(async (_prompt: unknown, options: { requestContext: { get(key: string): unknown } }) => {
      requestState = options.requestContext.get('plus-one.orchestrator');
      return submitFinalResponse(options, 'I could not access saved context right now, but I can still help with this request.');
    });
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate }) as never,
      sessionMemory,
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(vi.fn()),
    });

    await expect(orchestrator.run({ message: message('What do you remember about me?') }))
      .resolves.toMatchObject({ body: 'I could not access saved context right now, but I can still help with this request.' });
    expect(generate).toHaveBeenCalledOnce();
    expect(requestState).toMatchObject({ memoryDegraded: false, memoryFailures: [] });
    expect(sessionMemory.inspectWorkingMemory).not.toHaveBeenCalled();
  });

  it('degrades safely when the authorized prompt projection read fails', async () => {
    const sessionMemory = testSessionMemory({
      readWorkingMemoryPromptContext: vi.fn(async () => ({
        status: 'failed' as const,
        outcome: {
          operation: 'read' as const,
          status: 'failed' as const,
          code: 'working_memory_read_failed',
          category: 'storage_unavailable' as const,
          retry: 'after_backoff' as const,
        },
        error: new PlusOneError({
          category: 'storage_unavailable',
          code: 'working_memory_read_failed',
          message: 'Working Memory operation failed.',
          retry: 'after_backoff',
          receiptLookupRequired: false,
        }),
      })),
    });
    let prompt: unknown;
    let requestState: unknown;
    const generate = vi.fn(async (value: unknown, options: { requestContext: { get(key: string): unknown } }) => {
      prompt = value;
      requestState = options.requestContext.get('plus-one.orchestrator');
      return submitFinalResponse(options, 'I continued without unavailable saved context.');
    });
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate }) as never,
      sessionMemory,
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(vi.fn()),
    });

    await expect(orchestrator.run({ message: message('What do you remember about me?') }))
      .resolves.toMatchObject({ body: 'I continued without unavailable saved context.' });
    expect(JSON.stringify(prompt)).not.toContain('<durable-working-memory>');
    expect(requestState).toMatchObject({
      memoryDegraded: true,
      memoryFailures: [expect.objectContaining({ operation: 'read', code: 'working_memory_read_failed' })],
    });
  });

  it('does not register native Working Memory hooks or forgetEverything', async () => {
    const sessionMemory = testSessionMemory();
    let config: Record<string, unknown> | undefined;
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (agentConfig) => {
        config = agentConfig as unknown as Record<string, unknown>;
        return { ...agentConfig, generate: vi.fn(async (_prompt: unknown, options: unknown) => submitFinalResponse(options, 'Ready.')) } as never;
      },
      sessionMemory,
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(vi.fn()),
    });

    expect(config?.hooks).toBeUndefined();
    expect(config?.tools).toEqual(expect.not.objectContaining({
      forgetEverything: expect.anything(),
      updateWorkingMemory: expect.anything(),
    }));
    expect(orchestrator.agentTools.inspectWorkingMemory).toBeDefined();
    expect(orchestrator.agentTools.mutateWorkingMemory).toBeDefined();
  });

  it('records a custom Working Memory inspection failure and prevents a success claim', async () => {
    const sessionMemory = testSessionMemory({
      inspectWorkingMemory: vi.fn(async () => ({
        status: 'failed' as const,
        outcome: {
          operation: 'inspect' as const,
          status: 'failed' as const,
          code: 'working_memory_read_failed',
          category: 'storage_unavailable' as const,
          retry: 'after_backoff' as const,
        },
        error: new PlusOneError({
          category: 'storage_unavailable',
          code: 'working_memory_read_failed',
          message: 'Working Memory operation failed.',
          retry: 'after_backoff',
          receiptLookupRequired: false,
        }),
      })),
    });
    let requestState: unknown;
    const generate = vi.fn(async (_prompt: unknown, options: { requestContext: { get(key: string): unknown } }) => {
      const tool = orchestrator.agentTools.inspectWorkingMemory;
      if (tool === undefined) throw new Error('Expected inspectWorkingMemory tool.');
      await (tool.execute as unknown as (input: unknown, context: unknown) => Promise<unknown>)({}, {});
      requestState = options.requestContext.get('plus-one.orchestrator');
      return submitFinalResponse(options, 'I could not access saved context, so I continued without it.');
    });
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate }) as never,
      sessionMemory,
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(vi.fn()),
    });

    await expect(orchestrator.run({ message: message('What do you remember about me?') }))
      .resolves.toMatchObject({ body: 'I could not access saved context, so I continued without it.' });
    expect(requestState).toMatchObject({
      memoryDegraded: true,
      memoryFailures: [expect.objectContaining({
        operation: 'inspect',
        code: 'working_memory_read_failed',
        category: 'storage_unavailable',
      })],
    });
  });

  it('accepts a direct create only after the custom adapter reports verified success', async () => {
    const document = workingMemoryDocument();
    const inspection = workingMemoryInspection(document);
    const applyWorkingMemoryMutation = vi.fn(async () => ({
      status: 'succeeded' as const,
      operation: 'create' as const,
      code: 'working_memory_mutation_succeeded' as const,
      document,
      outcome: {
        operation: 'mutate' as const,
        status: 'succeeded' as const,
        code: 'working_memory_mutation_succeeded',
      },
    }));
    const sessionMemory = testSessionMemory({
      inspectWorkingMemory: vi.fn(async () => ({
        status: 'succeeded' as const,
        document,
        inspection,
        outcome: {
          operation: 'inspect' as const,
          status: 'succeeded' as const,
          code: 'working_memory_inspection_succeeded',
        },
      })),
      applyWorkingMemoryMutation,
    });
    const generate = vi.fn(async (_prompt: unknown, options: unknown) => {
      await executeMemoryTool(orchestrator.agentTools.inspectWorkingMemory);
      await executeMemoryTool(orchestrator.agentTools.mutateWorkingMemory, {
        operation: 'create',
        basedOnRevision: inspection.revision,
        kind: 'goal',
        summary: 'Buy a BMW X5.',
        scope: 'household',
        value: { goal: 'BMW X5', timeframe: 'next year' },
      });
      return submitFinalResponse(options, 'I saved that goal.');
    });
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate }) as never,
      sessionMemory,
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(vi.fn()),
    });

    await expect(orchestrator.run({ message: message('Remember that I want to buy a BMW X5 next year.') }))
      .resolves.toMatchObject({ body: 'I saved that goal.' });
    expect(applyWorkingMemoryMutation).toHaveBeenCalledOnce();
  });

  it('returns a same-agent confirmation preview without exposing proposal internals', async () => {
    const document = workingMemoryDocument(true);
    const inspection = workingMemoryInspection(document);
    const recordValidatedMutation = vi.fn();
    const sessionMemory = testSessionMemory({
      inspectWorkingMemory: vi.fn(async () => ({
        status: 'succeeded' as const,
        document,
        inspection,
        outcome: {
          operation: 'inspect' as const,
          status: 'succeeded' as const,
          code: 'working_memory_inspection_succeeded',
        },
      })),
      validateWorkingMemoryMutation: vi.fn(async () => {
        recordValidatedMutation();
        return {
          status: 'succeeded' as const,
          operation: 'create' as const,
          code: 'working_memory_mutation_validated' as const,
          document,
          outcome: {
            operation: 'validate' as const,
            status: 'succeeded' as const,
            code: 'working_memory_mutation_validated',
          },
        };
      }),
    });
    const generate = vi.fn(async (_prompt: unknown, options: unknown) => {
      if (generate.mock.calls.length === 1) {
        await executeMemoryTool(orchestrator.agentTools.inspectWorkingMemory);
        await executeMemoryTool(orchestrator.agentTools.mutateWorkingMemory, {
          operation: 'create',
          basedOnRevision: inspection.revision,
          kind: 'goal',
          summary: 'A second goal.',
          scope: 'household',
          value: { goal: 'A second goal' },
        });
        return submitFinalResponse(options, 'I prepared the proposed change.');
      }
      return submitFinalResponse(options, 'I can remember that goal, but would you like me to save it?');
    });
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate }) as never,
      sessionMemory,
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(vi.fn()),
    });

    const result = await orchestrator.runTurn({ message: message('Remember another goal.') });

    expect(result.kind).toBe('ask-user');
    expect(result).toMatchObject({
      pendingWorkingMemoryMutation: expect.objectContaining({
        householdId,
        conversationId,
        mutation: expect.objectContaining({ operation: 'create' }),
      }),
    });
    expect(recordValidatedMutation).toHaveBeenCalledOnce();
    expect(result.response.body).toContain('?');
    expect(result.response.body).not.toContain(workingMemoryProposalId);
    expect(result.response.body).not.toContain('wme_');
    expect(result.response.body).not.toContain('revision');
  });

  it('returns typed Working Memory resolution statuses for approval, rejection, expiry, stale approval, and unclear feedback', async () => {
    const scenarios = [
      { name: 'approval', body: 'yes', decision: 'approve' as const, text: 'The goal is now in place.', expectedStatus: 'applied', applyCode: undefined, expired: false },
      { name: 'rejection', body: 'no', decision: 'reject' as const, text: 'No changes were made.', expectedStatus: 'rejected', applyCode: undefined, expired: false },
      { name: 'expiry', body: 'yes', decision: 'approve' as const, text: 'That approval expired, so the change was not completed.', expectedStatus: 'expired', applyCode: undefined, expired: true },
      { name: 'stale approval', body: 'yes', decision: 'approve' as const, text: 'The change was not completed because the context changed. Please ask me to review it again.', expectedStatus: 'stale', applyCode: 'working_memory_revision_stale', expired: false },
      { name: 'unclear', body: 'maybe', decision: 'ambiguous' as const, text: 'I am ready to make that change. Would you like me to approve it?', expectedStatus: 'pending', applyCode: undefined, expired: false },
    ] as const;

    for (const scenario of scenarios) {
      const applyWorkingMemoryMutation = vi.fn(async () => scenario.applyCode === undefined
        ? {
            status: 'succeeded' as const,
            operation: 'replace' as const,
            code: 'working_memory_mutation_succeeded' as const,
            document: workingMemoryDocument(true),
            outcome: { operation: 'mutate' as const, status: 'succeeded' as const, code: 'working_memory_mutation_succeeded' },
          }
        : {
            status: 'failed' as const,
            operation: 'replace' as const,
            code: scenario.applyCode,
            category: 'serialization_conflict' as const,
            retry: 'after_state_resolution' as const,
            outcome: { operation: 'mutate' as const, status: 'failed' as const, code: scenario.applyCode },
          });
      const orchestrator = new OrchestratorAgent({
        model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
        agentFactory: (config) => ({
          ...config,
          generate: vi.fn(async (_prompt: unknown, options: unknown) => submitFinalResponse(options, scenario.text)),
        }) as never,
        sessionMemory: testSessionMemory({ applyWorkingMemoryMutation }),
        teams: [queryTeam],
        teamRuntime: testTeamRuntime(vi.fn()),
      });
      const pending = scenario.expired
        ? pendingWorkingMemory({
            createdAt: new Date(Date.now() - 11 * 60_000).toISOString(),
            expiresAt: new Date(Date.now() - 1_000).toISOString(),
          })
        : pendingWorkingMemory();

      const result = await orchestrator.resolvePendingWorkingMemoryMutation({
        message: message(scenario.body),
        pending,
        decision: scenario.decision,
      });

      expect(result.status, scenario.name).toBe(scenario.expectedStatus);
      expect(result.response.body, scenario.name).toBe(scenario.text);
      if (scenario.name === 'approval' || scenario.name === 'stale approval') {
        expect(applyWorkingMemoryMutation).toHaveBeenCalledOnce();
      } else {
        expect(applyWorkingMemoryMutation).not.toHaveBeenCalled();
      }
    }

    const unavailableOrchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({
        ...config,
        generate: vi.fn(async (_prompt: unknown, options: unknown) => submitFinalResponse(options, 'The change could not be stored.')),
      }) as never,
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(vi.fn()),
    });
    const unavailable = await unavailableOrchestrator.resolvePendingWorkingMemoryMutation({
      message: message('yes'),
      pending: pendingWorkingMemory(),
      decision: 'approve',
    });
    expect(unavailable).toMatchObject({ status: 'failed', code: 'working_memory_storage_unavailable' });
    expect(unavailable.response.body).toBe('The change could not be stored.');
  });

  it('raises a typed error when Working Memory synthesis never submits a response', async () => {
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate: vi.fn(async () => rawOrchestratorTextLeak('')) }) as never,
      sessionMemory: testSessionMemory({
        applyWorkingMemoryMutation: vi.fn(async () => ({
          status: 'succeeded' as const,
          operation: 'replace' as const,
          code: 'working_memory_mutation_succeeded' as const,
          document: workingMemoryDocument(true),
          outcome: { operation: 'mutate' as const, status: 'succeeded' as const, code: 'working_memory_mutation_succeeded' },
        })),
      }),
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(vi.fn()),
    });

    await expect(orchestrator.resolvePendingWorkingMemoryMutation({
      message: message('yes'),
      pending: pendingWorkingMemory(),
      decision: 'approve',
    })).rejects.toMatchObject({ code: 'orchestrator_response_not_submitted' });
  });

  it('keeps the full checked team result for citations while exposing only a safe final-synthesis view to the model', async () => {
    const result = finalSynthesisProjectionResult();
    let delegated: TeamResultEnvelopeV2 | undefined;
    let modelOutput: unknown;
    const generate = vi.fn(async (_prompt: unknown, options: unknown) => {
      delegated = await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('Show our recent transactions.', { coverage: ['categorized transactions'] }),
      });
      const toModelOutput = orchestrator.agentTools.delegateTeam.toModelOutput;
      if (toModelOutput !== undefined) modelOutput = toModelOutput(delegated);
      return submitFinalResponse(options, 'Checking is configured for this household.');
    });
    const orchestrator = singleLoopOrchestrator({
      generate,
      runTeamLead: vi.fn(async () => result),
      teams: [queryTeam],
    });

    const response = await orchestrator.run({ message: message('Show our recent transactions.') });

    expect(delegated).toMatchObject({
      householdId,
      taskId,
      makerArtifacts: [expect.objectContaining({
        artifactId,
        artifactHash,
        payload: expect.objectContaining({
          output: expect.objectContaining({
            rows: [expect.objectContaining({ account_id: 'account_private_001' })],
          }),
        }),
      })],
    });
    expect(response.citations).toEqual(expect.arrayContaining([
      { label: 'query:checking-account', artifactId },
      { label: 'query:unsafe-claim', artifactId },
    ]));
    expect(typeof orchestrator.agentTools.delegateTeam.toModelOutput).toBe('function');
    expect(modelOutput).toMatchObject({
      type: 'json',
      value: {
        schemaName: 'final-synthesis-team-result',
        schemaVersion: 1,
        team: 'query',
        status: 'verified',
        checkedClaims: expect.arrayContaining([
          'Checking is configured for this household.',
          'Some checked details were withheld for privacy.',
        ]),
        assumptions: expect.arrayContaining(['Amounts are shown in USD.']),
        uncertainty: expect.arrayContaining(['No additional uncertainty was reported.']),
        outstanding: expect.arrayContaining(['You can review the checked result.']),
        checkedData: [{
          checkedClaim: 'Checking is configured for this household.',
          rows: [{
            'effective on': '2026-06-23',
            'account name': 'Checking',
            'accounting class': 'asset',
            'account native amount': '420.00',
            'account native currency': 'USD',
            description: 'Some checked details were withheld for privacy.',
          }],
        }],
      },
    });
    const serializedView = JSON.stringify(modelOutput);
    expect(serializedView.includes(householdId)).toBe(false);
    expect(serializedView.includes(taskId)).toBe(false);
    expect(serializedView.includes(artifactId)).toBe(false);
    expect(serializedView.includes(artifactHash)).toBe(false);
    expect(serializedView.includes(draftId)).toBe(false);
    expect(serializedView.includes('draft_private_001')).toBe(false);
    expect(serializedView.includes('internal checker payload')).toBe(false);
    expect(serializedView.includes('account_private_001')).toBe(false);
    expect(serializedView.includes('internal account-key payload')).toBe(false);
    expect(serializedView.includes('account_secret')).toBe(false);
    expect(serializedView.includes('internal alphabetic account-key payload')).toBe(false);
    expect(serializedView.includes('draft_secret')).toBe(false);
    expect(serializedView.includes('internal alphabetic draft-key payload')).toBe(false);
    expect(serializedView.includes('account_id')).toBe(false);
    expect(serializedView.includes('household_id')).toBe(false);
    expect(serializedView.includes('reporting.categorized_transactions')).toBe(false);
    expect(serializedView.includes('single-maker-checker')).toBe(false);
    expect(serializedView.includes('query-evidence')).toBe(false);
    expect(serializedView.includes('query-answer')).toBe(false);
    expect(serializedView.includes('Ready for orchestrator reconciliation.')).toBe(false);
  });

  it('replaces stale mutation and inverted-direction query prose with checked transaction facts', async () => {
    const result = categorizedTransactionResult();
    const generate = vi.fn(async (_prompt: unknown, options: unknown) => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('Show the Dog Treats transaction.', { coverage: ['categorized transactions'] }),
      });
      return submitFinalResponse(options, 'I found a USD 23.75 transaction on 2026-07-24 under Dog Treats, using Everyday Checking.');
    });
    const orchestrator = singleLoopOrchestrator({
      generate,
      runTeamLead: vi.fn(async () => result),
      teams: [queryTeam],
    });

    const response = await orchestrator.run({ message: message('Show the Dog Treats transaction.') });

    expect(response.body).toBe(
      'I found a USD 23.75 transaction on 2026-07-24 under Dog Treats, using Everyday Checking.',
    );
  });

  it('does not grant categorized transaction field capability to another reporting relation', () => {
    const orchestrator = singleLoopOrchestrator({
      generate: vi.fn(async (_prompt: unknown, options: unknown) => submitFinalResponse(options, 'Unused.')),
      runTeamLead: vi.fn(),
      teams: [queryTeam],
    });
    const toModelOutput = orchestrator.agentTools.delegateTeam.toModelOutput;
    if (toModelOutput === undefined) throw new Error('Expected delegateTeam to provide model output.');

    const modelOutput = toModelOutput(finalSynthesisProjectionResult('reporting.accounts'));
    const serializedView = JSON.stringify(modelOutput);

    expect(serializedView.includes('account_name')).toBe(false);
    expect(serializedView.includes('account_native_amount')).toBe(false);
    expect(serializedView.includes('account_native_currency')).toBe(false);
    expect(serializedView.includes('draft_secret')).toBe(false);
    expect(serializedView.includes('account_secret')).toBe(false);
  });

  it('rejects malformed delegate input without consuming delegation', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async (_prompt: unknown, rawOptions: unknown) => {
      const options = rawOptions as {
        prepareStep(): Promise<{ activeTools: string[]; toolChoice: string }> | { activeTools: string[]; toolChoice: string };
      };
      const execute = orchestrator.agentTools.delegateTeam.execute as unknown as
        (input: unknown, options: unknown) => Promise<unknown>;
      await expect(execute({ team: 'query', request: 'account_private_001' }, {}))
        .rejects.toThrow('Query request must contain businessQuestion');
      await expect(options.prepareStep()).resolves.toMatchObject({
        activeTools: ['delegateTeam', 'submitFinalResponse'],
        toolChoice: 'auto',
      });
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.', { coverage: ['account list'] }),
      });
      await expect(options.prepareStep()).resolves.toMatchObject({
        activeTools: ['delegateTeam', 'submitFinalResponse'],
        toolChoice: 'auto',
      });
      return submitFinalResponse(options, 'The checked evidence includes one account row.');
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('List our accounts.') }))
      .resolves.toMatchObject({ body: 'The checked evidence includes one account row.' });

    expect(runTeamLead).toHaveBeenCalledOnce();
  });

  it('uses a real Mastra step sequence to retry invalid delegation before final synthesis', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const modelCalls: unknown[] = [];
    const modelSteps = [
      {
        finishReason: 'tool-calls' as const,
        content: [{
          type: 'tool-call' as const,
          toolCallId: 'invalid-delegation',
          toolName: 'delegateTeam',
          input: JSON.stringify({ team: 'query', request: draftId }),
        }],
      },
      {
        finishReason: 'tool-calls' as const,
        content: [{
          type: 'tool-call' as const,
          toolCallId: 'valid-delegation',
          toolName: 'delegateTeam',
          input: JSON.stringify({
            team: 'query',
            request: queryDraft('List our accounts.', { coverage: ['account list'] }),
          }),
        }],
      },
      {
        finishReason: 'stop' as const,
        content: [{ type: 'text' as const, text: 'Final synthesis after corrected delegation.' }],
      },
    ];
    const scriptedModel = {
      specificationVersion: 'v2' as const,
      provider: 'test',
      modelId: 'orchestrator-step-sequence',
      supportedUrls: {},
      doGenerate: vi.fn(async (options: unknown) => {
        modelCalls.push(options);
        const next = modelSteps.shift();
        if (next === undefined) throw new Error('Model received more steps than the test script permits.');
        return {
          ...next,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      }),
      doStream: async () => {
        throw new Error('The orchestrator test uses non-streaming generation.');
      },
    };
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => new Agent({ ...config, model: scriptedModel as never }),
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(runTeamLead),
    });

    const response = await orchestrator.run({ message: message('List our accounts.') });

    expect(response.body).toBe('Final synthesis after corrected delegation.');
    expect(response.body).not.toContain('The checked evidence includes one account row.');
    expect(scriptedModel.doGenerate).toHaveBeenCalledTimes(3);
    expect(modelCalls).toHaveLength(3);
  });

  it('passes the inbound timestamp and user body into a non-memory model prompt', async () => {
    const body = 'What are the balances in my accounts?';
    let prompt: unknown;
    const generate = vi.fn(async (value: unknown, options: unknown) => {
      prompt = value;
      return submitFinalResponse(options, 'I will check the balances.');
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead: vi.fn(), teams: [queryTeam] });

    await orchestrator.run({ message: message(body) });

    expect(typeof prompt === 'string').toBe(true);
    if (typeof prompt !== 'string') throw new Error('Expected a text-only prompt.');
    expect(prompt).toContain(body);
    expect(prompt).toContain(now);
    expect(prompt).toContain('preserve the user’s relative wording');
    expect(prompt.includes(householdId)).toBe(false);
    expect(prompt.includes(conversationId)).toBe(false);
    expect(prompt.includes('telegram-chat-42')).toBe(false);
  });

  it('does not log an unsafe submitted body', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'plus-one-orchestrator-'));
    const logging = configureLogging({ homeDirectory });
    const generate = vi.fn(async (_prompt: unknown, options: unknown) =>
      submitFinalResponse(options, 'Please use account_private_001 to continue.'));
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead: vi.fn(), teams: [queryTeam] });

    try {
      await expect(orchestrator.run({ message: message('Can you help?') }))
        .rejects.toMatchObject({ code: 'orchestrator_response_rejected' });
      await logging.flush();
      const records = (await readFile(join(homeDirectory, 'logs', 'agent.log'), 'utf8'))
        .trim().split('\n')
        .map((line) => parseLogEnvelope(line))
        .filter((record): record is LogEnvelopeV1 => record !== undefined);
      expect(records).toContainEqual(expect.objectContaining({
        eventName: 'turn.failed',
        severityText: 'ERROR',
      }));
      expect(JSON.stringify(records)).not.toContain('account_private_001');
    } finally {
      await logging.close();
    }
  });

  it('keeps checked account-list evidence separate from an empty current-balance projection during deterministic synthesis', async () => {
    let orchestratorInstructions: string | undefined;
    const sessionMemory = testSessionMemory();
    const currentBalancesResult = emptyCurrentBalancesResult();
    const runTeamLead = vi.fn(async () => currentBalancesResult);
    const generate = vi.fn(async (messages: unknown, options: unknown) => {
      expect(messages).toEqual([
        expect.objectContaining({
          role: 'system',
          content: expect.objectContaining({
            parts: expect.arrayContaining([
              expect.objectContaining({ text: expect.stringContaining(now) }),
            ]),
          }),
        }),
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({
          role: 'system',
          content: expect.objectContaining({
            parts: expect.arrayContaining([
              expect.objectContaining({ text: expect.stringContaining('<durable-working-memory>') }),
            ]),
          }),
        }),
        expect.objectContaining({ role: 'user' }),
      ]);
      const delegated = await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('What are the balances in my accounts?', {
          desiredGrain: ['household', 'account'],
          coverage: ['balance snapshot'],
        }),
      });
      expect(delegated.makerArtifacts[0]?.payload).toMatchObject({
        output: { relationName: 'reporting.current_balances', rows: [] },
      });
      return submitFinalResponse(options, 'No current-balance rows were returned.');
    });
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => {
        if (typeof config.instructions !== 'string') throw new Error('Expected orchestrator instructions to be a string.');
        orchestratorInstructions = config.instructions;
        return { ...config, generate } as never;
      },
      sessionMemory,
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(runTeamLead),
    });

    const response = await orchestrator.run({ message: message('What are the balances in my accounts?') });

    expect(orchestratorInstructions).toContain(
      'An empty reporting.current_balances result does not prove that no accounts exist.',
    );
    expect(orchestratorInstructions).toContain(
      'Do not infer entity absence from an empty metric projection. State only that the requested metric projection returned no rows.',
    );
    expect(orchestratorInstructions).toContain(
      'Only reporting.accounts account-list evidence may support a claim that no accounts are configured.',
    );
    expect(runTeamLead).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ coverage: ['balance snapshot'] }),
    }));
    expect(response.body).not.toMatch(/no accounts|no accounts set up|do not have accounts/i);
    expect(response.body).toBe('No current-balance rows were returned.');
  });

  it('allows six semantic model steps for validation recovery and sequential checked substeps', async () => {
    const generate = vi.fn(async (_prompt: unknown, rawOptions: unknown) => {
      const options = rawOptions as Record<string, unknown>;
      const stopWhen = options.stopWhen as (input: { steps: Array<{ finishReason?: string }> }) => boolean;
      expect(stopWhen({ steps: [{ finishReason: 'retry' }, { finishReason: 'tool-calls' }] })).toBe(false);
      expect(stopWhen({ steps: [{ finishReason: 'tool-calls' }, { finishReason: 'stop' }] })).toBe(false);
      expect(stopWhen({ steps: [
        { finishReason: 'tool-calls' },
        { finishReason: 'tool-calls' },
        { finishReason: 'stop' },
      ] })).toBe(false);
      expect(stopWhen({ steps: [
        { finishReason: 'tool-calls' },
        { finishReason: 'tool-calls' },
        { finishReason: 'tool-calls' },
        { finishReason: 'stop' },
      ] })).toBe(false);
      expect(stopWhen({ steps: [
        { finishReason: 'tool-calls' },
        { finishReason: 'tool-calls' },
        { finishReason: 'tool-calls' },
        { finishReason: 'tool-calls' },
        { finishReason: 'tool-calls' },
        { finishReason: 'stop' },
      ] })).toBe(true);
      return submitFinalResponse(options, 'Plus One can help with household finance questions.');
    });
    const configs: Array<{ id?: string; tools?: unknown }> = [];
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => {
        configs.push(config);
        return { ...config, generate } as never;
      },
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(vi.fn()),
    });
    const signal = AbortSignal.timeout(1_000);

    await expect(orchestrator.run({ message: message('hi'), signal }))
      .resolves.toMatchObject({ body: 'Plus One can help with household finance questions.' });
    expect(configs.map(({ id }) => id)).toEqual(['orchestrator']);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      stopWhen: expect.any(Function),
      maxProcessorRetries: 2,
      errorProcessors: [expect.anything()],
      toolChoice: 'auto',
      abortSignal: signal,
    }));
    const [, options] = generate.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(options).not.toHaveProperty('structuredOutput');
    expect(options).not.toHaveProperty('maxRetries');
    expect(options).not.toHaveProperty('maxSteps');
  });

  it('lets the single orchestrator generation delegate once and return checked reply text', async () => {
    const runTeamLead = vi.fn(async (input: Parameters<OrchestratorTeamRuntime['runTeamLead']>[0]) => {
      void input;
      return teamResult();
    });
    const generate = vi.fn(async (_prompt: unknown, options: unknown) => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.', {
          desiredGrain: ['household', 'account'],
          coverage: ['account list'],
        }),
      });
      return submitFinalResponse(options, 'The checked evidence includes one account row.');
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    const response = await orchestrator.run({ message: message('List our accounts.') });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(runTeamLead).toHaveBeenCalledTimes(1);
    expect(response.citations).toEqual([{ label: 'query:accounts-listed', artifactId }]);
  });

  it('sends an application-authored delegation bubble and returns only the submitted reply', async () => {
    const channelEvents = { emit: vi.fn(async (event: unknown) => { void event; }) };
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async (_prompt: unknown, options: unknown) => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.', {
          desiredGrain: ['household', 'account'],
          coverage: ['account list'],
        }),
      });
      return submitFinalResponse(options, 'The checked evidence includes one account row.');
    });
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate }) as never,
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(runTeamLead),
      channelEvents,
    });

    await expect(orchestrator.run({ message: message('List our accounts.') }))
      .resolves.toMatchObject({ body: 'The checked evidence includes one account row.' });

    const emitted = channelEvents.emit.mock.calls.map(([event]) => event);
    expect(emitted.slice(0, 2)).toEqual([
      expect.objectContaining({
        kind: 'assistant.commentary',
        body: "I'll check your household accounts.",
      }),
      expect.objectContaining({ kind: 'tool.started', toolName: 'delegateTeam' }),
    ]);
    expect(emitted).not.toContainEqual(
      expect.objectContaining({ body: 'Let me check your household accounts for you!' }),
    );
  });

  it('does not expose delegation commentary as the final response', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async (_prompt: unknown, options: unknown) => {
        await executeDelegate(orchestrator.agentTools.delegateTeam, {
          team: 'query', request: queryDraft('List our accounts.', { coverage: ['account list'] }),
        });
        return submitFinalResponse(options, 'I found one account in your household records.');
      });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    const response = await orchestrator.run({ message: message('List our accounts.') });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(response.body).toBe('I found one account in your household records.');
    expect(response.body).not.toContain('Preamble that must never be a final response.');
    expect(response.body).not.toMatch(/reporting\.|QueryResultV1|checker|maker|team status|native_currency/i);
  });

  it('uses the submitted body for a direct answer', async () => {
    const generate = vi.fn(async (_prompt: unknown, options: unknown) =>
      submitFinalResponse(options, 'Final direct answer.'));
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead: vi.fn(), teams: [] });

    await expect(orchestrator.run({ message: message('hi') }))
      .resolves.toMatchObject({ body: 'Final direct answer.' });
  });

  it('keeps delegateTeam available after a checked result so the model can finish or take another checked substep', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async (_prompt: unknown, rawOptions: unknown) => {
      const options = rawOptions as {
        prepareStep(): Promise<{ activeTools: string[]; toolChoice: string }> | { activeTools: string[]; toolChoice: string };
      };
      await expect(options.prepareStep()).resolves.toMatchObject({
        activeTools: ['delegateTeam', 'submitFinalResponse'],
        toolChoice: 'auto',
      });
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.'),
      });
      await expect(options.prepareStep()).resolves.toMatchObject({
        activeTools: ['delegateTeam', 'submitFinalResponse'],
        toolChoice: 'auto',
      });
      return submitFinalResponse(rawOptions, 'The checked evidence includes one account row.');
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('List our accounts.') }))
      .resolves.toMatchObject({ body: 'The checked evidence includes one account row.' });
  });

  it('logs specialist completion timing without response content', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'plus-one-orchestrator-'));
    const logging = configureLogging({ homeDirectory });
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async (_prompt: unknown, options: unknown) => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.'),
      });
      return submitFinalResponse(options, 'Private checked answer body.');
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    try {
      await orchestrator.run({ message: message('List our accounts.') });
      await logging.flush();
      const records = (await readFile(join(homeDirectory, 'logs', 'agent.log'), 'utf8'))
        .trim().split('\n')
        .map((line) => parseLogEnvelope(line))
        .filter((record): record is LogEnvelopeV1 => record !== undefined);
      expect(records).toContainEqual(expect.objectContaining({
        eventName: 'orchestrator.delegation.completed',
        severityText: 'INFO',
        attributes: expect.objectContaining({ 'duration.ms': expect.any(Number) }),
      }));
      expect(JSON.stringify(records)).not.toContain('Private checked answer body.');
    } finally {
      await logging.close();
    }
  });

  it('runs sequential checked substeps while retaining a pending transaction draft', async () => {
    const pending = pendingChartTeamResult({
      name: 'Foods',
      accountingClass: 'expense',
      normalBalance: 'debit',
      nativeCurrency: 'IDR',
    });
    const runTeamLead = vi.fn()
      .mockResolvedValueOnce(transactionInsufficientEvidenceResult('The Foods category must be created first.'))
      .mockResolvedValueOnce(pending);
    const incompleteProposal = 'I’ll add Foods as a new expense account with a normal debit balance in IDR. Foods is the expense category, IDR is the currency, debit is the normal balance, and I will record IDR 20000 from Bank ABC dated yesterday under Foods. Would you like me to proceed?';
    const generate = vi.fn(async (prompt: unknown, rawOptions: unknown) => {
      if (JSON.stringify(prompt).includes('Safe checked context:')) {
        return submitFinalResponse(rawOptions, incompleteProposal);
      }
      const options = rawOptions as {
        prepareStep(): Promise<{ activeTools: string[]; toolChoice: string }> | { activeTools: string[]; toolChoice: string };
      };
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'accounting',
        request: {
          schemaName: 'accounting-lead-request',
          schemaVersion: 1,
          intent: 'transaction_capture',
          request: {
            schemaName: 'transaction-capture-request-draft',
            schemaVersion: 1,
            instruction: 'Yesterday. Add Foods as a new category.',
            known: { occurredOn: 'yesterday' },
          },
        },
      });
      await expect(options.prepareStep()).resolves.toMatchObject({
        activeTools: ['delegateTeam', 'submitFinalResponse'],
        toolChoice: 'auto',
      });
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'accounting',
        request: {
          schemaName: 'accounting-lead-request',
          schemaVersion: 1,
          intent: 'chart_of_accounts',
          request: {
            schemaName: 'chart-work-request-draft',
            schemaVersion: 1,
            action: 'create_account',
            instruction: 'Add Foods as a new spending category.',
            known: {
              accountName: 'Foods',
              accountingClass: 'expense',
              normalBalance: 'debit',
              nativeCurrency: 'IDR',
            },
          },
        },
      });
      await expect(options.prepareStep()).resolves.toMatchObject({
        activeTools: ['submitFinalResponse'],
        toolChoice: 'auto',
      });
      return submitFinalResponse(rawOptions, incompleteProposal);
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [accountingTeam] });

    const result = await orchestrator.runTurn({
      message: message('yesterday. add foods as a new category'),
      transactionContinuation: {
        schemaName: 'transaction-capture-continuation',
        schemaVersion: 1,
        request: {
          schemaName: 'transaction-capture-request-draft',
          schemaVersion: 1,
          instruction: 'Spent 20k IDR out of Bank ABC for foods.',
          known: {
            amount: '20000',
            currency: CurrencyCodeSchema.parse('IDR'),
            paymentAccountName: 'Bank ABC',
            categoryName: 'foods',
          },
        },
      },
    });
    expect(runTeamLead).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      kind: 'ask-user',
      pendingMutation: pending,
      transactionContinuation: {
        request: {
          known: {
            amount: '20000',
            currency: 'IDR',
            paymentAccountName: 'Bank ABC',
            categoryName: 'foods',
            occurredOn: 'yesterday',
          },
        },
      },
      response: {
        body: incompleteProposal,
      },
    });
  });

  it('returns an application-owned response after delegated work fails', async () => {
    const runTeamLead = vi.fn(async () => { throw new Error('team unavailable'); });
    const generate = vi.fn(async (_prompt: unknown, options: unknown) => {
      try {
        await executeDelegate(orchestrator.agentTools.delegateTeam, {
          team: 'query',
          request: queryDraft('List our accounts.'),
        });
      } catch {
        return submitFinalResponse(options, 'The specialist check was unavailable.');
      }
      return submitFinalResponse(options, 'unreachable');
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('List our accounts.') }))
      .resolves.toMatchObject({
        body: 'I could not complete the specialist check, so I cannot give you a checked answer yet. No changes were made. Please try again.',
      });
  });

  it('returns the submitted response after the bounded delegation limit is exceeded', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async (_prompt: unknown, options: unknown) => {
      try {
        for (let index = 0; index < 5; index += 1) {
          await executeDelegate(orchestrator.agentTools.delegateTeam, {
            team: 'query',
            request: queryDraft(`List our accounts, substep ${index + 1}.`),
          });
        }
      } catch {
        return submitFinalResponse(options, 'The checked work is ready, but I could not complete another substep.');
      }
      return submitFinalResponse(options, 'unreachable');
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('List our accounts.') }))
      .resolves.toMatchObject({
        body: 'The checked work is ready, but I could not complete another substep.',
      });
  });

  it('does not fall back to a checked result after the orchestrator signal aborts', async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.'),
      });
      entered();
      await new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      });
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    const turn = orchestrator.run({ message: message('List our accounts.'), signal: controller.signal });
    await enteredPromise;
    controller.abort(new DOMException('Timed out', 'TimeoutError'));

    await expect(turn).rejects.toThrow();
    expect(runTeamLead).toHaveBeenCalledOnce();
  });

  it('does not start delegated work after the orchestrator signal aborts', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('Timed out', 'TimeoutError'));
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async (_prompt: unknown, options: unknown) => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.'),
      });
      return submitFinalResponse(options, 'unreachable');
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('List our accounts.'), signal: controller.signal }))
      .rejects.toThrow('Timed out');
    expect(runTeamLead).not.toHaveBeenCalled();
  });

  it('does not let progress event failures fail delegated turns', async () => {
    const channelEvents = { emit: vi.fn(async () => { throw new Error('status transport unavailable'); }) };
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async (_prompt: unknown, options: unknown) => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.', { desiredGrain: ['household', 'account'], coverage: ['account list'] }),
      });
      return submitFinalResponse(options, 'The checked evidence includes one account row.');
    });
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate }) as never,
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(runTeamLead),
      channelEvents,
    });

    await expect(orchestrator.run({ message: message('List our accounts.') }))
      .resolves.toMatchObject({ body: expect.stringContaining('checked evidence') });
    expect(channelEvents.emit).toHaveBeenCalled();
    expect(runTeamLead).toHaveBeenCalledOnce();
  });

  it('keeps delegate context isolated across concurrent runs', async () => {
    const runTeamLead = vi.fn(async (input: Parameters<OrchestratorTeamRuntime['runTeamLead']>[0]) => {
      void input;
      return teamResult();
    });
    let secondDelegated!: () => void;
    const secondDelegatedPromise = new Promise<void>((resolve) => { secondDelegated = resolve; });
    let firstEntered!: () => void;
    const firstEnteredPromise = new Promise<void>((resolve) => { firstEntered = resolve; });
    const generate = vi.fn(async (prompt: unknown, options: unknown) => {
      const body = typeof prompt === 'string' && prompt.includes('first') ? 'first' : 'second';
      if (body === 'first') {
        firstEntered();
        await secondDelegatedPromise;
      } else {
        await firstEnteredPromise;
      }
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft(body),
      });
      if (body === 'second') secondDelegated();
      return submitFinalResponse(options, `${body} checked reply`);
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    await Promise.all([
      orchestrator.run({ message: message('first') }),
      orchestrator.run({ message: message('second') }),
    ]);

    expect(runTeamLead.mock.calls.map(([input]) => input.message.body).sort()).toEqual(['first', 'second']);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('returns a non-terminal turn result when a delegated team needs user clarification', async () => {
    const runTeamLead = vi.fn(async () => insufficientEvidenceResult());
    const generate = vi.fn(async (_prompt: unknown, options: unknown) => {
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
      return submitFinalResponse(options, 'What is its native currency?');
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam, accountingTeam] });

    await expect(orchestrator.runTurn({ message: message('add $10 of buying a burger') })).resolves.toMatchObject({
      kind: 'ask-user',
      response: { body: 'What is its native currency?' },
    });
  });

  it('retains and merges the transaction draft across category clarification turns', async () => {
    const runTeamLead = vi.fn(async () => insufficientEvidenceResult());
    const generate = vi.fn()
      .mockImplementationOnce(async (_prompt: unknown, options: unknown) => {
        await executeDelegate(orchestrator.agentTools.delegateTeam, {
          team: 'accounting',
          request: {
            schemaName: 'accounting-lead-request',
            schemaVersion: 1,
            intent: 'transaction_capture',
            request: {
              schemaName: 'transaction-capture-request-draft',
              schemaVersion: 1,
              instruction: 'add a transaction to test wallet',
              known: { paymentAccountName: 'test wallet' },
            },
          },
        });
        return submitFinalResponse(options, 'What amount should be recorded?');
      })
      .mockImplementationOnce(async (_prompt: unknown, options: unknown) => {
        await executeDelegate(orchestrator.agentTools.delegateTeam, {
          team: 'accounting',
          request: {
            schemaName: 'accounting-lead-request',
            schemaVersion: 1,
            intent: 'transaction_capture',
            request: {
              schemaName: 'transaction-capture-request-draft',
              schemaVersion: 1,
              instruction: '50 USD yesterday in dining',
              known: {
                amount: '50.00',
                currency: 'USD',
                occurredOn: '2026-07-15',
                categoryName: 'dining',
              },
            },
          },
        });
        return submitFinalResponse(options, 'I need a category choice.');
      });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam, accountingTeam] });

    const first = await orchestrator.runTurn({ message: message('add a transaction to test wallet') });
    expect(first).toMatchObject({
      kind: 'ask-user',
      transactionContinuation: {
        request: { known: { paymentAccountName: 'test wallet' } },
      },
    });

    const continuation = first.kind === 'ask-user' ? first.transactionContinuation : undefined;
    if (continuation === undefined) throw new Error('Expected transaction continuation.');
    await orchestrator.runTurn({
      message: message('50 USD yesterday, dining'),
      transactionContinuation: continuation,
    });

    expect(runTeamLead).toHaveBeenLastCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        request: expect.objectContaining({
          known: {
            amount: '50.00',
            currency: 'USD',
            occurredOn: '2026-07-15',
            paymentAccountName: 'test wallet',
            categoryName: 'dining',
          },
        }),
      }),
    }));
  });

  it('rejects a raw post-delegation text leak instead of selecting fallback prose', async () => {
    const runTeamLead = vi.fn(async () => insufficientEvidenceResult());
    const generate = vi.fn(async () => {
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
      return rawOrchestratorTextLeak([
          'Accounting team status: insufficient_evidence',
          'Checker accepted the result.',
          'What is its native currency?',
          'native_currency',
        ].join('\n\n'));
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam, accountingTeam] });

    await expect(orchestrator.runTurn({ message: message('add $10 of buying a burger') }))
      .rejects.toMatchObject({ code: 'orchestrator_response_not_submitted' });
  });

  it('uses checked team results instead of a direct answer when delegation is not verified', async () => {
    const runTeamLead = vi.fn(async () => failedTeamResult());
    const generate = vi.fn(async (_prompt: unknown, options: unknown) => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('Show our transactions.'),
      });
      return submitFinalResponse(options, 'I could not complete that request safely. Please try again.');
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    const response = await orchestrator.run({ message: message('Show our transactions.') });

    expect(response.body).toBe('I could not complete that request safely. Please try again.');
    expect(response.body).not.toContain('Query team status: failed');
    expect(response.body).not.toContain('grain mismatch');
    expect(response.body).not.toContain('verified transactions');
    expect(response.citations).toEqual([{ label: 'query:team-result', sourceRef: 'team-result:failed' }]);
  });

  it('accepts delegated reply text and attaches checked team metadata', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async (_prompt: unknown, options: unknown) => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.'),
      });
      return submitFinalResponse(options, 'not a typed final response');
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('List our accounts.') }))
      .resolves.toMatchObject({
        body: 'not a typed final response',
        policyBoundary: 'personalized_finance',
        citations: [{ label: 'query:accounts-listed', artifactId }],
      });
  });

  it('raises a typed error when post-delegation generation submits no response', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.'),
      });
      return rawOrchestratorTextLeak('   ');
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('List our accounts.') }))
      .rejects.toMatchObject({ code: 'orchestrator_response_not_submitted' });
  });

  it('preserves an operational failure after same-agent synthesis also fails', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.'),
      });
      throw new Error('Inference capacity queue is full');
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('List our accounts.') }))
      .rejects.toThrow('Inference capacity queue is full');
    expect(runTeamLead).toHaveBeenCalledOnce();
  });

  it('repairs a failed synthesis through the same agent without exposing opaque identifiers', async () => {
    const unsafeResult = TeamResultEnvelopeSchemaV2.parse({
      ...teamResult(),
      claims: [
        ...teamResult().claims,
        {
          claimId: 'unsafe-draft-claim',
          text: `Use ${draftId} to continue.`,
          evidenceArtifactIds: [],
          checkedMakerArtifactIds: [artifactId],
        },
      ],
      completionReason: `The checked artifact is ${artifactId}.`,
      outstanding: [`Ask for ${draftId} if clarification is needed.`],
    });
    const runTeamLead = vi.fn(async () => unsafeResult);
    const generate = vi.fn()
      .mockImplementationOnce(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.'),
      });
      throw new Error('specialist result contract failed');
      })
      .mockImplementationOnce(async (_prompt: unknown, options: unknown) =>
        submitFinalResponse(options, 'I could not safely summarize the checked result. Please try again.'));
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    const response = await orchestrator.run({ message: message('List our accounts.') });

    expect(response.body).toBe('I could not safely summarize the checked result. Please try again.');
    expect(response.body).not.toContain(draftId);
    expect(response.body).not.toContain(artifactId);
    expect(response.citations).toEqual(expect.arrayContaining([
      { label: 'query:accounts-listed', artifactId },
      { label: 'query:unsafe-draft-claim', artifactId },
    ]));
  });

  it('raises a typed error when post-delegation API retries exhaust before submission', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.'),
      });
      return { ...rawOrchestratorTextLeak(''), finishReason: 'retry' };
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('List our accounts.') }))
      .rejects.toMatchObject({ code: 'orchestrator_response_not_submitted' });
  });

  it('uses checked team citations for delegated reply text', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async (_prompt: unknown, options: unknown) => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.', { desiredGrain: ['household', 'account'], coverage: ['account list'] }),
      });
      return submitFinalResponse(options, 'I found one account in the household records.');
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    const response = await orchestrator.run({ message: message('List our accounts.') });

    expect(response.citations).toEqual([{ label: 'query:accounts-listed', artifactId }]);
    expect(response.delivery.format).toBe('mrkdwn');
  });

  it('does not delegate when the orchestrator submits a direct answer', async () => {
    const runTeamLead = vi.fn();
    const generate = vi.fn(async (_prompt: unknown, options: unknown) =>
      submitFinalResponse(options, 'I can answer directly without a team.'));
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam, accountingTeam] });

    const response = await orchestrator.run({ message: message('What can you do?') });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(runTeamLead).not.toHaveBeenCalled();
    expect(response.body).toBe('I can answer directly without a team.');
    expect(response.delivery.format).toBe('mrkdwn');
  });

  it('accepts an ordinary no-team submitted answer', async () => {
    const generate = vi.fn(async (_prompt: unknown, options: unknown) => submitFinalResponse(options, 'I recorded it.'));
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead: vi.fn(), teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('What can you do?') }))
      .resolves.toMatchObject({
        body: 'I recorded it.',
        policyBoundary: 'informational_only',
        citations: [{ label: 'orchestrator-policy', sourceRef: 'runtime-instructions' }],
      });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty direct model response without a fallback', async () => {
    const generate = vi.fn(async () => rawOrchestratorTextLeak('   '));
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead: vi.fn(), teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('hello') }))
      .rejects.toMatchObject({ code: 'orchestrator_response_not_submitted' });
  });

  it('classifies an exhausted direct response protocol as a typed runtime failure', async () => {
    const generate = vi.fn(async () => ({ ...rawOrchestratorTextLeak(''), finishReason: 'retry' }));
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead: vi.fn(), teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('hello') }))
      .rejects.toMatchObject({ code: 'orchestrator_response_not_submitted', retry: 'after_backoff' });
  });

  it('handles delegate tool calls outside an active invocation', async () => {
    const runTeamLead = vi.fn();
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate: vi.fn() }) as never,
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(runTeamLead),
    });

    const execute = orchestrator.agentTools.delegateTeam.execute as unknown as (input: unknown, options: unknown) => Promise<unknown>;
    await expect(execute({ team: 'Query Team', request: 'test' }, {}))
      .resolves.toMatchObject({ error: true });
    await expect(execute({ team: 'query', request: '"test"' }, {}))
      .rejects.toThrow('No active orchestrator invocation.');
    expect(runTeamLead).not.toHaveBeenCalled();
  });

  it('rejects a submitted response that asks for internal identifiers', async () => {
    const runTeamLead = vi.fn();
    const generate = vi.fn(async (_prompt: unknown, options: unknown) =>
      submitFinalResponse(options, 'Please send your Household ID and Book ID.'));
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('Can you help?') }))
      .rejects.toMatchObject({ code: 'orchestrator_response_rejected' });
  });

  it('rejects a submitted response that contains a contract opaque identifier', async () => {
    const generate = vi.fn(async (_prompt: unknown, options: unknown) =>
      submitFinalResponse(options, `Please use ${draftId} to continue.`));
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead: vi.fn(), teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('Can you help?') }))
      .rejects.toMatchObject({ code: 'orchestrator_response_rejected' });
  });
});

async function executeDelegate(
  tool: typeof OrchestratorAgent.prototype.agentTools.delegateTeam,
  input: { team: string; request: unknown },
): Promise<TeamResultEnvelopeV2> {
  const execute = tool.execute as unknown as (input: unknown, options: unknown) => Promise<unknown>;
  return TeamResultEnvelopeSchemaV2.parse(await execute(input, {}));
}
