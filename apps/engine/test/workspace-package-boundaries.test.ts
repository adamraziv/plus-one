import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('workspace package boundaries', () => {
  it('keeps mutations independent from accounting domain implementations', async () => {
    const manifest = JSON.parse(await readFile('packages/mutations/package.json', 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(manifest.dependencies).not.toHaveProperty('@plus-one/accounting');
  });
});
