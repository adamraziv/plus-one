import { describe, expect, it } from 'vitest';
import { accountingTeamDefinition } from '@plus-one/accounting';
import { ingestionRoles, ingestionToolPermissions } from './roles.js';
import { ingestionWorkCellDefinition, reconciliationWorkCellDefinition } from './work-cells.js';

describe('ingestion and reconciliation work cells', () => {
  it('extends Accounting Team to exactly five distinct maker/checker cells', () => {
    expect(accountingTeamDefinition.workCells.map((cell) => cell.workCellId)).toEqual([
      'transaction-capture', 'ingestion', 'journal', 'chart-of-accounts', 'reconciliation',
    ]);
    expect(new Set(ingestionRoles.map((role) => role.identity.roleName)).size).toBe(4);
  });

  it('uses exact versioned request/result identities', () => {
    expect(ingestionWorkCellDefinition.outputSchemaIdentity)
      .toEqual({ schemaName: 'ingestion-work-result', schemaVersion: 1 });
    expect(reconciliationWorkCellDefinition.outputSchemaIdentity)
      .toEqual({ schemaName: 'reconciliation-work-result', schemaVersion: 1 });
  });

  it('gives no database, query, filesystem, command, or mutation tools to agents', () => {
    expect(ingestionToolPermissions.every((entry) => entry.toolIds.length === 0)).toBe(true);
  });
});
