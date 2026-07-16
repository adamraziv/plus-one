import type { WorkCellDefinition } from '@plus-one/runtime';
import { ingestionWorkCellDefinition, reconciliationWorkCellDefinition } from '@plus-one/ingestion';
import {
  AccountingClarificationSchemaV1,
  AccountingWorkResultSchemaV1,
  ChartClarificationSchemaV1,
  ChartWorkRequestSchemaV1,
  ChartWorkResultSchemaV1,
  JournalWorkRequestSchemaV1,
  TransactionCaptureRequestSchemaV1,
} from './contracts.js';
import { accountingRoles } from './roles.js';

const byName = (name: string) => {
  const role = accountingRoles.find((entry) => entry.identity.roleName === name);
  if (role === undefined) throw new Error('Unknown accounting role ' + name);
  return role;
};

const acceptedStop: WorkCellDefinition['evaluateStopCondition'] = ({ maker }) => {
  const clarification = AccountingClarificationSchemaV1.safeParse(maker.output);
  if (clarification.success) {
    return {
      status: 'insufficient_evidence',
      reason: clarification.data.reason,
      outstanding: [...clarification.data.questions],
    };
  }
  return {
    status: 'verified',
    reason: 'The checker accepted the exact mutation proposal.',
    outstanding: [],
  };
};

const chartStop: WorkCellDefinition['evaluateStopCondition'] = ({ maker }) => {
  const clarification = ChartClarificationSchemaV1.safeParse(maker.output);
  if (clarification.success) {
    return {
      status: 'insufficient_evidence',
      reason: clarification.data.reason,
      outstanding: [...clarification.data.questions],
    };
  }
  return {
    status: 'verified',
    reason: 'The checker accepted the exact chart proposal.',
    outstanding: [],
  };
};

export const transactionCaptureWorkCell: WorkCellDefinition = {
  workCellId: 'transaction-capture',
  maker: byName('transaction-capture-maker') as WorkCellDefinition['maker'],
  checker: byName('transaction-capture-checker') as WorkCellDefinition['checker'],
  makerInputSchema: TransactionCaptureRequestSchemaV1,
  makerOutputSchema: AccountingWorkResultSchemaV1,
  inputSchemaIdentity: { schemaName: 'transaction-capture-request', schemaVersion: 1 },
  outputSchemaIdentity: { schemaName: 'accounting-work-result', schemaVersion: 1 },
  checkerRubric: {
    rubricName: 'transaction-capture-rubric',
    rubricVersion: 1,
    instructions: [
      'Require explicit intent.',
      'Verify all material fields and balancing.',
      'Accept clarification only when a material field is genuinely unresolved.',
    ],
  },
  allowedSkillNames: ['transaction-capture'],
  evaluateStopCondition: acceptedStop,
};

export const journalWorkCell: WorkCellDefinition = {
  workCellId: 'journal',
  maker: byName('journal-maker') as WorkCellDefinition['maker'],
  checker: byName('journal-checker') as WorkCellDefinition['checker'],
  makerInputSchema: JournalWorkRequestSchemaV1,
  makerOutputSchema: AccountingWorkResultSchemaV1,
  inputSchemaIdentity: { schemaName: 'journal-work-request', schemaVersion: 1 },
  outputSchemaIdentity: { schemaName: 'accounting-work-result', schemaVersion: 1 },
  checkerRubric: {
    rubricName: 'journal-rubric',
    rubricVersion: 1,
    instructions: [
      'Verify exact balance and account semantics.',
      'Verify transfers, splits, corrections, and realized-FX provenance.',
      'Reject unrealized revaluation journals.',
    ],
  },
  allowedSkillNames: ['accounting-journal'],
  evaluateStopCondition: acceptedStop,
};

export const chartOfAccountsWorkCell: WorkCellDefinition = {
  workCellId: 'chart-of-accounts',
  maker: byName('chart-maker') as WorkCellDefinition['maker'],
  checker: byName('chart-checker') as WorkCellDefinition['checker'],
  makerInputSchema: ChartWorkRequestSchemaV1,
  makerOutputSchema: ChartWorkResultSchemaV1,
  inputSchemaIdentity: { schemaName: 'chart-work-request', schemaVersion: 1 },
  outputSchemaIdentity: { schemaName: 'chart-work-result', schemaVersion: 1 },
  checkerRubric: {
    rubricName: 'chart-of-accounts-rubric',
    rubricVersion: 1,
    instructions: [
      'Verify household/book/account scope.',
      'Verify class, normal balance, currency, hierarchy, archival, and source mapping fields.',
      'Do not treat the checker verdict as external confirmation.',
    ],
  },
  allowedSkillNames: ['chart-of-accounts'],
  evaluateStopCondition: chartStop,
};

export const accountingWorkCells = [
  transactionCaptureWorkCell,
  ingestionWorkCellDefinition,
  journalWorkCell,
  chartOfAccountsWorkCell,
  reconciliationWorkCellDefinition,
] as const;
