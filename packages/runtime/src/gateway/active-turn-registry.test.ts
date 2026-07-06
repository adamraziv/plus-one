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

  it('cancels pending work on shutdown', async () => {
    const registry = new ActiveTurnRegistry();
    let release!: () => void;
    const active = registry.submit('conversation-1', async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return 'first';
    });
    await Promise.resolve();
    await registry.submit('conversation-1', async () => 'pending');
    await registry.shutdown();
    release();
    await active;
    await registry.drainIdle();
    expect(registry.activeCount()).toBe(0);
  });
});
