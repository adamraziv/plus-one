import { containsOpaqueIdentifierToken } from '@plus-one/contracts';

export type InternalIdentifierMatchCategory =
  | 'identifier_label'
  | 'identifier_token'
  | 'short_token';

export function internalIdentifierMatchCategory(value: string): InternalIdentifierMatchCategory | undefined {
  if (/\b(?:household|book|account)\s*(?:id|identifier)\b/i.test(value)) {
    return 'identifier_label';
  }
  if (containsOpaqueIdentifierToken(value) || /\b(?:household|acct)_[a-z0-9_-]+\b/i.test(value)) {
    return 'identifier_token';
  }
  if (/\b[hb]\d{3,}\b/i.test(value)) {
    return 'short_token';
  }
  return undefined;
}
