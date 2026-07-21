import { z } from 'zod';
import {
  TransactionCaptureRequestDraftSchemaV1,
  type TransactionCaptureRequestDraftV1,
} from './accounting-request-drafts.js';

export const TransactionCaptureContinuationSchemaV1 = z.object({
  schemaName: z.literal('transaction-capture-continuation'),
  schemaVersion: z.literal(1),
  request: TransactionCaptureRequestDraftSchemaV1,
}).strict();

export type TransactionCaptureContinuationV1 = z.infer<typeof TransactionCaptureContinuationSchemaV1>;

export function transactionCaptureContinuation(
  request: TransactionCaptureRequestDraftV1,
): TransactionCaptureContinuationV1 {
  return TransactionCaptureContinuationSchemaV1.parse({
    schemaName: 'transaction-capture-continuation',
    schemaVersion: 1,
    request,
  });
}
