import { EventEmitter } from 'node:events';
import type { BackgroundRuntimeState } from '../src/live-cli/background-state.js';
import { describe, expect, it, vi } from 'vitest';
import {
  getGatewayDaemonStatus,
  startGatewayDaemon,
  stopGatewayDaemon,
} from '../src/daemon-runtime.js';
import type { Logger, LoggingHandle } from '@plus-one/runtime';

class FakeChild extends EventEmitter {
  readonly pid = 4321;
  readonly unref = vi.fn();
  readonly kill = vi.fn();
}

function stateStore(initial: BackgroundRuntimeState | undefined) {
  let current = initial;
  return {
    store: {
      load: vi.fn(async () => current),
      save: vi.fn(async (state: BackgroundRuntimeState) => { current = state; }),
      clear: vi.fn(async () => { current = undefined; }),
    },
    get current() {
      return current;
    },
  };
}

function logging(order: string[] = []): {
  handle: LoggingHandle;
  logger: Logger;
} {
  return {
    handle: {
      logDirectory: '/tmp/plus-one-test-logs',
      flush: vi.fn(async () => undefined),
      close: vi.fn(async () => {
        await Promise.resolve();
        order.push('logging:close');
      }),
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe('gateway daemon runtime', () => {
  it('prints starting then listening, waits for readiness, and saves detached state', async () => {
    const writes: string[] = [];
    const child = new FakeChild();
    const state = stateStore(undefined);
    const operational = logging();
    const configureLogging = vi.fn(() => operational.handle);
    const spawnProcess = vi.fn(() => child);
    let healthChecks = 0;

    await expect(startGatewayDaemon({
      environment: { ENGINE_HOST: '127.0.0.1', ENGINE_PORT: '4111' },
      stdout: { write: (text) => writes.push(text) },
      state: state.store,
      spawnProcess,
      configureLogging,
      logger: operational.logger,
      fetch: async () => {
        healthChecks += 1;
        return new Response(JSON.stringify({ status: healthChecks === 1 ? 'starting' : 'ready' }), {
          status: healthChecks === 1 ? 503 : 200,
        });
      },
      isProcessAlive: () => true,
      sleep: async () => undefined,
    })).resolves.toBe(0);

    expect(writes).toEqual([
      'Plus One gateway starting...\n',
      'Plus One gateway listening on 127.0.0.1:4111.\n',
    ]);
    expect(child.unref).toHaveBeenCalledOnce();
    expect(configureLogging).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'launcher',
    }));
    expect(spawnProcess).toHaveBeenCalledWith(expect.objectContaining({
      logFilePath: expect.stringMatching(/launcher-console\.log$/),
    }));
    expect(spawnProcess).not.toHaveBeenCalledWith(expect.objectContaining({
      logFilePath: expect.stringMatching(/gateway\.log$/),
    }));
    expect(operational.logger.info).toHaveBeenCalledWith('launcher.starting');
    expect(operational.logger.info).toHaveBeenCalledWith(
      'launcher.started',
      expect.objectContaining({ fields: expect.objectContaining({ durationMs: expect.any(Number) }) }),
    );
    expect(operational.handle.close).toHaveBeenCalledOnce();
    expect(state.current?.command).toEqual(['plus-one', '--foreground']);
    expect(state.current?.enginePid).toBe(4321);
  });

  it('stops the recorded process group and clears state', async () => {
    const state = stateStore({
      schemaVersion: 1,
      enginePid: 4321,
      startedAt: '2026-07-12T00:00:00.000Z',
      command: ['plus-one', '--foreground'],
      cwd: '/home/ubuntu/projects/plus-one/build',
    });
    const killProcess = vi.fn();
    const operational = logging();

    await expect(stopGatewayDaemon({
      state: state.store,
      stdout: { write: vi.fn() },
      isProcessAlive: () => false,
      killProcess,
      configureLogging: vi.fn(() => operational.handle),
      logger: operational.logger,
    })).resolves.toBe(0);

    expect(killProcess).toHaveBeenCalledWith(-4321, 'SIGTERM');
    expect(state.store.clear).toHaveBeenCalledOnce();
    expect(operational.logger.info).toHaveBeenCalledWith('launcher.stop.requested');
    expect(operational.logger.info).toHaveBeenCalledWith(
      'launcher.stopped',
      expect.objectContaining({ fields: expect.objectContaining({ durationMs: expect.any(Number) }) }),
    );
    expect(operational.handle.close).toHaveBeenCalledOnce();
  });

  it('reports readiness without starting or stopping anything', async () => {
    const state = stateStore({
      schemaVersion: 1,
      enginePid: 4321,
      startedAt: '2026-07-12T00:00:00.000Z',
      command: ['plus-one', '--foreground'],
      cwd: '/home/ubuntu/projects/plus-one/build',
    });
    const write = vi.fn();

    await expect(getGatewayDaemonStatus({
      state: state.store,
      stdout: { write },
      fetch: async () => new Response(JSON.stringify({ status: 'ready' }), { status: 200 }),
    })).resolves.toBe(0);

    expect(write).toHaveBeenCalledWith('Plus One is listening on 127.0.0.1:4111.\n');
    expect(state.store.save).not.toHaveBeenCalled();
    expect(state.store.clear).not.toHaveBeenCalled();
  });

  it('cleans up a detached child when state persistence fails', async () => {
    const child = new FakeChild();
    const killProcess = vi.fn();
    const state = stateStore(undefined);
    state.store.save.mockRejectedValueOnce(new Error('state unavailable'));
    const operational = logging();

    await expect(startGatewayDaemon({
      state: state.store,
      spawnProcess: () => child,
      fetch: async () => new Response(JSON.stringify({ status: 'ready' }), { status: 200 }),
      isProcessAlive: () => true,
      killProcess,
      sleep: async () => undefined,
      configureLogging: vi.fn(() => operational.handle),
      logger: operational.logger,
    })).rejects.toThrow('state unavailable');

    expect(child.unref).toHaveBeenCalledOnce();
    expect(killProcess).toHaveBeenCalledWith(-4321, 'SIGTERM');
    expect(operational.logger.error).toHaveBeenCalledWith(
      'launcher.start.failed',
      expect.objectContaining({
        fields: expect.objectContaining({ failureCategory: 'state_save_failed' }),
        error: {
          name: 'OperationalError',
          message: 'Plus One gateway launcher start failed.',
          stack: 'OperationalError: Plus One gateway launcher start failed.',
          code: 'gateway_launcher_start_failed',
          category: 'state_save_failed',
        },
      }),
    );
    expect(operational.handle.close).toHaveBeenCalledOnce();
  });

  it('records stop failure and closes launcher logging before rejecting', async () => {
    const state = stateStore({
      schemaVersion: 1,
      enginePid: 4321,
      startedAt: '2026-07-12T00:00:00.000Z',
      command: ['plus-one', '--foreground'],
      cwd: '/home/ubuntu/projects/plus-one/build',
    });
    const failure = new Error('state clear failed');
    state.store.clear.mockRejectedValueOnce(failure);
    const operational = logging();

    await expect(stopGatewayDaemon({
      state: state.store,
      stdout: { write: vi.fn() },
      isProcessAlive: () => false,
      killProcess: vi.fn(),
      configureLogging: vi.fn(() => operational.handle),
      logger: operational.logger,
    })).rejects.toBe(failure);

    expect(operational.logger.error).toHaveBeenCalledWith(
      'launcher.stop.failed',
      expect.objectContaining({
        fields: expect.objectContaining({ failureCategory: 'stop_failed' }),
        error: {
          name: 'OperationalError',
          message: 'Plus One gateway launcher stop failed.',
          stack: 'OperationalError: Plus One gateway launcher stop failed.',
          code: 'gateway_launcher_stop_failed',
          category: 'stop_failed',
        },
      }),
    );
    expect(operational.handle.close).toHaveBeenCalledOnce();
  });
});
