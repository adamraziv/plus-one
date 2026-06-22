import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PlusOneError } from '@plus-one/contracts';
import { loadDatabaseConfig, normalizeDatabaseError } from './index.js';
import { listMigrationFiles } from './migrations/runner.js';

const validEnvironment = {
  DATABASE_ADMIN_URL: 'postgresql://plus_one_admin:admin@127.0.0.1:5432/plus_one',
  DATABASE_MIGRATOR_URL: 'postgresql://plus_one_migrator:migrator@127.0.0.1:5432/plus_one',
  DATABASE_ACCOUNTING_URL: 'postgresql://plus_one_accounting:accounting@127.0.0.1:5432/plus_one',
  DATABASE_PLANNING_URL: 'postgresql://plus_one_planning:planning@127.0.0.1:5432/plus_one',
  DATABASE_OPERATIONS_URL: 'postgresql://plus_one_operations:operations@127.0.0.1:5432/plus_one',
  DATABASE_QUERY_URL: 'postgresql://plus_one_query:query-password@127.0.0.1:5432/plus_one',
  DATABASE_MEMORY_URL: 'postgresql://plus_one_memory:memory-password@127.0.0.1:5432/plus_one',
  PLUS_ONE_ACCOUNTING_PASSWORD: 'accounting-password',
  PLUS_ONE_PLANNING_PASSWORD: 'planning-password',
  PLUS_ONE_OPERATIONS_PASSWORD: 'operations-password',
  PLUS_ONE_QUERY_PASSWORD: 'query-password-123',
  PLUS_ONE_MEMORY_PASSWORD: 'memory-password-123',
};

describe('database configuration', () => {
  it('parses every role boundary without exposing passwords separately from migration input', () => {
    const config = loadDatabaseConfig(validEnvironment);
    expect(config.poolUrls.query).toContain('plus_one_query');
    expect(config.rolePasswords.accounting).toBe('accounting-password');
  });

  it('rejects incomplete role configuration', () => {
    const incomplete = { ...validEnvironment, DATABASE_QUERY_URL: undefined };
    expect(() => loadDatabaseConfig(incomplete)).toThrow();
  });
});

describe('database error normalization', () => {
  it('maps serialization conflicts without returning raw SQL or database messages', () => {
    const error = normalizeDatabaseError(
      { code: '40001', message: 'raw database message', query: 'select secret' },
      { operation: 'post-journal', receiptLookupRequired: true },
    );

    expect(error).toBeInstanceOf(PlusOneError);
    expect(error.toJSON()).toMatchObject({
      category: 'serialization_conflict',
      retry: 'after_backoff',
      receiptLookupRequired: true,
      details: { operation: 'post-journal', sqlState: '40001' },
    });
    expect(JSON.stringify(error.toJSON())).not.toContain('raw database message');
    expect(JSON.stringify(error.toJSON())).not.toContain('select secret');
  });
});

describe('migration discovery', () => {
  it('returns only ordered migration SQL files with stable sha256 checksums', async () => {
    const directory = resolve('database/migrations');
    const migrations = await listMigrationFiles(directory);

    expect(migrations.map((migration) => migration.filename)).toEqual([
      '0001_platform_foundation.sql',
      '0002_database_roles.sql',
      '0003_operational_verification.sql',
      '0004_accounting_ledger.sql',
      '0005_checked_mutations.sql',
      '0006_ingestion_reconciliation.sql',
      '0007_source_scoped_fingerprints.sql',
      '0008_planning.sql',
      '0009_reporting.sql',
      '0010_query_role.sql',
      '0011_mastra_memory_storage.sql',
      '0012_policy_delivery_scheduler.sql',
    ]);

    for (const migration of migrations) {
      const sql = await readFile(resolve(directory, migration.filename), 'utf8');
      expect(migration.checksum).toBe(createHash('sha256').update(sql).digest('hex'));
    }
  });
});
