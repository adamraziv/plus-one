import type { PoolClient } from 'pg';
import type { DomainReadbackOutput, MutationCommandHandler } from '@plus-one/mutations';
import { canonicalizeJson } from '@plus-one/runtime';
import {
  ChartOfAccountsProposalSchemaV1,
  type ChartOfAccountsProposalV1,
} from '../team/contracts.js';
import { AccountingRepository } from '../repositories/accounting-repository.js';

export function createChartOfAccountsMutationHandler(
  repository: Pick<AccountingRepository,
    'createAccount' | 'updateAccount' | 'archiveAccount'
    | 'createAccountSourceMapping' | 'archiveAccountSourceMapping'> = new AccountingRepository(),
): MutationCommandHandler<ChartOfAccountsProposalV1> {
  return {
    commandType: 'apply_chart_of_accounts_change',
    domainRole: 'accounting',
    inputSchema: ChartOfAccountsProposalSchemaV1,
    inputSchemaIdentity: { schemaName: 'chart-of-accounts-proposal', schemaVersion: 1 },
    confirmation: 'required',
    requiredReadbackChecks: ['identifiers', 'row_values', 'artifact_links', 'idempotency_receipt'],
    async execute(client: PoolClient, candidate: ChartOfAccountsProposalV1) {
      const input = ChartOfAccountsProposalSchemaV1.parse(candidate);
      if (input.action === 'create_account') {
        await repository.createAccount(client, accountWriteInput(input));
      } else if (input.action === 'update_account') {
        await repository.updateAccount(client, accountWriteInput(input));
      } else if (input.action === 'archive_account') {
        await repository.archiveAccount(client, input.householdId, input.accountId);
      } else if (input.action === 'create_source_mapping') {
        await repository.createAccountSourceMapping(client, input);
      } else {
        await repository.archiveAccountSourceMapping(client, {
          householdId: input.householdId, mappingId: input.archivedMappingId,
        });
        await repository.createAccountSourceMapping(client, input);
      }
      const committedRecords = input.action === 'replace_source_mapping'
        ? [
            { recordType: 'accounting.account_source_mapping', recordId: input.archivedMappingId },
            { recordType: 'accounting.account_source_mapping', recordId: input.mappingId },
          ]
        : input.action === 'archive_account'
          ? [{ recordType: 'accounting.account', recordId: input.accountId }]
          : 'mappingId' in input
            ? [{ recordType: 'accounting.account_source_mapping', recordId: input.mappingId }]
            : [{ recordType: 'accounting.account', recordId: input.accountId }];
      return {
        committedRecords,
        expectedState: JSON.parse(JSON.stringify(input)),
      };
    },
    async readback(client: PoolClient, _input: ChartOfAccountsProposalV1, receipt): Promise<DomainReadbackOutput> {
      const expected = ChartOfAccountsProposalSchemaV1.parse(receipt.expectedState);
      const mapping = 'mappingId' in expected;
      const result = mapping
        ? await client.query<{
            mapping_id: string; account_id: string; source_system: string;
            external_account_id: string; metadata: unknown; archived: boolean;
          }>(
            `SELECT mapping.mapping_id, account.account_id,
              mapping.source_system, mapping.external_account_id, mapping.metadata,
              mapping.archived_at IS NOT NULL AS archived
             FROM accounting.account_source_mappings mapping
             JOIN accounting.accounts account ON account.id = mapping.account_id
             JOIN operations.households household ON household.id = mapping.household_id
             WHERE household.household_id = $1 AND mapping.mapping_id = $2`,
            [expected.householdId, expected.mappingId])
        : await client.query<{
            account_id: string; name: string; purpose: string | null; accounting_class: string;
            normal_balance: string; native_currency: string; ownership_label: string | null;
            parent_account_id: string | null; archived: boolean;
          }>(
            `SELECT account.account_id, account.name, account.purpose,
              account.accounting_class, account.normal_balance, account.native_currency,
              account.ownership_label, parent.account_id AS parent_account_id,
              account.archived_at IS NOT NULL AS archived
             FROM accounting.accounts account
             LEFT JOIN accounting.accounts parent ON parent.id = account.parent_account_id
             JOIN operations.households household ON household.id = account.household_id
             WHERE household.household_id = $1 AND account.account_id = $2`,
            [expected.householdId, expected.accountId]);
      const observed = result.rows[0];
      const archivedMapping = expected.action === 'replace_source_mapping'
        ? await client.query<{ archived: boolean }>(
            `SELECT archived_at IS NOT NULL AS archived
             FROM accounting.account_source_mappings mapping
             JOIN operations.households household ON household.id = mapping.household_id
             WHERE household.household_id = $1 AND mapping.mapping_id = $2`,
            [expected.householdId, expected.archivedMappingId])
        : undefined;
      const missing = observed === undefined;
      const archivedExpected = expected.action === 'archive_account';
      const activeAccountExpected = expected.action === 'create_account'
        || expected.action === 'update_account';
      const rowMismatch = !missing && (mapping
        ? (() => {
          const row = observed as Extract<typeof observed, { source_system: string }>;
          return row.account_id !== expected.accountId
            || row.source_system !== expected.sourceSystem
            || row.external_account_id !== expected.externalAccountId
            || canonicalizeJson(row.metadata as never) !== canonicalizeJson(expected.metadata as never)
            || row.archived !== false
            || (expected.action === 'replace_source_mapping'
              && archivedMapping?.rows[0]?.archived !== true);
        })()
        : (() => {
          const row = observed as Extract<typeof observed, { name: string }>;
          return row.account_id !== expected.accountId
            || ('name' in expected && (row.name !== expected.name
              || row.purpose !== (expected.purpose ?? null)
              || row.accounting_class !== expected.accountingClass
              || row.normal_balance !== expected.normalBalance
              || row.native_currency !== expected.nativeCurrency
              || row.ownership_label !== (expected.ownershipLabel ?? null)
              || row.parent_account_id !== (expected.parentAccountId ?? null)))
            || (activeAccountExpected && row.archived !== false)
            || (archivedExpected && row.archived !== true);
        })());
      const mismatches = [
        ...(missing ? ['record_missing'] : []), ...(rowMismatch ? ['row_values'] : []),
      ];
      const artifactOk = receipt.checkedProposalId.length > 0
        && receipt.checkedProposalHash.length === 64;
      return {
        checks: [
          { kind: 'identifiers', status: missing ? 'failed' : 'passed',
            ...(missing ? { detailCode: 'record_missing' } : {}) },
          { kind: 'row_values', status: rowMismatch ? 'failed' : 'passed',
            ...(rowMismatch ? { detailCode: 'chart_row_mismatch' } : {}) },
          { kind: 'balances', status: 'not_applicable' },
          { kind: 'source_links', status: mapping ? 'passed' : 'not_applicable' },
          { kind: 'artifact_links', status: artifactOk ? 'passed' : 'failed',
            ...(artifactOk ? {} : { detailCode: 'receipt_artifact_missing' }) },
        ],
        mismatches,
        observedState: (observed !== undefined ? JSON.parse(JSON.stringify(observed)) : null) as never,
      };
    },
  };
}

function accountWriteInput(
  input: Extract<ChartOfAccountsProposalV1, { action: 'create_account' | 'update_account' }>,
) {
  return {
    householdId: input.householdId,
    bookId: input.bookId,
    accountId: input.accountId,
    name: input.name,
    accountingClass: input.accountingClass,
    normalBalance: input.normalBalance,
    nativeCurrency: input.nativeCurrency,
    ...(input.parentAccountId === undefined ? {} : { parentAccountId: input.parentAccountId }),
    ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
    ...(input.ownershipLabel === undefined ? {} : { ownershipLabel: input.ownershipLabel }),
  };
}
