import { serve, type ServerType } from '@hono/node-server';
import type { Mastra } from '@mastra/core';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { startMastraHttpServer } from '../src/server/mastra-http-server.js';

describe('Mastra HTTP server', () => {
  it('binds the configured host and port and exposes health state', async () => {
    type ListenOptions = Parameters<typeof serve>[0];
    let fetchHandler: ListenOptions['fetch'] | undefined;
    const close = vi.fn((callback?: (error?: Error) => void) => callback?.());
    const listen = vi.fn((options: ListenOptions, onListening?: (info: AddressInfo) => void) => {
      fetchHandler = options.fetch;
      const nodeServer = { close, once: vi.fn() } as unknown as ServerType;
      queueMicrotask(() => onListening?.({} as AddressInfo));
      return nodeServer;
    });
    const ready = vi.fn(() => false);

    const server = await startMastraHttpServer({
      mastra: {} as Mastra,
      host: '127.0.0.1',
      port: 4111,
      isReady: ready,
    }, {
      initializeMastra: vi.fn(async () => undefined),
      listen,
    });

    expect(listen).toHaveBeenCalledWith(expect.objectContaining({
      hostname: '127.0.0.1',
      port: 4111,
    }), expect.any(Function));
    await expect(await fetchHandler?.(new Request('http://localhost/health/live'), {} as never))
      .toMatchObject({ status: 200 });
    await expect(await fetchHandler?.(new Request('http://localhost/health/ready'), {} as never))
      .toMatchObject({ status: 503 });

    ready.mockReturnValue(true);
    await expect(await fetchHandler?.(new Request('http://localhost/health/ready'), {} as never))
      .toMatchObject({ status: 200 });

    await server.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects when the Node server reports a close error', async () => {
    const closeFailure = new Error('close failed');
    const server = await startMastraHttpServer({
      mastra: {} as Mastra,
      host: '127.0.0.1',
      port: 4111,
      isReady: () => true,
    }, {
      initializeMastra: vi.fn(async () => undefined),
      listen: vi.fn((_options, onListening) => {
        const nodeServer = {
          close: (callback?: (error?: Error) => void) => callback?.(closeFailure),
          once: vi.fn(),
        } as unknown as ServerType;
        queueMicrotask(onListening);
        return nodeServer;
      }),
    });

    await expect(server.close()).rejects.toBe(closeFailure);
  });
});
