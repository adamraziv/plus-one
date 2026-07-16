import {
  ChartOfAccountsProposalSchemaV1,
  type ChartOfAccountsProposalV1,
  type ChartWorkRequestV1,
} from '@plus-one/accounting';

export function deterministicChartProposal(
  request: ChartWorkRequestV1,
): ChartOfAccountsProposalV1 | undefined {
  const base = {
    schemaName: 'chart-of-accounts-proposal' as const,
    schemaVersion: 1 as const,
    householdId: request.householdId,
    bookId: request.bookId,
    accountId: request.accountId,
  };

  if (request.action === 'create_account' || request.action === 'update_account') {
    const { name, accountingClass, normalBalance, nativeCurrency } = request.known;
    if (name === undefined
      || accountingClass === undefined
      || normalBalance === undefined
      || nativeCurrency === undefined) {
      return undefined;
    }
    return ChartOfAccountsProposalSchemaV1.parse({
      ...base,
      action: request.action,
      name,
      accountingClass,
      normalBalance,
      nativeCurrency,
      ...(request.known.parentAccountId === undefined
        ? {}
        : { parentAccountId: request.known.parentAccountId }),
      ...(request.known.purpose === undefined ? {} : { purpose: request.known.purpose }),
      ...(request.known.ownershipLabel === undefined
        ? {}
        : { ownershipLabel: request.known.ownershipLabel }),
    });
  }

  if (request.action === 'archive_account') {
    return ChartOfAccountsProposalSchemaV1.parse({
      ...base,
      action: request.action,
    });
  }

  const { sourceSystem, externalAccountId } = request.known;
  if (sourceSystem === undefined || externalAccountId === undefined) return undefined;
  return ChartOfAccountsProposalSchemaV1.parse({
    ...base,
    action: request.action,
    mappingId: request.mappingId,
    ...(request.action === 'replace_source_mapping'
      ? { archivedMappingId: request.archivedMappingId }
      : {}),
    sourceSystem,
    externalAccountId,
    metadata: {},
  });
}
