import { describe, expect, it } from 'vitest';
import {
  redactSecrets,
  sanitizeFields,
  sanitizeLogString,
  serializeLogError,
} from './redaction.js';

describe('logging redaction', () => {
  it('drops content-bearing fields', () => {
    expect(sanitizeFields({ status: 'failed', body: 'private household message', amount: '42.00' })).toEqual({
      status: 'failed',
    });
  });

  it('masks credentials and preserves safe IDs', () => {
    expect(redactSecrets('Authorization: Bearer sk-test-12345678901234567890')).toContain('***');
    expect(redactSecrets('postgresql://user:secret-password@localhost/db')).toContain('***');
    expect(redactSecrets('task_01JNZQ4A9B8C7D6E5F4G3H2J1K')).toBe('task_01JNZQ4A9B8C7D6E5F4G3H2J1K');
  });

  it('serializes only bounded error metadata', () => {
    const error = new Error('database password=secret-password');
    error.name = 'DatabaseError';
    error.stack = `DatabaseError: password=secret-password\n${'frame\n'.repeat(2_000)}`;
    expect(serializeLogError(error, { includeStack: true })).toMatchObject({ name: 'DatabaseError' });
    expect(serializeLogError(error, { includeStack: true }).stack?.length).toBeLessThanOrEqual(8_000);
    expect(JSON.stringify(serializeLogError(error, { includeStack: true }))).not.toContain('secret-password');
  });

  it('retains a bounded sanitized provider response from the error cause chain', () => {
    const providerError = Object.assign(new Error('provider rejected request'), {
      responseBody: `{"error":"capacity unavailable","token":"sk-test-${'a'.repeat(40)}"}${'x'.repeat(20_000)}`,
      statusCode: 503,
      requestBodyValues: { prompt: 'private household message' },
    });
    const wrappedError = new Error('model retries exhausted', { cause: providerError });

    const serialized = serializeLogError(wrappedError);

    expect(serialized.responseBody).toContain('capacity unavailable');
    expect(serialized.responseBody).not.toContain(`sk-test-${'a'.repeat(40)}`);
    expect(serialized.responseBody?.length).toBeLessThanOrEqual(16_000);
    expect(serialized.statusCode).toBe(503);
    expect(JSON.stringify(serialized)).not.toContain('private household message');
  });

  it('bounds strings and removes record-injection characters', () => {
    expect(sanitizeLogString(`first\r\nsecond ${'x'.repeat(2_000)}`, 1_000)).toMatch(/^first {2}second /);
    expect(sanitizeLogString(`first\r\nsecond ${'x'.repeat(2_000)}`, 1_000)).toHaveLength(1_000);
  });
});
