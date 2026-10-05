/**
 * tab ↔ TabData 编解码（纯函数，规格 §5.3）：
 * tab 级操作印记（lastOp = { d, s }）经 tabs_data JSON 上云往返。
 * 双向约定：印记缺失 ↔ null（云端 NULL 视为全序最小值，兼容迁移前数据与老客户端）。
 *
 * ── 2026-10-05：反序列化不再丢弃「打不开」的标签 ──────────────────────
 * 修复前 deserializeTab 对每个 URL 调 sanitizeTabUrl（当时语义 =「可打开」），
 * 判 null 就把整个 tab 丢掉。叠加后果（用户线上日志已证实）：
 *   保存侧放行 file:/blob:/devtools: → 云端存得进去；
 *   还原侧把它们全滤掉 → 「存得下、回不来」。
 * 再叠加还原率判据按**整组**生效（MIN_RESTORABLE_TAB_RATIO），一个 3 标签的
 * 组里 2 个是 file: 就会 0.33 < 0.5，连同那个正常的 https 标签一起被隐藏；
 * 而这在无回收站模型下不可逆（云端行永不被改写，对端重写也还是同一个 URL）。
 *
 * 现在：
 *   - **危险 schema**（javascript:/vbscript:/data:）仍拒 → 返回 null，丢弃；
 *   - **打不开但有保存价值**（file:/blob:/devtools:…）→ 保留，标 unopenable；
 *   调用方据此在 UI 上降级显示，而不是把用户的数据从数据里抹掉。
 */
import type { Tab, TabData } from '../types/tab';
import { isStorableTabUrl, isOpenableTabUrl } from '../utils/inputValidation';

export function serializeTab(tab: Tab): TabData {
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    favicon: tab.favicon,
    created_at: tab.createdAt,
    last_accessed: tab.lastAccessed,
    pinned: tab.pinned,
    is_deleted: tab.isDeleted || undefined,
    deleted_at: tab.deletedAt ?? undefined,
    last_op_device: tab.lastOp?.d ?? null,
    last_op_seq: typeof tab.lastOp?.s === 'number' ? tab.lastOp.s : null,
  };
}

/**
 * 反序列化一行 tabs_data。
 *
 * @returns 成功返回 Tab；**危险 schema / 形状非法**返回 null（调用方过滤）。
 *   「可存储但当前设备打不开」的 URL 返回的 Tab 带 `unopenable: true`，
 *   调用方应保留并降级显示，**不可**当 null 丢弃。
 */
export function deserializeTab(data: TabData, groupId: string): Tab | null {
  // 危险 schema / 形状非法 → 拒收（这两类本就不该进数据库）
  if (!isStorableTabUrl(data.url)) return null;
  const url = String(data.url).trim();
  return {
    id: data.id,
    url,
    title: data.title,
    favicon: data.favicon,
    createdAt: data.created_at,
    lastAccessed: data.last_accessed,
    group_id: groupId,
    pinned: data.pinned ?? false,
    isDeleted: data.is_deleted === true ? true : undefined,
    deletedAt: data.deleted_at ?? undefined,
    lastOp:
      typeof data.last_op_seq === 'number' && data.last_op_device
        ? { d: String(data.last_op_device), s: data.last_op_seq }
        : undefined,
    /**
     * 能否重新打开与「能否存储」是两件事（见文件头）。这个标记让 UI 可以
     * 说清「这个标签在当前设备打不开」，而不是假装它不存在。
     */
    unopenable: isOpenableTabUrl(url) ? undefined : true,
  };
}
