import { z } from 'zod';

type OpaqueIdentifierDefinition = {
  prefix: string;
  minSuffixLength: number;
  maxSuffixLength: number;
};

const CROCKFORD_ULID_CHARACTERS = '[0-9A-HJKMNP-TV-Z]';

export const OpaqueIdentifierDefinitions = {
  household: { prefix: 'hh', minSuffixLength: 26, maxSuffixLength: 26 },
  task: { prefix: 'task', minSuffixLength: 26, maxSuffixLength: 26 },
  run: { prefix: 'run', minSuffixLength: 26, maxSuffixLength: 26 },
  artifact: { prefix: 'artifact', minSuffixLength: 26, maxSuffixLength: 26 },
  command: { prefix: 'command', minSuffixLength: 26, maxSuffixLength: 26 },
  receipt: { prefix: 'receipt', minSuffixLength: 26, maxSuffixLength: 26 },
  job: { prefix: 'job', minSuffixLength: 26, maxSuffixLength: 26 },
  occurrence: { prefix: 'occurrence', minSuffixLength: 26, maxSuffixLength: 26 },
  delivery: { prefix: 'delivery', minSuffixLength: 26, maxSuffixLength: 26 },
  conversation: { prefix: 'conversation', minSuffixLength: 26, maxSuffixLength: 26 },
  evidence: { prefix: 'evidence', minSuffixLength: 26, maxSuffixLength: 26 },
  book: { prefix: 'book', minSuffixLength: 26, maxSuffixLength: 26 },
  bookConfiguration: { prefix: 'bookconfig', minSuffixLength: 26, maxSuffixLength: 26 },
  account: { prefix: 'account', minSuffixLength: 26, maxSuffixLength: 26 },
  accountSourceMapping: { prefix: 'accountmap', minSuffixLength: 26, maxSuffixLength: 26 },
  period: { prefix: 'period', minSuffixLength: 26, maxSuffixLength: 26 },
  draftSeries: { prefix: 'draftseries', minSuffixLength: 26, maxSuffixLength: 26 },
  journalDraft: { prefix: 'draft', minSuffixLength: 26, maxSuffixLength: 26 },
  journal: { prefix: 'journal', minSuffixLength: 26, maxSuffixLength: 26 },
  posting: { prefix: 'posting', minSuffixLength: 26, maxSuffixLength: 26 },
  counterparty: { prefix: 'counterparty', minSuffixLength: 26, maxSuffixLength: 26 },
  tag: { prefix: 'tag', minSuffixLength: 26, maxSuffixLength: 26 },
  confirmation: { prefix: 'confirm', minSuffixLength: 26, maxSuffixLength: 26 },
  mutationReadback: { prefix: 'readback', minSuffixLength: 26, maxSuffixLength: 26 },
  idempotency: { prefix: 'idem', minSuffixLength: 26, maxSuffixLength: 120 },
  sourceDocument: { prefix: 'source', minSuffixLength: 26, maxSuffixLength: 26 },
  importBatch: { prefix: 'import', minSuffixLength: 26, maxSuffixLength: 26 },
  rawRow: { prefix: 'rawrow', minSuffixLength: 26, maxSuffixLength: 26 },
  normalizedRow: { prefix: 'normrow', minSuffixLength: 26, maxSuffixLength: 26 },
  matchDecision: { prefix: 'match', minSuffixLength: 26, maxSuffixLength: 26 },
  statementSnapshot: { prefix: 'snapshot', minSuffixLength: 26, maxSuffixLength: 26 },
  statementLine: { prefix: 'stmtline', minSuffixLength: 26, maxSuffixLength: 26 },
  reconciliation: { prefix: 'recon', minSuffixLength: 26, maxSuffixLength: 26 },
  reconciliationItem: { prefix: 'reconitem', minSuffixLength: 26, maxSuffixLength: 26 },
  periodEvent: { prefix: 'periodevent', minSuffixLength: 26, maxSuffixLength: 26 },
  discrepancy: { prefix: 'discrepancy', minSuffixLength: 26, maxSuffixLength: 26 },
} as const satisfies Record<string, OpaqueIdentifierDefinition>;

export type OpaqueIdentifierKind = keyof typeof OpaqueIdentifierDefinitions;

const OpaqueIdentifierTokenPatterns = Object.values(OpaqueIdentifierDefinitions).map((definition) =>
  new RegExp(
    `\\b${definition.prefix}_${CROCKFORD_ULID_CHARACTERS}{${definition.minSuffixLength},${definition.maxSuffixLength}}\\b`,
    'i',
  ));

const OpaqueIdentifierPrefixTokenPatterns = Object.values(OpaqueIdentifierDefinitions).map((definition) =>
  new RegExp(`\\b${definition.prefix}_[a-z0-9_-]+\\b`, 'i'));

export function opaqueIdentifierSchema<const Brand extends string>(kind: OpaqueIdentifierKind) {
  const definition = OpaqueIdentifierDefinitions[kind];
  return z.string()
    .regex(
      new RegExp(
        `^${definition.prefix}_${CROCKFORD_ULID_CHARACTERS}{${definition.minSuffixLength},${definition.maxSuffixLength}}$`,
      ),
      `Expected ${definition.prefix}_ followed by an opaque Crockford identifier`,
    )
    .brand<Brand>();
}

export function containsOpaqueIdentifier(value: string): boolean {
  return OpaqueIdentifierTokenPatterns.some((pattern) => pattern.test(value));
}

export function containsOpaqueIdentifierToken(value: string): boolean {
  return OpaqueIdentifierPrefixTokenPatterns.some((pattern) => pattern.test(value));
}
