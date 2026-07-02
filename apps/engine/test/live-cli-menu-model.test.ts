import { describe, expect, it } from 'vitest';
import { createInitialLiveCliState, handleLiveCliKey, snapshotLiveCliState } from '../src/live-cli/menu-model.js';

describe('live CLI menu model', () => {
  it('shows Start while stopped and Stop while running', () => {
    expect(snapshotLiveCliState(createInitialLiveCliState({ runtimeStatus: 'stopped' })).items.map((item) => item.label))
      .toEqual(['Start', 'Hide to background', 'Configure socials', 'Exit']);

    expect(snapshotLiveCliState(createInitialLiveCliState({ runtimeStatus: 'running-background' })).items.map((item) => item.label))
      .toEqual(['Stop', 'Hide to background', 'Configure socials', 'Exit']);
  });

  it('never shows the word stack in visible menu labels', () => {
    const snapshot = snapshotLiveCliState(createInitialLiveCliState({ runtimeStatus: 'running-attached' }));

    expect(snapshot.items.map((item) => item.label.toLowerCase()).join(' ')).not.toContain('stack');
  });

  it('opens socials and telegram screens with drill-down navigation', () => {
    const main = createInitialLiveCliState({ runtimeStatus: 'stopped' });
    const socials = handleLiveCliKey(main, { name: '3' }).state;
    const telegram = handleLiveCliKey(socials, { name: 'enter' }).state;

    expect(snapshotLiveCliState(socials).title).toBe('Plus One / Configure socials');
    expect(snapshotLiveCliState(socials).items.map((item) => item.label)).toEqual(['Telegram', 'Back']);
    expect(snapshotLiveCliState(telegram).title).toBe('Plus One / Configure socials / Telegram');
    expect(snapshotLiveCliState(telegram).items.map((item) => item.label)).toEqual([
      'Status',
      'List pending pairings',
      'Approve pairing code',
      'Revoke user',
      'Back',
    ]);
  });

  it('supports j/k, arrow keys, number keys, escape, q, and help overlay', () => {
    const start = createInitialLiveCliState({ runtimeStatus: 'stopped' });
    const down = handleLiveCliKey(start, { name: 'down' }).state;
    const vimDown = handleLiveCliKey(down, { name: 'j' }).state;
    const up = handleLiveCliKey(vimDown, { name: 'up' }).state;
    const help = handleLiveCliKey(up, { name: '?' }).state;
    const dismissed = handleLiveCliKey(help, { name: 'escape' }).state;

    expect(snapshotLiveCliState(down).selectedIndex).toBe(1);
    expect(snapshotLiveCliState(vimDown).selectedIndex).toBe(2);
    expect(snapshotLiveCliState(up).selectedIndex).toBe(1);
    expect(snapshotLiveCliState(help).overlay?.kind).toBe('help');
    expect(snapshotLiveCliState(dismissed).overlay).toBeUndefined();
  });

  it('returns semantic actions for start, stop, hide, exit, and telegram commands', () => {
    expect(handleLiveCliKey(createInitialLiveCliState({ runtimeStatus: 'stopped' }), { name: 'enter' }).action)
      .toEqual({ type: 'start-runtime' });

    expect(handleLiveCliKey(createInitialLiveCliState({ runtimeStatus: 'running-background' }), { name: 'enter' }).action)
      .toEqual({ type: 'stop-runtime' });

    expect(handleLiveCliKey(createInitialLiveCliState({ runtimeStatus: 'stopped', selectedIndex: 1 }), { name: 'enter' }).action)
      .toEqual({ type: 'hide-runtime' });

    expect(handleLiveCliKey(createInitialLiveCliState({ runtimeStatus: 'stopped', selectedIndex: 3 }), { name: 'enter' }).action)
      .toEqual({ type: 'exit' });
  });

  it('opens and cancels focused prompt dialogs for approve and revoke', () => {
    const telegram = handleLiveCliKey(
      handleLiveCliKey(createInitialLiveCliState({ runtimeStatus: 'stopped' }), { name: '3' }).state,
      { name: 'enter' },
    ).state;

    const approvePrompt = handleLiveCliKey({ ...telegram, selectedIndex: 2 }, { name: 'enter' }).state;
    expect(snapshotLiveCliState(approvePrompt).prompt?.label).toBe('Pairing code');

    const cancelled = handleLiveCliKey(approvePrompt, { name: 'escape' }).state;
    expect(snapshotLiveCliState(cancelled).prompt).toBeUndefined();

    const revokePrompt = handleLiveCliKey({ ...telegram, selectedIndex: 3 }, { name: 'enter' }).state;
    expect(snapshotLiveCliState(revokePrompt).prompt?.label).toBe('Telegram user id');
  });
});
