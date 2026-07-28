import { describe, expect, it } from 'vitest';
import { buildLogEnvelope } from './record-builder.js';

const RESOURCE = {
  'service.name': 'plus-one',
  'service.instance.id': 'instance_1',
  'deployment.environment.name': 'test',
} as const;

function baseInput() {
  return {
    component: 'runtime.agent',
    eventName: 'agent.completed',
    severityText: 'INFO' as const,
    fields: {
      role: 'journal_maker',
      model: 'provider/model',
      attemptOrdinal: 1,
      durationMs: 120,
    },
    context: {
      requestId: 'req_1',
      householdId: 'household_1',
      taskId: 'task_1',
      runId: 'run_1',
    },
    timestamp: new Date('2026-07-28T10:15:30.123Z'),
    observedTimestamp: new Date('2026-07-28T10:15:30.124Z'),
    resource: RESOURCE,
  };
}

describe('buildLogEnvelope', () => {
  it('builds the exact canonical envelope and dotted attributes', () => {
    expect(buildLogEnvelope(baseInput())).toEqual({
      schemaVersion: 1,
      timestamp: '2026-07-28T10:15:30.123Z',
      observedTimestamp: '2026-07-28T10:15:30.124Z',
      severityText: 'INFO',
      severityNumber: 9,
      eventName: 'agent.completed',
      body: 'agent.completed',
      resource: RESOURCE,
      instrumentationScope: { name: 'runtime.agent' },
      attributes: {
        'request.id': 'req_1',
        'plus_one.household.id': 'household_1',
        'plus_one.task.id': 'task_1',
        'plus_one.run.id': 'run_1',
        'agent.role': 'journal_maker',
        'agent.model': 'provider/model',
        'agent.attempt.ordinal': 1,
        'duration.ms': 120,
      },
    });
  });

  it('omits unknown optional attributes without leaking their names or values', () => {
    const envelope = buildLogEnvelope({
      ...baseInput(),
      fields: {
        ...baseInput().fields,
        unexpectedSecretField: 'private-value',
      },
    });
    expect(envelope.eventName).toBe('agent.completed');
    expect(JSON.stringify(envelope)).not.toContain('unexpectedSecretField');
    expect(JSON.stringify(envelope)).not.toContain('private-value');
  });

  it('replaces unknown, wrong-component, illegal-severity, and incomplete events safely', () => {
    for (const input of [
      { ...baseInput(), eventName: 'dynamic.private-value' },
      { ...baseInput(), component: 'runtime.delivery' },
      { ...baseInput(), severityText: 'WARN' as const },
      { ...baseInput(), fields: { durationMs: 120 } },
    ]) {
      const envelope = buildLogEnvelope(input);
      expect(envelope.eventName).toBe('logging.event.invalid');
      expect(envelope.body).toBe('logging.event.invalid');
      expect(envelope.instrumentationScope).toEqual({ name: 'runtime.logging' });
      expect(Object.keys(envelope.attributes).sort()).toEqual([
        'logging.component',
        'logging.validation.category',
      ]);
      expect(JSON.stringify(envelope)).not.toContain('dynamic.private-value');
      expect(JSON.stringify(envelope)).not.toContain('journal_maker');
    }
  });

  it('sanitizes CR/LF and secret patterns and maps WARN to number 13', () => {
    const envelope = buildLogEnvelope({
      ...baseInput(),
      component: 'runtime.orchestrator',
      eventName: 'orchestrator.response.withheld',
      severityText: 'WARN',
      fields: { matchCategory: 'unsafe\nAuthorization: Bearer secret-value\rnext' },
    });
    expect(envelope.severityNumber).toBe(13);
    expect(envelope.attributes['match.category']).not.toMatch(/[\r\n]/);
    expect(envelope.attributes['match.category']).not.toContain('secret-value');
  });

  it('includes a bounded sanitized stack only for ERROR records', () => {
    const error = new Error('password=secret-value');
    error.name = 'ProviderError';
    error.stack = `ProviderError: password=secret-value\n${'frame\n'.repeat(2_000)}`;

    const warning = buildLogEnvelope({
      ...baseInput(),
      eventName: 'agent.failed',
      severityText: 'WARN',
      fields: {
        role: 'journal_maker',
        model: 'provider/model',
        attemptOrdinal: 1,
        failureCategory: 'retryable',
        durationMs: 120,
      },
      error,
    });
    const failure = buildLogEnvelope({
      ...baseInput(),
      eventName: 'agent.failed',
      severityText: 'ERROR',
      fields: {
        role: 'journal_maker',
        model: 'provider/model',
        attemptOrdinal: 1,
        failureCategory: 'exhausted',
        durationMs: 120,
      },
      error,
    });

    expect(warning.attributes['exception.stacktrace']).toBeUndefined();
    expect(failure.attributes['exception.stacktrace']).toEqual(expect.any(String));
    expect(String(failure.attributes['exception.stacktrace']).length).toBeLessThanOrEqual(8_000);
    expect(JSON.stringify(failure)).not.toContain('secret-value');
  });
});
