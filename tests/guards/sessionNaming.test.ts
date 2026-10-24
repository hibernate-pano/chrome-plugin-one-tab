// 会话命名链的守卫（2026-10-22 审计 U-06 / U-15 / U-19）。
//
// ── 这个文件防的具体事故 ────────────────────────────────────────────────
//
// 现场：一屏 10 张会话卡，全是「标签组 10月22日 09:12」「标签组 10月22日 09:47」。
//
// 根因**不是**「缺 favicon」，而是**默认名里根本没有站点身份**：
//
//   deriveSessionNameFromChromeTabs = deriveDominantHost(urls) ?? buildTimestampSessionName(now)
//   deriveDominantHost → localhost / IP / 非法协议 ⇒ 直接返回 null
//
// ⇒ 内网、自建服务、本地开发（`localhost:3000`、`192.168.1.5`、`[::1]:8080`）
//   **全部**落进时间戳兜底。favicon 救不了它 —— 连域名都没有。
//
// 而「取不到域名时退回时间戳」这条承诺，是 2026-10-20 第三轮审计 L-17
// 在**公网域名**场景下立的（`tests/guards/hostNamePolicy.test.ts` 守着它）。
// 这次不是推翻那条承诺，而是**把承诺的适用面说清楚**：
// 「用户会拿来记忆工作现场的公共域名」只是其中一种，
// 内网主机名同样是用户记忆工作现场的方式（甚至是更常用的方式 ——
// 对自建服务而言，`localhost:3000` 就是那个项目的名字）。
//
// ── 这个文件守什么 ────────────────────────────────────────────────────────
//
// ① **内网/本地主机必须产出可读的主机名**（本轮的核心回归钉）。
//    破了 ⇒ 回到「一屏 10 张卡长得一样」。
// ② **取值链是「域名 → 有意义的标题 → 时间戳」**，且每一级的判据都明确。
//    破了 ⇒ 要么退化成一堆时间戳，要么退化成一堆「新标签页」。
// ③ **非 http(s) 协议不贡献主机名** —— `chrome://` / `file://` / `about:`
//    根本没有主机，算进去只会得到 `settings`、`blank` 这种噪声。
// ④ **`pickDominantTab` 的四条契约**（取哪个标签的 favicon / 主机名）。
//    破了 ⇒ 若界面用它取卡头图标，图标与会话名会来自不同标签，自相矛盾。
//    ⚠️ 2026-10-24：界面回到 v1.25.1 ⇒ **卡头不再渲染 favicon**，
//    这个纯函数暂时**不被界面消费**（模块与它的契约都保留着，
//    哪天要恢复卡头图标，直接接回去即可）。
//
// 【每条断言都写清「破了会怎样」】——守卫的价值在于失败时能立刻
// 说出后果，而不是只说「不相等」。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTimestampSessionName,
  deriveDominantHost,
  deriveSessionNameFromChromeTabs,
  extractNamingHost,
  isMeaningfulTabTitle,
  MAX_SESSION_TITLE_LENGTH,
  truncateSessionTitle,
} from '@/domain/tabGroup/sessionName';
import { pickDominantTab } from '@/domain/tabGroup/pickDominantTab';
import type { Tab } from '@/types/tab';

// 用本地时区构造固定时间，断言与机器时区无关
const now = new Date(2026, 4, 11, 8, 9).toISOString();
const TIMESTAMP_NAME = '标签组 5月11日 08:09';

const chromeTab = (url: string, title = '') =>
  ({ url, title, pinned: false } as chrome.tabs.Tab);

const storeTab = (url: string, extra: Partial<Tab> = {}): Tab => ({
  id: `t-${url}`,
  url,
  title: '标题',
  favicon: '',
  createdAt: now,
  lastAccessed: now,
  pinned: false,
  ...extra,
});

// ─────────────────────────────────────────────────────────────────────────
// ① 内网 / 本地主机必须产出可读的主机名（U-06 的核心回归钉）
// ─────────────────────────────────────────────────────────────────────────

describe('U-06 ① 内网 / 本地主机必须产出可读的主机名', () => {
  it('localhost 带端口 → localhost:3000（端口是区分不同本地服务的唯一线索）', () => {
    assert.equal(
      deriveSessionNameFromChromeTabs([chromeTab('http://localhost:3000/app')], now),
      'localhost:3000',
      '本地开发会话的名字退化成了时间戳 —— 一屏 10 张本地项目卡片长得一模一样'
    );
  });

  it('内网 IPv4 → 192.168.1.5', () => {
    assert.equal(
      deriveSessionNameFromChromeTabs([chromeTab('http://192.168.1.5/admin')], now),
      '192.168.1.5',
      '内网地址没有产出主机名 —— 自建服务的会话名里没有任何站点身份'
    );
  });

  it('内网 IPv4 带端口 → 192.168.1.5:8080', () => {
    assert.equal(
      deriveSessionNameFromChromeTabs([chromeTab('http://192.168.1.5:8080/admin')], now),
      '192.168.1.5:8080',
      '内网地址的端口被丢掉了 —— 同一台机器上的两个服务会撞名'
    );
  });

  it('IPv6 回环 → [::1]:8080（方括号必须留着，否则粘不回地址栏）', () => {
    assert.equal(
      deriveSessionNameFromChromeTabs([chromeTab('http://[::1]:8080/')], now),
      '[::1]:8080',
      'IPv6 本机地址没有产出主机名（或方括号/端口被吞了）'
    );
  });

  it('内网后缀 .local → myhost.local:8080', () => {
    assert.equal(
      deriveSessionNameFromChromeTabs([chromeTab('http://myhost.local:8080/')], now),
      'myhost.local:8080',
      '内网后缀域名没有按「自建服务」口径命名'
    );
  });

  it('单标签内网主机名 → wiki', () => {
    assert.equal(
      deriveSessionNameFromChromeTabs([chromeTab('http://wiki/docs')], now),
      'wiki',
      '内网主机名（无点）没有产出主机名 —— 用户恰恰是靠它记住工作现场的'
    );
  });

  it('一屏内网会话不再全是时间戳（U-06 现场复现）', () => {
    // 现场：10 张卡全是「标签组 10月22日 09:12」/「标签组 10月22日 09:47」。
    const urls = [
      'http://localhost:3000/app',
      'http://localhost:8080/api',
      'http://192.168.1.5/admin',
      'http://192.168.1.5:9000/metrics',
      'http://[::1]:8080/',
      'http://myhost.local:3000/',
      'http://wiki.internal/x',
    ];
    const names = urls.map(url => deriveSessionNameFromChromeTabs([chromeTab(url)], now));
    for (const [index, name] of names.entries()) {
      assert.notEqual(
        name,
        TIMESTAMP_NAME,
        `${urls[index]} 仍然命名成时间戳 —— U-06 没修好`
      );
    }
    // 且这些名字必须**互不相同**：一屏 10 张一样的卡依然是「分不清」
    assert.equal(
      new Set(names).size,
      names.length,
      '内网会话的名字撞了 —— 端口/主机名没有参与区分'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ② 取值链：域名 → 有意义的标题 → 时间戳
// ─────────────────────────────────────────────────────────────────────────

describe('U-06 ② 取值链：域名 → 有意义的标题 → 时间戳', () => {
  it('公网域名当会话名（既有行为不许被改掉）', () => {
    assert.equal(
      deriveSessionNameFromChromeTabs(
        [chromeTab('https://github.com/a'), chromeTab('https://github.com/b')],
        now
      ),
      'github.com',
      '公网域名的会话名不对 —— 这是产品的主路径，不能被内网支持挤掉'
    );
  });

  it('域名优先于标题（域名是上下文，标题是条目）', () => {
    assert.equal(
      deriveSessionNameFromChromeTabs(
        [chromeTab('https://github.com/a', 'Pull Request #1234 · Fix the sync bug')],
        now
      ),
      'github.com',
      '标题抢走了域名 —— 同一域名下的多个标签会得到不同的名字，用户失去「上下文」'
    );
  });

  it('没有域名但有有意义的标题 → 标题当会话名', () => {
    assert.equal(
      deriveSessionNameFromChromeTabs(
        [chromeTab('about:blank', '设计稿评审 - 2026 迭代')],
        now
      ),
      '设计稿评审 - 2026 迭代',
      '有意义的标题被丢掉了 —— 明明比「标签组 5月11日 08:09」有信息量'
    );
  });

  it('标题被裁剪到 24 个字符（超出加省略号）', () => {
    const long = '这是一个非常非常长的页面标题用来测试裁剪逻辑是否生效';
    const name = deriveSessionNameFromChromeTabs([chromeTab('about:blank', long)], now);
    assert.equal(name.length, MAX_SESSION_TITLE_LENGTH, '超长标题没有裁剪到上限');
    assert.ok(name.endsWith('…'), '裁剪后必须带省略号，否则用户看不出被截断');
    assert.ok(long.startsWith(name.slice(0, -1)), '裁剪必须保留开头（标题的前半段信息量最大）');
  });

  it('裁剪器本身：短标题原样返回，长标题截到上限并加省略号', () => {
    // 破了 ⇒ 要么会话名被截得只剩半个词，要么超长标题把卡片徽章挤出屏幕
    assert.equal(truncateSessionTitle('短标题'), '短标题');
    assert.equal(truncateSessionTitle('  前后有空格  '), '前后有空格', '首尾空白必须去掉');
    const long = 'x'.repeat(100);
    const cut = truncateSessionTitle(long);
    assert.equal(cut.length, MAX_SESSION_TITLE_LENGTH);
    assert.ok(cut.endsWith('…'));
    assert.equal(truncateSessionTitle('x'.repeat(MAX_SESSION_TITLE_LENGTH)).length, MAX_SESSION_TITLE_LENGTH);
  });

  it('浏览器默认标题不算「有意义」（New Tab / 新标签页 / 新标签 / New Tab Page）', () => {
    // 破了 ⇒ 一屏的「新标签页」取代一屏的时间戳 —— 换了个写法，信息量一样是零
    for (const title of ['New Tab', 'new tab', 'NEW TAB', '新标签页', '新标签', 'New Tab Page']) {
      assert.equal(
        isMeaningfulTabTitle(title),
        false,
        `「${title}」被当成了有意义的标题 —— 浏览器默认标题不含任何站点信息`
      );
    }
    assert.equal(isMeaningfulTabTitle(''), false);
    assert.equal(isMeaningfulTabTitle('   '), false);
    assert.equal(isMeaningfulTabTitle(undefined), false);
    assert.equal(isMeaningfulTabTitle('GitHub · 主页'), true);
  });

  it('标题是 New Tab → 落到时间戳兜底', () => {
    assert.equal(
      deriveSessionNameFromChromeTabs([chromeTab('about:blank', 'New Tab')], now),
      TIMESTAMP_NAME,
      '默认标题被当成了会话名 —— 用户看到一屏「新标签页」'
    );
  });

  it('标题是空 → 落到时间戳兜底', () => {
    assert.equal(
      deriveSessionNameFromChromeTabs([chromeTab('about:blank', '')], now),
      TIMESTAMP_NAME,
      '空标题没有被时间戳兜住 —— 会话名变成空串，用户什么也看不到'
    );
  });

  it('空标签列表 → 时间戳兜底', () => {
    assert.equal(
      deriveSessionNameFromChromeTabs([], now),
      TIMESTAMP_NAME,
      '空列表没有回落时间戳'
    );
  });

  it('buildTimestampSessionName 仍是最后一道（格式不许变）', () => {
    assert.equal(buildTimestampSessionName(now), TIMESTAMP_NAME);
    assert.equal(buildTimestampSessionName('not-a-date'), '标签组');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ③ 非 http(s) 协议：根本没有主机，不参与命名
// ─────────────────────────────────────────────────────────────────────────

describe('U-06 ③ 非 http(s) 协议不贡献主机名', () => {
  it('chrome:// / file:// / about: 都不产出主机名', () => {
    // 破了 ⇒ 会话名变成「settings」「blank」这种**比时间戳还糟**的噪声
    for (const url of [
      'chrome://settings',
      'chrome-extension://abcdef/options.html',
      'file:///Users/me/paper.pdf',
      'about:blank',
      'data:text/html,hello',
      'devtools://devtools/bundled/inspector.html',
    ]) {
      assert.equal(
        deriveDominantHost([url]),
        null,
        `${url} 产出了主机名 —— 这些协议根本没有主机，算进去只是噪声`
      );
    }
  });

  it('非 http(s) 的标签不稀释公网域名（内部页不参与计数）', () => {
    // 破了 ⇒ 2 个 github + 3 个内部页被判成「并列」，名字随标签顺序抖动
    assert.equal(
      deriveSessionNameFromChromeTabs(
        [
          chromeTab('chrome://settings'),
          chromeTab('https://github.com/a'),
          chromeTab('chrome://extensions'),
          chromeTab('https://github.com/b'),
          chromeTab('about:blank'),
        ],
        now
      ),
      'github.com',
      '内部页稀释了域名统计 —— 结果不再稳定'
    );
  });

  it('extractNamingHost 是这条判据的单源（pickDominantTab 也走它）', () => {
    assert.equal(extractNamingHost('http://localhost:3000/x'), 'localhost:3000');
    assert.equal(extractNamingHost('chrome://settings'), null);
    assert.equal(extractNamingHost(undefined), null);
    assert.equal(extractNamingHost('not-a-url'), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ④ pickDominantTab 的四条契约（取哪个标签的 favicon / 主机名）
//
// ⚠️ 2026-10-24：界面回到 v1.25.1 ⇒ 卡头不再渲染 favicon ⇒ 这个纯函数
// 暂时不被界面消费。**模块与契约都保留**：它仍是「同一个站点取哪个标签」
// 的判据真源，恢复卡头图标时直接接回去。
// ─────────────────────────────────────────────────────────────────────────

describe('U-15 ④ pickDominantTab 的四条契约', () => {
  it('契约① 返回域名占多数的那个标签', () => {
    const tabs = [
      storeTab('https://github.com/a', { id: 'a', favicon: 'https://i/1.png' }),
      storeTab('https://github.com/b', { id: 'b', favicon: 'https://i/2.png' }),
      storeTab('https://figma.com/c', { id: 'c', favicon: 'https://i/3.png' }),
    ];
    assert.equal(
      pickDominantTab(tabs)?.id,
      'a',
      '没有取「域名占多数」的那个标签 —— 卡片图标与会话名会来自不同的站点'
    );
  });

  it('契约② 域名并列时取数组里靠前的那个', () => {
    // 破了 ⇒ 同一批标签换个顺序，卡片图标就变了 —— 用户会觉得「图标在乱跳」
    const tabs = [
      storeTab('https://alpha.com/1', { id: 'first', favicon: 'https://i/1.png' }),
      storeTab('https://beta.com/2', { id: 'second', favicon: 'https://i/2.png' }),
    ];
    assert.equal(pickDominantTab(tabs)?.id, 'first');
  });

  it('契约③ 没有任何标签有可用域名时，返回第一个带 favicon 的标签', () => {
    const tabs = [
      storeTab('chrome://settings', { id: 'no-icon', favicon: '' }),
      storeTab('chrome://extensions', { id: 'has-icon', favicon: 'https://i/e.png' }),
    ];
    assert.equal(
      pickDominantTab(tabs)?.id,
      'has-icon',
      '没有域名的会话没有退回 favicon —— 卡片头在这种情况下彻底没有身份'
    );
  });

  it('契约④ 都没有 favicon 时返回 null', () => {
    const tabs = [
      storeTab('chrome://settings', { id: 'x' }),
      storeTab('chrome://extensions', { id: 'y' }),
    ];
    // Tab.favicon 是可选字段 ⇒ 构造没有 favicon 的标签要显式抹掉
    for (const tab of tabs) delete tab.favicon;
    assert.equal(
      pickDominantTab(tabs),
      null,
      '没有任何 favicon 时应返回 null —— 调用方会据此不渲染图标，而不是渲染一个空图标'
    );
  });

  it('空数组返回 null', () => {
    assert.equal(pickDominantTab([]), null);
  });

  it('与 deriveDominantHost 是同一把尺子（图标与名字必须来自同一个站点）', () => {
    // 破了 ⇒ 会话名写 github.com、卡片图标却是 figma 的 —— 自相矛盾
    const urls = [
      'https://github.com/a',
      'https://figma.com/b',
      'https://github.com/c',
      'http://localhost:3000/d',
    ];
    const tabs = urls.map((url, i) => storeTab(url, { id: `t${i}`, favicon: `https://i/${i}.png` }));
    const picked = pickDominantTab(tabs);
    const host = deriveDominantHost(urls);
    assert.ok(picked);
    assert.equal(
      extractNamingHost(picked.url),
      host,
      'pickDominantTab 与 deriveDominantHost 选出了不同的主机 —— 两处口径漂移了'
    );
  });

  it('签名必须是 (tabs: Tab[]) => Tab | null（别的 agent 按这个契约调用）', () => {
    assert.equal(typeof pickDominantTab, 'function');
    assert.equal(pickDominantTab.length, 1, '入参必须是**一个**数组');
  });
});
