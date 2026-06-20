import { describe, expect, it } from 'vitest';
import {
  ActivateBudgetCommandAdapter,
  ArchivePlanningRecordCommandAdapter,
  PlanningCommandHandlers,
} from './planning-command-handlers.js';

const payload = {
  schemaName: 'activate-budget-proposal' as const,
  schemaVersion: 1 as const,
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  scopeKey: 'monthly',
  name: 'June',
  validFrom: '2026-06-01',
  categories: [{ categoryKey: 'food', name: 'Food' }],
  allocations: [],
  mappings: [],
};
const input = {
  commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  householdId: payload.householdId,
  taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  checkedProposalId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  checkedProposalHash: 'a'.repeat(64),
  idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  payloadSchema: { schemaName: 'activate-budget-proposal', schemaVersion: 1 },
  payload,
};

describe('planning command handlers', () => {
  it('adapts checked planning commands through explicit command types', () => {
    expect(new ActivateBudgetCommandAdapter().buildCommand(input).commandType).toBe('activate_budget');
    expect(() => new ArchivePlanningRecordCommandAdapter().buildCommand(input)).toThrow();
  });

  it('registers every Plan 08 command on the planning role', () => {
    expect(PlanningCommandHandlers.map((handler) => [handler.commandType, handler.domainRole])).toEqual([
      ['activate_budget', 'planning'],
      ['update_obligation', 'planning'],
      ['upsert_savings_goal', 'planning'],
      ['upsert_debt_plan', 'planning'],
      ['archive_planning_record', 'planning'],
    ]);
    expect(PlanningCommandHandlers.every((handler) => handler.requiredReadbackChecks.includes('idempotency_receipt'))).toBe(true);
  });
});
