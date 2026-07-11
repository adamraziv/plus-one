import { describe, expect, it, vi } from 'vitest';
import { runGatewayRuntime } from '../src/gateway-runtime.js';

function loggingHandle() {
  return { logDirectory: '/tmp/plus-one-test-logs', flush: vi.fn(), close: vi.fn() };
}

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('gateway runtime', () => {
  it('configures logging, reports lifecycle, waits, and closes the runtime', async () => {
    const handle = loggingHandle();
    const gatewayLogger = logger();
    const runtime = { close: vi.fn(async () => undefined) };
    const configureLogging = vi.fn(() => handle);
    const bootstrap = vi.fn(async () => runtime);

    await expect(runGatewayRuntime({
      environment: { NODE_ENV: 'test' },
      configureLogging,
      logger: gatewayLogger,
      bootstrap: bootstrap as never,
      stdout: { write: vi.fn() },
      waitForShutdown: vi.fn(async () => undefined),
    })).resolves.toBe(0);

    expect(configureLogging).toHaveBeenCalledWith(expect.objectContaining({ mode: 'gateway' }));
    expect(bootstrap).toHaveBeenCalledWith({ environment: { NODE_ENV: 'test' } });
    expect(gatewayLogger.info).toHaveBeenCalledWith('runtime.started', { fields: { mode: 'gateway' } });
    expect(gatewayLogger.info).toHaveBeenCalledWith('runtime.stopped', { fields: { mode: 'gateway', status: 'stopped' } });
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('logs failed startup, closes logging, and rethrows the bootstrap error', async () => {
    const handle = loggingHandle();
    const gatewayLogger = logger();
    const failure = new Error('database unavailable');

    await expect(runGatewayRuntime({
      environment: { NODE_ENV: 'test' },
      configureLogging: vi.fn(() => handle),
      logger: gatewayLogger,
      bootstrap: vi.fn(async () => { throw failure; }) as never,
      stdout: { write: vi.fn() },
      waitForShutdown: vi.fn(),
    })).rejects.toBe(failure);

    expect(gatewayLogger.info).toHaveBeenCalledWith('runtime.stopped', {
      fields: { mode: 'gateway', status: 'failed' },
      error: failure,
    });
    expect(handle.close).toHaveBeenCalledOnce();
  });
});
