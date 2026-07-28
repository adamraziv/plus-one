import type { LogSeverityText } from './types.js';

export const ATTRIBUTE_DEFINITIONS = {
  mode: { output: 'runtime.mode', type: 'string' },
  readiness: { output: 'runtime.readiness', type: 'string' },
  status: { output: 'status', type: 'string' },
  channel: { output: 'channel', type: 'string' },
  durationMs: { output: 'duration.ms', type: 'number' },
  failureCategory: { output: 'failure.category', type: 'string' },
  role: { output: 'agent.role', type: 'string' },
  model: { output: 'agent.model', type: 'string' },
  attemptOrdinal: { output: 'agent.attempt.ordinal', type: 'number' },
  outcome: { output: 'outcome', type: 'string' },
  retryClassification: { output: 'retry.classification', type: 'string' },
  messageCount: { output: 'message.count', type: 'number' },
  matchCategory: { output: 'match.category', type: 'string' },
  step: { output: 'orchestrator.step.ordinal', type: 'number' },
  inputTokens: { output: 'usage.input_tokens', type: 'number' },
  outputTokens: { output: 'usage.output_tokens', type: 'number' },
  toolCallCount: { output: 'tool.call.count', type: 'number' },
  team: { output: 'team', type: 'string' },
  jobId: { output: 'scheduler.job.id', type: 'string' },
  occurrenceId: { output: 'scheduler.occurrence.id', type: 'string' },
  targetKind: { output: 'scheduler.target.kind', type: 'string' },
  retryCount: { output: 'retry.count', type: 'number' },
  sent: { output: 'delivery.send.attempted', type: 'boolean' },
  operation: { output: 'working_memory.operation', type: 'string' },
  outcomeCode: { output: 'working_memory.outcome.code', type: 'string' },
  retryDirective: { output: 'retry.directive', type: 'string' },
  requestedBy: { output: 'request.source', type: 'string' },
  findingCount: { output: 'working_memory.finding.count', type: 'number' },
  recordCount: { output: 'record.count', type: 'number' },
  component: { output: 'logging.component', type: 'string' },
  validationCategory: { output: 'logging.validation.category', type: 'string' },
  sink: { output: 'logging.sink.name', type: 'string' },
  droppedCount: { output: 'logging.records.dropped.count', type: 'number' },
  droppedSeverity: { output: 'logging.records.dropped.severity', type: 'string' },
  dropReason: { output: 'logging.records.dropped.reason', type: 'string' },
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

export function eventDefinition(eventName: string): EventDefinition | undefined {
  return (EVENT_CATALOG as Readonly<Record<string, EventDefinition>>)[eventName];
}
