import { describe, expect, it } from 'vitest';
import { SourceExtractor } from './source-extractor.js';

describe('SourceExtractor', () => {
  it('extracts canonical CSV rows with stable identities', () => {
    const rows = new SourceExtractor().extract({
      mediaType: 'text/csv',
      parserVersion: 'csv-v1',
      bytes: Buffer.from('date,amount,currency,description\n2026-05-01,-20.00,USD,Burger\n'),
    });
    expect(rows).toEqual([{
      sourceRowNumber: 2,
      sourceRowIdentity: 'csv-row-2',
      rawPayload: { amount: '-20.00', currency: 'USD', date: '2026-05-01', description: 'Burger' },
    }]);
  });

  it('extracts JSON array rows with stable identities and canonical payload key order', () => {
    const rows = new SourceExtractor().extract({
      mediaType: 'application/json',
      parserVersion: 'json-v1',
      bytes: Buffer.from('[{"b":2,"a":1}]'),
    });
    expect(rows).toEqual([{ sourceRowNumber: 1, sourceRowIdentity: 'json-row-1', rawPayload: { a: 1, b: 2 } }]);
  });

  it('rejects unsupported media and malformed CSV', () => {
    const extractor = new SourceExtractor();
    expect(() => extractor.extract({
      mediaType: 'application/pdf',
      parserVersion: 'pdf-v1',
      bytes: Buffer.from('%PDF'),
    })).toThrowError(/unsupported/i);
    expect(() => extractor.extract({
      mediaType: 'text/csv',
      parserVersion: 'csv-v1',
      bytes: Buffer.from('a,b\n1'),
    })).toThrowError(/width mismatch/i);
  });
});
