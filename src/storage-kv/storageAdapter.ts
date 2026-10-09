import { indexedDbDriver, isIndexedDbAvailable } from './indexedDbClient';
import { localStorageDriver, isLocalStorageAvailable } from './localStorageFallback';
import type { StorageBackend, StorageDriver } from './types';
import { MIGRATION_KEYS, MIGRATION_SCAN_KEYS } from './keys';
import { hasExtensionStorage } from './env';
import { logWarn } from '../utils/log';

let backend: StorageBackend | null = null;
let driver: StorageDriver | null = null;
let initialized = false;

function pickBackend(): StorageBackend {
  if (isIndexedDbAvailable()) return 'indexeddb';
  return 'localStorage';
}

async function migrateFromLocalStorage(target: StorageDriver) {
  // Service Worker 环境没有 window，跳过迁移以避免报错
  if (typeof window === 'undefined') return;
  if (!isLocalStorageAvailable()) return;
  const ls = window.localStorage;

  // 迁移只执行一次（与 migrateFromChromeStorage 同语义）。
  // 无此标志时，每次冷启动（popup 每次打开都调 initStorage，见 AppContainer）
  // 都会把 localStorage 里的旧值无条件覆盖回 IndexedDB —— 用户列表被无声回滚。
  //
  // 2026-10-07 P1-7：白名单原先漏掉 pending_upload / device_seq 等键，
  // 注释里「pending_upload 不在迁移键表内」正是这个 bug 的自述。现改为派生表。
  const flags = (await target.getItem<Record<string, boolean>>(MIGRATION_KEYS.migrationFlags)) || {};
  if (flags.localStorageMigrated) return;

  const candidates: Array<{ key: string; value: unknown }> = [];

  for (let i = 0; i < ls.length; i += 1) {
    const key = ls.key(i);
    if (!key) continue;
    const interested =
      MIGRATION_SCAN_KEYS.includes(key) || key.startsWith(MIGRATION_KEYS.tabGroupPrefix);

    if (interested) {
      const raw = ls.getItem(key);
      if (raw !== null) {
        try {
          candidates.push({ key, value: JSON.parse(raw) });
        } catch {
          candidates.push({ key, value: raw });
        }
      }
    }
  }

  if (!candidates.length) return;

  try {
    // ── 2026-10-09 P0：migration_flags 不参与批量搬运 ────────────────────
    //
    // MIGRATION_SCAN_KEYS 由 Object.values(STORAGE_KEYS) 全量派生，**包含
    // migration_flags 自己**，于是候选清单里会出现这个键。它是**三份要合并的
    // 值**，不是普通数据：
    //   ① KV 侧现值 —— 本函数开头读的 flags
    //   ② 源侧现值 —— candidates 里可能带过来的值
    //   ③ 本次要置的 localStorageMigrated
    // 让它混进批量写，② 会先盖掉 ①；随后无论怎么「重新读」都救不回来，
    // 读到的已经是被覆盖的那份（第一版修复只做了重新读，变异测试当场抓到）。
    //
    // 丢掉其中任何一份都不是「少一个标志」而是**丢数据**：那个迁移的完成标记
    // 一旦丢失，判定重新变 false，它就把更旧的数据整批覆盖回 IndexedDB ——
    // 用户当前会话无声回滚，v1.22.0 起无回收站。
    const FLAGS_KEY = MIGRATION_KEYS.migrationFlags;
    const sourceFlagsEntry = candidates.find(entry => entry.key === FLAGS_KEY);
    const sourceFlags =
      sourceFlagsEntry &&
      sourceFlagsEntry.value !== null &&
      typeof sourceFlagsEntry.value === 'object' &&
      !Array.isArray(sourceFlagsEntry.value)
        ? (sourceFlagsEntry.value as Record<string, boolean>)
        : {};

    await Promise.all(
      candidates
        .filter(entry => entry.key !== FLAGS_KEY)
        .map(entry => target.setItem(entry.key, entry.value))
    );

    // 全部落盘成功后才标记已迁移，并清理源键（顺序与 migrateFromChromeStorage 一致）：
    // 写回中断时标志不置位，下次冷启动会重试而不是半迁移卡死。
    //
    // ① flags 现在仍是真值（批量写绕开了它），与 ② 源值、③ 本次标志三路合并。
    // 源里没有该键时 ② 为 {}，不影响其余两份 —— 不存在"依赖源里一定有"的假设。
    await target.setItem(FLAGS_KEY, {
      ...flags,
      ...sourceFlags,
      localStorageMigrated: true,
    });
    for (const entry of candidates) {
      ls.removeItem(entry.key);
    }
  } catch (error) {
    logWarn('[storage] migrateFromLocalStorage failed, skip migration', error);
  }
}

// 将 chrome.storage.local 中的旧数据迁移到统一的 kv 存储
async function migrateFromChromeStorage(target: StorageDriver) {
  // S2 同源：chrome 可用性判断走共享 env（与 supabase session 层同一函数）
  if (!hasExtensionStorage()) return;

  // 迁移只执行一次，避免刷新后旧数据反复覆盖
  const flags = (await target.getItem<Record<string, boolean>>(MIGRATION_KEYS.migrationFlags)) || {};
  if (flags.chromeStorageMigrated) return;

  // 2026-10-07 P1-7：改用派生表。原来这里是手抄的 9 项子集，漏掉了
  // pending_delete_ids / device_seq / last_upload_time 等 5 个业务键 ——
  // 对从 v1.21.x 直升的老用户是静默的数据丢失（删除广播队列 / Lamport 时钟 /
  // 下载保护窗口）。MIGRATION_SCAN_KEYS 由 STORAGE_KEYS 全量派生，
  // 新增业务键只改一处，扫描自动跟上。
  const keys = [...MIGRATION_SCAN_KEYS];

  try {
    const result = await chrome.storage.local.get(keys);
    const entries = Object.entries(result).filter(([, value]) => value !== undefined);
    if (!entries.length) return;

    // 同 migrateFromLocalStorage：migration_flags 要三路合并，不能混进批量写
    //（批量写会用 chrome.storage 的值盖掉 KV 侧现值，之后再"重新读"也救不回）。
    const FLAGS_KEY = MIGRATION_KEYS.migrationFlags;
    const sourceFlagsEntry = entries.find(([key]) => key === FLAGS_KEY);
    const sourceFlags =
      sourceFlagsEntry &&
      sourceFlagsEntry[1] !== null &&
      typeof sourceFlagsEntry[1] === 'object' &&
      !Array.isArray(sourceFlagsEntry[1])
        ? (sourceFlagsEntry[1] as Record<string, boolean>)
        : {};
    await Promise.all(
      entries
        .filter(([key]) => key !== FLAGS_KEY)
        .map(([key, value]) => target.setItem(key, value))
    );

    // 标记已迁移，并清理旧键，避免后续刷新重新写回旧数据
    // 三路合并：① KV 现值（批量写已绕开，仍是真值）② chrome.storage 现值
    // ③ 本次置位。丢任何一份 = 那个迁移会重跑 = 用更旧的数据覆盖当前数据。
    await target.setItem(FLAGS_KEY, {
      ...flags,
      ...sourceFlags,
      chromeStorageMigrated: true,
    });
    await chrome.storage.local.remove(keys);
  } catch (error) {
    logWarn('[storage] migrateFromChromeStorage failed, skip migration', error);
  }
}

async function ensureInitialized() {
  if (initialized) return;

  backend = pickBackend();
  driver = backend === 'indexeddb' ? indexedDbDriver : localStorageDriver;

  if (backend === 'indexeddb') {
    // 尝试迁移已有 chrome.storage/localStorage 数据
    await migrateFromChromeStorage(driver);
    await migrateFromLocalStorage(driver);
  }

  initialized = true;
}

// 显式初始化，供入口处预热与日志上报
export async function initStorage(): Promise<StorageBackend | null> {
  await ensureInitialized();
  return backend;
}

export async function kvGet<T = unknown>(key: string): Promise<T | null> {
  await ensureInitialized();
  if (!driver) return null;
  return driver.getItem<T>(key);
}

export async function kvSet<T = unknown>(key: string, value: T): Promise<void> {
  await ensureInitialized();
  if (!driver) return;
  await driver.setItem<T>(key, value);
}

export async function kvRemove(key: string): Promise<void> {
  await ensureInitialized();
  if (!driver) return;
  await driver.removeItem(key);
}

export function getActiveBackend(): StorageBackend | null {
  return backend;
}
