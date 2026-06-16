import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('workspace package entry points', () => {
  it('provides source entry points for both foundation packages', async () => {
    await expect(access(resolve('packages/contracts/src/index.ts'))).resolves.toBeUndefined();
    await expect(access(resolve('packages/database/src/index.ts'))).resolves.toBeUndefined();
  });
});
