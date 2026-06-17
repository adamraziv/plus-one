import { describe, expect, it } from 'vitest';
import { HouseholdIdSchema, TaskIdSchema, type TeamLeadInvocationV1 } from '@plus-one/contracts';
import { RoleContextBuilder, SkillRegistry, ToolPermissionRegistry, createSkillRegistration } from '../index.js';
import { makeVerificationTask } from '../../../../test/helpers/team-contract-fixtures.js';

const skill = createSkillRegistration({
  skillName: 'verified-lookup', skillVersion: 1, content: 'Check primary evidence first.',
  allowedTeams: ['query'], allowedRoles: ['query-maker', 'query-checker', 'query-lead'],
  makerInstructions: ['Return typed claims.'],
  checkerRubric: ['Verify every claim.'],
});

const tools = new ToolPermissionRegistry([
  { team: 'query', roleName: 'query-maker', roleVersion: 1, toolIds: ['web.lookup'] },
  { team: 'query', roleName: 'query-checker', roleVersion: 1, toolIds: [] },
  { team: 'query', roleName: 'query-lead', roleVersion: 1, toolIds: [] },
]);
const skills = new SkillRegistry([skill]);

const builder = new RoleContextBuilder({ skills, tools });

describe('RoleContextBuilder', () => {
  it('builds an isolated checker context with one typed verification task', () => {
    const task = makeVerificationTask(skill.identity);
    const context = builder.forChecker({
      team: 'query',
      role: { roleName: 'query-checker', roleVersion: 1 },
      selectedSkill: skill.identity,
      verificationTask: task,
    });
    expect(context.messages).toEqual([{ role: 'user', content: JSON.stringify(task) }]);
    expect(context.parentMessages).toEqual([]);
    expect(context.memoryEnabled).toBe(false);
    expect(context.activeTools).toEqual([]);
    expect(context.toolHistory).toEqual([]);
  });

  it('builds the lead charter from registered roles, tools, strategies, and selected skill', () => {
    const invocation: TeamLeadInvocationV1 = {
      schemaName: 'team-lead-invocation', schemaVersion: 1,
      householdId: HouseholdIdSchema.parse('hh_01JNZQ4A9B8C7D6E5F4G3H2J1K'),
      taskId: TaskIdSchema.parse('task_01JNZQ4A9B8C7D6E5F4G3H2J1K'),
      team: 'query',
      role: { roleName: 'query-lead', roleVersion: 1 }, selectedSkill: skill.identity,
      request: { question: 'Look up a checked value.' }, availableWorkCellIds: ['lookup'],
      availableStrategyNames: ['verified-factual-lookup'], policyLabels: ['financial-data'],
    };
    const context = builder.forLead({
      team: {
        team: 'query',
        lead: { identity: invocation.role, kind: 'lead' as const, agentId: 'query-lead',
          runtimePolicy: { policyName: 'query-lead', policyVersion: 1 } },
        charter: 'Return checked financial evidence.', prohibitedBehavior: ['Do not mutate data.'],
        workCells: [{ workCellId: 'lookup',
          maker: { identity: { roleName: 'query-maker', roleVersion: 1 }, kind: 'maker' as const,
            agentId: 'query-maker', runtimePolicy: { policyName: 'query-maker', policyVersion: 1 } },
          checker: { identity: { roleName: 'query-checker', roleVersion: 1 }, kind: 'checker' as const,
            agentId: 'query-checker', runtimePolicy: { policyName: 'query-checker', policyVersion: 1 } },
          makerInputSchema: undefined as never, makerOutputSchema: undefined as never,
          inputSchemaIdentity: { schemaName: 'lookup-input', schemaVersion: 1 },
          outputSchemaIdentity: { schemaName: 'lookup-output', schemaVersion: 1 },
          checkerRubric: { rubricName: 'lookup-rubric', rubricVersion: 1, instructions: ['Check.'] },
          allowedSkillNames: ['verified-lookup'],
          evaluateStopCondition: () => ({ status: 'verified' as const, reason: 'ok', outstanding: [] }),
        }] as never,
        allowedStrategyNames: ['verified-factual-lookup'],
      },
      selectedSkill: skill.identity, invocation,
    });
    expect(context.systemPrompt).toContain('query-maker -> query-checker');
    expect(context.systemPrompt).toContain('web.lookup');
    expect(context.systemPrompt).toContain(skill.identity.contentHash);
  });

  it('rejects a checker task with undeclared fields instead of forwarding it', () => {
    expect(() => builder.forChecker({
      team: 'query', role: { roleName: 'query-checker', roleVersion: 1 },
      selectedSkill: skill.identity,
      verificationTask: { ...makeVerificationTask(skill.identity), parentConversation: ['secret'] } as never,
    })).toThrow();
  });
});
