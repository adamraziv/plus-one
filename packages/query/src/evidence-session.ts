import { z } from 'zod';
import { Pool, type PoolClient } from 'pg';
import {
  EvidencePackageAnalystSectionSchemaV1,
  EvidencePackageSchemaV1,
  QueryResultSchemaV1,
  type EvidencePackageV1,
  type EvidencePackageAnalystSectionV1,
  type EvidenceRequestV1,
  type QueryResultV1,
  type QuerySpecificationV1,
} from '@plus-one/contracts';
import { PlusOneError } from '@plus-one/contracts';
import type { QueryToolRegistry } from './query-tool-registry.js';
import type { ReadOnlySqlValidator } from './sql-validator.js';

export interface QueryRunner {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: readonly R[]; fields?: readonly { name: string }[] }>;
  release?(): void;
}

export interface EvidenceSessionConfig {
  allowedRelations: readonly string[];
  maxRows: number;
  maxOutputBytes: number;
  statementTimeoutMs: number;
  validator: ReadOnlySqlValidator;
}

export interface EvidencePackageInput {
  request: EvidenceRequestV1;
  querySpecification: QuerySpecificationV1;
  analyst?: EvidencePackageAnalystSectionV1;
}

export class EvidenceSession {
  constructor(
    private readonly runner: QueryRunner,
    private readonly config: EvidenceSessionConfig,
    private readonly tools: QueryToolRegistry,
  ) {}

  async open(): Promise<EvidenceHandle> {
    await this.runner.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await this.runner.query(`SET LOCAL statement_timeout = ${this.config.statementTimeoutMs}`);
    return new EvidenceHandle(this.runner, this.config, this.tools);
  }

  async withSession<T>(work: (handle: EvidenceHandle) => Promise<T>): Promise<T> {
    const handle = await this.open();
    try {
      const result = await work(handle);
      await this.runner.query('COMMIT');
      return result;
    } catch (error) {
      await this.runner.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
}

export class EvidenceHandle {
  constructor(
    private readonly runner: QueryRunner,
    private readonly config: EvidenceSessionConfig,
    private readonly tools: QueryToolRegistry,
  ) {}

  async runTool(toolName: string, parameters: readonly unknown[]): Promise<QueryResultV1> {
    const tool = this.tools.get(toolName);
    if (tool.parameters.length !== parameters.length) {
      throw new PlusOneError({
        category: 'validation_rejected',
        code: 'query_tool_arity_mismatch',
        message: `Tool ${toolName} expects ${tool.parameters.length} parameters, received ${parameters.length}`,
        retry: 'never',
        receiptLookupRequired: false,
        details: { toolName, expected: tool.parameters.length, received: parameters.length },
      });
    }
    return this.runSql(
      tool.relationNames[0]!,
      tool.sql,
      tool.limit,
      parameters,
      tool.description,
      sourceReferencesForToolCall(tool.relationNames[0]!, parameters),
    );
  }

  async runFlexibleQuery(spec: QuerySpecificationV1): Promise<QueryResultV1> {
    const validated = this.config.validator.validate({
      sql: spec.sql,
      allowedRelations: this.config.allowedRelations,
      maxRows: this.config.maxRows,
    });
    if (validated.relationNames.length !== 1) {
      throw new PlusOneError({
        category: 'policy_rejected',
        code: 'query_flexible_single_relation_required',
        message: 'Flexible query must target exactly one reporting relation',
        retry: 'never',
        receiptLookupRequired: false,
        details: { relationCount: validated.relationNames.length },
      });
    }
    return this.runSql(validated.relationNames[0]!, validated.sql, validated.limit,
      [], 'flexible query');
  }

  async buildEvidencePackage(input: EvidencePackageInput): Promise<EvidencePackageV1> {
    const result = await this.runFlexibleQuery(input.querySpecification);
    if (input.request.requiredCalculations.length > 0 && input.analyst === undefined) {
      throw new PlusOneError({
        category: 'validation_rejected',
        code: 'analyst_outputs_required',
        message: 'Evidence packages with required calculations must include analyst outputs',
        retry: 'never',
        receiptLookupRequired: false,
        details: { requiredCalculations: input.request.requiredCalculations.length },
      });
    }
    const interpretation = `Interpreted evidence request for ${input.request.intendedUse}.`;
    const analyst = input.analyst === undefined
      ? undefined
      : EvidencePackageAnalystSectionSchemaV1.parse(input.analyst);
    return EvidencePackageSchemaV1.parse({
      schemaName: 'evidence-package',
      schemaVersion: 1,
      evidencePackageId: input.request.requestId,
      householdId: input.request.householdId,
      request: input.request,
      status: 'verified',
      requestInterpretation: interpretation,
      dataScope: [`relation=${result.relationName}`],
      grain: input.request.desiredGrain,
      filters: input.querySpecification.filters,
      queryResults: [result],
      assumptions: ['Reporting rows are projections of authoritative ledger facts.'],
      uncertainty: result.coverageWarnings,
      queryMakerArtifactId: 'artifact_00000000000000000000000000',
      queryCheckerArtifactId: 'artifact_00000000000000000000000000',
      queryCheckerOutput: {
        schemaName: 'query-checker-output',
        schemaVersion: 1,
        accepted: true,
        checkedQueryResultArtifactId: 'artifact_00000000000000000000000000',
        findings: [],
      },
      analyst,
      stopCondition: 'verified',
      completionReason: 'Reporting query executed under repeatable-read read-only evidence session.',
    });
  }

  private async runSql(
    relationName: string,
    sql: string,
    limit: number,
    parameters: readonly unknown[],
    description: string,
    sourceReferences: readonly string[] = [`relation=${relationName}`],
  ): Promise<QueryResultV1> {
    const response = await this.runner.query<Record<string, unknown>>(sql, parameters);
    if (response.rows.length > limit) {
      throw new PlusOneError({
        category: 'policy_rejected',
        code: 'query_row_limit_exceeded',
        message: `Query ${description} returned ${response.rows.length} rows, limit ${limit}`,
        retry: 'never',
        receiptLookupRequired: false,
        details: { rowCount: response.rows.length, limit },
      });
    }
    const fields = response.fields?.map((field) => field.name).sort()
      ?? (response.rows[0] === undefined ? [] : Object.keys(response.rows[0]).sort());
    const grain = grainForRelation(relationName);
    const serialized = JSON.stringify(response.rows);
    if (serialized.length > this.config.maxOutputBytes) {
      throw new PlusOneError({
        category: 'policy_rejected',
        code: 'query_output_size_exceeded',
        message: `Query ${description} serialized output ${serialized.length} bytes exceeds ${this.config.maxOutputBytes}`,
        retry: 'never',
        receiptLookupRequired: false,
        details: { bytes: serialized.length, maxOutputBytes: this.config.maxOutputBytes },
      });
    }
    return QueryResultSchemaV1.parse({
      schemaName: 'query-result',
      schemaVersion: 1,
      relationName,
      grain,
      rows: response.rows,
      fieldDefinitions: fields,
      sourceReferences,
      freshness: 'latest available reporting projection',
      coverageWarnings: [],
    });
  }
}

function sourceReferencesForToolCall(
  relationName: string,
  parameters: readonly unknown[],
): readonly string[] {
  const references = [`relation=${relationName}`];
  const householdId = parameters[0];
  if (typeof householdId === 'string' && householdId.startsWith('hh_')) {
    references.push(`filter=household_id:eq:${householdId}`);
  }
  return references;
}

function grainForRelation(relationName: string): string[] {
  return {
    'reporting.accounts': ['household', 'account'],
    'reporting.current_balances': ['household', 'account'],
    'reporting.account_daily_balances': ['household', 'account', 'date'],
    'reporting.household_net_worth_daily': ['household', 'date'],
    'reporting.journal_activity': ['household', 'journal'],
    'reporting.categorized_transactions': ['household', 'account', 'journal'],
    'reporting.cash_flow_monthly': ['household', 'month', 'accounting class', 'currency'],
    'reporting.obligation_occurrences': ['household', 'obligation occurrence'],
    'reporting.budget_variance': ['household', 'budget category', 'period'],
    'reporting.savings_goal_progress': ['household', 'savings goal'],
    'reporting.debt_progress': ['household', 'debt plan'],
    'reporting.reconciliation_status': ['household', 'statement snapshot'],
    'reporting.source_freshness': ['household', 'source system'],
  }[relationName] ?? ['household', relationName.replace(/^reporting\./, '')];
}

const PoolLikeClientSchema = z.object({
  query: z.function(),
});

export function pgRunner(pool: Pick<Pool, 'connect'>): QueryRunner {
  let client: PoolClient | undefined;
  const acquire = async (): Promise<PoolClient> => {
    if (client === undefined) client = await pool.connect();
    return client;
  };
  return {
    async query<R extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<{ rows: readonly R[]; fields?: readonly { name: string }[] }> {
      const connection = await acquire();
      const response = await connection.query<R>(text, values as unknown[] | undefined);
      return { rows: response.rows, fields: response.fields.map((field) => ({ name: field.name })) };
    },
    release(): void {
      if (client !== undefined) {
        client.release();
        client = undefined;
      }
    },
  };
}

export function ensurePgRunner(value: unknown): QueryRunner {
  const candidate = PoolLikeClientSchema.safeParse(value);
  if (candidate.success) return value as QueryRunner;
  throw new PlusOneError({
    category: 'validation_rejected',
    code: 'query_runner_invalid',
    message: 'Evidence session requires a pg-compatible client',
    retry: 'never',
    receiptLookupRequired: false,
  });
}

export type { QuerySpecificationV1, EvidencePackageV1 };
