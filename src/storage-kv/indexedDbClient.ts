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
    // blocked：有另一个连接持有旧版本且未关闭。浏览器不会因此 resolve/reject，
    // 若不处理则 open 的 promise 永远不 settle → 上层 kvGet 永久挂起（不是失败）。
    // 这里直接判失败：挂起无法被上层感知，也无从恢复。
    request.onblocked = () => reject(new Error('IndexedDB open blocked by another connection'));
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
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(KV_STORE, mode);
      const store = tx.objectStore(KV_STORE);
      const request = action(store);

      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  } catch (error) {
    // 事务失败后句柄可能已进入不可用状态（连接被关、版本变更中）。
    // 丢弃缓存句柄，下次调用重新 open，避免在坏句柄上反复失败。
    try {
      cachedDb?.close();
    } catch {
      /* close 本身失败无需处理：句柄即将被丢弃 */
    }
    cachedDb = null;
    throw error;
  }
}

export const indexedDbDriver: StorageDriver = {
  async getItem<T>(key: string): Promise<T | null> {
    // fail-closed：读失败必须抛错，不能与「键不存在」同形（都返回 null）。
    // 静默返回 null 会让上层把一次瞬时读错误当成「没有数据」——
    // 而所有写路径都是 getGroups() 的读-改-写，groups 读成 [] 时
    // 保存/删除/重命名/移动的结果会整组覆盖用户数据并回报 ok:true。
    const result = await runTransaction<any>('readonly', store => store.get(key));

    // 数据以 { key, value } 形式存入，读取时需要取出 value
    if (result && typeof result === 'object' && 'value' in result) {
      return (result as { value: T }).value;
    }

    // 兼容直接存储原始值的情况
    return result as T | null;
  },

  async setItem<T>(key: string, value: T): Promise<void> {
    await runTransaction('readwrite', store => store.put({ key, value }));
  },

  async removeItem(key: string): Promise<void> {
    await runTransaction('readwrite', store => store.delete(key));
  }
};

export { isIndexedDbAvailable };
