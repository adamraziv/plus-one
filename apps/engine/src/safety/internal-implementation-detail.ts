export type InternalImplementationDetailMatchCategory =
  | 'relation_name'
  | 'schema_type'
  | 'structured_key'
  | 'workflow_jargon';

export function internalImplementationDetailMatchCategory(
  value: string,
): InternalImplementationDetailMatchCategory | undefined {
  if (/\b(?:reporting|accounting|operations|planning|ingestion|mastra_memory)\.[a-z][a-z0-9_]*\b/i.test(value)) {
    return 'relation_name';
  }
  if (/\b[A-Z][A-Za-z0-9]*(?:Schema)?V\d+\b/.test(value)) {
    return 'schema_type';
  }
  if (/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/.test(value)) {
    return 'structured_key';
  }
  if (
    /\b(?:maker|checker)(?:\s+(?:accepted|rejected|requested|verdict|artifact|output|result|team))?\b/i.test(value)
    || /\b(?:accounting|query|ingestion|planning|operations)?\s*team\s+status\b/i.test(value)
    || /\binternal(?:-only)?\b/i.test(value)
    || /\b(?:schemaName|schemaVersion|claimId|artifactHash|completionReason)\b/.test(value)
  ) {
    return 'workflow_jargon';
  }
  return undefined;
}
