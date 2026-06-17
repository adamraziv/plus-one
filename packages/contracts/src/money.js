import { z } from 'zod';
export const DecimalStringSchema = z
    .string()
    .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/, 'Expected a non-exponential decimal string')
    .brand();
export const CurrencyCodeSchema = z
    .string()
    .regex(/^[A-Z][A-Z0-9]{2,11}$/, 'Expected an uppercase ISO-style currency code')
    .brand();
export const MoneySchemaV1 = z
    .object({
    amount: DecimalStringSchema,
    currency: CurrencyCodeSchema,
})
    .strict();
