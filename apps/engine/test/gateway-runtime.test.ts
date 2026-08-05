import { describe, expect, it, vi } from 'vitest';
import { runGatewayRuntime } from '../src/gateway-runtime.js';

function loggingHandle(order?: string[]) {
  return {
    logDirectory: '/tmp/plus-one-test-logs',
    flush: vi.fn(async () => undefined),
    close: vi.fn(async () => {
      await Promise.resolve();
      order?.push('logging:close');
    }),
  };
}

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('gateway runtime', () => {
  it('configures logging, starts HTTP before intake, and shuts down in order', async () => {
    const order: string[] = [];
    const handle = loggingHandle(order);
    const gatewayLogger = logger();
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
      environment: { NODE_ENV: 'test' },
      configureLogging: vi.fn((options) => {
        expect(options).toMatchObject({
          mode: 'gateway',
          stdout: expect.any(Object),
          stderr: expect.any(Object),
        });
        return handle;
      }),
      logger: gatewayLogger,
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
      'logging:close',
    ]);
    expect(gatewayLogger.info).toHaveBeenCalledWith('runtime.started', { fields: { mode: 'gateway' } });
    expect(gatewayLogger.info).toHaveBeenCalledWith('runtime.readiness.changed', {
      fields: { mode: 'gateway', readiness: 'ready' },
    });
    expect(gatewayLogger.info).toHaveBeenCalledWith('runtime.readiness.changed', {
      fields: { mode: 'gateway', readiness: 'not_ready' },
    });
    expect(gatewayLogger.info).toHaveBeenCalledWith('runtime.stopped', {
      fields: { mode: 'gateway', status: 'stopped' },
    });
    expect(gatewayLogger.error).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('closes HTTP and runtime resources when intake startup fails', async () => {
    const failure = new Error('Telegram polling conflict');
    const handle = loggingHandle();
    const gatewayLogger = logger();
    const server = { close: vi.fn(async () => undefined) };
    const runtime = {
      config: { host: '127.0.0.1', port: 4111 },
      mastra: {},
      startIntake: vi.fn(async () => { throw failure; }),
      stopIntake: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };

    await expect(runGatewayRuntime({
      environment: { NODE_ENV: 'test' },
      configureLogging: vi.fn(() => handle),
      logger: gatewayLogger,
      bootstrap: vi.fn(async () => runtime as never),
      startServer: vi.fn(async () => server),
      stdout: { write: vi.fn() },
    })).rejects.toBe(failure);

    expect(server.close).toHaveBeenCalledOnce();
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(gatewayLogger.error).toHaveBeenCalledWith('runtime.failed', {
      fields: {
        mode: 'gateway',
        failureCategory: 'startup_failed',
      },
      error: {
        name: 'OperationalError',
        message: 'Plus One gateway runtime failed.',
        stack: 'OperationalError: Plus One gateway runtime failed.',
        code: 'gateway_runtime_failed',
        category: 'startup_failed',
      },
    });
    expect(gatewayLogger.info).not.toHaveBeenCalledWith(
      'runtime.stopped',
      expect.anything(),
    );
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('preserves the startup failure when cleanup also fails', async () => {
    const startupFailure = new Error('Telegram polling conflict');
    const cleanupFailure = new Error('server close failed');
    const runtime = {
      config: { host: '127.0.0.1', port: 4111 },
      mastra: {},
      startIntake: vi.fn(async () => { throw startupFailure; }),
      stopIntake: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };

    await expect(runGatewayRuntime({
      environment: { NODE_ENV: 'test' },
      configureLogging: vi.fn(() => loggingHandle()),
      logger: logger(),
      bootstrap: vi.fn(async () => runtime as never),
      startServer: vi.fn(async () => ({ close: vi.fn(async () => { throw cleanupFailure; }) })),
      stdout: { write: vi.fn() },
    })).rejects.toBe(startupFailure);
  });

  it('logs a bootstrap failure and closes logging', async () => {
    const handle = loggingHandle();
    const gatewayLogger = logger();
    const failure = new Error('database unavailable');

    await expect(runGatewayRuntime({
      environment: { NODE_ENV: 'test' },
      configureLogging: vi.fn(() => handle),
      logger: gatewayLogger,
      bootstrap: vi.fn(async () => { throw failure; }) as never,
      stdout: { write: vi.fn() },
    })).rejects.toBe(failure);

    expect(gatewayLogger.error).toHaveBeenCalledWith('runtime.failed', {
      fields: {
        mode: 'gateway',
        failureCategory: 'startup_failed',
      },
      error: {
        name: 'OperationalError',
        message: 'Plus One gateway runtime failed.',
        stack: 'OperationalError: Plus One gateway runtime failed.',
        code: 'gateway_runtime_failed',
        category: 'startup_failed',
      },
    });
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('records a shutdown failure as the only terminal event', async () => {
    const handle = loggingHandle();
    const gatewayLogger = logger();
    const failure = new Error('server close failed');
    const runtime = {
      config: { host: '127.0.0.1', port: 4111 },
      mastra: {},
      startIntake: vi.fn(async () => undefined),
      stopIntake: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };

    await expect(runGatewayRuntime({
      environment: { NODE_ENV: 'test' },
      configureLogging: vi.fn(() => handle),
      logger: gatewayLogger,
      bootstrap: vi.fn(async () => runtime as never),
      startServer: vi.fn(async () => ({
        close: vi.fn(async () => {
          throw failure;
        }),
      })),
      waitForShutdown: vi.fn(async () => undefined),
      stdout: { write: vi.fn() },
    })).rejects.toBe(failure);

    expect(gatewayLogger.error).toHaveBeenCalledWith('runtime.failed', {
      fields: {
        mode: 'gateway',
        failureCategory: 'shutdown_failed',
      },
      error: {
        name: 'OperationalError',
        message: 'Plus One gateway runtime failed.',
        stack: 'OperationalError: Plus One gateway runtime failed.',
        code: 'gateway_runtime_failed',
        category: 'shutdown_failed',
      },
    });
    expect(gatewayLogger.info).not.toHaveBeenCalledWith(
      'runtime.stopped',
      expect.anything(),
    );
    expect(handle.close).toHaveBeenCalledOnce();
  });
});
