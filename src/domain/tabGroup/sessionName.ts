import { isLocalOrIpHost, normalizeHostForDisplay } from '@/core/hostName';

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * 默认会话名：**保存时刻的时间戳**（如「2026-10-25 14:30」）。
 *
 * ── 为什么是时间戳（2026-10-25 产品定案）────────────────────────────────
 *
 * 旧口径是「取出现最多的域名 → 首个有意义的标题 → 时间戳」，也就是
 * **插件替用户猜这个会话叫什么**。猜错的那一次不是「名字不好听」，
 * 是**一个错的名字钉在卡片上**，用户还得手动去改 —— 而卡片标题只有一行，
 * 改名的入口藏在菜单里。
 *
 * ⇒ 新口径：**默认给一个不会说谎的名字**（保存时刻），**让用户自己调整**。
 *   ⚠️ 2026-10-25 产品负责人**推翻了**中途加的「全都来自同一个网站就用网站名」
 *   这条例外 ⇒ 现在**没有例外**：**全部**默认时间戳。
 *   理由：那条例外本身就是「猜」——「这批标签恰好都来自同一个网站」是
 *   **内容**的事实，不是**这次保存**的事实；它会让人以为名字在说
 *   「这批东西是关于 github 的」，而真实语义只是「这批东西来自 github」。
 *   而**同一个网站**这个事实，用户在标签行右侧**本来就能看到**（那里显示域名）
 *   ⇒ 名字不必再兼职承载站点身份。
 *
 * ── 格式为什么是 `2026-10-25 14:30` ──────────────────────────────────────
 *
 * ① **零填充、固定宽**：卡片标题行右侧还有数量徽章与时间，
 *    定长（16 字）才不会把它们挤走（真的超长时由 CSS 的 `truncate` 兜底）。
 * ② **字典序 == 时间序**：「10月25日」按字典序排在「9月20日」**后面**
 *    （"1" < "9"）⇒ 用月日格式时，「按名称」排序会把 10 月排到 9 月前面。
 *    零填充的 `2026-10-25 14:30` 没有这个问题 ⇒ **按名称排序顺带就是按时间排序**。
 * ③ **带年份**：「10-25」分不清是去年还是今年。
 * ④ **不写秒**：同一分钟里存两次就是两个同名会话，写秒只是更长的噪声。
 *
 * ⚠️ 用**本地时间**（与卡片上「今天/昨天/N 天前」那套相对时间同一时区口径）。
 */
export const buildTimestampSessionName = (now: string) => {
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) return '未命名会话';
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hours = pad2(date.getHours());
  const minutes = pad2(date.getMinutes());
  return `${year}-${month}-${day} ${hours}:${minutes}`;
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
 * ⇒ 这里补一份**后缀**清单，让内网/自建主机在**导入命名与显示**时**带上端口**。
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
 * 从一个 URL 里提取**主机名**（单一真相源）。
 *
 * ⚠️ 2026-10-25：默认会话名**一律**是保存时刻 ⇒ host **不再**出现在
 * 新会话的名字里。本函数现在只服务两处：
 * ① **OneTab 文本导入**的会话名（`deriveDominantHost`）；
 * ② **标签行显示的域名**（`utils/sessionPresentation.ts`）。
 * ⇒ 口径一个字没松，只是**消费方**换了。
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
 * ── 谁在用它（2026-10-25 起只剩一处）─────────────────────────────────────
 *
 * ⚠️ 保存路径**不再**用它（新产品口径：默认名**一律**是保存时刻，
 * 名字里**不出现**任何域名）。
 * 现在**唯一**的调用方是 **OneTab 文本导入**的命名（`deriveImportedGroupName`）——
 * 导入的组名会进**幂等指纹**（组名 + URL 集合）⇒ 必须是**确定性**的
 * ⇒ 既不能用时间戳，也就不适合换成别的规则
 * （跨站的组会从「主导域名」变成「导入的会话 N」⇒ 老文件重新导入时
 * 指纹对不上 ⇒ 判重失效 ⇒ 产生整份副本）。
 *
 * 【口径不变的部分】哪些 host 算、怎么去 www、并列取谁 —— 都还在这里，
 * 导入路径继续用它。
 *
 * 【取不到时返回 null，而不是时间戳】
 * 调用方需要区分「取到了域名」与「没取到」：
 *  · 导入路径：没取到 ⇒ 回落「导入的会话 N」
 *    （**不能**用时间戳 —— 导入的组名会进幂等指纹，
 *      而时间戳是**非确定性**的 ⇒ 同一份文件导两次会算出不同指纹
 *      ⇒ 判重失效 ⇒ 产生整份副本。这正是「导入的会话 N」用序号
 *      而不是时间戳的原因。）
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
