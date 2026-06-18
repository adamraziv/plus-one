import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalSourceObjectStore } from './local-source-object-store.js';

describe('LocalSourceObjectStore', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('stores immutable bytes by verified sha256 and returns idempotent metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plus-one-source-'));
    roots.push(root);
    const store = new LocalSourceObjectStore(root);
    const bytes = Buffer.from('date,amount\n2026-05-01,-20\n');
    const first = await store.put(bytes, 'text/csv');
    const second = await store.put(bytes, 'text/csv');
    expect(second).toEqual(first);
    expect(await store.get(first.storageKey)).toEqual(bytes);
    expect(await readFile(join(root, first.storageKey))).toEqual(bytes);
  });

  it('rejects traversal and detects bytes whose stored hash no longer matches the key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plus-one-source-'));
    roots.push(root);
    const store = new LocalSourceObjectStore(root);
    const stored = await store.put(Buffer.from('safe'), 'text/csv');
    await writeFile(join(root, stored.storageKey), 'changed');
    await expect(store.get('../secret')).rejects.toMatchObject({ code: 'source_storage_key_invalid' });
    await expect(store.get(stored.storageKey)).rejects.toMatchObject({ code: 'source_object_hash_mismatch' });
  });
});
