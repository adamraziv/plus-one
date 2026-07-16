import {
  InboundChannelMessageSchemaV1,
  TeamResultEnvelopeSchemaV2,
  type TeamResultEnvelopeV2,
} from '@plus-one/contracts';

export const confirmationMessageFixture = InboundChannelMessageSchemaV1.parse({
  schemaName: 'inbound-channel-message',
  schemaVersion: 1,
  conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  channel: 'telegram',
  externalMessageId: 'telegram-message-confirm-1',
  receivedAt: '2026-07-16T00:00:00.000Z',
  speaker: { principalRef: 'telegram:user:1' },
  body: 'go ahead',
  attachments: [],
  metadata: { destination: { chatId: 'telegram-chat-1' } },
});

const proposal = {
  schemaName: 'chart-of-accounts-proposal' as const,
  schemaVersion: 1 as const,
  action: 'create_account' as const,
  householdId: confirmationMessageFixture.householdId,
  bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  name: 'Bank ABC',
  accountingClass: 'asset' as const,
  normalBalance: 'debit' as const,
  nativeCurrency: 'IDR',
};

const artifactId = 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const artifactHash = 'a'.repeat(64);
const taskId = 'task_01JNZQ4A9B8C7D6E5F4G3H2J9K';

export const pendingChartResultFixture = TeamResultEnvelopeSchemaV2.parse({
  schemaName: 'team-result',
  schemaVersion: 2,
  householdId: confirmationMessageFixture.householdId,
  taskId,
  team: 'accounting',
  status: 'partial',
  claims: [{
    claimId: 'chart-proposal',
    text: 'The chart proposal was checked.',
    evidenceArtifactIds: [],
    checkedMakerArtifactIds: [artifactId],
  }],
  assumptions: [],
  uncertainty: [],
  freshness: [],
  coverage: ['chart-of-accounts'],
  makerArtifacts: [{
    artifactId,
    householdId: confirmationMessageFixture.householdId,
    taskId,
    artifactType: 'maker_output',
    schema: { schemaName: 'maker-artifact', schemaVersion: 1 },
    canonicalizationVersion: 'rfc8785-v1',
    hashAlgorithm: 'sha256',
    artifactHash,
    payload: {
      schemaName: 'maker-artifact',
      schemaVersion: 1,
      outputSchema: { schemaName: 'chart-work-result', schemaVersion: 1 },
      output: proposal,
      claims: [{ claimId: 'chart-proposal', text: 'Checked proposal.', evidenceArtifactIds: [] }],
      assumptions: [],
      uncertainty: [],
    },
    createdAt: '2026-07-16T00:00:00.000Z',
  }],
  checkerVerdicts: [{
    verdict: 'accepted',
    coveredArtifactId: artifactId,
    coveredArtifactHash: artifactHash,
    findings: [],
  }],
  selectedSkill: { skillName: 'chart-of-accounts', skillVersion: 1, contentHash: 'b'.repeat(64) },
  strategyName: 'single-maker-checker',
  stopCondition: { code: 'checked-chart', description: 'Return one checked chart proposal.' },
  completionReason: 'The exact chart proposal passed checking.',
  outstanding: [],
  effect: {
    state: 'awaiting_confirmation',
    proposal: { taskId, artifactId, artifactHash },
    command: {
      schemaName: 'checked-command',
      schemaVersion: 1,
      commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      householdId: confirmationMessageFixture.householdId,
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

function pendingEffect(result: TeamResultEnvelopeV2) {
  if (result.effect.state !== 'awaiting_confirmation') {
    throw new Error('Expected a pending mutation fixture');
  }
  return result.effect;
}

export const pendingEffectFixture = pendingEffect(pendingChartResultFixture);
