import { afterEach, describe, expect, it } from 'vitest';
import { createIngestionHarness } from '../helpers/ingestion.js';

let harness: Awaited<ReturnType<typeof createIngestionHarness>> | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('checked import posting', () => {
  it('preserves source, requires confirmation, posts once, and reads lineage', async () => {
    harness = await createIngestionHarness();
    const checked = await harness.checkedImport();

    await expect(harness.execute(checked)).rejects.toMatchObject({
      category: 'confirmation_required',
    });

    const first = await harness.confirmAndExecute(checked);
    const replay = await harness.confirmAndExecute(checked);

    expect(replay.receipt.receiptId).toBe(first.receipt.receiptId);
    expect(await harness.postedJournalCount()).toBe(1);
    expect(await harness.lineage()).toMatchObject({
      normalizedRowId: expect.any(String),
      rawRowId: expect.any(String),
      importBatchId: expect.any(String),
      sourceDocumentId: expect.any(String),
    });
  });
});
