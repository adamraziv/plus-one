import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  BudgetingMutationService,
} from '@plus-one/planning';
import { ActivateBudgetProposalSchemaV1 } from '@plus-one/contracts';
import {
  checkedPlanningResult,
  createPlanningMutationCoordinator,
  seedPlanningTeamFixture,
} from '../helpers/planning-team.js';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext | undefined;
let closeHarness: (() => Promise<void>) | undefined;
let owner: Pool | undefined;

afterEach(async () => {
  await closeHarness?.();
  closeHarness = undefined;
  await owner?.end();
  owner = undefined;
  await context?.cleanup();
  context = undefined;
});

describe('BudgetingMutationService', () => {
  it('executes an accepted budget-plan through activate_budget and read-back verification', async () => {
    context = await createPostgresTestContext('budgeting_team_mutation');
    owner = new Pool({ connectionString: context.migratorUrl });
    const { planning } = await seedPlanningTeamFixture(owner);
    const output = ActivateBudgetProposalSchemaV1.parse({
      schemaName: 'activate-budget-proposal',
      schemaVersion: 1,
      householdId: planning.householdId,
      scopeKey: 'monthly',
      name: 'July budget',
      validFrom: '2026-07-01',
      categories: [{ categoryKey: 'food', name: 'Food' }],
      allocations: [],
      mappings: [],
    });
    const harness = await createPlanningMutationCoordinator(owner, context, checkedPlanningResult({
      householdId: planning.householdId,
      householdDbId: planning.householdDbId,
      taskId: planning.context.taskId,
      team: 'budgeting',
      workCellId: 'budget-plan',
      outputSchema: { schemaName: 'activate-budget-proposal', schemaVersion: 1 },
      output: JSON.parse(JSON.stringify(output)),
      claimId: 'budget-ready',
      claimText: 'Budget proposal is ready for checked execution.',
    }));
    closeHarness = harness.close;

    const result = await new BudgetingMutationService(harness.coordinator).execute({
      workCellInput: {
        householdId: planning.householdId,
        taskId: planning.context.taskId,
        team: 'budgeting',
        workCellId: 'budget-plan',
      } as never,
      commandId: planning.context.commandId,
      idempotencyKey: planning.context.idempotencyKey,
    });

    expect(result.status).toBe('verified');
    expect(result.mutation.receipt.commandType).toBe('activate_budget');
  });
});
