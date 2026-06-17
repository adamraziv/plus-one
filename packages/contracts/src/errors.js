import { z } from 'zod';
export const ErrorCategorySchemaV1 = z.enum([
    'validation_rejected',
    'checker_rejected',
    'confirmation_required',
    'serialization_conflict',
    'constraint_violation',
    'duplicate_replay',
    'period_closed',
    'ambiguous_source_match',
    'readback_mismatch',
    'projection_unhealthy',
    'timeout',
    'storage_unavailable',
    'policy_rejected',
    'unsupported_capability',
    'runtime_failure',
]);
export const RetryDirectiveSchemaV1 = z.enum([
    'never',
    'safe',
    'after_backoff',
    'after_state_resolution',
]);
const ErrorDetailValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const ErrorDetailsSchema = z.record(z.string(), ErrorDetailValueSchema).readonly();
export class PlusOneError extends Error {
    category;
    code;
    retry;
    receiptLookupRequired;
    details;
    constructor(input) {
        super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
        this.name = 'PlusOneError';
        this.category = input.category;
        this.code = input.code;
        this.retry = input.retry;
        this.receiptLookupRequired = input.receiptLookupRequired;
        this.details = ErrorDetailsSchema.parse(input.details ?? {});
    }
    toJSON() {
        return {
            name: this.name,
            category: this.category,
            code: this.code,
            message: this.message,
            retry: this.retry,
            receiptLookupRequired: this.receiptLookupRequired,
            details: this.details,
        };
    }
}
