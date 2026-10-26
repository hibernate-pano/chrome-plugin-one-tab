// 会话命名规则的守卫（2026-10-25 产品定案：**全部**默认时间戳，无例外）。
//
// ── 规则（只有一档）──────────────────────────────────────────────────────
//
//   保存 ⇒ 名字 = **保存那一刻**（`2026-10-25 14:30`）。
//
//   **没有例外**：不按域名、不按页面标题、不按「这批标签来自哪个网站」。
//   中途加过一条「全都来自同一个网站 ⇒ 用网站名」的例外，2026-10-25 由
//   产品负责人**推翻** —— 那条例外也是猜：它说的是**内容**的事实，
//   却挂在**这次保存**的名字上。
//
// ── 这个文件守什么 ────────────────────────────────────────────────────────
//
// ① **默认名一律是保存时刻**（无论这批标签长什么样）。
// ② **接线**：factory 给出的名字就是判据算出来的那一个，且与 `createdAt`
//    用**同一个** `now`（不许两个时钟打架）。
// ③ **导入路径仍按主导域名命名**（OneTab 文本）—— 那个名字必须**确定性**
//    （它进幂等指纹），所以它与保存路径**故意**不是同一把尺子。
// ④ **`pickDominantTab` 的四条契约**（取哪个标签的 favicon / 主机名）。
// ⑤ **主机名的归一口径**（内网带端口、IPv6 方括号、去 `www.`、
//    非 http(s) 不算主机）—— 现在由**导入路径**与**标签行的域名显示**消费。
//
// 【每条断言都写清「破了会怎样」】——守卫的价值在于失败时能立刻
// 说出后果，而不是只说「不相等」。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTimestampSessionName,
  deriveDominantHost,
  extractNamingHost,
} from '@/domain/tabGroup/sessionName';
import { pickDominantTab } from '@/domain/tabGroup/pickDominantTab';
import { createTabGroupFromChromeTabs } from '@/domain/tabGroup/factory';
import type { Tab } from '@/types/tab';

// 用本地时区构造固定时间，断言与机器时区无关
const now = new Date(2026, 4, 11, 8, 9).toISOString();
const TIMESTAMP_NAME = '2026-05-11 08:09';

const chromeTab = (url: string, title = '示例页面') =>
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
// ① 默认名一律是保存时刻（无论这批标签长什么样）
// ─────────────────────────────────────────────────────────────────────────

describe('① 默认名一律是保存时刻（没有例外）', () => {
  /**
   * 【为什么这一组是整个文件的核心】
   *
   * 「全部默认时间戳」= **没有例外**。任何「按内容命名」的分支都是
   * 替用户猜 ⇒ 猜出来的名字会被当成事实钉在卡片上，而改名入口藏在菜单里。
   *
   * ⇒ 下面这**六种形态**必须给出**同一个**名字（同一个 `now` 下）。
   * 少了任何一种覆盖，都是一个能溜回来的后门。
   */
  const SHAPES: Array<[label: string, tabs: chrome.tabs.Tab[]]> = [
    ['同站（3 个 github）', [chromeTab('https://github.com/a'), chromeTab('https://github.com/b'), chromeTab('https://github.com/c')]],
    ['跨站（github + figma）', [chromeTab('https://github.com/a'), chromeTab('https://figma.com/b')]],
    ['只有一个标签', [chromeTab('https://github.com/a')]],
    ['没有任何域名', [chromeTab('about:blank'), chromeTab('chrome://settings')]],
    ['页面标题很像一个名字', [chromeTab('https://example.com/design', '设计稿评审 - 2026 迭代')]],
    ['本机 / 内网地址', [chromeTab('http://localhost:3000/app'), chromeTab('http://192.168.1.5/admin')]],
  ];

  for (const [label, tabs] of SHAPES) {
    it(`${label} ⇒ 名字是保存时刻`, () => {
      const group = createTabGroupFromChromeTabs(tabs, { now });
      assert.equal(
        group.name,
        TIMESTAMP_NAME,
        `${label} 得到的名字不是保存时刻（实际 "${group.name}"）—— ` +
          '默认名不按内容猜，网站名要靠用户自己改'
      );
    });
  }

  it('空标签列表 ⇒ 也是保存时刻（不许空名字）', () => {
    const group = createTabGroupFromChromeTabs([], { now });
    assert.equal(group.name, TIMESTAMP_NAME);
  });

  it('加载中的标签（url 为空、pendingUrl 有值）⇒ 也是保存时刻', () => {
    // 这一条曾经是「取名」最容易失效的地方：url:'' + pendingUrl:'https://…'
    // 的标签过去会被判成「没有域名」⇒ 名字退回时间戳。
    // 现在名字**本来就是**时间戳 ⇒ 无论 url 还是 pendingUrl，结果都一样。
    const loading = {
      url: '',
      pendingUrl: 'https://github.com/x',
      title: 'PR',
      pinned: false,
    } as chrome.tabs.Tab;
    const group = createTabGroupFromChromeTabs([loading], { now });
    assert.equal(group.name, TIMESTAMP_NAME);
  });

  it('名字**与标签内容无关**：同样时刻、不同标签 ⇒ 同一个名字', () => {
    // 这是「没有例外」这句话最干脆的写法：
    // 名字只由 `now` 决定，与这批标签是什么**完全无关**。
    const a = createTabGroupFromChromeTabs([chromeTab('https://github.com/a')], { now });
    const b = createTabGroupFromChromeTabs(
      [chromeTab('https://figma.com/b'), chromeTab('https://docs.google.com/c')],
      { now }
    );
    assert.equal(a.name, b.name);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ② 接线：factory 给出的名字就是判据算出来的那一个
//
// ⚠️ 「判据算对了」≠「保存出来的会话用了它」—— 本仓栽过一次
// （L-10：排序下拉能选、顺序不动；下拉与判据都齐了，列表还是写死的）。
// ⇒ 这里**真的调用那条路径**：`createTabGroupFromChromeTabs` 是保存路径
// 建会话的**唯一入口**（`background/TabManager.ts` 的两条保存路径都走它）。
// ⚠️ 不钉「源码里出现了某个函数名」—— 那种断言在被绕开时仍然是绿的。
// ─────────────────────────────────────────────────────────────────────────

describe('② 接线：保存路径建出来的会话必须按这条规则命名', () => {
  it('factory 给出的名字必须就是判据函数算出来的那个（不许另走一套）', () => {
    const tabs = [chromeTab('https://github.com/a'), chromeTab('https://figma.com/b')];
    assert.equal(
      createTabGroupFromChromeTabs(tabs, { now }).name,
      buildTimestampSessionName(now),
      '保存路径用的命名规则与判据层不是同一套'
    );
  });

  it('名字里的时间与会话自己的 `createdAt` 必须是**同一个**时刻', () => {
    // 破了 ⇒ 卡片上写着「保存于 14:30」，名字却写着「15:02」——
    // 两个时钟打架，用户对不上「这是什么时候存的」。
    const group = createTabGroupFromChromeTabs([chromeTab('https://github.com/a')], { now });
    assert.equal(
      buildTimestampSessionName(group.createdAt),
      group.name,
      '名字与 createdAt 不是同一个时刻 —— 名字说的时间与卡片上的「保存时间」对不上'
    );
  });

  it('显式传入的 `name` 仍然能覆盖（导入等路径要自己起名）', () => {
    // `options.name` 是留给**不按默认规则**的调用方的口子
    // （例如导入路径），它必须仍然有效。
    const group = createTabGroupFromChromeTabs([chromeTab('https://github.com/a')], {
      now,
      name: '我自己起的名字',
    });
    assert.equal(group.name, '我自己起的名字');
  });

  it('没被保留的标签（未勾保存的固定标签）不会让名字变成别的东西', () => {
    const pinned = { ...chromeTab('https://github.com/a'), pinned: true } as chrome.tabs.Tab;
    const group = createTabGroupFromChromeTabs(
      [pinned, chromeTab('https://figma.com/b')],
      { now }
    );
    assert.equal(group.name, TIMESTAMP_NAME);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ③ 导入路径：仍按主导域名命名（**故意**与保存路径不是同一把尺子）
//
// ⚠️ 导入的组名会进**幂等指纹**（组名 + URL 集合）⇒ 必须**确定性**
// ⇒ 不能用时间戳（同一份文件导两次会算出不同指纹 ⇒ 判重失效
// ⇒ 产生整份副本）。
// ─────────────────────────────────────────────────────────────────────────

describe('③ 导入路径的命名（OneTab 文本）仍然是主导域名', () => {
  const importTabs = (urls: string[]): Tab[] =>
    urls.map((url, i) => storeTab(url, { id: `t${i}` }));

  it('导入的会话按「出现最多的域名」命名', async () => {
    // ⚠️ 动态 import：`oneTabFormatParser` 会拉进「披露」那条链
    //（`oneTabFormatLimits`），它在模块加载时就会碰浏览器的通知 API
    // ⇒ 静态 import 会让这个守卫在 Node 里直接崩。
    const { deriveImportedGroupName } = await import('@/core/oneTabFormatParser');
    const name = deriveImportedGroupName(
      importTabs(['https://github.com/a', 'https://github.com/b', 'https://gitlab.com/c']),
      0
    );
    assert.equal(name, 'github.com');
  });

  it('导入路径与保存路径**故意**不是同一把尺子（保存=保存时刻，导入=域名）', async () => {
    // 这不是缺陷，是**必须**：保存路径的名字是「什么时候存的」，
    // 导入路径的名字是「这批内容是什么」—— 后者必须可复现。
    const { deriveImportedGroupName } = await import('@/core/oneTabFormatParser');
    const urls = ['https://github.com/a', 'https://github.com/b'];
    const imported = deriveImportedGroupName(importTabs(urls), 0);
    const saved = createTabGroupFromChromeTabs(
      urls.map(url => chromeTab(url)),
      { now }
    ).name;

    assert.equal(imported, 'github.com');
    assert.equal(saved, TIMESTAMP_NAME);
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
      '没有取「域名占多数」的那个标签 —— 站点身份会来自一个跟图标不是同一个站的标签'
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

  it('与 deriveDominantHost 是同一把尺子（图标与显示出来的域名必须一致）', () => {
    // 破了 ⇒ 图标是 A 站的、标签行写着 B 站 —— 自相矛盾。
    // ⚠️ 2026-10-25：会话名**一律**是保存时刻 ⇒ 名字不再承载站点身份
    // ⇒ 站点身份由**标签行右侧的域名**承担 ⇒ 这条一致性的适用面
    // 从「图标 vs 名字」变成「图标 vs 标签行显示的域名」。
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

// ─────────────────────────────────────────────────────────────────────────
// ⑤ 主机名的归一口径（导入路径与标签行显示都在消费它）
// ─────────────────────────────────────────────────────────────────────────

describe('⑤ 主机名归一口径', () => {
  it('内网 / 本机 / 自建服务：带端口（端口是区分不同服务的唯一线索）', () => {
    assert.equal(extractNamingHost('http://localhost:3000/app'), 'localhost:3000');
    assert.equal(extractNamingHost('http://192.168.1.5:8080/admin'), '192.168.1.5:8080');
    assert.equal(extractNamingHost('http://myhost.local:8080/'), 'myhost.local:8080');
  });

  it('IPv6 回环：方括号必须留着，否则粘不回地址栏', () => {
    assert.equal(extractNamingHost('http://[::1]:8080/'), '[::1]:8080');
  });

  it('公网域名：去 `www.`、不带端口', () => {
    assert.equal(extractNamingHost('https://www.example.com/x'), 'example.com');
    assert.equal(extractNamingHost('https://github.com/a'), 'github.com');
  });

  it('非 http(s) 协议：根本没有主机', () => {
    // 破了 ⇒ 会得到 `settings`、`blank` 这种**比时间戳还糟**的噪声
    for (const url of [
      'chrome://settings',
      'chrome-extension://abcdef/options.html',
      'file:///Users/me/paper.pdf',
      'about:blank',
      'data:text/html,hello',
      'devtools://devtools/bundled/inspector.html',
    ]) {
      assert.equal(
        extractNamingHost(url),
        null,
        `${url} 产出了主机名 —— 这些协议根本没有主机，算进去只是噪声`
      );
    }
  });

  it('非法 URL ⇒ null（不许抛异常）', () => {
    assert.equal(extractNamingHost(undefined), null);
    assert.equal(extractNamingHost('not-a-url'), null);
  });

  it('非 http(s) 的标签不参与「主导域名」（内部页不算站点）', () => {
    assert.equal(
      deriveDominantHost(['chrome://settings', 'https://github.com/a']),
      'github.com'
    );
    assert.equal(deriveDominantHost(['about:blank', 'chrome://settings']), null);
  });
});
