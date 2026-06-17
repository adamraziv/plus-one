import {
  MakerInvocationSchemaV1, PlusOneError, TeamLeadInvocationSchemaV1, VerificationTaskSchemaV1,
  type MakerInvocationV1, type RoleIdentityV1, type SkillIdentityV1,
  type TeamLeadInvocationV1, type VerificationTaskV1,
} from '@plus-one/contracts';
import type { SkillRegistry } from '../skills/skill-registry.js';
import type { TeamDefinition } from '../teams/definitions.js';
import type { ToolPermissionRegistry } from '../tools/tool-permission-registry.js';

export interface ContractualRoleContext {
  systemPrompt: string;
  messages: readonly [{ role: 'user'; content: string }];
  parentMessages: readonly [];
  memoryEnabled: false;
  activeTools: readonly string[];
  toolHistory: readonly [];
}

export class RoleContextBuilder {
  constructor(private readonly dependencies: {
    skills: SkillRegistry;
    tools: ToolPermissionRegistry;
  }) {}

  forLead(input: {
    team: TeamDefinition;
    selectedSkill: SkillIdentityV1;
    invocation: TeamLeadInvocationV1;
  }): ContractualRoleContext {
    const invocation = TeamLeadInvocationSchemaV1.parse(input.invocation);
    this.assertRoleAndSkill(input.team.team, input.team.lead.identity, input.selectedSkill,
      invocation.team, invocation.role, invocation.selectedSkill);
    const workCells = input.team.workCells.map((cell) => cell.workCellId).sort();
    const strategies = [...input.team.allowedStrategyNames].sort();
    if (JSON.stringify([...invocation.availableWorkCellIds].sort()) !== JSON.stringify(workCells)
      || JSON.stringify([...invocation.availableStrategyNames].sort()) !== JSON.stringify(strategies)) {
      throw new PlusOneError({ category: 'policy_rejected', code: 'lead_catalog_mismatch',
        message: 'Lead invocation catalog does not match the registered team definition',
        retry: 'never', receiptLookupRequired: false, details: { team: input.team.team } });
    }
    const skill = this.dependencies.skills.assertAllowed(
      input.selectedSkill, input.team.team, input.team.lead.identity.roleName,
    );
    const activeTools = this.dependencies.tools.resolve({
      team: input.team.team, ...input.team.lead.identity,
    });
    const workCellLines = input.team.workCells.map((cell) =>
      cell.workCellId + ': ' + cell.maker.identity.roleName + ' -> ' + cell.checker.identity.roleName,
    );
    const makerToolIds = input.team.workCells.flatMap((cell) => {
      try {
        return [...this.dependencies.tools.resolve({ team: input.team.team, ...cell.maker.identity })];
      } catch {
        return [];
      }
    });
    return {
      systemPrompt: [
        'You are the ' + input.team.lead.identity.roleName + ' lead for team ' + input.team.team + '.',
        'Charter: ' + input.team.charter,
        'Prohibited behavior: ' + input.team.prohibitedBehavior.join('; '),
        'Allowed work cells: ' + workCellLines.join(', '),
        'Allowed strategies: ' + input.team.allowedStrategyNames.join(', '),
        'Maker tool ids: ' + makerToolIds.join(', '),
        'Selected skill: ' + skill.identity.skillName + '@' + skill.identity.skillVersion
          + ' sha256:' + skill.identity.contentHash + '.',
        'Selected skill guidance: ' + skill.content,
        'Return only the requested structured output through the configured schema.',
      ].join('\n'),
      messages: [{ role: 'user', content: JSON.stringify(invocation) }],
      parentMessages: [],
      memoryEnabled: false,
      activeTools,
      toolHistory: [],
    };
  }

  forMaker(input: {
    team: string;
    role: RoleIdentityV1;
    selectedSkill: SkillIdentityV1;
    invocation: MakerInvocationV1;
  }): ContractualRoleContext {
    const invocation = MakerInvocationSchemaV1.parse(input.invocation);
    this.assertRoleAndSkill(input.team, input.role, input.selectedSkill,
      invocation.team, invocation.role, invocation.skill);
    const skill = this.dependencies.skills.assertAllowed(input.selectedSkill, input.team, input.role.roleName);
    const activeTools = this.dependencies.tools.resolve({ team: input.team, ...input.role });
    return {
      systemPrompt: [
        'You are the ' + input.role.roleName + ' maker for team ' + input.team + '.',
        'Return only the requested structured output through the configured schema.',
        'Selected skill: ' + skill.identity.skillName + '@' + skill.identity.skillVersion
          + ' sha256:' + skill.identity.contentHash + '.',
        'Selected skill guidance: ' + skill.content,
        ...skill.makerInstructions,
        'Do not claim access to evidence or tools absent from the typed invocation.',
      ].join('\n'),
      messages: [{ role: 'user', content: JSON.stringify(invocation) }],
      parentMessages: [],
      memoryEnabled: false,
      activeTools,
      toolHistory: [],
    };
  }

  forChecker(input: {
    team: string;
    role: RoleIdentityV1;
    selectedSkill: SkillIdentityV1;
    verificationTask: VerificationTaskV1;
  }): ContractualRoleContext {
    const verificationTask = VerificationTaskSchemaV1.parse(input.verificationTask);
    this.assertRoleAndSkill(input.team, input.role, input.selectedSkill,
      input.team, verificationTask.checkerRole, verificationTask.selectedSkill);
    const skill = this.dependencies.skills.assertAllowed(input.selectedSkill, input.team, input.role.roleName);
    const activeTools = this.dependencies.tools.resolve({ team: input.team, ...input.role });
    return {
      systemPrompt: [
        'You are the independent ' + input.role.roleName + ' checker for team ' + input.team + '.',
        'Evaluate only the one typed verification task in the user message.',
        'Return only CheckerVerdictSchemaV1 through the configured structured-output boundary.',
        'Selected skill: ' + skill.identity.skillName + '@' + skill.identity.skillVersion
          + ' sha256:' + skill.identity.contentHash + '.',
        'Selected skill guidance: ' + skill.content,
        ...verificationTask.rubric.instructions,
        ...skill.checkerRubric,
        'Never infer parent conversation, maker reasoning, tool history, or unlisted evidence.',
      ].join('\n'),
      messages: [{ role: 'user', content: JSON.stringify(verificationTask) }],
      parentMessages: [],
      memoryEnabled: false,
      activeTools,
      toolHistory: [],
    };
  }

  private assertRoleAndSkill(
    expectedTeam: string, expectedRole: RoleIdentityV1, expectedSkill: SkillIdentityV1,
    actualTeam: string, actualRole: RoleIdentityV1, actualSkill: SkillIdentityV1,
  ): void {
    if (actualTeam !== expectedTeam
      || actualRole.roleName !== expectedRole.roleName
      || actualRole.roleVersion !== expectedRole.roleVersion
      || actualSkill.skillName !== expectedSkill.skillName
      || actualSkill.skillVersion !== expectedSkill.skillVersion
      || actualSkill.contentHash !== expectedSkill.contentHash) {
      throw new PlusOneError({ category: 'policy_rejected', code: 'role_context_contract_mismatch',
        message: 'Role context identity does not match the selected execution contract',
        retry: 'never', receiptLookupRequired: false, details: { team: expectedTeam } });
    }
  }
}
