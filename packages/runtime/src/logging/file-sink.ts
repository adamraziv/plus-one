import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import {
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import { formatLogRecord } from './formatter.js';
import { parseLogEnvelope, serializeLogEnvelope } from './ndjson.js';
import type {
  LegacyLogSink,
  LogEnvelopeV1,
  LogLevel,
  LogRecord,
  LogSink,
} from './types.js';

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
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

export class RotatingFileSink implements LegacyLogSink {
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

export interface NdjsonRotatingFileSinkOptions {
  name: string;
  path: string;
  maxBytes: number;
  backupCount: number;
  matches(record: LogEnvelopeV1): boolean;
  now?: () => Date;
  append?: (path: string, line: string) => Promise<void>;
  diagnostics?: { write(text: string): void };
}

export class NdjsonRotatingFileSink implements LogSink {
  readonly name: string;
  private readonly now: () => Date;
  private readonly append: (path: string, line: string) => Promise<void>;
  private chain: Promise<void> = Promise.resolve();
  private initialized = false;
  private uncertain = false;
  private closed = false;

  constructor(private readonly options: NdjsonRotatingFileSinkOptions) {
    this.name = options.name;
    this.now = options.now ?? (() => new Date());
    this.append = options.append ?? (async (path, line) => {
      await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
    });
  }

  matches(record: LogEnvelopeV1): boolean {
    return this.options.matches(record);
  }

  write(record: LogEnvelopeV1): Promise<void> {
    if (this.closed) return Promise.resolve();
    const operation = this.chain.then(async () => {
      await this.ensureReady();
      const line = serializeLogEnvelope(record);
      try {
        await this.rotateIfNeeded(Buffer.byteLength(line, 'utf8'));
        await this.append(this.options.path, line);
        await chmod(this.options.path, 0o600);
      } catch (error) {
        this.uncertain = true;
        throw error;
      }
    });
    this.chain = operation.catch(() => undefined);
    return operation;
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.chain;
      return;
    }
    this.closed = true;
    await this.chain;
  }

  private async ensureReady(): Promise<void> {
    await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.options.path), 0o700);
    await this.tightenBackups();
    if (this.uncertain) {
      await this.preserveActive('partial');
      this.uncertain = false;
      this.initialized = true;
      await this.ensureActive();
      return;
    }
    if (!this.initialized) {
      await this.migrateActive();
      await this.ensureActive();
      this.initialized = true;
    }
  }

  private async migrateActive(): Promise<void> {
    if (!await pathExists(this.options.path)) return;
    await chmod(this.options.path, 0o600);
    const content = await readFile(this.options.path, 'utf8');
    const lines = content.split('\n').filter((line) => line.length > 0);
    if (lines.length === 0 || lines.every((line) => parseLogEnvelope(line) !== undefined)) return;

    const recognizedLegacy = lines.map((line) => LEGACY_LINE_PATTERN.test(line));
    if (recognizedLegacy.every(Boolean)) {
      await this.preserveActive('legacy');
      return;
    }
    if (lines.some((line) => parseLogEnvelope(line) !== undefined) || recognizedLegacy.some(Boolean)) {
      await this.preserveActive('mixed');
      return;
    }
    await this.preserveActive('corrupt');
    this.writeDiagnostic(`WARN logging.file.corrupt_preserved sink=${this.name}\n`);
  }

  private async ensureActive(): Promise<void> {
    const handle = await open(this.options.path, 'a', 0o600);
    await handle.close();
    await chmod(this.options.path, 0o600);
  }

  private async preserveActive(kind: 'legacy' | 'mixed' | 'corrupt' | 'partial'): Promise<void> {
    if (!await pathExists(this.options.path)) return;
    await rename(this.options.path, `${this.options.path}.${kind}-${timestampSuffix(this.now())}`);
  }

  private async rotateIfNeeded(nextBytes: number): Promise<void> {
    if (!await pathExists(this.options.path)) {
      await this.ensureActive();
      return;
    }
    if ((await stat(this.options.path)).size + nextBytes <= this.options.maxBytes) return;

    if (this.options.backupCount === 0) {
      await unlink(this.options.path);
      await this.ensureActive();
      return;
    }
    for (let index = this.options.backupCount - 1; index >= 1; index -= 1) {
      const source = `${this.options.path}.${index}`;
      const target = `${this.options.path}.${index + 1}`;
      if (!await pathExists(source)) continue;
      if (index + 1 === this.options.backupCount && await pathExists(target)) {
        await unlink(target);
      }
      await rename(source, target);
      await chmod(target, 0o600);
    }
    const firstBackup = `${this.options.path}.1`;
    if (await pathExists(firstBackup)) await unlink(firstBackup);
    await rename(this.options.path, firstBackup);
    await chmod(firstBackup, 0o600);
    await this.ensureActive();
  }

  private async tightenBackups(): Promise<void> {
    for (let index = 1; index <= this.options.backupCount; index += 1) {
      const path = `${this.options.path}.${index}`;
      if (await pathExists(path)) await chmod(path, 0o600);
    }
  }

  private writeDiagnostic(message: string): void {
    try {
      this.options.diagnostics?.write(message);
    } catch {
      return;
    }
  }
}

const LEGACY_LINE_PATTERN = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\.\d{3}\s+(?:DEBUG|INFO|WARN|WARNING|ERROR)\s/;

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function timestampSuffix(value: Date): string {
  return value.toISOString().replace(/[:.]/g, '-');
}
