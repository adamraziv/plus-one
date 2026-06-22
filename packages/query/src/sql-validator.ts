import { parse, type Statement } from 'pgsql-ast-parser';
import { PlusOneError } from '@plus-one/contracts';

export interface ReadOnlySqlValidationInput {
  sql: string;
  allowedRelations: readonly string[];
  maxRows: number;
}

export interface ReadOnlySqlValidationResult {
  sql: string;
  relationNames: string[];
  limit: number;
  parameters: string[];
}

const SAFE_FUNCTIONS = new Set(['avg', 'coalesce', 'count', 'date_trunc', 'max', 'min', 'sum']);

function reject(code: string): never {
  throw new PlusOneError({
    category: 'policy_rejected',
    code,
    message: 'Query SQL was rejected',
    retry: 'never',
    receiptLookupRequired: false,
    details: { reason: code },
  });
}

function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const node = value as Record<string, unknown>;
  visit(node);
  for (const child of Object.values(node)) walk(child, visit);
}

function relationName(node: Record<string, unknown>): string | undefined {
  if (node.type !== 'table') return undefined;
  const name = node.name as Record<string, unknown> | undefined;
  if (typeof name?.name !== 'string') return undefined;
  return typeof name.schema === 'string' ? `${name.schema}.${name.name}` : name.name;
}

function integerLimit(statement: Record<string, unknown>): number {
  const limit = statement.limit as Record<string, unknown> | undefined;
  const literal = limit?.limit as Record<string, unknown> | undefined;
  if (literal?.type !== 'integer' || typeof literal.value !== 'number') reject('query_limit_required');
  return literal.value;
}

function hasHouseholdPredicate(statement: Record<string, unknown>): boolean {
  let found = false;
  walk(statement.where, (node) => {
    if (node.type === 'ref' && node.name === 'household_id') found = true;
  });
  return found;
}

export class ReadOnlySqlValidator {
  validate(input: ReadOnlySqlValidationInput): ReadOnlySqlValidationResult {
    let statements: Statement[];
    try {
      statements = parse(input.sql);
    } catch {
      reject('query_parse_failed');
    }
    if (statements.length !== 1) reject('query_single_statement_required');
    const statement = statements[0] as unknown as Record<string, unknown>;
    if (statement.type !== 'select') reject('query_select_required');

    const limit = integerLimit(statement);
    if (limit > input.maxRows) reject('query_limit_too_large');
    if (!hasHouseholdPredicate(statement)) reject('query_household_filter_required');

    const relations = new Set<string>();
    const parameters = new Set<string>();
    walk(statement, (node) => {
      const name = relationName(node);
      if (name !== undefined) relations.add(name);
      if (node.type === 'parameter' && typeof node.name === 'string') parameters.add(node.name);
      if (node.type === 'call') {
        const fn = node.function as Record<string, unknown> | undefined;
        const functionName = typeof fn?.name === 'string' ? fn.name.toLowerCase() : '';
        if (!SAFE_FUNCTIONS.has(functionName)) reject('query_function_rejected');
      }
      if (node.type === 'with') {
        const binds = node.bind as Array<Record<string, unknown>> | undefined;
        if (binds?.some((bind) => {
          const bound = bind.statement as Record<string, unknown> | undefined;
          return bound !== undefined && bound.type !== 'select';
        }) === true) reject('query_mutating_cte_rejected');
      }
    });

    const allowed = new Set(input.allowedRelations);
    for (const relation of relations) {
      if (!allowed.has(relation)) reject('query_relation_rejected');
    }
    if (relations.size === 0) reject('query_relation_required');

    return {
      sql: input.sql,
      relationNames: [...relations].sort(),
      limit,
      parameters: [...parameters].sort(),
    };
  }
}
