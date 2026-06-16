import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PlusOneError } from '@plus-one/contracts';
import { Pool, type PoolClient } from 'pg';
import { normalizeDatabaseError } from '../errors.js';

const MIGRATION_FILENAME = /^\d{4}_[a-z0-9_]+\.sql$/;

export interface MigrationFile {
  filename: string;
  checksum: string;
  sql: string;
}

export interface MigrationRolePasswords {
  accounting: string;
  planning: string;
  operations: string;
  query: string;
  memory: string;
}

export interface MigrationRunnerOptions {
  connectionString: string;
  migrationDirectory: string;
  rolePasswords: MigrationRolePasswords;
}

export async function listMigrationFiles(directory: string): Promise<MigrationFile[]> {
  const filenames = (await readdir(directory)).filter((name) => MIGRATION_FILENAME.test(name)).sort();

  return Promise.all(
    filenames.map(async (filename) => {
      const sql = await readFile(resolve(directory, filename), 'utf8');
      return {
        filename,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    }),
  );
}

async function migrationTableExists(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('operations.schema_migrations') IS NOT NULL AS exists",
  );
  return result.rows[0]?.exists ?? false;
}

async function setRolePasswords(client: PoolClient, passwords: MigrationRolePasswords): Promise<void> {
  for (const [role, password] of Object.entries(passwords)) {
    await client.query('SELECT set_config($1, $2, false)', [`plus_one.role_password.${role}`, password]);
  }
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let singleQuoted = false;
  let dollarQuoteTag: string | undefined;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const rest = sql.slice(index);

    if (dollarQuoteTag !== undefined) {
      current += char;
      if (rest.startsWith(dollarQuoteTag)) {
        current += dollarQuoteTag.slice(1);
        index += dollarQuoteTag.length - 1;
        dollarQuoteTag = undefined;
      }
      continue;
    }

    if (singleQuoted) {
      current += char;
      if (char === "'" && sql[index + 1] === "'") {
        current += "'";
        index += 1;
      } else if (char === "'") {
        singleQuoted = false;
      }
      continue;
    }

    const dollarQuoteMatch = /^\$[A-Za-z0-9_]*\$/.exec(rest);
    if (dollarQuoteMatch !== null) {
      dollarQuoteTag = dollarQuoteMatch[0];
      current += dollarQuoteTag;
      index += dollarQuoteTag.length - 1;
      continue;
    }

    if (char === "'") {
      singleQuoted = true;
      current += char;
      continue;
    }

    if (char === ';') {
      const statement = current.trim();
      if (statement.length > 0) {
        statements.push(statement);
      }
      current = '';
      continue;
    }

    current += char;
  }

  const finalStatement = current.trim();
  if (finalStatement.length > 0) {
    statements.push(finalStatement);
  }

  return statements;
}

async function executeSqlStatements(client: PoolClient, sql: string): Promise<void> {
  for (const statement of splitSqlStatements(sql)) {
    await client.query(statement);
  }
}

export async function runMigrations(options: MigrationRunnerOptions): Promise<string[]> {
  const pool = new Pool({ connectionString: options.connectionString, max: 1 });
  const appliedNow: string[] = [];

  try {
    const migrations = await listMigrationFiles(options.migrationDirectory);
    const client = await pool.connect();

    try {
      for (const migration of migrations) {
        const tableExists = await migrationTableExists(client);

        if (tableExists) {
          const existing = await client.query<{ checksum: string }>(
            'SELECT checksum FROM operations.schema_migrations WHERE filename = $1',
            [migration.filename],
          );
          const checksum = existing.rows[0]?.checksum;

          if (checksum !== undefined) {
            if (checksum !== migration.checksum) {
              throw new PlusOneError({
                category: 'constraint_violation',
                code: 'migration_checksum_mismatch',
                message: 'An applied migration no longer matches its recorded checksum',
                retry: 'never',
                receiptLookupRequired: false,
                details: { filename: migration.filename },
              });
            }
            continue;
          }
        }

        const startedAt = performance.now();
        await client.query('RESET ROLE');
        await client.query('BEGIN');
        try {
          await setRolePasswords(client, options.rolePasswords);
          await executeSqlStatements(client, migration.sql);
          await client.query(
            'INSERT INTO operations.schema_migrations (filename, checksum, duration_ms) VALUES ($1, $2, $3)',
            [migration.filename, migration.checksum, Math.max(0, Math.round(performance.now() - startedAt))],
          );
          await client.query('COMMIT');
          appliedNow.push(migration.filename);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          await client.query('RESET ROLE');
        }
      }
    } finally {
      client.release();
    }

    return appliedNow;
  } catch (error) {
    throw normalizeDatabaseError(error, { operation: 'run-migrations' });
  } finally {
    await pool.end();
  }
}

export async function verifyMigrations(options: MigrationRunnerOptions): Promise<void> {
  const pool = new Pool({ connectionString: options.connectionString, max: 1 });

  try {
    const expected = await listMigrationFiles(options.migrationDirectory);
    const result = await pool.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM operations.schema_migrations ORDER BY filename',
    );
    const actual = result.rows;

    if (actual.length !== expected.length) {
      throw new PlusOneError({
        category: 'constraint_violation',
        code: 'migration_set_incomplete',
        message: 'The database migration set is incomplete',
        retry: 'never',
        receiptLookupRequired: false,
        details: { expectedCount: expected.length, actualCount: actual.length },
      });
    }

    expected.forEach((migration, index) => {
      const applied = actual[index];

      if (applied?.filename !== migration.filename || applied.checksum !== migration.checksum) {
        throw new PlusOneError({
          category: 'constraint_violation',
          code: 'migration_verification_failed',
          message: 'The applied migration set does not match the repository',
          retry: 'never',
          receiptLookupRequired: false,
          details: { filename: migration.filename },
        });
      }
    });
  } catch (error) {
    throw normalizeDatabaseError(error, { operation: 'verify-migrations' });
  } finally {
    await pool.end();
  }
}
