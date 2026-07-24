import { z } from 'zod';

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

export const HouseholdWorkingMemorySchema = z.object({
  goals: boundedRecord(goal).optional(),
  savingPreferences: savingPreferences.optional(),
  communication: communication.optional(),
  conventions: boundedRecord(workingMemoryText).optional(),
  members: boundedRecord(member).optional(),
}).strict();
export type HouseholdWorkingMemory = z.infer<typeof HouseholdWorkingMemorySchema>;

const nullableText = workingMemoryText.nullable();
const nullableList = workingMemoryList.nullable();
const nullablePriority = priority.nullable();
const nullableSavingStyle = savingStyle.nullable();

const memberCommunicationPatch = z.object({
  tone: nullableText.optional(),
  detail: nullableText.optional(),
}).strict();

const memberPatch = z.object({
  nickname: nullableText.optional(),
  preferredName: nullableText.optional(),
  communication: memberCommunicationPatch.nullable().optional(),
}).strict();

const goalPatch = z.object({
  summary: nullableText.optional(),
  horizon: nullableText.optional(),
  priority: nullablePriority.optional(),
}).strict();

const savingPreferencesPatch = z.object({
  style: nullableSavingStyle.optional(),
  priorities: nullableList.optional(),
  cadence: nullableText.optional(),
  constraints: nullableList.optional(),
}).strict();

const communicationPatch = z.object({
  tone: nullableText.optional(),
  detail: nullableText.optional(),
  reminders: nullableText.optional(),
}).strict();

export const HouseholdWorkingMemoryPatchSchema = z.object({
  goals: boundedRecord(goalPatch.nullable()).nullable().optional(),
  savingPreferences: savingPreferencesPatch.nullable().optional(),
  communication: communicationPatch.nullable().optional(),
  conventions: boundedRecord(nullableText).nullable().optional(),
  members: boundedRecord(memberPatch.nullable()).nullable().optional(),
}).strict();
export type HouseholdWorkingMemoryPatch = z.infer<typeof HouseholdWorkingMemoryPatchSchema>;
