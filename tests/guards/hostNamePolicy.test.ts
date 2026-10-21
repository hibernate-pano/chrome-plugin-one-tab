// host 的**归一化与分类**必须自洽（2026-10-20 第三轮审计 L-17）。
//
// ── 这个文件要防的具体事故 ────────────────────────────────────────────────
//
// 商店页承诺：「取不到域名时（本地地址、内网地址等）退回「标签组 月日 时:分」」。
// 而实现只判了 **IPv4 正则**：
//
//   if (!host || host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
//
// ⇒ `127.0.0.1` 退回时间戳（兑现承诺），**`[::1]` 却当域名用上了**
// （会话名显示成 `[::1]`）。**同一个意思、两种结果** —— 承诺只在
// IPv4 上兑现。IPv6 回环地址在任何一台现代机器上都是最常见的本机地址之一。
//
// 同一轮还查出第二个缺陷：`getDisplayUrl` 用的是**非锚定**的
// `replace('www.','')`，它会命中域名**中间**的 `www.`：
//
//   `https://mywww.example.com/` → 显示成 `myexample.com`
//
// 那是一个**不存在的域名**。用户照着它记忆、搜索、跟同事转述，全部落空。
//
// 两个缺陷的根因是同一个：**host 判定用了字面量匹配，而不是语义判定**。
// 而且判定在仓库里有**三份**（sessionName / sessionPresentation / search），
// 三份互不等价 ⇒ 同一条地址在不同界面里长成不同样子。
//
// ── 这个文件守什么 ────────────────────────────────────────────────────────
//
// ① **不变量**：任何「本机 / 内网 / IP 字面量」的写法都**不得**被当作
//    可记忆的公共域名（命名与展示都算）。
//    —— 注意判据是**语义**（「这是不是一个用户会拿来记忆工作现场的域名」），
//    不是某个具体字符串。IPv4/IPv6/单标签主机名/带尾点/带 www 都得覆盖。
//
// ② **不变量**：归一化**不得改变域名本身** —— 去掉 `www.` 前缀之后，
//    剩下的部分必须**原样**是那个域名（不能被 `replace` 误伤中间的 `www.`）。
//
// ③ **单源**：三处判定必须走同一个函数（不许再各写一份）。
//
// ④ **口径一致**：标签行**显示**的域名，与「按域名筛选」**匹配**的域名，
//    必须是同一个形态 —— 否则用户照着自己看到的域名筛，却筛不出东西。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  hostMatchesDomainFilter,
  isLocalOrIpHost,
  normalizeHostForDisplay,
} from '@/core/hostName';
import { deriveSessionNameFromChromeTabs } from '@/domain/tabGroup/sessionName';
import { getDisplayUrl } from '@/utils/sessionPresentation';
import { applySearchFilters, type SearchResult } from '@/utils/search';
import type { TabGroup } from '@/types/tab';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** 去掉注释后再扫 —— 判据要对着**代码**，不对着关于代码的散文。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const now = new Date(2026, 4, 11, 8, 9).toISOString();
const TIMESTAMP_NAME = '标签组 5月11日 08:09';
const tab = (url: string) => ({ url, title: 'T', pinned: false } as chrome.tabs.Tab);

/**
 * 「本机 / 内网 / IP 字面量」的**各种写法**。
 *
 * 【为什么要列全而不是只列一个】缺陷的本质是「判据只覆盖了 IPv4」。
 * 只钉 `127.0.0.1` 的话，把判据换成只认 `127.0.0.1` 也能过测 ——
 * 而 IPv6 依然漏。⇒ 必须覆盖**每一族**。
 */
const LOCAL_FORMS: Array<[label: string, url: string]> = [
  ['localhost', 'http://localhost:3000/app'],
  ['localhost 大写', 'http://LOCALHOST/app'],
  ['localhost 带尾点', 'http://localhost./app'],
  ['localhost 子域', 'http://foo.localhost/app'],
  ['IPv4 回环', 'http://127.0.0.1:8080/x'],
  ['IPv4 内网', 'http://192.168.1.5/x'],
  ['IPv4 全零', 'http://0.0.0.0/x'],
  ['IPv6 回环', 'http://[::1]:8080/x'],
  ['IPv6 全局', 'http://[2001:db8::1]/x'],
  ['IPv6 映射 IPv4', 'http://[::ffff:127.0.0.1]/x'],
  ['单标签内网主机名', 'http://wiki/x'],
];

describe('L-17 ① 本机 / 内网 / IP 字面量不得被当成可记忆域名', () => {
  for (const [label, url] of LOCAL_FORMS) {
    it(`${label}：会话名退回时间戳（兑现「本地地址退回时间戳」的承诺）`, () => {
      assert.equal(
        deriveSessionNameFromChromeTabs([tab(url)], now),
        TIMESTAMP_NAME,
        `${url} 的会话名没有退回时间戳 —— 命名承诺「取不到域名时退回标签组 月日 时:分」`
      );
    });
  }

  it('IPv4 与 IPv6 的本机地址得到**同样的**结果（不能一个退回、一个当域名）', () => {
    // 这是本缺陷的核心形态：同一句承诺，两种结果。
    const v4 = deriveSessionNameFromChromeTabs([tab('http://127.0.0.1:8080/x')], now);
    const v6 = deriveSessionNameFromChromeTabs([tab('http://[::1]:8080/x')], now);
    assert.equal(v6, v4, 'IPv6 本机地址与 IPv4 本机地址必须得到同样的会话名');
  });

  it('这些写法确实被判成本机地址（判据本身的自检）', () => {
    for (const [label, url] of LOCAL_FORMS) {
      const hostname = new URL(url).hostname;
      assert.ok(
        isLocalOrIpHost(hostname),
        `${label}（${hostname}）没有被判成本机地址 —— 判据漏了这一族`
      );
    }
  });

  it('IPv6 判据必须**显式**存在，不能靠「没有点」顺带兜住', () => {
    /**
     * 【为什么必须直接调用、还要挑一个「含点」的 IPv6 字面量】
     *
     * 变异验证 M1 实测过的坑：把 IPv6 判据（`含冒号`）从实现里删掉，
     * 守卫**全绿** —— 因为 URL 解析器把 IPv6 归一化成 `::1` / `::ffff:7f00:1`，
     * 它们**本来就不含点**，于是「单标签主机名」那条判据顺带拦下了它们。
     * 换句话说：守卫当时验证的是**结果**，没验证**原因**。
     *
     * ⇒ 这里**直接调用**判据，并挑一个**同时含点**的 IPv6 字面量
     * （`::ffff:192.168.1.1` 这种「IPv4 映射的 IPv6」）。
     * 它有点 ⇒ 「无点」那条判据拦不住它 ⇒ 只有**显式的 IPv6 判据**
     * 才能拦得住。删掉 IPv6 判据 ⇒ 这里变红。
     */
    const ipv6WithDots = '::ffff:192.168.1.1';
    assert.ok(
      ipv6WithDots.includes('.') && ipv6WithDots.includes(':'),
      '这个用例本身失效了 —— 必须挑一个既含点又含冒号的字面量'
    );
    assert.ok(
      isLocalOrIpHost(ipv6WithDots),
      '含点的 IPv6 字面量没有被判成本机地址 —— IPv6 判据只是靠「无点」顺带兜住的' +
        '（变异验证 M1 实测过这个洞）'
    );
  });

  it('真正的公网域名不得被误判成本机地址', () => {
    // 反向断言：判据不能「为了全红而全红」。
    for (const host of ['github.com', 'example.com', 'a.b.c.example.com', 'xn--fsq.com']) {
      assert.ok(!isLocalOrIpHost(host), `${host} 被误判成本机地址 —— 公网域名要能当会话名`);
    }
  });
});

describe('L-17 ② 归一化不得改变域名本身', () => {
  it('只去掉**开头**的 www.，域名中间的 www. 必须保留', () => {
    // 缺陷形态：`replace('www.','')` 把 mywww.example.com 变成 myexample.com
    // —— 那是一个不存在的域名，用户照着它记忆/搜索/转述全部落空。
    assert.equal(
      normalizeHostForDisplay('mywww.example.com'),
      'mywww.example.com',
      '域名中间的 www. 被误删了 —— 显示成了一个不存在的域名'
    );
    assert.equal(
      getDisplayUrl('https://mywww.example.com/x'),
      'mywww.example.com',
      '标签行显示了一个不存在的域名'
    );
  });

  it('开头的 www. 仍然被去掉（既有行为不许被改掉）', () => {
    assert.equal(normalizeHostForDisplay('www.example.com'), 'example.com');
    assert.equal(getDisplayUrl('https://www.example.com/x'), 'example.com');
  });

  it('归一化是幂等的（归一化两次 = 归一化一次）', () => {
    for (const host of ['www.example.com', 'mywww.example.com', 'localhost.', '[::1]']) {
      const once = normalizeHostForDisplay(host);
      assert.equal(
        normalizeHostForDisplay(once),
        once,
        `归一化不幂等（${host}）—— 同一处 host 反复归一化会得到不同结果`
      );
    }
  });

  it('展示形态与归一化单源一致（不许各写一份）', () => {
    for (const url of [
      'https://www.example.com/x',
      'https://mywww.example.com/x',
      'http://localhost:3000/app',
      'https://developer.chrome.com/docs',
    ]) {
      const expected = normalizeHostForDisplay(new URL(url).hostname);
      assert.equal(
        getDisplayUrl(url),
        expected,
        `${url} 的展示形态与 core/hostName 的归一化单源不一致 —— 两处会再次漂移`
      );
    }
  });
});

describe('L-17 ③ 判定必须是单源（不许三处各写一份）', () => {
  const callSites: Array<[file: string, symbol: string]> = [
    ['src/domain/tabGroup/sessionName.ts', 'isLocalOrIpHost'],
    ['src/domain/tabGroup/sessionName.ts', 'normalizeHostForDisplay'],
    ['src/utils/sessionPresentation.ts', 'normalizeHostForDisplay'],
    ['src/utils/search.ts', 'hostMatchesDomainFilter'],
  ];

  for (const [file, symbol] of callSites) {
    it(`${file} 从 @/core/hostName 取 ${symbol}`, () => {
      const source = read(file);
      assert.match(
        source,
        new RegExp(`import\\s*\\{[^}]*${symbol}[^}]*\\}\\s*from\\s*'@/core/hostName'`),
        `${file} 没有从 @/core/hostName 取 ${symbol} —— 判定又变成各写一份`
      );
    });
  }

  it('三处不得再自己写 host 判定', () => {
    for (const file of [
      'src/domain/tabGroup/sessionName.ts',
      'src/utils/sessionPresentation.ts',
      'src/utils/search.ts',
    ]) {
      /**
       * 【为什么必须剥注释】判据要扫的是**代码**，不是**关于代码的散文**。
       * 这三份文件的头注释里**必然**会写「旧实现是 replace('www.','')」——
       * 那是在解释修复的来龙去脉。不剥注释的话，守卫会把自己的
       * 修复说明判成违规 ⇒ 假红 ⇒ 守卫被当成噪音而废掉。
       * （本仓反复吃过这个亏：守卫钉错了值，挡住了正确的改动。）
       */
      const source = stripComments(read(file));
      // 自己写「这是不是一个 IP」的判据
      assert.doesNotMatch(
        source,
        /\\d\+\\\.\\d\+\\\.\\d\+\\\.\\d\+/,
        `${file} 又自己写了一份 IP 判据 —— 判据会再次漂移（IPv6 漏掉就是这么来的）`
      );
      // 非锚定的 www. 剥离
      assert.doesNotMatch(
        source,
        /replace\(\s*['"]www\.['"]\s*,/,
        `${file} 又用了非锚定的 replace('www.','') —— 它会误伤域名中间的 www.`
      );
    }
  });
});

describe('L-17 ④ 显示与筛选必须是同一个口径', () => {
  it('用户照着自己看到的域名筛选，必须能筛到东西', () => {
    // 缺陷形态：标签行显示 `example.com`（去 www），而筛选按原始 hostname
    // 匹配 `www.example.com` ⇒ 用户照抄地址栏的写法反而筛不出。
    assert.ok(
      hostMatchesDomainFilter('www.example.com', 'example.com'),
      '地址栏写法 www.example.com 筛不出显示成 example.com 的标签'
    );
    assert.ok(
      hostMatchesDomainFilter('example.com', 'www.example.com'),
      '显示出来的 example.com 筛不出地址栏写法的 www.example.com'
    );
  });

  it('筛选仍是子串匹配（用户输入 example 期望看到所有 example.*）', () => {
    assert.ok(hostMatchesDomainFilter('developer.example.com', 'example'));
    assert.ok(hostMatchesDomainFilter('example.com', 'example'));
    assert.ok(!hostMatchesDomainFilter('github.com', 'example'));
  });

  it('旧行为不许被缩小：输入 www 仍能匹配到 www 主机', () => {
    // 归一化后 host 里已经没有 www 了，若只做归一化匹配，
    // "www" 这个过滤词会**失配** —— 那是缩小了筛选范围（改了产品行为）。
    assert.ok(
      hostMatchesDomainFilter('www.example.com', 'www'),
      '输入 www 匹配不到 www 主机 —— 筛选范围被悄悄缩小了'
    );
  });

  it('空过滤词不过滤任何东西', () => {
    assert.ok(hostMatchesDomainFilter('example.com', ''));
    assert.ok(hostMatchesDomainFilter('example.com', '   '));
  });

  it('**真实生效**的那条筛选路径（applySearchFilters）也用同一口径', () => {
    /**
     * 【为什么必须单独测这一条】`src/utils/search.ts` 里有**两处**域名过滤：
     *   ① `AdvancedSearch.search` 的 `domainFilter` 选项；
     *   ② `applySearchFilters` 的 `filters.domain`。
     *
     * 而 UI（`SearchResultList.tsx`）**只传** `filters.domain` 给
     * `applySearchFilters` —— `AdvancedSearch.search` 的 `domainFilter`
     * 从来没人传过（它只被 `search()` 的调用方传了 query/searchPinned）。
     *
     * ⇒ 变异验证 M8 实测：只把 ① 改回原始匹配，守卫**全绿** ——
     * 因为我当初只测了 ② 的底层函数，没测**哪条路径真的生效**。
     * ⇒ 这里必须**端到端**测 `applySearchFilters`。
     */
    const group: TabGroup = {
      id: 'g1',
      name: '会话',
      createdAt: now,
      updatedAt: now,
      isLocked: false,
      tabs: [
        // 存的是**不带 www** 的地址（很多站点跳转后就是这样）
        { id: 't1', url: 'https://example.com/a', title: 'A', favicon: '', createdAt: now, lastAccessed: now, pinned: false },
        // 存的是**带 www** 的地址
        { id: 't2', url: 'https://www.other.com/b', title: 'B', favicon: '', createdAt: now, lastAccessed: now, pinned: false },
        { id: 't3', url: 'https://github.com/c', title: 'C', favicon: '', createdAt: now, lastAccessed: now, pinned: false },
      ],
    };
    const results: SearchResult[] = group.tabs.map(tab => ({
      tab,
      group,
      score: 1,
      matches: [],
    }));

    /**
     * 【为什么挑这两条，具体到「原始匹配会不会通过」】
     *
     * 守卫必须挑一个**原始匹配会失败、归一化匹配才成功**的组合 ——
     * 否则它就区分不出「走单源」与「走原始匹配」，变异验证 M8 实测过这个洞：
     * 我第一版用 `www.example.com` 的 host + `example.com` 的过滤词，
     * 而 `'www.example.com'.includes('example.com')` 本来就是 true
     * ⇒ 把实现改回原始匹配，守卫**照样全绿**。
     *
     * 现在用 host=`example.com`（不带 www）+ filter=`www.example.com`：
     *   原始匹配：'example.com'.includes('www.example.com') = **false** ✗
     *   归一化匹配：'example.com'.includes('example.com') = **true** ✓
     * ⇒ 只有真的走了归一化单源才会通过。
     */
    const byAddressBar = applySearchFilters(results, { domain: 'www.example.com' });
    assert.equal(
      byAddressBar.length,
      1,
      '照抄地址栏的 www.example.com 筛不出存着 example.com 的那条 —— ' +
        '筛选没走归一化单源（用户看着自己写的域名却没结果）'
    );
    assert.equal(byAddressBar[0].tab.id, 't1');

    // 反向：host 带 www，过滤词不带 www
    const byDisplayed = applySearchFilters(results, { domain: 'other.com' });
    assert.equal(byDisplayed.length, 1);
    assert.equal(byDisplayed[0].tab.id, 't2');

    // 不相关域名必须筛掉
    assert.equal(applySearchFilters(results, { domain: 'github' }).length, 1);
    assert.equal(applySearchFilters(results, { domain: 'not-a-host' }).length, 0);
  });
});
