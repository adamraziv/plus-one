import { describe, expect, it } from 'vitest';
import { EVENT_CATALOG } from './event-catalog.js';

const REQUIRED_EVENTS = [
  'runtime.started',
  'runtime.readiness.changed',
  'runtime.stopped',
  'runtime.failed',
  'launcher.starting',
  'launcher.started',
  'launcher.start.failed',
  'launcher.stop.requested',
  'launcher.stopped',
  'launcher.stop.failed',
  'gateway.inbound.accepted',
  'gateway.inbound.duplicate',
  'gateway.inbound.queued',
  'gateway.turn.started',
  'gateway.turn.completed',
  'gateway.turn.failed',
  'turn.started',
  'turn.context.prepared',
  'turn.completed',
  'turn.failed',
  'orchestrator.delegation.completed',
  'orchestrator.delegation.failed',
  'orchestrator.response.withheld',
  'orchestrator.checked_response.withheld',
  'orchestrator.step.completed',
  'agent.started',
  'agent.completed',
  'agent.failed',
  'delivery.started',
  'delivery.processing.completed',
  'delivery.reserved',
  'delivery.sent',
  'delivery.completed',
  'delivery.failed',
  'delivery.ambiguous',
  'scheduler.run.started',
  'scheduler.run.completed',
  'scheduler.run.skipped',
  'scheduler.run.timed_out',
  'scheduler.run.failed',
  'pairing.approved',
  'pairing.revoked',
  'working_memory.read.completed',
  'working_memory.read.failed',
  'working_memory.mutation.completed',
  'working_memory.mutation.rejected',
  'working_memory.write.failed',
  'working_memory.readback.failed',
  'working_memory.migration.completed',
  'working_memory.migration.failed',
  'working_memory.review.completed',
  'working_memory.review.failed',
  'logging.event.invalid',
  'logging.records.dropped',
  'logging.sink.failed',
  'logging.sink.recovered',
] as const;

describe('EVENT_CATALOG', () => {
  it('contains every approved operational and launcher event', () => {
    expect(Object.keys(EVENT_CATALOG).sort()).toEqual([...REQUIRED_EVENTS].sort());
  });

  it('keeps each definition keyed by its stable event name', () => {
    for (const [eventName, definition] of Object.entries(EVENT_CATALOG)) {
      expect(definition.eventName).toBe(eventName);
      expect(definition.component).toMatch(/^[a-z][a-z0-9_.]+$/);
      expect(definition.severities.length).toBeGreaterThan(0);
      expect(new Set(definition.severities).size).toBe(definition.severities.length);
    }
  });
});
