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
  }>;
}

export interface LogSink {
  write(record: LogRecord): void;
  close(): void;
}

export interface LoggingOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
  level?: LogLevel;
  maxSizeMb?: number;
  backupCount?: number;
  mode?: 'cli' | 'gateway';
  stderr?: { write(text: string): void };
}

export interface LoggingHandle {
  logDirectory: string;
  flush(): void;
  close(): void;
}

export interface Logger<EventName extends string = string> {
  debug(event: EventName, options?: LogOptions): void;
  info(event: EventName, options?: LogOptions): void;
  warn(event: EventName, options?: LogOptions): void;
  error(event: EventName, options?: LogOptions): void;
}
