import type { StorageDriver } from './types';

const DB_NAME = 'tabvaultpro';
const DB_VERSION = 1;
const KV_STORE = 'kv';

function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isIndexedDbAvailable()) {
      reject(new Error('IndexedDB not available'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KV_STORE)) {
        db.createObjectStore(KV_STORE, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

let cachedDb: IDBDatabase | null = null;

async function getDb(): Promise<IDBDatabase> {
  if (cachedDb) return cachedDb;
  cachedDb = await openDatabase();
  cachedDb.onversionchange = () => {
    cachedDb?.close();
    cachedDb = null;
  };
  return cachedDb;
}

async function runTransaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV_STORE, mode);
    const store = tx.objectStore(KV_STORE);
    const request = action(store);

    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export const indexedDbDriver: StorageDriver = {
  async getItem<T>(key: string): Promise<T | null> {
    try {
      const result = await runTransaction<any>('readonly', store => store.get(key));

      // 数据以 { key, value } 形式存入，读取时需要取出 value
      if (result && typeof result === 'object' && 'value' in result) {
        return (result as { value: T }).value;
      }

      // 兼容直接存储原始值的情况
      return result as T | null;
    } catch {
      return null;
    }
  },

  async setItem<T>(key: string, value: T): Promise<void> {
    await runTransaction('readwrite', store => store.put({ key, value }));
  },

  async removeItem(key: string): Promise<void> {
    await runTransaction('readwrite', store => store.delete(key));
  }
};

export { isIndexedDbAvailable };

