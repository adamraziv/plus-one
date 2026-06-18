import { describe, expect, it } from 'vitest';
import { DuplicateMatcher } from './duplicate-matcher.js';

describe('DuplicateMatcher', () => {
  const matcher = new DuplicateMatcher();
  const scope = { householdId: 'hh_1', sourceAccountId: 'account_1', sourceSystem: 'bank' };

  it('uses a stable source transaction ID when one exists', () => {
    expect(matcher.exactFingerprint({
      ...scope,
      externalTransactionId: 'txn-7',
      sourceDocumentHash: 'a'.repeat(64),
      sourceRowIdentity: 'row-1',
      rawPayload: { amount: '20' },
    })).toEqual({ kind: 'stable_external_id', hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('uses document, row identity, and canonical raw payload as fallback', () => {
    const one = matcher.exactFingerprint({
      ...scope,
      sourceDocumentHash: 'a'.repeat(64),
      sourceRowIdentity: 'row-1',
      rawPayload: { b: 2, a: 1 },
    });
    const two = matcher.exactFingerprint({
      ...scope,
      sourceDocumentHash: 'a'.repeat(64),
      sourceRowIdentity: 'row-1',
      rawPayload: { a: 1, b: 2 },
    });
    expect(one).toEqual(two);
  });

  it('never calls similarity an exact duplicate', () => {
    expect(matcher.scoreProbable(
      { amount: '-20.00', occurredOn: '2026-05-01', description: 'Burger' },
      { amount: '-20.00', occurredOn: '2026-05-01', description: 'Burger' },
    )).toEqual({
      classification: 'probable_duplicate',
      score: 0.85,
      evidence: ['same_amount', 'same_date', 'same_description'],
    });
  });
});
