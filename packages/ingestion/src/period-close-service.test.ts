import { describe, expect, it, vi } from 'vitest';
import { PeriodCloseService } from './period-close-service.js';

describe('PeriodCloseService', () => {
  it('rejects close when durable coverage differs from the checked proposal', async () => {
    const repository = {
      readPeriodCoverage: vi.fn().mockResolvedValue({
        reconciliationIds: ['recon_1'],
        unresolvedDiscrepancyIds: ['discrepancy_1'],
        responsibleArtifactIds: ['artifact_1'],
        periodStatus: 'open',
      }),
    };
    const service = new PeriodCloseService(repository as never);
    await expect(service.close({} as never, {
      householdId: 'hh',
      bookId: 'book',
      periodId: 'period',
      reconciliationIds: ['recon_1'],
      unresolvedDiscrepancyIds: [],
      responsibleArtifactIds: ['artifact_1'],
    } as never, { checkedProposalId: 'artifact_2' } as never))
      .rejects.toMatchObject({ code: 'period_close_evidence_mismatch' });
  });

  it('requires confirmed reopen to reference the latest close event', async () => {
    const repository = {
      readLatestPeriodEvent: vi.fn().mockResolvedValue({
        periodEventId: 'periodevent_latest',
        eventType: 'closed',
      }),
      insertPeriodEvent: vi.fn(),
      setPeriodStatus: vi.fn(),
    };
    const service = new PeriodCloseService(repository as never);
    await expect(service.reopen({} as never, {
      householdId: 'hh',
      bookId: 'book',
      periodId: 'period',
      priorCloseEventId: 'periodevent_old',
      reason: 'Correction required',
    } as never, { checkedProposalId: 'artifact_1', confirmationId: 'confirm_1' } as never))
      .rejects.toMatchObject({ code: 'period_reopen_stale_close' });
  });
});
