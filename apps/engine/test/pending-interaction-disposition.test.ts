import { describe, expect, it } from 'vitest';
import { createPendingInteractionDispositionSession } from '../src/agents/pending-interaction-disposition.js';

async function executeTool(tool: unknown, input: unknown): Promise<unknown> {
  const executable = tool as { execute?: (value: unknown, context: unknown) => unknown };
  if (executable.execute === undefined) throw new Error('Expected an executable disposition tool.');
  return executable.execute(input, {});
}

describe('pending interaction disposition session', () => {
  it('accepts only semantic dispositions and rejects mutation decisions, unknown keys, and duplicate submission', async () => {
    const session = createPendingInteractionDispositionSession();

    await expect(executeTool(session.tool, { disposition: 'approve' })).resolves.toMatchObject({ error: true });
    await expect(executeTool(session.tool, { disposition: 'reject' })).resolves.toMatchObject({ error: true });
    await expect(executeTool(session.tool, { disposition: 'new_intent', unexpected: true }))
      .resolves.toMatchObject({ error: true });
    expect(() => session.requireDisposition()).toThrow(/not submitted/i);

    await expect(executeTool(session.tool, { disposition: 'ambiguous' })).resolves.toEqual({ accepted: true });
    expect(session.requireDisposition()).toBe('ambiguous');
    await expect(executeTool(session.tool, { disposition: 'new_intent' }))
      .rejects.toMatchObject({ code: 'pending_interaction_disposition_duplicate' });
  });
});
