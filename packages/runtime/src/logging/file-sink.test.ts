import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NdjsonRotatingFileSink } from './file-sink.js';
import { parseLogEnvelope, serializeLogEnvelope } from './ndjson.js';
import type { LogEnvelopeV1 } from './types.js';

function envelope(eventName: string): LogEnvelopeV1 {
  return {
    schemaVersion: 1,
    timestamp: '2026-07-28T10:15:30.123Z',
    observedTimestamp: '2026-07-28T10:15:30.124Z',
    severityText: 'INFO',
    severityNumber: 9,
    eventName,
    body: eventName,
    resource: { 'service.name': 'plus-one' },
    instrumentationScope: { name: 'runtime.test' },
    attributes: {},
  };
}

describe('NdjsonRotatingFileSink', () => {
  it('writes ordered NDJSON with owner-only directory and file permissions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'plus-one-logging-'));
    await chmod(home, 0o755);
    const path = join(home, 'logs', 'agent.log');
    const sink = new NdjsonRotatingFileSink({
      name: 'agent',
      path,
      maxBytes: 1_000_000,
      backupCount: 3,
      matches: () => true,
    });

    await sink.write(envelope('first'));
    await sink.write(envelope('second'));
    await sink.close();

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines.map((line) => parseLogEnvelope(line)?.eventName)).toEqual(['first', 'second']);
    expect((await stat(join(home, 'logs'))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('rotates in order, enforces backup limits, and supports zero backups', async () => {
    const home = await mkdtemp(join(tmpdir(), 'plus-one-logging-'));
    const path = join(home, 'agent.log');
    const lineBytes = Buffer.byteLength(serializeLogEnvelope(envelope('first')));
    const sink = new NdjsonRotatingFileSink({
      name: 'agent',
      path,
      maxBytes: lineBytes + 1,
      backupCount: 2,
      matches: () => true,
    });
    await sink.write(envelope('first'));
    await sink.write(envelope('second'));
    await sink.write(envelope('third'));
    await sink.close();

    expect(parseLogEnvelope((await readFile(path, 'utf8')).trim())?.eventName).toBe('third');
    expect(parseLogEnvelope((await readFile(`${path}.1`, 'utf8')).trim())?.eventName).toBe('second');
    expect(parseLogEnvelope((await readFile(`${path}.2`, 'utf8')).trim())?.eventName).toBe('first');

    const zeroPath = join(home, 'errors.log');
    const zero = new NdjsonRotatingFileSink({
      name: 'errors',
      path: zeroPath,
      maxBytes: lineBytes + 1,
      backupCount: 0,
      matches: () => true,
    });
    await zero.write(envelope('first'));
    await zero.write(envelope('second'));
    await zero.close();
    expect(parseLogEnvelope((await readFile(zeroPath, 'utf8')).trim())?.eventName).toBe('second');
    expect((await readdir(home)).some((name) => name.startsWith('errors.log.'))).toBe(false);
  });

  it('preserves legacy, mixed, and corrupt active files before writing canonical output', async () => {
    const home = await mkdtemp(join(tmpdir(), 'plus-one-logging-'));
    const diagnostics: string[] = [];
    const fixtures = [
      { name: 'legacy', content: '2026-07-28 10:15:30.123 INFO runtime.agent: agent.started\n' },
      {
        name: 'mixed',
        content: `${serializeLogEnvelope(envelope('canonical'))}2026-07-28 10:15:30.123 INFO runtime.agent: agent.started\n`,
      },
      { name: 'corrupt', content: 'unrecognized private bytes\n' },
    ] as const;

    for (const fixture of fixtures) {
      const directory = join(home, fixture.name);
      const path = join(directory, 'agent.log');
      await mkdir(directory, { recursive: true });
      await writeFile(path, fixture.content);
      const sink = new NdjsonRotatingFileSink({
        name: fixture.name,
        path,
        maxBytes: 1_000_000,
        backupCount: 3,
        matches: () => true,
        diagnostics: { write: (text) => diagnostics.push(text) },
      });
      await sink.write(envelope('fresh'));
      await sink.close();
      const names = await readdir(directory);
      expect(names.some((name) => name.startsWith(`agent.log.${fixture.name}-`))).toBe(true);
      expect(parseLogEnvelope((await readFile(path, 'utf8')).trim())?.eventName).toBe('fresh');
    }
    expect(diagnostics).toEqual([expect.stringContaining('logging.file.corrupt_preserved')]);
  });

  it('quarantines the whole uncertain active file before later recovery', async () => {
    const home = await mkdtemp(join(tmpdir(), 'plus-one-logging-'));
    const path = join(home, 'agent.log');
    let fail = true;
    const sink = new NdjsonRotatingFileSink({
      name: 'agent',
      path,
      maxBytes: 1_000_000,
      backupCount: 3,
      matches: () => true,
      append: async (target, line) => {
        if (fail) {
          fail = false;
          await appendFile(target, line.slice(0, Math.floor(line.length / 2)));
          throw new Error('uncertain write');
        }
        await appendFile(target, line);
      },
    });

    await expect(sink.write(envelope('failed'))).rejects.toThrow('uncertain write');
    await sink.write(envelope('recovered'));
    await sink.close();

    expect((await readdir(home)).some((name) => name.startsWith('agent.log.partial-'))).toBe(true);
    expect(parseLogEnvelope((await readFile(path, 'utf8')).trim())?.eventName).toBe('recovered');
  });
});
