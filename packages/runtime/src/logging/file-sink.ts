import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { formatLogRecord } from './formatter.js';
import type { LogLevel, LogRecord, LogSink } from './types.js';

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARNING: 2,
  ERROR: 3,
};

export interface RotatingFileSinkOptions {
  path: string;
  level: LogLevel;
  maxBytes: number;
  backupCount: number;
  componentPrefixes?: readonly string[];
}

export class RotatingFileSink implements LogSink {
  private closed = false;

  constructor(private readonly options: RotatingFileSinkOptions) {
    mkdirSync(dirname(options.path), { recursive: true });
  }

  write(record: LogRecord): void {
    if (this.closed || LEVEL_ORDER[record.level] < LEVEL_ORDER[this.options.level]) return;
    if (this.options.componentPrefixes !== undefined
      && !this.options.componentPrefixes.some((prefix) => record.component.startsWith(prefix))) {
      return;
    }
    const line = formatLogRecord(record);
    this.rotateIfNeeded(Buffer.byteLength(line, 'utf8'));
    appendFileSync(this.options.path, line, { encoding: 'utf8' });
  }

  close(): void {
    this.closed = true;
  }

  private rotateIfNeeded(nextBytes: number): void {
    if (!existsSync(this.options.path)) return;
    const size = statSync(this.options.path).size;
    if (size + nextBytes <= this.options.maxBytes) return;

    if (this.options.backupCount === 0) {
      unlinkSync(this.options.path);
      return;
    }
    for (let index = this.options.backupCount - 1; index >= 1; index -= 1) {
      const source = `${this.options.path}.${index}`;
      const target = `${this.options.path}.${index + 1}`;
      if (existsSync(source)) {
        if (index + 1 === this.options.backupCount && existsSync(target)) unlinkSync(target);
        renameSync(source, target);
      }
    }
    const firstBackup = `${this.options.path}.1`;
    if (existsSync(firstBackup)) unlinkSync(firstBackup);
    renameSync(this.options.path, firstBackup);
  }
}
