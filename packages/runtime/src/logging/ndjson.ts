import { z } from 'zod';
import { SEVERITY_NUMBER } from './record-builder.js';
import type { LogEnvelopeV1 } from './types.js';

const LogScalarSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
]);

const LogEnvelopeSchemaV1 = z.strictObject({
  schemaVersion: z.literal(1),
  timestamp: z.string().datetime({ offset: true }),
  observedTimestamp: z.string().datetime({ offset: true }),
  severityText: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']),
  severityNumber: z.union([z.literal(5), z.literal(9), z.literal(13), z.literal(17)]),
  eventName: z.string().min(1),
  body: z.string().min(1),
  resource: z.record(z.string(), z.string()),
  instrumentationScope: z.strictObject({ name: z.string().min(1) }),
  traceId: z.string().min(1).optional(),
  spanId: z.string().min(1).optional(),
  attributes: z.record(z.string(), LogScalarSchema),
}).superRefine((record, context) => {
  if (record.severityNumber !== SEVERITY_NUMBER[record.severityText]) {
    context.addIssue({
      code: 'custom',
      path: ['severityNumber'],
      message: 'severityNumber does not match severityText',
    });
  }
});

export function serializeLogEnvelope(record: LogEnvelopeV1): string {
  return `${JSON.stringify(LogEnvelopeSchemaV1.parse(record))}\n`;
}

export function parseLogEnvelope(line: string): LogEnvelopeV1 | undefined {
  try {
    return LogEnvelopeSchemaV1.parse(JSON.parse(line)) as LogEnvelopeV1;
  } catch {
    return undefined;
  }
}
