import { TabGroup } from '@/types/tab';
import { normalizeHostForDisplay } from '@/core/hostName';
import { hasUnknownSaveTime } from '@/core/sessionSaveTime';

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
 *
 * 2026-10-20 修：去 `www.` 的写法从 `replace('www.','')` 改成锚定的
 * `/^www\./`（见 `@/core/hostName` 的 `normalizeHostForDisplay`）。
 * 旧写法会命中域名**中间**的 `www.` —— `mywww.example.com` 被显示成
 * `myexample.com`，那是一个**不存在的域名**，用户照着它记忆/搜索/转述
 * 都会落空。归一化口径也统一到了 `core/hostName` 单源。
 */
export const getDisplayUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    return parsed.hostname ? normalizeHostForDisplay(parsed.hostname) : url;
  } catch {
    return url;
  }
};

/**
 * 相对时间（今天 / 昨天 / N 天前 / N 周前 / M月D日）—— 列表页卡片的时间位。
 *
 * ⚠️ **时间戳解析不出来时不许显示「Invalid Date」**（2026-10-25）：
 * 旧实现（`TabGroup.tsx` 里的局部 `formatTime`）在时间戳非法时会一路落到
 * `toLocaleDateString` ⇒ 界面上出现字面的 **「Invalid Date」**。
 * ⇒ 非法一律说「时间未知」。
 */
export const formatRelativeTime = (dateString: string): string => {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) {
    return '时间未知';
  }
  const diff = Date.now() - date.getTime();
  // ⚠️ 夹到 0：时间戳**比现在还晚**时（设备时钟不准、或另一台设备时钟超前），
  // `Math.floor` 会给出 **-1** ⇒ 界面上出现「-1 天前」（2026-10-25 修）。
  // 一个「刚刚保存的会话」说成「-1 天前」是胡说 ⇒ 一律按「今天」算。
  const days = Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));

  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
};

/**
 * 列表页卡片上的**时间位**文案。
 *
 * ── 为什么保存时间未知时要写「导入 · …」而不是「今天」（2026-10-25）────────
 *
 * 来源格式不带时间戳的导入件（OneTab）**没有保存时间**。旧写法直接拿
 * `createdAt`（= 导入那一刻）去格式化 ⇒ 卡片上写着「今天」⇒
 * **界面在撒谎**：这些标签页是两年前存的。
 *
 * ⇒ 改说「导入 · 今天」/「导入 · 10-23」：**只说真的事** ——
 * 「什么时候进到本机」是真话，「什么时候保存的」我们不知道，就不装作知道。
 */
export const formatSessionTimeLabel = (group: {
  createdAt: string;
  importedAt?: string;
}): string => {
  if (hasUnknownSaveTime(group) && group.importedAt) {
    return `导入 · ${formatRelativeTime(group.importedAt)}`;
  }
  return formatRelativeTime(group.createdAt);
};

export const getSessionResultSummary = (
  group: Pick<TabGroup, 'tabs' | 'createdAt' | 'importedAt'>,
  matchedCount: number
) => {
  // 秒对找回会话没有信息量，meta 行只精确到分
  const formatStamp = (value: string): string => {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? ''
      : date.toLocaleString('zh-CN', {
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
  };

  // 保存时间未知 ⇒ 说「导入于 …」，**不说**「保存于 …」（2026-10-25）。
  const unknownSaveTime = hasUnknownSaveTime(group);
  const stampSource = unknownSaveTime ? group.importedAt : group.createdAt;
  const savedTime = stampSource ? formatStamp(stampSource) : '';

  if (!savedTime) {
    return `匹配 ${matchedCount}/${group.tabs.length} 个标签`;
  }

  return unknownSaveTime
    ? `匹配 ${matchedCount}/${group.tabs.length} 个标签 · 导入于 ${savedTime}`
    : `匹配 ${matchedCount}/${group.tabs.length} 个标签 · 保存于 ${savedTime}`;
};
