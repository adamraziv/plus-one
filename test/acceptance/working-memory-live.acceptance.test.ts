import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  InboundChannelMessageSchemaV1,
  WorkingMemoryEntryIdSchema,
  type FlexibleWorkingMemory,
  type WorkingMemoryEntry,
} from '@plus-one/contracts';
import {
  readLiveWorkingMemory,
  startWorkingMemoryLiveHarness,
  type WorkingMemoryLiveHarness,
  withRevokedMemoryPrivileges,
  writeLiveWorkingMemory,
} from '../helpers/working-memory-live.js';

type LiveIds = {
  householdId: string;
  conversationId: string;
};

type LiveResponse = {
  status: number;
  body: string;
  json: Record<string, unknown>;
};

const principalRef = 'telegram:user:working-memory-live';
const otherPrincipalRef = 'telegram:user:other-member';
let harness: WorkingMemoryLiveHarness | undefined;

beforeAll(async () => {
  harness = await startWorkingMemoryLiveHarness();
}, 120_000);

afterAll(async () => {
  await harness?.stop();
  harness = undefined;
}, 120_000);

describe('Working Memory through the real gateway and configured provider', () => {
  it('creates a natural-language goal after inspection and recalls it in a new thread', async () => {
    const target = ids();
    const created = await sendMessage({
      ...target,
      body: 'My goal is to buy a BMW X5 in the next year. Please remember that.',
    });
    expectSuccessful(created);

    const stored = await readMemory(target);
    expect(findEntry(stored, 'goal')).toMatchObject({
      value: expect.objectContaining({ goal: expect.stringMatching(/BMW X5/i) }),
    });

    const recalled = await sendMessage({
      householdId: target.householdId,
      conversationId: ids().conversationId,
      body: 'What durable goal do you remember for me?',
    });
    expectSuccessful(recalled);
    expect(recalled.body).toMatch(/BMW X5|buy.*car|goal/i);
  }, 300_000);

  it('suspends a replacement, applies the same entry after approval, and removes the old value', async () => {
    const target = ids();
    await writeMemory(target, {
      kind: 'goal',
      summary: 'Buy a BMW X5 within one year.',
      scope: 'household',
      value: { goal: 'BMW X5', timeframe: 'one year' },
    });

    const proposal = await sendMessage({
      ...target,
      body: 'Change my car goal to a BMW X7 in two years.',
    });
    expectSuccessful(proposal);
    expect(proposal.body).toMatch(/BMW X7|confirm|approve|would you like/i);

    const approved = await sendMessage({ ...target, body: 'Yes' });
    expectSuccessful(approved);
    const stored = await readMemory(target);
    const goal = findEntry(stored, 'goal');
    expect(goal?.summary).toMatch(/BMW X7/i);
    expect(JSON.stringify(goal?.value)).not.toMatch(/BMW X5/i);
  }, 300_000);

  it('preserves the original entry when a replacement is rejected', async () => {
    const target = ids();
    await writeMemory(target, {
      kind: 'goal',
      summary: 'Buy a BMW X5 within one year.',
      scope: 'household',
      value: { goal: 'BMW X5', timeframe: 'one year' },
    });
    await sendMessage({ ...target, body: 'Change my car goal to a BMW X7 in two years.' });
    const rejected = await sendMessage({ ...target, body: 'No' });
    expectSuccessful(rejected);

    const stored = await readMemory(target);
    const goal = findEntry(stored, 'goal');
    expect(goal?.summary).toMatch(/BMW X5/i);
    expect(JSON.stringify(goal?.value)).not.toMatch(/BMW X7/i);
  }, 300_000);

  it('asks before appending a second entry of the same kind', async () => {
    const target = ids();
    await writeMemory(target, {
      kind: 'goal',
      summary: 'Build an emergency fund.',
      scope: 'household',
      value: { goal: 'Emergency fund' },
    });
    const response = await sendMessage({
      ...target,
      body: 'Remember another goal: save for a home renovation.',
    });
    expectSuccessful(response);
    expect(response.body).toMatch(/confirm|approve|would you like|another goal/i);
    expect(Object.values((await readMemory(target)).entries)).toHaveLength(1);
  }, 300_000);

  it('replaces flexible goal values without retaining the old singular or plural shape', async () => {
    const target = ids();
    await writeMemory(target, {
      kind: 'goal',
      summary: 'Buy a BMW X5 within one year.',
      scope: 'household',
      value: { goal: 'BMW X5', timeline: 'one year' },
    });
    await sendMessage({ ...target, body: 'Change my car goal to a BMW X7 in two years.' });
    await sendMessage({ ...target, body: 'yes' });

    const goal = findEntry(await readMemory(target), 'goal');
    expect(goal?.value).toEqual(expect.objectContaining({ goals: expect.anything() }));
    expect(goal?.value).not.toHaveProperty('goal');
    expect(goal?.value).not.toHaveProperty('timeline');
  }, 300_000);

  it('requires approval before clearing Working Memory and leaves workflow rows untouched', async () => {
    const target = ids();
    await writeMemory(target, {
      kind: 'goal',
      summary: 'Build an emergency fund.',
      scope: 'household',
      value: { goal: 'Emergency fund' },
    });
    const workflow = new Pool({ connectionString: live().context.migratorUrl, max: 1 });
    const workflowName = `working-memory-live-${randomSuffix()}`;
    const runId = `run-${randomSuffix()}`;
    try {
      await workflow.query(
        `INSERT INTO mastra_memory.mastra_workflow_snapshot
           (workflow_name, run_id, "resourceId", snapshot)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [workflowName, runId, target.householdId, JSON.stringify({ untouched: true })],
      );
      const before = await workflow.query(
        `SELECT snapshot FROM mastra_memory.mastra_workflow_snapshot WHERE workflow_name = $1 AND run_id = $2`,
        [workflowName, runId],
      );

      const proposal = await sendMessage({ ...target, body: 'Forget everything you remember about this household.' });
      expectSuccessful(proposal);
      expect(proposal.body).toMatch(/confirm|approve|clear|forget/i);
      const approved = await sendMessage({ ...target, body: 'yes' });
      expectSuccessful(approved);
      await expect(readMemory(target)).resolves.toMatchObject({ version: 1, entries: {} });

      const after = await workflow.query(
        `SELECT snapshot FROM mastra_memory.mastra_workflow_snapshot WHERE workflow_name = $1 AND run_id = $2`,
        [workflowName, runId],
      );
      expect(after.rows).toEqual(before.rows);
    } finally {
      await workflow.end();
    }
  }, 300_000);

  it('does not expose another principal’s member entry', async () => {
    const target = ids();
    await writeMemory(target, {
      kind: 'member_context',
      summary: 'Other member nickname.',
      scope: 'member',
      ownerPrincipalRef: otherPrincipalRef,
      value: { nickname: 'Other Person' },
    }, otherPrincipalRef);
    const response = await sendMessage({ ...target, body: 'What nickname do you remember for me?' });
    expectSuccessful(response);
    expect(response.body).not.toMatch(/Other Person/i);
    expect((await readMemory(target)).entries).toEqual([]);
  }, 300_000);

  it('reports revoked inspection privileges without claiming saved context was read', async () => {
    const target = ids();
    await writeMemory(target, {
      kind: 'goal',
      summary: 'Build a reserve.',
      scope: 'household',
      value: { goal: 'Emergency fund' },
    });
    const response = await withRevokedMemoryPrivileges(live().context, ['SELECT'], () => sendMessage({
      ...target,
      body: 'What do you remember about my saved goal?',
    }));
    expectMemoryFailure(response);
    expect(response.body).not.toMatch(/emergency fund|build a reserve/i);
    expect(response.body).not.toContain('working_memory_');
  }, 300_000);

  it('recalls seeded context without registering a native updateWorkingMemory tool', async () => {
    const target = ids();
    await writeMemory(target, {
      kind: 'communication_preference',
      summary: 'Concise replies.',
      scope: 'household',
      value: { detail: 'concise' },
    });
    const response = await sendMessage({ ...target, body: 'What communication preference do you remember?' });
    expectSuccessful(response);
    expect(response.body).toMatch(/concise/i);
    expect(response.body).not.toContain('updateWorkingMemory');
  }, 300_000);
});

function live(): WorkingMemoryLiveHarness {
  if (harness === undefined) throw new Error('Working Memory live harness is not initialized.');
  return harness;
}

async function writeMemory(target: LiveIds, entry: WorkingMemoryEntry, principal = principalRef): Promise<void> {
  await seedHousehold(target.householdId);
  await writeLiveWorkingMemory({
    connectionString: live().context.roleUrls.memory,
    model: live().model,
    threadId: target.conversationId,
    resourceId: target.householdId,
    principalRef: principal,
    mutation: {
      operation: 'create',
      entryId: WorkingMemoryEntryIdSchema.parse(`wme_${randomSuffix()}`),
      entry,
    },
  });
}

async function readMemory(target: LiveIds, conversationId = target.conversationId, principal = principalRef): Promise<FlexibleWorkingMemory> {
  return readLiveWorkingMemory({
    connectionString: live().context.roleUrls.memory,
    model: live().model,
    threadId: conversationId,
    resourceId: target.householdId,
    principalRef: principal,
  });
}

function findEntry(document: FlexibleWorkingMemory, kind: WorkingMemoryEntry['kind']): WorkingMemoryEntry | undefined {
  return Object.values(document.entries).find((entry) => entry.kind === kind);
}

async function sendMessage(input: {
  householdId: string;
  conversationId: string;
  body: string;
  displayName?: string;
  speaker?: string;
}): Promise<LiveResponse> {
  await seedHousehold(input.householdId);
  const message = InboundChannelMessageSchemaV1.parse({
    schemaName: 'inbound-channel-message',
    schemaVersion: 1,
    conversationId: input.conversationId,
    householdId: input.householdId,
    channel: 'telegram',
    externalMessageId: `telegram:working-memory-live:${randomSuffix()}`,
    receivedAt: new Date().toISOString(),
    speaker: {
      principalRef: input.speaker ?? principalRef,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    },
    body: input.body,
    attachments: [],
    metadata: { destination: { chatId: 'working-memory-live' } },
  });
  const response = await fetch(`${live().gateway.baseUrl}/plus-one/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  });
  const json = await response.json() as Record<string, unknown>;
  return { status: response.status, body: typeof json.body === 'string' ? json.body : '', json };
}

async function seedHousehold(householdId: string): Promise<void> {
  const operations = new Pool({ connectionString: live().context.roleUrls.operations, max: 1 });
  try {
    await operations.query(
      `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
       VALUES ($1, 'USD', 'UTC')
       ON CONFLICT DO NOTHING`,
      [householdId],
    );
  } finally {
    await operations.end();
  }
}

function ids(): LiveIds {
  const suffix = randomSuffix();
  return { householdId: `hh_${suffix}`, conversationId: `conversation_${suffix}` };
}

function randomSuffix(): string {
  return randomBytes(13).toString('hex').toUpperCase();
}

function expectSuccessful(response: LiveResponse): void {
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  expect(response.body.length).toBeGreaterThan(0);
}

function expectMemoryFailure(response: LiveResponse): void {
  expectSuccessful(response);
  expect(response.body).toMatch(/could not|couldn['’]t|unable|wasn['’]t able|failed|failure|unavailable|not saved|not read|cannot|can['’]t/i);
  expect(response.body).not.toMatch(/(?:saved|stored|updated|cleared|forgotten) successfully/i);
}
