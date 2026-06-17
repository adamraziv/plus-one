import { describe, expect, it } from 'vitest';
import { assertMakerOutputSchemaIdentity } from './definitions.js';

describe('maker output schema identity', () => {
  it('rejects a maker-declared schema that differs from the selected work-cell contract', () => {
    expect(() => assertMakerOutputSchemaIdentity(
      { schemaName: 'post-journal-proposal', schemaVersion: 1 },
      { schemaName: 'accounting-work-result', schemaVersion: 1 },
    )).toThrowError(/schema identity/);
  });
});
