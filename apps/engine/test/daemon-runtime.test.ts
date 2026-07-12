import { EventEmitter } from 'node:events';
import type { BackgroundRuntimeState } from '../src/live-cli/background-state.js';
import { describe, expect, it, vi } from 'vitest';
import {
  getGatewayDaemonStatus,
  startGatewayDaemon,
  stopGatewayDaemon,
} from '../src/daemon-runtime.js';

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

describe('gateway daemon runtime', () => {
  it('prints starting then listening, waits for readiness, and saves detached state', async () => {
    const writes: string[] = [];
    const child = new FakeChild();
    const state = stateStore(undefined);
    let healthChecks = 0;

    await expect(startGatewayDaemon({
      environment: { ENGINE_HOST: '127.0.0.1', ENGINE_PORT: '4111' },
      stdout: { write: (text) => writes.push(text) },
      state: state.store,
      spawnProcess: () => child,
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

    await expect(stopGatewayDaemon({
      state: state.store,
      stdout: { write: vi.fn() },
      isProcessAlive: () => false,
      killProcess,
    })).resolves.toBe(0);

    expect(killProcess).toHaveBeenCalledWith(-4321, 'SIGTERM');
    expect(state.store.clear).toHaveBeenCalledOnce();
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
});
