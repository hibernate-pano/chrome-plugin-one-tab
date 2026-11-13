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

/**
 * 会话卡片上的**站点摘要**（最多 3 个域名，按出现次数降序）。
 *
 * ── 为什么需要它（2026-11-06 首用体验走查）──────────────────────────────
 *
 * 默认名一律是保存时刻（`2026-10-25 14:30`，见 sessionName.ts）。这本身是对的
 * （不猜、不说谎），但它有一个直接代价：**同一分钟里保存两次**，
 * 两张卡片在名称、数量、时间三个维度上**完全相同** ⇒ 用户只能展开逐行读
 * 标签标题才能分辨哪张是哪张。真机实测（1.30.1）：
 *
 *     2026-11-06 09:34   2 个标签
 *     2026-11-06 09:34   2 个标签
 *
 * ⇒ 名字继续用时间戳（不改规则），另加一行**站点摘要**补上辨识度。
 *   这一行说的是**内容**的事实（这批标签来自哪些站点），不是替用户猜名字 ——
 *   它不进名字、不进幂等指纹、不参与搜索排序，只是卡片上的一行小字。
 *
 * ⚠️ 与 `deriveDominantHost`（导入命名用）**不是同一件事**：那个只取**一个**
 *   主导域名，且必须**确定性**（进指纹）。这里要的是「一眼看出这批是什么」，
 *   所以按出现次数取前几个，并列时按首次出现序 —— 纯展示，不承诺确定性。
 *
 * 非 http(s)（`file://` / `chrome://`）不贡献域名 ⇒ 全是本地文件时返回 `''`
 * （调用方据此不渲染这一行，而不是渲染一行空白）。
 */
export const getSessionHostSummary = (
  group: Pick<TabGroup, 'tabs'>,
  maxHosts = 3
): string => {
  const counts = new Map<string, number>();
  for (const tab of group.tabs) {
    // 只认 http(s) 的主机名：`file:` / `blob:` / `view-source:` 解析成功但
    // `hostname` 为空 ⇒ 它们不该被算成「站点」（与 getDisplayUrl 的回落规则
    // 同源，这里只需要判断「有没有站点身份」）。
    let host = '';
    try {
      const parsed = new URL(tab.url);
      if (/^https?:$/.test(parsed.protocol)) {
        host = normalizeHostForDisplay(parsed.hostname);
      }
    } catch {
      host = '';
    }
    if (!host) continue;
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  if (counts.size === 0) return '';

  // 按次数降序，并列时保留首次出现序（Map 的插入序）
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const shown = ordered.slice(0, maxHosts).map(([host]) => host);
  const rest = ordered.length - shown.length;
  return rest > 0 ? `${shown.join(' · ')} 等 ${ordered.length} 个站点` : shown.join(' · ');
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
