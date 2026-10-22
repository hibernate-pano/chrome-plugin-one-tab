/**
 * 「恢复即消费」的**撤销**语义（2026-10-22 审计 P0-4）。
 *
 * ── 这个模块解决的是什么问题 ────────────────────────────────────────────
 *
 * 1.24.1 定案：点开标签 = 消费掉那条记录；恢复整个会话 = 消费掉整条会话。
 * 这是**不可逆的删除**（无回收站），而且是本产品**最高频**的两个动作。
 * 恢复之后卡片凭空消失 —— 用户第一反应是「我是不是点错了」，而他**没有任何
 * 办法退回去**。
 *
 * 产品界上的标准答案是「给一条可点回去的路」：Chrome 的「重新打开已关闭的
 * 标签」、Dropbox 的「撤销删除」都是这个形状。本模块提供那条路的**语义**，
 * UI（toast 上的动作按钮）由 components 层负责。
 *
 * ── 撤销恢复的是什么 ────────────────────────────────────────────────────
 *
 * **不是标签，是记录。** 恢复动作已经把标签页开在浏览器里了 —— 撤销不会
 * 把它们关掉。撤销恢复的是**「这一组标签」这条记录**：卡片回到列表里。
 *
 * 这样定位有两个好处：
 *   · 撤销是**纯本地的小操作**（写回一条记录），不需要去动已经打开的浏览器
 *     窗口（关掉它们会让用户更迷惑）；
 *   · 语义诚实：用户按下「撤销」时想要的是「我刚才不该消费这一条」，
 *     而不是「把我刚打开的 12 个标签全关掉」。
 *
 * ── 为什么撤销必须动**印记**与**删除意图** ──────────────────────────────
 *
 * 消费 = 一次删除，两件事同时发生：
 *   ① 本地物理移除该记录；
 *   ② 登记一条删除广播意图（pendingDeleteIds），上传时把云端行标成墓碑
 *      （is_deleted=true），好让别的设备也删。
 *
 * 只做 ① 不做 ② 的撤销是**假的**：本地卡片回来了，但下一次上传仍会把云端
 * 行标墓碑 ⇒ 别的设备上的这条会话消失 ⇒ 两台设备分叉。而本地这一侧，
 * 墓碑的印记比恢复后的本地印记旧时合并会「本地赢」，于是本地留着、云端没了 ——
 * 正是本仓最恨的那种「两台设备不一致且没人知道」。
 *
 * 所以撤销必须同时：
 *   · **撤回**那条删除广播意图（第 ② 件事的回滚）；
 *   · 给恢复出来的记录盖一个**全新且更新的印记**（让「本地赢」这条合并规则
 *     在跨设备比较时也成立：墓碑的印记是删除时取的，撤销时再取一个必然更大）。
 *
 * ── 印记为什么必然更大 ──────────────────────────────────────────────────
 *
 * 墓碑的序号取自本机的 Lamport 计数器（utils/supabase/upload.ts 的
 * tombstoneSeq），恢复的印记也取自同一个计数器（core/opStamp + seqRegistry，
 * 同一持久化 key）。计数器单调递增 ⇒ 撤销取到的号一定大于删除时取的号。
 * 这不是「大概率」，是**结构上**保证。
 *
 * ── 唯一的竞态与它的封堵 ────────────────────────────────────────────────
 *
 * 上传可能**正在**把墓碑写上云，而用户在同一瞬间点了撤销。顺序若是
 * 「撤销写入恢复态 → 在途的上传写墓碑」，墓碑会拿到更大的号 ⇒ 撤销被推翻。
 *
 * 封堵靠两条**结构性**事实，不是靠「上传时再查一遍本地」：
 *
 *   ① **单写者队列**（background/mutationQueue.ts）：上传与语义命令在 SW 里
 *      串行执行。于是撤销只有两种落位：
 *        · 整块排在上传**之前** ⇒ 意图已被撤回 ⇒ 上传写墓碑前读到的队列里
 *          没有它 ⇒ 不写墓碑；
 *        · 整块排在上传**之后** ⇒ 墓碑已写上云，但撤销随后取到一个**更大**
 *          的号（见上）⇒ 恢复态赢 ⇒ 下一轮上传把云端行复位。
 *      两种顺序都不会出现「墓碑写在撤销之后、号却比撤销旧」的分叉。
 *
 *   ② **单调的持久化号位**（utils/seqRegistry.ts 的 DEVICE_SEQ）：取号只会
 *      更大，所以撤销写回的那个号必然新于在途上传写的那个墓碑号。
 *
 * ⚠️ 曾经试过另一条路：「本机现在还有这条记录 ⇒ 删除意图已过期 ⇒ 不写墓碑」。
 * **那条判据是错的**：下载合并会把**云端的活跃副本**带进本机（老版本墓碑组
 * 被剥掉后，云端那一行仍是活跃的）—— 此时删除意图**必须**照写，否则那条
 * 「本机已经删掉的会话」下一轮又从云端回来。真正的判据是「意图还在不在
 * 队列里」：撤销会把那条 id 从队列里摘掉，写墓碑前读到的队列因此不含它。
 */
import type { TabGroup, Tab } from '../types/tab';
import type { OpStamp } from './opStamp';

/**
 * 被消费掉的一条标签，及其在组内的**原下标**。
 *
 * 下标是必须的：撤销要把标签插回原来的位置，而不是追加到末尾
 * —— 顺序是用户自己排的，撤销不该偷偷改它。
 */
export interface ConsumedTabRef {
  tabId: string;
  index: number;
}

/**
 * 一次「消费」的撤销凭据。
 *
 * 携带**消费前的整组快照**而不是「被消费的那一条」：因为消费掉最后一条标签
 * 时整组会被物理移除，只带一条标签是还原不回来的。
 */
export interface ConsumeUndoSpec {
  /** 消费前的整组快照。撤销按它还原。 */
  group: TabGroup;
  /** 本次被消费掉的标签 id。**整组**被消费时省略。 */
  consumedTabId?: string;
  /** 被消费那条标签在组内的下标 —— 撤销时插回原位，而不是追加到末尾。 */
  consumedIndex?: number;
  /**
   * 一次消费掉**多条**标签时用这个（搜索页的「批量恢复」）。
   *
   * 为什么单条形式不够：批量恢复一次可能从同一个会话里消费掉好几条，
   * 逐条撤销会算错位置（先插回来的那条会把后面的下标顶偏）。
   * 一次性给出全部（tabId + 原下标），按原下标**升序**插回，结果与消费前逐字一致。
   */
  consumedTabs?: ConsumedTabRef[];
}

export type RestoreConsumedOutcome =
  | {
      ok: true;
      /** 落盘后的完整会话列表。 */
      groups: TabGroup[];
      /** 还原后的那一条会话（落盘真值）。 */
      group: TabGroup;
      /** 本次是否真的改变了什么。false = 已经撤销过 / 本来就没被消费。 */
      changed: boolean;
    }
  | { ok: false; error: string };

/** 从快照里取出被消费的那条标签。 */
function findConsumedTab(snapshot: TabGroup, tabId: string): Tab | undefined {
  return snapshot.tabs.find(t => t.id === tabId);
}

/**
 * 把撤销凭据归一成「被消费掉的那些标签」（按原下标升序）。
 *
 * 两种形式：单条（consumedTabId + consumedIndex）与多条（consumedTabs）。
 * 归一之后两条路径走同一段代码 —— 免得「单条那条」和「多条那条」的还原
 * 语义悄悄分叉（分叉的后果是「撤销后标签顺序不对」，用户看得见）。
 */
function normalizeConsumedRefs(spec: ConsumeUndoSpec): ConsumedTabRef[] {
  if (spec.consumedTabs && spec.consumedTabs.length > 0) {
    return [...spec.consumedTabs].sort((a, b) => a.index - b.index);
  }
  if (spec.consumedTabId !== undefined) {
    return [{ tabId: spec.consumedTabId, index: spec.consumedIndex ?? 0 }];
  }
  return [];
}

/**
 * 撤销一次「消费」。
 *
 * 幂等：已经撤销过（记录已经在列表里）时返回 changed:false 而不是报错 ——
 * 撤销被点两次（用户手快、或 toast 重复渲染）不该变成一次失败提示。
 */
export function applyRestoreConsumed(
  groups: TabGroup[],
  spec: ConsumeUndoSpec,
  now: string,
  stamp: OpStamp
): RestoreConsumedOutcome {
  const snapshot = spec.group;
  if (!snapshot || typeof snapshot.id !== 'string' || snapshot.id.length === 0) {
    return { ok: false, error: '撤销凭据损坏：会话 id 缺失' };
  }

  const idx = groups.findIndex(g => g.id === snapshot.id);
  const refs = normalizeConsumedRefs(spec);

  // ── 情况一：整组被消费（恢复整个会话）───────────────────────────────
  if (refs.length === 0) {
    if (idx !== -1) {
      // 已经在列表里（撤销过一次，或它其实从没被消费掉）⇒ 幂等返回。
      return { ok: true, groups, group: groups[idx], changed: false };
    }
    const restored: TabGroup = {
      ...snapshot,
      // 印记必须换新：旧印记比墓碑旧 ⇒ 跨设备合并会输给云端墓碑（见文件头）。
      lastOp: stamp,
      updatedAt: now,
      version: (snapshot.version ?? 1) + 1,
    };
    // 插回原位：列表按 createdAt 倒序，原 createdAt 不变 ⇒ 位置自然回到原处。
    const out = [...groups, restored];
    out.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return { ok: true, groups: out, group: restored, changed: true };
  }

  // ── 情况二：被消费掉的是组里的若干条标签 ────────────────────────────
  // 先把每一条都对上号：凭据里有一条在快照里找不到 ⇒ 整次撤销失败
  // （宁可不做，也不要插一条错的 —— 那是把「撤销」变成「再删一次」）。
  const consumedTabs: Tab[] = [];
  for (const ref of refs) {
    const tab = findConsumedTab(snapshot, ref.tabId);
    if (!tab) {
      return {
        ok: false,
        error: '撤销凭据与当前数据不一致：找不到被移除的那条标签',
      };
    }
    consumedTabs.push(tab);
  }

  if (idx === -1) {
    // 组整个不在了 —— 说明被消费的是**最后一条**标签，消费时整组被移除了。
    // 这时按快照整组还原。
    const restored: TabGroup = {
      ...snapshot,
      lastOp: stamp,
      updatedAt: now,
      version: (snapshot.version ?? 1) + 1,
    };
    const out = [...groups, restored];
    out.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return { ok: true, groups: out, group: restored, changed: true };
  }

  const current = groups[idx];
  const tabs = [...current.tabs];
  let changed = false;
  // 按**原下标升序**插回：插回一条会把后面的位置顶过去，而后面的那些
  // 记着的是消费前的下标 —— 升序插入时，后面那些的下标仍然指向正确位置。
  // （倒序插入会得到错位的顺序：那是「撤销之后顺序变了」，用户看得见。）
  refs.forEach((ref, i) => {
    const tab = consumedTabs[i];
    if (tabs.some(t => t.id === tab.id)) {
      // 那条标签已经在列表里 ⇒ 已经撤销过 ⇒ 幂等跳过。
      return;
    }
    const insertAt = Math.max(0, Math.min(ref.index, tabs.length));
    tabs.splice(insertAt, 0, tab);
    changed = true;
  });
  if (!changed) {
    return { ok: true, groups, group: current, changed: false };
  }

  const restored: TabGroup = {
    ...current,
    tabs,
    lastOp: stamp,
    updatedAt: now,
    version: (current.version ?? 1) + 1,
  };
  const out = [...groups];
  out[idx] = restored;
  return { ok: true, groups: out, group: restored, changed: true };
}
