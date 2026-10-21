import { isLocalOrIpHost, normalizeHostForDisplay } from '@/core/hostName';

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * 默认会话名：短格式时间戳（如「标签组 9月12日 19:51」）。
 * 不带秒与年份——列表里已有相对时间（今天/昨天/N 天前），
 * 完整时间戳在窄宽度下会先被截掉尾部的有效信息。
 */
export const buildTimestampSessionName = (now: string) => {
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) return '标签组';
  return `标签组 ${date.getMonth() + 1}月${date.getDate()}日 ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
};

/**
 * 从标签页里提取**可检索的域名**（2026-10-20 审计 A-16）。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────────
 * 产品的承诺是「保存 → 之后找回」（README:26-28）。而「找回」这一步此前
 * **没有任何产品级支撑**：默认会话名只有时间戳（`标签组 9月12日 19:51`），
 * 保存时也无法命名（只能事后点标题重命名）。
 *
 * 攒到 20 个会话，列表就是一列时间戳 —— 用户必须靠搜索框找回，
 * 而搜索要能命中，前提是标签标题与 URL 还在。于是**唯一能证明「这是
 * 哪个工作现场」的信息（标题、域名）没有出现在列表里**。
 *
 * 竞品对比也指向同一处：OneTab 2026 年新增了 folders / search，
 * 它的默认组名同样是时间戳 —— 这正是它的用户抱怨「我有一堆叫
 * "Saved 9/12" 的组，分不清哪个是哪个」的原因。
 *
 * ── 为什么域名比标题好 ───────────────────────────────────────────────────
 * · 标题会重复（「GitHub」在三个标签里出现三次），且常常很长
 *   （「Pull Request #1234 · Fix the sync bug」），在卡片标题位会被截断；
 * · 域名短、稳定、且**用户就是用它来记忆工作现场的**
 *   （「那是 github.com 上那个 PR」「那个 figma 文件」）；
 * · 同一域名下多个标签时，域名给出的是**上下文**而非条目。
 *
 * ── 边界处理 ─────────────────────────────────────────────────────────────
 * · 非 http(s)（chrome://、file://、扩展页）→ 不贡献域名
 * · 无 host（localhost、data:）→ 不贡献域名
 * · 本机 / 内网 / IP 字面量（`127.0.0.1`、`[::1]`、`192.168.1.5`、`wiki`）
 *   → 不贡献域名（判据见 `@/core/hostName` 的 `isLocalOrIpHost`）
 * · 全部标签都取不到域名 → 回落到时间戳（保持既有行为，不给用户
 *   一个空名字或「标签组」这种无信息的名字）
 */
const extractHost = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const host = normalizeHostForDisplay(parsed.hostname);
    if (!host || isLocalOrIpHost(host)) return null;
    return host;
  } catch {
    return null;
  }
};

/**
 * 从一组 URL 里派生**主导域名**（出现次数最多的那个），取不到返回 null。
 *
 * ── 为什么要抽成独立函数（2026-10-20 审计 A-20）────────────────────────
 *
 * 「按域名命名」这条规则现在有**两个**调用方：
 *  · 保存时给新会话命名（`deriveSessionNameFromChromeTabs`）
 *  · OneTab 导入时给会话命名（`deriveImportedGroupName`）
 *
 * 两处必须**同一把尺子** —— 否则同一条内容在「保存」与「导入」两条路上
 * 会得到不同的名字，用户看到的是「同一个工作现场叫两个名字」。
 * ⇒ 口径（哪些 host 算、怎么去 www、并列取谁）只写在这一个函数里。
 *
 * 【取不到时返回 null，而不是时间戳】
 * 调用方需要区分「取到了域名」与「没取到」：
 *  · 保存路径：没取到 ⇒ 回落时间戳（`buildTimestampSessionName`）
 *  · 导入路径：没取到 ⇒ 回落「导入的会话 N」
 *    （**不能**用时间戳 —— 导入的组名会进幂等指纹，
 *      而时间戳是**非确定性**的 ⇒ 同一份文件导两次会算出不同指纹
 *      ⇒ 判重失效 ⇒ 产生整份副本。这正是「导入的会话 N」用序号
 *      而不是时间戳的原因。）
 */
export const deriveDominantHost = (urls: readonly (string | undefined)[]): string | null => {
  const counts = new Map<string, number>();
  for (const url of urls) {
    const host = extractHost(url);
    if (!host) continue;
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  if (counts.size === 0) return null;

  // 找出出现次数最多的域名；并列时保留最先出现者（Map 保持插入序）
  let bestHost = '';
  let bestCount = 0;
  for (const [host, count] of counts) {
    if (count > bestCount) {
      bestHost = host;
      bestCount = count;
    }
  }
  return bestHost || null;
};

/**
 * 从标签页派生会话名（2026-10-20 审计 A-16）。
 *
 * 策略：**域名**（例如「github.com」）。
 * 域名取**出现次数最多**的那个（用户心里「这个工作现场的主场」通常是
 * 打开最多次的站点）；并列时取**第一个**（保持结果稳定，不随标签顺序抖动）。
 *
 * 不在名字里带标签数：卡片右侧已有数量徽章（`tab-group-count`），
 * 重复一遍是噪声。
 *
 * 没有域名时回落到时间戳。
 */
export const deriveSessionNameFromChromeTabs = (
  tabs: chrome.tabs.Tab[],
  now: string
) => {
  // 空串不是 nullish：`tab.url ?? tab.pendingUrl` 在 url 为 '' 时会短路成
  // ''（加载中的标签正是这种形状：url:'' + pendingUrl:'https://…'），
  // 于是域名取不到、名字退回时间戳 —— 恰好在最需要可读名字的时候失效。
  // 判据与 factory 的 resolveStorableUrl 同源：先正式 url，再 pendingUrl。
  const urls = (tabs ?? []).map(tab =>
    tab.url && tab.url.length > 0 ? tab.url : tab.pendingUrl
  );
  return deriveDominantHost(urls) ?? buildTimestampSessionName(now);
};
