import { afterEach, describe, expect, it } from 'vitest';
import { createIngestionHarness } from '../helpers/ingestion.js';

let harness: Awaited<ReturnType<typeof createIngestionHarness>> | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('reconciliation and monthly soft close', () => {
  it('records reconciliation, closes exact coverage, and reopens only with confirmation', async () => {
    harness = await createIngestionHarness();

    await expect(harness.recordCheckedReconciliation()).resolves.toMatchObject({
      status: 'readback_verified',
    });
    await expect(harness.closePeriod()).resolves.toMatchObject({
      status: 'readback_verified',
    });
    await expect(harness.executeReopenWithoutConfirmation()).rejects.toMatchObject({
      category: 'confirmation_required',
    });
    await expect(harness.reopenPeriod()).resolves.toMatchObject({
      status: 'readback_verified',
    });
    expect(await harness.periodEvents()).toEqual(['closed', 'reopened']);
  });
});
