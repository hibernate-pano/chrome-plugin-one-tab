import { indexedDbDriver, isIndexedDbAvailable } from './indexedDbClient';
import { localStorageDriver, isLocalStorageAvailable } from './localStorageFallback';
import type { StorageBackend, StorageDriver } from './types';
import { MIGRATION_KEY_RENAMES, MIGRATION_KEYS, MIGRATION_SCAN_KEYS } from './keys';
import { hasExtensionStorage } from './env';
import { logWarn } from '../utils/log';

let backend: StorageBackend | null = null;
let driver: StorageDriver | null = null;
let initialized = false;

/**
 * chrome.storage → KV 迁移失败时的标记（2026-10-20 审计 A-15）。
 *
 * 【为什么必须有这个标记】迁移失败时**老数据还留在 chrome.storage.local**，
 * 而 KV 里是空的 ⇒ `kvGet('tab_groups')` 返回 null ⇒ 上层判成
 * 「用户一个会话都没有」。而所有写路径都是读-改-写：下一次保存/删除/
 * 重命名会拿这个空列表当真值，把用户整组会话截断成刚保存的那一条，
 * **并回报成功**。v1.22.0 起无回收站、无撤销 ⇒ 这是静默数据丢失。
 *
 * 所以「迁移失败」不能降级成「没有数据」，必须**显式失败**：
 * 读路径抛错（用户看到错误而不是空白列表），写路径整条失败（不动他的数据）。
 * 下次冷启动（模块重新加载 ⇒ initialized 复位）会重试迁移。
 */
let migrationFailure: Error | null = null;

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * 「空」的判据：不存在 / null / 空数组。
 *
 * 为什么要它：改名迁移的优先级规则里，需要区分「这个源键**没有**数据」
 * 与「这个源键有数据但**是空的**」—— 两者在守卫里的含义不同
 * （前者是「没有」，后者是「有，但空」）。
 */
function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return Array.isArray(value) && value.length === 0;
}

/**
 * 把「源键 → 值」的清单整理成「目标键 → 值」的搬运计划。
 *
 * 【为什么抽出来】chrome.storage 与 localStorage 两条迁移路径都要处理改名，
 * 而改名规则一旦分叉就会出现「一条路径搬对了、另一条搬进死键」的漂移。
 * 纯函数 ⇒ 可直接单测，不依赖任何环境桩。
 *
 * 【规则】
 *   ① 非改名键：原样搬（键名不变）。
 *   ② 改名键（源键在 MIGRATION_KEY_RENAMES 里）：写到**目标键名**上。
 *   ③ 目标键**已被占用**时**跳过**改名来的值 ——
 *      「已占用」= 源侧同名键有非空值，**或** KV 侧该键已有非空值。
 *      现行数据优先，历史键只是备份，绝不允许它覆盖用户在用的那份；
 *      也不允许它覆盖刚刚并发写入的数据。
 *   ④ `skipKey`（migration_flags）不参与搬运：它是三份要合并的值，
 *      由调用方单独处理（见两处迁移的注释）。
 */
export function planMigrationWrites(
  entries: ReadonlyArray<readonly [string, unknown]>,
  options?: { skipKey?: string; existingValues?: ReadonlyMap<string, unknown> }
): Array<{ key: string; value: unknown }> {
  const skipKey = options?.skipKey;
  const existing = options?.existingValues;
  const sourceByKey = new Map(entries);

  const direct: Array<{ key: string; value: unknown }> = [];
  const renamed: Array<{ key: string; value: unknown }> = [];

  for (const [key, value] of entries) {
    if (skipKey && key === skipKey) continue;
    const renamedTo = MIGRATION_KEY_RENAMES[key];
    if (!renamedTo) {
      direct.push({ key, value });
      continue;
    }
    // 目标键已被占用（源侧非空 或 KV 侧非空）⇒ 现行数据优先，跳过历史键。
    if (!isEmptyValue(sourceByKey.get(renamedTo))) continue;
    if (existing && !isEmptyValue(existing.get(renamedTo))) continue;
    renamed.push({ key: renamedTo, value });
  }

  return [...direct, ...renamed];
}

/**
 * 读出改名表的**目标键**在 KV 侧当前的值（只读改名涉及的那几个键）。
 *
 * 为什么要在意 KV 侧：迁移可能与「用户刚在另一处保存了会话」并发。
 * 此时 KV 里的 `tab_groups` 是**更新**的那份，而源侧的历史键是旧备份 ——
 * 改名写入若覆盖它，就是用旧数据盖掉用户刚保存的内容。
 */
async function readRenameTargets(target: StorageDriver): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  for (const targetKey of new Set(Object.values(MIGRATION_KEY_RENAMES))) {
    try {
      out.set(targetKey, await target.getItem(targetKey));
    } catch {
      // 读不到就当作"没有"—— 下面的写入会失败并被 catch 记为迁移失败，
      // 那比在这里猜一个值安全。
      out.set(targetKey, undefined);
    }
  }
  return out;
}

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
      planMigrationWrites(
        candidates.map(entry => [entry.key, entry.value] as const),
        {
          skipKey: FLAGS_KEY,
          existingValues: await readRenameTargets(target),
        }
      ).map(({ key, value }) => target.setItem(key, value))
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

    // ── 2026-10-20 审计 A-15：改名键必须写到**目标键名**上 ──────────────────
    //
    // 修复前一律 `target.setItem(key, value)`（沿用源键名）。于是历史键
    // `tabGroups` 的数据会被写进 IndexedDB 的 `tabGroups` 键 ——
    // 而应用只读 `tab_groups`（现行键）。数据"搬到了"，但搬到一个
    // **没人读的键上** ⇒ 用户看不到自己的会话，存储层却一路绿灯。
    //
    // 改名规则集中在 planMigrationWrites（纯函数，两条迁移路径共用），
    // 改名表 MIGRATION_KEY_RENAMES 是它的单源（见 storage-kv/keys.ts）。
    await Promise.all(
      planMigrationWrites(entries, {
        skipKey: FLAGS_KEY,
        existingValues: await readRenameTargets(target),
      }).map(({ key, value }) => target.setItem(key, value))
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
    // ── 2026-10-20 审计 A-15：迁移失败必须**显式失败**，不能降级成「没有数据」 ──
    //
    // 修复前这里是 `logWarn(...)` 后静默返回，语义是"跳过迁移"。
    // 但老数据**还留在 chrome.storage.local 里**，KV 里是空的 ⇒
    // `kvGet('tab_groups')` 返回 null ⇒ 上层判成「用户一个会话都没有」。
    // 而所有写路径都是读-改-写：下一次保存/删除会拿这个空列表当真值，
    // 把用户整组会话截断成刚保存的那一条**并回报成功**。
    // v1.22.0 起无回收站、无撤销 ⇒ 这是静默数据丢失。
    //
    // 所以这里记下失败状态，由 kvGet/kvSet/kvRemove 统一 fail-closed：
    // 读抛错（用户看到错误，不是空白列表）、写整条失败（不动他的数据）。
    // 下次冷启动（模块重新加载 ⇒ initialized 复位）会重试迁移。
    migrationFailure = toError(error);
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
  // ── 2026-10-20 审计 A-15：迁移失败 ⇒ 读抛错，不返回 null ──────────────────
  //
  // null 与「键不存在」在上层完全同形：storage.getGroups() 只把 null 判成
  // 「首次使用 → 返回 []」。而迁移失败时**老数据还在 chrome.storage.local 里**，
  // KV 是空的 —— 返回 null 就等于告诉上层「用户一个会话都没有」。
  // 抛错则整条读路径失败，用户看到的是错误而不是一份空白列表，
  // 且下一次冷启动会重试迁移（模块重新加载 ⇒ initialized 复位）。
  if (migrationFailure) throw migrationFailure;
  if (!driver) return null;
  return driver.getItem<T>(key);
}

export async function kvSet<T = unknown>(key: string, value: T): Promise<void> {
  await ensureInitialized();
  // 写侧同理：迁移失败时 KV 不是「空的」，而是「**还没搬完**」。
  // 此时写进去会与源里的老数据分叉（用户下次重试迁移时源值会覆盖新值，
  // 或者新值被当成"已是最新"而把老数据永久留在源里）。
  // 整条失败 ⇒ 用户的操作报错而不是"成功但数据错位"。
  if (migrationFailure) throw migrationFailure;
  if (!driver) return;
  await driver.setItem<T>(key, value);
}

export async function kvRemove(key: string): Promise<void> {
  await ensureInitialized();
  if (migrationFailure) throw migrationFailure;
  if (!driver) return;
  await driver.removeItem(key);
}

export function getActiveBackend(): StorageBackend | null {
  return backend;
}
