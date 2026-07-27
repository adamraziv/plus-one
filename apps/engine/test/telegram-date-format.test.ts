import { describe, expect, it } from 'vitest';
import { formatReadableUtcInstant } from '../src/telegram/date-format.js';

describe('formatReadableUtcInstant', () => {
  it.each([
    ['2026-01-01T09:05:00.000Z', '1 January 2026, at 09:05 AM'],
    ['2026-01-10T13:45:00.000Z', '10 January 2026, at 01:45 PM'],
  ])('formats %s as %s', (value, expected) => {
    expect(formatReadableUtcInstant(value)).toBe(expected);
  });
});
