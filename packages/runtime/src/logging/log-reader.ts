import {
  open,
  readdir,
  stat,
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { EVENT_CATALOG } from './event-catalog.js';
import { parseLogEnvelope } from './ndjson.js';
import { sanitizeLogString } from './redaction.js';
import { SEVERITY_NUMBER } from './record-builder.js';
import type {
  LogAttributes,
  LogContext,
  LogContextKey,
  LogEnvelopeV1,
  LogName,
  LogQuery,
  LogSeverityText,
  ReadableLogRecord,
} from './types.js';

const READ_CHUNK_BYTES = 64 * 1024;
const FOLLOW_INTERVAL_MS = 100;
const SEVERITY_ORDER: Record<LogSeverityText, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};
const CONTEXT_ATTRIBUTES: Record<LogContextKey, string> = {
  requestId: 'request.id',
  conversationId: 'plus_one.conversation.id',
  householdId: 'plus_one.household.id',
  taskId: 'plus_one.task.id',
  runId: 'plus_one.run.id',
  deliveryId: 'plus_one.delivery.id',
};
const LEGACY_COMPONENTS: ReadonlySet<string> = new Set(
  Object.values(EVENT_CATALOG).map(({ component }) => component),
);
const LEGACY_EVENT_MAP: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.keys(EVENT_CATALOG).map((eventName) => [eventName, eventName])),
  'delivery.processed': 'delivery.processing.completed',
  'orchestrator.delegate.completed': 'orchestrator.delegation.completed',
  'orchestrator.delegate.failed': 'orchestrator.delegation.failed',
};
const LEGACY_PATTERN = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}\.\d{3})\s+(DEBUG|INFO|WARN|WARNING|ERROR)(?:\s+\[([^\]]*)\])?\s+(\S+):\s*(.*)$/;

interface SourceDescriptor {
  path: string;
  generation: number;
  active: boolean;
}

interface PhysicalLine {
  text: string;
  byteOffset: number;
}

interface FollowState {
  inode: number | bigint;
  offset: number;
}

export async function readLogTail(query: LogQuery): Promise<ReadableLogRecord[]> {
  assertLogName(query.log);
  const sources = await discoverSources(query.homeDirectory, query.log);
  const records: ReadableLogRecord[] = [];
  for (const source of sources) {
    try {
      const { lines } = await readLines(source.path, 0, false);
      for (const line of lines) {
        const record = normalizeLine(line, source, query.diagnostics);
        if (record !== undefined && matches(record.envelope, query)) records.push(record);
      }
    } catch {
      writeDiagnostic(query.diagnostics, source.path, 0, 'unreadable');
    }
  }
  records.sort(compareRecords);
  return records.slice(-(query.lines ?? 50));
}

export async function followLog(
  query: LogQuery,
  onRecord: (record: ReadableLogRecord) => void,
  signal: AbortSignal,
): Promise<void> {
  assertLogName(query.log);
  const states = new Map<string, FollowState>();
  for (const source of await discoverSources(query.homeDirectory, query.log)) {
    try {
      const metadata = await stat(source.path);
      states.set(source.path, { inode: metadata.ino, offset: metadata.size });
    } catch {
      continue;
    }
  }

  while (!signal.aborted) {
    await waitForPoll(signal);
    if (signal.aborted) break;
    const batch: ReadableLogRecord[] = [];
    const sources = await discoverSources(query.homeDirectory, query.log);
    for (const source of sources) {
      let metadata;
      try {
        metadata = await stat(source.path);
      } catch {
        continue;
      }
      const previous = states.get(source.path);
      if (previous === undefined && !source.active) {
        states.set(source.path, { inode: metadata.ino, offset: metadata.size });
        continue;
      }
      const offset = previous === undefined
        || previous.inode !== metadata.ino
        || metadata.size < previous.offset
        ? 0
        : previous.offset;
      const result = await readLines(source.path, offset, true).catch(() => undefined);
      if (result === undefined) continue;
      states.set(source.path, { inode: metadata.ino, offset: result.nextOffset });
      for (const line of result.lines) {
        const record = normalizeLine(line, source, query.diagnostics);
        if (record !== undefined && matches(record.envelope, query)) batch.push(record);
      }
    }
    batch.sort(compareRecords);
    for (const record of batch) onRecord(record);
  }
}

async function discoverSources(
  homeDirectory: string,
  log: LogName,
): Promise<SourceDescriptor[]> {
  const resolvedHome = resolve(homeDirectory);
  const directories: { path: string; rollback: boolean }[] = [{
    path: join(resolvedHome, 'logs'),
    rollback: false,
  }];
  try {
    const entries = await readdir(resolvedHome, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('logs.rollback-')) {
        directories.push({ path: join(resolvedHome, entry.name), rollback: true });
      }
    }
  } catch {
    return [];
  }

  const bases = log === 'agent'
    ? ['agent.log']
    : log === 'errors'
      ? ['errors.log']
      : ['gateway.log', 'launcher.log'];
  const sources: SourceDescriptor[] = [];
  for (const directory of directories.sort((left, right) => left.path.localeCompare(right.path))) {
    let entries;
    try {
      entries = await readdir(directory.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      for (const base of bases) {
        const generation = sourceGeneration(entry.name, base, directory.rollback);
        if (generation === undefined) continue;
        sources.push({
          path: resolve(join(directory.path, entry.name)),
          generation,
          active: !directory.rollback && entry.name === base,
        });
        break;
      }
    }
  }
  return sources.sort((left, right) => (
    left.generation - right.generation || left.path.localeCompare(right.path)
  ));
}

function sourceGeneration(
  filename: string,
  base: string,
  rollback: boolean,
): number | undefined {
  const rollbackOffset = rollback ? -20_000 : 0;
  if (filename === base) return rollbackOffset;
  const numbered = new RegExp(`^${escapeRegExp(base)}\\.(\\d+)$`).exec(filename);
  if (numbered !== null) return rollbackOffset - Number(numbered[1]);
  if (new RegExp(`^${escapeRegExp(base)}\\.(?:legacy|mixed|corrupt|partial)(?:-|$)`).test(filename)) {
    return rollbackOffset - 10_000;
  }
  return undefined;
}

async function readLines(
  path: string,
  startOffset: number,
  completeOnly: boolean,
): Promise<{ lines: PhysicalLine[]; nextOffset: number }> {
  const handle = await open(path, 'r');
  try {
    const lines: PhysicalLine[] = [];
    let position = startOffset;
    let buffered = Buffer.alloc(0);
    let bufferedOffset = startOffset;
    while (true) {
      const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      buffered = Buffer.concat([buffered, chunk.subarray(0, bytesRead)]);
      let newline;
      while ((newline = buffered.indexOf(0x0a)) !== -1) {
        const content = buffered.subarray(0, newline);
        lines.push({
          text: stripCarriageReturn(content.toString('utf8')),
          byteOffset: bufferedOffset,
        });
        buffered = buffered.subarray(newline + 1);
        bufferedOffset += newline + 1;
      }
    }
    if (!completeOnly && buffered.length > 0) {
      lines.push({
        text: stripCarriageReturn(buffered.toString('utf8')),
        byteOffset: bufferedOffset,
      });
      bufferedOffset += buffered.length;
    }
    return { lines, nextOffset: bufferedOffset };
  } finally {
    await handle.close();
  }
}

function normalizeLine(
  line: PhysicalLine,
  source: SourceDescriptor,
  diagnostics: LogQuery['diagnostics'],
): ReadableLogRecord | undefined {
  if (line.text.length === 0) return undefined;
  const canonical = parseLogEnvelope(line.text);
  if (canonical !== undefined) {
    return {
      envelope: canonical,
      source: {
        path: source.path,
        format: 'ndjson',
        generation: source.generation,
        byteOffset: line.byteOffset,
      },
    };
  }
  const legacy = parseLegacy(line.text);
  if (legacy !== undefined) {
    return {
      envelope: legacy.envelope,
      source: {
        path: source.path,
        format: 'legacy',
        generation: source.generation,
        byteOffset: line.byteOffset,
      },
      legacyDisplayMessage: legacy.display,
    };
  }
  writeDiagnostic(diagnostics, source.path, line.byteOffset, 'malformed');
  return undefined;
}

function parseLegacy(line: string): {
  envelope: LogEnvelopeV1;
  display: string;
} | undefined {
  const match = LEGACY_PATTERN.exec(line);
  if (match === null) return undefined;
  const [, date, time, rawSeverity, rawContext = '', rawComponent, remainder] = match;
  if (date === undefined
    || time === undefined
    || rawSeverity === undefined
    || rawComponent === undefined
    || remainder === undefined) {
    return undefined;
  }
  const timestamp = new Date(`${date}T${time}Z`);
  if (!Number.isFinite(timestamp.getTime())) return undefined;
  const severityText = rawSeverity === 'WARNING' ? 'WARN' : rawSeverity as LogSeverityText;
  const attributes: Record<string, string | number | boolean> = {
    'log.source.format': 'legacy',
  };
  addLegacyContext(attributes, rawContext);
  const [legacyEvent = '', ...fieldTokens] = remainder.split(/\s+/);
  const mappedEvent = LEGACY_EVENT_MAP[legacyEvent];
  if (mappedEvent !== undefined) attributes['legacy.event.name'] = mappedEvent;
  addLegacyFields(attributes, fieldTokens);
  const component = LEGACY_COMPONENTS.has(rawComponent) ? rawComponent : 'runtime.legacy';
  return {
    envelope: {
      schemaVersion: 1,
      timestamp: timestamp.toISOString(),
      observedTimestamp: timestamp.toISOString(),
      severityText,
      severityNumber: SEVERITY_NUMBER[severityText],
      eventName: 'legacy.record',
      body: 'legacy.record',
      resource: { 'service.name': 'plus-one' },
      instrumentationScope: { name: component },
      attributes,
    },
    display: sanitizeLogString(remainder),
  };
}

function addLegacyContext(
  attributes: Record<string, string | number | boolean>,
  context: string,
): void {
  const legacyNames: Readonly<Record<string, string>> = {
    requestId: CONTEXT_ATTRIBUTES.requestId,
    conversationId: CONTEXT_ATTRIBUTES.conversationId,
    householdId: CONTEXT_ATTRIBUTES.householdId,
    taskId: CONTEXT_ATTRIBUTES.taskId,
    runId: CONTEXT_ATTRIBUTES.runId,
    deliveryId: CONTEXT_ATTRIBUTES.deliveryId,
  };
  for (const token of context.split(/\s+/)) {
    const separator = token.indexOf('=');
    if (separator < 1) continue;
    const output = legacyNames[token.slice(0, separator)];
    if (output !== undefined) attributes[output] = sanitizeLogString(token.slice(separator + 1));
  }
}

function addLegacyFields(
  attributes: Record<string, string | number | boolean>,
  tokens: readonly string[],
): void {
  const safeFields: Readonly<Record<string, { output: string; type: 'string' | 'number' }>> = {
    status: { output: 'status', type: 'string' },
    channel: { output: 'channel', type: 'string' },
    durationMs: { output: 'duration.ms', type: 'number' },
    failureCategory: { output: 'failure.category', type: 'string' },
  };
  for (const token of tokens) {
    const separator = token.indexOf('=');
    if (separator < 1) continue;
    const definition = safeFields[token.slice(0, separator)];
    if (definition === undefined) continue;
    const value = token.slice(separator + 1);
    if (definition.type === 'number') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) attributes[definition.output] = parsed;
    } else {
      attributes[definition.output] = sanitizeLogString(value);
    }
  }
}

function matches(envelope: LogEnvelopeV1, query: LogQuery): boolean {
  if (query.minLevel !== undefined
    && SEVERITY_ORDER[envelope.severityText] < SEVERITY_ORDER[query.minLevel]) return false;
  if (query.component !== undefined
    && !envelope.instrumentationScope.name.startsWith(query.component)) return false;
  if (query.event !== undefined && !envelope.eventName.startsWith(query.event)) return false;
  if (query.since !== undefined && new Date(envelope.timestamp) < query.since) return false;
  if (query.correlations !== undefined && !matchesCorrelations(envelope.attributes, query.correlations)) {
    return false;
  }
  return true;
}

function matchesCorrelations(attributes: LogAttributes, correlations: LogContext): boolean {
  for (const [key, value] of Object.entries(correlations)) {
    if (value === undefined) continue;
    const attribute = CONTEXT_ATTRIBUTES[key as LogContextKey];
    if (attributes[attribute] !== value) return false;
  }
  return true;
}

function compareRecords(left: ReadableLogRecord, right: ReadableLogRecord): number {
  return Date.parse(left.envelope.timestamp) - Date.parse(right.envelope.timestamp)
    || left.source.generation - right.source.generation
    || left.source.byteOffset - right.source.byteOffset
    || left.source.path.localeCompare(right.source.path);
}

function assertLogName(log: LogName): void {
  if (log !== 'agent' && log !== 'errors' && log !== 'gateway') {
    throw new Error(`Unknown log: ${String(log)}`);
  }
}

function writeDiagnostic(
  output: LogQuery['diagnostics'],
  path: string,
  offset: number,
  category: string,
): void {
  try {
    output?.write(
      `WARN logging.record.${category} source=${sanitizeLogString(basename(path), 200)} offset=${offset}\n`,
    );
  } catch {
    return;
  }
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolvePromise();
    };
    const timer = setTimeout(finish, FOLLOW_INTERVAL_MS);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function stripCarriageReturn(value: string): string {
  return value.endsWith('\r') ? value.slice(0, -1) : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
