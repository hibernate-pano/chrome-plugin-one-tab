/**
 * tab ↔ TabData 编解码（纯函数，规格 §5.3）：
 * tab 级操作印记（lastOp = { d, s }）经 tabs_data JSON 上云往返。
 * 双向约定：印记缺失 ↔ null（云端 NULL 视为全序最小值，兼容迁移前数据与老客户端）。
 * 反序列化保留 sanitizeTabUrl 防线（危险协议拒绝、loading:// 占位符保留）。
 */
import type { Tab, TabData } from '@/types/tab';
import { sanitizeTabUrl } from '@/utils/inputValidation';

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
    last_op_device: tab.lastOp?.d ?? null,
    last_op_seq: typeof tab.lastOp?.s === 'number' ? tab.lastOp.s : null,
  };
}

/** 反序列化一行 tabs_data；URL 危险/非法时返回 null（调用方过滤） */
export function deserializeTab(data: TabData, groupId: string): Tab | null {
  const url = sanitizeTabUrl(data.url);
  if (!url) return null;
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
    lastOp:
      typeof data.last_op_seq === 'number' && data.last_op_device
        ? { d: String(data.last_op_device), s: data.last_op_seq }
        : undefined,
  };
}
