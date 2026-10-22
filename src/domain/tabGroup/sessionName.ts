import { isLocalOrIpHost, normalizeHostForDisplay } from '@/core/hostName';

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * 默认会话名：**最后一道**兜底 —— 短格式时间戳（如「标签组 9月12日 19:51」）。
 * 不带秒与年份——列表里已有相对时间（今天/昨天/N 天前），
 * 完整时间戳在窄宽度下会先被截掉尾部的有效信息。
 *
 * 【什么时候才会走到这里】只有「连域名都没有、连一个有意义的标题都没有」
 * 时（全是 `about:blank` / `chrome://` 且标题也是空的）。
 * 2026-10-22 审计 U-06 之前，它是**第二**道兜底 —— 内网/localhost 场景
 * 全部落到这里 ⇒ 一屏 10 张卡全是「标签组 10月22日 09:12」，
 * 连站点身份都没有（favicon 也救不了：连域名都没有）。
 */
export const buildTimestampSessionName = (now: string) => {
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) return '标签组';
  return `标签组 ${date.getMonth() + 1}月${date.getDate()}日 ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
};

/**
 * 内网 / 自建服务的域名后缀。
 *
 * ── 为什么需要这一份清单 ─────────────────────────────────────────────────
 * `isLocalOrIpHost`（`@/core/hostName`）判的是「这是不是一个用户会拿去
 * 记忆工作现场的**公共**域名」—— 它把 `localhost` / IP / 单标签主机名
 * 判成本机地址，把 `myhost.local` 判成**普通域名**（它确实有、不是 IP）。
 *
 * 但对「这条地址是内网服务」这件事，`myhost.local` / `wiki.internal` 与
 * `192.168.1.5` 是**同一类**：它们是自建服务，端口往往才是区分不同服务的
 * 唯一线索（`wiki.local:8080` 与 `git.local:3000` 是两个东西）。
 *
 * ⇒ 这里补一份**后缀**清单，让内网/自建主机在命名时**带上端口**。
 *
 * 【为什么不把它放进 `@/core/hostName`】那才是它该待的地方（host 语义的
 * 单一真相源）。但本轮的文件边界只允许改 `domain/tabGroup/` 下的文件，
 * 强行绕过边界去改共享单源，会和其他并行改动撞车。
 * ⇒ 先在这里落地，**下一轮应当整体搬进 `core/hostName.ts`**，
 * 让「内网主机」这个概念仍然只有一份定义。
 */
const INTRANET_HOST_SUFFIXES: readonly string[] = [
  '.local', // RFC 6762 mDNS 保留
  '.localdomain', // Debian / 家用路由惯例
  '.internal', // Google Cloud 内部域
  '.lan', // 家用局域网惯例
  '.home.arpa', // RFC 8375 家用域
  '.intranet', // 企业内网惯例
  '.corp', // 企业内网惯例
  '.private', // 家用/私有域惯例
];

/**
 * 这个 host 是不是「本机 / 内网 / 自建服务」。
 *
 * = `isLocalOrIpHost`（localhost、IPv4、IPv6、单标签主机名）
 *   ∪ 内网后缀（`.local` / `.internal` / …）
 *
 * 【为什么不直接用 `isLocalOrIpHost` 就够了】那会把 `myhost.local`
 * 当成公网域名 ⇒ 命名时不带端口 ⇒ `wiki.local:8080` 与 `wiki.local:9090`
 * 命名结果相同 ⇒ 用户还是分不清（正是 U-06 要解决的那类「一屏全一样」）。
 */
const isIntranetHost = (host: string): boolean => {
  if (!host) return false;
  if (isLocalOrIpHost(host)) return true;
  const normalized = normalizeHostForDisplay(host);
  return INTRANET_HOST_SUFFIXES.some(suffix => normalized.endsWith(suffix));
};

/**
 * 从一个 URL 里提取**用于命名的主机名**（单一真相源）。
 *
 * ── 口径（2026-10-22 审计 U-06）──────────────────────────────────────────
 *
 * | URL                          | 结果             |
 * |------------------------------|------------------|
 * | `https://github.com/a`       | `github.com`     |
 * | `https://www.example.com/a`  | `example.com`    |
 * | `http://localhost:3000/x`    | `localhost:3000` |
 * | `http://192.168.1.5/admin`   | `192.168.1.5`    |
 * | `http://[::1]:8080/`         | `[::1]:8080`     |
 * | `http://myhost.local:8080/`  | `myhost.local:8080` |
 * | `chrome://settings`          | `null`           |
 * | `file:///Users/me/paper.pdf`  | `null`           |
 * | `about:blank`                | `null`           |
 *
 * ── 两条规则 ──────────────────────────────────────────────────────────────
 *
 * ① **非 http(s) 协议一律不贡献主机名**。
 *    `chrome://` / `file://` / `about:` / `data:` / `blob:` / `devtools://`
 *    这些协议**根本没有主机**（`file:` 与 `about:` 连 hostname 都是空串），
 *    把它们算进来只会得到 `settings`、`blank` 这种**噪声**。
 *
 * ② **内网 / 本地主机带端口，公网域名不带**。
 *    端口是「同一个 host 上的不同服务」的唯一区分线索
 *    （`localhost:3000` 与 `localhost:8080` 是两个完全不同的项目）；
 *    而公网域名的端口几乎总是默认端口，带上它只是噪声 —— 且
 *    「公网域名不带端口」是既有行为，不在这里改。
 *
 * 【IPv6 为什么保留方括号】`[::1]:8080` 才是**可被粘贴回地址栏**的写法
 * （`::1:8080` 不是合法地址）。归一化时去掉方括号是为了显示，
 * 这里要拼端口，就得把它加回去。
 */
export const extractNamingHost = (url: string | undefined): string | null => {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // ① 非 http(s)：根本没有主机
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const hostname = normalizeHostForDisplay(parsed.hostname);
  if (!hostname) return null;

  // ② 公网域名：既有口径，不带端口
  if (!isIntranetHost(hostname)) return hostname;

  // 内网 / 本地 / 自建：带上端口（IPv6 要把方括号加回去才能粘回地址栏）
  const hostPart = hostname.includes(':') ? `[${hostname}]` : hostname;
  return parsed.port ? `${hostPart}:${parsed.port}` : hostPart;
};

/**
 * 从一组 URL 里派生**主导主机名**（出现次数最多的那个），取不到返回 null。
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
 *  · 保存路径：没取到 ⇒ 回落标题 ⇒ 再回落时间戳
 *  · 导入路径：没取到 ⇒ 回落「导入的会话 N」
 *    （**不能**用时间戳 —— 导入的组名会进幂等指纹，
 *      而时间戳是**非确定性**的 ⇒ 同一份文件导两次会算出不同指纹
 *      ⇒ 判重失效 ⇒ 产生整份副本。这正是「导入的会话 N」用序号
 *      而不是时间戳的原因。）
 *
 * 【口径变更记录】2026-10-22 审计 U-06 之前，本机 / 内网 / IP 一律返回
 * null ⇒ 内网场景全部落进时间戳名。现在它们**也**产出主机名
 * （`localhost:3000` / `192.168.1.5` / `[::1]:8080`）——
 * 因为对自建服务来说，主机名**就是**用户记忆工作现场的方式。
 */
export const deriveDominantHost = (urls: readonly (string | undefined)[]): string | null => {
  const counts = new Map<string, number>();
  for (const url of urls) {
    const host = extractNamingHost(url);
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
 * 浏览器给空白标签页的**默认标题** —— 这些标题**没有任何信息量**。
 *
 * 【为什么必须把它们排除】Chrome（中文）给新标签页的标题是「新标签页」，
 * 英文环境是「New Tab」，Firefox 的新标签页也是「New Tab」。
 * 若把它们当会话名，用户会得到一屏的「新标签页」——
 * 那和「标签组 10月22日 09:12」一样没用，只是换了个写法。
 *
 * 【为什么要大小写不敏感】英文环境下 `New Tab` / `New tab` / `NEW TAB`
 * 都可能出现（Chrome 的 UI 语言、操作系统语言、网页 `<title>` 都可能影响）。
 * ⇒ 统一小写后比较。
 */
const DEFAULT_TAB_TITLES: ReadonlySet<string> = new Set([
  '新标签页',
  '新标签',
  'new tab',
  'new tab page',
]);

/**
 * 会话名的标题**长度上限**（含省略号）。
 *
 * 【为什么是 24】会话名要能塞进卡片标题行（`.tab-group-title`）。
 * 标题行右侧还有数量徽章与时间，24 个字符是「在 1280px 卡片里不换行、
 * 也不把徽章挤走」的上限。超出就裁剪 + 省略号。
 */
export const MAX_SESSION_TITLE_LENGTH = 24;

/**
 * 这个标题**有信息量**吗？
 *
 * 「有信息量」= 非空，且不是浏览器给空白页的默认标题。
 */
export const isMeaningfulTabTitle = (title: string | undefined | null): boolean => {
  if (!title) return false;
  const trimmed = title.trim();
  if (!trimmed) return false;
  return !DEFAULT_TAB_TITLES.has(trimmed.toLowerCase());
};

/**
 * 把标题裁剪到会话名的长度上限（超出加省略号）。
 *
 * 【为什么裁剪而不是原样塞进去】卡片标题行的宽度有限，
 * 一个 60 字的页面标题会把数量徽章与时间挤到第二行，
 * 甚至把「保存时间」挤出卡片 —— 名字变长了，别的信息没了。
 */
export const truncateSessionTitle = (
  title: string,
  maxLength: number = MAX_SESSION_TITLE_LENGTH
): string => {
  const trimmed = title.trim();
  if (trimmed.length <= maxLength) return trimmed;
  // 省略号本身占一个字符 ⇒ 内容截到 maxLength - 1
  return `${trimmed.slice(0, Math.max(1, maxLength - 1))}…`;
};

/**
 * 从标签页派生会话名（2026-10-20 审计 A-16；2026-10-22 审计 U-06/U-19 改链）。
 *
 * ── 取值链 ───────────────────────────────────────────────────────────────
 *
 *   ① **主导主机名**（出现次数最多的那个域名）
 *      —— 「那是 github.com 上那个 PR」「那个 figma 文件」，
 *         用户心里「这个工作现场的主场」通常就是打开最多次的站点；
 *         并列时取**第一个**（结果稳定，不随标签顺序抖动）。
 *   ② **首个有意义的标签标题**（裁剪到 24 字）
 *      —— 兜底场景 ① 完全失效时（全是 `about:blank` / `chrome://`，
 *         或内网地址解析不出主机名）。
 * ③ **时间戳**（`标签组 M月D日 HH:MM`）—— 最后一道，连标题都没有时。
 *
 * ── 为什么②不能省（U-06 的真正根因）────────────────────────────────────
 *
 * U-06 现场：一屏 10 张卡全是「标签组 10月22日 09:12」「标签组 10月22日 09:47」。
 * 根因不是「没有 favicon」，而是**默认名里根本没有站点身份**：
 * `deriveDominantHost` 对 localhost / IP / 非 http 协议返回 null，
 * 于是内网、自建服务、本地开发场景**全部**落进时间戳兜底。
 * ⇒ ① 现在也覆盖内网主机；② 补上「连主机名都没有」的那一格。
 *
 * 不在名字里带标签数：卡片右侧已有数量徽章（`tab-group-count`），
 * 重复一遍是噪声。
 */
export const deriveSessionNameFromChromeTabs = (
  tabs: chrome.tabs.Tab[],
  now: string
) => {
  const safeTabs = tabs ?? [];
  // 空串不是 nullish：`tab.url ?? tab.pendingUrl` 在 url 为 '' 时会短路成
  // ''（加载中的标签正是这种形状：url:'' + pendingUrl:'https://…'），
  // 于是域名取不到、名字退回时间戳 —— 恰好在最需要可读名字的时候失效。
  // 判据与 factory 的 resolveStorableUrl 同源：先正式 url，再 pendingUrl。
  const urls = safeTabs.map(tab =>
    tab.url && tab.url.length > 0 ? tab.url : tab.pendingUrl
  );

  // ① 主导主机名
  const host = deriveDominantHost(urls);
  if (host) return host;

  // ② 首个有意义的标签标题（数组里靠前的那个）
  const titled = safeTabs.find(tab => isMeaningfulTabTitle(tab.title));
  if (titled?.title) return truncateSessionTitle(titled.title);

  // ③ 时间戳（最后一道）
  return buildTimestampSessionName(now);
};
