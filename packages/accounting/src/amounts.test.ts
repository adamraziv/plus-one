import { describe, expect, it } from 'vitest';
import { compareDecimalStrings, negateDecimalString, sumSignedPostings } from './amounts.js';

describe('exact accounting amount helpers', () => {
  it('never converts decimal strings through JavaScript number', () => {
    expect(compareDecimalStrings('9007199254740993.01', '9007199254740993.00')).toBe(1);
    expect(negateDecimalString('20.00')).toBe('-20.00');
    expect(sumSignedPostings([
      { direction: 'debit', amount: '9007199254740993.01' },
      { direction: 'credit', amount: '9007199254740993.01' },
    ])).toEqual({ debit: '9007199254740993.01', credit: '9007199254740993.01' });
  });
});
