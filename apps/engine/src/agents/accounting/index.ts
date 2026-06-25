import { createAccountingTeamLeadAgent } from './team-lead.js';
import { createChartCheckerAgent } from './chart-checker.js';
import { createChartMakerAgent } from './chart-maker.js';
import { createIngestionCheckerAgent } from './ingestion-checker.js';
import { createIngestionMakerAgent } from './ingestion-maker.js';
import { createJournalCheckerAgent } from './journal-checker.js';
import { createJournalMakerAgent } from './journal-maker.js';
import { createReconciliationCheckerAgent } from './reconciliation-checker.js';
import { createReconciliationMakerAgent } from './reconciliation-maker.js';
import { createTransactionCaptureCheckerAgent } from './transaction-capture-checker.js';
import { createTransactionCaptureMakerAgent } from './transaction-capture-maker.js';
import type { AccountingRoleAgent, AccountingRoleAgentInput } from './types.js';

export { createAccountingTeamLeadAgent } from './team-lead.js';
export { createChartCheckerAgent } from './chart-checker.js';
export { createChartMakerAgent } from './chart-maker.js';
export { createIngestionCheckerAgent } from './ingestion-checker.js';
export { createIngestionMakerAgent } from './ingestion-maker.js';
export { createJournalCheckerAgent } from './journal-checker.js';
export { createJournalMakerAgent } from './journal-maker.js';
export { createReconciliationCheckerAgent } from './reconciliation-checker.js';
export { createReconciliationMakerAgent } from './reconciliation-maker.js';
export { createTransactionCaptureCheckerAgent } from './transaction-capture-checker.js';
export { createTransactionCaptureMakerAgent } from './transaction-capture-maker.js';
export type {
  AccountingRoleAgent,
  AccountingRoleAgentFactory,
  AccountingRoleAgentInput,
  AccountingRoleAgentModels,
} from './types.js';

export function createAccountingRoleAgents(input: AccountingRoleAgentInput): Record<string, AccountingRoleAgent> {
  return {
    'accounting-lead': createAccountingTeamLeadAgent(input),
    'transaction-capture-maker': createTransactionCaptureMakerAgent(input),
    'transaction-capture-checker': createTransactionCaptureCheckerAgent(input),
    'ingestion-maker': createIngestionMakerAgent(input),
    'ingestion-checker': createIngestionCheckerAgent(input),
    'journal-maker': createJournalMakerAgent(input),
    'journal-checker': createJournalCheckerAgent(input),
    'chart-maker': createChartMakerAgent(input),
    'chart-checker': createChartCheckerAgent(input),
    'reconciliation-maker': createReconciliationMakerAgent(input),
    'reconciliation-checker': createReconciliationCheckerAgent(input),
  };
}
