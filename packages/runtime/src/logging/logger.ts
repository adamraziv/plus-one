import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { getLogContext } from './context.js';
import { RotatingFileSink } from './file-sink.js';
import { redactSecrets, sanitizeFields, serializeLogError } from './redaction.js';
import type {
  LogLevel,
  LogOptions,
  LogRecord,
  Logger,
  LoggingHandle,
  LoggingOptions,
  LogSink,
} from './types.js';

const DEFAULT_LEVEL: LogLevel = 'INFO';
const DEFAULT_MAX_SIZE_MB = 5;
const DEFAULT_BACKUP_COUNT = 3;
const ERROR_MAX_SIZE_MB = 2;
const ERROR_BACKUP_COUNT = 2;

interface LoggingState {
  directory: string;
  sinks: LogSink[];
  stderr: { write(text: string): void };
  fallbackReported: boolean;
  handle: LoggingHandle;
}

let state: LoggingState | undefined;

export function configureLogging(options: LoggingOptions = {}): LoggingHandle {
  const environment = options.environment ?? process.env;
  const directory = resolve(
    join(options.homeDirectory ?? environment.PLUS_ONE_HOME ?? join(homedir(), '.plus-one'), 'logs'),
  );
  if (state !== undefined && state.directory === directory) {
    if (options.mode === 'gateway' && state.sinks.length < 3) {
      addGatewaySink(state, directory, resolveLevel(options, environment), resolvePositive(options.maxSizeMb, environment.PLUS_ONE_LOG_MAX_SIZE_MB, DEFAULT_MAX_SIZE_MB), resolvePositive(options.backupCount, environment.PLUS_ONE_LOG_BACKUP_COUNT, DEFAULT_BACKUP_COUNT));
    }
    return state.handle;
  }
  state?.handle.close();

  const level = resolveLevel(options, environment);
  const maxSizeMb = resolvePositive(options.maxSizeMb, environment.PLUS_ONE_LOG_MAX_SIZE_MB, DEFAULT_MAX_SIZE_MB);
  const backupCount = resolvePositive(options.backupCount, environment.PLUS_ONE_LOG_BACKUP_COUNT, DEFAULT_BACKUP_COUNT);
  const stderr = options.stderr ?? process.stderr;
  const sinks: LogSink[] = [];
  const logDirectory = directory;
  try {
    sinks.push(new RotatingFileSink({
      path: join(logDirectory, 'agent.log'), level, maxBytes: maxSizeMb * 1024 * 1024, backupCount,
    }));
    sinks.push(new RotatingFileSink({
      path: join(logDirectory, 'errors.log'), level: 'WARNING', maxBytes: ERROR_MAX_SIZE_MB * 1024 * 1024, backupCount: ERROR_BACKUP_COUNT,
    }));
    if (options.mode === 'gateway') {
      addGatewaySink({ sinks }, logDirectory, level, maxSizeMb, backupCount);
    }
  } catch (error) {
    closeSinks(sinks);
    reportFallback(stderr, error);
  }

  const nextState = {} as LoggingState;
  const handle: LoggingHandle = {
    logDirectory,
    flush: () => undefined,
    close: () => {
      if (state !== nextState) return;
      closeSinks(nextState.sinks);
      state = undefined;
    },
  };
  nextState.directory = logDirectory;
  nextState.sinks = sinks;
  nextState.stderr = stderr;
  nextState.fallbackReported = false;
  nextState.handle = handle;
  state = nextState;
  return handle;
}

export function getLogger(component: string): Logger {
  return {
    debug: (event, options) => emit('DEBUG', component, event, options),
    info: (event, options) => emit('INFO', component, event, options),
    warn: (event, options) => emit('WARNING', component, event, options),
    error: (event, options) => emit('ERROR', component, event, options),
  };
}

function emit(level: LogLevel, component: string, event: string, options: LogOptions | undefined): void {
  const current = state;
  if (current === undefined) return;
  const record: LogRecord = {
    timestamp: new Date(),
    level,
    component,
    event,
    context: getLogContext(),
    fields: sanitizeFields(options?.fields),
    ...(options?.error === undefined ? {} : { error: serializeLogError(options.error) }),
  };
  for (const sink of current.sinks) {
    try {
      sink.write(record);
    } catch (error) {
      reportFallback(current.stderr, error, current);
    }
  }
}

function addGatewaySink(
  current: Pick<LoggingState, 'sinks'>,
  directory: string,
  level: LogLevel,
  maxSizeMb: number,
  backupCount: number,
): void {
  current.sinks.push(new RotatingFileSink({
    path: join(directory, 'gateway.log'),
    level,
    maxBytes: maxSizeMb * 1024 * 1024,
    backupCount,
    componentPrefixes: ['gateway'],
  }));
}

function resolveLevel(options: LoggingOptions, environment: Readonly<Record<string, string | undefined>>): LogLevel {
  return options.level ?? parseLevel(environment.PLUS_ONE_LOG_LEVEL) ?? DEFAULT_LEVEL;
}

function parseLevel(value: string | undefined): LogLevel | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toUpperCase();
  return normalized === 'DEBUG' || normalized === 'INFO' || normalized === 'WARNING' || normalized === 'ERROR'
    ? normalized
    : undefined;
}

function resolvePositive(explicit: number | undefined, configured: string | undefined, fallback: number): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 0) return explicit;
  const parsed = configured === undefined ? Number.NaN : Number(configured);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function closeSinks(sinks: readonly LogSink[]): void {
  for (const sink of sinks) sink.close();
}

function reportFallback(
  stderr: { write(text: string): void },
  error: unknown,
  current?: LoggingState,
): void {
  if (current?.fallbackReported) return;
  if (current !== undefined) current.fallbackReported = true;
  try {
    stderr.write(`WARNING logging.file_sink_failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}\n`);
  } catch {
    return;
  }
}
