import { sanitizeLogString } from './redaction.js';

export interface OperationalLogError {
  name: 'OperationalError';
  message: string;
  stack: string;
  code: string;
  category: string;
}

export function createOperationalLogError(input: {
  message: string;
  code: string;
  category: string;
}): OperationalLogError {
  const name = 'OperationalError';
  const message = sanitizeLogString(input.message);
  return {
    name,
    message,
    stack: `${name}: ${message}`,
    code: sanitizeLogString(input.code, 200),
    category: sanitizeLogString(input.category, 200),
  };
}
