import { describe, expect, it } from 'vitest';
import { classifyTelegramApiFailure, transportFailureFromUnknown } from './send-result.js';

describe('send result classification', () => {
  it.each([
    [429, 'Too Many Requests: retry after 10', 'rate_limited', true],
    [400, 'Bad Request: message is too long', 'too_long', false],
    [400, 'Bad Request: cannot parse entities', 'bad_format', false],
    [403, 'Forbidden: bot was blocked by the user', 'forbidden', false],
    [404, 'Not Found', 'not_found', false],
    [502, 'Bad Gateway', 'transient', true],
  ] as const)('classifies Telegram status %s as %s', (status, description, category, retryable) => {
    expect(classifyTelegramApiFailure({ status, description })).toMatchObject({ category, retryable });
  });

  it('treats TypeError transport throws as ambiguous receipt cases', () => {
    expect(transportFailureFromUnknown(new TypeError('fetch failed'))).toMatchObject({
      category: 'ambiguous',
      retryable: true,
      receiptLookupRequired: true,
    });
  });

  it('keeps ordinary errors failed and retryable after backoff', () => {
    expect(transportFailureFromUnknown(new Error('socket closed'))).toMatchObject({
      category: 'transient',
      retryable: true,
      receiptLookupRequired: false,
    });
  });
});
