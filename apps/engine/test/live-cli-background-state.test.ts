import { describe, expect, it, vi } from 'vitest';
import {
  clearBackgroundRuntimeState,
  loadBackgroundRuntimeState,
  saveBackgroundRuntimeState,
} from '../src/live-cli/background-state.js';

describe('live CLI background state', () => {
  it('saves and loads a versioned hidden runtime state', async () => {
    const files = new Map<string, string>();
    const fileSystem = {
      mkdir: vi.fn(async () => undefined),
      readFile: vi.fn(async (path: string) => {
        const value = files.get(path);
        if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return value;
      }),
      writeFile: vi.fn(async (path: string, value: string) => {
        files.set(path, value);
      }),
      unlink: vi.fn(async () => undefined),
    };

    await saveBackgroundRuntimeState({
      path: '/state/live-cli.json',
      fileSystem,
      state: {
        schemaVersion: 1,
        enginePid: 1234,
        startedAt: '2026-07-02T00:00:00.000Z',
        command: ['plus-one', '--foreground'],
        cwd: '/repo',
        logFilePath: '/tmp/plus-one.log',
      },
    });

    await expect(loadBackgroundRuntimeState({
      path: '/state/live-cli.json',
      fileSystem,
      isProcessAlive: () => true,
    })).resolves.toEqual({
      schemaVersion: 1,
      enginePid: 1234,
      startedAt: '2026-07-02T00:00:00.000Z',
      command: ['plus-one', '--foreground'],
      cwd: '/repo',
      logFilePath: '/tmp/plus-one.log',
    });
  });

  it('clears stale state when the process is gone', async () => {
    const fileSystem = {
      mkdir: vi.fn(async () => undefined),
      readFile: vi.fn(async () => JSON.stringify({
        schemaVersion: 1,
        enginePid: 1234,
        startedAt: '2026-07-02T00:00:00.000Z',
        command: ['plus-one', '--foreground'],
        cwd: '/repo',
      })),
      writeFile: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
    };

    await expect(loadBackgroundRuntimeState({
      path: '/state/live-cli.json',
      fileSystem,
      isProcessAlive: () => false,
    })).resolves.toBeUndefined();

    expect(fileSystem.unlink).toHaveBeenCalledWith('/state/live-cli.json');
  });

  it('ignores missing state files', async () => {
    const fileSystem = {
      mkdir: vi.fn(async () => undefined),
      readFile: vi.fn(async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }),
      writeFile: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
    };

    await expect(loadBackgroundRuntimeState({
      path: '/state/live-cli.json',
      fileSystem,
      isProcessAlive: () => true,
    })).resolves.toBeUndefined();
  });

  it('clears malformed state files', async () => {
    const fileSystem = {
      mkdir: vi.fn(async () => undefined),
      readFile: vi.fn(async () => 'not json'),
      writeFile: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
    };

    await expect(loadBackgroundRuntimeState({
      path: '/state/live-cli.json',
      fileSystem,
      isProcessAlive: () => true,
    })).resolves.toBeUndefined();

    expect(fileSystem.unlink).toHaveBeenCalledWith('/state/live-cli.json');
  });

  it('clears state idempotently', async () => {
    const fileSystem = {
      mkdir: vi.fn(async () => undefined),
      readFile: vi.fn(async () => ''),
      writeFile: vi.fn(async () => undefined),
      unlink: vi.fn(async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }),
    };

    await expect(clearBackgroundRuntimeState({
      path: '/state/live-cli.json',
      fileSystem,
    })).resolves.toBeUndefined();
  });
});
