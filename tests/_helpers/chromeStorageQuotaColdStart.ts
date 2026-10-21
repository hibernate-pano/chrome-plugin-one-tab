// chrome.storage → KV 迁移冷启动子进程（仅供 tests/unlimitedStorageRemoval.test.ts 使用，
// 非 *.test.ts，不被 pnpm test 收集）。
//
// 为什么需要子进程：storageAdapter 的 `initialized` / `cachedDb` / `migrationFailure`
// 都是**模块级**状态。同一进程内：
//   - 无法触发第二次「冷启动」（迁移只跑一次）；
//   - 无法在「迁移失败」之后再走一次读路径（migrationFailure 一旦置位就常驻）。
// 而本文件要验证的恰恰是「一次失败的迁移之后用户看到什么」—— 必须每次冷启动
// 都是干净的模块实例。
//
// 用法：node --experimental-strip-types tests/_helpers/chromeStorageQuotaColdStart.ts <stateFile>
// stateFile: {
//   chromeStorage?: Record<string, unknown>,   // chrome.storage.local 的初始内容
//   indexedDb?: Record<string, unknown>,       // IndexedDB kv 仓的初始内容
//   failChromeSet?: boolean,                   // chrome.storage.local.set 一律抛 QUOTA_BYTES
//   failIdbPutKeys?: string[],                 // 这些键的 IndexedDB put 抛错
//   probeKeys?: string[],                      // 迁移后逐个 kvGet 的键
// }
// 退出前把结果快照写回同一文件。
import { register } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
await register(pathToFileURL(resolve(HERE, '..', '_alias-loader.mjs')).href);

interface State {
  chromeStorage?: Record<string, unknown>;
  indexedDb?: Record<string, unknown>;
  failChromeSet?: boolean;
  failIdbPutKeys?: string[];
  probeKeys?: string[];
  /** 迁移后对这个键做一次 kvSet 探针（验证写路径在迁移失败时也 fail-closed）。 */
  probeWrite?: string;
}

const statePath = process.argv[2];
if (!statePath) {
  console.error('usage: chromeStorageQuotaColdStart.ts <stateFile>');
  process.exit(2);
}

const state: State = JSON.parse(readFileSync(statePath, 'utf8'));

const chromeData = new Map<string, unknown>(Object.entries(state.chromeStorage ?? {}));
const idbBacking = new Map<string, unknown>(Object.entries(state.indexedDb ?? {}));
const failIdbPutKeys = new Set(state.failIdbPutKeys ?? []);

/** chrome.storage.local.set 的每一次调用（键名）——用来证明「迁移过程一次都没写」。 */
const chromeSetCalls: string[] = [];
/** chrome.storage.local.remove 的每一次调用（键名）。 */
const chromeRemoveCalls: string[] = [];

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
          if (failIdbPutKeys.has(record.key)) {
            throw new Error(`simulated IndexedDB write failure: ${record.key}`);
          }
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

g.chrome = {
  storage: {
    local: {
      get: async (keys: string | string[]) => {
        const list = Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const key of list) if (chromeData.has(key)) out[key] = chromeData.get(key);
        return out;
      },
      set: async (obj: Record<string, unknown>) => {
        chromeSetCalls.push(...Object.keys(obj));
        if (state.failChromeSet) {
          // Chrome 真机上 10MB 配额耗尽时的典型报错（QUOTA_BYTES）。
          // 移除 unlimitedStorage 后，这正是老用户升级路上会撞上的那堵墙。
          throw new Error('QUOTA_BYTES: The quota has been exceeded.');
        }
        for (const [key, value] of Object.entries(obj)) chromeData.set(key, value);
      },
      remove: async (keys: string | string[]) => {
        const list = Array.isArray(keys) ? keys : [keys];
        chromeRemoveCalls.push(...list);
        for (const key of list) chromeData.delete(key);
      },
    },
  },
  runtime: { getManifest: () => ({ version: 'test' }) },
};

// 不定义 window：migrateFromLocalStorage 会因 `typeof window === 'undefined'` 直接返回，
// 本文件只聚焦 chrome.storage → KV 这一条迁移路径。

const { initStorage, kvGet, kvSet } = await import('@/storage-kv/storageAdapter');
const backend = await initStorage();

const probes: Record<string, { ok: boolean; value?: unknown; error?: string }> = {};
for (const key of state.probeKeys ?? ['tab_groups']) {
  try {
    const value = await kvGet(key);
    probes[key] = { ok: true, value: value === undefined ? null : value };
  } catch (error) {
    probes[key] = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// 写路径探针：迁移失败时写也必须整条失败（不能把数据写进一个「还没搬完」的 KV）。
if (state.probeWrite) {
  try {
    await kvSet(state.probeWrite, [{ id: 'probe-write' }]);
    probes.__write__ = { ok: true };
  } catch (error) {
    probes.__write__ = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const out = {
  backend,
  indexedDb: Object.fromEntries(idbBacking),
  chromeStorage: Object.fromEntries(chromeData),
  chromeSetCalls,
  chromeRemoveCalls,
  probes,
};
writeFileSync(statePath, JSON.stringify(out, null, 2));
