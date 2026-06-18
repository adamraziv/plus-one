import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { PlusOneError } from '@plus-one/contracts';
import type { SourceObjectStore, StoredSourceObject } from './source-object-store.js';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export class LocalSourceObjectStore implements SourceObjectStore {
  constructor(private readonly root: string) {}

  async put(bytes: Uint8Array, mediaType: StoredSourceObject['mediaType']): Promise<StoredSourceObject> {
    const contentHash = sha256(bytes);
    const storageKey = `sha256/${contentHash.slice(0, 2)}/${contentHash}`;
    const target = this.resolveKey(storageKey);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, target);
      } catch (error: unknown) {
        await rm(temporary, { force: true });
        const existing = await this.get(storageKey);
        if (sha256(existing) !== contentHash) throw error;
      }
    } finally {
      await rm(temporary, { force: true });
    }
    return { storageKey, contentHash, byteSize: bytes.byteLength, mediaType };
  }

  async get(storageKey: string): Promise<Buffer> {
    const path = this.resolveKey(storageKey);
    const bytes = await readFile(path);
    const expected = storageKey.split('/').at(-1);
    if (expected === undefined || sha256(bytes) !== expected) {
      throw new PlusOneError({
        category: 'storage_unavailable',
        code: 'source_object_hash_mismatch',
        message: 'Stored source bytes do not match their immutable key',
        retry: 'after_state_resolution',
        receiptLookupRequired: false,
        details: { storageKey },
      });
    }
    return bytes;
  }

  private resolveKey(storageKey: string): string {
    if (!/^sha256\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(storageKey)) {
      throw new PlusOneError({
        category: 'validation_rejected',
        code: 'source_storage_key_invalid',
        message: 'Source storage key is invalid',
        retry: 'never',
        receiptLookupRequired: false,
        details: { storageKey },
      });
    }
    const root = resolve(this.root);
    const path = resolve(join(root, storageKey));
    if (relative(root, path).startsWith('..')) {
      throw new PlusOneError({
        category: 'validation_rejected',
        code: 'source_storage_key_invalid',
        message: 'Source storage key is invalid',
        retry: 'never',
        receiptLookupRequired: false,
        details: { storageKey },
      });
    }
    return path;
  }
}
