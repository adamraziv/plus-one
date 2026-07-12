import { describe, expect, it, vi } from 'vitest';
import { runGatewayRuntime } from '../src/gateway-runtime.js';

describe('gateway runtime', () => {
  it('starts HTTP before intake and shuts down intake before resources', async () => {
    const order: string[] = [];
    const runtime = {
      config: { host: '127.0.0.1', port: 4111 },
      mastra: {},
      startIntake: vi.fn(async () => { order.push('intake:start'); }),
      stopIntake: vi.fn(async () => { order.push('intake:stop'); }),
      close: vi.fn(async () => { order.push('runtime:close'); }),
    };
    const server = {
      close: vi.fn(async () => { order.push('server:close'); }),
    };

    await expect(runGatewayRuntime({
      bootstrap: vi.fn(async () => {
        order.push('bootstrap');
        return runtime as never;
      }),
      startServer: vi.fn(async () => {
        order.push('server:start');
        return server;
      }),
      waitForShutdown: vi.fn(async () => { order.push('wait'); }),
      stdout: { write: vi.fn() },
    })).resolves.toBe(0);

    expect(order).toEqual([
      'bootstrap',
      'server:start',
      'intake:start',
      'wait',
      'intake:stop',
      'server:close',
      'runtime:close',
    ]);
  });

  it('closes HTTP and runtime resources when intake startup fails', async () => {
    const failure = new Error('Telegram polling conflict');
    const server = { close: vi.fn(async () => undefined) };
    const runtime = {
      config: { host: '127.0.0.1', port: 4111 },
      mastra: {},
      startIntake: vi.fn(async () => { throw failure; }),
      stopIntake: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };

    await expect(runGatewayRuntime({
      bootstrap: vi.fn(async () => runtime as never),
      startServer: vi.fn(async () => server),
      stdout: { write: vi.fn() },
    })).rejects.toBe(failure);

    expect(server.close).toHaveBeenCalledOnce();
    expect(runtime.close).toHaveBeenCalledOnce();
  });
});
