import { describe, expect, it } from 'vitest';
import {
  MakerArtifactSchemaV1,
  MakerInvocationSchemaV1,
  TeamLeadInvocationSchemaV1,
  TeamLeadPlanSchemaV1,
  TeamResultEnvelopeSchemaV1,
  VerificationTaskSchemaV1,
} from './index.js';

const identity = {
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
} as const;
const skill = { skillName: 'verified-lookup', skillVersion: 1, contentHash: 'a'.repeat(64) };
const makerArtifact = {
  artifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  ...identity,
  artifactType: 'maker_output',
  schema: { schemaName: 'maker-artifact', schemaVersion: 1 },
  canonicalizationVersion: 'rfc8785-v1',
  hashAlgorithm: 'sha256',
  artifactHash: 'b'.repeat(64),
  payload: {
    schemaName: 'maker-artifact',
    schemaVersion: 1,
    outputSchema: { schemaName: 'lookup-output', schemaVersion: 1 },
    output: { answer: '42' },
    claims: [{ claimId: 'claim-1', text: 'The answer is 42', evidenceArtifactIds: [] }],
    assumptions: [],
    uncertainty: [],
  },
  createdAt: '2026-06-14T10:00:00.000Z',
};

describe('team execution contracts', () => {
  it('rejects prompted JSON strings at maker boundaries', () => {
    expect(MakerArtifactSchemaV1.safeParse('{"answer":42}').success).toBe(false);
  });

  it('requires a versioned invocation and selected immutable skill identity', () => {
    expect(MakerInvocationSchemaV1.parse({
      schemaName: 'maker-invocation', schemaVersion: 1, ...identity, team: 'query',
      role: { roleName: 'query-maker', roleVersion: 1 }, skill,
      inputSchema: { schemaName: 'lookup-input', schemaVersion: 1 },
      outputSchema: { schemaName: 'lookup-output', schemaVersion: 1 },
      input: { question: 'What is the value?' }, permittedEvidence: [],
      policyLabels: ['financial-data'], stopCondition: { code: 'exact-answer', description: 'Return one checked answer' },
    }).skill).toEqual(skill);
  });

  it('keeps lead recommendations typed and non-authoritative', () => {
    const invocation = TeamLeadInvocationSchemaV1.parse({
      schemaName: 'team-lead-invocation', schemaVersion: 1, ...identity, team: 'query',
      role: { roleName: 'query-lead', roleVersion: 1 }, selectedSkill: skill,
      request: { question: 'Compare two checked views.' },
      availableWorkCellIds: ['lookup'], availableStrategyNames: ['parallel-independent-makers'],
      policyLabels: ['financial-data'],
    });
    expect(TeamLeadPlanSchemaV1.parse({
      schemaName: 'team-lead-plan', schemaVersion: 1,
      recommendedStrategyName: invocation.availableStrategyNames[0],
      work: [{ workCellId: 'lookup', makerInput: invocation.request }],
      stopCondition: { code: 'checked-comparison', description: 'Return checked comparison inputs.' },
    }).recommendedStrategyName).toBe('parallel-independent-makers');
  });

  it('embeds the exact immutable maker artifact in a verification task', () => {
    const parsed = VerificationTaskSchemaV1.parse({
      schemaName: 'verification-task', schemaVersion: 1, ...identity,
      checkerRole: { roleName: 'query-checker', roleVersion: 1 },
      makerArtifact, makerInput: { question: 'What is the value?' }, permittedEvidence: [], selectedSkill: skill,
      rubric: { rubricName: 'lookup-rubric', rubricVersion: 1, instructions: ['Check the evidence and claim.'] },
      policyLabels: ['financial-data'],
      requiredOutputSchema: { schemaName: 'checker-verdict', schemaVersion: 1 },
    });
    expect(parsed.makerArtifact.artifactHash).toBe('b'.repeat(64));
  });

  it('requires checked artifact references for every final claim', () => {
    const result = {
      schemaName: 'team-result', schemaVersion: 1, ...identity, team: 'query',
      status: 'verified', claims: [{ claimId: 'claim-1', text: 'The answer is 42',
        evidenceArtifactIds: [], checkedMakerArtifactIds: [makerArtifact.artifactId] }],
      assumptions: [], uncertainty: [], freshness: [], coverage: ['requested answer'],
      makerArtifacts: [makerArtifact],
      checkerVerdicts: [{ verdict: 'accepted', coveredArtifactId: makerArtifact.artifactId,
        coveredArtifactHash: makerArtifact.artifactHash, findings: [] }],
      selectedSkill: skill, strategyName: 'verified-factual-lookup',
      stopCondition: { code: 'exact-answer', description: 'Return one checked answer' },
      completionReason: 'The exact-answer condition passed.', outstanding: [],
    };
    expect(TeamResultEnvelopeSchemaV1.parse(result).status).toBe('verified');
    expect(TeamResultEnvelopeSchemaV1.safeParse({
      ...result,
      claims: [{ ...result.claims[0]!, checkedMakerArtifactIds: ['artifact_01AAAAAAAAAAAAAAAAAAAAAAAAAA'] }],
    }).success).toBe(false);
  });
});
