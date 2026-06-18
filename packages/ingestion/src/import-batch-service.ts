import { createHash } from 'node:crypto';
import { PlusOneError } from '@plus-one/contracts';
import type { DuplicateMatcher } from './duplicate-matcher.js';
import type { IngestionRepository } from './repositories/ingestion-repository.js';
import type { SourceExtractor } from './source/source-extractor.js';
import type { SourceObjectStore } from './source/source-object-store.js';

export class ImportBatchService {
  constructor(
    private readonly repository: IngestionRepository,
    private readonly store: SourceObjectStore,
    private readonly extractor: SourceExtractor,
    private readonly matcher: DuplicateMatcher,
  ) {}

  async receive(input: {
    householdId: string;
    sourceAccountId: string;
    sourceSystem: string;
    uploadReference: string;
    parserVersion: 'csv-v1' | 'json-v1';
    sourceSchemaVersion: string;
    mediaType: 'text/csv' | 'application/json';
    bytes: Buffer;
  }): Promise<unknown> {
    const contentHash = createHash('sha256').update(input.bytes).digest('hex');
    const existing = await this.repository.findBySourceScopeAndHash({ ...input, contentHash });
    if (existing !== undefined) return existing;

    const stored = await this.store.put(input.bytes, input.mediaType);
    const document = await this.repository.insertSourceDocument({ ...input, ...stored });
    const batch = await this.repository.insertBatch(document.sourceDocumentId);
    const extracted = this.extractor.extract({
      mediaType: input.mediaType,
      parserVersion: input.parserVersion,
      bytes: input.bytes,
    });
    await this.repository.insertRawRows(batch.importBatchId, extracted);
    await this.repository.transitionBatch(batch.importBatchId, 'received', 'extracted');
    void this.matcher;
    return batch;
  }

  async markChecked(importBatchId: string, artifactId: string, artifactHash: string): Promise<void> {
    const batch = await this.repository.lockBatch(importBatchId);
    if (batch?.state !== 'normalized') {
      throw new PlusOneError({
        category: 'constraint_violation',
        code: 'import_batch_not_normalized',
        message: 'Import batch is not ready for checking',
        retry: 'after_state_resolution',
        receiptLookupRequired: false,
        details: { importBatchId },
      });
    }

    const rows = await this.repository.listLatestRows(importBatchId);
    if (rows.some((row) => row.rowState === 'probable_duplicate')) {
      throw new PlusOneError({
        category: 'ambiguous_source_match',
        code: 'import_rows_require_decision',
        message: 'Probable duplicate rows require explicit checked decisions',
        retry: 'after_state_resolution',
        receiptLookupRequired: false,
        details: { importBatchId },
      });
    }

    await this.repository.transitionBatch(importBatchId, 'normalized', 'checked', {
      id: artifactId,
      hash: artifactHash,
    });
    await this.repository.transitionBatch(importBatchId, 'checked', 'awaiting_confirmation');
  }
}
