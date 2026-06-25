import { ArtifactIdSchema, HouseholdIdSchema, TaskIdSchema, UtcInstantSchema } from '@plus-one/contracts';
import type { SkillIdentityV1, VerificationTaskV1 } from '@plus-one/contracts';

export function makeVerificationTask(selectedSkill: SkillIdentityV1): VerificationTaskV1 {
  return {
    schemaName: 'verification-task', schemaVersion: 1,
    householdId: HouseholdIdSchema.parse('hh_01JNZQ4A9B8C7D6E5F4G3H2J1K'),
    taskId: TaskIdSchema.parse('task_01JNZQ4A9B8C7D6E5F4G3H2J1K'),
    checkerRole: { roleName: 'query-checker', roleVersion: 1 },
    makerArtifact: {
      artifactId: ArtifactIdSchema.parse('artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K'),
      householdId: HouseholdIdSchema.parse('hh_01JNZQ4A9B8C7D6E5F4G3H2J1K'),
      taskId: TaskIdSchema.parse('task_01JNZQ4A9B8C7D6E5F4G3H2J1K'),
      artifactType: 'maker_output',
      schema: { schemaName: 'maker-artifact', schemaVersion: 1 },
      canonicalizationVersion: 'rfc8785-v1', hashAlgorithm: 'sha256',
      artifactHash: 'b'.repeat(64),
      payload: { schemaName: 'maker-artifact', schemaVersion: 1,
        outputSchema: { schemaName: 'lookup-output', schemaVersion: 1 },
        output: { answer: '42' },
        claims: [{ claimId: 'claim-1', text: 'The answer is 42', evidenceArtifactIds: [] }],
        assumptions: [], uncertainty: [] },
      createdAt: UtcInstantSchema.parse('2026-06-14T10:00:00.000Z'),
    },
    makerInput: { question: 'What is the value?' },
    permittedEvidence: [], selectedSkill,
    rubric: { rubricName: 'lookup-rubric', rubricVersion: 1, instructions: ['Reject unsupported claims.'] },
    policyLabels: ['financial-data'],
    requiredOutputSchema: { schemaName: 'checker-verdict', schemaVersion: 1 },
  };
}
