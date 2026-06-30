import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import {
  ArtifactEnvelopeSchemaV1,
  MakerArtifactSchemaV1,
  MakerInvocationSchemaV1,
  VerificationTaskSchemaV1,
} from '@plus-one/contracts';
import { accountingSkills } from '@plus-one/accounting';
import {
  createAccountingRoleAgents,
  createJournalCheckerAgent,
  createJournalMakerAgent,
  createTransactionCaptureCheckerAgent,
  createTransactionCaptureMakerAgent,
} from '../src/agents/accounting/index.js';

const models = {
  lead: { id: 'provider/lead', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
  maker: { id: 'provider/maker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
  checker: { id: 'provider/checker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
};

const expectedIds = [
  'accounting-lead',
  'chart-checker',
  'chart-maker',
  'ingestion-checker',
  'ingestion-maker',
  'journal-checker',
  'journal-maker',
  'reconciliation-checker',
  'reconciliation-maker',
  'transaction-capture-checker',
  'transaction-capture-maker',
] as const;

describe('Accounting Mastra role agents', () => {
  it('creates one concrete Mastra agent per Accounting Team role with role-owned instructions', () => {
    const configs: Array<{
      id?: string;
      name?: string;
      description?: string;
      model?: unknown;
      tools?: Record<string, unknown>;
      instructions?: unknown;
    }> = [];
    const agents = createAccountingRoleAgents({
      models,
      tools: {},
      agentFactory: (config) => {
        configs.push(config as typeof configs[number]);
        return { generate: vi.fn() } as unknown as Agent;
      },
    });

    expect(Object.keys(agents).sort()).toEqual([...expectedIds]);
    expect(configs.map((config) => config.id).sort()).toEqual([...expectedIds]);
    expect(configs.every((config) => Object.keys(config.tools ?? {}).length === 0)).toBe(true);
    expect(configs.find((config) => config.id === 'accounting-lead')).toMatchObject({
      name: 'Accounting Team Lead',
      model: { id: 'provider/lead', url: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      tools: {},
    });
    expect(configs.find((config) => config.id === 'journal-maker')).toMatchObject({
      model: { id: 'provider/maker', url: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      tools: {},
    });
    expect(configs.find((config) => config.id === 'journal-checker')).toMatchObject({
      model: { id: 'provider/checker', url: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      tools: {},
    });
  });

  it('keeps ingestion and reconciliation inside the Accounting Team agent folder', () => {
    const agents = createAccountingRoleAgents({
      models,
      tools: {},
      agentFactory: () => ({ generate: vi.fn() } as unknown as Agent),
    });

    expect(agents['ingestion-maker']).toBeDefined();
    expect(agents['ingestion-checker']).toBeDefined();
    expect(agents['reconciliation-maker']).toBeDefined();
    expect(agents['reconciliation-checker']).toBeDefined();
  });

  it('puts input/output contracts and no-direct-tool boundaries in every instruction set', () => {
    const configs: Array<{ id?: string; instructions?: unknown }> = [];
    createAccountingRoleAgents({
      models,
      tools: {},
      agentFactory: (config) => {
        configs.push(config as typeof configs[number]);
        return { generate: vi.fn() } as unknown as Agent;
      },
    });

    for (const config of configs) {
      const instructions = String(config.instructions);
      expect(instructions).toContain('Input contract:');
      expect(instructions).toContain('Output contract:');
      expect(instructions).toContain('Do not access databases, SQL, command handlers, command registries, provider accounts, external financial systems, arbitrary files, or unavailable tools.');
      expect(instructions).toContain('Return only');
    }
    const accountingLeadInstructions = String(configs.find((config) => config.id === 'accounting-lead')?.instructions);
    expect(accountingLeadInstructions).toContain('transaction_capture -> transaction-capture');
    expect(accountingLeadInstructions).toContain('single-maker-checker');
    expect(accountingLeadInstructions).toContain('checked-transaction-capture');
    expect(String(configs.find((config) => config.id === 'transaction-capture-maker')?.instructions))
      .toContain('accounting-clarification');
    expect(String(configs.find((config) => config.id === 'ingestion-maker')?.instructions))
      .toContain('Never auto-post probable duplicates');
    expect(String(configs.find((config) => config.id === 'chart-checker')?.instructions))
      .toContain('requires external confirmation before persistence');
    expect(String(configs.find((config) => config.id === 'reconciliation-checker')?.instructions))
      .toContain('Return insufficient_evidence when checked evidence is missing');
  });

  it('accepts valid transaction-capture clarifications without calling the model', async () => {
    const modelGenerate = vi.fn(async () => {
      throw new Error('model should not be called');
    });
    const agent = createTransactionCaptureCheckerAgent({
      models,
      tools: {},
      agentFactory: () => ({ generate: modelGenerate } as unknown as Agent),
    });
    const makerArtifact = ArtifactEnvelopeSchemaV1.parse({
      artifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      artifactType: 'maker_output',
      schema: { schemaName: 'maker-artifact', schemaVersion: 1 },
      canonicalizationVersion: 'rfc8785-v1',
      hashAlgorithm: 'sha256',
      artifactHash: 'b'.repeat(64),
      payload: MakerArtifactSchemaV1.parse({
        schemaName: 'maker-artifact',
        schemaVersion: 1,
        outputSchema: { schemaName: 'accounting-work-result', schemaVersion: 1 },
        output: {
          schemaName: 'accounting-clarification',
          schemaVersion: 1,
          missingFields: ['payment_account', 'occurred_on', 'category'],
          questions: [
            'Which internal payment account should this use?',
            'On what date did the transaction occur?',
            'Which internal category account should this use?',
          ],
          reason: 'The transaction cannot be posted without account, date, and category.',
        },
        claims: [],
        assumptions: [],
        uncertainty: [],
      }),
      createdAt: '2026-06-24T00:00:00.000Z',
    });
    const skill = accountingSkills.find((candidate) => candidate.identity.skillName === 'transaction-capture')!;
    const task = VerificationTaskSchemaV1.parse({
      schemaName: 'verification-task',
      schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      checkerRole: { roleName: 'transaction-capture-checker', roleVersion: 1 },
      makerArtifact,
      makerInput: {
        schemaName: 'transaction-capture-request',
        schemaVersion: 1,
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        explicitInstruction: true,
        instruction: 'add $10 of buying a burger',
        known: { amount: '10.00', currency: 'USD' },
      },
      permittedEvidence: [],
      selectedSkill: skill.identity,
      rubric: { rubricName: 'transaction-capture-rubric', rubricVersion: 1, instructions: ['Check.'] },
      policyLabels: ['personalized_finance'],
      requiredOutputSchema: { schemaName: 'checker-verdict', schemaVersion: 1 },
    });

    const result = await agent.generate([{ role: 'user', content: JSON.stringify(task) }], {});

    expect(modelGenerate).not.toHaveBeenCalled();
    expect(result).toEqual({
      object: {
        verdict: 'accepted',
        coveredArtifactId: makerArtifact.artifactId,
        coveredArtifactHash: makerArtifact.artifactHash,
        findings: [],
      },
    });
  });

  it('returns transaction-capture clarifications without calling the model when required fields are missing', async () => {
    const modelGenerate = vi.fn(async () => {
      throw new Error('model should not be called');
    });
    const agent = createTransactionCaptureMakerAgent({
      models,
      tools: {},
      agentFactory: () => ({ generate: modelGenerate } as unknown as Agent),
    });
    const skill = accountingSkills.find((candidate) => candidate.identity.skillName === 'transaction-capture')!;
    const invocation = MakerInvocationSchemaV1.parse({
      schemaName: 'maker-invocation',
      schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      team: 'accounting',
      role: { roleName: 'transaction-capture-maker', roleVersion: 1 },
      skill: skill.identity,
      inputSchema: { schemaName: 'transaction-capture-request', schemaVersion: 1 },
      outputSchema: { schemaName: 'accounting-work-result', schemaVersion: 1 },
      input: {
        schemaName: 'transaction-capture-request',
        schemaVersion: 1,
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        explicitInstruction: true,
        instruction: 'add $10 of buying a burger',
        known: { amount: '10.00', currency: 'USD' },
      },
      permittedEvidence: [],
      policyLabels: ['personalized_finance'],
      stopCondition: { code: 'checked-transaction-capture', description: 'Return one checked accounting result.' },
    });

    const result = await agent.generate([{ role: 'user', content: JSON.stringify(invocation) }], {});

    expect(modelGenerate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      object: {
        outputSchema: { schemaName: 'accounting-work-result', schemaVersion: 1 },
        output: {
          schemaName: 'accounting-clarification',
          missingFields: ['payment_account', 'occurred_on', 'category'],
        },
      },
    });
  });

  it('returns deterministic transaction-capture proposals without calling the model when required fields, period, and account currencies are present', async () => {
    const modelGenerate = vi.fn(async () => {
      throw new Error('model should not be called');
    });
    const agent = createTransactionCaptureMakerAgent({
      models,
      tools: {},
      agentFactory: () => ({ generate: modelGenerate } as unknown as Agent),
    });
    const skill = accountingSkills.find((candidate) => candidate.identity.skillName === 'transaction-capture')!;
    const invocation = MakerInvocationSchemaV1.parse({
      schemaName: 'maker-invocation',
      schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      team: 'accounting',
      role: { roleName: 'transaction-capture-maker', roleVersion: 1 },
      skill: skill.identity,
      inputSchema: { schemaName: 'transaction-capture-request', schemaVersion: 1 },
      outputSchema: { schemaName: 'accounting-work-result', schemaVersion: 1 },
      input: {
        schemaName: 'transaction-capture-request',
        schemaVersion: 1,
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        periodId: 'period_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        explicitInstruction: true,
        instruction: 'Record a USD 10.00 grocery purchase.',
        paymentAccountCurrency: 'USD',
        categoryAccountCurrency: 'USD',
        known: {
          amount: '10.00',
          currency: 'USD',
          paymentAccountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
          occurredOn: '2026-06-27',
          categoryAccountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J3K',
        },
      },
      permittedEvidence: [],
      policyLabels: ['personalized_finance'],
      stopCondition: { code: 'checked-transaction-capture', description: 'Return one checked accounting result.' },
    });

    const result = await agent.generate([{ role: 'user', content: JSON.stringify(invocation) }], {});

    expect(modelGenerate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      object: {
        outputSchema: { schemaName: 'accounting-work-result', schemaVersion: 1 },
        output: {
          schemaName: 'accounting-journal-mutation-proposal',
          schemaVersion: 1,
          operation: 'post',
          draft: {
            draftSeriesId: 'draftseries_01JNZQ4A9B8C7D6E5F4G3H2J1K',
            version: 1,
            journal: {
              schemaName: 'post-journal-proposal',
              schemaVersion: 1,
              householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
              bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
              journalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J1K',
              draftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J1K',
              periodId: 'period_01JNZQ4A9B8C7D6E5F4G3H2J1K',
              taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
              transactionCurrency: 'USD',
              occurredOn: '2026-06-27',
              effectiveOn: '2026-06-27',
              postings: [
                {
                  accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J3K',
                  direction: 'debit',
                  transactionAmount: '10.00',
                  accountNativeAmount: '10.00',
                  accountNativeCurrency: 'USD',
                },
                {
                  accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
                  direction: 'credit',
                  transactionAmount: '10.00',
                  accountNativeAmount: '10.00',
                  accountNativeCurrency: 'USD',
                },
              ],
            },
          },
        },
      },
    });
  });

  it('accepts deterministic transaction-capture proposals without calling the model when they match the fully-known request', async () => {
    const modelGenerate = vi.fn(async () => {
      throw new Error('model should not be called');
    });
    const agent = createTransactionCaptureCheckerAgent({
      models,
      tools: {},
      agentFactory: () => ({ generate: modelGenerate } as unknown as Agent),
    });
    const makerArtifact = ArtifactEnvelopeSchemaV1.parse({
      artifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      artifactType: 'maker_output',
      schema: { schemaName: 'maker-artifact', schemaVersion: 1 },
      canonicalizationVersion: 'rfc8785-v1',
      hashAlgorithm: 'sha256',
      artifactHash: 'b'.repeat(64),
      payload: MakerArtifactSchemaV1.parse({
        schemaName: 'maker-artifact',
        schemaVersion: 1,
        outputSchema: { schemaName: 'accounting-work-result', schemaVersion: 1 },
        output: {
          schemaName: 'accounting-journal-mutation-proposal',
          schemaVersion: 1,
          operation: 'post',
          draft: {
            draftSeriesId: 'draftseries_01JNZQ4A9B8C7D6E5F4G3H2J1K',
            version: 1,
            journal: {
              schemaName: 'post-journal-proposal',
              schemaVersion: 1,
              householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
              bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
              journalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J1K',
              draftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J1K',
              periodId: 'period_01JNZQ4A9B8C7D6E5F4G3H2J1K',
              taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
              journalType: 'ordinary',
              transactionCurrency: 'USD',
              occurredOn: '2026-06-27',
              effectiveOn: '2026-06-27',
              description: 'Record a USD 10.00 grocery purchase.',
              tagIds: [],
              postings: [
                {
                  accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J3K',
                  direction: 'debit',
                  transactionAmount: '10.00',
                  accountNativeAmount: '10.00',
                  accountNativeCurrency: 'USD',
                  tagIds: [],
                },
                {
                  accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
                  direction: 'credit',
                  transactionAmount: '10.00',
                  accountNativeAmount: '10.00',
                  accountNativeCurrency: 'USD',
                  tagIds: [],
                },
              ],
            },
          },
        },
        claims: [],
        assumptions: [],
        uncertainty: [],
      }),
      createdAt: '2026-06-24T00:00:00.000Z',
    });
    const skill = accountingSkills.find((candidate) => candidate.identity.skillName === 'transaction-capture')!;
    const task = VerificationTaskSchemaV1.parse({
      schemaName: 'verification-task',
      schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      checkerRole: { roleName: 'transaction-capture-checker', roleVersion: 1 },
      makerArtifact,
      makerInput: {
        schemaName: 'transaction-capture-request',
        schemaVersion: 1,
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        periodId: 'period_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        explicitInstruction: true,
        instruction: 'Record a USD 10.00 grocery purchase.',
        paymentAccountCurrency: 'USD',
        categoryAccountCurrency: 'USD',
        known: {
          amount: '10.00',
          currency: 'USD',
          paymentAccountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
          occurredOn: '2026-06-27',
          categoryAccountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J3K',
        },
      },
      permittedEvidence: [],
      selectedSkill: skill.identity,
      rubric: { rubricName: 'transaction-capture-rubric', rubricVersion: 1, instructions: ['Check.'] },
      policyLabels: ['personalized_finance'],
      requiredOutputSchema: { schemaName: 'checker-verdict', schemaVersion: 1 },
    });

    const result = await agent.generate([{ role: 'user', content: JSON.stringify(task) }], {});

    expect(modelGenerate).not.toHaveBeenCalled();
    expect(result).toEqual({
      object: {
        verdict: 'accepted',
        coveredArtifactId: makerArtifact.artifactId,
        coveredArtifactHash: makerArtifact.artifactHash,
        findings: [],
      },
    });
  });

  it('returns journal transfer clarifications without calling the model', async () => {
    const modelGenerate = vi.fn(async () => {
      throw new Error('model should not be called');
    });
    const agent = createJournalMakerAgent({
      models,
      tools: {},
      agentFactory: () => ({ generate: modelGenerate } as unknown as Agent),
    });
    const skill = accountingSkills.find((candidate) => candidate.identity.skillName === 'accounting-journal')!;
    const invocation = MakerInvocationSchemaV1.parse({
      schemaName: 'maker-invocation',
      schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      team: 'accounting',
      role: { roleName: 'journal-maker', roleVersion: 1 },
      skill: skill.identity,
      inputSchema: { schemaName: 'journal-work-request', schemaVersion: 1 },
      outputSchema: { schemaName: 'accounting-work-result', schemaVersion: 1 },
      input: {
        schemaName: 'journal-work-request',
        schemaVersion: 1,
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        operation: 'transfer',
        instruction: 'transfer $1000 from my savings to my checking account',
      },
      permittedEvidence: [],
      policyLabels: ['personalized_finance'],
      stopCondition: { code: 'checked-journal', description: 'Return one checked accounting result.' },
    });

    const result = await agent.generate([{ role: 'user', content: JSON.stringify(invocation) }], {});

    expect(modelGenerate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      object: {
        output: {
          schemaName: 'accounting-clarification',
          missingFields: ['payment_account', 'occurred_on'],
        },
      },
    });
  });

  it('accepts journal transfer clarifications without calling the model', async () => {
    const modelGenerate = vi.fn(async () => {
      throw new Error('model should not be called');
    });
    const agent = createJournalCheckerAgent({
      models,
      tools: {},
      agentFactory: () => ({ generate: modelGenerate } as unknown as Agent),
    });
    const makerArtifact = ArtifactEnvelopeSchemaV1.parse({
      artifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      artifactType: 'maker_output',
      schema: { schemaName: 'maker-artifact', schemaVersion: 1 },
      canonicalizationVersion: 'rfc8785-v1',
      hashAlgorithm: 'sha256',
      artifactHash: 'b'.repeat(64),
      payload: MakerArtifactSchemaV1.parse({
        schemaName: 'maker-artifact',
        schemaVersion: 1,
        outputSchema: { schemaName: 'accounting-work-result', schemaVersion: 1 },
        output: {
          schemaName: 'accounting-clarification',
          schemaVersion: 1,
          missingFields: ['payment_account', 'occurred_on'],
          questions: [
            'Which internal account should be the source for this transfer?',
            'Which internal account should be the destination for this transfer?',
            'On what date should this transfer be recorded?',
          ],
          reason: 'The transfer cannot be posted until the exact internal source account, destination account, and effective date are confirmed.',
        },
        claims: [],
        assumptions: [],
        uncertainty: [],
      }),
      createdAt: '2026-06-24T00:00:00.000Z',
    });
    const skill = accountingSkills.find((candidate) => candidate.identity.skillName === 'accounting-journal')!;
    const task = VerificationTaskSchemaV1.parse({
      schemaName: 'verification-task',
      schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      checkerRole: { roleName: 'journal-checker', roleVersion: 1 },
      makerArtifact,
      makerInput: {
        schemaName: 'journal-work-request',
        schemaVersion: 1,
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        operation: 'transfer',
        instruction: 'transfer $1000 from my savings to my checking account',
      },
      permittedEvidence: [],
      selectedSkill: skill.identity,
      rubric: { rubricName: 'journal-rubric', rubricVersion: 1, instructions: ['Check.'] },
      policyLabels: ['personalized_finance'],
      requiredOutputSchema: { schemaName: 'checker-verdict', schemaVersion: 1 },
    });

    const result = await agent.generate([{ role: 'user', content: JSON.stringify(task) }], {});

    expect(modelGenerate).not.toHaveBeenCalled();
    expect(result).toEqual({
      object: {
        verdict: 'accepted',
        coveredArtifactId: makerArtifact.artifactId,
        coveredArtifactHash: makerArtifact.artifactHash,
        findings: [],
      },
    });
  });
});
