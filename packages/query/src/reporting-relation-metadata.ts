import { z } from 'zod';
import { PlusOneError } from '@plus-one/contracts';

export interface ReportingRelationMetadataReader {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: readonly R[] }>;
}

const GrainSchema = z.array(z.string().min(1).max(128)).min(1).max(16);

export async function readReportingRelationGrain(
  reader: ReportingRelationMetadataReader,
  relationName: string,
): Promise<string[]> {
  const result = await reader.query<{ grain: unknown }>(
    'SELECT grain FROM reporting.relation_metadata WHERE relation_name = $1',
    [relationName],
  );
  if (result.rows.length !== 1) {
    throw new PlusOneError({
      category: 'validation_rejected',
      code: 'reporting_relation_metadata_missing',
      message: 'Reporting relation metadata must exist exactly once for governed query execution.',
      retry: 'never',
      receiptLookupRequired: false,
      details: { relationName, rowCount: result.rows.length },
    });
  }
  const grain = GrainSchema.safeParse(result.rows[0]?.grain);
  if (!grain.success) {
    throw new PlusOneError({
      category: 'validation_rejected',
      code: 'reporting_relation_grain_invalid',
      message: 'Reporting relation metadata contains an invalid grain.',
      retry: 'never',
      receiptLookupRequired: false,
      details: { relationName },
    });
  }
  return grain.data;
}
