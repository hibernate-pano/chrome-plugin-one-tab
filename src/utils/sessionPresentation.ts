import { TabGroup } from '@/types/tab';

/**
 * 标签行里显示的 URL 短形态：域名（去掉 `www.`）。
 *
 * ⚠️ **不能只取 `hostname`**：`view-source:` / `file:` / `blob:` 这些**非特殊 scheme** 的
 * URL 解析**成功**但 `hostname` 是空串，于是 catch 不触发、URL 列渲染成空白 ——
 * 而这些恰好是「本设备打不开」、最需要说明的一族（列表页与搜索页都读它）。
 * hostname 为空时回落到原 URL，与「URL 解析不了」同一条兜底。
 *
 * 2026-10-18 修：改前 `view-source:` / `file:` / `blob:` / `about:blank` 的 URL 列
 * 真机实测全是空串（两处调用方各写了一份同样的实现，故一并收到这里）。
 */
export const getDisplayUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    return parsed.hostname ? parsed.hostname.replace('www.', '') : url;
  } catch {
    return url;
  }
};

export const getSessionResultSummary = (group: Pick<TabGroup, 'tabs' | 'createdAt'>, matchedCount: number) => {
  const savedAt = new Date(group.createdAt);
  // 秒对找回会话没有信息量，meta 行只精确到分
  const savedTime = Number.isNaN(savedAt.getTime())
    ? ''
    : savedAt.toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  if (!savedTime) {
    return `匹配 ${matchedCount}/${group.tabs.length} 个标签`;
  }

  return `匹配 ${matchedCount}/${group.tabs.length} 个标签 · 保存于 ${savedTime}`;
};
