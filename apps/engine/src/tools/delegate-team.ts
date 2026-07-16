import { createTool, isValidationError } from '@mastra/core/tools';
import { z } from 'zod';
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
  assumptions: z.array(z.string()),
  uncertainty: z.array(z.string()),
  outstanding: z.array(z.string()),
  checkedData: z.array(z.object({
    checkedClaim: z.string(),
    rows: z.array(z.record(z.string(), UserFacingQueryValueSchema)),
  }).strict()),
}).strict();

export type FinalSynthesisTeamResultView = z.infer<typeof FinalSynthesisTeamResultViewSchema>;

const DELEGATE_TEAM_RETRY_INSTRUCTION = 'Retry delegateTeam with an exact registered team id and a JSON-object request matching that team\'s declared schema.';

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
  return FinalSynthesisTeamResultViewSchema.parse({
    schemaName: 'final-synthesis-team-result',
    schemaVersion: 1,
    team: result.team,
    status: result.status,
    checkedClaims: userFacingTexts(result.claims.map((claim) => claim.text)),
    assumptions: userFacingTexts(result.assumptions),
    uncertainty: userFacingTexts(result.uncertainty),
    outstanding: userFacingTexts(result.outstanding),
    checkedData,
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
      if (active.delegationCount !== 0) {
        active.delegationFailed = true;
        throw new Error('Only one specialist delegation is allowed per orchestrator turn.');
      }
      const context = parseDelegateTeamToolInput(inputData);
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
          request: requestForRuntime(context.request),
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
