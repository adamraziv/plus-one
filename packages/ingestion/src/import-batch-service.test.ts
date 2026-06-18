import { describe, expect, it, vi } from 'vitest';
import { ImportBatchService } from './import-batch-service.js';

describe('ImportBatchService', () => {
  it('returns the existing batch for the same source scope and content hash', async () => {
    const repository = {
      findBySourceScopeAndHash: vi.fn().mockResolvedValue({ importBatchId: 'import_existing' }),
    };
    const service = new ImportBatchService(repository as never, {} as never, {} as never, {} as never);
    await expect(service.receive({
      householdId: 'hh',
      sourceAccountId: 'account',
      sourceSystem: 'bank',
      uploadReference: 'msg-2',
      parserVersion: 'csv-v1',
      sourceSchemaVersion: 'bank-v1',
      mediaType: 'text/csv',
      bytes: Buffer.from('x'),
    })).resolves.toEqual({ importBatchId: 'import_existing' });
    expect(repository.findBySourceScopeAndHash).toHaveBeenCalledOnce();
  });

  it('leaves probable duplicates staged and advances only fully checked batches', async () => {
    const repository = {
      lockBatch: vi.fn().mockResolvedValue({ state: 'normalized' }),
      listLatestRows: vi.fn().mockResolvedValue([{ rowState: 'probable_duplicate' }]),
      transitionBatch: vi.fn(),
    };
    const service = new ImportBatchService(repository as never, {} as never, {} as never, {} as never);
    await expect(service.markChecked('import_1', 'artifact_1', 'a'.repeat(64)))
      .rejects.toMatchObject({ code: 'import_rows_require_decision' });
    expect(repository.transitionBatch).not.toHaveBeenCalled();
  });
});
