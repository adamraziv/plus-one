import {
  ATTRIBUTE_DEFINITIONS,
  eventDefinition,
  type AttributeDefinition,
  type CatalogAttributeName,
} from './event-catalog.js';
import { sanitizeLogString, serializeLogError } from './redaction.js';
import type {
  BuildLogEnvelopeInput,
  LogEnvelopeV1,
  LogScalar,
  LogSeverityText,
} from './types.js';

export const SEVERITY_NUMBER = {
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
} as const;

const CONTEXT_ATTRIBUTES = {
  requestId: 'request.id',
  conversationId: 'plus_one.conversation.id',
  householdId: 'plus_one.household.id',
  taskId: 'plus_one.task.id',
  runId: 'plus_one.run.id',
  deliveryId: 'plus_one.delivery.id',
} as const;

export function buildLogEnvelope(input: BuildLogEnvelopeInput): LogEnvelopeV1 {
  try {
    const definition = eventDefinition(input.eventName);
    if (definition === undefined) return invalidEnvelope(input, 'unknown_event');
    if (definition.component !== input.component) return invalidEnvelope(input, 'component_mismatch');
    if (!definition.severities.includes(input.severityText)) {
      return invalidEnvelope(input, 'severity_mismatch');
    }

    const attributes: Record<string, LogScalar> = {};
    for (const [contextName, outputName] of Object.entries(CONTEXT_ATTRIBUTES)) {
      const value = input.context[contextName as keyof typeof CONTEXT_ATTRIBUTES];
      if (value !== undefined) attributes[outputName] = sanitizeLogString(value);
    }

    const allowed = new Set<CatalogAttributeName>([
      ...definition.requiredAttributes,
      ...definition.optionalAttributes,
    ]);
    for (const attributeName of Object.keys(input.fields ?? {})) {
      if (!allowed.has(attributeName as CatalogAttributeName)) {
        return invalidEnvelope(input, 'unknown_attribute');
      }
    }
    for (const attributeName of allowed) {
      const value = input.fields?.[attributeName];
      if (value === undefined) {
        if (definition.requiredAttributes.includes(attributeName)) {
          return invalidEnvelope(input, 'required_attribute_missing');
        }
        continue;
      }
      const attributeDefinition = ATTRIBUTE_DEFINITIONS[attributeName];
      if (!matchesDefinition(value, attributeDefinition)) {
        return invalidEnvelope(input, 'attribute_type_invalid');
      }
      attributes[attributeDefinition.output] = sanitizeScalar(value, attributeDefinition);
    }

    if (input.error !== undefined && definition.allowException === true) {
      const error = serializeLogError(input.error, {
        includeStack: input.severityText === 'ERROR',
      });
      attributes['exception.type'] = error.name;
      attributes['exception.message'] = error.message;
      if (error.stack !== undefined) attributes['exception.stacktrace'] = error.stack;
      if (error.code !== undefined) attributes['error.code'] = error.code;
      if (error.category !== undefined) attributes['error.category'] = error.category;
    }

    return freezeEnvelope({
      schemaVersion: 1,
      timestamp: safeIso(input.timestamp),
      observedTimestamp: safeIso(input.observedTimestamp),
      severityText: input.severityText,
      severityNumber: SEVERITY_NUMBER[input.severityText],
      eventName: definition.eventName,
      body: definition.eventName,
      resource: sanitizeResource(input.resource),
      instrumentationScope: { name: definition.component },
      ...(input.traceId === undefined ? {} : { traceId: sanitizeLogString(input.traceId, 200) }),
      ...(input.spanId === undefined ? {} : { spanId: sanitizeLogString(input.spanId, 200) }),
      attributes,
    });
  } catch {
    return invalidEnvelope(input, 'builder_failure');
  }
}

function invalidEnvelope(
  input: BuildLogEnvelopeInput,
  category: string,
): LogEnvelopeV1 {
  const severityText: LogSeverityText = 'ERROR';
  return freezeEnvelope({
    schemaVersion: 1,
    timestamp: safeIso(input.timestamp),
    observedTimestamp: safeIso(input.observedTimestamp),
    severityText,
    severityNumber: SEVERITY_NUMBER[severityText],
    eventName: 'logging.event.invalid',
    body: 'logging.event.invalid',
    resource: sanitizeResource(input.resource),
    instrumentationScope: { name: 'runtime.logging' },
    attributes: {
      'logging.component': sanitizeLogString(input.component, 200),
      'logging.validation.category': category,
    },
  });
}

function matchesDefinition(
  value: LogScalar,
  definition: AttributeDefinition,
): boolean {
  if (typeof value !== definition.type) return false;
  if (definition.type !== 'number' || typeof value !== 'number') return true;
  return Number.isFinite(value)
    && value >= definition.minimum
    && value <= definition.maximum;
}

function sanitizeScalar(
  value: LogScalar,
  definition: AttributeDefinition,
): LogScalar {
  return typeof value === 'string' && definition.type === 'string'
    ? sanitizeLogString(value, definition.maxLength)
    : value;
}

function sanitizeResource(
  resource: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(resource).map(([key, value]) => [
      sanitizeLogString(key, 200),
      sanitizeLogString(value, 200),
    ]),
  ));
}

function safeIso(value: Date): string {
  return Number.isFinite(value.getTime()) ? value.toISOString() : new Date(0).toISOString();
}

function freezeEnvelope(envelope: LogEnvelopeV1): LogEnvelopeV1 {
  Object.freeze(envelope.attributes);
  Object.freeze(envelope.instrumentationScope);
  Object.freeze(envelope.resource);
  return Object.freeze(envelope);
}
