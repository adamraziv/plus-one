import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  followLog as defaultFollowLog,
  readLogTail as defaultReadLogTail,
  type LogContextKey,
  type LogLevel,
  type LogName,
  type LogQuery,
} from '@plus-one/runtime';

interface Output {
  write(text: string): void;
}

export interface RunLogsCliDependencies {
  environment?: Readonly<Record<string, string | undefined>>;
  stdout: Output;
  stderr: Output;
  readLogTail?: typeof defaultReadLogTail;
  followLog?: typeof defaultFollowLog;
}

const CONTEXT_FLAGS: Readonly<Record<string, LogContextKey>> = {
  '--request': 'requestId',
  '--conversation': 'conversationId',
  '--household': 'householdId',
  '--task': 'taskId',
  '--run': 'runId',
  '--delivery': 'deliveryId',
};

const LEVELS: readonly LogLevel[] = ['DEBUG', 'INFO', 'WARNING', 'ERROR'];
const LOG_NAMES: readonly LogName[] = ['agent', 'errors', 'gateway'];

export async function runLogsCli(
  argv: string[] = [],
  dependencies: RunLogsCliDependencies,
): Promise<number> {
  try {
    const parsed = parseArguments(argv, dependencies.environment ?? process.env);
    const readLogTail = dependencies.readLogTail ?? defaultReadLogTail;
    if (!parsed.follow) {
      for (const line of readLogTail(parsed.query)) dependencies.stdout.write(line);
      return 0;
    }

    const followLog = dependencies.followLog ?? defaultFollowLog;
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await followLog(parsed.query, dependencies.stdout, controller.signal);
      return 0;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  } catch (error) {
    dependencies.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function parseArguments(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): { query: LogQuery; follow: boolean } {
  let index = 0;
  let log: LogName = 'agent';
  const first = argv[0];
  if (first !== undefined && !first.startsWith('-')) {
    if (!LOG_NAMES.includes(first as LogName)) throw new Error(`Unknown log: ${first}`);
    log = first as LogName;
    index = 1;
  }

  let lines = 50;
  let minLevel: LogLevel | undefined;
  let correlation: LogQuery['correlation'];
  let component: string | undefined;
  let since: Date | undefined;
  let follow = false;
  while (index < argv.length) {
    const flag = argv[index];
    if (flag === undefined) throw new Error('Missing log option.');
    index += 1;
    if (flag === '--follow') {
      follow = true;
      continue;
    }
    const value = argv[index];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    index += 1;
    if (flag === '--lines') {
      lines = positiveInteger(value, '--lines');
      continue;
    }
    if (flag === '--level') {
      const level = value.toUpperCase() as LogLevel;
      if (!LEVELS.includes(level)) throw new Error('Invalid --level. Use DEBUG, INFO, WARNING, or ERROR.');
      minLevel = level;
      continue;
    }
    if (flag === '--component') {
      if (value.length === 0) throw new Error('--component requires a non-empty value');
      component = value;
      continue;
    }
    const contextKey = CONTEXT_FLAGS[flag];
    if (contextKey !== undefined) {
      if (correlation !== undefined) throw new Error('Only one correlation filter may be used.');
      correlation = { key: contextKey, value };
      continue;
    }
    if (flag === '--since') {
      since = new Date(Date.now() - relativeMilliseconds(value));
      continue;
    }
    throw new Error(`Unknown option: ${flag}`);
  }

  return {
    query: {
      homeDirectory: environment.PLUS_ONE_HOME ?? join(homedir(), '.plus-one'),
      log,
      lines,
      ...(minLevel === undefined ? {} : { minLevel }),
      ...(correlation === undefined ? {} : { correlation }),
      ...(component === undefined ? {} : { component }),
      ...(since === undefined ? {} : { since }),
    },
    follow,
  };
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer.`);
  return parsed;
}

function relativeMilliseconds(value: string): number {
  const match = /^(\d+)\s*([smhd])$/.exec(value.toLowerCase());
  if (match === null) throw new Error('--since must look like 30m, 1h, or 2d.');
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === undefined) throw new Error('--since must look like 30m, 1h, or 2d.');
  const multiplier = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit as 's' | 'm' | 'h' | 'd'];
  return amount * multiplier;
}
