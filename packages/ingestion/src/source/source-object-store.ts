export interface StoredSourceObject {
  storageKey: string;
  contentHash: string;
  byteSize: number;
  mediaType: 'text/csv' | 'application/json';
}

export interface SourceObjectStore {
  put(bytes: Uint8Array, mediaType: StoredSourceObject['mediaType']): Promise<StoredSourceObject>;
  get(storageKey: string): Promise<Buffer>;
}
