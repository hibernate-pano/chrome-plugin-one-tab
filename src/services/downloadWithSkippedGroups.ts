/**
 * 「读远端会话 + 本轮读不出来的那几组」的一次性读取（2026-10-20 D-6）。
 *
 * ── 为什么需要这一层 ─────────────────────────────────────────────────────
 * 云端下行时，有些会话**整组读不出来**会被跳过（形状不可恢复 / 还原率不达标 /
 * tabs 表被网关截断 / 单组处理异常）。这些组的**云端行仍在**（一个字节都没被动过），
 * 但它们**不在下载结果里**。
 *
 * 于是上层（SyncEngine）若只看「下载结果」，就会把「云端那份没读到」误判成
 * 「云端没有这一组」：
 *   · 覆盖下载（forceRemote）会把 localGroups 整体置空 ⇒ 本机那一份被物理删除；
 *   · 删除熔断量的是「合并结果里被剔除的」⇒ 压根没进合并结果 ⇒ 熔断看不见；
 *   · `droppedIds` 为空 ⇒ 不登记删除广播 ⇒ 云端行也不会被标记；
 *   · 结果是 `success: true` ⇒ 界面报成功 ⇒ 用户唯一可见信号是「列表变短了」。
 *
 * 而 v1.22.0 起删除即物理清除、无回收站 —— 一次覆盖下载就能把用户仅存于
 * 本机的那一份会话永久清掉；再叠加一次覆盖上传（先 DELETE 云端全部行），
 * 云端那份也跟着消失。
 *
 * 对照：自带存储后端在同样情形下是 **fail-closed** 的（不可读分片 → 收集 →
 * 整轮抛错，中止合并以免把本地对应会话判成「云端已删除」）。只有云端后端
 * 是「静默少读」—— 那正是本模块要补上的事实出口。
 *
 * ── 为什么放在服务层，而不是让引擎直接读端口 ───────────────────────────
 * 分层纪律：engine → service → port（见 tests/firstSyncPendingGate.test.ts）。
 * 引擎只认「读到了什么 + 哪些读不出来」这个**语义面**，不认后端怎么实现。
 *
 * ── 为什么必须**一次**读完（原子） ─────────────────────────────────────
 * 「读到的」与「读不出来的」必须来自**同一轮**下载。分两次调用（先读结果、
 * 再问清单）中间有 await 间隙，同一 realm 里理论上可能读到别的轮次的清单。
 * 所以这里把两件事收进一个函数，端口实例也只解析一次。
 *
 * ── 端口方法是**可选**的 ───────────────────────────────────────────────
 * 不是每个后端都「产生跳过」：
 *   · 自带存储（WebDAV）遇到读不出来的分片是 **fail-closed**（整轮抛错中止，
 *     见 sync-backend/webdav/adapter.ts）⇒ 它**不产生跳过**，也就没有这个方法；
 *   · 测试替身同理。
 * 方法不存在 ⇒ 清单为空 ⇒ 这**不是「不知道」**，而是「这个后端本轮没有跳过
 * 任何会话」—— 对这样的后端，空清单是**正确的事实**。
 * 因此这里绝不能因为「拿不到清单」就中断同步（那会把所有自带存储用户打死）。
 *
 * ⚠️ 反过来：方法**存在**却抛错 ⇒ 「本来该告诉我的清单拿不到」⇒ 事实未知 ⇒
 * 此时必须**中止**（fail-closed）：在覆盖模式下继续，就是拿「不知道哪些组被
 * 跳过」去覆盖本地 —— 那正是本文件要防的那场数据丢失。抛错上浮，引擎那一侧
 * 会回滚快照并如实报失败。
 */
import type { DownloadSkippedGroup, TabGroup } from '@/types/tab';
import { ensureBackendPrimed, getActiveSyncBackend } from '@/sync-backend';
import type { SyncBackendPort } from '@/sync-backend/ports';

/**
 * 端口上的「读不出来的那几组」清单（可选能力）。
 *
 * 端口上那条方法是**可选**的（见 SyncBackendPort.downloadSkippedGroups）：
 * 自带存储（WebDAV）遇到读不出来的分片是 fail-closed（整轮抛错中止），
 * 它**不产生跳过**，也就没有这个方法。
 */
type BackendWithSkippedGroups = SyncBackendPort & {
  downloadSkippedGroups?: () => Promise<DownloadSkippedGroup[]>;
};

export interface DownloadWithSkippedResult {
  /** 本轮**读到**的会话。 */
  groups: TabGroup[];
  /** 本轮**读不出来**而被整组跳过的会话（云端行仍在）。 */
  skipped: DownloadSkippedGroup[];
}

/**
 * 归一化后端给的清单：只保留有合法 id 的条目，去重，并保证返回数组。
 *
 * 为什么要归一化而不是原样透传：这份清单会驱动「覆盖模式下保留本机那几份」
 * 与「向用户报出到底有几组」两件事 —— 脏数据（缺 id / 重复 / 不是数组）
 * 在这里被过滤掉，比在引擎里逐处判空可靠。
 */
function normalizeSkipped(raw: unknown): DownloadSkippedGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: DownloadSkippedGroup[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const id = (item as { id?: unknown } | null | undefined)?.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const reason = (item as { reason?: unknown } | null | undefined)?.reason;
    out.push({ id, reason: (reason ?? 'processing_error') as DownloadSkippedGroup['reason'] });
  }
  return out;
}

/**
 * 读远端会话，并同时取回「本轮读不出来而被整组跳过」的清单。
 *
 * 失败语义：
 *   · `downloadGroups()` 失败 → 抛（与既有下载路径一致：整轮中止）；
 *   · `downloadSkippedGroups()` **不存在** → 空清单（该后端不产生跳过）；
 *   · `downloadSkippedGroups()` **存在但抛错** → 抛（事实未知 ⇒ fail-closed）。
 */
export async function downloadGroupsWithSkipped(): Promise<DownloadWithSkippedResult> {
  await ensureBackendPrimed();
  const backend = getActiveSyncBackend() as BackendWithSkippedGroups;

  const groups = await backend.downloadGroups();

  let raw: unknown;
  try {
    // 可选调用：方法不存在时 `raw` 恒为 undefined ⇒ 归一化后是空清单。
    raw = await backend.downloadSkippedGroups?.();
  } catch (err) {
    // 方法存在却拿不到清单 ⇒ 「本轮哪些组被跳过」这个问题没有答案。
    // 在覆盖模式下继续 = 拿「不知道」去覆盖本地（那正是要防的数据丢失）⇒ 中止。
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      '读不到「云端哪些会话这轮没能读下来」这份清单，已中止本轮下载' +
        '（fail-closed：不写入任何数据，以免把云端只是「没读到」的会话当成本机没有而删除）。' +
        `原始错误：${detail}`
    );
  }

  return { groups, skipped: normalizeSkipped(raw) };
}
