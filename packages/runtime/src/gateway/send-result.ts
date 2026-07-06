export type TransportFailureCategory =
  | 'too_long'
  | 'bad_format'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'transient'
  | 'ambiguous'
  | 'unknown';

export interface TransportFailure {
  category: TransportFailureCategory;
  message: string;
  retryable: boolean;
  receiptLookupRequired: boolean;
  retryAfterMs?: number;
}

export type TransportSendResult =
  | { ok: true; platformMessageId: string; raw?: unknown }
  | { ok: false; failure: TransportFailure; raw?: unknown };

export class TransportSendError extends Error {
  constructor(readonly failure: TransportFailure) {
    super(failure.message);
    this.name = 'TransportSendError';
  }
}

export function classifyTelegramApiFailure(input: {
  status?: number;
  description?: string;
  retryAfterSeconds?: number;
}): TransportFailure {
  const description = input.description ?? 'Telegram API request failed';
  const normalized = description.toLowerCase();
  if (input.status === 429) {
    return {
      category: 'rate_limited',
      message: description,
      retryable: true,
      receiptLookupRequired: false,
      ...(input.retryAfterSeconds === undefined ? {} : { retryAfterMs: input.retryAfterSeconds * 1_000 }),
    };
  }
  if (input.status !== undefined && input.status >= 500) {
    return { category: 'transient', message: description, retryable: true, receiptLookupRequired: false };
  }
  if (normalized.includes('too long') || normalized.includes('message is too long')) {
    return { category: 'too_long', message: description, retryable: false, receiptLookupRequired: false };
  }
  if (normalized.includes('parse entities') || normalized.includes('cannot parse') || normalized.includes('bad format')) {
    return { category: 'bad_format', message: description, retryable: false, receiptLookupRequired: false };
  }
  if (input.status === 403 || normalized.includes('forbidden') || normalized.includes('blocked by the user')) {
    return { category: 'forbidden', message: description, retryable: false, receiptLookupRequired: false };
  }
  if (input.status === 404 || normalized.includes('not found')) {
    return { category: 'not_found', message: description, retryable: false, receiptLookupRequired: false };
  }
  return { category: 'unknown', message: description, retryable: false, receiptLookupRequired: false };
}

export function transportFailureFromUnknown(error: unknown): TransportFailure {
  if (error instanceof TransportSendError) return error.failure;
  if (error instanceof TypeError) {
    return {
      category: 'ambiguous',
      message: error.message,
      retryable: true,
      receiptLookupRequired: true,
    };
  }
  if (error instanceof Error) {
    return {
      category: 'transient',
      message: error.message,
      retryable: true,
      receiptLookupRequired: false,
    };
  }
  return {
    category: 'unknown',
    message: String(error),
    retryable: false,
    receiptLookupRequired: false,
  };
}
