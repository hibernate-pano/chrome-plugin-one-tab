// 设置页的信息架构与出口（2026-10-20 第二轮审计）。
//
// ── 本文件要防的回归类别 ──────────────────────────────────────────────────
//
// 设置页是 `options_ui.open_in_tab: true` 打开的**独立标签页**，
// 而管理页是 `chrome.tabs.create` 打开的**另一个**独立标签页。
// 这个形态带来三个只在真机上才看得出来的缺口：
//
//   ① **进得来，出不去。** 页面顶部只有标题，没有回到管理页的入口。
//      从扩展详情页的「扩展选项」进来时，浏览器历史里**没有**管理页
//      ⇒ 「后退」不是出路，用户卡在设置页里。
//
//   ② **文案指向不存在的入口。** autoSyncHint 让用户「去右上角菜单登录」——
//      而设置页**没有右上角菜单**（那是管理页顶栏的东西）。
//      用户照做得到的是「找一个不存在的菜单」，于是云端用户（默认后端）
//      永远开不了自动同步，也不知道为什么。
//
//   ③ **最长的那块表单默认展开。** 「自带存储配置」有地址、账号、应用密码、
//      加密口令、测试连接、保存、清除配置 —— 而 90% 的用户用默认的
//      Supabase 后端，永远不碰它。默认展开 = 首屏被一块用不到的表单占掉。
//
// ── 测试形态 ──────────────────────────────────────────────────────────────
// 本仓没有 jsdom / happy-dom / @testing-library。所以这里：
//   · 判据层（optionsPageIa / optionsAccount）是**纯函数**，直接调用断言；
//   · 接线层用源码结构断言，钉「组件真的用了这些纯函数」；
//   · 渲染层用 `react-dom/server`（见 tests/optionsInertGate.test.ts 的同一套
//     harness）真的渲染一遍，断言输出的 HTML 里有该有的东西。
//
// ⚠️ 断言盯**不变量**，不盯字面量：文案可以改得更顺，判据不能反。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collapsiblePanelState,
  managerPageExitAction,
  shouldCollapseWebDavSection,
  syncIntervalHint,
} from '../src/options/optionsPageIa.ts';
import { accountPanelMode, loginHintCopy } from '../src/options/optionsAccount.ts';
import { MANAGER_PAGE_PATH } from '../src/core/managerPage.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');
const OPTIONS = read('src/options/OptionsPage.tsx');
const BACKEND_STATUS = read('src/components/layout/backendStatus.ts');

/** 剥注释再断言：注释里会引用旧文案，不能参与断言。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
const OPTIONS_CODE = stripComments(OPTIONS);

// ══════════════════════════════════════════════════════════════════════════
// ① 出口：回到管理页
// ══════════════════════════════════════════════════════════════════════════
describe('① 设置页必须有一条永远存在的出口（「后退」不是出路）', () => {
  it('判据：已有管理页 ⇒ 切过去；没有 ⇒ 新开一个（两条路都能看到列表）', () => {
    // 反向断言证伪「常量实现」：两个入参必须给出**不同**的动作。
    // 如果哪天有人把它改成 `return 'open-new'`，这条立刻红。
    assert.equal(managerPageExitAction(true), 'focus-existing');
    assert.equal(managerPageExitAction(false), 'open-new');
    assert.notEqual(
      managerPageExitAction(true),
      managerPageExitAction(false),
      '两种输入必须给出不同动作 —— 否则「已经有管理页」时用户会得到第二个'
    );
  });

  it('管理页路径是单一真相源，且指向真实的管理页入口', () => {
    // 为什么钉这个：`popup.html` 是 vite 的入口壳（里面只有一行 redirect.js），
    // 用它会让用户先白一下再跳转。真身是 src/popup/index.html。
    assert.equal(MANAGER_PAGE_PATH, 'src/popup/index.html');
    // TabManager 必须用同一个常量（否则两处手抄早晚会漂）。
    const tabManager = read('src/background/TabManager.ts');
    assert.match(
      tabManager,
      /chrome\.runtime\.getURL\(MANAGER_PAGE_PATH\)/,
      'TabManager 必须引用单源常量，不得手抄字符串'
    );
    assert.ok(
      !/getURL\('src\/popup\/index\.html'\)/.test(tabManager),
      'TabManager 里不得再出现手抄的路径字面量'
    );
  });

  it('设置页的出口真的接了判据与单源路径', () => {
    assert.match(
      OPTIONS_CODE,
      /managerPageExitAction\(/,
      '出口必须用判据决定动作（不是无条件 create）'
    );
    assert.match(
      OPTIONS_CODE,
      /chrome\.runtime\.getURL\(MANAGER_PAGE_PATH\)/,
      '出口必须用单源路径'
    );
    // 切到已有标签还不够 —— 那个标签可能在另一个窗口里。
    assert.match(
      OPTIONS_CODE,
      /chrome\.windows\.update\(/,
      '切到已有管理页时必须连带把那个窗口点亮（否则用户点了没反应）'
    );
  });

  it('出口在页首（用户不需要先滚到底才找得到）', () => {
    const headerAt = OPTIONS_CODE.indexOf('<header>');
    const exitAt = OPTIONS_CODE.indexOf('handleBackToManager()');
    assert.ok(headerAt > -1 && exitAt > -1, '应能找到 header 与出口接线点');
    assert.ok(exitAt > headerAt, '出口必须在 header 之后');
    // 而且必须早于第一个设置区块 —— 否则它就是「滚到底才看得到」。
    const firstSection = OPTIONS_CODE.indexOf('aria-labelledby="sec-sync"');
    assert.ok(
      exitAt < firstSection,
      '出口必须排在第一个设置区块之前（在页首第一屏）'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ② 账号：设置页自己的登录入口 + 文案不得指向不存在的菜单
// ══════════════════════════════════════════════════════════════════════════
describe('② 设置页必须自带登录入口（它没有右上角菜单）', () => {
  it('判据：云端未登录 ⇒ 提示登录；自带存储 ⇒ 不要账号；已登录 ⇒ 显示账号', () => {
    assert.equal(accountPanelMode('supabase', false), 'signed-out');
    assert.equal(accountPanelMode('supabase', true), 'signed-in');
    // WebDAV 用户没有 TapStack 账号 —— 给他显示「去登录」是纯噪音。
    assert.equal(accountPanelMode('webdav', false), 'not-needed');
    // 已经登录的人哪怕切到 WebDAV 也仍然显示账号（他确实登录着）。
    assert.equal(accountPanelMode('webdav', true), 'signed-in');
  });

  it('判据真的按后端分流（证伪「只看登录态」的实现）', () => {
    // 这是本条最容易写错的地方：只判 isAuthenticated 会让 WebDAV 用户
    // 看到一个与他无关的「去登录」。
    assert.notEqual(
      accountPanelMode('supabase', false),
      accountPanelMode('webdav', false),
      '两个后端在未登录时必须是两种形态'
    );
  });

  it('设置页的提示文案不得再让用户去「右上角菜单」（本页没有菜单）', () => {
    // 这是本次修掉的那句死指针。它必须**彻底消失**，
    // 而不是「再加一句本页入口」—— 留着前半句用户仍会去找菜单。
    assert.ok(
      !OPTIONS_CODE.includes('请先在右上角菜单登录'),
      '「请先在右上角菜单登录」在设置页里指向一个不存在的入口'
    );
    assert.ok(
      !OPTIONS_CODE.includes('右上角菜单'),
      '设置页的代码里不该再出现「右上角菜单」这个说法'
    );
  });

  it('云端未登录的提示必须指向**本页**真实存在的入口', () => {
    const copy = loginHintCopy('supabase');
    assert.match(copy, /登录/, '必须说清缺的是登录');
    assert.match(copy, /本页/, '必须指向本页 —— 设置页没有菜单');
    assert.doesNotMatch(copy, /菜单/, '不得再指向菜单');
  });

  it('组件真的挂了登录 / 退出入口与弹窗', () => {
    assert.match(
      OPTIONS_CODE,
      /<AuthModal/,
      '必须真的渲染 AuthModal（否则「去登录」是个空按钮）'
    );
    assert.match(
      OPTIONS_CODE,
      /setAuthModal\('login'\)/,
      '未登录态的按钮必须能打开登录弹窗'
    );
    assert.match(
      OPTIONS_CODE,
      /dispatch\(signOut\(\)\)/,
      '既然能登录就必须能退出 —— 否则用户只能跑去管理页退'
    );
  });

  it('账号区按判据渲染，不是无条件渲染', () => {
    assert.match(
      OPTIONS_CODE,
      /accountPanelMode\(/,
      '账号区必须走判据（WebDAV 用户不该看到它）'
    );
    assert.match(
      OPTIONS_CODE,
      /accountMode === 'not-needed'/,
      '必须有「不需要账号」这条分支'
    );
  });

  it('autoSyncBlockedCopy 不再假设调用点在管理页', () => {
    // 这条文案有两个渲染位置（管理页有菜单、设置页没有），
    // 所以「下一步去哪儿」必须由调用方传进来，不能写死。
    assert.match(
      BACKEND_STATUS,
      /loginEntry/,
      'autoSyncBlockedCopy 必须收一个「登录入口在哪儿」的参数'
    );
    // 设置页必须传 '本页'。
    assert.match(
      OPTIONS_CODE,
      /autoSyncBlockedCopy\([^)]*'本页'/,
      '设置页调用时必须传「本页」，否则用户会去找一个不存在的菜单'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ③ 「自带存储配置」默认折叠
// ══════════════════════════════════════════════════════════════════════════
describe('③ 自带存储配置：默认折叠，但永远可展开', () => {
  it('判据：用云端且从没配过 ⇒ 折叠；用 WebDAV 或已配过 ⇒ 展开', () => {
    assert.equal(shouldCollapseWebDavSection('supabase', false), true);
    assert.equal(shouldCollapseWebDavSection('supabase', true), false);
    assert.equal(shouldCollapseWebDavSection('webdav', false), false);
    assert.equal(shouldCollapseWebDavSection('webdav', true), false);
  });

  it('判据的两个入参都真的起作用（证伪「只看一个」的实现）', () => {
    // 只看 syncBackend：已配过但用云端的人会被折叠（违背「想一眼看到配好了」）。
    assert.notEqual(
      shouldCollapseWebDavSection('supabase', false),
      shouldCollapseWebDavSection('supabase', true),
      '「配过没有」必须影响结果'
    );
    // 只看 isWebDavConfigured：WebDAV 用户（没配过）会被折叠（他正要用这块）。
    assert.notEqual(
      shouldCollapseWebDavSection('supabase', false),
      shouldCollapseWebDavSection('webdav', false),
      '「用的哪个后端」必须影响结果'
    );
  });

  it('折叠时两个通道一起关（hidden + aria-hidden）', () => {
    const collapsed = collapsiblePanelState(false);
    assert.equal(collapsed.hidden, true, 'hidden 让浏览器把它移出 Tab 序列');
    assert.equal(collapsed['aria-hidden'], true, 'aria-hidden 告诉读屏它不存在');
    const expanded = collapsiblePanelState(true);
    assert.equal(expanded.hidden, false);
    assert.equal(expanded['aria-hidden'], false);
  });

  it('组件：面板永远在（不按 syncBackend 条件渲染），只是默认收起', () => {
    // ⚠️ 这条守的是**上一轮修掉的死锁不能回来**：
    //    面板要切过去才出现、切换入口又在面板里 ⇒ 永远打不开。
    assert.match(OPTIONS_CODE, /<WebDavSettings\s*\/>/, '面板必须无条件渲染');
    // 渲染点往前看一段，不得有 syncBackend 的三元判断。
    const panelAt = OPTIONS_CODE.indexOf('<WebDavSettings');
    const before = OPTIONS_CODE.slice(Math.max(0, panelAt - 400), panelAt);
    assert.ok(
      !/syncBackend === 'webdav'\s*\?/.test(before),
      '面板不得受 syncBackend 条件约束（那正是死锁条件）'
    );
    // 折叠开关必须真的接到判据上。
    assert.match(
      OPTIONS_CODE,
      /shouldCollapseWebDavSection\(/,
      '默认展开态必须由判据决定'
    );
    assert.match(
      OPTIONS_CODE,
      /collapsiblePanelState\(/,
      '折叠时必须走两个通道（hidden + aria-hidden）'
    );
  });

  it('用户手动展开后不再被自动改回去（自动改回去 = 说不清的 bug）', () => {
    // 判据只算**初始值**：`webDavExpanded === null` 时才用判据，
    // 用户点过之后以他的选择为准。
    assert.match(
      OPTIONS_CODE,
      /webDavExpanded\s*\?\?\s*!shouldCollapseWebDavSection\(/,
      '展开态必须是「用户的显式选择 ?? 判据算出的初始值」'
    );
  });

  it('折叠按钮是标准 disclosure（aria-expanded + aria-controls 指向面板 id）', () => {
    assert.match(OPTIONS_CODE, /aria-expanded=\{isWebDavPanelExpanded\}/);
    const controls = OPTIONS_CODE.match(/aria-controls="([^"]+)"/)?.[1];
    assert.ok(controls, '折叠按钮必须有 aria-controls');
    assert.ok(
      OPTIONS_CODE.includes(`id="${controls}"`),
      `aria-controls 指向的 id="${controls}" 必须在同一份源码里真实存在`
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ④ 同步间隔：始终渲染，但必须说清「关着时不生效」
// ══════════════════════════════════════════════════════════════════════════
describe('④ 同步间隔：始终渲染（已定决定），但关着时必须说清不生效', () => {
  it('开着时说的是「间隔越短越快」，关着时必须说清它现在不生效', () => {
    const on = syncIntervalHint(true);
    const off = syncIntervalHint(false);
    assert.match(on, /间隔越短/, '开着时讲代价');
    assert.match(off, /不生效/, '关着时必须说清这一档现在不生效');
    assert.match(off, /自动同步/, '必须点名是哪个开关');
    assert.notEqual(on, off, '两种状态必须是两句话');
  });

  it('radiogroup 仍然无条件渲染（不推翻 2026-10-17 B8 的决定）', () => {
    // 这条是**反向**守卫：本轮**没有**把它藏起来。
    // 仓库里已定的决定是「常显」——把「多久跑一次」藏起来，用户想设时找不到。
    // 如果有人把条件渲染加回来，这条会红，逼他先论证为什么推翻那条决定。
    assert.match(
      OPTIONS_CODE,
      /SYNC_INTERVAL_CHOICES\.map\(/,
      '档位必须仍然被无条件映射出来'
    );
    const mapAt = OPTIONS_CODE.indexOf('SYNC_INTERVAL_CHOICES.map(');
    const before = OPTIONS_CODE.slice(Math.max(0, mapAt - 300), mapAt);
    assert.ok(
      !/syncEnabled\s*&&/.test(before),
      '档位不得被 syncEnabled 条件包住 —— 那推翻了「始终渲染」这条已定决定'
    );
    // 原来的「始终渲染」说明必须还在（它记录了为什么这样做）。
    assert.match(
      OPTIONS,
      /档位行：\*\*始终渲染\*\*/,
      '保留常显的理由必须写在注释里'
    );
  });

  it('提示文案接的是判据函数，不是手写的三元', () => {
    assert.match(
      OPTIONS_CODE,
      /syncIntervalHint\(/,
      '提示文案必须来自单源函数（两处手写会漂）'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ⑤ 渲染层：真的渲染一遍，看 HTML
// ══════════════════════════════════════════════════════════════════════════
describe('⑤ 真实渲染：页首有出口、账号区按状态出现', () => {
  // 与 tests/optionsInertGate.test.ts 同一套桩：只提供被读到的几个 API，
  // 不提供文档树与事件系统。
  const lsData = new Map<string, string>();
  (globalThis as Record<string, unknown>).window = {
    localStorage: {
      get length() {
        return lsData.size;
      },
      key: (i: number) => [...lsData.keys()][i] ?? null,
      getItem: (k: string) => (lsData.has(k) ? (lsData.get(k) as string) : null),
      setItem: (k: string, v: string) => void lsData.set(k, String(v)),
      removeItem: (k: string) => void lsData.delete(k),
      clear: () => lsData.clear(),
    },
    matchMedia: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
  (globalThis as Record<string, unknown>).localStorage = (
    globalThis as unknown as { window: { localStorage: unknown } }
  ).window.localStorage;
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => undefined,
        remove: async () => undefined,
      },
      onChanged: { addListener: () => undefined, removeListener: () => undefined },
    },
    runtime: { getManifest: () => ({ version: 'test' }) },
  };

  const renderOptions = async (): Promise<string> => {
    const React = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { Provider } = await import('react-redux');
    const { createStore } = await import('../src/store/index.ts');
    const mod = await import('../src/options/OptionsPage.tsx');
    return renderToStaticMarkup(
      React.createElement(
        Provider,
        { store: createStore() } as unknown as React.ComponentProps<typeof Provider>,
        React.createElement((mod as { OptionsPage: React.FC }).OptionsPage)
      )
    );
  };

  it('页首渲染出「回到 TapStack」出口', async () => {
    const html = await renderOptions();
    assert.ok(html.length > 0, '渲染失败 —— 下面的断言会变成恒真');
    assert.match(html, /回到 TapStack/, '出口必须真的渲染出来');
    // 它必须是一个按钮（可键盘激活），不是一段纯文本。
    // 正则要容许按钮内部先有一个装饰性 <svg>（图标在文字之前）。
    assert.match(
      html,
      /<button[^>]*>(?:(?!<\/button>)[\s\S])*?回到 TapStack(?:(?!<\/button>)[\s\S])*?<\/button>/,
      '出口必须是 button（键盘可达）'
    );
  });

  it('未登录 + 云端（默认后端）⇒ 渲染出登录入口', async () => {
    const html = await renderOptions();
    // createStore() 的 auth 初始态是未登录，settings 默认 syncBackend='supabase'。
    assert.match(html, /尚未登录 TapStack 云端/, '未登录时必须显示账号区');
    assert.match(html, /登录 \/ 注册/, '必须给出可点的登录入口');
    // 反向：不得再让用户去找菜单。
    assert.ok(
      !html.includes('右上角菜单'),
      '渲染产物里不得出现「右上角菜单」（本页没有菜单）'
    );
  });

  it('「自带存储配置」的折叠按钮渲染出 aria-expanded，且面板带 hidden', async () => {
    const html = await renderOptions();
    assert.match(html, /aria-expanded="false"/, '默认应折叠（云端 + 未配过）');
    // 面板在折叠态必须带 hidden（真移出 Tab 序列，不只是视觉隐藏）。
    assert.match(
      html,
      /id="webdav-settings-panel"[^>]*hidden/,
      '折叠态的面板必须带 hidden —— 否则键盘用户会 Tab 进一片看不见的输入框'
    );
    assert.match(
      html,
      /id="webdav-settings-panel"[^>]*aria-hidden="true"/,
      '折叠态的面板必须同时 aria-hidden'
    );
  });
});
