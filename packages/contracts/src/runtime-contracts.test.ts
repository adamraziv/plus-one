import { describe, expect, it } from 'vitest';
import {
  ArtifactEnvelopeSchemaV1,
  CheckerVerdictSchemaV1,
  RuntimePolicySchemaV1,
  TaskStatusSchemaV1,
} from './index.js';

describe('operational contracts', () => {
  it('requires versioned immutable artifact identity and lowercase sha256', () => {
    const parsed = ArtifactEnvelopeSchemaV1.parse({
      artifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      artifactType: 'maker_output',
      schema: { schemaName: 'cash-flow-maker-output', schemaVersion: 1 },
      canonicalizationVersion: 'rfc8785-v1',
      hashAlgorithm: 'sha256',
      artifactHash: 'a'.repeat(64),
      payload: { amount: '12.34', labels: ['verified'] },
      createdAt: '2026-06-14T10:00:00.000Z',
    });

    expect(parsed.artifactHash).toBe('a'.repeat(64));
    expect(
      ArtifactEnvelopeSchemaV1.safeParse({
        ...parsed,
        artifactHash: 'A'.repeat(64),
      }).success,
    ).toBe(false);
  });

  it('requires checker coverage of an exact artifact ID and hash', () => {
    expect(
      CheckerVerdictSchemaV1.safeParse({
        verdict: 'accepted',
        coveredArtifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      }).success,
    ).toBe(false);
  });

  it('fixes lifecycle and bounded runtime policy vocabulary', () => {
    expect(TaskStatusSchemaV1.parse('checker_validated')).toBe('checker_validated');
    expect(TaskStatusSchemaV1.safeParse('done').success).toBe(false);
    expect(
      RuntimePolicySchemaV1.parse({
        identity: { policyName: 'default-maker', policyVersion: 1 },
        requiredCapabilities: ['structured_output'],
        primaryModel: 'provider/model-a',
        fallbackModels: ['provider/model-b'],
        maxModelSteps: 8,
        maxToolConcurrency: 2,
        maxAttempts: 2,
        maxModelRequestRetries: 1,
        maxProcessorRetries: 1,
        maxSandboxReproductions: 0,
        callDeadlineMs: 30_000,
        teamDeadlineMs: 120_000,
        endToEndDeadlineMs: 300_000,
        maxOutputBytes: 131_072,
      }).maxAttempts,
    ).toBe(2);
  });
});
