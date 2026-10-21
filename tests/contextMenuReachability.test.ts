// 右键菜单必须在**用户真正会右键的地方**出现 —— 2026-10-20 审计 A-12。
//
// 真实缺陷（主审核实代码 + 竞品对比后确认）：
//
//   修复前三个菜单项的 contexts 全是 ['action'] ⇒ **只在扩展图标上右键才出现**。
//   而用户最自然的位置是**在网页标签页上右键** —— OneTab 等竞品就是在那儿做的。
//   商店文案 CHROMEWEBSTORE.md 写的是「右键菜单：不打开管理界面，也能保存当前
//   标签页或窗口里的其他标签页」—— **那句话在修复前是假的**：
//   在网页上右键，TapStack 什么也没有。
//
// 另有两个连带问题：
//   ① 保存后**强制打开管理页**（`openTabManager(true)`），与「不打开管理界面」
//      的承诺正面相反；而且快捷键路径不打开、图标点击路径打开、菜单路径打开 ——
//      三条入口三种行为。
//   ② 在网页上下文里，菜单标题说「当前标签」有歧义（活动标签？还是我右键的
//      这个？）。而 Chrome 的 `contextMenus.create` 一个调用只有**一个** title，
//      共享给它的所有 contexts —— 想按上下文给不同标题，必须拆成两个 id。
//
// ── 为什么 id 从常量模块读，而不是在测试里写死字符串 ─────────────────────
//
// 菜单 id 已经被抽到 `src/background/contextMenuPolicy.ts` 的 `CONTEXT_MENU_IDS`
// 里（Service Worker 入口在 node:test 里没法 import —— 它一进来就
// `chrome.runtime.getManifest()`；把判定抽成纯函数模块才能被单测覆盖）。
//
// 测试若在源码里写死 'saveCurrentTab'，那么**有人改 id 时测试会红** ——
// 但那不是缺陷，只是重构。若测试从常量模块读 id，则它钉住的是
// **语义**（哪个 id 在哪个上下文出现、标题说了什么），而不是字面量。
// 这正是本仓的纪律：断言不变量，不钉字面量。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CONTEXT_MENU_IDS } from '../src/background/contextMenuPolicy.ts';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const sw = () => read('src/service-worker.ts');

/**
 * 取出某个菜单项的 create 调用片段。
 *
 * 匹配 `id: <常量表达式>` —— 因为源码里写的是 `id: CONTEXT_MENU_IDS.xxx`，
 * 不是字面量。匹配到 `id:` 之后**跨过本条 create 的其余字段**，
 * 直到下一个 `chrome.contextMenus.create(` 或本条 create 结束。
 */
const createBlock = (constName: keyof typeof CONTEXT_MENU_IDS): string => {
  const src = sw();
  const needle = `id: CONTEXT_MENU_IDS.${constName}`;
  const at = src.indexOf(needle);
  assert.ok(at > -1, `service-worker.ts 里应能找到 ${needle}`);
  // 从这条 create 往后取，直到下一个 create 开始
  const next = src.indexOf('chrome.contextMenus.create(', at);
  return src.slice(at, next === -1 ? src.length : next);
};

const contextsOf = (constName: keyof typeof CONTEXT_MENU_IDS): string => {
  const block = createBlock(constName);
  // contexts 现在有两种写法：
  //   · 字面量数组            → contexts: ['action']
  //   · 按版本裁剪的表达式     → contexts: resolveContextTypes([...], ...)
  // 两种都要能取到「这一项声明了哪些上下文」。
  const literal = block.match(/contexts:\s*\[([^\]]*)\]/);
  if (literal) return literal[1];
  const computed = block.match(/contexts:\s*resolveContextTypes\(\s*\[([^\]]*)\]/);
  assert.ok(computed, `${constName} 的 create 里应能找到 contexts`);
  return computed[1];
};

/**
 * 把 contexts 片段里的写法统一成「词表名」序列。
 *
 * 源码里两种写法都要认：
 *   · 字面量         'page'
 *   · 常量表引用     CONTEXT_TYPES.page
 * 断言的是**语义**（这一项在哪些上下文出现），不是写法 ——
 * 所以先归一化再断言。
 */
const contextNames = (constName: keyof typeof CONTEXT_MENU_IDS): string[] =>
  contextsOf(constName)
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const literal = part.match(/^'([^']+)'$/);
      if (literal) return literal[1];
      const fromConst = part.match(/^CONTEXT_TYPES\.(\w+)$/);
      if (fromConst) return fromConst[1];
      throw new Error(`无法识别的 context 写法: ${part}`);
    });

const titleOf = (constName: keyof typeof CONTEXT_MENU_IDS): string => {
  const block = createBlock(constName);
  const match = block.match(/title:\s*'([^']*)'/);
  assert.ok(match, `${constName} 的 create 里应能找到 title`);
  return match[1];
};

// ─────────────────────────────────────────────────────────────────────────
// 1. 菜单必须出现在网页上下文
// ─────────────────────────────────────────────────────────────────────────

describe('右键菜单的可达性', () => {
  it('「保存标签页」必须注册在 page 上下文（网页上右键能出现）', () => {
    assert.ok(
      contextNames('saveCurrentTab').includes('page'),
      "网页上下文必须包含 'page' —— 否则用户在网页上右键什么也没有"
    );
  });

  it('「保存标签页」也注册在 tab 上下文（右键标签栏上的标签标题）', () => {
    // 'tab' = 右键**标签栏上的标签页标题**（不是网页内容区）。
    // 那是用户最想「收起来」的位置（正在浏览时右键标签标题）。
    // 旧版 Chrome 不认识这个上下文 —— 运行时裁剪见 resolveContextTypes，
    // 但**声明**里必须有它，否则新 Chrome 上这个入口根本不存在。
    assert.ok(
      contextNames('saveCurrentTab').includes('tab'),
      "标签栏上下文必须包含 'tab'"
    );
  });

  it('「打开标签管理器」与「保存其他标签」只在 action 上下文出现', () => {
    // 这两项在网页上下文出现是危险的：
    //   · 打开管理器 = 抢走用户正在浏览的现场
    //   · 保存其他标签 = 关掉当前窗口除一个之外的全部标签
    for (const id of ['openTabManager', 'saveOtherTabs'] as const) {
      assert.ok(
        !contextNames(id).includes('page'),
        `${id} 不该出现在网页上下文（破坏性动作不该随手可达）`
      );
      assert.ok(
        !contextNames(id).includes('tab'),
        `${id} 不该出现在标签栏上下文（破坏性动作不该随手可达）`
      );
    }
  });

  it('不能只有 action 上下文（那正是原缺陷）', () => {
    assert.ok(
      !contextNames('saveCurrentTab').includes('action'),
      'saveCurrentTab 现在是网页/标签栏上下文专用项'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 标题：必须按上下文分开，且各自说清破坏性
// ─────────────────────────────────────────────────────────────────────────

describe('菜单标题：按上下文分开，且说清破坏性', () => {
  it('网页上下文的标题用「此标签页」（消除「当前」的歧义）', () => {
    const title = titleOf('saveCurrentTab');
    assert.match(title, /此标签页/, '网页上下文要说「此」—— 明确指向用户右键的那一个');
    assert.match(title, /并关闭/, '必须说清会关闭（保存 = 剪切）');
  });

  it('图标上下文的标题用「当前标签页」并单独成项', () => {
    const title = titleOf('saveCurrentTabFromIcon');
    assert.match(title, /当前标签页/);
    assert.match(title, /并关闭/, '必须说清会关闭');
  });

  it('两个 id 各自独立注册（Chrome 的一个 create 只有一个 title）', () => {
    assert.notEqual(
      CONTEXT_MENU_IDS.saveCurrentTab,
      CONTEXT_MENU_IDS.saveCurrentTabFromIcon,
      '两个上下文必须用两个 id —— 一个 create 只有一个 title'
    );
    const createCalls = sw().match(/chrome\.contextMenus\.create\(/g) ?? [];
    assert.ok(createCalls.length >= 4, `应至少有 4 个菜单项，实际 ${createCalls.length}`);
  });

  it('「保存其他标签」标题必须说清它会关掉多个标签', () => {
    const title = titleOf('saveOtherTabs');
    assert.match(title, /其他/, '要说清是「其他」标签（不是当前这个）');
    assert.match(title, /并关闭/, '必须说清会关闭');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 点击处理：存对标签、不强开管理页
// ─────────────────────────────────────────────────────────────────────────

describe('菜单点击：存对标签，且不抢走现场', () => {
  it('两个 id 都走同一条保存逻辑', () => {
    const src = sw();
    assert.match(
      src,
      /info\.menuItemId === CONTEXT_MENU_IDS\.saveCurrentTab\s*\|\|\s*\n?\s*info\.menuItemId === CONTEXT_MENU_IDS\.saveCurrentTabFromIcon/,
      '两个 id 必须共用一个处理分支（否则文案/行为会漂移）'
    );
  });

  it('存的是传进来的那个 tab（用户右键的那个），不是重新查活动标签', () => {
    const src = sw();
    const start = src.indexOf('info.menuItemId === CONTEXT_MENU_IDS.saveCurrentTab');
    assert.ok(start > 0);
    const body = src.slice(start, start + 1400);
    assert.match(body, /saveCurrentTab\(tab\)/, '必须把 Chrome 传来的 tab 直接传下去');
    // 不能在这个分支里另查 active tab —— 那会存错标签并关错标签
    const branchEnd = body.indexOf('saveOtherTabs');
    const branch = branchEnd === -1 ? body : body.slice(0, branchEnd);
    assert.doesNotMatch(
      branch,
      /query\(\{\s*active:\s*true/,
      '这个分支不能自己查活动标签（那会存错、也关错）'
    );
  });

  it('右键保存后**不**打开管理页（否则与「不打开管理界面」的承诺相反）', () => {
    const src = sw();
    const start = src.indexOf('info.menuItemId === CONTEXT_MENU_IDS.saveCurrentTab');
    assert.ok(start > 0);
    // 取「保存当前标签」这个分支的**代码正文**（去掉注释，避免被注释里的
    // `openTabManager(true)` 字样误导）
    const body = src.slice(start, start + 2600);
    const codeOnly = body
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .join('\n');
    const branchEnd = codeOnly.indexOf('saveOtherTabs');
    const branch = branchEnd === -1 ? codeOnly : codeOnly.slice(0, branchEnd);
    assert.doesNotMatch(
      branch,
      /openTabManager\s*\(/,
      '右键保存路径不得打开管理页 —— 快捷键路径不打开，入口之间必须一致'
    );
  });

  it('「保存其他标签」这条右键路径也不得打开管理页', () => {
    // 上一条只覆盖了「保存当前标签页」那一个分支 —— 变异验证时把
    // `saveOtherTabs` 分支里的 `openTabManager(true)` 加回去，测试竟然
    // 没红（漏网）。这一条补上：**两个保存分支都不许打开管理页**。
    const src = sw();
    const start = src.indexOf('info.menuItemId === CONTEXT_MENU_IDS.saveOtherTabs');
    assert.ok(start > 0, '应能找到 saveOtherTabs 分支');
    const body = src.slice(start, start + 2000);
    const codeOnly = body
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .join('\n');
    // 分支的结束点是 catch 块
    const branchEnd = codeOnly.indexOf('} catch');
    const branch = branchEnd === -1 ? codeOnly : codeOnly.slice(0, branchEnd);
    assert.doesNotMatch(
      branch,
      /openTabManager\s*\(/,
      '「保存其他标签」也不得打开管理页 —— 与「保存当前标签页」及快捷键路径保持一致'
    );
  });

  it('网页上下文与图标上下文可区分（两个 id 本身就是判据）', () => {
    const src = sw();
    assert.match(
      src,
      /const fromPageContext = info\.menuItemId === CONTEXT_MENU_IDS\.saveCurrentTab/,
      '必须按 id 区分上下文（不能用 pageUrl 之类的启发式）'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. 承诺一致性：商店文案说的事，产品必须做得到
// ─────────────────────────────────────────────────────────────────────────

describe('承诺一致性：文案说的必须做得到', () => {
  it('商店文案承诺了「在网页标签页上右键也能保存」', () => {
    const store = read('CHROMEWEBSTORE.md');
    assert.match(
      store,
      /右键菜单[\s\S]{0,200}网页标签页上右键/,
      '商店文案应说明右键菜单在网页上可用'
    );
  });

  it('manifest 申请了 contextMenus 权限', () => {
    const manifest = JSON.parse(read('manifest.json'));
    assert.ok(
      manifest.permissions.includes('contextMenus'),
      '必须有 contextMenus 权限，否则菜单根本注册不了'
    );
  });
});
