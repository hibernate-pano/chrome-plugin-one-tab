import { TabGroup, Tab } from '../types/tab';
import { nanoid } from '@reduxjs/toolkit';
import { sanitizeTabUrl } from '../utils/inputValidation';
import { deriveDominantHost } from '../domain/tabGroup/sessionName';
import {
  announceOneTabExportLimits,
  announceOneTabImportLimits,
} from './oneTabFormatLimits';

/**
 * 给导入的会话起名（2026-10-20 审计 A-20）。
 *
 * ── 为什么不用「导入的会话 N」────────────────────────────────────────────
 *
 * OneTab 格式**本身不含组名**（社区标准如此：`URL | 标题`，空行分组）⇒
 * 导入别人的 OneTab 文件时组名必然丢失。这是**格式的固有限制**，
 * 改不了（硬塞组名会破坏与 OneTab 的互操作 —— 我们的导出文件在
 * OneTab 里打开会多出看不懂的行）。
 *
 * 但「组名丢失」不等于「组名只能是序号」：
 *  · 攒到 20 个导入的会话，列表就是一列「导入的会话 1…20」——
 *    **与 A-16 审计发现的原始问题一模一样**（一堆分不清的组），
 *    而产品的核心承诺是「保存 → 之后找回」；
 *  · 序号还有个隐患：它是**按位置**定的，同一份文件在不同上下文里
 *    序号相同，但如果用户在文件里调整过组的顺序，序号就会错位。
 *
 * ⇒ 用**域名**补上（与保存路径同一把尺子，见 `deriveDominantHost`）：
 * 导入一个 GitHub 的工作现场，卡片上写的是 `github.com`，
 * 而不是「导入的会话 3」。
 *
 * 【为什么不用时间戳回落】导入的组名会进**幂等指纹**
 * （`groupContentFingerprint` = 组名 + URL 集合）。
 * 时间戳是**非确定性**的 ⇒ 同一份文件导两次会算出两个不同指纹
 * ⇒ 判重失效 ⇒ 产生整份副本。
 * ⇒ 取不到域名时回落到**序号**（确定性的）。
 */
export const deriveImportedGroupName = (tabs: readonly Tab[], index: number): string => {
  const host = deriveDominantHost(tabs.map(t => t.url));
  return host ?? `导入的会话 ${index + 1}`;
};

/**
 * 把一行 OneTab 文本切成「URL」与「标题」。
 *
 * ── 为什么需要专门的切分器（2026-10-20 审计 A-20）────────────────────────
 *
 * OneTab 的行格式是 `URL | 标题`，但这个格式**天生有歧义**：
 * 分隔符 `|` 同时可能出现在 URL 里，也同时可能出现在标题里。
 * 两种情况都是真实存在的：
 *
 *   · **URL 含 `|`**：`https://github.com/search?q=foo|bar` —— `|` 在
 *     RFC 3986 里**不是**合法的 URI 字符，但 Chrome 地址栏**不编码**它
 *     （`new URL(...).href` 原样保留），所以它能原封不动地存进会话。
 *   · **标题含 `|`**：「A | B」、正则表达式、面包屑分隔。
 *
 * 旧实现切**第一个** `|`（2026-10-06 修的「标题里的 | 被切开」）⇒
 * URL 含 `|` 时**URL 被截断**，标签页静默变成一个打不开的地址。
 * 实测：`https://ex.com/a|b?q=1|2` 往返后变成 `https://ex.com/a`，
 * 且标题被错位成 `b?q=1|2 | 标题 | 带竖线`。
 *
 * ── 切分规则 ──────────────────────────────────────────────────────────────
 *
 * 关键事实：**存下来的 URL 永不含裸空格**。
 * Chrome 把地址栏里的空格编码成 `%20`，`new URL('https://x.com/a b').href`
 * = `https://x.com/a%20b` ⇒ 存储层拿到的 URL 里没有空格。
 *
 * ⇒ 判据只有一条：**从后往前**找第一个「左半边是无空白的合法 URL」的竖线。
 * 这一条规则同时解决三种情况：
 *  · `https://ex.com/a|b?q=1|2 | 标题 | 带竖线`
 *    → 最后一个竖线（`带竖线` 前那个）的左侧含空白 ⇒ 跳过；
 *      下一个竖线的左侧是 `https://ex.com/a|b?q=1|2`（无空白、合法）✓
 *  · `https://ex.com/x | A | B`
 *    → `A | B` 的竖线左侧是 `https://ex.com/x | A`（含空白）⇒ 跳过；
 *      分隔符的左侧是 `https://ex.com/x`（无空白、合法）✓
 *  · `https://ex.com/path| | 标题`（URL 以竖线结尾）
 *    → 最后一个竖线的左侧是 `https://ex.com/path|`（无空白、合法）✓
 *      ⇒ URL 的尾竖线不会被吃掉
 *
 * 【为什么「从后往前」】URL 以竖线结尾时，导出的文本里有**两个**竖线的
 * 左侧都是合法 URL ⇒ 从前往后会切在 URL 末尾那个 ⇒ 尾竖线被吃掉（实测已复现）。
 *
 * 【为什么不用「直接取最后一个 `|`」】那会把 `https://ex.com/x | A | B` 切成
 * URL=`https://ex.com/x | A`（含空白，不是合法 URL）⇒ 整行被丢弃。实测已否决。
 *
 * 【为什么不用「直接取第一个 `|`」】那会把 `https://ex.com/a|b?q=1|2` 截断成
 * `https://ex.com/a` ⇒ 标签页静默变成一个打不开的地址。
 * 这正是 2026-10-20 审计 A-20 实测到的损坏。
 *
 * 【为什么不用「转义竖线」】OneTab 格式**没有**转义规定，
 * 第三方导出的文件里不可能有 `\|` ⇒ 我们的转义只有自己认自己，
 * 对「导入别人的 OneTab 文件」这个真实场景毫无帮助。
 *
 * 往返契约见 tests/guards/oneTabRoundTripFidelity.test.ts
 * 与 tests/importRoundTrip.test.ts。
 */
export const splitOneTabLine = (line: string): { url: string; title: string } | null => {
  /**
   * 一个片段能不能当 URL 用。
   *
   * 【为什么不能只看 sanitizeTabUrl】`sanitizeTabUrl('https://ex.com/x |')`
   * **返回真** —— URL 解析器会把裸空格编码成 `%20`，于是「URL | 标题」
   * 这一行的左半边（`https://ex.com/x |`）被误判成合法 URL ⇒
   * 导回来的 URL 尾部多一个竖线（实测已复现）。
   *
   * 【判据】**片段里不能有任何空白**。这条不是风格偏好，而是本仓
   * 「存下来的 URL 永不含裸空格」这条不变量的直接推论：
   * Chrome 把地址栏里的空格编码成 `%20`，所以存储层拿到的 URL 是
   * `https://ex.com/a%20b` 而不是 `https://ex.com/a b`。
   * ⇒ 一行文本里**带空白的那一半**必然是标题侧，不是 URL 侧。
   */
  const looksLikeUrl = (fragment: string): boolean => {
    if (!fragment || /\s/.test(fragment)) return false;
    return Boolean(sanitizeTabUrl(fragment));
  };

  // 全部竖线的位置。**不做任何预筛** —— 预筛条件（「两侧都空白」之类）
  // 看起来更精确，实测对结果**没有任何影响**（变异验证 M2/M3 都变不红），
  // 反而会让下一个人以为它们在承重。⇒ 判据只有一条，放在下面那一步。
  const candidates: number[] = [];
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '|') candidates.push(i);
  }

  // **从后往前**找第一个「左半边是合法可存储 URL」的竖线。
  //
  // 【为什么从后往前，而不是从前往后】URL **以竖线结尾**时
  // （`https://ex.com/path|`），导出的文本是 `https://ex.com/path| | 标题`
  // ⇒ **两个**竖线的左侧都是合法 URL：
  //   · 第 1 个（URL 末尾那个）：左侧 `https://ex.com/path` ⇒ 从前往后会切在这里
  //     ⇒ **URL 尾部的竖线被吃掉**（实测已复现）
  //   · 第 2 个（真正的分隔符）：左侧 `https://ex.com/path|` ✓
  // 从后往前 ⇒ 取到第 2 个 ⇒ URL 完整保留。
  //
  // 【为什么从后往前不会切错】标题里的竖线（`A | B` 的那个），它的左侧
  // 是 `https://ex.com/x | A` —— **含空白** ⇒ `looksLikeUrl` 判否 ⇒ 被跳过。
  // 真正的分隔符左侧是**纯 URL**（不含空白）⇒ 被选中。
  // ⇒ 「从后往前」+「左侧必须是无空白的合法 URL」这一条规则同时解决了
  // 「URL 含 |」「标题含 |」「URL 以 | 结尾」三种情况。
  for (let k = candidates.length - 1; k >= 0; k -= 1) {
    const idx = candidates[k];
    const left = line.slice(0, idx).trim();
    if (!looksLikeUrl(left)) continue;
    // 有分隔符 ⇒ 标题就是分隔符右边那一段（**可以为空**）。
    //
    // 【不要在这里回落成 URL】旧实现是 `sep === -1 ? url : slice(sep+1).trim()`
    // ⇒ `url | ` 的标题是**空字符串**，不是 URL。
    // 回落成 URL 会把「用户没写标题」变成「标题显示成网址」——
    // 那是**行为变更**，且没有任何好处（列表里 URL 本来就在下面）。
    return { url: left, title: line.slice(idx + 1).trim() };
  }

  // 没有可切分的竖线 ⇒ 整行就是一个 URL（无标题）。
  const whole = line.trim();
  if (!looksLikeUrl(whole)) return null;
  return { url: whole, title: whole };
};

/**
 * 解析 OneTab 格式的导出文本
 * OneTab 格式示例:
 * https://example.com/page1 | Example Page 1
 * https://example.com/page2 | Example Page 2
 * 
 * https://anotherexample.com/page1 | Another Example Page 1
 * https://anotherexample.com/page2 | Another Example Page 2
 * 
 * 空行分隔不同的标签组
 * 
 * @param text OneTab 格式的导出文本
 * @returns 解析后的标签组数组
 */
/**
 * 把 OneTab 文本按**空行**切成组块，返回组数。
 *
 * ── 为什么导出成一个函数（2026-10-20 审计 A-20）──────────────────────────
 *
 * 此前 UI（`HeaderDropdown.tsx`）为了报「文件内共 N 个会话」，**自己**又数了一遍：
 * `text.split('\n\n').filter(Boolean).length`
 * 而解析器用的是 `split(/\n\s*\n/)` —— **两条规则不同** ⇒ 数字对不上：
 *
 *   · Windows 换行（`\r\n\r\n`，OneTab 在 Windows 上的默认导出）
 *     → 解析器 2 组，界面报「共 1 个会话」⇒ **「共 1 个，成功导入 2 个」**
 *   · 中间是「换行 + 空格 + 换行」的空行 → 同上
 *
 * 而 F-5 审计刚建立的契约是「source = imported + skippedExisting + 内容有问题」
 * 恒成立 ⇒ source 必须是**真实的组数**。
 *
 * ⇒ **规则只写在这里**，UI 通过 `countOneTabGroups` 取数，不重数。
 * （这与本仓「同一把尺子」的一贯做法一致：域名判定、主题令牌、
 * 过滤级别都各有唯一来源。）
 */
export const countOneTabGroups = (text: string): number =>
  text.replace(/^\uFEFF/, '').trim().split(/\n\s*\n/).length;

export function parseOneTabFormat(text: string): TabGroup[] {
  // ── 2026-10-22 审计 DS-43-2：导入即披露这个格式带不过去什么 ──────────
  //
  // 披露点选在**这里**（格式的唯一实现）而不是 UI 层：
  //   · OneTab 导入只有这一条路（storage.importFromOneTabFormat → 这里），
  //     UI 那一处披露迟早会被另一条路绕过；
  //   · 这里正是**知道**「锁定态带不过来」的那一处
  //     （下面建出来的会话 isLocked 恒为 false 就是证据）。
  //
  // 【为什么必须在导入的当下说，而不是等恢复时再说】
  // 恢复时的那句「该会话已从列表移除」是在**不可逆之后**才说的 ——
  // 用户已经没得选了。导入时说，他还能在恢复之前手动锁上那个会话。
  announceOneTabImportLimits();

  // 移除可能的 BOM 和其他不可见字符
  const cleanText = text.replace(/^\uFEFF/, '').trim();
  
  // 按空行分割不同的标签组
  const groupTexts = cleanText.split(/\n\s*\n/);
  
  // 当前时间戳，用于创建时间
  const now = new Date().toISOString();
  
  // 解析每个标签组
  const groups: TabGroup[] = groupTexts.map((groupText, index) => {
    // 分割每一行，解析 URL 和标题
    const lines = groupText.split('\n').filter(line => line.trim() !== '');
    
    // 解析每一行为标签
    const tabs: Tab[] = lines.flatMap(line => {
      // 切分规则见 splitOneTabLine 的头注释（2026-10-20 审计 A-20）。
      //
      // 【为什么要专门一个切分器】OneTab 行格式 `URL | 标题` 天生有歧义：
      // 分隔符 `|` 既可能出现在 URL 里（`?q=foo|bar` —— Chrome 不编码它），
      // 也可能出现在标题里（「A | B」）。切第一个会**截断 URL**，
      // 切最后一个会**整行丢弃**（标题里的 | 把左半边拼成非法 URL）。
      //
      // 判据：取第一个「两侧空白、且左半边能通过 URL 解析器」的竖线。
      // 存储的 URL 永不含裸空格（Chrome 编码成 %20）⇒ 这个锚点是可靠的。
      const parsed = splitOneTabLine(line);
      if (!parsed) return [];
      const url = sanitizeTabUrl(parsed.url);
      if (!url) return [];

      return [{
        id: nanoid(),
        url,
        title: parsed.title,
        favicon: '', // OneTab 导出不包含 favicon
        createdAt: now,
        lastAccessed: now,
        pinned: false, // OneTab 导出不包含固定标签页信息
      }];
    });
    
    // 创建会话
    //
    // ⚠️ `importedAt`：**OneTab 格式不带时间戳** ⇒ 这个会话的**保存时间未知**。
    // 写在这里（而不是让 `createdAt` 承担）是因为 `createdAt` 会被原样上云
    // （`upload.ts` 里是 `group.createdAt || currentTime`）⇒ 用空值/最旧来表达
    // 「未知」会在上传时被盖成「现在」，谎话从云端绕回来。
    // 判据见 `types/tab.ts` 的 `importedAt` 说明与 `@/core/sessionSaveTime`。
    return {
      id: nanoid(),
      name: deriveImportedGroupName(tabs, index),
      tabs,
      createdAt: now,
      updatedAt: now,
      importedAt: now,
      isLocked: false
    };
  });

  return groups;
}

/**
 * 将标签组数组转换为 OneTab 格式的导出文本
 *
 * @param groups 标签组数组
 * @returns OneTab 格式的导出文本
 */
export function formatToOneTabFormat(groups: TabGroup[]): string {
  // ── 2026-10-22 审计 DS-43-2：导出即披露这个格式带不过去什么 ──────────
  //
  // 【为什么导出侧也要说，而不是只在导入时说】
  // 导入侧的披露发生得太晚：用户**已经把文件带到另一台机器**了，
  // 那时候知道「这个格式不带锁定」已经没有用了（那边的会话已经建立）。
  // 导出时才是他还能改主意的时候（「那我改用 JSON 备份」）。
  //
  // 两侧都说，是因为它们回答的是**两个不同的问题**：
  //   · 导出：「你即将拿到的文件带不过去什么」；
  //   · 导入：「你刚拿进来的文件带不过去什么」。
  announceOneTabExportLimits();

  return groups.map(group => {
    // 将每个标签格式化为 "URL | 标题"
    //
    // 【为什么标题里的换行必须压掉（2026-10-20 审计 A-20）】
    // OneTab 用**换行**分隔标签、用**空行**分隔会话 ⇒ 标题里若带换行，
    // 导出的文本会在一行中间断开 ⇒ 重新导入时**一条标签被拆成两条**：
    //   导出：`https://ex.com/ok | 第一行\n第二行`
    //   导回：`https://ex.com/ok | 第一行` + `第二行`（后者不是 URL，被丢弃）
    // ⇒ 标题只剩「第一行」，**内容被静默截断**。
    //
    // 页面标题带换行不罕见（某些站点用多行标题，或标题里带了软换行）。
    // ⇒ 导出侧把换行压成空格（保留可读性，不丢信息）。
    //
    // 【为什么用空格而不是删掉】删掉会粘连两个词（「第一行第二行」读起来像
    // 一个词）；压成空格是**无损**的展示性折中，且往返后标题仍可读。
    const tabLines = group.tabs.map(tab => {
      const title = (tab.title ?? '').replace(/\r\n|\r|\n/g, ' ').trim();
      return `${tab.url} | ${title}`;
    });
    return tabLines.join('\n');
  }).join('\n\n');
}
