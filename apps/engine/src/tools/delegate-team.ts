import { createTool, isValidationError } from '@mastra/core/tools';
import { z } from 'zod';
import { ChartOfAccountsProposalSchemaV1 } from '@plus-one/accounting';
import {
  InboundChannelMessageSchemaV1,
  MakerArtifactSchemaV1,
  QueryResultSchemaV1,
  TeamResultEnvelopeSchemaV2,
  type InboundChannelMessageV1,
  type JsonValue,
  type TeamResultEnvelopeV2,
} from '@plus-one/contracts';
import { internalImplementationDetailMatchCategory, type TeamDefinition } from '@plus-one/runtime';
import { isUserFacingQueryField } from '../query-tools.js';
import { internalIdentifierMatchCategory } from '../safety/internal-identifier.js';
import { AccountingDelegateRequestSchemaV1 } from '../accounting/accounting-lead-contracts.js';
import {
  transactionCaptureContinuation,
  type TransactionCaptureContinuationV1,
} from '../accounting/transaction-capture-continuation.js';
import type { TransactionCaptureRequestDraftV1 } from '../accounting/accounting-request-drafts.js';
import {
  DelegateTeamToolInputSchema,
  parseDelegateTeamToolInput,
  requestForRuntime,
} from './delegate-team-schemas.js';

export interface OrchestratorTeamRuntime {
  runTeamLead(input: {
    message: InboundChannelMessageV1;
    team: TeamDefinition;
    request: JsonValue;
    signal: AbortSignal;
  }): Promise<TeamResultEnvelopeV2>;
  resumePendingMutation(input: {
    message: InboundChannelMessageV1;
    pending: TeamResultEnvelopeV2;
    signal: AbortSignal;
  }): Promise<TeamResultEnvelopeV2>;
  cancelPendingMutation(input: {
    pending: TeamResultEnvelopeV2;
    signal: AbortSignal;
  }): Promise<void>;
}

const UserFacingQueryValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const FinalSynthesisTeamResultViewSchema = z.object({
  schemaName: z.literal('final-synthesis-team-result'),
  schemaVersion: z.literal(1),
  team: z.string(),
  status: z.enum(['verified', 'partial', 'insufficient_evidence', 'conflicted', 'failed']),
  checkedClaims: z.array(z.string()),
  proposalFacts: z.array(z.string()),
  assumptions: z.array(z.string()),
  uncertainty: z.array(z.string()),
  outstanding: z.array(z.string()),
  checkedData: z.array(z.object({
    checkedClaim: z.string(),
    rows: z.array(z.record(z.string(), UserFacingQueryValueSchema)),
  }).strict()),
  proposedChange: z.object({
    kind: z.literal('chart_of_accounts'),
    action: z.enum(['create_account', 'update_account', 'archive_account', 'create_source_mapping', 'replace_source_mapping']),
    accountName: z.string().optional(),
    accountingClass: z.string().optional(),
    normalBalance: z.string().optional(),
    nativeCurrency: z.string().optional(),
  }).strict().optional(),
  effectState: z.enum(['none', 'awaiting_confirmation', 'unresolved', 'persisted']),
}).strict();

export type FinalSynthesisTeamResultView = z.infer<typeof FinalSynthesisTeamResultViewSchema>;

const DELEGATE_TEAM_RETRY_INSTRUCTION = 'Retry delegateTeam with an exact registered team id and a JSON-object request matching that team\'s declared schema.';
export const MAX_DELEGATIONS_PER_TURN = 4;

export const DelegateTeamRetrySignalSchema = z.object({
  schemaName: z.literal('delegate-team-retry-signal'),
  schemaVersion: z.literal(1),
  status: z.literal('retry_required'),
  instruction: z.literal(DELEGATE_TEAM_RETRY_INSTRUCTION),
}).strict();

export type DelegateTeamRetrySignal = z.infer<typeof DelegateTeamRetrySignalSchema>;

export const WITHHELD_DETAIL = 'Some checked details were withheld for privacy.';

export function finalSynthesisTeamResultView(result: TeamResultEnvelopeV2): FinalSynthesisTeamResultView {
  const acceptedArtifacts = new Map<string, TeamResultEnvelopeV2['makerArtifacts'][number]>();
  for (const artifact of result.makerArtifacts) {
    const accepted = result.checkerVerdicts.some((verdict) =>
      verdict.verdict === 'accepted'
      && verdict.coveredArtifactId === artifact.artifactId
      && verdict.coveredArtifactHash === artifact.artifactHash,
    );
    if (accepted) acceptedArtifacts.set(artifact.artifactId, artifact);
  }
  const includedArtifactIds = new Set<string>();
  const checkedData = result.claims.flatMap((claim) => {
    const checkedClaim = userFacingText(claim.text) ?? 'Checked data is available.';
    return claim.checkedMakerArtifactIds.flatMap((artifactId) => {
      if (includedArtifactIds.has(artifactId)) return [];
      const artifact = acceptedArtifacts.get(artifactId);
      if (artifact === undefined || checkedClaim === undefined) return [];
      const makerArtifact = MakerArtifactSchemaV1.safeParse(artifact.payload);
      if (!makerArtifact.success) return [];
      const queryResult = QueryResultSchemaV1.safeParse(makerArtifact.data.output);
      if (!queryResult.success) return [];
      const rows = queryResult.data.rows
        .map((row) => userFacingQueryRow(queryResult.data.relationName, row))
        .filter((row): row is Record<string, z.infer<typeof UserFacingQueryValueSchema>> => row !== undefined);
      if (rows.length === 0) return [];
      includedArtifactIds.add(artifactId);
      return [{ checkedClaim, rows }];
    });
  });
  const proposedChange = result.effect.state === 'awaiting_confirmation' || result.effect.state === 'persisted'
    ? (() => {
      const candidate = result.effect.state === 'awaiting_confirmation'
        ? result.effect.command.payload
        : (() => {
          const artifact = acceptedArtifacts.get(result.effect.proposal.artifactId);
          if (artifact === undefined) return undefined;
          const maker = MakerArtifactSchemaV1.safeParse(artifact.payload);
          return maker.success ? maker.data.output : undefined;
        })();
      const proposal = ChartOfAccountsProposalSchemaV1.safeParse(candidate);
      if (!proposal.success) return undefined;
      return {
        kind: 'chart_of_accounts' as const,
        action: proposal.data.action,
        accountName: 'name' in proposal.data ? proposal.data.name : undefined,
        accountingClass: 'accountingClass' in proposal.data ? proposal.data.accountingClass : undefined,
        normalBalance: 'normalBalance' in proposal.data ? proposal.data.normalBalance : undefined,
        nativeCurrency: 'nativeCurrency' in proposal.data ? proposal.data.nativeCurrency : undefined,
      };
    })()
    : undefined;
  return FinalSynthesisTeamResultViewSchema.parse({
    schemaName: 'final-synthesis-team-result',
    schemaVersion: 1,
    team: result.team,
    status: result.status,
    checkedClaims: result.effect.state === 'awaiting_confirmation'
      ? []
      : userFacingTexts(result.claims.map((claim) => claim.text)),
    proposalFacts: pendingProposalFacts(result),
    assumptions: userFacingTexts(result.assumptions),
    uncertainty: userFacingTexts(result.uncertainty),
    outstanding: userFacingTexts(result.outstanding),
    checkedData,
    ...(proposedChange === undefined ? {} : { proposedChange }),
    effectState: result.effect.state,
  });
}

function pendingProposalFacts(result: TeamResultEnvelopeV2): string[] {
  if (result.effect.state !== 'awaiting_confirmation') return [];
  return result.claims.flatMap((claim) => {
    const text = userFacingText(claim.text);
    if (text === undefined || /\b(created|saved|added|applied|recorded|completed|succeeded)\b/i.test(text)) {
      return [];
    }
    return [text];
  });
}

export function createDelegateTeamTool(input: {
  teams: ReadonlyMap<string, TeamDefinition>;
  teamRuntime: OrchestratorTeamRuntime;
  getActiveInvocation(): {
    message: InboundChannelMessageV1;
    signal: AbortSignal;
    delegationCount: number;
    delegationFailed: boolean;
    transactionCaptureContinuation?: TransactionCaptureContinuationV1;
  } | undefined;
}) {
  const teamCatalog = [...input.teams.values()]
    .map((team) => `${team.team}: ${team.charter}`)
    .join(' | ');
  return createTool({
    id: 'delegateTeam',
    description: [
      'Delegate one checked task to a registered specialist team lead.',
      `Registered teams for this runtime are: ${teamCatalog}.`,
      'The team field must be an exact team id.',
      'The request field must be a JSON object matching the selected team schema.',
      'You may call this tool again after receiving a checked result when the same user task requires another sequential checked substep.',
      'Call only one specialist substep at a time and use each checked result before choosing the next substep.',
      'Do not use this tool for payments, trades, tax filings, provider account changes, or external financial actions.',
    ].join(' '),
    inputSchema: DelegateTeamToolInputSchema,
    outputSchema: TeamResultEnvelopeSchemaV2,
    toModelOutput: (result: unknown) => {
      if (isValidationError(result)) {
        return {
          type: 'json',
          value: DelegateTeamRetrySignalSchema.parse({
            schemaName: 'delegate-team-retry-signal',
            schemaVersion: 1,
            status: 'retry_required',
            instruction: DELEGATE_TEAM_RETRY_INSTRUCTION,
          }),
        };
      }
      return {
        type: 'json',
        value: finalSynthesisTeamResultView(TeamResultEnvelopeSchemaV2.parse(result)),
      };
    },
    execute: async (inputData) => {
      const active = input.getActiveInvocation();
      if (active === undefined) throw new Error('No active orchestrator invocation.');
      if (active.signal.aborted) {
        throw active.signal.reason ?? new DOMException('Delegated team work aborted.', 'AbortError');
      }
      if (active.delegationCount >= MAX_DELEGATIONS_PER_TURN) {
        active.delegationFailed = true;
        throw new Error(`Specialist delegation limit of ${MAX_DELEGATIONS_PER_TURN} was exceeded.`);
      }
      const context = parseDelegateTeamToolInput(inputData);
      const request = requestWithTransactionContinuation(active, context.request);
      active.delegationCount += 1;
      const team = input.teams.get(context.team);
      if (team === undefined) throw new Error(`Unknown team: ${context.team}`);
      if (active.signal.aborted) {
        throw active.signal.reason ?? new DOMException('Delegated team work aborted.', 'AbortError');
      }
      try {
        const result = TeamResultEnvelopeSchemaV2.parse(await input.teamRuntime.runTeamLead({
          message: InboundChannelMessageSchemaV1.parse(active.message),
          team,
          request: requestForRuntime(request),
          signal: active.signal,
        }));
        return result;
      } catch (error) {
        active.delegationFailed = true;
        throw error;
      }
    },
  });
}

function requestWithTransactionContinuation(
  active: {
    transactionCaptureContinuation?: TransactionCaptureContinuationV1;
  },
  request: unknown,
): unknown {
  const parsed = AccountingDelegateRequestSchemaV1.safeParse(request);
  if (!parsed.success || parsed.data.intent !== 'transaction_capture') return request;
  const current = parsed.data.request;
  if (current.schemaName !== 'transaction-capture-request-draft') {
    delete active.transactionCaptureContinuation;
    return request;
  }
  const previous = active.transactionCaptureContinuation?.request;
  const merged: TransactionCaptureRequestDraftV1 = previous === undefined
    ? current
    : {
        ...current,
        known: { ...previous.known, ...current.known },
      };
  active.transactionCaptureContinuation = transactionCaptureContinuation(merged);
  return { ...parsed.data, request: merged };
}

export function userFacingTexts(values: readonly string[]): string[] {
  const safeValues = values.flatMap((value) => {
    const safeValue = userFacingText(value);
    return safeValue === undefined ? [] : [safeValue];
  });
  const omittedUnsafeText = safeValues.length !== values.filter((value) => value.trim().length > 0).length;
  return omittedUnsafeText ? [...safeValues, WITHHELD_DETAIL] : safeValues;
}

export function userFacingText(value: string): string | undefined {
  const text = value.trim();
  if (
    text.length === 0
    || internalIdentifierMatchCategory(text) !== undefined
    || internalImplementationDetailMatchCategory(text) !== undefined
  ) return undefined;
  return text;
}

function userFacingQueryRow(
  relationName: string,
  row: Record<string, unknown>,
): Record<string, z.infer<typeof UserFacingQueryValueSchema>> | undefined {
  const entries = Object.entries(row).flatMap(([key, value]) => {
    const userFacingField = isUserFacingQueryField(relationName, key);
    if (!userFacingField && (isInternalQueryField(key) || internalIdentifierMatchCategory(key) !== undefined)) {
      return [];
    }
    const safeValue = userFacingQueryValue(value);
    return safeValue === undefined ? [] : [[userFacingFieldLabel(key), safeValue] as const];
  });
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function userFacingFieldLabel(key: string): string {
  return key.replaceAll('_', ' ');
}

function isInternalQueryField(key: string): boolean {
  return /(?:^|_)(?:id|identifier)(?:_|$)|(?:household|book|task|artifact|hash|source|provenance|metadata)/i.test(key);
}

function userFacingQueryValue(value: unknown): z.infer<typeof UserFacingQueryValueSchema> | undefined {
  if (typeof value === 'string') return userFacingText(value) ?? WITHHELD_DETAIL;
  const parsed = UserFacingQueryValueSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
