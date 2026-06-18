import { MutationReceiptIdSchema, type JsonValue } from '@plus-one/contracts';
import type { PoolClient } from 'pg';
import { normalizeDatabaseError } from '../../errors.js';

export class PostgresDomainCommandBridge {
  async claim(client: PoolClient, householdId: string, commandId: string): Promise<{
    status: 'execution_pending' | 'committed' | 'readback_verified';
    receiptId?: string;
  }> {
    try {
      const result = await client.query<{
        command_status: 'execution_pending' | 'committed' | 'readback_verified';
        receipt_id: string | null;
      }>(
        'SELECT command_status, receipt_id FROM operations.claim_mutation_command($1,$2)',
        [householdId, commandId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('Mutation command was not claimable');
      return {
        status: row.command_status,
        ...(row.receipt_id === null ? {} : { receiptId: MutationReceiptIdSchema.parse(row.receipt_id) }),
      };
    } catch (error) {
      throw normalizeDatabaseError(error, { operation: 'claim-mutation-command' });
    }
  }

  async commit(client: PoolClient, input: {
    householdId: string;
    commandId: string;
    receiptId: string;
    committedRecords: JsonValue;
    expectedState: JsonValue;
    expectedStateHash: string;
  }): Promise<{ receiptId: string; committedAt: string }> {
    try {
      const result = await client.query<{ receipt_id: string; committed_at: string }>(
        `SELECT receipt_id,
          to_char(committed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS committed_at
         FROM operations.commit_mutation_command($1,$2,$3,$4,$5,$6)`,
        [input.householdId, input.commandId, MutationReceiptIdSchema.parse(input.receiptId),
          JSON.stringify(input.committedRecords), JSON.stringify(input.expectedState),
          input.expectedStateHash],
      );
      return { receiptId: result.rows[0]!.receipt_id, committedAt: result.rows[0]!.committed_at };
    } catch (error) {
      throw normalizeDatabaseError(error, { operation: 'commit-mutation-command' });
    }
  }
}
