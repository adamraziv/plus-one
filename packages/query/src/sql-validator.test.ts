import { describe, expect, it } from 'vitest';
import { ReadOnlySqlValidator } from './sql-validator.js';

const validator = new ReadOnlySqlValidator();
const allowedRelations = ['reporting.accounts', 'reporting.current_balances'];

describe('ReadOnlySqlValidator', () => {
  it('accepts one bounded household-scoped reporting select', () => {
    expect(validator.validate({
      sql: 'SELECT account_id FROM reporting.accounts WHERE household_id = $1 LIMIT 100',
      allowedRelations,
      maxRows: 500,
    })).toEqual({
      sql: 'SELECT account_id FROM reporting.accounts WHERE household_id = $1 LIMIT 100',
      relationNames: ['reporting.accounts'],
      limit: 100,
      parameters: ['$1'],
    });
  });

  it.each([
    ['multiple statements', 'SELECT * FROM reporting.accounts WHERE household_id = $1 LIMIT 1; SELECT 1'],
    ['insert', 'INSERT INTO reporting.accounts(account_id) VALUES ($1)'],
    ['ddl', 'DROP VIEW reporting.accounts'],
    ['mutation cte', 'WITH changed AS (DELETE FROM reporting.accounts RETURNING *) SELECT * FROM changed LIMIT 1'],
    ['unsafe function', 'SELECT pg_sleep(1) FROM reporting.accounts WHERE household_id = $1 LIMIT 1'],
    ['unlisted relation', 'SELECT * FROM accounting.accounts WHERE household_id = $1 LIMIT 1'],
    ['missing limit', 'SELECT * FROM reporting.accounts WHERE household_id = $1'],
    ['excessive limit', 'SELECT * FROM reporting.accounts WHERE household_id = $1 LIMIT 501'],
    ['missing household filter', 'SELECT * FROM reporting.accounts LIMIT 10'],
  ])('rejects %s', (_name, sql) => {
    expect(() => validator.validate({ sql, allowedRelations, maxRows: 500 }))
      .toThrow(/Query SQL was rejected/);
  });
});
