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

  it('returns one receipt and one journal under concurrent same-key confirmations', async () => {
    const h = await createIngestionHarness();
    harness = h;
    const checked = await h.confirm(await h.checkedImport());

    const results = await Promise.all(Array.from({ length: 4 }, () => h.execute(checked)));

    expect(new Set(results.map((result) => result.receipt.receiptId)).size).toBe(1);
    expect(await h.postedJournalCount()).toBe(1);
  });

  it('links an existing journal without posting twice', async () => {
    const h = await createIngestionHarness();
    harness = h;
    const existing = await h.postExistingJournal();
    const checked = await h.confirm(await h.checkedExistingMatch(existing.journalId));

    await expect(h.execute(checked)).resolves.toMatchObject({ status: 'readback_verified' });
    expect(await h.postedJournalCount()).toBe(1);
  });

  it('resumes committed import read-back without posting again', async () => {
    const h = await createIngestionHarness();
    harness = h;
    const checked = await h.commitImportWithoutReadback();

    await expect(h.execute(checked)).resolves.toMatchObject({ status: 'readback_verified' });
    expect(await h.postedJournalCount()).toBe(1);
  });
});
