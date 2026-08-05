import { buildLogEnvelope } from './record-builder.js';
import { sanitizeLogString } from './redaction.js';
import type { LogEnvelopeV1, LogSeverityText, LogSink } from './types.js';

const DEFAULT_CAPACITY = 4_096;
const CONTROL_INTERVAL_MS = 60_000;
const SEVERITY_ORDER: Record<LogSeverityText, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

export interface DispatcherOptions {
  sinks: readonly LogSink[];
  capacity?: number;
  stderr: { write(text: string): void };
  now?: () => number;
  startAfter?: Promise<void>;
}

interface QueuedRecord {
  sequence: number;
  record: LogEnvelopeV1;
  terminalBySink: Map<string, 'written' | 'failed'>;
  control: boolean;
}

interface FlushWaiter {
  barrier: number;
  resolve(): void;
}

export class LogDispatcher {
  private readonly sinks: readonly LogSink[];
  private readonly capacity: number;
  private readonly stderr: { write(text: string): void };
  private readonly now: () => number;
  private readonly startAfter: Promise<void>;
  private readonly queue: QueuedRecord[] = [];
  private readonly pendingSequences = new Set<number>();
  private readonly waiters: FlushWaiter[] = [];
  private readonly sinkHealthy = new Map<string, boolean>();
  private readonly droppedBySeverity = new Map<LogSeverityText, number>();
  private sequence = 0;
  private processing = false;
  private scheduled = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private droppedSinceControl = 0;
  private lastDropFallbackCount = 0;
  private lastDropFallbackAt = Number.NEGATIVE_INFINITY;

  constructor(options: DispatcherOptions) {
    this.sinks = options.sinks;
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    if (!Number.isInteger(this.capacity) || this.capacity < 1) {
      throw new Error('Logging queue capacity must be a positive integer');
    }
    this.stderr = options.stderr;
    this.now = options.now ?? Date.now;
    this.startAfter = options.startAfter ?? Promise.resolve();
    for (const sink of this.sinks) this.sinkHealthy.set(sink.name, true);
  }

  dispatch(record: LogEnvelopeV1): void {
    if (this.closed) return;
    this.enqueue(record, false);
  }

  flush(): Promise<void> {
    const barrier = this.sequence;
    this.schedule();
    if (!this.hasPendingAtOrBelow(barrier)) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.push({ barrier, resolve });
    });
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      await this.flush();
      await this.drain();
      this.reportDropsToStderr(true);
      const closeResults = await Promise.allSettled(
        this.sinks.map(async (sink) => sink.close()),
      );
      for (const [index, result] of closeResults.entries()) {
        if (result.status !== 'rejected') continue;
        const sink = this.sinks[index];
        this.writeFallback(
          `ERROR logging.sink.failed sink=${sanitizeLogString(sink?.name ?? 'unknown', 200)} category=close_failed\n`,
        );
      }
    })();
    return this.closePromise;
  }

  private enqueue(record: LogEnvelopeV1, control: boolean): void {
    const entry: QueuedRecord = {
      sequence: ++this.sequence,
      record,
      terminalBySink: new Map(),
      control,
    };
    if (this.queue.length >= this.capacity + (control ? 1 : 0)) {
      const displaced = this.displacementIndex(record.severityText);
      if (displaced === -1) {
        if (!control) this.noteDrop(record.severityText, 'queue_capacity');
        this.checkWaiters();
        return;
      }
      const [evicted] = this.queue.splice(displaced, 1);
      if (evicted !== undefined) {
        this.pendingSequences.delete(evicted.sequence);
        if (!evicted.control) this.noteDrop(evicted.record.severityText, 'severity_displaced');
      }
    }
    this.queue.push(entry);
    this.pendingSequences.add(entry.sequence);
    this.schedule();
  }

  private displacementIndex(incoming: LogSeverityText): number {
    if (incoming === 'DEBUG') return -1;
    const incomingOrder = SEVERITY_ORDER[incoming];
    let lowest = incomingOrder;
    for (const entry of this.queue) {
      const order = SEVERITY_ORDER[entry.record.severityText];
      if (!entry.control && order < lowest) lowest = order;
    }
    if (lowest >= incomingOrder) return -1;
    return this.queue.findIndex((entry) => (
      !entry.control && SEVERITY_ORDER[entry.record.severityText] === lowest
    ));
  }

  private schedule(): void {
    if (this.processing || this.scheduled || this.queue.length === 0) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.process();
    });
  }

  private async process(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      await this.startAfter;
      while (this.queue.length > 0) {
        const entry = this.queue.shift();
        if (entry === undefined) break;
        await this.deliver(entry);
        this.pendingSequences.delete(entry.sequence);
        this.checkWaiters();
        if (!entry.control && this.droppedSinceControl > 0) this.enqueueDropControl(entry.record);
      }
    } finally {
      this.processing = false;
      this.checkWaiters();
      if (this.queue.length > 0) this.schedule();
    }
  }

  private async deliver(entry: QueuedRecord): Promise<void> {
    const matching = this.sinks.filter((sink) => {
      try {
        return sink.matches(entry.record);
      } catch {
        return false;
      }
    });
    await Promise.all(matching.map(async (sink) => {
      try {
        await sink.write(entry.record);
        entry.terminalBySink.set(sink.name, 'written');
        if (this.sinkHealthy.get(sink.name) === false) {
          this.sinkHealthy.set(sink.name, true);
          this.enqueueSinkControl('logging.sink.recovered', sink.name, entry.record);
        }
      } catch {
        entry.terminalBySink.set(sink.name, 'failed');
        if (this.sinkHealthy.get(sink.name) !== false) {
          this.sinkHealthy.set(sink.name, false);
          this.writeFallback(`ERROR logging.sink.failed sink=${sanitizeLogString(sink.name, 200)} category=write_failed\n`);
          if (!entry.control) this.enqueueSinkControl('logging.sink.failed', sink.name, entry.record);
        }
      }
    }));
  }

  private enqueueDropControl(reference: LogEnvelopeV1): void {
    const droppedCount = this.droppedSinceControl;
    this.droppedSinceControl = 0;
    const severities = [...this.droppedBySeverity.entries()]
      .filter(([, count]) => count > 0)
      .map(([severity]) => severity);
    this.enqueue(buildLogEnvelope({
      component: 'runtime.logging',
      eventName: 'logging.records.dropped',
      severityText: 'WARN',
      fields: {
        droppedCount,
        dropReason: 'queue_capacity',
        droppedSeverity: severities.length === 1 ? severities[0] : 'mixed',
      },
      context: {},
      timestamp: new Date(this.now()),
      observedTimestamp: new Date(this.now()),
      resource: reference.resource,
    }), true);
  }

  private enqueueSinkControl(
    eventName: 'logging.sink.failed' | 'logging.sink.recovered',
    sink: string,
    reference: LogEnvelopeV1,
  ): void {
    this.enqueue(buildLogEnvelope({
      component: 'runtime.logging',
      eventName,
      severityText: eventName === 'logging.sink.failed' ? 'ERROR' : 'INFO',
      fields: {
        sink,
        ...(eventName === 'logging.sink.failed' ? { failureCategory: 'write_failed' } : {}),
      },
      context: {},
      timestamp: new Date(this.now()),
      observedTimestamp: new Date(this.now()),
      resource: reference.resource,
    }), true);
  }

  private noteDrop(severity: LogSeverityText, reason: string): void {
    this.droppedBySeverity.set(severity, (this.droppedBySeverity.get(severity) ?? 0) + 1);
    this.droppedSinceControl += 1;
    this.reportDropsToStderr(false, reason);
  }

  private reportDropsToStderr(force: boolean, reason = 'queue_capacity'): void {
    const count = [...this.droppedBySeverity.values()].reduce((total, value) => total + value, 0);
    if (count === this.lastDropFallbackCount) return;
    const now = this.now();
    if (!force && this.lastDropFallbackCount !== 0 && now - this.lastDropFallbackAt < CONTROL_INTERVAL_MS) {
      return;
    }
    this.lastDropFallbackCount = count;
    this.lastDropFallbackAt = now;
    this.writeFallback(`WARN logging.records.dropped count=${count} reason=${reason}\n`);
  }

  private writeFallback(message: string): void {
    try {
      this.stderr.write(message);
    } catch {
      return;
    }
  }

  private hasPendingAtOrBelow(barrier: number): boolean {
    for (const sequence of this.pendingSequences) {
      if (sequence <= barrier) return true;
    }
    return false;
  }

  private checkWaiters(): void {
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index];
      if (waiter !== undefined && !this.hasPendingAtOrBelow(waiter.barrier)) {
        this.waiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }

  private async drain(): Promise<void> {
    while (this.processing || this.scheduled || this.queue.length > 0) {
      this.schedule();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  }
}
