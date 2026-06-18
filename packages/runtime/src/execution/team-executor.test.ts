import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { TeamExecutor } from '../index.js';

describe('TeamExecutor', () => {
  it('freezes maker output before checking and retries revisions with new artifacts', async () => {
    const calls: string[] = [];
    const runtime = {
      createTask: vi.fn(), selectContract: vi.fn(), beginMaker: vi.fn(() => calls.push('begin-maker')),
      validateMaker: vi.fn(async (input) => {
        calls.push('freeze-maker');
        return { ...input, artifactType: 'maker_output',
          schema: { schemaName: 'maker-artifact', schemaVersion: 1 },
          canonicalizationVersion: 'rfc8785-v1', hashAlgorithm: 'sha256',
          artifactHash: input.artifactId.endsWith('1K') ? 'a'.repeat(64) : 'b'.repeat(64),
          createdAt: '2026-06-14T10:00:00.000Z' };
      }),
      beginChecker: vi.fn(() => calls.push('begin-checker')),
      validateChecker: vi.fn(async (input) => {
        calls.push('freeze-checker');
        return { artifactId: input.checkerArtifactId, artifactHash: 'c'.repeat(64) };
      }),
      requestRevision: vi.fn(() => calls.push('revision')),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const runner = { run: vi.fn()
      .mockResolvedValueOnce({ schemaName: 'maker-artifact', schemaVersion: 1,
        outputSchema: { schemaName: 'lookup-output', schemaVersion: 1 }, output: { answer: '41' },
        claims: [{ claimId: 'c1', text: '41', evidenceArtifactIds: [] }], assumptions: [], uncertainty: [] })
      .mockResolvedValueOnce({ verdict: 'revision_requested',
        coveredArtifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        coveredArtifactHash: 'a'.repeat(64), findings: [{ code: 'wrong', message: 'Recalculate.' }] })
      .mockResolvedValueOnce({ schemaName: 'maker-artifact', schemaVersion: 1,
        outputSchema: { schemaName: 'lookup-output', schemaVersion: 1 }, output: { answer: '42' },
        claims: [{ claimId: 'c2', text: '42', evidenceArtifactIds: [] }], assumptions: [], uncertainty: [] })
      .mockResolvedValueOnce({ verdict: 'accepted',
        coveredArtifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J2K',
        coveredArtifactHash: 'b'.repeat(64), findings: [] }) };
    const executor = new TeamExecutor({
      runtime: runtime as never, runner: runner as never,
      contexts: { forMaker: vi.fn(() => ({ systemPrompt: 'maker', messages: [{ role: 'user', content: '{}' }],
        parentMessages: [], memoryEnabled: false, activeTools: [], toolHistory: [] })),
        forChecker: vi.fn(() => ({ systemPrompt: 'checker', messages: [{ role: 'user', content: '{}' }],
          parentMessages: [], memoryEnabled: false, activeTools: [], toolHistory: [] })) } as never,
      policies: { resolve: vi.fn(() => ({ maxAttempts: 2, teamDeadlineMs: 5_000, identity: {
        policyName: 'test', policyVersion: 1 } })) } as never,
      ids: { nextArtifactId: vi.fn()
        .mockReturnValueOnce('artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K')
        .mockReturnValueOnce('artifact_01JNZQ4A9B8C7D6E5F4G3H2J9K')
        .mockReturnValueOnce('artifact_01JNZQ4A9B8C7D6E5F4G3H2J2K')
        .mockReturnValueOnce('artifact_01JNZQ4A9B8C7D6E5F4G3H2J8K') },
    });
    const result = await executor.executeWorkCell(makeExecutionInput());
    expect(result.status).toBe('verified');
    expect(result.makerArtifacts).toHaveLength(2);
    expect(calls).toEqual(['begin-maker', 'freeze-maker', 'begin-checker', 'freeze-checker',
      'revision', 'begin-maker', 'freeze-maker', 'begin-checker', 'freeze-checker']);
  });

  it('leaves an accepted mutation work cell at checker_validated', async () => {
    const runtime = {
      createTask: vi.fn(),
      selectContract: vi.fn(),
      beginMaker: vi.fn(),
      beginChecker: vi.fn(),
      validateMaker: vi.fn(async (input) => ({
        ...input,
        artifactType: 'maker_output',
        schema: { schemaName: 'maker-artifact', schemaVersion: 1 },
        canonicalizationVersion: 'rfc8785-v1',
        hashAlgorithm: 'sha256',
        artifactHash: 'a'.repeat(64),
        createdAt: '2026-06-15T08:00:00.000Z',
      })),
      validateChecker: vi.fn(),
      requestRevision: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const runner = { run: vi.fn()
      .mockResolvedValueOnce({
        schemaName: 'maker-artifact',
        schemaVersion: 1,
        outputSchema: { schemaName: 'lookup-output', schemaVersion: 1 },
        output: { answer: '42' },
        claims: [{ claimId: 'c1', text: '42', evidenceArtifactIds: [] }],
        assumptions: [],
        uncertainty: [],
      })
      .mockResolvedValueOnce({
        verdict: 'accepted',
        coveredArtifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        coveredArtifactHash: 'a'.repeat(64),
        findings: [],
      }) };
    const executor = new TeamExecutor({
      runtime: runtime as never,
      runner: runner as never,
      contexts: {
        forMaker: vi.fn(() => ({
          systemPrompt: 'maker',
          messages: [],
          parentMessages: [],
          memoryEnabled: false,
          activeTools: [],
          toolHistory: [],
        })),
        forChecker: vi.fn(() => ({
          systemPrompt: 'checker',
          messages: [],
          parentMessages: [],
          memoryEnabled: false,
          activeTools: [],
          toolHistory: [],
        })),
      } as never,
      policies: { resolve: vi.fn(() => ({
        maxAttempts: 1,
        teamDeadlineMs: 5_000,
        identity: { policyName: 'test', policyVersion: 1 },
      })) } as never,
      ids: { nextArtifactId: vi.fn()
        .mockReturnValueOnce('artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K')
        .mockReturnValueOnce('artifact_01JNZQ4A9B8C7D6E5F4G3H2J2K') },
    });
    const result = await executor.executeWorkCell({
      ...makeExecutionInput(),
      completionMode: 'checked_mutation',
    });
    expect(result.status).toBe('verified');
    expect(result.completionState).toBe('checked_mutation_pending');
    expect(runtime.complete).not.toHaveBeenCalled();
  });
});

function makeExecutionInput() {
  const outputSchema = z.object({ answer: z.string() }).strict();
  return {
    householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K', team: 'query',
    workCell: {
      workCellId: 'lookup',
      maker: { identity: { roleName: 'query-maker', roleVersion: 1 }, kind: 'maker' as const,
        agentId: 'query-maker', runtimePolicy: { policyName: 'query-maker', policyVersion: 1 } },
      checker: { identity: { roleName: 'query-checker', roleVersion: 1 }, kind: 'checker' as const,
        agentId: 'query-checker', runtimePolicy: { policyName: 'query-checker', policyVersion: 1 } },
      makerInputSchema: z.object({ question: z.string() }), makerOutputSchema: outputSchema,
      inputSchemaIdentity: { schemaName: 'lookup-input', schemaVersion: 1 },
      outputSchemaIdentity: { schemaName: 'lookup-output', schemaVersion: 1 },
      checkerRubric: { rubricName: 'lookup-rubric', rubricVersion: 1, instructions: ['Check answer.'] },
      allowedSkillNames: ['verified-lookup'],
      evaluateStopCondition: () => ({ status: 'verified' as const,
        reason: 'The exact checked answer is present.', outstanding: [] }),
    },
    selectedSkill: { skillName: 'verified-lookup', skillVersion: 1, contentHash: 'a'.repeat(64) },
    makerInput: { question: 'What is six times seven?' }, permittedEvidence: [],
    policyLabels: [], stopCondition: { code: 'exact-answer', description: 'Return a checked answer.' },
    strategyName: 'verified-factual-lookup', abortSignal: new AbortController().signal,
  };
}
