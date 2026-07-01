import { z } from 'zod';
import { ArtifactIdSchema, ConversationIdSchema, DeliveryIdSchema, HouseholdIdSchema, JobIdSchema, OccurrenceIdSchema, TaskIdSchema } from './ids.js';
import { JsonValueSchema, SchemaIdentitySchemaV1 } from './json.js';
import { IanaTimezoneSchema, UtcInstantSchema } from './time.js';

const strict = <Shape extends z.ZodRawShape>(shape: Shape) => z.object(shape).strict();
const metadata = z.record(z.string(), JsonValueSchema);
const hash = z.string().regex(/^[0-9a-f]{64}$/);

export const ChannelKindSchemaV1 = z.enum(['telegram', 'slack']);
export type ChannelKindV1 = z.infer<typeof ChannelKindSchemaV1>;

export const ChannelDestinationSchemaV1 = metadata;
export type ChannelDestinationV1 = z.infer<typeof ChannelDestinationSchemaV1>;

export const ChannelConversationSchemaV1 = strict({
  schemaName: z.literal('channel-conversation'),
  schemaVersion: z.literal(1),
  conversationId: ConversationIdSchema,
  householdId: HouseholdIdSchema,
  channel: ChannelKindSchemaV1,
  channelType: z.enum(['direct', 'group', 'channel', 'thread']),
  externalConversationId: z.string().min(1).max(512),
  externalThreadId: z.string().min(1).max(512).optional(),
  destination: ChannelDestinationSchemaV1,
  createdAt: UtcInstantSchema,
  updatedAt: UtcInstantSchema,
});
export type ChannelConversationV1 = z.infer<typeof ChannelConversationSchemaV1>;

export const InboundChannelMessageSchemaV1 = strict({
  schemaName: z.literal('inbound-channel-message'),
  schemaVersion: z.literal(1),
  conversationId: ConversationIdSchema,
  householdId: HouseholdIdSchema,
  channel: ChannelKindSchemaV1,
  externalMessageId: z.string().min(1).max(512),
  receivedAt: UtcInstantSchema,
  speaker: strict({
    principalRef: z.string().min(1).max(512),
    displayName: z.string().min(1).max(256).optional(),
  }),
  body: z.string().min(1).max(32_000),
  attachments: z.array(metadata),
  metadata,
});
export type InboundChannelMessageV1 = z.infer<typeof InboundChannelMessageSchemaV1>;

export const ChannelCommandResultSchemaV1 = strict({
  schemaName: z.literal('channel-command-result'),
  schemaVersion: z.literal(1),
  command: z.enum(['new']),
  status: z.enum(['handled']),
  householdId: HouseholdIdSchema,
  conversationId: ConversationIdSchema,
  channel: ChannelKindSchemaV1,
  delivery: strict({
    channel: ChannelKindSchemaV1,
    destination: ChannelDestinationSchemaV1,
    format: z.enum(['plain_text', 'mrkdwn']),
  }),
  body: z.string().min(1).max(32_000),
  createdAt: UtcInstantSchema,
});
export type ChannelCommandResultV1 = z.infer<typeof ChannelCommandResultSchemaV1>;

export const OutputProcessorResultSchemaV1 = strict({
  schemaName: z.literal('output-processor-result'),
  schemaVersion: z.literal(1),
  processorName: z.string().regex(/^[a-z][a-z0-9-]+$/),
  processorVersion: z.number().int().positive(),
  status: z.enum(['passed', 'blocked']),
  reason: z.string().min(1).max(2_000),
  issues: z.array(z.string().min(1).max(256)),
  retryable: z.boolean(),
});
export type OutputProcessorResultV1 = z.infer<typeof OutputProcessorResultSchemaV1>;

const DeliveryTargetSchemaV1 = strict({
  channel: ChannelKindSchemaV1,
  destination: ChannelDestinationSchemaV1,
  format: z.enum(['plain_text', 'mrkdwn']),
});

export const OrchestratorFinalResponseSchemaV1 = strict({
  schemaName: z.literal('orchestrator-final-response'),
  schemaVersion: z.literal(1),
  responseId: z.string().min(1).max(256),
  householdId: HouseholdIdSchema,
  conversationId: ConversationIdSchema,
  taskId: TaskIdSchema.optional(),
  body: z.string().min(1).max(32_000),
  policyBoundary: z.enum(['personalized_finance', 'informational_only', 'unsupported_capability', 'operational']),
  citations: z.array(strict({
    label: z.string().min(1).max(512),
    artifactId: ArtifactIdSchema.optional(),
    sourceRef: z.string().min(1).max(512).optional(),
  })).min(1),
  assumptions: z.array(z.string().min(1).max(2_000)),
  freshness: z.array(z.string().min(1).max(2_000)).min(1),
  disclaimer: z.string().min(1).max(2_000),
  unsupportedCapabilities: z.array(z.enum(['tax', 'insurance'])),
  recommendationActions: z.array(z.string().min(1).max(2_000)),
  delivery: DeliveryTargetSchemaV1,
  responseHash: hash,
  createdAt: UtcInstantSchema,
});
export type OrchestratorFinalResponseV1 = z.infer<typeof OrchestratorFinalResponseSchemaV1>;

export const DeliveryRequestSchemaV1 = strict({
  schemaName: z.literal('delivery-request'),
  schemaVersion: z.literal(1),
  deliveryId: DeliveryIdSchema,
  idempotencyKey: z.string().min(1).max(512),
  response: OrchestratorFinalResponseSchemaV1,
});
export type DeliveryRequestV1 = z.infer<typeof DeliveryRequestSchemaV1>;

export const DeliveryRecordSchemaV1 = strict({
  schemaName: z.literal('delivery-record'),
  schemaVersion: z.literal(1),
  deliveryId: DeliveryIdSchema,
  householdId: HouseholdIdSchema,
  conversationId: ConversationIdSchema,
  channel: ChannelKindSchemaV1,
  idempotencyKey: z.string().min(1).max(512),
  responseHash: hash,
  status: z.enum(['pending', 'sending', 'delivered', 'failed', 'ambiguous']),
  destination: ChannelDestinationSchemaV1,
  platformMessageId: z.string().min(1).max(512).optional(),
  attemptCount: z.number().int().nonnegative(),
  failureCategory: z.string().min(1).max(256).optional(),
  createdAt: UtcInstantSchema,
  updatedAt: UtcInstantSchema,
});
export type DeliveryRecordV1 = z.infer<typeof DeliveryRecordSchemaV1>;

const SchedulerTargetSchemaV1 = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('orchestrator') }),
  strict({ kind: z.literal('team_lead'), team: z.string().regex(/^[a-z][a-z0-9-]+$/) }),
]);

const DeliveryBehaviorSchemaV1 = z.discriminatedUnion('mode', [
  strict({ mode: z.literal('none') }),
  strict({ mode: z.literal('deliver_final_response'), channel: ChannelKindSchemaV1, destination: ChannelDestinationSchemaV1 }),
]);

export const ScheduledJobSchemaV1 = strict({
  schemaName: z.literal('scheduled-job'),
  schemaVersion: z.literal(1),
  jobId: JobIdSchema,
  householdId: HouseholdIdSchema,
  version: z.number().int().positive(),
  target: SchedulerTargetSchemaV1,
  purpose: z.string().min(1).max(2_000),
  schedule: strict({
    kind: z.literal('external'),
    expression: z.string().min(1).max(512),
  }),
  timezone: IanaTimezoneSchema,
  nextEligibleRunAt: UtcInstantSchema,
  requiredContextSchema: SchemaIdentitySchemaV1,
  requiredContext: JsonValueSchema,
  deliveryBehavior: DeliveryBehaviorSchemaV1,
  overlapPolicy: z.enum(['skip', 'allow']),
  missedRunPolicy: z.enum(['skip', 'run_once', 'bounded_catch_up']),
  timeoutMs: z.number().int().positive(),
  maxRetries: z.number().int().nonnegative(),
  enabled: z.boolean(),
  createdAt: UtcInstantSchema,
  updatedAt: UtcInstantSchema,
});
export type ScheduledJobV1 = z.infer<typeof ScheduledJobSchemaV1>;

export const ScheduledRunSchemaV1 = strict({
  schemaName: z.literal('scheduled-run'),
  schemaVersion: z.literal(1),
  occurrenceId: OccurrenceIdSchema,
  jobId: JobIdSchema,
  jobVersion: z.number().int().positive(),
  householdId: HouseholdIdSchema,
  runKey: z.string().min(1).max(512),
  scheduledFor: UtcInstantSchema,
  status: z.enum(['claimed', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled', 'skipped']),
  attemptCount: z.number().int().nonnegative(),
  taskId: TaskIdSchema.optional(),
  deliveryId: DeliveryIdSchema.optional(),
  failureCategory: z.string().min(1).max(256).optional(),
  createdAt: UtcInstantSchema,
  updatedAt: UtcInstantSchema,
});
export type ScheduledRunV1 = z.infer<typeof ScheduledRunSchemaV1>;
