import { describe, expect, it, vi } from 'vitest';
import { PlusOneError } from '@plus-one/contracts';
import {
  BudgetingMutationService,
  CashFlowMutationService,
} from '../index.js';

describe('planning mutation services', () => {
  it('routes budget-plan to activate_budget through the coordinator', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 'verified', completionState: 'terminal' });
    await new BudgetingMutationService({ execute } as never).execute({
      workCellInput: { workCellId: 'budget-plan' } as never,
      commandId: 'command_01JQ8000000000000000000021',
      idempotencyKey: 'idem_01JQ8000000000000000000021',
    });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      adapter: expect.objectContaining({ buildCommand: expect.any(Function) }),
    }));
  });

  it('rejects budget-scenarios from mutation execution', async () => {
    const service = new BudgetingMutationService({ execute: vi.fn() } as never);
    await expect(service.execute({
      workCellInput: { workCellId: 'budget-scenarios' } as never,
      commandId: 'command_01JQ8000000000000000000022',
      idempotencyKey: 'idem_01JQ8000000000000000000022',
    })).rejects.toMatchObject({ code: 'planning_mutation_cell_invalid' } satisfies Partial<PlusOneError>);
  });

  it('routes only cash-flow mutation cells through the coordinator', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 'verified', completionState: 'terminal' });
    const service = new CashFlowMutationService({ execute } as never);
    await service.execute({
      workCellInput: { workCellId: 'cash-flow-obligation' } as never,
      commandId: 'command_01JQ8000000000000000000023',
      idempotencyKey: 'idem_01JQ8000000000000000000023',
    });
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(service.execute({
      workCellInput: { workCellId: 'cash-flow-analysis' } as never,
      commandId: 'command_01JQ8000000000000000000024',
      idempotencyKey: 'idem_01JQ8000000000000000000024',
    })).rejects.toMatchObject({ code: 'planning_mutation_cell_invalid' } satisfies Partial<PlusOneError>);
  });
});
