import {
  PlusOneError,
  type ErrorCategoryV1,
  type RetryDirectiveV1,
} from '@plus-one/contracts';
import { ZodError, type z } from 'zod';
import type { StructuredAgentPort } from '../agents/structured-agent-port.js';
import type { ContractualRoleContext } from '../context/role-context-builder.js';
import type { VerificationLedgerPort } from '../ledger/ports.js';
import type { RuntimePolicyRegistry } from '../runtime-policy.js';
import type { AgentRoleDefinition } from '../teams/definitions.js';
import { getLogger, withLogContext } from '../logging/index.js';

export interface InvocationIdGenerator {
  nextRunId(): string;
}

type AgentLedgerPort = Pick<VerificationLedgerPort, 'startRun' | 'finishRun' | 'startAttempt' | 'finishAttempt'>;

export class AgentInvocationRunner {
  constructor(private readonly dependencies: {
    agents: StructuredAgentPort;
    policies: RuntimePolicyRegistry;
    ledger: AgentLedgerPort;
    ids: InvocationIdGenerator;
  }) {}

  async run<Output>(input: {
    householdId: string;
    taskId: string;
    role: AgentRoleDefinition;
    attemptOrdinal: number;
    context: ContractualRoleContext;
    outputSchema: z.ZodType<Output>;
    abortSignal: AbortSignal;
  }): Promise<Output> {
    const policy = this.dependencies.policies.resolve(input.role.runtimePolicy);
    if (input.attemptOrdinal < 1 || input.attemptOrdinal > policy.maxAttempts) {
      throw this.error('agent_attempt_limit_exceeded', 'Agent attempt exceeds the selected runtime policy');
    }
    const models = [policy.primaryModel, ...policy.fallbackModels];
    const modelId = models[(input.attemptOrdinal - 1) % models.length] ?? policy.primaryModel;
    const runId = this.dependencies.ids.nextRunId();
    const logger = getLogger('runtime.agent');
    const startedAt = Date.now();
    return withLogContext({
      householdId: input.householdId,
      taskId: input.taskId,
      runId,
    }, async () => {
      logger.info('agent.started', {
        fields: {
          role: input.role.identity.roleName,
          model: modelId,
          attemptOrdinal: input.attemptOrdinal,
        },
      });
      let terminalLogged = false;
      try {
        await this.dependencies.ledger.startRun({
          householdId: input.householdId, taskId: input.taskId, runId,
          role: input.role.identity.roleName, roleVersion: input.role.identity.roleVersion,
          modelId, policy,
        });
        try {
          await this.dependencies.ledger.startAttempt({
            householdId: input.householdId, taskId: input.taskId, runId,
            role: input.role.identity.roleName, ordinal: input.attemptOrdinal,
            configuredLimit: policy.maxAttempts, resumable: true,
          });
        } catch (cause) {
          await this.dependencies.ledger.finishRun(
            runId,
            'failed',
            'attempt_start_failed',
            'attempt_start_failed',
            'after_state_resolution',
          );
          const recoverable = input.attemptOrdinal < policy.maxAttempts;
          const options = {
            fields: {
              role: input.role.identity.roleName,
              model: modelId,
              attemptOrdinal: input.attemptOrdinal,
              failureCategory: 'attempt_start_failed',
              failureCode: 'attempt_start_failed',
              retryDirective: 'after_state_resolution',
              retryClassification: recoverable ? 'retryable' : 'exhausted',
              durationMs: Date.now() - startedAt,
            },
          };
          if (recoverable) logger.warn('agent.failed', options);
          else logger.error('agent.failed', options);
          terminalLogged = true;
          throw new PlusOneError({ category: 'storage_unavailable', code: 'attempt_start_failed',
            message: 'Agent attempt could not be started', retry: 'after_state_resolution',
            receiptLookupRequired: false, details: { runId }, cause });
        }

        try {
          const abortSignal = AbortSignal.any([
            input.abortSignal,
            AbortSignal.timeout(policy.callDeadlineMs),
          ]);
          const output = await this.dependencies.agents.generate({
            runId, agentId: input.role.agentId, modelId, roleKind: input.role.kind,
            ...input.context, outputSchema: input.outputSchema,
            maxSteps: policy.maxModelSteps, maxRetries: policy.maxModelRequestRetries,
            maxToolConcurrency: policy.maxToolConcurrency,
            maxProcessorRetries: policy.maxProcessorRetries,
            maxOutputBytes: policy.maxOutputBytes, abortSignal,
          });
          await this.dependencies.ledger.finishAttempt({
            householdId: input.householdId, taskId: input.taskId,
            role: input.role.identity.roleName, ordinal: input.attemptOrdinal,
            outcome: 'succeeded', resumable: false,
          });
          await this.dependencies.ledger.finishRun(runId, 'succeeded');
          logger.info('agent.completed', {
            fields: {
              role: input.role.identity.roleName,
              model: modelId,
              attemptOrdinal: input.attemptOrdinal,
              durationMs: Date.now() - startedAt,
            },
          });
          terminalLogged = true;
          return output;
        } catch (cause) {
          const failure = this.classifyFailure(cause, input.abortSignal);
          await this.dependencies.ledger.finishAttempt({
            householdId: input.householdId, taskId: input.taskId,
            role: input.role.identity.roleName, ordinal: input.attemptOrdinal,
            outcome: failure.outcome, retryCategory: failure.category,
            failureCode: failure.code, retryDirective: failure.retry,
            resumable: failure.outcome !== 'cancelled',
          });
          await this.dependencies.ledger.finishRun(
            runId,
            failure.runStatus,
            failure.category,
            failure.code,
            failure.retry,
          );
          const recoverable = failure.outcome !== 'cancelled'
            && input.attemptOrdinal < policy.maxAttempts;
          const options = {
            fields: {
              role: input.role.identity.roleName,
              model: modelId,
              attemptOrdinal: input.attemptOrdinal,
              failureCategory: failure.category,
              failureCode: failure.code,
              retryDirective: failure.retry,
              retryClassification: failure.outcome === 'cancelled'
                ? 'cancelled'
                : recoverable ? 'retryable' : 'exhausted',
              durationMs: Date.now() - startedAt,
            },
            ...(failure.category === 'model_failure' ? { error: cause } : {}),
          };
          if (recoverable) logger.warn('agent.failed', options);
          else logger.error('agent.failed', options);
          terminalLogged = true;
          throw new PlusOneError({
            category: failure.errorCategory, code: failure.code, message: failure.message,
            retry: failure.retry,
            receiptLookupRequired: false,
            details: { role: input.role.identity.roleName, attemptOrdinal: input.attemptOrdinal, modelId },
            cause,
          });
        }
      } catch (cause) {
        if (!terminalLogged) {
          logger.error('agent.failed', {
            fields: {
              role: input.role.identity.roleName,
              model: modelId,
              attemptOrdinal: input.attemptOrdinal,
              failureCategory: 'runtime_failure',
              retryClassification: 'exhausted',
              durationMs: Date.now() - startedAt,
            },
          });
        }
        throw cause;
      }
    });
  }

  private classifyFailure(cause: unknown, callerSignal: AbortSignal): {
    outcome: 'schema_failed' | 'model_failed' | 'tool_failed' | 'timed_out' | 'cancelled';
    runStatus: 'failed' | 'timed_out' | 'cancelled';
    category: string;
    errorCategory: ErrorCategoryV1;
    code: string;
    message: string;
    retry: RetryDirectiveV1;
  } {
    if (callerSignal.aborted) {
      if (callerSignal.reason instanceof DOMException && callerSignal.reason.name === 'TimeoutError') {
        return { outcome: 'timed_out', runStatus: 'timed_out', category: 'team_deadline',
          errorCategory: 'timeout', code: 'agent_call_timed_out', message: 'Agent call exceeded the team deadline',
          retry: 'after_backoff' };
      }
      return { outcome: 'cancelled', runStatus: 'cancelled',
        category: 'cancelled', errorCategory: 'runtime_failure',
        code: 'agent_call_cancelled', message: 'Agent call was cancelled', retry: 'never' };
    }
    if (cause instanceof ZodError) return { outcome: 'schema_failed', runStatus: 'failed',
      category: 'schema_validation', errorCategory: 'validation_rejected',
      code: 'agent_output_schema_failed', message: 'Agent output failed structured validation', retry: 'safe' };
    if (cause instanceof DOMException && (cause.name === 'TimeoutError' || cause.name === 'AbortError')) {
      return { outcome: 'timed_out', runStatus: 'timed_out', category: 'call_deadline',
        errorCategory: 'timeout', code: 'agent_call_timed_out', message: 'Agent call exceeded its deadline',
        retry: 'after_backoff' };
    }
    if (cause instanceof PlusOneError) {
      const outcome = cause.category === 'validation_rejected'
        ? 'schema_failed'
        : cause.code.startsWith('tool_') ? 'tool_failed' : 'model_failed';
      return {
        outcome,
        runStatus: 'failed',
        category: cause.category,
        errorCategory: cause.category,
        code: cause.code,
        message: safeFailureMessage(cause),
        retry: cause.retry,
      };
    }
    return { outcome: 'model_failed', runStatus: 'failed', category: 'model_failure',
      errorCategory: 'runtime_failure', code: 'agent_model_failed', message: 'Agent model call failed',
      retry: 'after_backoff' };
  }

  private error(code: string, message: string): PlusOneError {
    return new PlusOneError({ category: 'policy_rejected', code, message, retry: 'never',
      receiptLookupRequired: false, details: {} });
  }
}

function safeFailureMessage(error: PlusOneError): string {
  if (error.category === 'validation_rejected') return 'Agent output failed contractual validation';
  if (error.code.startsWith('tool_')) return 'Agent tool execution failed';
  return 'Agent model call failed';
}
