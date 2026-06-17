import { describe, expect, it } from 'vitest';
import { CurrencyCodeSchema, DatabaseIdSchema, ErrorCategorySchemaV1, HouseholdIdSchema, IanaTimezoneSchema, LocalDateSchema, MoneySchemaV1, PlusOneError, UtcInstantSchema, } from './index.js';
describe('shared value contracts', () => {
    it('transports bigint database identifiers as canonical decimal strings', () => {
        expect(DatabaseIdSchema.parse('9007199254740993')).toBe('9007199254740993');
        expect(DatabaseIdSchema.safeParse('01').success).toBe(false);
        expect(DatabaseIdSchema.safeParse(1).success).toBe(false);
    });
    it('requires prefixed Crockford opaque household identifiers', () => {
        expect(HouseholdIdSchema.parse('hh_01JNZQ4A9B8C7D6E5F4G3H2J1K')).toBe('hh_01JNZQ4A9B8C7D6E5F4G3H2J1K');
        expect(HouseholdIdSchema.safeParse('household-1').success).toBe(false);
    });
    it('accepts exact decimal money without JavaScript numbers', () => {
        expect(MoneySchemaV1.parse({ amount: '-1200.50', currency: 'USD' })).toEqual({
            amount: '-1200.50',
            currency: 'USD',
        });
        expect(MoneySchemaV1.safeParse({ amount: 1200.5, currency: 'USD' }).success).toBe(false);
        expect(CurrencyCodeSchema.safeParse('usd').success).toBe(false);
    });
    it('separates UTC instants, local dates, and IANA timezones', () => {
        expect(UtcInstantSchema.parse('2026-06-14T09:30:00.000Z')).toBe('2026-06-14T09:30:00.000Z');
        expect(UtcInstantSchema.safeParse('2026-06-14T17:30:00+08:00').success).toBe(false);
        expect(LocalDateSchema.parse('2026-02-28')).toBe('2026-02-28');
        expect(LocalDateSchema.safeParse('2026-02-30').success).toBe(false);
        expect(IanaTimezoneSchema.parse('Asia/Shanghai')).toBe('Asia/Shanghai');
        expect(IanaTimezoneSchema.safeParse('UTC+8').success).toBe(false);
    });
});
describe('typed errors', () => {
    it('exposes the fixed categories and redacted structured fields', () => {
        expect(ErrorCategorySchemaV1.parse('storage_unavailable')).toBe('storage_unavailable');
        const error = new PlusOneError({
            category: 'storage_unavailable',
            code: 'database_connection_failed',
            message: 'Storage is unavailable',
            retry: 'after_backoff',
            receiptLookupRequired: false,
            details: { operation: 'connect' },
        });
        expect(error.toJSON()).toEqual({
            name: 'PlusOneError',
            category: 'storage_unavailable',
            code: 'database_connection_failed',
            message: 'Storage is unavailable',
            retry: 'after_backoff',
            receiptLookupRequired: false,
            details: { operation: 'connect' },
        });
    });
});
