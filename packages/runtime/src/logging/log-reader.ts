import {
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { LogContextKey, LogLevel } from './types.js';

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARNING: 2,
  ERROR: 3,
};

const LEVEL_PATTERN = /\s(DEBUG|INFO|WARNING|ERROR)\s/;
const LOGGER_PATTERN = /\s(?:DEBUG|INFO|WARNING|ERROR)(?:\s+\[[^\]]*\])?\s+(\S+):/;
const TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})/;

export type LogName = 'agent' | 'errors' | 'gateway';

export interface LogQuery {
  homeDirectory: string;
  log: LogName;
  lines?: number;
  minLevel?: LogLevel;
  correlation?: { key: LogContextKey; value: string };
  component?: string;
  since?: Date;
}

export function readLogTail(query: LogQuery): string[] {
  const path = logPath(query.homeDirectory, query.log);
  if (!existsSync(path)) throw new Error(`Log file not found: ${path}`);
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0).map((line) => `${line}\n`);
  const filtered = lines.filter((line) => matches(line, query));
  return filtered.slice(-(query.lines ?? 50));
}

export function followLog(
  query: LogQuery,
  output: { write(text: string): void },
  signal: AbortSignal,
): Promise<void> {
  const path = logPath(query.homeDirectory, query.log);
  if (!existsSync(path)) throw new Error(`Log file not found: ${path}`);
  let offset = statSync(path).size;
  return new Promise((resolvePromise) => {
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      signal.removeEventListener('abort', stop);
      resolvePromise();
    };
    const poll = () => {
      if (stopped) return;
      try {
        const content = readFileSync(path, 'utf8');
        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes < offset) offset = 0;
        const chunk = content.slice(offset);
        offset = bytes;
        for (const line of chunk.split('\n').filter((value) => value.length > 0).map((value) => `${value}\n`)) {
          if (matches(line, query)) output.write(line);
        }
      } catch {
        stop();
      }
    };
    const timer = setInterval(poll, 300);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  });
}

function logPath(homeDirectory: string, log: LogName): string {
  const filename = log === 'agent' ? 'agent.log' : log === 'errors' ? 'errors.log' : log === 'gateway' ? 'gateway.log' : undefined;
  if (filename === undefined) throw new Error(`Unknown log: ${String(log)}`);
  return resolve(join(homeDirectory, 'logs', filename));
}

function matches(line: string, query: LogQuery): boolean {
  if (query.minLevel !== undefined) {
    const level = line.match(LEVEL_PATTERN)?.[1] as LogLevel | undefined;
    if (level === undefined || LEVEL_ORDER[level] < LEVEL_ORDER[query.minLevel]) return false;
  }
  if (query.correlation !== undefined && !line.includes(`${query.correlation.key}=${query.correlation.value}`)) return false;
  if (query.component !== undefined) {
    const component = line.match(LOGGER_PATTERN)?.[1];
    if (component === undefined || !component.startsWith(query.component)) return false;
  }
  if (query.since !== undefined) {
    const timestamp = line.match(TIMESTAMP_PATTERN)?.[1];
    if (timestamp === undefined || new Date(`${timestamp.replace(' ', 'T')}Z`) < query.since) return false;
  }
  return true;
}
