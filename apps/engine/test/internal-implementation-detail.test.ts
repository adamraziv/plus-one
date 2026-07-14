import { describe, expect, it } from 'vitest';
import { internalImplementationDetailMatchCategory } from '../src/safety/internal-implementation-detail.js';

describe('internal implementation detail safety', () => {
  it.each([
    ['Query result from reporting.accounts returned 2 rows.', 'relation_name'],
    ['Checker accepted the QueryResultV1.', 'schema_type'],
    ['What is its native_currency?', 'structured_key'],
    ['Accounting team status: failed', 'workflow_jargon'],
    ['The checker accepted the maker artifact.', 'workflow_jargon'],
    ['Which internal payment account should this use?', 'workflow_jargon'],
  ])('classifies %s', (value, category) => {
    expect(internalImplementationDetailMatchCategory(value)).toBe(category);
  });

  it.each([
    'Here are your accounts: Checking and Groceries.',
    'What currency should I use for this account?',
    'I could not complete that request safely. Please try again.',
  ])('allows natural user-facing text: %s', (value) => {
    expect(internalImplementationDetailMatchCategory(value)).toBeUndefined();
  });
});
