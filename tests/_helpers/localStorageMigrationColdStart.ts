// 迁移冷启动子进程（仅供 tests/storageMigrationFlag.test.ts 使用，非 *.test.ts，不被 pnpm test 收集）。
//
// 为什么需要子进程：storageAdapter 的 `initialized` / `cachedDb` 是模块级状态，
// 同一进程内无法触发第二次「冷启动」。要验证「迁移标志位让第二次冷启动不再
// 覆盖 IndexedDB」，必须让两次冷启动跑在两个干净的模块实例里。
//
// 用法：node --experimental-strip-types tests/_helpers/localStorageMigrationColdStart.ts <stateFile>
// stateFile: { localStorage: Record<string,string>, indexedDb: Record<string, {key,value}> }
// 退出前把迁移后的 localStorage / indexedDb 快照写回同一文件。
import { register } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
await register(pathToFileURL(resolve(HERE, '..', '_alias-loader.mjs')).href);

const statePath = process.argv[2];
if (!statePath) {
  console.error('usage: localStorageMigrationColdStart.ts <stateFile>');
  process.exit(2);
}

interface State {
  localStorage: Record<string, string>;
  indexedDb: Record<string, unknown>;
}

const state: State = JSON.parse(readFileSync(statePath, 'utf8'));

const lsBacking = new Map<string, string>(Object.entries(state.localStorage ?? {}));
const idbBacking = new Map<string, unknown>(Object.entries(state.indexedDb ?? {}));

function makeRequest(producer: () => unknown) {
  const req: Record<string, unknown> = { result: undefined, error: null };
  queueMicrotask(() => {
    try {
      req.result = producer();
      (req.onsuccess as ((e: unknown) => void) | null)?.({ target: req });
    } catch (error) {
      req.error = error ?? new Error('IndexedDB request failed');
      (req.onerror as ((e: unknown) => void) | null)?.({ target: req });
    }
  });
  return req;
}

const db = {
  objectStoreNames: { contains: () => true },
  createObjectStore: () => undefined,
  close: () => undefined,
  transaction(_storeName: string, _mode: string) {
    const tx: Record<string, unknown> = { error: null };
    tx.objectStore = () => ({
      get: (key: string) => makeRequest(() => idbBacking.get(key)),
      put: (record: { key: string; value: unknown }) =>
        makeRequest(() => {
          idbBacking.set(record.key, record);
          return record.key;
        }),
      delete: (key: string) =>
        makeRequest(() => {
          idbBacking.delete(key);
          return undefined;
        }),
    });
    return tx;
  },
};

const g = globalThis as Record<string, unknown>;
g.indexedDB = {
  open() {
    const req: Record<string, unknown> = { result: db, error: null };
    queueMicrotask(() => {
      (req.onupgradeneeded as ((e: unknown) => void) | null)?.({ target: req });
      (req.onsuccess as ((e: unknown) => void) | null)?.({ target: req });
    });
    return req;
  },
};
g.window = {
  localStorage: {
    get length() {
      return lsBacking.size;
    },
    key: (i: number) => Array.from(lsBacking.keys())[i] ?? null,
    getItem: (k: string) => (lsBacking.has(k) ? (lsBacking.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      lsBacking.set(k, String(v));
    },
    removeItem: (k: string) => {
      lsBacking.delete(k);
    },
    clear: () => lsBacking.clear(),
  },
};

const { initStorage, getActiveBackend } = await import('@/storage-kv/storageAdapter');
const backend = await initStorage();

const out: State & { backend: string | null } = {
  localStorage: Object.fromEntries(lsBacking),
  indexedDb: Object.fromEntries(idbBacking),
  backend,
};
writeFileSync(statePath, JSON.stringify(out, null, 2));
