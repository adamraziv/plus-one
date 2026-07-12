export type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

export type LogScalar = string | number | boolean;

export type LogFields = Readonly<Record<string, LogScalar | undefined>>;

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

export interface Logger {
  debug(event: string, options?: LogOptions): void;
  info(event: string, options?: LogOptions): void;
  warn(event: string, options?: LogOptions): void;
  error(event: string, options?: LogOptions): void;
}
