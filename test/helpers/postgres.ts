import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { loadDatabaseConfig, runMigrations, type DatabasePoolRole } from '@plus-one/database';
import { Pool } from 'pg';

export interface PostgresTestContext {
  databaseName: string;
  migratorUrl: string;
  roleUrls: Record<DatabasePoolRole, string>;
  cleanup: () => Promise<void>;
}

function databaseUrl(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function safeDatabaseName(label: string): string {
  const safeLabel = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);

  return `plus_one_test_${safeLabel}_${randomBytes(6).toString('hex')}`;
}

export async function createPostgresTestContext(
  label: string,
  migrate = true,
): Promise<PostgresTestContext> {
  const config = loadDatabaseConfig();

  if (config.adminUrl === undefined) {
    throw new Error('DATABASE_ADMIN_URL is required for database tests');
  }

  const databaseName = safeDatabaseName(label);
  const adminPool = new Pool({ connectionString: config.adminUrl, max: 1 });

  await adminPool.query(`CREATE DATABASE "${databaseName}" OWNER plus_one_migrator`);

  const migratorUrl = databaseUrl(config.migratorUrl, databaseName);
  const roleUrls = Object.fromEntries(
    Object.entries(config.poolUrls).map(([role, url]) => [role, databaseUrl(url, databaseName)]),
  ) as Record<DatabasePoolRole, string>;

  if (migrate) {
    await runMigrations({
      connectionString: migratorUrl,
      migrationDirectory: resolve('database/migrations'),
      rolePasswords: config.rolePasswords,
    });
    await adminPool.query('ALTER ROLE plus_one_migrator NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS');
  }

  return {
    databaseName,
    migratorUrl,
    roleUrls,
    cleanup: async () => {
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await adminPool.end();
    },
  };
}
