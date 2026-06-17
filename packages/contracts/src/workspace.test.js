import { describe, expect, it } from 'vitest';
import { DatabaseIdSchema, MoneySchemaV1, PlusOneError, UtcInstantSchema } from './index.js';
describe('contracts workspace entry point', () => {
    it('exports shared contract schemas and errors from the package entry point', () => {
        expect(DatabaseIdSchema.parse('1')).toBe('1');
        expect(MoneySchemaV1.parse({ amount: '12.34', currency: 'USD' })).toEqual({
            amount: '12.34',
            currency: 'USD',
        });
        expect(UtcInstantSchema.parse('2026-06-16T00:00:00.000Z')).toBe('2026-06-16T00:00:00.000Z');
        expect(new PlusOneError({
            category: 'storage_unavailable',
            code: 'database_unavailable',
            message: 'Dependency is unavailable',
            receiptLookupRequired: false,
            retry: 'after_backoff',
        })).toBeInstanceOf(Error);
    });
});
