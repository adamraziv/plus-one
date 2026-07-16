import type { WorkCellDefinition } from '@plus-one/runtime';
import {
  IngestionClarificationSchemaV1,
  IngestionWorkRequestSchemaV1,
  IngestionWorkResultSchemaV1,
  ReconciliationClarificationSchemaV1,
  ReconciliationWorkRequestSchemaV1,
  ReconciliationWorkResultSchemaV1,
} from './contracts.js';
import { ingestionRoles } from './roles.js';

const role = (name: string) => {
  const found = ingestionRoles.find((entry) => entry.identity.roleName === name);
  if (found === undefined) throw new Error('Unknown ingestion role ' + name);
  return found;
};

export const ingestionWorkCellDefinition: WorkCellDefinition = {
  workCellId: 'ingestion',
  maker: role('ingestion-maker') as WorkCellDefinition['maker'],
  checker: role('ingestion-checker') as WorkCellDefinition['checker'],
  makerInputSchema: IngestionWorkRequestSchemaV1,
  makerOutputSchema: IngestionWorkResultSchemaV1,
  inputSchemaIdentity: { schemaName: 'ingestion-work-request', schemaVersion: 1 },
  outputSchemaIdentity: { schemaName: 'ingestion-work-result', schemaVersion: 1 },
  effectPolicy: {
    kind: 'checked_mutation',
    proposals: [{
      schema: { schemaName: 'confirm-import-batch-proposal', schemaVersion: 1 },
      confirmation: 'required',
    }],
  },
  checkerRubric: {
    rubricName: 'ingestion-rubric',
    rubricVersion: 1,
    instructions: [
      'Verify every source row and exact fingerprint.',
      'Reject auto-posting probable duplicates.',
      'Verify balanced drafts and complete source lineage.',
    ],
  },
  allowedSkillNames: ['accounting-ingestion'],
  evaluateStopCondition: ({ maker }) => {
    const clarification = IngestionClarificationSchemaV1.safeParse(maker.output);
    return clarification.success
      ? { status: 'insufficient_evidence', reason: clarification.data.reason,
        outstanding: [...clarification.data.questions] }
      : { status: 'verified', reason: 'Checker accepted the exact import proposal.', outstanding: [] };
  },
};

export const reconciliationWorkCellDefinition: WorkCellDefinition = {
  workCellId: 'reconciliation',
  maker: role('reconciliation-maker') as WorkCellDefinition['maker'],
  checker: role('reconciliation-checker') as WorkCellDefinition['checker'],
  makerInputSchema: ReconciliationWorkRequestSchemaV1,
  makerOutputSchema: ReconciliationWorkResultSchemaV1,
  inputSchemaIdentity: { schemaName: 'reconciliation-work-request', schemaVersion: 1 },
  outputSchemaIdentity: { schemaName: 'reconciliation-work-result', schemaVersion: 1 },
  effectPolicy: {
    kind: 'checked_mutation',
    proposals: [
      { schema: { schemaName: 'reconciliation-proposal', schemaVersion: 1 }, confirmation: 'optional' },
      { schema: { schemaName: 'period-close-proposal', schemaVersion: 1 }, confirmation: 'optional' },
      { schema: { schemaName: 'period-reopen-proposal', schemaVersion: 1 }, confirmation: 'required' },
    ],
  },
  checkerRubric: {
    rubricName: 'reconciliation-rubric',
    rubricVersion: 1,
    instructions: [
      'Use only supplied checked evidence artifacts.',
      'Keep statement and ledger balances separate.',
      'Verify account, period, currency, item coverage, and discrepancies.',
    ],
  },
  allowedSkillNames: ['accounting-reconciliation'],
  evaluateStopCondition: ({ maker }) => {
    const clarification = ReconciliationClarificationSchemaV1.safeParse(maker.output);
    return clarification.success
      ? { status: 'insufficient_evidence', reason: clarification.data.reason,
        outstanding: [...clarification.data.missingEvidence] }
      : { status: 'verified', reason: 'Checker accepted the exact reconciliation proposal.', outstanding: [] };
  },
};
