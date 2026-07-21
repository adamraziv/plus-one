import { describe, expect, it } from 'vitest';
import { createRequestId, getLogContext, withLogContext } from './context.js';

describe('logging context', () => {
  it('creates a request identifier with the req_ prefix', () => {
    expect(createRequestId()).toMatch(/^req_[0-9a-f-]{36}$/);
  });

  it('merges nested context and restores the parent after the callback', async () => {
    expect(getLogContext()).toEqual({});
    await withLogContext({ requestId: 'req_parent', conversationId: 'conversation_1' }, async () => {
      expect(getLogContext()).toEqual({ requestId: 'req_parent', conversationId: 'conversation_1' });
      await withLogContext({ taskId: 'task_1' }, async () => {
        expect(getLogContext()).toEqual({
          requestId: 'req_parent', conversationId: 'conversation_1', taskId: 'task_1',
        });
      });
      expect(getLogContext()).toEqual({ requestId: 'req_parent', conversationId: 'conversation_1' });
    });
    expect(getLogContext()).toEqual({});
  });

  it('keeps concurrent contexts isolated', async () => {
    const seen: string[] = [];
    await Promise.all([
      withLogContext({ requestId: 'req_a' }, async () => {
        await Promise.resolve();
        seen.push(getLogContext().requestId ?? 'missing');
      }),
      withLogContext({ requestId: 'req_b' }, async () => {
        await Promise.resolve();
        seen.push(getLogContext().requestId ?? 'missing');
      }),
    ]);
    expect(seen.sort()).toEqual(['req_a', 'req_b']);
  });
});
