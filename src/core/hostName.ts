/**
 * 主机名（host）的**归一化与分类** —— 单一真相源（2026-10-20 第三轮审计 L-17）。
 *
 * ── 为什么需要这个模块 ────────────────────────────────────────────────────
 *
 * 仓库里曾有**三处**各写一份「这个 host 算不算域名」的判定：
 *   ① `src/domain/tabGroup/sessionName.ts` 的 `extractHost`
 *      —— 决定会话名显示「github.com」还是退回时间戳；
 *   ② `src/utils/sessionPresentation.ts` 的 `getDisplayUrl`
 *      —— 决定标签行里 URL 列显示成什么样；
 *   ③ `src/utils/search.ts` 的域名过滤/建议
 *      —— 决定「按域名筛选」命中什么。
 *
 * 三份判据**不等价**，于是同一条地址在不同界面里长成不同样子：
 *   · `http://[::1]:8080/` —— ① 判「不是域名」退回时间戳，
 *     ② 显示成 `[::1]`，③ 域名过滤里出现 `[::1]` 这个选项；
 *   · `https://mywww.example.com/` —— ② 用 `replace('www.','')`（**非锚定**）
 *     把它显示成 `myexample.com`（域名**被改错了**），而 ① 用锚定的
 *     `/^www\./` 显示成 `mywww.example.com`（正确）。
 *
 * 后者尤其恶劣：用户看到的是**一个不存在的域名**。他按这个域名去记忆、
 * 搜索、或者跟同事说「那个 myexample.com 上的页面」——全都不对。
 *
 * ── 判据（按语义，不按字面量） ────────────────────────────────────────────
 *
 * ① **归一化**（`normalizeHostForDisplay`）：展示用一律去**锚定**的 `www.` 前缀。
 *    非锚定的 `replace('www.','')` 会命中域名**中间**的 `www.`，
 *    把 `mywww.example.com` 变成 `myexample.com` —— 那是错的域名。
 *    同时去掉末尾的根点（`localhost.` ≡ `localhost`）与方括号
 *    （`[::1]` → `::1`），因为 URL 解析器会把这些写法保留下来。
 *
 * ② **分类**（`isLocalOrIpHost`）：判断这个 host 是不是「用户会拿来记忆
 *    工作现场的公共域名」的**反面** —— 本机地址、内网地址、IP 字面量。
 *    这三种都会退回时间戳命名，因为「标签组 10月20日 10:30」至少诚实，
 *    而 `192.168.1.5` / `[::1]` 只是噪声，用户记不住也用不上。
 *
 *    ⚠️ 判据必须覆盖 **IPv6**：原先只判 IPv4 正则
 *    （`/^\d+\.\d+\.\d+\.\d+$/`），于是 `127.0.0.1` 退回时间戳、
 *    `[::1]` 却当域名用上了 —— **同一个意思、两种结果**，
 *    而文案承诺的是「取不到域名时（本地地址、内网地址等）退回时间戳」。
 *
 * ── 为什么不放在 utils ────────────────────────────────────────────────────
 * 这不是「某个工具函数」，而是**跨层共享的语义判定**：domain（命名）、
 * utils（展示）、utils（搜索）都要读它。放 `src/core/` 正是本仓
 * 放跨层共享逻辑的地方（见 `src/core/managerPage.ts` 的同类理由）。
 */

/**
 * 展示用的 host 归一化：
 *   · 去**锚定**的 `www.` 前缀（`/^www\./`，不是 `replace('www.','')`）；
 *   · 去末尾根点（`example.com.` → `example.com`）；
 *   · 去 IPv6 的方括号（`[::1]` → `::1`）。
 *
 * 【为什么必须锚定】`replace('www.','')` 会命中域名**中间**的 `www.`：
 * `mywww.example.com` → `myexample.com`。那不是去掉前缀，
 * 那是**把域名改错了** —— 用户看到的是一个不存在的域名。
 */
export const normalizeHostForDisplay = (hostname: string): string => {
  if (!hostname) return '';
  let host = hostname.trim().toLowerCase();
  // IPv6 字面量：URL 解析器保留方括号（`[::1]`），展示时不必带
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  // 末尾根点（FQDN 写法）：`localhost.` 与 `localhost` 是同一个主机
  while (host.endsWith('.')) {
    host = host.slice(0, -1);
  }
  // 只去**开头**的 www.
  if (host.startsWith('www.')) {
    host = host.slice(4);
  }
  return host;
};

/**
 * 这个 host 是不是「本机 / 内网 / IP 字面量」—— 也就是**不该**被当成
 * 可记忆的公共域名。
 *
 * 覆盖：
 *   · `localhost` 及其子域（`foo.localhost`）与带尾点的写法；
 *   · IPv4 字面量（`127.0.0.1`、`192.168.1.5`、`0.0.0.0`）；
 *   · IPv6 字面量（`::1`、`fe80::1`、`::ffff:127.0.0.1`）；
 *   · 单标签主机名（`wiki`、`intranet`）—— 没有点，不是公共域名。
 *
 * 【为什么单标签主机名也算】`http://wiki/x` 能解析，但 `wiki` 不是
 * 公共域名 —— 它是内网主机名。把它当域名显示出来，用户拿它去别处
 * 找（记忆、搜索、跟人描述）只会得到「打不开」。
 *
 * 【为什么不判「内网网段」】`192.168.x.x` / `10.x.x.x` 已被
 * 「IPv4 字面量」这一条覆盖。判「内网网段」而不判「IP 字面量」
 * 会漏掉公网 IP（`1.1.1.1` 也不是用户记忆工作现场的方式）。
 */
export const isLocalOrIpHost = (host: string): boolean => {
  if (!host) return true;
  const normalized = normalizeHostForDisplay(host);
  if (!normalized) return true;

  // IPv6 字面量：归一化后已去掉方括号，含冒号
  if (normalized.includes(':')) return true;

  // IPv4 字面量
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(normalized)) return true;

  // localhost 及其子域
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;

  // 单标签主机名（无点）—— 内网主机名，不是公共域名
  if (!normalized.includes('.')) return true;

  return false;
};

/**
 * 「按域名筛选」时的匹配判据（`hostMatchesDomainFilter`）。
 *
 * 筛选是**子串匹配**（用户输入 "example" 期望看到所有 example.* 的标签），
 * 判据必须同时满足两件事：
 *   ① 用户在**地址栏**看到的写法（`www.example.com`）能匹配上
 *      —— 而标签行里**显示**的是归一化后的 `example.com`；
 *   ② 旧行为不能被悄悄改掉 —— 用户输入 "www" 时，原本所有 www 主机都该命中。
 *
 * ⇒ 取两个判据的**并集**：归一化后互含，或**原始**写法互含。
 *
 * 【为什么不只做归一化互含】只做归一化的话，"www" 这个过滤词会在
 * 归一化后失配（显示形态里已经没有 www 了）—— 那是**缩小**了筛选范围，
 * 属于「改了产品行为」，不是「修了显示不一致」。
 *
 * 【为什么不只做原始互含】那就是现状：用户照抄地址栏的 `www.example.com`
 * 反而匹配不到显示成 `example.com` 的那些标签 —— 看着自己写的域名
 * 筛不出东西，是最容易被当成「坏了」的一类。
 */
export const hostMatchesDomainFilter = (hostname: string, filter: string): boolean => {
  const filterText = filter.trim().toLowerCase();
  if (!filterText) return true;
  const rawHost = hostname.toLowerCase();
  if (rawHost.includes(filterText)) return true;
  const normalizedHost = normalizeHostForDisplay(rawHost);
  const normalizedFilter = normalizeHostForDisplay(filterText);
  if (!normalizedFilter) return true;
  return normalizedHost.includes(normalizedFilter);
};
