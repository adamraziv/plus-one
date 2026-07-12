import { describe, expect, it } from 'vitest';
import { redactSecrets, sanitizeFields, serializeLogError } from './redaction.js';

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
    expect(serializeLogError(error)).toMatchObject({ name: 'DatabaseError' });
    expect(JSON.stringify(serializeLogError(error))).not.toContain('secret-password');
  });
});
