// packages/accounting/src/posting/projection-hook.ts
import type { PoolClient } from 'pg';

export interface CurrentBalanceProjectionHook {
  applyJournal(client: PoolClient, input: {
    householdId: string;
    journalId: string;
    postingIds: readonly string[];
    effectiveOn: string;
  }): Promise<void>;
}
