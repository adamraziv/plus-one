import 'dotenv/config';
import { resolve } from 'node:path';
import { loadDatabaseConfig } from '../config.js';
import { runMigrations, verifyMigrations } from './runner.js';

const command = process.argv[2];
const config = loadDatabaseConfig();
const options = {
  connectionString: config.migratorUrl,
  migrationDirectory: resolve('database/migrations'),
  rolePasswords: config.rolePasswords,
};

if (command === 'migrate') {
  const applied = await runMigrations(options);
  process.stdout.write(
    `${applied.length === 0 ? 'No migrations applied' : `Applied: ${applied.join(', ')}`}\n`,
  );
} else if (command === 'verify') {
  await verifyMigrations(options);
  process.stdout.write('Migration verification passed\n');
} else {
  process.stderr.write('Usage: tsx packages/database/src/migrations/cli.ts <migrate|verify>\n');
  process.exitCode = 2;
}
