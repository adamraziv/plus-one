import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  followLog as defaultFollowLog,
  formatReadableLogRecord,
  readLogTail as defaultReadLogTail,
  serializeLogEnvelope,
  type LogContext,
  type LogContextKey,
  type LogName,
  type LogQuery,
  type LogSeverityText,
  type ReadableLogRecord,
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
const LOG_NAMES: readonly LogName[] = ['agent', 'errors', 'gateway'];

export async function runLogsCli(
  argv: string[] = [],
  dependencies: RunLogsCliDependencies,
): Promise<number> {
  try {
    const parsed = parseArguments(argv, dependencies.environment ?? process.env);
    const readLogTail = dependencies.readLogTail ?? defaultReadLogTail;
    const query = { ...parsed.query, diagnostics: dependencies.stderr };
    const initial = await readLogTail(query);
    if (initial.length === 0 && !parsed.follow) {
      dependencies.stdout.write('No logs yet.\n');
      return 0;
    }
    for (const record of initial) writeRecord(record, parsed, dependencies.stdout);
    if (!parsed.follow) return 0;

    if (initial.length === 0) dependencies.stderr.write('Waiting for logs...\n');
    const followLog = dependencies.followLog ?? defaultFollowLog;
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await followLog(
        query,
        (record) => writeRecord(record, parsed, dependencies.stdout),
        controller.signal,
      );
      return 0;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.stderr.write(`Usage error: ${message.replace(/[\r\n]/g, ' ').slice(0, 200)}\n`);
    return 1;
  }
}

function writeRecord(
  record: ReadableLogRecord,
  options: { json: boolean; stack: boolean },
  output: Output,
): void {
  output.write(options.json
    ? serializeLogEnvelope(record.envelope)
    : formatReadableLogRecord(record, { stack: options.stack }));
}

function parseArguments(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): {
  query: LogQuery;
  follow: boolean;
  json: boolean;
  stack: boolean;
} {
  let index = 0;
  let log: LogName = 'agent';
  const first = argv[0];
  if (first !== undefined && !first.startsWith('-')) {
    if (!LOG_NAMES.includes(first as LogName)) throw new Error(`unknown log ${first}`);
    log = first as LogName;
    index = 1;
  }

  let lines = 50;
  let minLevel: LogSeverityText | undefined;
  const correlations: Partial<Record<LogContextKey, string>> = {};
  let component: string | undefined;
  let event: string | undefined;
  let since: Date | undefined;
  let follow = false;
  let json = false;
  let stack = false;
  while (index < argv.length) {
    const flag = argv[index];
    if (flag === undefined) throw new Error('missing log option');
    index += 1;
    if (flag === '--follow' || flag === '--json' || flag === '--stack') {
      if (flag === '--follow') follow = true;
      if (flag === '--json') json = true;
      if (flag === '--stack') stack = true;
      continue;
    }
    const value = argv[index];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    index += 1;
    if (flag === '--lines') {
      lines = positiveInteger(value, '--lines');
      continue;
    }
    if (flag === '--level') {
      minLevel = parseLevel(value);
      continue;
    }
    if (flag === '--component') {
      component = nonEmpty(value, '--component');
      continue;
    }
    if (flag === '--event') {
      event = nonEmpty(value, '--event');
      continue;
    }
    const contextKey = CONTEXT_FLAGS[flag];
    if (contextKey !== undefined) {
      correlations[contextKey] = nonEmpty(value, flag);
      continue;
    }
    if (flag === '--since') {
      since = new Date(Date.now() - relativeMilliseconds(value));
      continue;
    }
    throw new Error(`unknown option ${flag}`);
  }
  if (json && stack) throw new Error('--json cannot be combined with --stack');

  return {
    query: {
      homeDirectory: environment.PLUS_ONE_HOME ?? join(homedir(), '.plus-one'),
      log,
      lines,
      ...(minLevel === undefined ? {} : { minLevel }),
      ...(Object.keys(correlations).length === 0 ? {} : { correlations: correlations as LogContext }),
      ...(component === undefined ? {} : { component }),
      ...(event === undefined ? {} : { event }),
      ...(since === undefined ? {} : { since }),
    },
    follow,
    json,
    stack,
  };
}

function parseLevel(value: string): LogSeverityText {
  const normalized = value.toUpperCase();
  if (normalized === 'WARNING') return 'WARN';
  if (normalized === 'DEBUG'
    || normalized === 'INFO'
    || normalized === 'WARN'
    || normalized === 'ERROR') {
    return normalized;
  }
  throw new Error('invalid --level; use DEBUG, INFO, WARN, or ERROR');
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function nonEmpty(value: string, flag: string): string {
  if (value.length === 0) throw new Error(`${flag} requires a non-empty value`);
  return value;
}

function relativeMilliseconds(value: string): number {
  const match = /^(\d+)\s*([smhd])$/.exec(value.toLowerCase());
  if (match === null) throw new Error('--since must look like 30m, 1h, or 2d');
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === undefined) throw new Error('--since must look like 30m, 1h, or 2d');
  return amount * {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  }[unit as 's' | 'm' | 'h' | 'd'];
}
