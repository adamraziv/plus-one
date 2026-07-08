import { describe, expect, it } from 'vitest';
import { ActiveTurnRegistry } from './active-turn-registry.js';

describe('ActiveTurnRegistry', () => {
  it('runs the first turn immediately', async () => {
    const registry = new ActiveTurnRegistry();
    await expect(registry.submit('conversation-1', async () => 'delivered')).resolves.toEqual({
      status: 'started',
      result: 'delivered',
    });
  });

  it('keeps one pending replacement while a turn is active and drains it after completion', async () => {
    const registry = new ActiveTurnRegistry();
    const order: string[] = [];
    let release!: () => void;
    const active = registry.submit('conversation-1', async () => {
      order.push('active-start');
      await new Promise<void>((resolve) => { release = resolve; });
      order.push('active-end');
      return 'first';
    });

    await Promise.resolve();
    await expect(registry.submit('conversation-1', async () => {
      order.push('pending-a');
      return 'pending-a';
    })).resolves.toEqual({ status: 'queued' });
    await expect(registry.submit('conversation-1', async () => {
      order.push('pending-b');
      return 'pending-b';
    })).resolves.toEqual({ status: 'queued' });

    release();
    await active;
    await registry.drainIdle();

    expect(order).toEqual(['active-start', 'active-end', 'pending-b']);
  });

  it('does not reject drainIdle when queued work fails during the background drain', async () => {
    const registry = new ActiveTurnRegistry();
    const pendingError = new Error('delivery persistence failed');
    let releaseActive!: () => void;
    let rejectPending!: (error: Error) => void;
    let pendingStarted!: () => void;
    const pendingStartedPromise = new Promise<void>((resolve) => { pendingStarted = resolve; });
    const active = registry.submit('conversation-1', async () => {
      await new Promise<void>((resolve) => { releaseActive = resolve; });
      return 'first';
    });

    await Promise.resolve();
    await expect(registry.submit('conversation-1', async () => {
      pendingStarted();
      await new Promise<never>((_resolve, reject) => { rejectPending = reject; });
    })).resolves.toEqual({ status: 'queued' });

    releaseActive();
    await active;
    await pendingStartedPromise;
    const drain = registry.drainIdle();
    rejectPending(pendingError);

    await expect(drain).resolves.toBeUndefined();
    expect(registry.activeCount()).toBe(0);
  });

  it('cancels pending work on shutdown', async () => {
    const registry = new ActiveTurnRegistry();
    let release!: () => void;
    let pendingRan = false;
    const active = registry.submit('conversation-1', async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return 'first';
    });
    await Promise.resolve();
    await registry.submit('conversation-1', async () => {
      pendingRan = true;
      return 'pending';
    });
    const shutdown = registry.shutdown();
    release();
    await active;
    await shutdown;
    await registry.drainIdle();
    expect(pendingRan).toBe(false);
    expect(registry.activeCount()).toBe(0);
  });

  it('waits for active work to finish during shutdown', async () => {
    const registry = new ActiveTurnRegistry();
    let release!: () => void;
    let shutdownResolved = false;
    const active = registry.submit('conversation-1', async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return 'first';
    });
    await Promise.resolve();

    const shutdown = registry.shutdown().then(() => { shutdownResolved = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    try {
      expect(shutdownResolved).toBe(false);
    } finally {
      release();
      await active;
      await shutdown;
    }
    expect(registry.activeCount()).toBe(0);
  });
});
