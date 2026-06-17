import { z } from 'zod';
function isRealLocalDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (match === null) {
        return false;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day);
}
function isIanaTimezone(value) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
        return value.includes('/') || value === 'UTC';
    }
    catch {
        return false;
    }
}
export const UtcInstantSchema = z
    .string()
    .datetime({ offset: false })
    .refine((value) => value.endsWith('Z'), 'Expected a UTC instant ending in Z')
    .brand();
export const LocalDateSchema = z
    .string()
    .refine(isRealLocalDate, 'Expected a real YYYY-MM-DD date')
    .brand();
export const IanaTimezoneSchema = z
    .string()
    .refine(isIanaTimezone, 'Expected an IANA timezone')
    .brand();
