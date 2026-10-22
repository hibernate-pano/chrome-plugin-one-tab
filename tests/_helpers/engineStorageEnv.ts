// 真实 SyncEngine / migrationUtils 回归测试的浏览器环境桩。
//
// 【为什么集中一份】L2/L3/L4/L5/L7 五份恢复的守卫都要跑真 storage + 真
// SyncEngine。各文件原来各带一套 ~50 行的环境桩；本 helper 把
// 「无 indexedDB ⇒ storage-kv 回退 localStorage 驱动」这条唯一事实源收在一处，
// 避免五份拷贝漂移（比如某一版忘了给 getItem 抛错注入能力，对应守卫就悄悄失效）。
//
// 使用纪律：
//   1. 必须在任何 `await import('@/...')` 之前调用（storage-kv 在首次 import 时
//      选择 driver）；
//   2. 每个测试文件是独立进程，桩不跨文件泄漏；
//   3. `failReadKeys` 用于模拟一次真实存储读失败（键级注入），
//      `writes` 记录全部落盘键，供「读失败后零写入」类断言使用。

export interface EngineStorageEnv {
  /** localStorage 驱动的真实内容（storage-kv 的物理落盘处）。 */
  lsData: Map<string, string>;
  /** 命中这些键的读会抛错（模拟 IndexedDB/localStorage 读失败）。 */
  failReadKeys: Set<string>;
  /**
   * 命中这些键的写会抛错（模拟配额满 / 存储不可用）。
   *
   * 为什么要能注入**写**失败：读失败与写失败在数据安全上方向相反 ——
   * 读失败可以「停下不写」，写失败则可能已经改了一半。凡是「读-改-写」
   * 的队列（删除广播队列就是），都必须证明**写失败时不会把意图弄丢**
   * （见 tests/retractDeleteIntent.test.ts）。只注入读失败时，那条性质
   * 是测不出来的 —— 守卫会因「根本没走到写」而假绿。
   */
  failWriteKeys: Set<string>;
  /** 落盘日志（按 setItem 顺序，含重复）。 */
  writes: string[];
  /** chrome.storage.local 的独立内容。 */
  chromeData: Map<string, unknown>;
}

export function installEngineStorageEnv(): EngineStorageEnv {
  const lsData = new Map<string, string>();
  const failReadKeys = new Set<string>();
  const failWriteKeys = new Set<string>();
  const writes: string[] = [];

  const localStorageStub = {
    get length() {
      return lsData.size;
    },
    key: (i: number) => [...lsData.keys()][i] ?? null,
    getItem: (k: string) => {
      if (failReadKeys.has(k)) throw new Error(`simulated read failure: ${k}`);
      return lsData.has(k) ? (lsData.get(k) as string) : null;
    },
    setItem: (k: string, v: string) => {
      if (failWriteKeys.has(k)) throw new Error(`simulated write failure: ${k}`);
      writes.push(k);
      lsData.set(k, String(v));
    },
    removeItem: (k: string) => {
      if (failWriteKeys.has(k)) throw new Error(`simulated write failure: ${k}`);
      lsData.delete(k);
    },
    clear: () => lsData.clear(),
  };
  (globalThis as Record<string, unknown>).window = { localStorage: localStorageStub };
  (globalThis as Record<string, unknown>).localStorage = localStorageStub;

  const chromeData = new Map<string, unknown>();
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        get: async (k: string | string[]) => {
          const keys = Array.isArray(k) ? k : [k];
          const out: Record<string, unknown> = {};
          for (const key of keys) if (chromeData.has(key)) out[key] = chromeData.get(key);
          return out;
        },
        set: async (obj: Record<string, unknown>) => {
          for (const [key, v] of Object.entries(obj)) chromeData.set(key, v);
        },
        remove: async (k: string) => {
          chromeData.delete(k);
        },
      },
      onChanged: { addListener: () => undefined, removeListener: () => undefined },
    },
    runtime: { getManifest: () => ({ version: 'test' }) },
    alarms: {
      create: () => undefined,
      clear: async () => true,
      onAlarm: { addListener: () => undefined },
    },
  };

  return { lsData, failReadKeys, failWriteKeys, writes, chromeData };
}

/** 测试数据：一个带活跃标签的组（空壳会被空组判据剔除，做种子必须带 tab）。 */
export function mkGroup(id: string, overrides: Record<string, unknown> = {}) {
  const now = '2026-09-29T08:00:00.000Z';
  return {
    id,
    name: id,
    tabs: [
      {
        id: `${id}-t1`,
        url: `https://${id}.example.com/`,
        title: id,
        createdAt: now,
        lastAccessed: now,
        pinned: false,
      },
    ],
    createdAt: now,
    updatedAt: now,
    isLocked: false,
    version: 1,
    ...overrides,
  } as Record<string, unknown>;
}
