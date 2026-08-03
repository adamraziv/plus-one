import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  InboundChannelMessageSchemaV1,
  PendingWorkingMemoryMutationSchema,
  WorkingMemoryEntryIdSchema,
  type FlexibleWorkingMemory,
  type WorkingMemoryEntry,
} from '@plus-one/contracts';
import { OrchestratorAgent } from '../../apps/engine/src/agents/orchestrator.js';
import { createOrchestratorSessionMemory } from '../../apps/engine/src/memory/orchestrator-session-memory.js';
import type { OrchestratorTeamRuntime } from '../../apps/engine/src/tools/delegate-team.js';
import {
  readLiveWorkingMemory,
  reviewLiveWorkingMemory,
  startWorkingMemoryLiveHarness,
  type WorkingMemoryLiveHarness,
  viewLiveWorkingMemory,
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
  it('working-memory-model-compatibility: issue #33 classifier reaches the configured provider with thread-scoped memory identity', async () => {
    const liveHarness = live();
    const target = ids();
    const createdAt = new Date().toISOString();
    const message = InboundChannelMessageSchemaV1.parse({
      schemaName: 'inbound-channel-message',
      schemaVersion: 1,
      conversationId: target.conversationId,
      householdId: target.householdId,
      channel: 'telegram',
      externalMessageId: 'telegram:live-pending-classifier:1',
      receivedAt: createdAt,
      speaker: { principalRef },
      body: 'Buat budget bulanan: total 10 juta IDR, prioritaskan makanan 2 juta IDR dan transportasi 1 juta IDR.',
      attachments: [],
      metadata: { destination: { chatId: 'live-chat' } },
    });
    const pending = PendingWorkingMemoryMutationSchema.parse({
      proposalId: 'wmproposal_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      householdId: target.householdId,
      conversationId: target.conversationId,
      speakerPrincipalRef: principalRef,
      mutation: {
        operation: 'create',
        entryId: WorkingMemoryEntryIdSchema.parse('wme_01JNZQ4A9B8C7D6E5F4G3H2J1K'),
        entry: {
          kind: 'communication_preference',
          summary: 'Use concise household summaries.',
          scope: 'household',
          value: { detail: 'concise' },
        },
      },
      basedOnRevision: 'a'.repeat(64),
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + 15 * 60_000).toISOString(),
    });
    const memory = createOrchestratorSessionMemory({
      connectionString: liveHarness.context.roleUrls.memory,
      model: liveHarness.model,
    });
    const unexpectedTeamCall = async () => {
      throw new Error('The pending classifier must not invoke a specialist team.');
    };
    const teamRuntime: OrchestratorTeamRuntime = {
      runTeamLead: unexpectedTeamCall,
      resumePendingMutation: unexpectedTeamCall,
      cancelPendingMutation: unexpectedTeamCall,
    };
    const orchestrator = new OrchestratorAgent({
      model: liveHarness.model,
      teams: [],
      teamRuntime,
      sessionMemory: memory,
    });

    try {
      await expect(orchestrator.classifyPendingWorkingMemoryInput({ message, pending }))
        .resolves.toBe('new_intent');
    } finally {
      await memory.close();
    }
  }, 120_000);

  it('working-memory-model-compatibility: issue #33 keeps the exact confirmation pending across an Indonesian budget request', async () => {
    const target = ids();
    const proposal = await sendMessage({
      ...target,
      body: 'Please remember that I prefer concise household summaries, but ask me for confirmation before saving it.',
    });
    expectSuccessful(proposal);
    expect(proposal.body).toMatch(/confirm|approve|would you like|remember|save/i);

    const before = await pendingInteraction(target);
    expect(before.status).toBe('pending');

    const unrelated = await sendMessage({
      ...target,
      body: 'Buat budget bulanan: total 10 juta IDR, prioritaskan makanan 2 juta IDR dan transportasi 1 juta IDR.',
    });
    expectSuccessful(unrelated);
    expect(unrelated.body).not.toMatch(/concise.*(?:saved|stored)|(?:saved|stored).*concise/i);

    const afterUnrelated = await pendingInteraction(target);
    expect(afterUnrelated).toEqual(before);
    await expect(readMemory(target)).resolves.toMatchObject({ version: 1, entries: {} });

    const approved = await sendMessage({ ...target, body: 'yes' });
    expectSuccessful(approved);
    expect(approved.body.length).toBeGreaterThan(0);
    const stored = await readMemory(target);
    expect(findEntry(stored, 'communication_preference'), JSON.stringify(stored)).toBeDefined();

    const terminal = await pendingInteraction(target);
    expect(terminal.status).toBe('applied');
    expect(terminal.resolutionExternalMessageId).toBeTruthy();
  }, 300_000);

  it('working-memory-model-compatibility: issue #33 survives five fresh detailed Indonesian budget flows', async () => {
    await runFreshIssue33Flows('Buat budget bulanan: total 10 juta IDR, prioritaskan makanan 2 juta IDR dan transportasi 1 juta IDR.');
  }, 900_000);

  it('working-memory-model-compatibility: issue #33 survives five fresh short Indonesian budget flows', async () => {
    await runFreshIssue33Flows('Tolong buatkan budget bulanan untuk rumah tangga kita.');
  }, 900_000);

  it('working-memory-model-compatibility: issue #33 classifies multilingual, natural, and mixed confirmations live', async () => {
    for (const approvalBody of ['yes', 'Yes, go ahead and save it.', 'Ya, silakan simpan.']) {
      const target = ids();
      const proposal = await sendMessage({
        ...target,
        body: 'Please remember that I prefer concise household summaries, but ask me for confirmation before saving it.',
      });
      expectSuccessful(proposal);
      expect((await pendingInteraction(target)).status).toBe('pending');

      const approved = await sendMessage({ ...target, body: approvalBody });
      expectSuccessful(approved);
      expect(findEntry(await readMemory(target), 'communication_preference')).toBeDefined();
      expect((await pendingInteraction(target)).status).toBe('applied');
    }

    const rejectedTarget = ids();
    await expect(sendMessage({
      ...rejectedTarget,
      body: 'Please remember that I prefer concise household summaries, but ask me for confirmation before saving it.',
    })).resolves.toMatchObject({ status: 200 });
    const rejected = await sendMessage({ ...rejectedTarget, body: 'Tidak, jangan simpan.' });
    expectSuccessful(rejected);
    expect(await readMemory(rejectedTarget)).toMatchObject({ version: 1, entries: {} });
    expect((await pendingInteraction(rejectedTarget)).status).toBe('rejected');

    const mixedTarget = ids();
    await expect(sendMessage({
      ...mixedTarget,
      body: 'Please remember that I prefer concise household summaries, but ask me for confirmation before saving it.',
    })).resolves.toMatchObject({ status: 200 });
    const mixed = await sendMessage({ ...mixedTarget, body: 'Yes, but make the preference detailed instead.' });
    expectSuccessful(mixed);
    expect(mixed.body).not.toMatch(/saved|stored|updated successfully/i);
    expect(await readMemory(mixedTarget)).toMatchObject({ version: 1, entries: {} });
    expect((await pendingInteraction(mixedTarget)).status).toBe('pending');

    const approvedAfterMixed = await sendMessage({ ...mixedTarget, body: 'yes' });
    expectSuccessful(approvedAfterMixed);
    expect(findEntry(await readMemory(mixedTarget), 'communication_preference')).toBeDefined();
    expect((await pendingInteraction(mixedTarget)).status).toBe('applied');
  }, 1_200_000);

  it('working-memory-model-compatibility: creates a natural-language goal after inspection and recalls it in a new thread', async () => {
    const target = ids();
    const created = await sendMessage({
      ...target,
      body: 'My goal is to buy a BMW X5 in the next year. Please remember that.',
    });
    expectSuccessful(created);

    let stored = await readMemory(target);
    if (findEntry(stored, 'goal') === undefined) {
      expect(created.body).toMatch(/confirm|approve|remember|save|goal|change/i);
      const approved = await sendMessage({ ...target, body: 'Yes' });
      expectSuccessful(approved);
      stored = await readMemory(target);
    }
    const createdGoal = findEntry(stored, 'goal');
    expect(createdGoal, JSON.stringify(stored)).toBeDefined();
    expect(JSON.stringify(createdGoal?.value ?? {})).toMatch(/BMW X5/i);

    const recalled = await sendMessage({
      householdId: target.householdId,
      conversationId: ids().conversationId,
      body: 'What durable goal do you remember for me?',
    });
    expectSuccessful(recalled);
    expect(recalled.body).toMatch(/BMW X5|buy.*car|goal/i);
  }, 300_000);

  it('working-memory-model-compatibility: suspends a replacement, applies the same entry after approval, and removes the old value', async () => {
    const target = ids();
    await writeMemory(target, {
      kind: 'goal',
      summary: 'Buy a BMW X5 within one year.',
      scope: 'household',
      value: { goal: 'BMW X5', timeframe: 'one year' },
    });

    const proposal = await sendMessage({
      ...target,
      body: 'Correction: replace the saved goal “Buy a BMW X5 within one year.” with “Buy a BMW X7 in two years.” Please ask for confirmation.',
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

  it('working-memory-model-compatibility: preserves the original entry when a replacement is rejected', async () => {
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
    expect(response.body).toMatch(/confirm|approve|would you like|another goal|shall i save|save/i);
    expect(Object.values((await readMemory(target)).entries)).toHaveLength(1);
  }, 300_000);

  it('asks for confirmation before saving an ordinary preference signal', async () => {
    const target = ids();
    const response = await sendMessage({
      ...target,
      body: 'I prefer concise monthly household summaries. Please remember this preference.',
    });
    expectSuccessful(response);
    expect(response.body).toMatch(/confirm|approve|would you like|remember/i);
    expect(Object.values((await readMemory(target)).entries)).toHaveLength(0);
  }, 300_000);

  it('shows safe personal and household views while preserving member isolation', async () => {
    const target = ids();
    await writeMemory(target, {
      kind: 'member_context',
      summary: 'Prefers concise replies.',
      scope: 'member',
      ownerPrincipalRef: principalRef,
      value: { communication: { detail: 'concise' } },
    });
    await writeMemory(target, {
      kind: 'convention',
      summary: 'Review household spending on Fridays.',
      scope: 'household',
      value: { cadence: 'Friday' },
    });
    await writeMemory(target, {
      kind: 'member_context',
      summary: 'Other member context.',
      scope: 'member',
      ownerPrincipalRef: otherPrincipalRef,
      value: { nickname: 'Other Person' },
    }, otherPrincipalRef);

    const personal = await viewLiveWorkingMemory({
      connectionString: live().context.roleUrls.memory,
      model: live().model,
      threadId: target.conversationId,
      resourceId: target.householdId,
      principalRef,
      view: 'personal',
    });
    expect(personal.status).toBe('succeeded');
    if (personal.status !== 'succeeded') return;
    expect(personal.entries.map((entry) => entry.summary)).toEqual(['Prefers concise replies.']);
    expect(JSON.stringify(personal)).not.toMatch(/entryId|revision|ownerPrincipalRef|Other Person/i);

    const response = await sendMessage({ ...target, body: 'What do you remember about me?' });
    expectSuccessful(response);
    expect(response.body).toMatch(/concise/i);
    expect(response.body).not.toMatch(/Other Person/i);

    const householdResponse = await sendMessage({ ...target, body: 'What do you remember about our household?' });
    expectSuccessful(householdResponse);
    expect(householdResponse.body).toMatch(/Friday|spending|household/i);
    expect(householdResponse.body).not.toMatch(/Other Person/i);
  }, 300_000);

  it('reviews duplicates and contradictions without changing the stored document', async () => {
    const target = ids();
    await writeMemory(target, {
      kind: 'communication_preference',
      summary: 'Concise replies.',
      scope: 'household',
      value: { detail: 'concise' },
    });
    await writeMemory(target, {
      kind: 'communication_preference',
      summary: 'Short replies.',
      scope: 'household',
      value: { detail: 'concise' },
    });
    await writeMemory(target, {
      kind: 'communication_preference',
      summary: 'Detailed replies.',
      scope: 'household',
      value: { detail: 'detailed' },
    });
    const before = await readMemory(target);
    const report = await reviewLiveWorkingMemory({
      connectionString: live().context.roleUrls.memory,
      model: live().model,
      threadId: target.conversationId,
      resourceId: target.householdId,
      principalRef,
    });
    expect(report.findings.map((finding) => finding.category)).toEqual(['duplicate', 'contradiction', 'contradiction']);
    await expect(readMemory(target)).resolves.toEqual(before);

    const response = await sendMessage({
      ...target,
      body: 'Review my durable working memory for duplicate or contradictory preferences. Do not change anything.',
    });
    expectSuccessful(response);
    expect(response.body).toMatch(/duplicate|contradict|review|finding/i);
    await expect(readMemory(target)).resolves.toEqual(before);
  }, 300_000);

  it('does not turn a conversation-only reference into durable Working Memory', async () => {
    const target = ids();
    const response = await sendMessage({
      ...target,
      body: 'We discussed a savings goal last month; continue with the conversation context, but do not save anything new.',
    });
    expectSuccessful(response);
    expect(Object.values((await readMemory(target)).entries)).toHaveLength(0);
  }, 300_000);

  it('keeps a saved fact available across conversations but not across households', async () => {
    const first = ids();
    await writeMemory(first, {
      kind: 'goal',
      summary: 'Buy a red cedar kayak in 37 days.',
      scope: 'household',
      value: { goal: 'Red cedar kayak', timeframe: '37 days' },
    });
    const sameHousehold = await sendMessage({
      householdId: first.householdId,
      conversationId: ids().conversationId,
      body: 'What durable goal do you remember for this household?',
    });
    expectSuccessful(sameHousehold);
    expect(sameHousehold.body).toMatch(/red cedar kayak|37 days/i);

    const otherHousehold = ids();
    const isolated = await sendMessage({
      ...otherHousehold,
      body: 'What durable goal do you remember for this household?',
    });
    expectSuccessful(isolated);
    expect(isolated.body).not.toMatch(/red cedar kayak|37 days/i);
    expect(Object.values((await readMemory(otherHousehold)).entries)).toHaveLength(0);
  }, 300_000);

  it('replaces flexible goal values without retaining the old value', async () => {
    const target = ids();
    await writeMemory(target, {
      kind: 'goal',
      summary: 'Buy a BMW X5 within one year.',
      scope: 'household',
      value: { goal: 'BMW X5', timeline: 'one year' },
    });
    await sendMessage({
      ...target,
      body: 'Correction: replace the saved goal “Buy a BMW X5 within one year.” with “Buy a BMW X7 in two years.” Please ask for confirmation.',
    });
    await sendMessage({ ...target, body: 'yes' });

    const goal = findEntry(await readMemory(target), 'goal');
    expect(JSON.stringify(goal?.value)).toMatch(/BMW X7/i);
    expect(JSON.stringify(goal?.value)).not.toMatch(/BMW X5|one year/i);
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
      expect(proposal.body).toMatch(/confirm|approve|clear|forget|working memory|change/i);
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
    const personalView = await viewLiveWorkingMemory({
      connectionString: live().context.roleUrls.memory,
      model: live().model,
      threadId: target.conversationId,
      resourceId: target.householdId,
      principalRef,
      view: 'personal',
    });
    expect(personalView).toMatchObject({ status: 'succeeded', entries: [] });
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

async function pendingInteraction(target: LiveIds): Promise<{
  status: string;
  payload: unknown;
  resolutionExternalMessageId: string | null;
}> {
  const operations = new Pool({ connectionString: live().context.roleUrls.operations, max: 1 });
  try {
    const result = await operations.query<{
      status: string;
      payload: unknown;
      resolution_external_message_id: string | null;
    }>(
      `SELECT status, payload, resolution_external_message_id
       FROM operations.pending_interactions
       JOIN operations.households ON households.id = pending_interactions.household_id
       WHERE households.household_id = $1
         AND pending_interactions.conversation_id = $2
         AND pending_interactions.speaker_principal_ref = $3
       ORDER BY pending_interactions.id DESC
       LIMIT 1`,
      [target.householdId, target.conversationId, principalRef],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('Expected a durable pending Working Memory interaction.');
    return {
      status: row.status,
      payload: row.payload,
      resolutionExternalMessageId: row.resolution_external_message_id,
    };
  } finally {
    await operations.end();
  }
}

async function runFreshIssue33Flows(budgetBody: string): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const target = ids();
    const proposal = await sendMessage({
      ...target,
      body: 'Please remember that I prefer concise household summaries, but ask me for confirmation before saving it.',
    });
    expectSuccessful(proposal);
    const pendingBeforeBudget = await pendingInteraction(target);
    expect(pendingBeforeBudget.status, `${budgetBody} attempt ${attempt}`).toBe('pending');
    await expect(readMemory(target)).resolves.toMatchObject({ version: 1, entries: {} });

    const budget = await sendMessage({ ...target, body: budgetBody });
    expectSuccessful(budget);
    expect(budget.body).not.toMatch(/concise.*(?:saved|stored)|(?:saved|stored).*concise/i);
    expect(await pendingInteraction(target)).toEqual(pendingBeforeBudget);
    await expect(readMemory(target)).resolves.toMatchObject({ version: 1, entries: {} });

    const approved = await sendMessage({ ...target, body: 'Ya, silakan simpan.' });
    expectSuccessful(approved);
    expect(findEntry(await readMemory(target), 'communication_preference')).toBeDefined();
    const terminal = await pendingInteraction(target);
    expect(terminal.status, `${budgetBody} attempt ${attempt}`).toBe('applied');
    expect(terminal.resolutionExternalMessageId).toBeTruthy();
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
