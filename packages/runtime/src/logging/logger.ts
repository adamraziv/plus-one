import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { getLogContext } from './context.js';
import { LogDispatcher } from './dispatcher.js';
import {
  type CatalogLogger,
  type LogComponent,
} from './event-catalog.js';
import { NdjsonRotatingFileSink } from './file-sink.js';
import { buildLogEnvelope } from './record-builder.js';
import { NdjsonStdoutSink } from './stdout-sink.js';
import type {
  LogOptions,
  Logger,
  LoggingHandle,
  LoggingOptions,
  LogSeverityText,
  LogSink,
} from './types.js';

const DEFAULT_LEVEL: LogSeverityText = 'INFO';
const DEFAULT_MAX_SIZE_MB = 5;
const DEFAULT_BACKUP_COUNT = 3;
const ERROR_MAX_SIZE_MB = 2;
const ERROR_BACKUP_COUNT = 2;
const SEVERITY_ORDER: Record<LogSeverityText, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

interface LoggingState {
  key: string;
  dispatcher: LogDispatcher;
  level: LogSeverityText;
  clock: () => Date;
  resource: Readonly<Record<string, string>>;
  handle: LoggingHandle;
}

let state: LoggingState | undefined;

export function configureLogging(options: LoggingOptions = {}): LoggingHandle {
  const environment = options.environment ?? process.env;
  const mode = options.mode ?? 'cli';
  const logDirectory = resolve(
    join(options.homeDirectory ?? environment.PLUS_ONE_HOME ?? join(homedir(), '.plus-one'), 'logs'),
  );
  const key = `${logDirectory}\0${mode}`;
  if (state?.key === key) return state.handle;

  const previous = state;
  state = undefined;
  const startAfter = previous?.handle.close() ?? Promise.resolve();
  const level = resolveLevel(options, environment);
  const stderr = options.stderr ?? process.stderr;
  const stdout = options.stdout ?? process.stdout;
  const clock = options.clock ?? (() => new Date());
  const resource = Object.freeze({
    'service.name': 'plus-one',
    'service.instance.id': options.instanceId ?? `instance_${randomUUID()}`,
    'deployment.environment.name': deploymentEnvironment(environment.NODE_ENV),
  });
  const sinks = options.sinks ?? defaultSinks({
    logDirectory,
    mode,
    level,
    maxSizeMb: resolveNonNegative(
      options.maxSizeMb,
      environment.PLUS_ONE_LOG_MAX_SIZE_MB,
      DEFAULT_MAX_SIZE_MB,
    ),
    backupCount: Math.floor(resolveNonNegative(
      options.backupCount,
      environment.PLUS_ONE_LOG_BACKUP_COUNT,
      DEFAULT_BACKUP_COUNT,
    )),
    stderr,
    stdout,
    stdoutEnabled: mode === 'gateway' && environment.PLUS_ONE_LOG_STDOUT?.toLowerCase() === 'true',
  });
  const dispatcher = new LogDispatcher({
    sinks,
    stderr,
    ...(options.queueCapacity === undefined ? {} : { capacity: options.queueCapacity }),
    startAfter,
    now: () => clock().getTime(),
  });

  const nextState = {} as LoggingState;
  let closePromise: Promise<void> | undefined;
  const handle: LoggingHandle = {
    logDirectory,
    flush: async () => dispatcher.flush(),
    close: () => {
      closePromise ??= (async () => {
        await dispatcher.close();
        if (state === nextState) state = undefined;
      })();
      return closePromise;
    },
  };
  nextState.key = key;
  nextState.dispatcher = dispatcher;
  nextState.level = level;
  nextState.clock = clock;
  nextState.resource = resource;
  nextState.handle = handle;
  state = nextState;
  return handle;
}

export function getLogger<C extends LogComponent>(
  component: C,
): CatalogLogger<C>;
export function getLogger(component: string): Logger;
export function getLogger(
  component: string,
): Logger | CatalogLogger<LogComponent> {
  const logger: Logger = {
    debug: (event, options) => emit('DEBUG', component, event, options),
    info: (event, options) => emit('INFO', component, event, options),
    warn: (event, options) => emit('WARN', component, event, options),
    error: (event, options) => emit('ERROR', component, event, options),
  };
  return logger;
}

function emit(
  severityText: LogSeverityText,
  component: string,
  eventName: string,
  options: LogOptions | undefined,
): void {
  const current = state;
  if (current === undefined || SEVERITY_ORDER[severityText] < SEVERITY_ORDER[current.level]) return;
  const timestamp = current.clock();
  const observedTimestamp = current.clock();
  current.dispatcher.dispatch(buildLogEnvelope({
    component,
    eventName,
    severityText,
    ...(options?.fields === undefined ? {} : { fields: options.fields }),
    ...(options?.error === undefined ? {} : { error: options.error }),
    context: getLogContext(),
    timestamp,
    observedTimestamp,
    resource: current.resource,
  }));
}

function defaultSinks(input: {
  logDirectory: string;
  mode: 'cli' | 'gateway' | 'launcher';
  level: LogSeverityText;
  maxSizeMb: number;
  backupCount: number;
  stderr: { write(text: string): void };
  stdout: { write(text: string): void };
  stdoutEnabled: boolean;
}): readonly LogSink[] {
  if (input.mode === 'launcher') {
    return [new NdjsonRotatingFileSink({
      name: 'launcher',
      path: join(input.logDirectory, 'launcher.log'),
      maxBytes: input.maxSizeMb * 1024 * 1024,
      backupCount: input.backupCount,
      matches: (record) => record.instrumentationScope.name === 'engine.gateway.launcher',
      diagnostics: input.stderr,
    })];
  }

  const sinks: LogSink[] = [
    new NdjsonRotatingFileSink({
      name: 'agent',
      path: join(input.logDirectory, 'agent.log'),
      maxBytes: input.maxSizeMb * 1024 * 1024,
      backupCount: input.backupCount,
      matches: () => true,
      diagnostics: input.stderr,
    }),
    new NdjsonRotatingFileSink({
      name: 'errors',
      path: join(input.logDirectory, 'errors.log'),
      maxBytes: ERROR_MAX_SIZE_MB * 1024 * 1024,
      backupCount: ERROR_BACKUP_COUNT,
      matches: (record) => SEVERITY_ORDER[record.severityText] >= SEVERITY_ORDER.WARN,
      diagnostics: input.stderr,
    }),
  ];
  if (input.mode === 'gateway') {
    sinks.push(new NdjsonRotatingFileSink({
      name: 'gateway',
      path: join(input.logDirectory, 'gateway.log'),
      maxBytes: input.maxSizeMb * 1024 * 1024,
      backupCount: input.backupCount,
      matches: (record) => (
        record.instrumentationScope.name.startsWith('gateway.')
        || record.instrumentationScope.name === 'engine.gateway'
      ),
      diagnostics: input.stderr,
    }));
    if (input.stdoutEnabled) {
      sinks.push(new NdjsonStdoutSink({
        name: 'stdout',
        output: input.stdout,
        matches: () => true,
      }));
    }
  }
  return sinks;
}

function resolveLevel(
  options: LoggingOptions,
  environment: Readonly<Record<string, string | undefined>>,
): LogSeverityText {
  return normalizeLevel(options.level)
    ?? normalizeLevel(environment.PLUS_ONE_LOG_LEVEL)
    ?? DEFAULT_LEVEL;
}

function normalizeLevel(value: string | undefined): LogSeverityText | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toUpperCase();
  if (normalized === 'WARNING') return 'WARN';
  return normalized === 'DEBUG'
    || normalized === 'INFO'
    || normalized === 'WARN'
    || normalized === 'ERROR'
    ? normalized
    : undefined;
}

function resolveNonNegative(
  explicit: number | undefined,
  configured: string | undefined,
  fallback: number,
): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 0) return explicit;
  const parsed = configured === undefined ? Number.NaN : Number(configured);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function deploymentEnvironment(value: string | undefined): string {
  return value === 'development' || value === 'test' || value === 'production'
    ? value
    : 'unknown';
}
