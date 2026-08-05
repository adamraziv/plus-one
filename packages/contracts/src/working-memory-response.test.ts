import { describe, expect, it } from 'vitest';
import {
  WorkingMemoryReplyCheckSchemaV1,
  WorkingMemoryReplySchemaV1,
} from './working-memory-response.js';

describe('Working Memory response contracts', () => {
  it.each([
    'request_confirmation',
    'confirm_applied',
    'confirm_rejected',
    'report_failure',
  ] as const)('accepts the %s speech act', (speechAct) => {
    expect(WorkingMemoryReplySchemaV1.parse({
      speechAct,
      body: 'A concise user-facing response.',
    })).toEqual({
      speechAct,
      body: 'A concise user-facing response.',
    });
  });

  it('accepts a valid independent checker result', () => {
    expect(WorkingMemoryReplyCheckSchemaV1.parse({
      valid: true,
      explanation: 'The response expresses the required event.',
    })).toEqual({
      valid: true,
      explanation: 'The response expresses the required event.',
    });
  });

  it.each([
    { speechAct: 'confirm_saved', body: 'A response.' },
    { speechAct: 'confirm_applied', body: '' },
    { speechAct: 'confirm_applied', body: 'A response.', extra: true },
  ])('rejects a malformed reply: %j', (candidate) => {
    expect(WorkingMemoryReplySchemaV1.safeParse(candidate).success).toBe(false);
  });

  it('rejects a checker result without an explanation', () => {
    expect(WorkingMemoryReplyCheckSchemaV1.safeParse({ valid: false }).success).toBe(false);
  });
});
