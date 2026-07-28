import type { LogOptions, LogSeverityText } from './types.js';

export type AttributeSensitivity = 'operational' | 'correlation';

export type AttributeDefinition =
  | Readonly<{
    output: string;
    type: 'string';
    sensitivity: AttributeSensitivity;
    maxLength: number;
  }>
  | Readonly<{
    output: string;
    type: 'number';
    sensitivity: AttributeSensitivity;
    minimum: number;
    maximum: number;
  }>
  | Readonly<{
    output: string;
    type: 'boolean';
    sensitivity: AttributeSensitivity;
  }>;

function stringAttribute<Output extends string>(
  output: Output,
  sensitivity: AttributeSensitivity = 'operational',
) {
  return { output, type: 'string' as const, sensitivity, maxLength: 200 };
}

function numberAttribute<Output extends string>(output: Output) {
  return {
    output,
    type: 'number' as const,
    sensitivity: 'operational' as const,
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
  };
}

function booleanAttribute<Output extends string>(output: Output) {
  return {
    output,
    type: 'boolean' as const,
    sensitivity: 'operational' as const,
  };
}

export const ATTRIBUTE_DEFINITIONS = {
  mode: stringAttribute('runtime.mode'),
  readiness: stringAttribute('runtime.readiness'),
  status: stringAttribute('status'),
  channel: stringAttribute('channel'),
  durationMs: numberAttribute('duration.ms'),
  failureCategory: stringAttribute('failure.category'),
  role: stringAttribute('agent.role'),
  model: stringAttribute('agent.model'),
  attemptOrdinal: numberAttribute('agent.attempt.ordinal'),
  outcome: stringAttribute('outcome'),
  retryClassification: stringAttribute('retry.classification'),
  messageCount: numberAttribute('message.count'),
  matchCategory: stringAttribute('match.category'),
  step: numberAttribute('orchestrator.step.ordinal'),
  inputTokens: numberAttribute('usage.input_tokens'),
  outputTokens: numberAttribute('usage.output_tokens'),
  toolCallCount: numberAttribute('tool.call.count'),
  team: stringAttribute('team'),
  jobId: stringAttribute('scheduler.job.id', 'correlation'),
  occurrenceId: stringAttribute('scheduler.occurrence.id', 'correlation'),
  targetKind: stringAttribute('scheduler.target.kind'),
  retryCount: numberAttribute('retry.count'),
  sent: booleanAttribute('delivery.send.attempted'),
  operation: stringAttribute('working_memory.operation'),
  outcomeCode: stringAttribute('working_memory.outcome.code'),
  retryDirective: stringAttribute('retry.directive'),
  requestedBy: stringAttribute('request.source'),
  findingCount: numberAttribute('working_memory.finding.count'),
  recordCount: numberAttribute('record.count'),
  component: stringAttribute('logging.component'),
  validationCategory: stringAttribute('logging.validation.category'),
  sink: stringAttribute('logging.sink.name'),
  droppedCount: numberAttribute('logging.records.dropped.count'),
  droppedSeverity: stringAttribute('logging.records.dropped.severity'),
  dropReason: stringAttribute('logging.records.dropped.reason'),
} as const;

export type CatalogAttributeName = keyof typeof ATTRIBUTE_DEFINITIONS;

interface EventDefinition {
  component: string;
  eventName: string;
  severities: readonly LogSeverityText[];
  requiredAttributes: readonly CatalogAttributeName[];
  optionalAttributes: readonly CatalogAttributeName[];
  allowException?: boolean;
}

function defineEvent<
  const Component extends string,
  const EventName extends string,
  const Severities extends readonly LogSeverityText[],
  const Required extends readonly CatalogAttributeName[],
  const Optional extends readonly CatalogAttributeName[],
>(definition: {
  component: Component;
  eventName: EventName;
  severities: Severities;
  requiredAttributes: Required;
  optionalAttributes: Optional;
  allowException?: boolean;
}) {
  return definition;
}

export const EVENT_CATALOG = {
  'runtime.started': defineEvent({
    component: 'engine.gateway', eventName: 'runtime.started', severities: ['INFO'],
    requiredAttributes: ['mode'], optionalAttributes: [],
  }),
  'runtime.readiness.changed': defineEvent({
    component: 'engine.gateway', eventName: 'runtime.readiness.changed', severities: ['INFO'],
    requiredAttributes: ['readiness'], optionalAttributes: ['mode'],
  }),
  'runtime.stopped': defineEvent({
    component: 'engine.gateway', eventName: 'runtime.stopped', severities: ['INFO'],
    requiredAttributes: ['mode'], optionalAttributes: ['status', 'durationMs'],
  }),
  'runtime.failed': defineEvent({
    component: 'engine.gateway', eventName: 'runtime.failed', severities: ['ERROR'],
    requiredAttributes: ['mode', 'failureCategory'], optionalAttributes: ['durationMs'],
    allowException: true,
  }),
  'launcher.starting': defineEvent({
    component: 'engine.gateway.launcher', eventName: 'launcher.starting', severities: ['INFO'],
    requiredAttributes: [], optionalAttributes: ['mode'],
  }),
  'launcher.started': defineEvent({
    component: 'engine.gateway.launcher', eventName: 'launcher.started', severities: ['INFO'],
    requiredAttributes: [], optionalAttributes: ['mode', 'durationMs'],
  }),
  'launcher.start.failed': defineEvent({
    component: 'engine.gateway.launcher', eventName: 'launcher.start.failed', severities: ['ERROR'],
    requiredAttributes: ['failureCategory'], optionalAttributes: ['durationMs'], allowException: true,
  }),
  'launcher.stop.requested': defineEvent({
    component: 'engine.gateway.launcher', eventName: 'launcher.stop.requested', severities: ['INFO'],
    requiredAttributes: [], optionalAttributes: ['mode'],
  }),
  'launcher.stopped': defineEvent({
    component: 'engine.gateway.launcher', eventName: 'launcher.stopped', severities: ['INFO'],
    requiredAttributes: [], optionalAttributes: ['durationMs'],
  }),
  'launcher.stop.failed': defineEvent({
    component: 'engine.gateway.launcher', eventName: 'launcher.stop.failed', severities: ['ERROR'],
    requiredAttributes: ['failureCategory'], optionalAttributes: ['durationMs'], allowException: true,
  }),
  'gateway.inbound.accepted': defineEvent({
    component: 'gateway.channel', eventName: 'gateway.inbound.accepted', severities: ['INFO'],
    requiredAttributes: ['channel'], optionalAttributes: [],
  }),
  'gateway.inbound.duplicate': defineEvent({
    component: 'gateway.channel', eventName: 'gateway.inbound.duplicate', severities: ['INFO'],
    requiredAttributes: ['channel'], optionalAttributes: [],
  }),
  'gateway.inbound.queued': defineEvent({
    component: 'gateway.channel', eventName: 'gateway.inbound.queued', severities: ['INFO'],
    requiredAttributes: ['channel'], optionalAttributes: [],
  }),
  'gateway.turn.started': defineEvent({
    component: 'gateway.channel', eventName: 'gateway.turn.started', severities: ['INFO'],
    requiredAttributes: ['channel'], optionalAttributes: [],
  }),
  'gateway.turn.completed': defineEvent({
    component: 'gateway.channel', eventName: 'gateway.turn.completed', severities: ['INFO'],
    requiredAttributes: ['channel', 'status', 'durationMs'], optionalAttributes: ['failureCategory'],
  }),
  'gateway.turn.failed': defineEvent({
    component: 'gateway.channel', eventName: 'gateway.turn.failed', severities: ['ERROR'],
    requiredAttributes: ['channel', 'failureCategory', 'durationMs'], optionalAttributes: [],
  }),
  'turn.started': defineEvent({
    component: 'runtime.orchestrator', eventName: 'turn.started', severities: ['INFO'],
    requiredAttributes: ['channel'], optionalAttributes: [],
  }),
  'turn.context.prepared': defineEvent({
    component: 'runtime.orchestrator', eventName: 'turn.context.prepared', severities: ['INFO'],
    requiredAttributes: ['durationMs', 'messageCount'], optionalAttributes: [],
  }),
  'turn.completed': defineEvent({
    component: 'runtime.orchestrator', eventName: 'turn.completed', severities: ['INFO'],
    requiredAttributes: ['status', 'durationMs'], optionalAttributes: [],
  }),
  'turn.failed': defineEvent({
    component: 'runtime.orchestrator', eventName: 'turn.failed', severities: ['ERROR'],
    requiredAttributes: ['failureCategory', 'durationMs'], optionalAttributes: [], allowException: true,
  }),
  'orchestrator.delegation.completed': defineEvent({
    component: 'runtime.orchestrator', eventName: 'orchestrator.delegation.completed', severities: ['INFO'],
    requiredAttributes: ['team', 'status', 'durationMs'], optionalAttributes: [],
  }),
  'orchestrator.delegation.failed': defineEvent({
    component: 'runtime.orchestrator', eventName: 'orchestrator.delegation.failed', severities: ['WARN', 'ERROR'],
    requiredAttributes: ['team', 'durationMs'], optionalAttributes: ['failureCategory'], allowException: true,
  }),
  'orchestrator.response.withheld': defineEvent({
    component: 'runtime.orchestrator', eventName: 'orchestrator.response.withheld', severities: ['WARN'],
    requiredAttributes: ['matchCategory'], optionalAttributes: [],
  }),
  'orchestrator.checked_response.withheld': defineEvent({
    component: 'runtime.orchestrator', eventName: 'orchestrator.checked_response.withheld', severities: ['WARN'],
    requiredAttributes: ['matchCategory'], optionalAttributes: [],
  }),
  'orchestrator.step.completed': defineEvent({
    component: 'runtime.orchestrator', eventName: 'orchestrator.step.completed', severities: ['DEBUG'],
    requiredAttributes: ['step', 'durationMs'], optionalAttributes: ['inputTokens', 'outputTokens', 'toolCallCount'],
  }),
  'agent.started': defineEvent({
    component: 'runtime.agent', eventName: 'agent.started', severities: ['INFO'],
    requiredAttributes: ['role', 'model', 'attemptOrdinal'], optionalAttributes: [],
  }),
  'agent.completed': defineEvent({
    component: 'runtime.agent', eventName: 'agent.completed', severities: ['INFO'],
    requiredAttributes: ['role', 'model', 'attemptOrdinal', 'durationMs'], optionalAttributes: ['outcome'],
  }),
  'agent.failed': defineEvent({
    component: 'runtime.agent', eventName: 'agent.failed', severities: ['WARN', 'ERROR'],
    requiredAttributes: ['role', 'model', 'attemptOrdinal', 'failureCategory', 'durationMs'],
    optionalAttributes: ['outcome', 'retryClassification'], allowException: true,
  }),
  'delivery.started': defineEvent({
    component: 'runtime.delivery', eventName: 'delivery.started', severities: ['INFO'],
    requiredAttributes: ['channel'], optionalAttributes: [],
  }),
  'delivery.processing.completed': defineEvent({
    component: 'runtime.delivery', eventName: 'delivery.processing.completed', severities: ['INFO'],
    requiredAttributes: ['channel', 'status', 'durationMs'], optionalAttributes: [],
  }),
  'delivery.reserved': defineEvent({
    component: 'runtime.delivery', eventName: 'delivery.reserved', severities: ['INFO'],
    requiredAttributes: ['channel', 'status', 'durationMs'], optionalAttributes: [],
  }),
  'delivery.sent': defineEvent({
    component: 'runtime.delivery', eventName: 'delivery.sent', severities: ['INFO'],
    requiredAttributes: ['channel', 'sent', 'durationMs'], optionalAttributes: [],
  }),
  'delivery.completed': defineEvent({
    component: 'runtime.delivery', eventName: 'delivery.completed', severities: ['INFO'],
    requiredAttributes: ['channel', 'status', 'sent', 'durationMs'], optionalAttributes: ['failureCategory'],
  }),
  'delivery.failed': defineEvent({
    component: 'runtime.delivery', eventName: 'delivery.failed', severities: ['ERROR'],
    requiredAttributes: ['channel', 'status', 'failureCategory', 'sent', 'durationMs'],
    optionalAttributes: [], allowException: true,
  }),
  'delivery.ambiguous': defineEvent({
    component: 'runtime.delivery', eventName: 'delivery.ambiguous', severities: ['WARN'],
    requiredAttributes: ['channel', 'status', 'failureCategory', 'sent', 'durationMs'],
    optionalAttributes: [],
  }),
  'scheduler.run.started': defineEvent({
    component: 'runtime.scheduler', eventName: 'scheduler.run.started', severities: ['INFO'],
    requiredAttributes: ['jobId', 'occurrenceId', 'targetKind', 'retryCount'], optionalAttributes: ['team'],
  }),
  'scheduler.run.completed': defineEvent({
    component: 'runtime.scheduler', eventName: 'scheduler.run.completed', severities: ['INFO'],
    requiredAttributes: ['jobId', 'occurrenceId', 'targetKind', 'retryCount', 'status', 'durationMs'],
    optionalAttributes: ['team'],
  }),
  'scheduler.run.skipped': defineEvent({
    component: 'runtime.scheduler', eventName: 'scheduler.run.skipped', severities: ['INFO'],
    requiredAttributes: ['jobId', 'occurrenceId', 'targetKind', 'retryCount', 'status', 'durationMs'],
    optionalAttributes: ['team', 'failureCategory'],
  }),
  'scheduler.run.timed_out': defineEvent({
    component: 'runtime.scheduler', eventName: 'scheduler.run.timed_out', severities: ['ERROR'],
    requiredAttributes: ['jobId', 'occurrenceId', 'targetKind', 'retryCount', 'status', 'durationMs'],
    optionalAttributes: ['team', 'failureCategory'], allowException: true,
  }),
  'scheduler.run.failed': defineEvent({
    component: 'runtime.scheduler', eventName: 'scheduler.run.failed', severities: ['ERROR'],
    requiredAttributes: ['jobId', 'occurrenceId', 'targetKind', 'retryCount', 'status', 'durationMs'],
    optionalAttributes: ['team', 'failureCategory'], allowException: true,
  }),
  'pairing.approved': defineEvent({
    component: 'runtime.pairing', eventName: 'pairing.approved', severities: ['INFO'],
    requiredAttributes: ['channel'], optionalAttributes: [],
  }),
  'pairing.revoked': defineEvent({
    component: 'runtime.pairing', eventName: 'pairing.revoked', severities: ['INFO'],
    requiredAttributes: ['channel'], optionalAttributes: [],
  }),
  'working_memory.read.completed': defineEvent({
    component: 'runtime.memory', eventName: 'working_memory.read.completed', severities: ['DEBUG'],
    requiredAttributes: ['operation', 'outcomeCode', 'durationMs'], optionalAttributes: ['requestedBy', 'recordCount'],
  }),
  'working_memory.read.failed': defineEvent({
    component: 'runtime.memory', eventName: 'working_memory.read.failed', severities: ['ERROR'],
    requiredAttributes: ['operation', 'failureCategory', 'retryDirective', 'durationMs'],
    optionalAttributes: ['outcomeCode', 'requestedBy'], allowException: true,
  }),
  'working_memory.mutation.completed': defineEvent({
    component: 'runtime.memory', eventName: 'working_memory.mutation.completed', severities: ['INFO'],
    requiredAttributes: ['operation', 'outcomeCode', 'durationMs'], optionalAttributes: ['requestedBy', 'recordCount'],
  }),
  'working_memory.mutation.rejected': defineEvent({
    component: 'runtime.memory', eventName: 'working_memory.mutation.rejected', severities: ['WARN'],
    requiredAttributes: ['operation', 'outcomeCode', 'failureCategory', 'retryDirective', 'durationMs'],
    optionalAttributes: ['requestedBy'],
  }),
  'working_memory.write.failed': defineEvent({
    component: 'runtime.memory', eventName: 'working_memory.write.failed', severities: ['ERROR'],
    requiredAttributes: ['operation', 'failureCategory', 'retryDirective', 'durationMs'],
    optionalAttributes: ['outcomeCode', 'requestedBy'], allowException: true,
  }),
  'working_memory.readback.failed': defineEvent({
    component: 'runtime.memory', eventName: 'working_memory.readback.failed', severities: ['ERROR'],
    requiredAttributes: ['operation', 'failureCategory', 'retryDirective', 'durationMs'],
    optionalAttributes: ['outcomeCode', 'requestedBy'], allowException: true,
  }),
  'working_memory.migration.completed': defineEvent({
    component: 'runtime.memory', eventName: 'working_memory.migration.completed', severities: ['INFO'],
    requiredAttributes: ['operation', 'outcomeCode', 'durationMs'], optionalAttributes: ['recordCount'],
  }),
  'working_memory.migration.failed': defineEvent({
    component: 'runtime.memory', eventName: 'working_memory.migration.failed', severities: ['ERROR'],
    requiredAttributes: ['operation', 'failureCategory', 'retryDirective', 'durationMs'],
    optionalAttributes: ['outcomeCode'], allowException: true,
  }),
  'working_memory.review.completed': defineEvent({
    component: 'runtime.memory', eventName: 'working_memory.review.completed', severities: ['INFO'],
    requiredAttributes: ['operation', 'outcomeCode', 'durationMs'], optionalAttributes: ['requestedBy', 'findingCount'],
  }),
  'working_memory.review.failed': defineEvent({
    component: 'runtime.memory', eventName: 'working_memory.review.failed', severities: ['ERROR'],
    requiredAttributes: ['operation', 'failureCategory', 'retryDirective', 'durationMs'],
    optionalAttributes: ['outcomeCode', 'requestedBy'], allowException: true,
  }),
  'logging.event.invalid': defineEvent({
    component: 'runtime.logging', eventName: 'logging.event.invalid', severities: ['ERROR'],
    requiredAttributes: ['component', 'validationCategory'], optionalAttributes: [],
  }),
  'logging.records.dropped': defineEvent({
    component: 'runtime.logging', eventName: 'logging.records.dropped', severities: ['WARN'],
    requiredAttributes: ['droppedCount', 'dropReason'], optionalAttributes: ['droppedSeverity'],
  }),
  'logging.sink.failed': defineEvent({
    component: 'runtime.logging', eventName: 'logging.sink.failed', severities: ['ERROR'],
    requiredAttributes: ['sink', 'failureCategory'], optionalAttributes: [],
  }),
  'logging.sink.recovered': defineEvent({
    component: 'runtime.logging', eventName: 'logging.sink.recovered', severities: ['INFO'],
    requiredAttributes: ['sink'], optionalAttributes: [],
  }),
} as const satisfies Record<string, EventDefinition>;

export type LogEventName = keyof typeof EVENT_CATALOG;
export type LogComponent = (typeof EVENT_CATALOG)[LogEventName]['component'];
export type ComponentEventName<C extends LogComponent> = {
  [E in LogEventName]: (typeof EVENT_CATALOG)[E]['component'] extends C ? E : never;
}[LogEventName];

type AttributeValue<Name extends CatalogAttributeName> =
  (typeof ATTRIBUTE_DEFINITIONS)[Name]['type'] extends 'string'
    ? string
    : (typeof ATTRIBUTE_DEFINITIONS)[Name]['type'] extends 'number'
      ? number
      : boolean;

type RequiredAttributeName<E extends LogEventName> =
  (typeof EVENT_CATALOG)[E]['requiredAttributes'][number];

type OptionalAttributeName<E extends LogEventName> =
  (typeof EVENT_CATALOG)[E]['optionalAttributes'][number];

export type EventFields<E extends LogEventName> = Readonly<
  { [Name in RequiredAttributeName<E>]: AttributeValue<Name> }
  & { [Name in OptionalAttributeName<E>]?: AttributeValue<Name> }
>;

export type EventLogOptions<E extends LogEventName> =
  Omit<LogOptions, 'fields'>
  & ([RequiredAttributeName<E>] extends [never]
    ? { fields?: EventFields<E> }
    : { fields: EventFields<E> });

type EventLogArguments<E extends LogEventName> =
  [RequiredAttributeName<E>] extends [never]
    ? readonly [event: E, options?: EventLogOptions<E>]
    : readonly [event: E, options: EventLogOptions<E>];

type ComponentLogArguments<C extends LogComponent> = {
  [E in ComponentEventName<C>]: EventLogArguments<E>;
}[ComponentEventName<C>];

type CatalogLogMethod<C extends LogComponent> =
  (...arguments_: ComponentLogArguments<C>) => void;

export interface CatalogLogger<C extends LogComponent> {
  debug: CatalogLogMethod<C>;
  info: CatalogLogMethod<C>;
  warn: CatalogLogMethod<C>;
  error: CatalogLogMethod<C>;
}

export function eventDefinition(eventName: string): EventDefinition | undefined {
  return (EVENT_CATALOG as Readonly<Record<string, EventDefinition>>)[eventName];
}
