import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { runLiveCliSession } from '../src/live-cli/session.js';

class FakeInput extends EventEmitter {
  isTTY = true;
  rawMode?: boolean;

  setRawMode(value: boolean): void {
    this.rawMode = value;
  }

  resume(): void {}
  pause(): void {}
}

describe('live CLI session', () => {
  it('renders the main menu and restores raw mode on exit', async () => {
    const input = new FakeInput();
    const write = vi.fn();
    const runtime = {
      detect: vi.fn(async () => 'stopped' as const),
      currentStatus: vi.fn(() => 'stopped' as const),
      start: vi.fn(),
      stop: vi.fn(async () => ({ status: 'stopped' as const })),
      hideToBackground: vi.fn(),
    };

    const result = runLiveCliSession({
      stdin: input as never,
      stdout: { isTTY: true, columns: 80, rows: 24, write },
      stderr: { write: vi.fn() },
      environment: { NO_COLOR: '1' },
      runtime,
      telegram: {
        status: () => 'TELEGRAM_BOT_TOKEN: missing',
        listPending: vi.fn(),
        approve: vi.fn(),
        revoke: vi.fn(),
      },
    });

    input.emit('keypress', '', { name: 'q' });

    await expect(result).resolves.toBe(0);
    expect(write.mock.calls.map((call) => call[0]).join('')).toContain('Plus One');
    expect(runtime.stop).toHaveBeenCalled();
    expect(input.rawMode).toBe(false);
  });

  it('starts, hides, and exits without stopping a hidden runtime', async () => {
    const input = new FakeInput();
    const runtimeStatus = { value: 'stopped' as 'stopped' | 'running-attached' | 'running-background' };
    const runtime = {
      detect: vi.fn(async () => runtimeStatus.value),
      currentStatus: vi.fn(() => runtimeStatus.value),
      start: vi.fn(async () => {
        runtimeStatus.value = 'running-attached';
        return { status: runtimeStatus.value };
      }),
      stop: vi.fn(async () => {
        runtimeStatus.value = 'stopped';
        return { status: runtimeStatus.value };
      }),
      hideToBackground: vi.fn(async () => {
        runtimeStatus.value = 'running-background';
        return { status: runtimeStatus.value };
      }),
    };

    const result = runLiveCliSession({
      stdin: input as never,
      stdout: { isTTY: true, columns: 80, rows: 24, write: vi.fn() },
      stderr: { write: vi.fn() },
      environment: { NO_COLOR: '1' },
      runtime,
      telegram: {
        status: () => 'TELEGRAM_BOT_TOKEN: missing',
        listPending: vi.fn(),
        approve: vi.fn(),
        revoke: vi.fn(),
      },
    });

    input.emit('keypress', '', { name: 'enter' });
    await new Promise((resolve) => setImmediate(resolve));
    input.emit('keypress', '', { name: 'down' });
    input.emit('keypress', '', { name: 'enter' });

    await expect(result).resolves.toBe(0);
    expect(runtime.start).toHaveBeenCalled();
    expect(runtime.hideToBackground).toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it('shows Telegram status from the Telegram screen', async () => {
    const input = new FakeInput();
    const write = vi.fn();
    const result = runLiveCliSession({
      stdin: input as never,
      stdout: { isTTY: true, columns: 80, rows: 24, write },
      stderr: { write: vi.fn() },
      environment: { NO_COLOR: '1' },
      runtime: {
        detect: vi.fn(async () => 'stopped' as const),
        currentStatus: vi.fn(() => 'stopped' as const),
        start: vi.fn(),
        stop: vi.fn(async () => ({ status: 'stopped' as const })),
        hideToBackground: vi.fn(),
      },
      telegram: {
        status: () => 'TELEGRAM_BOT_TOKEN: missing',
        listPending: vi.fn(),
        approve: vi.fn(),
        revoke: vi.fn(),
      },
    });

    input.emit('keypress', '', { name: '3' });
    input.emit('keypress', '', { name: 'enter' });
    input.emit('keypress', '', { name: 'enter' });
    input.emit('keypress', '', { name: 'q' });
    input.emit('keypress', '', { name: 'q' });
    input.emit('keypress', '', { name: 'q' });

    await expect(result).resolves.toBe(0);
    expect(write.mock.calls.map((call) => call[0]).join('')).toContain('TELEGRAM_BOT_TOKEN: missing');
  });

  it('collects Telegram approve prompt values and delegates approval', async () => {
    const input = new FakeInput();
    const approve = vi.fn(async () => 'Approved Telegram user 123 for household hh_01JNZQ4A9B8C7D6E5F4G3H2J1K.');
    const result = runLiveCliSession({
      stdin: input as never,
      stdout: { isTTY: true, columns: 80, rows: 24, write: vi.fn() },
      stderr: { write: vi.fn() },
      environment: { NO_COLOR: '1' },
      runtime: {
        detect: vi.fn(async () => 'stopped' as const),
        currentStatus: vi.fn(() => 'stopped' as const),
        start: vi.fn(),
        stop: vi.fn(async () => ({ status: 'stopped' as const })),
        hideToBackground: vi.fn(),
      },
      telegram: {
        status: () => 'ok',
        listPending: vi.fn(),
        approve,
        revoke: vi.fn(),
      },
    });

    input.emit('keypress', '', { name: '3' });
    input.emit('keypress', '', { name: 'enter' });
    input.emit('keypress', '', { name: '3' });
    for (const char of 'ABCDEFGH') input.emit('keypress', char, { name: char });
    input.emit('keypress', '', { name: 'enter' });
    for (const char of 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K') input.emit('keypress', char, { name: char });
    input.emit('keypress', '', { name: 'enter' });
    input.emit('keypress', '', { name: 'q' });
    input.emit('keypress', '', { name: 'q' });
    input.emit('keypress', '', { name: 'q' });

    await expect(result).resolves.toBe(0);
    expect(approve).toHaveBeenCalledWith('ABCDEFGH', 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K');
  });

  it('opens help when readline reports question mark as a sequence', async () => {
    const input = new FakeInput();
    const write = vi.fn();
    const result = runLiveCliSession({
      stdin: input as never,
      stdout: { isTTY: true, columns: 80, rows: 24, write },
      stderr: { write: vi.fn() },
      environment: { NO_COLOR: '1' },
      runtime: {
        detect: vi.fn(async () => 'stopped' as const),
        currentStatus: vi.fn(() => 'stopped' as const),
        start: vi.fn(),
        stop: vi.fn(async () => ({ status: 'stopped' as const })),
        hideToBackground: vi.fn(),
      },
      telegram: {
        status: () => 'ok',
        listPending: vi.fn(),
        approve: vi.fn(),
        revoke: vi.fn(),
      },
    });

    input.emit('keypress', '?', { sequence: '?' });
    input.emit('keypress', '', { name: 'q' });
    input.emit('keypress', '', { name: 'q' });

    await expect(result).resolves.toBe(0);
    expect(write.mock.calls.map((call) => call[0]).join('')).toContain('Plus One help');
  });
});
