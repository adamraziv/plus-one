import { describe, expect, it } from 'vitest';
import {
  HouseholdWorkingMemoryPatchSchema,
  HouseholdWorkingMemorySchema,
  MAX_WORKING_MEMORY_KEY_LENGTH,
  MAX_WORKING_MEMORY_LIST_ITEMS,
  MAX_WORKING_MEMORY_RECORD_ENTRIES,
  MAX_WORKING_MEMORY_TEXT_LENGTH,
} from './working-memory.js';

const representativeMemory = {
  goals: {
    emergencyFund: {
      summary: 'Build a six-month emergency fund.',
      horizon: 'Within two years',
      priority: 'high',
    },
  },
  savingPreferences: {
    style: 'balanced',
    priorities: ['Emergency fund', 'Home repairs'],
    cadence: 'Review savings every payday.',
    constraints: ['Keep three months of expenses liquid.'],
  },
  communication: {
    tone: 'warm and direct',
    detail: 'concise',
    reminders: 'weekly',
  },
  conventions: {
    groceryCategory: 'Use Groceries for ordinary supermarket purchases.',
  },
  members: {
    'telegram:user:1': {
      nickname: 'Alex',
      preferredName: 'Alexandra',
      communication: {
        tone: 'friendly',
        detail: 'brief',
      },
    },
  },
} as const;

describe('HouseholdWorkingMemorySchema', () => {
  it('accepts an empty document and representative structured memory', () => {
    expect(HouseholdWorkingMemorySchema.parse({})).toEqual({});
    expect(HouseholdWorkingMemorySchema.parse(representativeMemory)).toEqual(representativeMemory);
  });

  it('accepts channel principal references and rejects unsafe member keys', () => {
    expect(HouseholdWorkingMemorySchema.parse({
      members: { 'telegram:user:1': { nickname: 'Alex' } },
    }).members?.['telegram:user:1']?.nickname).toBe('Alex');

    expect(() => HouseholdWorkingMemorySchema.parse({
      members: { 'telegram user 1': { nickname: 'Alex' } },
    })).toThrow();
    expect(() => HouseholdWorkingMemorySchema.parse({
      members: { '   ': { nickname: 'Alex' } },
    })).toThrow();
  });

  it('enforces text, key, list, and record bounds', () => {
    expect(() => HouseholdWorkingMemorySchema.parse({
      conventions: { key: 'x'.repeat(MAX_WORKING_MEMORY_TEXT_LENGTH + 1) },
    })).toThrow();
    expect(() => HouseholdWorkingMemorySchema.parse({
      members: { ['x'.repeat(MAX_WORKING_MEMORY_KEY_LENGTH + 1)]: { nickname: 'Alex' } },
    })).toThrow();
    expect(() => HouseholdWorkingMemorySchema.parse({
      savingPreferences: { priorities: Array.from({ length: MAX_WORKING_MEMORY_LIST_ITEMS + 1 }, () => 'priority') },
    })).toThrow();
    expect(() => HouseholdWorkingMemorySchema.parse({
      conventions: Object.fromEntries(
        Array.from({ length: MAX_WORKING_MEMORY_RECORD_ENTRIES + 1 }, (_, index) => [`key-${index}`, 'value']),
      ),
    })).toThrow();
  });

  it('rejects unknown fields at every structured level', () => {
    expect(() => HouseholdWorkingMemorySchema.parse({ unexpected: 'value' })).toThrow();
    expect(() => HouseholdWorkingMemorySchema.parse({
      savingPreferences: { unexpected: 'value' },
    })).toThrow();
    expect(() => HouseholdWorkingMemorySchema.parse({
      members: { 'telegram:user:1': { unexpected: 'value' } },
    })).toThrow();
  });
});

describe('HouseholdWorkingMemoryPatchSchema', () => {
  it('accepts null deletion patches without accepting arbitrary JSON', () => {
    const patch = HouseholdWorkingMemoryPatchSchema.parse({
      goals: null,
      savingPreferences: { priorities: null },
      communication: { tone: null },
      conventions: { groceryCategory: null },
      members: { 'telegram:user:1': { nickname: null } },
    });

    expect(patch).toEqual({
      goals: null,
      savingPreferences: { priorities: null },
      communication: { tone: null },
      conventions: { groceryCategory: null },
      members: { 'telegram:user:1': { nickname: null } },
    });
    expect(() => HouseholdWorkingMemoryPatchSchema.parse({ arbitrary: { nested: true } })).toThrow();
  });
});
