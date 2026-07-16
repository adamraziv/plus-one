import { describe, expect, it } from 'vitest';
import {
  MakerArtifactSchemaV1,
  MakerInvocationSchemaV1,
  TeamClaimSchemaV1,
  TeamLeadInvocationSchemaV1,
  TeamLeadPlanSchemaV1,
  TeamResultEnvelopeSchemaV1,
  TeamResultEnvelopeSchemaV2,
  VerificationTaskSchemaV1,
} from './index.js';

const identity = {
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
} as const;
const skill = { skillName: 'verified-lookup', skillVersion: 1, contentHash: 'a'.repeat(64) };
const makerArtifact = {
  artifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  ...identity,
  artifactType: 'maker_output',
  schema: { schemaName: 'maker-artifact', schemaVersion: 1 },
  canonicalizationVersion: 'rfc8785-v1',
  hashAlgorithm: 'sha256',
  artifactHash: 'b'.repeat(64),
  payload: {
    schemaName: 'maker-artifact',
    schemaVersion: 1,
    outputSchema: { schemaName: 'lookup-output', schemaVersion: 1 },
    output: { answer: '42' },
    claims: [{ claimId: 'claim-1', text: 'The answer is 42', evidenceArtifactIds: [] }],
    assumptions: [],
    uncertainty: [],
  },
  createdAt: '2026-06-14T10:00:00.000Z',
};

const proposal = {
  taskId: identity.taskId,
  artifactId: makerArtifact.artifactId,
  artifactHash: makerArtifact.artifactHash,
};
const command = {
  schemaName: 'checked-command' as const,
  schemaVersion: 1 as const,
  commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  householdId: identity.householdId,
  taskId: proposal.taskId,
  checkedProposalId: proposal.artifactId,
  checkedProposalHash: proposal.artifactHash,
  commandType: 'apply_chart_of_accounts_change',
  idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  payloadSchema: { schemaName: 'chart-of-accounts-proposal', schemaVersion: 1 },
  payload: {
    schemaName: 'chart-of-accounts-proposal', schemaVersion: 1,
    action: 'create_account', name: 'Bank ABC', accountingClass: 'asset',
    normalBalance: 'debit', nativeCurrency: 'IDR',
  },
};

function validTeamResultV2() {
  return {
    schemaName: 'team-result' as const,
    schemaVersion: 2 as const,
    ...identity,
    team: 'accounting',
    status: 'partial' as const,
    claims: [{
      claimId: 'claim-1', text: 'The chart proposal was checked.',
      evidenceArtifactIds: [], checkedMakerArtifactIds: [makerArtifact.artifactId],
    }],
    assumptions: [], uncertainty: [], freshness: [], coverage: ['chart change'],
    makerArtifacts: [makerArtifact],
    checkerVerdicts: [{
      verdict: 'accepted' as const,
      coveredArtifactId: makerArtifact.artifactId,
      coveredArtifactHash: makerArtifact.artifactHash,
      findings: [],
    }],
    selectedSkill: skill,
    strategyName: 'single-maker-checker',
    stopCondition: { code: 'checked-chart', description: 'Return one checked chart proposal.' },
    completionReason: 'The exact proposal passed checking.',
    outstanding: [],
    effect: { state: 'awaiting_confirmation' as const, proposal, command },
  };
}

function validMutationReceipt(input: { command: typeof command; proposal: typeof proposal }) {
  return {
    schemaName: 'mutation-receipt' as const,
    schemaVersion: 1 as const,
    receiptId: 'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    commandId: input.command.commandId,
    householdId: input.command.householdId,
    taskId: input.proposal.taskId,
    checkedProposalId: input.proposal.artifactId,
    checkedProposalHash: input.proposal.artifactHash,
    commandType: input.command.commandType,
    idempotencyKey: input.command.idempotencyKey,
    committedRecords: [{ recordType: 'accounting.account', recordId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K' }],
    expectedState: input.command.payload,
    expectedStateHash: 'b'.repeat(64),
    committedAt: '2026-07-16T00:00:00.000Z',
  };
}

function validMutationReadback(input: { receipt: ReturnType<typeof validMutationReceipt> }) {
  return {
    schemaName: 'mutation-readback' as const,
    schemaVersion: 1 as const,
    readbackId: 'readback_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    commandId: input.receipt.commandId,
    receiptId: input.receipt.receiptId,
    ok: true,
    checks: [
      { kind: 'identifiers' as const, status: 'passed' as const },
      { kind: 'row_values' as const, status: 'passed' as const },
      { kind: 'artifact_links' as const, status: 'passed' as const },
      { kind: 'idempotency_receipt' as const, status: 'passed' as const },
    ],
    mismatches: [],
    observedStateHash: 'c'.repeat(64),
  };
}

describe('team execution contracts', () => {
  it('rejects prompted JSON strings at maker boundaries', () => {
    expect(MakerArtifactSchemaV1.safeParse('{"answer":42}').success).toBe(false);
  });

  it('requires a versioned invocation and selected immutable skill identity', () => {
    expect(MakerInvocationSchemaV1.parse({
      schemaName: 'maker-invocation', schemaVersion: 1, ...identity, team: 'query',
      role: { roleName: 'query-maker', roleVersion: 1 }, skill,
      inputSchema: { schemaName: 'lookup-input', schemaVersion: 1 },
      outputSchema: { schemaName: 'lookup-output', schemaVersion: 1 },
      input: { question: 'What is the value?' }, permittedEvidence: [],
      policyLabels: ['financial-data'], stopCondition: { code: 'exact-answer', description: 'Return one checked answer' },
    }).skill).toEqual(skill);
  });

  it('keeps lead recommendations typed and non-authoritative', () => {
    const invocation = TeamLeadInvocationSchemaV1.parse({
      schemaName: 'team-lead-invocation', schemaVersion: 1, ...identity, team: 'query',
      role: { roleName: 'query-lead', roleVersion: 1 }, selectedSkill: skill,
      request: { question: 'Compare two checked views.' },
      availableWorkCellIds: ['lookup'], availableStrategyNames: ['parallel-independent-makers'],
      policyLabels: ['financial-data'],
    });
    expect(TeamLeadPlanSchemaV1.parse({
      schemaName: 'team-lead-plan', schemaVersion: 1,
      recommendedStrategyName: invocation.availableStrategyNames[0],
      work: [{ workCellId: 'lookup', makerInput: invocation.request }],
      stopCondition: { code: 'checked-comparison', description: 'Return checked comparison inputs.' },
    }).recommendedStrategyName).toBe('parallel-independent-makers');
  });

  it('embeds the exact immutable maker artifact in a verification task', () => {
    const parsed = VerificationTaskSchemaV1.parse({
      schemaName: 'verification-task', schemaVersion: 1, ...identity,
      checkerRole: { roleName: 'query-checker', roleVersion: 1 },
      makerArtifact, makerInput: { question: 'What is the value?' }, permittedEvidence: [], selectedSkill: skill,
      rubric: { rubricName: 'lookup-rubric', rubricVersion: 1, instructions: ['Check the evidence and claim.'] },
      policyLabels: ['financial-data'],
      requiredOutputSchema: { schemaName: 'checker-verdict', schemaVersion: 1 },
    });
    expect(parsed.makerArtifact.artifactHash).toBe('b'.repeat(64));
  });

  it('requires checked artifact references for every final claim', () => {
    const result = {
      schemaName: 'team-result', schemaVersion: 1, ...identity, team: 'query',
      status: 'verified', claims: [{ claimId: 'claim-1', text: 'The answer is 42',
        evidenceArtifactIds: [], checkedMakerArtifactIds: [makerArtifact.artifactId] }],
      assumptions: [], uncertainty: [], freshness: [], coverage: ['requested answer'],
      makerArtifacts: [makerArtifact],
      checkerVerdicts: [{ verdict: 'accepted', coveredArtifactId: makerArtifact.artifactId,
        coveredArtifactHash: makerArtifact.artifactHash, findings: [] }],
      selectedSkill: skill, strategyName: 'verified-factual-lookup',
      stopCondition: { code: 'exact-answer', description: 'Return one checked answer' },
      completionReason: 'The exact-answer condition passed.', outstanding: [],
    };
    expect(TeamResultEnvelopeSchemaV1.parse(result).status).toBe('verified');
    expect(TeamResultEnvelopeSchemaV1.safeParse({
      ...result,
      claims: [{ ...result.claims[0]!, checkedMakerArtifactIds: ['artifact_01AAAAAAAAAAAAAAAAAAAAAAAAAA'] }],
    }).success).toBe(false);
  });

  it('requires opaque artifact identities for all claim references', () => {
    const claim = {
      claimId: 'claim-1',
      text: 'The answer is checked.',
      evidenceArtifactIds: ['artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K'],
      checkedMakerArtifactIds: ['artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K'],
    };
    expect(TeamClaimSchemaV1.safeParse({
      ...claim,
      evidenceArtifactIds: ['artifact_private_001'],
    }).success).toBe(false);
    expect(TeamClaimSchemaV1.safeParse({
      ...claim,
      checkedMakerArtifactIds: ['artifact_private_001'],
    }).success).toBe(false);
  });
});

describe('team result effect proof', () => {
  const base = validTeamResultV2();

  it('accepts an awaiting-confirmation proposal only as partial', () => {
    expect(TeamResultEnvelopeSchemaV2.parse({
      ...base,
      status: 'partial',
      effect: { state: 'awaiting_confirmation', proposal, command },
    }).effect.state).toBe('awaiting_confirmation');
    expect(TeamResultEnvelopeSchemaV2.safeParse({
      ...base,
      status: 'verified',
      effect: { state: 'awaiting_confirmation', proposal, command },
    }).success).toBe(false);
  });

  it('rejects persisted proof whose receipt or read-back identity differs', () => {
    const receipt = validMutationReceipt({ command, proposal });
    const readback = validMutationReadback({ receipt });
    expect(TeamResultEnvelopeSchemaV2.safeParse({
      ...base,
      status: 'verified',
      effect: {
        state: 'persisted', proposal, receipt,
        readback: { ...readback, receiptId: 'receipt_01JNZQ4A9B8C7D6E5F4G3H2J9K' },
      },
    }).success).toBe(false);
  });

  it('accepts persistence only with matching receipt and successful read-back', () => {
    const receipt = validMutationReceipt({ command, proposal });
    const readback = validMutationReadback({ receipt });
    expect(TeamResultEnvelopeSchemaV2.parse({
      ...base,
      status: 'verified',
      effect: { state: 'persisted', proposal, receipt, readback },
    }).effect.state).toBe('persisted');
  });
});
