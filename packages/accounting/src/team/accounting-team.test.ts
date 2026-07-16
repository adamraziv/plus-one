import { describe, expect, it, vi } from 'vitest';
import {
  AgentRegistry, SkillRegistry, ToolPermissionRegistry,
} from '@plus-one/runtime';
import { ArtifactIdSchema } from '@plus-one/contracts';
import {
  accountingRoles, accountingSkills, accountingToolPermissions,
  createAccountingRuntimePolicies, registerAccountingAgents,
  accountingTeamDefinition, validateAccountingLeadPlan,
} from '../index.js';

describe('Accounting Team registrations', () => {
  it('registers immutable skills and gives every accounting role zero tools', () => {
    const skills = new SkillRegistry(accountingSkills);
    for (const skill of accountingSkills) {
      expect(skills.resolve(skill.identity).identity.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
    const tools = new ToolPermissionRegistry(accountingToolPermissions);
    for (const role of accountingRoles) {
      expect(tools.resolve({
        team: 'accounting', roleName: role.identity.roleName, roleVersion: role.identity.roleVersion,
      })).toEqual([]);
    }
  });

  it('registers checkers without memory and bounded structured-output policies', () => {
    const registry = new AgentRegistry();
    const agent = { generate: vi.fn() } as never;
    registerAccountingAgents(registry, {
      models: { lead: 'provider/lead', maker: 'provider/maker', checker: 'provider/checker' },
      agents: Object.fromEntries(accountingRoles.map((role) => [role.agentId, agent])),
    });
    for (const role of accountingRoles) {
      const modelId = role.kind === 'lead' ? 'provider/lead'
        : role.kind === 'maker' ? 'provider/maker' : 'provider/checker';
      expect(registry.resolve(role.agentId, modelId, role.kind).memoryEnabled).toBe(false);
    }
    const policies = createAccountingRuntimePolicies({
      leadModel: 'provider/lead', makerModel: 'provider/maker', checkerModel: 'provider/checker',
    });
    expect(policies.every((policy) => policy.maxAttempts <= 2 && policy.maxToolConcurrency === 1))
      .toBe(true);
  });

  it('contains exactly the five Plan 07 work cells with isolated makers and checkers', () => {
    expect(accountingTeamDefinition.workCells.map((cell) => cell.workCellId)).toEqual([
      'transaction-capture', 'ingestion', 'journal', 'chart-of-accounts', 'reconciliation',
    ]);
    expect(new Set(accountingTeamDefinition.workCells.flatMap((cell) => [
      cell.maker.agentId, cell.checker.agentId,
    ])).size).toBe(10);
  });

  it('routes one typed intent to one allowed cell and rejects lead drift', () => {
    expect(validateAccountingLeadPlan({ intent: 'chart_of_accounts' }, {
      schemaName: 'team-lead-plan', schemaVersion: 1,
      recommendedStrategyName: 'single-maker-checker',
      work: [{ workCellId: 'chart-of-accounts', makerInput: {} }],
      stopCondition: { code: 'checked-chart-change', description: 'Return one checked chart change.' },
    }).work[0]!.workCellId).toBe('chart-of-accounts');
    expect(validateAccountingLeadPlan({ intent: 'ingestion' }, {
      schemaName: 'team-lead-plan', schemaVersion: 1,
      recommendedStrategyName: 'single-maker-checker',
      work: [{ workCellId: 'ingestion', makerInput: {} }],
      stopCondition: { code: 'checked-ingestion', description: 'Return one checked import proposal.' },
    }).work[0]!.workCellId).toBe('ingestion');
    expect(validateAccountingLeadPlan({ intent: 'reconciliation' }, {
      schemaName: 'team-lead-plan', schemaVersion: 1,
      recommendedStrategyName: 'single-maker-checker',
      work: [{ workCellId: 'reconciliation', makerInput: {} }],
      stopCondition: { code: 'checked-reconciliation', description: 'Return one checked reconciliation proposal.' },
    }).work[0]!.workCellId).toBe('reconciliation');
    expect(() => validateAccountingLeadPlan({ intent: 'ingestion' }, {
      schemaName: 'team-lead-plan', schemaVersion: 1,
      recommendedStrategyName: 'single-maker-checker',
      work: [{ workCellId: 'journal', makerInput: {} }],
      stopCondition: { code: 'wrong', description: 'Wrong.' },
    })).toThrow();
    expect(() => validateAccountingLeadPlan({ intent: 'transaction_capture' }, {
      schemaName: 'team-lead-plan', schemaVersion: 1,
      recommendedStrategyName: 'parallel-independent-makers', work: [],
      stopCondition: { code: 'wrong', description: 'Wrong.' },
    })).toThrow();
  });

  it('marks checked clarification non-successful and checked proposals verified', () => {
    const cell = accountingTeamDefinition.workCells[0]!;
    const accepted = {
      verdict: 'accepted' as const,
      coveredArtifactId: ArtifactIdSchema.parse('artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K'),
      coveredArtifactHash: 'a'.repeat(64),
      findings: [],
    };
    const clarification = {
      schemaName: 'accounting-clarification' as const, schemaVersion: 1 as const,
      missingFields: ['payment_account'] as ['payment_account'],
      questions: ['Which account?'],
      reason: 'Required.',
    };
    const result = cell.evaluateStopCondition({
      condition: { code: 'capture', description: 'Capture.' },
      maker: {
        schemaName: 'maker-artifact' as const, schemaVersion: 1 as const,
        outputSchema: { schemaName: 'accounting-work-result', schemaVersion: 1 },
        output: clarification,
        claims: [{ claimId: 'clarify', text: 'Payment account is unresolved.', evidenceArtifactIds: [] }],
        assumptions: [],
        uncertainty: [],
      },
      verdict: accepted,
      permittedEvidence: [],
    });
    expect(result.status).toBe('insufficient_evidence');
  });

  it('marks a checked chart clarification as insufficient evidence', () => {
    const cell = accountingTeamDefinition.workCells.find((candidate) => candidate.workCellId === 'chart-of-accounts')!;
    const result = cell.evaluateStopCondition({
      condition: { code: 'chart', description: 'Return a checked chart result.' },
      maker: {
        schemaName: 'maker-artifact', schemaVersion: 1,
        outputSchema: { schemaName: 'chart-work-result', schemaVersion: 1 },
        output: {
          schemaName: 'chart-clarification', schemaVersion: 1,
          missingFields: ['name'],
          questions: ['What should the account be called?'],
          reason: 'A safe proposal needs an account name.',
        },
        claims: [{ claimId: 'clarify-chart', text: 'The chart name is unresolved.', evidenceArtifactIds: [] }],
        assumptions: [],
        uncertainty: [],
      },
      verdict: {
        verdict: 'accepted',
        coveredArtifactId: ArtifactIdSchema.parse('artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K'),
        coveredArtifactHash: 'a'.repeat(64),
        findings: [],
      },
      permittedEvidence: [],
    });

    expect(cell.outputSchemaIdentity).toEqual({ schemaName: 'chart-work-result', schemaVersion: 1 });
    expect(result).toMatchObject({
      status: 'insufficient_evidence',
      outstanding: ['What should the account be called?'],
    });
  });

  it('prohibits database access and disallows multi-cell strategies', () => {
    expect(accountingTeamDefinition.prohibitedBehavior).toEqual(expect.arrayContaining([
      expect.stringMatching(/SQL|database credentials/),
      expect.stringMatching(/confirmation/),
    ]));
    expect(accountingTeamDefinition.allowedStrategyNames).toEqual(['single-maker-checker']);
    expect(accountingToolPermissions.every((entry) => entry.toolIds.length === 0)).toBe(true);
  });
});
