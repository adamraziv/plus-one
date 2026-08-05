export type LogSeverityText = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export type LogLevel = LogSeverityText | 'WARNING';

export type LogScalar = string | number | boolean;

export type LogFields = Readonly<Record<string, LogScalar | undefined>>;

export type LogAttributes = Readonly<Record<string, LogScalar>>;

export type LogContextKey =
  | 'requestId'
  | 'conversationId'
  | 'householdId'
  | 'taskId'
  | 'runId'
  | 'deliveryId';

export type LogContext = Readonly<Partial<Record<LogContextKey, string>>>;

export type LogName = 'agent' | 'errors' | 'gateway';

export interface LogOptions {
  fields?: LogFields;
  error?: unknown;
}

export interface LogEnvelopeV1 {
  schemaVersion: 1;
  timestamp: string;
  observedTimestamp: string;
  severityText: LogSeverityText;
  severityNumber: 5 | 9 | 13 | 17;
  eventName: string;
  body: string;
  resource: Readonly<Record<string, string>>;
  instrumentationScope: Readonly<{ name: string }>;
  traceId?: string;
  spanId?: string;
  attributes: LogAttributes;
}

export interface BuildLogEnvelopeInput {
  component: string;
  eventName: string;
  severityText: LogSeverityText;
  fields?: LogFields;
  error?: unknown;
  context: LogContext;
  timestamp: Date;
  observedTimestamp: Date;
  resource: Readonly<Record<string, string>>;
  traceId?: string;
  spanId?: string;
}

export interface LogRecord {
  timestamp: Date;
  level: LogLevel;
  component: string;
  event: string;
  context: LogContext;
  fields: LogFields;
  error?: Readonly<{
    name: string;
    message: string;
    stack?: string;
    code?: string;
    category?: string;
    responseBody?: string;
    statusCode?: number;
  }>;
}

export interface LogSink {
  readonly name: string;
  matches(record: LogEnvelopeV1): boolean;
  write(record: LogEnvelopeV1): Promise<void>;
  close(): Promise<void>;
}

export interface LogQuery {
  homeDirectory: string;
  log: LogName;
  lines?: number;
  minLevel?: LogSeverityText;
  correlations?: LogContext;
  component?: string;
  event?: string;
  since?: Date;
  diagnostics?: { write(text: string): void };
}

export interface ReadableLogRecord {
  envelope: LogEnvelopeV1;
  source: {
    path: string;
    format: 'ndjson' | 'legacy';
    generation: number;
    byteOffset: number;
  };
  legacyDisplayMessage?: string;
}

export interface LoggingOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
  level?: LogSeverityText | 'WARNING';
  maxSizeMb?: number;
  backupCount?: number;
  mode?: 'cli' | 'gateway' | 'launcher';
  stderr?: { write(text: string): void };
  stdout?: { write(text: string): void };
  queueCapacity?: number;
  clock?: () => Date;
  instanceId?: string;
  sinks?: readonly LogSink[];
}

export interface LoggingHandle {
  logDirectory: string;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface Logger<EventName extends string = string> {
  debug(event: EventName, options?: LogOptions): void;
  info(event: EventName, options?: LogOptions): void;
  warn(event: EventName, options?: LogOptions): void;
  error(event: EventName, options?: LogOptions): void;
}
