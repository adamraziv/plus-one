import { describe, expect, it } from 'vitest';
import { createInitialLiveCliState, snapshotLiveCliState } from '../src/live-cli/menu-model.js';
import { detectColorSupport, renderLiveCliSnapshot } from '../src/live-cli/renderer.js';

describe('live CLI renderer', () => {
  it('renders the header, selected list item, footer, and runtime status without using stack', () => {
    const output = renderLiveCliSnapshot({
      snapshot: snapshotLiveCliState(createInitialLiveCliState({ runtimeStatus: 'stopped' })),
      size: { columns: 80, rows: 24 },
      color: 'none',
    });

    expect(output).toContain('Plus One');
    expect(output).toContain('Status: Stopped');
    expect(output).toContain('> 1. Start');
    expect(output).toContain('  2. Hide to background');
    expect(output).toContain('[Enter] select');
    expect(output.toLowerCase()).not.toContain('stack');
  });

  it('renders terminal-too-small message below 80x24', () => {
    const output = renderLiveCliSnapshot({
      snapshot: snapshotLiveCliState(createInitialLiveCliState({ runtimeStatus: 'stopped' })),
      size: { columns: 79, rows: 24 },
      color: 'ansi16',
    });

    expect(output).toBe('Terminal too small for Plus One.\nResize to at least 80x24.\n');
  });

  it('respects NO_COLOR and color capability detection', () => {
    expect(detectColorSupport({ NO_COLOR: '1', TERM: 'xterm-256color', COLORTERM: 'truecolor' })).toBe('none');
    expect(detectColorSupport({ TERM: 'xterm-256color' })).toBe('ansi256');
    expect(detectColorSupport({ COLORTERM: 'truecolor', TERM: 'xterm' })).toBe('truecolor');
    expect(detectColorSupport({ TERM: 'xterm' })).toBe('ansi16');
  });

  it('renders help overlay as focused content', () => {
    const state = createInitialLiveCliState({ runtimeStatus: 'stopped' });
    const output = renderLiveCliSnapshot({
      snapshot: {
        ...snapshotLiveCliState(state),
        overlay: {
          kind: 'help',
          title: 'Plus One help',
          lines: ['Enter selects the highlighted action.'],
        },
      },
      size: { columns: 80, rows: 24 },
      color: 'none',
    });

    expect(output).toContain('Plus One help');
    expect(output).toContain('Enter selects the highlighted action.');
  });
});
