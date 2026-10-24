// 真实 KV 层（storage-kv）的测试环境桩。
//
// ── 为什么需要它 ─────────────────────────────────────────────────────────
//
// storage-kv 在**有 indexedDB** 时用 indexedDB 驱动，在**没有**时回退到
// localStorage 驱动。Node 测试环境里两者都没有（`indexedDB` 未定义、
// `window` 未定义）⇒ 回退到 localStorage 驱动，而那个驱动读的是
// `window.localStorage`：
//
//   · 读不到 ⇒ 一律返回 null（「键不存在」）；
//   · 写不进去 ⇒ **静默 no-op**（`hasLocalStorage()` 为假时直接 return）。
//
// ⇒ 任何走 KV 层的用例（会话、**账号归属账本**、删除广播队列……）在没装这个
// 桩的环境里，「写进去了」是**假的**，「读不到」也是**假的** —— 用例会
// 假绿或假红，而且两种都很难查（症状是「数据莫名消失」）。
//
// ── 为什么要预置迁移标志 ─────────────────────────────────────────────────
//
// storage-kv 第一次被使用时会把 chrome.storage.local 的旧键搬进 KV
// （`migrateFromChromeStorage`），搬完**把旧键删掉**。真实存量用户身上
// 这个动作早已跑过（标志位 `chromeStorageMigrated` 为真 ⇒ 不会重跑）。
// 测试若不预置这个标志，第一次访问 KV 就会把 chrome 桩里的键搬走并删除
// ⇒ 与本用例无关的断言（"chrome 桩里的键还在"）会莫名其妙地红。
//
// ⇒ 本 helper 默认把两个迁移标志都预置成「已迁移」，让 KV 层处在真实存量
// 用户的**稳态**。要测迁移本身的行为，去看
// tests/storageMigrationFlag.test.ts 与 tests/localStorageMigrationColdStart.ts。

/** KV 环境的句柄（供断言用）。 */
export interface KvEnv {
  /** localStorage 驱动的真实内容（storage-kv 的物理落盘处）。 */
  lsData: Map<string, string>;
  /** 读出某个键的原始值（测试断言用；没有则是 undefined）。 */
  read: (key: string) => unknown;
  /** 清空 KV（每个用例前调用）。 */
  reset: () => void;
}

/** 迁移标志键（storage-kv/keys.ts 的 MIGRATION_KEYS.migrationFlags）。 */
const MIGRATION_FLAGS_KEY = 'migration_flags';

/**
 * 装 KV 环境桩（localStorage + 已迁移标志）。
 *
 * ⚠️ 必须在**任何一次 KV 访问之前**调用：storage-kv 在首次访问时选定驱动
 * 并跑一次迁移，之后就不再重跑。
 */
export function installKvEnv(): KvEnv {
  const lsData = new Map<string, string>();

  const stub = {
    get length() {
      return lsData.size;
    },
    key: (i: number) => [...lsData.keys()][i] ?? null,
    getItem: (k: string) => (lsData.has(k) ? (lsData.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      lsData.set(k, String(v));
    },
    removeItem: (k: string) => {
      lsData.delete(k);
    },
    clear: () => lsData.clear(),
  };

  const g = globalThis as Record<string, unknown>;
  // 保留已有的 window 上的其它属性（有些用例自己装了 matchMedia 之类）。
  const prevWindow = (g.window ?? {}) as Record<string, unknown>;
  g.window = { ...prevWindow, localStorage: stub };
  g.localStorage = stub;

  // 预置「已经迁移过」的标志（真实存量用户的稳态，见文件头）。
  lsData.set(
    MIGRATION_FLAGS_KEY,
    JSON.stringify({ chromeStorageMigrated: true, localStorageMigrated: true }),
  );

  return {
    lsData,
    read: (key: string) => {
      const raw = lsData.get(key);
      if (raw === undefined) return undefined;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
    reset: () => {
      lsData.clear();
      lsData.set(
        MIGRATION_FLAGS_KEY,
        JSON.stringify({ chromeStorageMigrated: true, localStorageMigrated: true }),
      );
    },
  };
}
