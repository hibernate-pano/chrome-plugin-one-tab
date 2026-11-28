/**
 * 「最近使用」的本机记录（v1.33）—— **只记在这台设备上，绝不上云**。
 *
 * ── 它是什么 ──────────────────────────────────────────────────────────────
 *
 * `{ [会话 id]: ISO 时间 }`：这个会话最近一次**从本机打开过标签**的时刻。
 * 「使用」的定义（产品口径）：从这个会话里打开过标签 —— 点开单个标签、
 * 恢复整个会话（锁定会话的恢复也算）、搜索页批量恢复命中的标签都算。
 * 只删标签、只重命名**不算**（那是「修改」，见 `core/sessionSort.ts` 的
 * `lastActivityAt`）。
 *
 * ── 为什么必须是独立存储，而不是 `TabGroup.lastUsedAt` ────────────────────
 *
 * 会话组会被**整体快照**写进 `tab_groups`、并原样上传/合并到云端与其它设备
 * （`buildTabGroupRow` / `encodeGroup`）。把本机使用时间挂进那个快照，
 * 它就变成了「会话数据」：换一台设备会看到另一台设备的使用时间 —— 那句话
 * 对这台设备是**假的**（本机没发生过那次使用），而且它会被写进云端、
 * 参与合并、再也收不回来。⇒ 使用记录只能落在**本机独立的 KV 键**上
 * （`STORAGE_KEYS.LAST_USED_AT`）。
 *
 * ── 写路径的三条纪律 ─────────────────────────────────────────────────────
 *
 * ① **读-改-写**：每次都基于完整快照合并，不整表覆盖成「只有一个 id」。
 * ② **单写者串行**：同一次点击可能连着触发两条记录（锁定组恢复 + 某个标签），
 *    并发读-改-写会互相盖掉 ⇒ 所有持久化排进一条 promise 链。
 * ③ **读不出来就不写**：`kvGet` 失败时若照着内存里的空快照写回去，
 *    会把**读不出来但真实存在**的旧记录全部抹掉。⇒ 加载失败的那一轮只更新
 *    内存（界面照常），不落盘；下一次成功加载会把磁盘值合并进来（内存值优先，
 *    因为它是用户刚做的动作）。
 *
 * ── 失败方向 ─────────────────────────────────────────────────────────────
 *
 * 使用记录是「锦上添花」的排序信号，不是用户数据：写失败只影响下次排序，
 * 绝不能让「点开一个标签」这个主操作失败。⇒ 所有存储错误只记日志、不抛给 UI。
 * 但**读失败不等于没有记录**：界面上的说明行会按「还没有使用记录」显示，
 * 这是已知的、可接受的降级（下一次打开页面会重试加载）。
 */
import { kvGet, kvSet } from './storageAdapter';
import { STORAGE_KEYS } from './keys';
import { logWarn } from '../utils/log';

/** 会话 id → 最近一次使用时间（ISO）。 */
export type LastUsedAtMap = Readonly<Record<string, string>>;

/** 空表（冻结：`useSyncExternalStore` 的快照引用必须稳定）。 */
const EMPTY: LastUsedAtMap = Object.freeze({});

/** 当前内存快照 —— UI 通过 `getLastUsedAtSnapshot` 读它。 */
let snapshot: LastUsedAtMap = EMPTY;

/** 磁盘真值是否已经成功读进内存。失败时保持 false ⇒ 下次再试。 */
let loaded = false;
let loadPromise: Promise<boolean> | null = null;

/** 持久化串行链（见文件头纪律②）。 */
let writeChain: Promise<void> = Promise.resolve();

const listeners = new Set<() => void>();

/** 只接受「非空字符串 id + 可解析的时间」；脏值丢弃（不显示、不参与排序）。 */
function sanitize(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (id.length === 0) continue;
    if (typeof value !== 'string' || value.length === 0) continue;
    if (Number.isNaN(new Date(value).getTime())) continue;
    out[id] = value;
  }
  return out;
}

function publish(next: LastUsedAtMap): void {
  snapshot = next;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      logWarn('[lastUsedAt] 订阅者抛错（已忽略）:', error);
    }
  }
}

/** 当前快照（引用稳定；没变化时返回同一个对象 —— `useSyncExternalStore` 的要求）。 */
export function getLastUsedAtSnapshot(): LastUsedAtMap {
  return snapshot;
}

/** 订阅变化。返回取消订阅函数。 */
export function subscribeLastUsedAt(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 把磁盘上的使用记录读进内存（幂等、并发去重）。
 *
 * @returns `true` = 读到了磁盘真值（可以安全地写回）；`false` = 读取失败
 *          （此时**不许**落盘，见文件头纪律③）。
 */
export function loadLastUsedAt(): Promise<boolean> {
  if (loaded) return Promise.resolve(true);
  loadPromise ??= (async () => {
    try {
      const raw = await kvGet<unknown>(STORAGE_KEYS.LAST_USED_AT);
      const stored = sanitize(raw);
      loaded = true;
      // 加载期间可能已经有新的使用记录写进内存（用户手速比 IndexedDB 快）——
      // 内存里的那条更新，合并时让它赢。
      //
      // 只在**真的变了**时通知：冷启动第一轮通常是「磁盘空 + 内存空」，
      // 此时换引用只会让订阅者白重渲染一次（`useSyncExternalStore` 按引用判变化）。
      const merged: LastUsedAtMap = { ...stored, ...snapshot };
      const changed =
        Object.keys(merged).length !== Object.keys(snapshot).length ||
        Object.entries(merged).some(([id, at]) => snapshot[id] !== at);
      if (changed) publish(merged);
      return true;
    } catch (error) {
      logWarn('[lastUsedAt] 读取使用记录失败（本轮按「没有记录」显示，下次重试）:', error);
      return false;
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

/**
 * 记一次「这个会话被使用了」（打开动作成功之后调用）。
 *
 * @param groupId 会话 id
 * @param usedAt  使用时刻（默认现在；测试可注入固定时间）
 * @returns 持久化完成的 promise（调用方通常 `void` 掉 —— 它永不 reject）
 */
export function recordSessionUsed(
  groupId: string,
  usedAt: Date | string = new Date()
): Promise<void> {
  const id = typeof groupId === 'string' ? groupId.trim() : '';
  if (id.length === 0) return writeChain;
  const iso = typeof usedAt === 'string' ? usedAt : usedAt.toISOString();
  if (Number.isNaN(new Date(iso).getTime())) return writeChain;

  writeChain = writeChain.then(async () => {
    const canPersist = await loadLastUsedAt();
    // 先更新内存（界面立刻按新记录排序/显示），再落盘。
    const next: LastUsedAtMap = { ...snapshot, [id]: iso };
    publish(next);
    if (!canPersist) return; // 见文件头纪律③：读不到真值就不写，免得抹掉旧记录
    try {
      await kvSet(STORAGE_KEYS.LAST_USED_AT, next);
    } catch (error) {
      // 使用记录写失败不影响主操作（见文件头「失败方向」）。
      logWarn('[lastUsedAt] 写入使用记录失败（本次不生效，下次使用会重试）:', error);
    }
  });
  return writeChain;
}

// ─────────────────────────────────────────────────────────────────────────
// 测试专用
// ─────────────────────────────────────────────────────────────────────────

/**
 * 直接种一份使用记录（SSR 测试用 —— 服务端渲染不跑 effect，读不到磁盘）。
 *
 * ⚠️ 只给测试用：生产代码里唯一的写入口是 `recordSessionUsed`。
 */
export function __seedLastUsedAtForTests(map: Record<string, string>): void {
  loaded = true;
  loadPromise = null;
  publish(sanitize(map));
}

/** 清空内存状态（每个用例之间复位；不会动真实存储）。 */
export function __resetLastUsedAtForTests(): void {
  snapshot = EMPTY;
  loaded = false;
  loadPromise = null;
  writeChain = Promise.resolve();
  listeners.clear();
}
