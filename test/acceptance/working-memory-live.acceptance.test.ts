import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  InboundChannelMessageSchemaV1,
  type HouseholdWorkingMemory,
  type HouseholdWorkingMemoryPatch,
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
  it('shares durable goals across conversations within one resource', async () => {
    const target = ids();
    const first = await sendUntilMemory(
      target,
      'Call the native updateWorkingMemory tool now with memory={"goals":{"emergencyFund":{"summary":"Build a six-month emergency fund by December 2027"}}}. Save this long-term household goal in Working Memory now.',
      (stored) => /emergency|six[- ]month|2027/i.test(JSON.stringify(stored)),
    );
    expectSuccessful(first);

    const second = await sendMessage({
      householdId: target.householdId,
      conversationId: ids().conversationId,
      body: 'What do you remember about our long-term goals? Summarize the saved household context.',
    });
    expectSuccessful(second);
    expect(second.body).toMatch(/emergency|six[- ]month|2027/i);

    const stored = await readMemory(target, second.json.conversationId as string | undefined);
    expect(JSON.stringify(stored)).toMatch(/emergency|six[- ]month|2027/i);
  }, 300_000);

  it('keeps another household resource isolated from the remembered goal', async () => {
    const target = ids();
    const response = await sendMessage({
      ...target,
      body: 'What do you remember about our long-term goals? If nothing is saved for this household, say so.',
    });
    expectSuccessful(response);

    const stored = await readMemory(target);
    expect(stored).toEqual({});
    expect(response.body).not.toMatch(/six[- ]month emergency fund|December 2027/i);
  }, 300_000);

  it('persists structured saving preferences through the native update tool', async () => {
    const target = ids();
    const response = await sendUntilMemory(
      target,
      'Remember these exact saving preferences for this household. Call the native updateWorkingMemory tool now with memory={"savingPreferences":{"style":"balanced","priorities":["emergency fund","retirement"],"cadence":"monthly","constraints":["keep at least 2,000 dollars liquid"]}}. Store every value in the structured Working Memory fields.',
      (stored) => stored.savingPreferences?.style === 'balanced'
        && stored.savingPreferences?.priorities?.includes('emergency fund') === true
        && stored.savingPreferences?.priorities?.includes('retirement') === true
        && stored.savingPreferences?.cadence === 'monthly',
    );
    expectSuccessful(response);

    const stored = await readMemory(target);
    expect(stored.savingPreferences?.style).toBe('balanced');
    expect(JSON.stringify(stored.savingPreferences)).toMatch(/emergency fund|retirement|monthly|liquid/i);
  }, 300_000);

  it('stores a nickname under the authenticated member principal and recalls it from another thread', async () => {
    const target = ids();
    const response = await sendUntilMemory(
      target,
      `Call the native updateWorkingMemory tool now with memory={"members":{"${principalRef}":{"nickname":"Sunny"}}}. Remember that my nickname is Sunny and save it under my authenticated member record.`,
      (stored) => stored.members?.[principalRef]?.nickname === 'Sunny',
    );
    expectSuccessful(response);

    const stored = await readMemory(target);
    const member = stored.members?.[principalRef];
    expect(member).toBeDefined();
    expect(member?.nickname ?? member?.preferredName).toMatch(/Sunny/i);

    const second = await sendMessage({
      householdId: target.householdId,
      conversationId: ids().conversationId,
      body: 'What nickname do you have saved for me?',
    });
    expectSuccessful(second);
    expect(second.body).toMatch(/Sunny/i);
    expect(second.body).not.toContain(principalRef);
  }, 300_000);

  it('answers identity from authenticated context and not from another member record', async () => {
    const target = ids();
    await writeMemory(target, {
      members: {
        [principalRef]: { nickname: 'Sky' },
        [otherPrincipalRef]: { nickname: 'Other Person' },
      },
    });

    const response = await sendMessage({
      ...target,
      displayName: 'Jordan',
      body: 'Who am I? Answer using my authenticated identity, not another member.',
    });
    expectSuccessful(response);
    expect(response.body).toMatch(/Jordan|Sky/i);
    expect(response.body).not.toMatch(/Other Person/i);
    expect(response.body).not.toContain(principalRef);
  }, 300_000);

  it('summarizes saved Working Memory without changing the stored resource', async () => {
    const target = ids();
    await writeMemory(target, {
      goals: { emergencyFund: { summary: 'Build a six-month emergency fund' } },
      savingPreferences: { style: 'balanced' },
    });
    const before = await readMemory(target);

    const response = await sendMessage({
      householdId: target.householdId,
      conversationId: ids().conversationId,
      body: 'What do you remember about our goals and saving preferences?',
    });
    expectSuccessful(response);
    expect(response.body).toMatch(/emergency|balanced/i);

    const after = await readMemory(target);
    expect(after).toEqual(before);
  }, 300_000);

  it('forgets one saved field while preserving unrelated Working Memory', async () => {
    const target = ids();
    await writeMemory(target, {
      savingPreferences: { style: 'balanced', cadence: 'monthly' },
    });
    const before = await readMemory(target);
    expect(before.savingPreferences?.style).toBe('balanced');

    const response = await sendMessage({
      ...target,
      body: 'Call the native updateWorkingMemory tool now with {"savingPreferences":{"cadence":null}}. Forget only my saving review cadence and keep my balanced saving style.',
    });
    expectSuccessful(response);

    const after = await readMemory(target);
    expect(after.savingPreferences?.style).toBe('balanced');
    expect(after.savingPreferences?.cadence).toBeUndefined();
  }, 300_000);

  it('forgets all Working Memory without touching workflow storage', async () => {
    const target = ids();
    await writeMemory(target, {
      goals: { emergencyFund: { summary: 'Build an emergency fund' } },
      members: { [principalRef]: { nickname: 'Sunny' } },
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
      const beforeWorkflow = await workflow.query(
        `SELECT snapshot
           FROM mastra_memory.mastra_workflow_snapshot
          WHERE workflow_name = $1 AND run_id = $2`,
        [workflowName, runId],
      );

      const response = await sendMessage({
        ...target,
        body: 'Forget everything you remember about this household in Working Memory. Do not delete accounting or workflow data.',
      });
      expectSuccessful(response);
      expect(response.body).toMatch(/forget|clear|nothing|remember/i);

      await expect(readMemory(target)).resolves.toEqual({});
      const afterWorkflow = await workflow.query(
        `SELECT snapshot
           FROM mastra_memory.mastra_workflow_snapshot
          WHERE workflow_name = $1 AND run_id = $2`,
        [workflowName, runId],
      );
      expect(afterWorkflow.rows).toEqual(beforeWorkflow.rows);
    } finally {
      await workflow.end();
    }
  }, 300_000);

  it('uses object merge, array replacement, and null deletion semantics through gateway updates', async () => {
    const target = ids();
    await writeMemory(target, {
      savingPreferences: {
        style: 'balanced',
        priorities: ['Emergency fund', 'Retirement'],
        cadence: 'monthly',
        constraints: ['Keep cash liquid'],
      },
    });
    await sendUntilMemory(
      target,
      'Call the native updateWorkingMemory tool now. Merge communication.tone="concise" into the existing Working Memory and preserve every existing savingPreferences field unchanged.',
      (stored) => stored.communication?.tone === 'concise',
    );
    await sendUntilMemory(
      target,
      'Call the native updateWorkingMemory tool now. Replace the entire savingPreferences.priorities array with exactly ["Travel","Education"]. Keep savingPreferences.style="balanced", savingPreferences.cadence="monthly", and savingPreferences.constraints=["Keep cash liquid"].',
      (stored) => stored.savingPreferences?.priorities?.length === 2
        && stored.savingPreferences.priorities.includes('Travel')
        && stored.savingPreferences.priorities.includes('Education'),
    );

    const stored = await readMemory(target);
    expect(stored.savingPreferences?.style).toBe('balanced');
    expect(stored.savingPreferences?.priorities).toEqual(expect.arrayContaining(['Travel', 'Education']));
    expect(stored.savingPreferences?.priorities).not.toEqual(expect.arrayContaining(['Emergency fund', 'Retirement']));
    expect(stored.savingPreferences?.cadence).toBe('monthly');
    expect(stored.communication?.tone).toBe('concise');
  }, 300_000);

  it('does not change valid memory when a bounded update exceeds the schema limit', async () => {
    const target = ids();
    await writeMemory(target, { communication: { detail: 'concise' } });
    const before = await readMemory(target);
    const priorities = JSON.stringify(Array.from({ length: 21 }, (_, index) => `priority ${index + 1}`));

    const response = await sendMessage({
      ...target,
      body: `Call the native updateWorkingMemory tool exactly once with savingPreferences.priorities=${priorities}. This exact update must be rejected because the bounded list limit is 20; do not summarize, drop, or replace any other saved field.`,
    });
    expectSuccessful(response);
    expect(response.body).toMatch(/could not|couldn['’]t|unable|wasn['’]t able|not save|limit|too many|failed|cannot/i);
    await expect(readMemory(target)).resolves.toEqual(before);
  }, 300_000);

  it('reports a real Working Memory read failure through the same orchestrator response', async () => {
    const target = ids();
    await writeMemory(target, { goals: { emergencyFund: { summary: 'Build a reserve' } } });

    const response = await withRevokedMemoryPrivileges(
      live().context,
      ['SELECT'],
      () => sendMessage({
        ...target,
        body: 'What do you remember about my saved goal?',
      }),
    );
    expectMemoryFailure(response);
    expect(response.body).not.toMatch(/emergency fund|build a reserve/i);
    expect(response.body).not.toContain('working_memory_read_failed');
    expect(response.body).not.toContain(principalRef);
    await expect(readMemory(target)).resolves.toMatchObject({
      goals: { emergencyFund: { summary: 'Build a reserve' } },
    });
  }, 300_000);

  it('reports a real Working Memory update failure without claiming the write succeeded', async () => {
    const target = ids();
    await writeMemory(target, { communication: { tone: 'warm' } });

    const response = await withRevokedMemoryPrivileges(
      live().context,
      ['UPDATE'],
      () => sendMessage({
        ...target,
        body: 'Remember that my communication tone should be concise.',
      }),
    );
    expectMemoryFailure(response);
    expect(response.body).not.toMatch(/saved|stored|updated successfully/i);
    expect(response.body).not.toContain('working_memory_write_failed');
    await expect(readMemory(target)).resolves.toMatchObject({
      communication: { tone: 'warm' },
    });
  }, 300_000);

  it('reports a real clear failure without claiming everything was forgotten', async () => {
    const target = ids();
    await writeMemory(target, {
      goals: { emergencyFund: { summary: 'Build a reserve' } },
      communication: { tone: 'warm' },
    });

    const response = await withRevokedMemoryPrivileges(
      live().context,
      ['UPDATE'],
      () => sendMessage({
        ...target,
        body: 'Forget everything you remember about this household.',
      }),
    );
    expectMemoryFailure(response);
    expect(response.body).not.toMatch(/forgotten successfully|everything (?:is|was) cleared|cleared successfully/i);
    await expect(readMemory(target)).resolves.toMatchObject({
      goals: { emergencyFund: { summary: 'Build a reserve' } },
      communication: { tone: 'warm' },
    });
  }, 300_000);

  it('does not present Working Memory as authoritative accounting evidence', async () => {
    const target = ids();
    await writeMemory(target, {
      goals: { emergencyFund: { summary: 'Build an emergency fund' } },
    });
    const response = await sendMessage({
      ...target,
      body: 'Does that saved goal prove that we currently have money in an account or establish our current balance?',
    });
    expectSuccessful(response);
    expect(response.body).toMatch(/not|does not|cannot|can.t|no current balance|not evidence/i);
    expect(response.body).not.toContain(principalRef);
  }, 300_000);
});

function live(): WorkingMemoryLiveHarness {
  if (harness === undefined) throw new Error('Working Memory live harness is not initialized.');
  return harness;
}

async function sendMessage(input: {
  householdId: string;
  conversationId: string;
  body: string;
  displayName?: string;
  speaker?: string;
}): Promise<LiveResponse> {
  const speaker = input.speaker ?? principalRef;
  const message = InboundChannelMessageSchemaV1.parse({
    schemaName: 'inbound-channel-message',
    schemaVersion: 1,
    conversationId: input.conversationId,
    householdId: input.householdId,
    channel: 'telegram',
    externalMessageId: `telegram:working-memory-live:${randomSuffix()}`,
    receivedAt: new Date().toISOString(),
    speaker: {
      principalRef: speaker,
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
  return {
    status: response.status,
    body: typeof json.body === 'string' ? json.body : '',
    json,
  };
}

async function sendUntilMemory(
  target: LiveIds,
  body: string,
  matches: (stored: HouseholdWorkingMemory) => boolean,
  maxAttempts = 3,
): Promise<LiveResponse> {
  let lastResponse: LiveResponse | undefined;
  let lastStored: HouseholdWorkingMemory | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    lastResponse = await sendMessage({ ...target, body });
    if (lastResponse.status === 200) {
      lastStored = await readMemory(target);
      if (matches(lastStored)) return lastResponse;
    }
  }
  throw new Error(`Live Working Memory update did not converge: ${JSON.stringify({ lastResponse, lastStored })}`);
}

async function readMemory(target: LiveIds, conversationId = target.conversationId): Promise<HouseholdWorkingMemory> {
  return readLiveWorkingMemory({
    connectionString: live().context.roleUrls.memory,
    model: live().model,
    threadId: conversationId,
    resourceId: target.householdId,
  });
}

async function writeMemory(target: LiveIds, patch: HouseholdWorkingMemoryPatch): Promise<void> {
  await writeLiveWorkingMemory({
    connectionString: live().context.roleUrls.memory,
    model: live().model,
    threadId: target.conversationId,
    resourceId: target.householdId,
    patch,
  });
}

function ids(): LiveIds {
  const suffix = randomSuffix();
  return {
    householdId: `hh_${suffix}`,
    conversationId: `conversation_${suffix}`,
  };
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
  expect(response.body).toMatch(/could not|couldn['’]t|unable|wasn['’]t able|didn['’]t succeed|did not succeed|failed|failure|unavailable|not saved|not cleared|cannot|can['’]t/i);
  expect(response.body).not.toMatch(/(?:saved|stored|updated|cleared|forgotten) successfully/i);
}
