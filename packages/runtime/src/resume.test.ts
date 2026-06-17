import { describe, expect, it } from 'vitest';
import { classifyResumeAction } from './resume.js';

const base = {
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  team: 'query',
  attemptLimit: 2,
  resumable: true,
  updatedAt: '2026-06-14T10:00:00.000Z',
} as const;

describe('resume inspection', () => {
  it('requires command-state resolution for ambiguous mutation states', () => {
    expect(
      classifyResumeAction({ ...base, status: 'execution_pending' }, '2026-06-14T10:05:00.000Z'),
    ).toBe('resolve_command_state');
    expect(classifyResumeAction({ ...base, status: 'committed' }, '2026-06-14T10:05:00.000Z')).toBe(
      'resolve_command_state',
    );
  });

  it('fails expired work and never reopens terminal work', () => {
    expect(
      classifyResumeAction(
        { ...base, status: 'maker_running', deadlineAt: '2026-06-14T10:01:00.000Z' },
        '2026-06-14T10:05:00.000Z',
      ),
    ).toBe('fail_expired');
    expect(classifyResumeAction({ ...base, status: 'verified' }, '2026-06-14T10:05:00.000Z')).toBe(
      'none_terminal',
    );
  });

  it('retries only explicitly resumable nonterminal work', () => {
    expect(classifyResumeAction({ ...base, status: 'checker_running' }, '2026-06-14T10:05:00.000Z')).toBe(
      'retry_allowed',
    );
    expect(
      classifyResumeAction(
        { ...base, status: 'checker_running', resumable: false },
        '2026-06-14T10:05:00.000Z',
      ),
    ).toBe('manual_recovery_required');
  });
});
