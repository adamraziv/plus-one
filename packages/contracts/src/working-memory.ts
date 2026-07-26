import { z } from 'zod';
import { ErrorCategorySchemaV1, RetryDirectiveSchemaV1 } from './errors.js';
import { ConversationIdSchema, HouseholdIdSchema } from './ids.js';
import { JsonValueSchema, type JsonValue } from './json.js';
import { opaqueIdentifierSchema } from './opaque-identifiers.js';
import { UtcInstantSchema } from './time.js';

export const MAX_WORKING_MEMORY_TEXT_LENGTH = 500;
export const MAX_WORKING_MEMORY_KEY_LENGTH = 128;
export const MAX_WORKING_MEMORY_LIST_ITEMS = 20;
export const MAX_WORKING_MEMORY_RECORD_ENTRIES = 50;

const workingMemoryText = z.string()
  .trim()
  .min(1)
  .max(MAX_WORKING_MEMORY_TEXT_LENGTH);
const workingMemoryKey = z.string()
  .trim()
  .min(1)
  .max(MAX_WORKING_MEMORY_KEY_LENGTH)
  .regex(/^[A-Za-z0-9:_./-]+$/);
const workingMemoryList = z.array(workingMemoryText).max(MAX_WORKING_MEMORY_LIST_ITEMS);
const priority = z.enum(['low', 'medium', 'high']);
const savingStyle = z.enum(['aggressive', 'balanced', 'conservative']);

function boundedRecord<Value extends z.ZodType>(value: Value) {
  return z.record(workingMemoryKey, value).refine(
    (record) => Object.keys(record).length <= MAX_WORKING_MEMORY_RECORD_ENTRIES,
    `Working Memory records may contain at most ${MAX_WORKING_MEMORY_RECORD_ENTRIES} entries`,
  );
}

const memberCommunication = z.object({
  tone: workingMemoryText.optional(),
  detail: workingMemoryText.optional(),
}).strict();

const member = z.object({
  nickname: workingMemoryText.optional(),
  preferredName: workingMemoryText.optional(),
  communication: memberCommunication.optional(),
}).strict();

const goal = z.object({
  summary: workingMemoryText,
  horizon: workingMemoryText.optional(),
  priority: priority.optional(),
}).strict();

const savingPreferences = z.object({
  style: savingStyle.optional(),
  priorities: workingMemoryList.optional(),
  cadence: workingMemoryText.optional(),
  constraints: workingMemoryList.optional(),
}).strict();

const communication = z.object({
  tone: workingMemoryText.optional(),
  detail: workingMemoryText.optional(),
  reminders: workingMemoryText.optional(),
}).strict();

export const LegacyHouseholdWorkingMemorySchema = z.object({
  goals: boundedRecord(goal).optional(),
  savingPreferences: savingPreferences.optional(),
  communication: communication.optional(),
  conventions: boundedRecord(workingMemoryText).optional(),
  members: boundedRecord(member).optional(),
}).strict();
export type LegacyHouseholdWorkingMemory = z.infer<typeof LegacyHouseholdWorkingMemorySchema>;

export const WorkingMemoryEntryIdSchema =
  opaqueIdentifierSchema<'WorkingMemoryEntryId'>('workingMemoryEntry');
export type WorkingMemoryEntryId = z.infer<typeof WorkingMemoryEntryIdSchema>;

export const WorkingMemoryProposalIdSchema =
  opaqueIdentifierSchema<'WorkingMemoryProposalId'>('workingMemoryProposal');
export type WorkingMemoryProposalId = z.infer<typeof WorkingMemoryProposalIdSchema>;

export const MAX_WORKING_MEMORY_DOCUMENT_BYTES = 64 * 1024;
export const MAX_WORKING_MEMORY_VALUE_DEPTH = 6;

const DANGEROUS_WORKING_MEMORY_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function addWorkingMemoryIssue(
  context: z.RefinementCtx,
  message: string,
  path: PropertyKey[] = [],
): void {
  context.addIssue({ code: 'custom', message, path });
}

function validateWorkingMemoryValue(
  value: JsonValue,
  context: z.RefinementCtx,
  depth: number,
  path: PropertyKey[] = [],
): void {
  if (depth > MAX_WORKING_MEMORY_VALUE_DEPTH) {
    addWorkingMemoryIssue(context, `Working Memory values may have a maximum depth of ${MAX_WORKING_MEMORY_VALUE_DEPTH}`, path);
    return;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_WORKING_MEMORY_TEXT_LENGTH) {
      addWorkingMemoryIssue(
        context,
        `Working Memory strings may contain at most ${MAX_WORKING_MEMORY_TEXT_LENGTH} characters`,
        path,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_WORKING_MEMORY_LIST_ITEMS) {
      addWorkingMemoryIssue(
        context,
        `Working Memory lists may contain at most ${MAX_WORKING_MEMORY_LIST_ITEMS} items`,
        path,
      );
    }
    value.forEach((item, index) => validateWorkingMemoryValue(item, context, depth + 1, [...path, index]));
    return;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length > MAX_WORKING_MEMORY_RECORD_ENTRIES) {
      addWorkingMemoryIssue(
        context,
        `Working Memory objects may contain at most ${MAX_WORKING_MEMORY_RECORD_ENTRIES} entries`,
        path,
      );
    }
    for (const key of keys) {
      if (key.length > MAX_WORKING_MEMORY_KEY_LENGTH) {
        addWorkingMemoryIssue(
          context,
          `Working Memory keys may contain at most ${MAX_WORKING_MEMORY_KEY_LENGTH} characters`,
          [...path, key],
        );
      }
      if (DANGEROUS_WORKING_MEMORY_KEYS.has(key)) {
        addWorkingMemoryIssue(context, `Working Memory key is not allowed: ${key}`, [...path, key]);
      }
      validateWorkingMemoryValue(value[key]!, context, depth + 1, [...path, key]);
    }
  }
}

function validateDangerousWorkingMemoryKeys(
  value: unknown,
  context: z.RefinementCtx,
  path: PropertyKey[] = [],
  seen = new Set<object>(),
): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateDangerousWorkingMemoryKeys(item, context, [...path, index], seen));
    return;
  }
  for (const key of Object.keys(value)) {
    if (DANGEROUS_WORKING_MEMORY_KEYS.has(key)) {
      addWorkingMemoryIssue(context, `Working Memory key is not allowed: ${key}`, [...path, key]);
    }
    validateDangerousWorkingMemoryKeys(
      (value as Record<string, unknown>)[key],
      context,
      [...path, key],
      seen,
    );
  }
}

const workingMemoryValueSchema = z.unknown().superRefine((value, context) => {
  validateDangerousWorkingMemoryKeys(value, context);
  const parsed = JsonValueSchema.safeParse(value);
  if (!parsed.success) {
    addWorkingMemoryIssue(context, 'Working Memory values must be valid JSON');
    return;
  }
  validateWorkingMemoryValue(value as JsonValue, context, 0);
});

export const WorkingMemoryValueSchema = workingMemoryValueSchema as z.ZodType<JsonValue>;
export type WorkingMemoryValue = z.infer<typeof WorkingMemoryValueSchema>;

export const WorkingMemoryKindSchema = z.enum([
  'goal',
  'saving_preference',
  'communication_preference',
  'convention',
  'member_context',
  'other',
]);
export type WorkingMemoryKind = z.infer<typeof WorkingMemoryKindSchema>;

const workingMemorySummary = z.string().trim().min(1).max(MAX_WORKING_MEMORY_TEXT_LENGTH);

export const WorkingMemoryLifecycleSchema = z.object({
  createdAt: UtcInstantSchema,
  updatedAt: UtcInstantSchema,
  lastReviewedAt: UtcInstantSchema.optional(),
  expiresAt: UtcInstantSchema.optional(),
}).strict();
export type WorkingMemoryLifecycle = z.infer<typeof WorkingMemoryLifecycleSchema>;

export const WorkingMemoryEntrySchema = z.object({
  kind: WorkingMemoryKindSchema,
  summary: workingMemorySummary,
  scope: z.enum(['household', 'member']),
  ownerPrincipalRef: z.string().min(1).max(512).optional(),
  value: WorkingMemoryValueSchema,
  lifecycle: WorkingMemoryLifecycleSchema.optional(),
}).strict().superRefine((entry, context) => {
  if (entry.scope === 'member' && entry.ownerPrincipalRef === undefined) {
    context.addIssue({ code: 'custom', message: 'Member entries require an owner.' });
  }
  if (entry.scope === 'household' && entry.ownerPrincipalRef !== undefined) {
    context.addIssue({ code: 'custom', message: 'Household entries cannot have an owner.' });
  }
});
export type WorkingMemoryEntry = z.infer<typeof WorkingMemoryEntrySchema>;

function validateWorkingMemoryDocumentBounds(
  document: { version: 1; entries: Record<string, WorkingMemoryEntry> },
  context: z.RefinementCtx,
): void {
  if (Object.keys(document.entries).length > MAX_WORKING_MEMORY_RECORD_ENTRIES) {
    addWorkingMemoryIssue(
      context,
      `Working Memory documents may contain at most ${MAX_WORKING_MEMORY_RECORD_ENTRIES} entries`,
      ['entries'],
    );
  }
  const serialized = JSON.stringify(document);
  if (serialized === undefined) {
    addWorkingMemoryIssue(context, 'Working Memory document must be serializable');
    return;
  }
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > MAX_WORKING_MEMORY_DOCUMENT_BYTES) {
    addWorkingMemoryIssue(
      context,
      `Working Memory documents may contain at most ${MAX_WORKING_MEMORY_DOCUMENT_BYTES} bytes`,
    );
  }
}

export const FlexibleWorkingMemorySchema = z.object({
  version: z.literal(1),
  entries: z.record(WorkingMemoryEntryIdSchema, WorkingMemoryEntrySchema),
}).strict().superRefine(validateWorkingMemoryDocumentBounds);
export type FlexibleWorkingMemory = z.infer<typeof FlexibleWorkingMemorySchema>;

export const WorkingMemoryRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export type WorkingMemoryRevision = z.infer<typeof WorkingMemoryRevisionSchema>;

const WorkingMemoryRevisionInputSchema = z.string().trim().min(1).max(128);

export const WorkingMemoryMutationDraftSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('create'),
    basedOnRevision: WorkingMemoryRevisionInputSchema,
    kind: WorkingMemoryKindSchema,
    summary: workingMemorySummary,
    scope: z.enum(['household', 'member']),
    value: WorkingMemoryValueSchema,
  }).strict(),
  z.object({
    operation: z.literal('replace'),
    basedOnRevision: WorkingMemoryRevisionInputSchema,
    entryId: WorkingMemoryEntryIdSchema,
    kind: WorkingMemoryKindSchema,
    summary: workingMemorySummary,
    value: WorkingMemoryValueSchema,
  }).strict(),
  z.object({
    operation: z.literal('delete'),
    basedOnRevision: WorkingMemoryRevisionInputSchema,
    entryId: WorkingMemoryEntryIdSchema,
  }).strict(),
  z.object({
    operation: z.literal('clear'),
    basedOnRevision: WorkingMemoryRevisionInputSchema,
  }).strict(),
]);
export type WorkingMemoryMutationDraft = z.infer<typeof WorkingMemoryMutationDraftSchema>;

const WorkingMemoryCandidateSignalSchema = z.enum([
  'explicit_request',
  'preference_signal',
  'correction_signal',
  'review_finding',
]);

export const WorkingMemoryCandidateInputSchema = z.object({
  kind: WorkingMemoryKindSchema,
  summary: workingMemorySummary,
  value: WorkingMemoryValueSchema,
  signal: WorkingMemoryCandidateSignalSchema,
  subject: z.enum(['self', 'household']),
  correctionTarget: z.object({
    kind: WorkingMemoryKindSchema,
    summary: workingMemorySummary,
  }).strict().optional(),
}).strict();
export type WorkingMemoryCandidateInput = z.infer<typeof WorkingMemoryCandidateInputSchema>;

export const WorkingMemoryCandidateSchema = z.object({
  kind: WorkingMemoryKindSchema,
  summary: workingMemorySummary,
  scope: z.enum(['household', 'member']),
  value: WorkingMemoryValueSchema,
  signal: WorkingMemoryCandidateSignalSchema,
  inspectedRevision: WorkingMemoryRevisionSchema.optional(),
}).strict();
export type WorkingMemoryCandidate = z.infer<typeof WorkingMemoryCandidateSchema>;

export const WorkingMemoryCandidateToolResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('confirmation_required'),
    operation: z.enum(['create', 'replace']),
    code: z.literal('working_memory_candidate_proposed'),
    candidate: WorkingMemoryCandidateSchema,
  }).strict(),
  z.object({
    status: z.literal('rejected'),
    operation: z.enum(['create', 'replace']),
    code: z.string().min(1).max(128),
    category: ErrorCategorySchemaV1,
    retry: RetryDirectiveSchemaV1,
  }).strict(),
]);
export type WorkingMemoryCandidateToolResult = z.infer<typeof WorkingMemoryCandidateToolResultSchema>;

export const WorkingMemoryViewItemSchema = z.object({
  kind: WorkingMemoryKindSchema,
  label: z.string().min(1).max(128),
  scope: z.enum(['household', 'member']),
  summary: workingMemorySummary,
  value: WorkingMemoryValueSchema,
}).strict();
export type WorkingMemoryViewItem = z.infer<typeof WorkingMemoryViewItemSchema>;

export const WorkingMemoryViewResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('succeeded'),
    view: z.enum(['personal', 'household', 'all']),
    entries: z.array(WorkingMemoryViewItemSchema).max(MAX_WORKING_MEMORY_RECORD_ENTRIES),
  }).strict(),
  z.object({
    status: z.literal('failed'),
    code: z.string().min(1).max(128),
    category: ErrorCategorySchemaV1,
    retry: RetryDirectiveSchemaV1,
  }).strict(),
]);
export type WorkingMemoryViewResult = z.infer<typeof WorkingMemoryViewResultSchema>;

export const WorkingMemoryReviewFindingSchema = z.object({
  category: z.enum(['duplicate', 'contradiction', 'stale', 'scope_mismatch']),
  entryIds: z.array(WorkingMemoryEntryIdSchema).min(1).max(10),
  explanation: z.string().trim().min(1).max(1_000),
  proposedOperation: z.enum(['none', 'replace', 'delete']),
  proposedSummary: workingMemorySummary.optional(),
  proposedValue: WorkingMemoryValueSchema.optional(),
  basedOnRevision: WorkingMemoryRevisionSchema,
}).strict();
export type WorkingMemoryReviewFinding = z.infer<typeof WorkingMemoryReviewFindingSchema>;

export const WorkingMemoryReviewReportSchema = z.object({
  status: z.literal('succeeded'),
  revision: WorkingMemoryRevisionSchema,
  reviewedAt: UtcInstantSchema,
  findings: z.array(WorkingMemoryReviewFindingSchema).max(50),
}).strict();
export type WorkingMemoryReviewReport = z.infer<typeof WorkingMemoryReviewReportSchema>;

export const WorkingMemoryReviewToolResultSchema = z.discriminatedUnion('status', [
  WorkingMemoryReviewReportSchema,
  z.object({
    status: z.literal('failed'),
    code: z.string().min(1).max(128),
    category: ErrorCategorySchemaV1,
    retry: RetryDirectiveSchemaV1,
  }).strict(),
]);
export type WorkingMemoryReviewToolResult = z.infer<typeof WorkingMemoryReviewToolResultSchema>;

const resolvedCreateWorkingMemoryMutationSchema = z.object({
  operation: z.literal('create'),
  entryId: WorkingMemoryEntryIdSchema,
  entry: WorkingMemoryEntrySchema,
}).strict();
const resolvedReplaceWorkingMemoryMutationSchema = z.object({
  operation: z.literal('replace'),
  entryId: WorkingMemoryEntryIdSchema,
  entry: WorkingMemoryEntrySchema,
}).strict();
const resolvedDeleteWorkingMemoryMutationSchema = z.object({
  operation: z.literal('delete'),
  entryId: WorkingMemoryEntryIdSchema,
}).strict();
const resolvedClearWorkingMemoryMutationSchema = z.object({
  operation: z.literal('clear'),
}).strict();

export const ResolvedWorkingMemoryMutationSchema = z.discriminatedUnion('operation', [
  resolvedCreateWorkingMemoryMutationSchema,
  resolvedReplaceWorkingMemoryMutationSchema,
  resolvedDeleteWorkingMemoryMutationSchema,
  resolvedClearWorkingMemoryMutationSchema,
]);
export type ResolvedWorkingMemoryMutation = z.infer<typeof ResolvedWorkingMemoryMutationSchema>;

export const PendingWorkingMemoryMutationSchema = z.object({
  proposalId: WorkingMemoryProposalIdSchema,
  householdId: HouseholdIdSchema,
  conversationId: ConversationIdSchema,
  speakerPrincipalRef: z.string().min(1).max(512),
  mutation: ResolvedWorkingMemoryMutationSchema,
  basedOnRevision: WorkingMemoryRevisionSchema,
  createdAt: UtcInstantSchema,
  expiresAt: UtcInstantSchema,
}).strict().superRefine((proposal, context) => {
  const createdAt = Date.parse(proposal.createdAt);
  const expiresAt = Date.parse(proposal.expiresAt);
  const duration = expiresAt - createdAt;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 15 * 60_000) {
    context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Working Memory proposals expire within 15 minutes.' });
  }
});
export type PendingWorkingMemoryMutation = z.infer<typeof PendingWorkingMemoryMutationSchema>;

const inspectedWorkingMemoryEntrySchema = z.object({
  entryId: WorkingMemoryEntryIdSchema,
  kind: WorkingMemoryKindSchema,
  summary: workingMemorySummary,
  scope: z.enum(['household', 'member']),
  value: WorkingMemoryValueSchema,
}).strict();

export const WorkingMemoryInspectionResultSchema = z.object({
  revision: WorkingMemoryRevisionSchema,
  entries: z.array(inspectedWorkingMemoryEntrySchema).max(MAX_WORKING_MEMORY_RECORD_ENTRIES),
}).strict();
export type WorkingMemoryInspectionResult = z.infer<typeof WorkingMemoryInspectionResultSchema>;

export const WorkingMemoryInspectionToolResultSchema = z.discriminatedUnion('status', [
  WorkingMemoryInspectionResultSchema.extend({ status: z.literal('succeeded') }),
  z.object({
    status: z.literal('failed'),
    code: z.string().min(1).max(128),
    category: ErrorCategorySchemaV1,
    retry: RetryDirectiveSchemaV1,
  }).strict(),
]);
export type WorkingMemoryInspectionToolResult = z.infer<typeof WorkingMemoryInspectionToolResultSchema>;

export const WorkingMemoryMutationToolResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('applied'),
    operation: z.enum(['create', 'replace', 'delete', 'clear']),
    code: z.literal('working_memory_mutation_succeeded'),
    reviewDue: z.literal(true).optional(),
  }).strict(),
  z.object({
    status: z.literal('confirmation_required'),
    operation: z.enum(['create', 'replace', 'delete', 'clear']),
    code: z.literal('working_memory_confirmation_required'),
  }).strict(),
  z.object({
    status: z.literal('rejected'),
    operation: z.enum(['create', 'replace', 'delete', 'clear']),
    code: z.string().min(1).max(128),
    category: ErrorCategorySchemaV1,
    retry: RetryDirectiveSchemaV1,
  }).strict(),
]);
export type WorkingMemoryMutationToolResult = z.infer<typeof WorkingMemoryMutationToolResultSchema>;
