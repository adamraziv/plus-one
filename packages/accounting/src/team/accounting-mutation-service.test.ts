import { describe, expect, it, vi } from 'vitest';
import { AccountingMutationService } from './accounting-mutation-service.js';

describe('AccountingMutationService', () => {
  it('routes journal and chart cells to distinct exact adapters', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 'verified' });
    const service = new AccountingMutationService({ execute } as never);
    await service.execute({
      workCellId: 'journal',
      workCellInput: {} as never,
      commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      adapter: expect.objectContaining({ constructor: expect.any(Function) }),
    }));
  });

  it('requires a confirmation before chart execution', async () => {
    const service = new AccountingMutationService({ execute: vi.fn() } as never);
    await expect(service.execute({
      workCellId: 'chart-of-accounts',
      workCellInput: {} as never,
      commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    })).rejects.toMatchObject({ code: 'chart_confirmation_required' });
  });

  it('routes chart cells to the chart adapter when confirmation is supplied', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 'verified' });
    const service = new AccountingMutationService({ execute } as never);
    await service.execute({
      workCellId: 'chart-of-accounts',
      workCellInput: {} as never,
      commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      confirmationId: 'confirm_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      confirmationId: 'confirm_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    }));
  });

  it('prepares only chart-of-accounts without executing it', async () => {
    const prepare = vi.fn().mockResolvedValue({ status: 'verified' });
    const service = new AccountingMutationService({ prepare } as never);
    await service.prepareChart({
      workCellInput: { workCell: { workCellId: 'chart-of-accounts' } } as never,
      commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    });
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      adapter: expect.objectContaining({ constructor: expect.any(Function) }),
    }));
  });

  it('rejects preparation for non-chart work cells', async () => {
    const prepare = vi.fn();
    const service = new AccountingMutationService({ prepare } as never);
    await expect(service.prepareChart({
      workCellInput: { workCell: { workCellId: 'journal' } } as never,
      commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    })).rejects.toMatchObject({ code: 'chart_mutation_cell_required' });
    expect(prepare).not.toHaveBeenCalled();
  });
});
