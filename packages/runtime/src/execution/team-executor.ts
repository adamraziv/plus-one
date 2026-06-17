import {
  CheckerVerdictSchemaV1, MakerArtifactSchemaV1, MakerInvocationSchemaV1,
  PlusOneError, TeamResultStatusSchemaV1, VerificationTaskSchemaV1,
  type ArtifactEnvelopeV1, type CheckerVerdictV1, type JsonValue,
  type MakerArtifactV1, type SkillIdentityV1, type StopConditionV1,
} from '@plus-one/contracts';
import { z } from 'zod';
import type { AgentInvocationRunner } from './agent-invocation-runner.js';
import type { RoleContextBuilder } from '../context/role-context-builder.js';
import type { RuntimePolicyRegistry } from '../runtime-policy.js';
import type { VerificationRuntime } from '../verification-runtime.js';
import {
  assertMakerOutputSchemaIdentity, type CheckedWorkCellResult, type WorkCellDefinition,
} from '../teams/definitions.js';

export interface TeamExecutionIdGenerator {
  nextArtifactId(): string;
}

export class TeamExecutor {
  constructor(private readonly dependencies: {
    runtime: VerificationRuntime;
    runner: AgentInvocationRunner;
    contexts: RoleContextBuilder;
    policies: RuntimePolicyRegistry;
    ids: TeamExecutionIdGenerator;
  }) {}

  async executeWorkCell(input: {
    householdId: string;
    taskId: string;
    parentTaskId?: string;
    team: string;
    workCell: WorkCellDefinition;
    selectedSkill: SkillIdentityV1;
    makerInput: JsonValue;
    permittedEvidence: readonly ArtifactEnvelopeV1[];
    policyLabels: readonly string[];
    stopCondition: StopConditionV1;
    strategyName: string;
    abortSignal: AbortSignal;
  }): Promise<CheckedWorkCellResult> {
    if (!input.workCell.allowedSkillNames.includes(input.selectedSkill.skillName)) {
      throw new PlusOneError({ category: 'policy_rejected', code: 'work_cell_skill_not_allowed',
        message: 'Selected skill is not allowed by the work cell', retry: 'never',
        receiptLookupRequired: false, details: { workCellId: input.workCell.workCellId } });
    }
    const makerPolicy = this.dependencies.policies.resolve(input.workCell.maker.runtimePolicy);
    const checkerPolicy = this.dependencies.policies.resolve(input.workCell.checker.runtimePolicy);
    const attemptLimit = Math.min(makerPolicy.maxAttempts, checkerPolicy.maxAttempts);
    const deadlineAt = new Date(Date.now()
      + Math.min(makerPolicy.teamDeadlineMs, checkerPolicy.teamDeadlineMs)).toISOString();
    const teamAbortSignal = AbortSignal.any([
      input.abortSignal,
      AbortSignal.timeout(Math.min(makerPolicy.teamDeadlineMs, checkerPolicy.teamDeadlineMs)),
    ]);
    input.workCell.makerInputSchema.parse(input.makerInput);
    await this.dependencies.runtime.createTask({
      householdId: input.householdId, taskId: input.taskId,
      team: input.team, attemptLimit, deadlineAt,
      ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
    });
    await this.dependencies.runtime.selectContract({
      householdId: input.householdId, taskId: input.taskId,
      skill: input.selectedSkill, inputSchema: input.workCell.inputSchemaIdentity,
      outputSchema: input.workCell.outputSchemaIdentity, policy: makerPolicy.identity,
    });

    const makerArtifacts: ArtifactEnvelopeV1[] = [];
    const checkerVerdicts: CheckerVerdictV1[] = [];
    let makerOrdinal = 0;
    let checkerOrdinal = 0;
    let firstRound = true;

    while (makerOrdinal < attemptLimit) {
      if (firstRound) {
        await this.dependencies.runtime.beginMaker(input);
        firstRound = false;
      }
      makerOrdinal += 1;
      let makerOutput: MakerArtifactV1;
      try {
        const invocation = MakerInvocationSchemaV1.parse({
          schemaName: 'maker-invocation', schemaVersion: 1,
          householdId: input.householdId, taskId: input.taskId, team: input.team,
          role: input.workCell.maker.identity, skill: input.selectedSkill,
          inputSchema: input.workCell.inputSchemaIdentity,
          outputSchema: input.workCell.outputSchemaIdentity,
          input: input.makerInput, permittedEvidence: input.permittedEvidence,
          policyLabels: input.policyLabels, stopCondition: input.stopCondition,
        });
        makerOutput = await this.dependencies.runner.run({
          householdId: input.householdId, taskId: input.taskId, role: input.workCell.maker,
          attemptOrdinal: makerOrdinal,
          context: this.dependencies.contexts.forMaker({
            team: input.team, role: input.workCell.maker.identity,
            selectedSkill: input.selectedSkill, invocation,
          }),
          outputSchema: MakerArtifactSchemaV1, abortSignal: teamAbortSignal,
        });
        assertMakerOutputSchemaIdentity(makerOutput.outputSchema,
          input.workCell.outputSchemaIdentity);
        input.workCell.makerOutputSchema.parse(makerOutput.output);
      } catch (error) {
        if (error instanceof PlusOneError && error.code === 'agent_call_cancelled') {
          await this.dependencies.runtime.fail({ householdId: input.householdId, taskId: input.taskId,
            expectedFrom: 'maker_running', failureCategory: 'cancelled', resumable: false });
          throw error;
        }
        if (makerOrdinal < attemptLimit) continue;
        await this.dependencies.runtime.fail({ householdId: input.householdId, taskId: input.taskId,
          expectedFrom: 'maker_running', failureCategory: 'runtime_failure', resumable: false });
        throw error;
      }

      const makerArtifact = await this.dependencies.runtime.validateMaker({
        householdId: input.householdId, taskId: input.taskId,
        artifactId: this.dependencies.ids.nextArtifactId(),
        schema: { schemaName: 'maker-artifact', schemaVersion: 1 }, payload: makerOutput,
      });
      makerArtifacts.push(makerArtifact);
      await this.dependencies.runtime.beginChecker(input);

      let verdict: CheckerVerdictV1 | undefined;
      while (checkerOrdinal < attemptLimit && verdict === undefined) {
        checkerOrdinal += 1;
        const verificationTask = VerificationTaskSchemaV1.parse({
          schemaName: 'verification-task', schemaVersion: 1,
          householdId: input.householdId, taskId: input.taskId,
          checkerRole: input.workCell.checker.identity, makerArtifact,
          permittedEvidence: input.permittedEvidence, selectedSkill: input.selectedSkill,
          rubric: input.workCell.checkerRubric, policyLabels: input.policyLabels,
          requiredOutputSchema: { schemaName: 'checker-verdict', schemaVersion: 1 },
        });
        try {
          verdict = await this.dependencies.runner.run({
            householdId: input.householdId, taskId: input.taskId, role: input.workCell.checker,
            attemptOrdinal: checkerOrdinal,
            context: this.dependencies.contexts.forChecker({
              team: input.team, role: input.workCell.checker.identity,
              selectedSkill: input.selectedSkill, verificationTask,
            }),
            outputSchema: CheckerVerdictSchemaV1, abortSignal: teamAbortSignal,
          });
        } catch (error) {
          if (error instanceof PlusOneError && error.code === 'agent_call_cancelled') {
            await this.dependencies.runtime.fail({ householdId: input.householdId, taskId: input.taskId,
              expectedFrom: 'checker_running', failureCategory: 'cancelled', resumable: false });
            throw error;
          }
          if (checkerOrdinal < attemptLimit) continue;
          await this.dependencies.runtime.fail({ householdId: input.householdId, taskId: input.taskId,
            expectedFrom: 'checker_running', failureCategory: 'runtime_failure', resumable: false });
          throw error;
        }
      }
      if (verdict === undefined) throw new Error('Checker attempt accounting failed');
      if (verdict.coveredArtifactId !== makerArtifact.artifactId
        || verdict.coveredArtifactHash !== makerArtifact.artifactHash) {
        await this.dependencies.runtime.fail({ householdId: input.householdId, taskId: input.taskId,
          expectedFrom: 'checker_running', failureCategory: 'checker_rejected', resumable: false });
        throw new PlusOneError({ category: 'checker_rejected', code: 'checker_coverage_mismatch',
          message: 'Checker verdict does not cover the exact current maker artifact', retry: 'never',
          receiptLookupRequired: false, details: { taskId: input.taskId } });
      }
      await this.dependencies.runtime.validateChecker({
        householdId: input.householdId, taskId: input.taskId,
        checkerArtifactId: this.dependencies.ids.nextArtifactId(), verdict,
      });
      checkerVerdicts.push(verdict);

      if (verdict.verdict === 'revision_requested' && makerOrdinal < attemptLimit) {
        await this.dependencies.runtime.requestRevision(input);
        await this.dependencies.runtime.beginMaker(input);
        continue;
      }
      let terminal: { status: 'verified' | 'partial' | 'insufficient_evidence' | 'conflicted' | 'failed';
        reason: string; outstanding: string[] };
      try {
        const evaluated = verdict.verdict === 'accepted'
          ? input.workCell.evaluateStopCondition({
              condition: input.stopCondition, maker: makerOutput, verdict,
              permittedEvidence: input.permittedEvidence,
            })
          : this.terminalFor(verdict);
        terminal = {
          status: TeamResultStatusSchemaV1.parse(evaluated.status),
          reason: z.string().min(1).parse(evaluated.reason),
          outstanding: z.array(z.string().min(1)).parse(evaluated.outstanding),
        };
        if (terminal.status === 'verified' && makerOutput.claims.length === 0) {
          throw new PlusOneError({ category: 'validation_rejected', code: 'verified_stop_without_claims',
            message: 'A verified stop condition requires at least one checked claim', retry: 'never',
            receiptLookupRequired: false, details: { taskId: input.taskId } });
        }
      } catch (error) {
        await this.dependencies.runtime.complete({
          householdId: input.householdId, taskId: input.taskId, status: 'failed',
        });
        throw error;
      }
      await this.dependencies.runtime.complete({
        householdId: input.householdId, taskId: input.taskId, status: terminal.status,
      });
      return {
        householdId: input.householdId, taskId: input.taskId, team: input.team,
        workCellId: input.workCell.workCellId, status: terminal.status,
        makerArtifacts, checkerVerdicts,
        completionReason: terminal.reason, outstanding: terminal.outstanding,
        ...(verdict.verdict === 'accepted' ? { acceptedMaker: makerOutput } : {}),
      };
    }
    throw new Error('Maker attempt accounting failed');
  }

  private terminalFor(verdict: CheckerVerdictV1): {
    status: 'verified' | 'partial' | 'insufficient_evidence' | 'conflicted' | 'failed';
    reason: string; outstanding: string[];
  } {
    if (verdict.verdict === 'insufficient_evidence') {
      return { status: 'insufficient_evidence', reason: 'The checker found required evidence absent or too weak.',
        outstanding: verdict.findings.map((finding) => finding.message) };
    }
    if (verdict.verdict === 'conflicted') {
      return { status: 'conflicted', reason: 'The checker found irreconcilable checked evidence.',
        outstanding: verdict.findings.map((finding) => finding.message) };
    }
    return { status: 'failed', reason: 'The checker rejected the artifact or revision attempts were exhausted.',
      outstanding: verdict.findings.map((finding) => finding.message) };
  }
}
