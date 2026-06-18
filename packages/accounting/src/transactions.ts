import { PlusOneError } from '@plus-one/contracts';
import type { PoolClient } from 'pg';

export async function assertSerializableTransaction(client: PoolClient): Promise<void> {
  const result = await client.query<{ transaction_isolation: string; transaction_read_only: string }>(
    `SELECT current_setting('transaction_isolation') AS transaction_isolation,
            current_setting('transaction_read_only') AS transaction_read_only`,
  );
  const state = result.rows[0];
  if (state?.transaction_isolation !== 'serializable' || state.transaction_read_only !== 'off') {
    throw new PlusOneError({
      category: 'constraint_violation', code: 'serializable_transaction_required',
      message: 'Accounting mutations require an existing read-write SERIALIZABLE transaction',
      retry: 'never', receiptLookupRequired: false,
      details: {
        ...(state?.transaction_isolation === undefined ? {} : { isolation: state.transaction_isolation }),
        ...(state?.transaction_read_only === undefined ? {} : { readOnly: state.transaction_read_only }),
      },
    });
  }
}
