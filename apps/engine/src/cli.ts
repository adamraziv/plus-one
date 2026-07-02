import { fileURLToPath } from 'node:url';
import {
  closeDatabasePools,
  createDatabasePools,
  PostgresChannelPairingRepository,
  type DatabasePools,
} from '@plus-one/database';
import { TelegramPairingService } from '@plus-one/runtime/telegram/pairing-service';
import { loadConfig } from './config.js';
import { handleTelegramPairingCommand } from './telegram/pairing-cli.js';

type PairingService = Parameters<typeof handleTelegramPairingCommand>[0]['service'];

interface Output {
  write(text: string): void;
}

interface PlusOneCliDependencies {
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  createPools?: typeof createDatabasePools;
  closePools?: typeof closeDatabasePools;
  pairingService?: PairingService;
  approvedBy?: string;
  stdout?: Output;
  stderr?: Output;
}

export async function runPlusOneCli(
  argv: string[] = process.argv.slice(2),
  dependencies: PlusOneCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  try {
    if (argv[0] === 'telegram' && argv[1] === 'pairing') {
      const result = await runTelegramPairingCommand(argv.slice(2), dependencies);
      stdout.write(`${result}\n`);
      return 0;
    }
    stderr.write('Usage: plus-one telegram pairing approve <code> --household <household_id> | revoke <telegram_user_id> | list-pending\n');
    return 1;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runTelegramPairingCommand(
  argv: string[],
  dependencies: PlusOneCliDependencies,
): Promise<string> {
  if (dependencies.pairingService !== undefined) {
    return handleTelegramPairingCommand({
      argv,
      service: dependencies.pairingService,
      approvedBy: dependencies.approvedBy ?? approvedBy(),
    });
  }

  const config = loadConfig(dependencies.environment ?? process.env);
  const pools = (dependencies.createPools ?? createDatabasePools)(config.database.poolUrls);
  try {
    return handleTelegramPairingCommand({
      argv,
      service: new TelegramPairingService({
        repository: new PostgresChannelPairingRepository(pools.operations),
      }),
      approvedBy: dependencies.approvedBy ?? approvedBy(),
    });
  } finally {
    await (dependencies.closePools ?? closeDatabasePools)(pools as DatabasePools);
  }
}

function approvedBy(): string {
  return `cli:${process.env.USER ?? 'operator'}`;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  void runPlusOneCli()
    .then((code) => {
      process.exitCode = code;
    });
}
