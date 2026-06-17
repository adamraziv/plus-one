import { describe, expect, it } from 'vitest';
import { assertAllowedTransition, isAllowedTransition, isTerminalStatus } from './state-machine.js';

describe('maker-checker state machine', () => {
  it('accepts the mandatory happy path and revision loop', () => {
    expect(isAllowedTransition('created', 'skill_selected')).toBe(true);
    expect(isAllowedTransition('maker_validated', 'checker_running')).toBe(true);
    expect(isAllowedTransition('checker_validated', 'revision_requested')).toBe(true);
    expect(isAllowedTransition('revision_requested', 'maker_running')).toBe(true);
    expect(isAllowedTransition('checker_validated', 'verified')).toBe(true);
  });

  it('rejects lifecycle skips and terminal escape', () => {
    expect(() => assertAllowedTransition('created', 'verified')).toThrow(/Invalid task transition/);
    expect(() => assertAllowedTransition('maker_running', 'checker_running')).toThrow(
      /Invalid task transition/,
    );
    expect(isAllowedTransition('verified', 'maker_running')).toBe(false);
    expect(isTerminalStatus('conflicted')).toBe(true);
  });

  it('supports checked mutation execution without allowing blind success', () => {
    expect(isAllowedTransition('checker_validated', 'execution_pending')).toBe(true);
    expect(isAllowedTransition('execution_pending', 'committed')).toBe(true);
    expect(isAllowedTransition('committed', 'readback_verified')).toBe(true);
    expect(isAllowedTransition('readback_verified', 'verified')).toBe(true);
    expect(isAllowedTransition('committed', 'verified')).toBe(false);
  });
});
