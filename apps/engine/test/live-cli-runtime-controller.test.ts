import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { LiveRuntimeController } from '../src/live-cli/runtime-controller.js';

class FakeChild extends EventEmitter {
  pid = 1234;
  killed = false;
  killSignal: NodeJS.Signals | undefined;
  unref = vi.fn();

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.killSignal = signal;
    this.emit('exit', 0, signal ?? null);
    return true;
  }
}

describe('live runtime controller', () => {
  it('starts db, verifies db, and starts engine without migrations', async () => {
    const calls: string[] = [];
    const child = new FakeChild();
    const spawnProcess = vi.fn((command, args, options) => {
      calls.push([command, ...args].join(' '));
      if (args[0] === 'dev:mastra') {
        calls.push(`engine detached ${String(options.detached)}`);
        return child as never;
      }
      const commandChild = new FakeChild();
      queueMicrotask(() => commandChild.emit('exit', 0, null));
      return commandChild as never;
    });
    const controller = new LiveRuntimeController({
      cwd: '/repo',
      now: () => new Date('2026-07-02T00:00:00.000Z'),
      spawnProcess,
      verifyDatabase: vi.fn(async () => {
        calls.push('verifyDatabase');
      }),
      state: {
        load: vi.fn(async () => undefined),
        save: vi.fn(async () => undefined),
        clear: vi.fn(async () => undefined),
      },
      isProcessAlive: () => false,
    });

    await expect(controller.start()).resolves.toEqual({ status: 'running-attached' });

    expect(calls).toEqual(['pnpm db:up', 'verifyDatabase', 'pnpm dev:mastra', 'engine detached true']);
    expect(calls).not.toContain('pnpm db:migrate');
  });

  it('stops engine before stopping db', async () => {
    const calls: string[] = [];
    const child = new FakeChild();
    const controller = new LiveRuntimeController({
      cwd: '/repo',
      now: () => new Date('2026-07-02T00:00:00.000Z'),
      spawnProcess: vi.fn((command, args) => {
        calls.push([command, ...args].join(' '));
        if (args[0] === 'dev:mastra') return child as never;
        const commandChild = new FakeChild();
        queueMicrotask(() => commandChild.emit('exit', 0, null));
        return commandChild as never;
      }),
      verifyDatabase: vi.fn(async () => undefined),
      state: {
        load: vi.fn(async () => undefined),
        save: vi.fn(async () => undefined),
        clear: vi.fn(async () => {
          calls.push('clearState');
        }),
      },
      isProcessAlive: () => false,
      killProcess: vi.fn((pid, signal) => {
        calls.push(`kill ${pid} ${signal}`);
        child.emit('exit', 0, signal);
      }),
    });

    await controller.start();
    await expect(controller.stop()).resolves.toEqual({ status: 'stopped' });

    expect(child.killed).toBe(false);
    expect(calls).toEqual(['pnpm db:up', 'pnpm dev:mastra', 'kill -1234 SIGTERM', 'clearState', 'pnpm db:down']);
  });

  it('stops a hidden background engine recorded in the state file', async () => {
    const calls: string[] = [];
    const controller = new LiveRuntimeController({
      cwd: '/repo',
      now: () => new Date('2026-07-02T00:00:00.000Z'),
      spawnProcess: vi.fn((command, args) => {
        calls.push([command, ...args].join(' '));
        const commandChild = new FakeChild();
        queueMicrotask(() => commandChild.emit('exit', 0, null));
        return commandChild as never;
      }),
      verifyDatabase: vi.fn(async () => undefined),
      state: {
        load: vi.fn(async () => ({
          schemaVersion: 1 as const,
          enginePid: 4321,
          startedAt: '2026-07-02T00:00:00.000Z',
          command: ['pnpm', 'dev:mastra'],
          cwd: '/repo',
        })),
        save: vi.fn(async () => undefined),
        clear: vi.fn(async () => {
          calls.push('clearState');
        }),
      },
      isProcessAlive: (pid) => pid === 4321,
      killProcess: vi.fn((pid, signal) => {
        calls.push(`kill ${pid} ${signal}`);
      }),
      sleep: vi.fn(async () => undefined),
      stopTimeoutMs: 0,
    });

    await controller.detect();
    await expect(controller.stop()).resolves.toEqual({ status: 'stopped' });

    expect(calls).toEqual([
      'kill -4321 SIGTERM',
      'kill -4321 SIGKILL',
      'clearState',
      'pnpm db:down',
    ]);
  });

  it('hides an attached runtime and saves state', async () => {
    const child = new FakeChild();
    const save = vi.fn(async () => undefined);
    const controller = new LiveRuntimeController({
      cwd: '/repo',
      now: () => new Date('2026-07-02T00:00:00.000Z'),
      spawnProcess: vi.fn((command, args) => {
        if (args[0] === 'dev:mastra') return child as never;
        const commandChild = new FakeChild();
        queueMicrotask(() => commandChild.emit('exit', 0, null));
        return commandChild as never;
      }),
      verifyDatabase: vi.fn(async () => undefined),
      state: {
        load: vi.fn(async () => undefined),
        save,
        clear: vi.fn(async () => undefined),
      },
      isProcessAlive: () => false,
    });

    await controller.start();
    await expect(controller.hideToBackground()).resolves.toEqual({ status: 'running-background' });

    expect(child.unref).toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith({
      schemaVersion: 1,
      enginePid: 1234,
      startedAt: '2026-07-02T00:00:00.000Z',
      command: ['pnpm', 'dev:mastra'],
      cwd: '/repo',
    });
  });

  it('reports stopped when hide is selected with nothing running', async () => {
    const controller = new LiveRuntimeController({
      cwd: '/repo',
      now: () => new Date('2026-07-02T00:00:00.000Z'),
      spawnProcess: vi.fn(),
      verifyDatabase: vi.fn(async () => undefined),
      state: {
        load: vi.fn(async () => undefined),
        save: vi.fn(async () => undefined),
        clear: vi.fn(async () => undefined),
      },
      isProcessAlive: () => false,
    });

    await expect(controller.hideToBackground()).resolves.toEqual({
      status: 'stopped',
      message: 'Nothing is running.',
    });
  });
});
