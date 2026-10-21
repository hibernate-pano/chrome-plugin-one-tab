// 键盘可达性与焦点管理的回归（2026-10-20）。
//
// 【本文件要防的回归类别】
// 一批**已由 Playwright 真机实测确认**的键盘/焦点/读屏缺陷：
//
//   P0-1  卡片「更多」菜单：方向键完全无反应、Tab 要穿过整个列表才进得去
//         （4 标签会话 16 次 Tab、15 标签会话 37 次 Tab）、
//         容器 role="menu" 但子项没有 role="menuitem"、summary 没有 aria-expanded。
//   P0-2  导入子菜单：`<label role="menuitem">`（tabIndex=-1 不可聚焦）+
//         内层 `display:none` 的 file input ⇒ 键盘与读屏都到不了。
//   P1-5  方向键在「导入数据」上死循环 ⇒ 其后的「问题反馈」「删除所有会话」全部不可达。
//   P0-3  确认框关闭后焦点丢到 <body>（四条路径全部复现）；
//         且 Esc 还焦、点「取消」丢焦 —— 同一个弹层两种行为。
//   P2-1  重命名输入框在「没改内容」或「清空」后卡在编辑态出不来。
//   P2-5  折叠按钮的 aria-label 全部同名（「折叠会话」「折叠会话」…）。
//   P1-7  搜索结果数量变化不被读屏播报（整页 [aria-live] 元素数 = 0）。
//
// 断言方式：本仓没有 jsdom / testing-library（不允许为此装依赖），
// 所以分两类：
//   (a) 纯函数断言 —— 决策逻辑都抽成了不依赖 DOM 的纯函数，直接跑行为断言。
//   (b) 源码结构断言 —— .tsx 无法被 node --experimental-strip-types 加载
//       （tests/_alias-loader.mjs 的 ts.transpileModule 不转 JSX），
//       用 node:fs 读源码，钉住「role/aria 不能被删」「onClick 不能回到裸 div」
//       「降级逻辑不能被删掉」这类回归。
//       这是本仓既有惯例（见 a11yDialogs.test.ts / a11yLists.test.ts）。
//
// 断言钉的是**不变量**（「不可聚焦的项永远不会被方向键选中」、
// 「还焦失败时绝不返回 body」），不是字面量 —— 菜单项增删时不该让测试变红。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  collectFocusableIndices,
  isFocusableMenuItem,
  resolveMenuNavigation,
} from '../src/utils/menuKeyboard.ts';
import { resolveFocusRestoreTarget } from '../src/hooks/useKeyboardNavigation.ts';
import { resolveRenameDecision } from '../src/domain/tabGroup/renameDecision.ts';

const read = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const TAB_GROUP = read('src/components/tabs/TabGroup.tsx');
const HEADER_DROPDOWN = read('src/components/layout/HeaderDropdown.tsx');
const SEARCH_RESULT_LIST = read('src/components/search/SearchResultList.tsx');
// 2026-10-20 审计 A-14 起，筛选浏览态的结果计数由共享文案函数产出
// （searchBrowseMode 的 browseSummaryCopy / searchSummaryCopy），
// 所以「live region 承载了动态计数」这件事不再表现为组件里的一行字面量。
const SEARCH_BROWSE_MODE = read('src/components/search/searchBrowseMode.ts');
const KEYBOARD_HOOKS = read('src/hooks/useKeyboardNavigation.ts');
const MODAL_FRAME = read('src/components/common/ModalFrame.tsx');

/** 去注释后的源码：注释里会引用旧写法，不能参与断言。 */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ══════════════════════════════════════════════════════════════════════════
// P0-2 + P1-5：方向键必须跳过不可聚焦的项
// ══════════════════════════════════════════════════════════════════════════

describe('菜单方向键：不可聚焦的项永远不会被选中', () => {
  it('isFocusableMenuItem：tabIndex < 0 的项不可聚焦（<label role=menuitem> 就是这种）', () => {
    // 原生 <label> 没有 tabindex ⇒ tabIndex === -1 ⇒ 方向键 focus() 无效。
    // 这正是「方向键永远停在导入数据」的死循环根因。
    assert.equal(isFocusableMenuItem({ tabIndex: -1 }), false);
    assert.equal(isFocusableMenuItem({ tabIndex: 0 }), true);
    assert.equal(isFocusableMenuItem({ tabIndex: 1 }), true);
  });

  it('isFocusableMenuItem：disabled 与不可见的项也不可聚焦', () => {
    assert.equal(isFocusableMenuItem({ tabIndex: 0, disabled: true }), false);
    assert.equal(isFocusableMenuItem({ tabIndex: 0, hidden: true }), false);
  });

  it('整条链：候选项 → 可聚焦下标 → 方向键决策（不变量端到端）', () => {
    // 真实的菜单项形状（含两个 <label role=menuitem>：tabIndex=-1 不可聚焦）
    const candidates = [
      { tabIndex: 0 }, // 0 登录/注册
      { tabIndex: 0 }, // 1 设置…
      { tabIndex: 0 }, // 2 导出数据
      { tabIndex: -1 }, // 3 JSON 格式（label，不可聚焦）
      { tabIndex: -1 }, // 4 OneTab 格式（label，不可聚焦）
      { tabIndex: 0 }, // 5 问题反馈
      { tabIndex: 0 }, // 6 删除所有会话
    ];

    const focusable = collectFocusableIndices(candidates);
    // 不可聚焦的两项**不得**出现在候选集里
    assert.ok(
      !focusable.includes(3) && !focusable.includes(4),
      `不可聚焦的项不得进候选集（实得 ${focusable.join(',')}）`
    );
    assert.deepEqual(focusable, [0, 1, 2, 5, 6]);

    // 从「导出数据」(2) 连按 ↓ 走一圈，每一站都必须是可聚焦项
    let current = 2;
    const visited: number[] = [];
    for (let i = 0; i < focusable.length; i += 1) {
      const decision = resolveMenuNavigation(focusable, current, 'ArrowDown');
      if (decision.kind !== 'move') break;
      current = decision.index;
      visited.push(current);
    }
    assert.equal(visited.length, focusable.length, '方向键必须能走完一圈');
    for (const stop of visited) {
      assert.ok(
        isFocusableMenuItem(candidates[stop]),
        `方向键停在了不可聚焦的项 ${stop} 上（死循环回归）`
      );
    }
  });

  it('resolveMenuNavigation：候选集里的每一项都是可聚焦的（不变量）', () => {
    // 候选集由调用方按 isFocusableMenuItem 过滤；这里钉住决策函数
    // 永远不会跳到候选集之外的下标。
    const focusable = [1, 3];
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End'] as const) {
      const decision = resolveMenuNavigation(focusable, 1, key);
      if (decision.kind === 'none') continue;
      assert.ok(
        focusable.includes(decision.index),
        `${key} 选中了不在可聚焦候选集里的下标 ${decision.index}`
      );
    }
  });

  it('resolveMenuNavigation：跳过不可聚焦的项，方向键不会卡在死循环里', () => {
    // 菜单项下标：0=登录 1=设置 2=导出数据 3=JSON格式(label,不可聚焦)
    //             4=OneTab格式(label,不可聚焦) 5=问题反馈 6=删除所有会话
    // 可聚焦的只有 [0,1,2,5,6] —— 3、4 是 <label role=menuitem>。
    const focusable = [0, 1, 2, 5, 6];
    // 从「导出数据」(2) 按 ↓ ⇒ 必须越过两个不可聚焦的项，落到「问题反馈」(5)。
    const down = resolveMenuNavigation(focusable, 2, 'ArrowDown');
    assert.equal(down.kind, 'move');
    assert.equal(down.kind === 'move' ? down.index : -1, 5);

    // 按 ↑ 从「导入数据」(2) ⇒ 落到「导出数据」(1)，**不是**那两个 label。
    const up = resolveMenuNavigation(focusable, 2, 'ArrowUp');
    assert.equal(up.kind === 'move' ? up.index : -1, 1);

    // 从头连按 ↓ 走一圈，**每一站**都必须是可聚焦项（不变量：永不卡住）。
    const visited: number[] = [];
    let current = 0;
    for (let i = 0; i < focusable.length; i += 1) {
      const decision = resolveMenuNavigation(focusable, current, 'ArrowDown');
      if (decision.kind !== 'move') break;
      current = decision.index;
      visited.push(current);
    }
    assert.equal(visited.length, focusable.length, '方向键应当能走完一圈可聚焦项');
    assert.deepEqual(
      [...new Set(visited)].sort((a, b) => a - b),
      [...focusable].sort((a, b) => a - b),
      '方向键走过的每一站都必须落在可聚焦集合内'
    );
  });

  it('resolveMenuNavigation：焦点不在菜单内时，上下键进入菜单的首/末项', () => {
    const focusable = [0, 2, 5];
    const down = resolveMenuNavigation(focusable, -1, 'ArrowDown');
    assert.equal(down.kind, 'enter');
    assert.equal(down.kind === 'enter' ? down.index : -1, 0);

    const up = resolveMenuNavigation(focusable, -1, 'ArrowUp');
    assert.equal(up.kind, 'enter');
    assert.equal(up.kind === 'enter' ? up.index : -1, 5);
  });

  it('resolveMenuNavigation：Home/End 跳到首/末**可聚焦**项', () => {
    const focusable = [0, 2, 5];
    const home = resolveMenuNavigation(focusable, 2, 'Home');
    assert.equal(home.kind === 'edge' ? home.index : -1, 0);
    const end = resolveMenuNavigation(focusable, 2, 'End');
    assert.equal(end.kind === 'edge' ? end.index : -1, 5);
  });

  it('resolveMenuNavigation：没有可聚焦项时什么都不做（不 preventDefault）', () => {
    assert.equal(resolveMenuNavigation([], 0, 'ArrowDown').kind, 'none');
    assert.equal(resolveMenuNavigation([], -1, 'ArrowUp').kind, 'none');
  });

  it('HeaderDropdown 的方向键处理器用了「可聚焦」候选集，而不是 role 候选集', () => {
    // 旧实现：`[role="menuitem"]:not([disabled])` —— role ≠ 可聚焦。
    const src = code(HEADER_DROPDOWN);
    assert.ok(
      src.includes('collectFocusableMenuItemIndices(root)'),
      '方向键必须用可聚焦候选集，否则会卡在不可聚焦的项上'
    );
    assert.ok(
      !src.includes("querySelectorAll<HTMLElement>('[role=\"menuitem\"]:not([disabled])')"),
      '旧的「role 候选集」不得复活'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// P0-2：导入子菜单必须是真按钮
// ══════════════════════════════════════════════════════════════════════════

describe('导入子菜单：键盘与读屏都到得了', () => {
  it('两个导入项是 <button role="menuitem">，不再是 <label role="menuitem">', () => {
    const src = code(HEADER_DROPDOWN);
    assert.ok(
      !/<label[^>]*role="menuitem"/.test(src),
      '导入项不得回退成 <label role="menuitem">（label 的 tabIndex=-1 ⇒ 不可聚焦）'
    );
    // 两个「JSON 格式」「OneTab 格式」都要是带 role 的真按钮
    const menuItemButtons =
      src.match(/<button[^>]*role="menuitem"[^>]*>/g) ?? [];
    assert.ok(
      menuItemButtons.length >= 2,
      `至少要有两个 role="menuitem" 的按钮，实得 ${menuItemButtons.length}`
    );
  });

  it('导入按钮的 onClick 去点隐藏的 file input（input 仍是全仓唯一导入入口）', () => {
    const src = code(HEADER_DROPDOWN);
    assert.ok(
      src.includes('jsonImportInputRef.current?.click()'),
      'JSON 导入按钮必须触发隐藏 input 的 click'
    );
    assert.ok(
      src.includes('oneTabImportInputRef.current?.click()'),
      'OneTab 导入按钮必须触发隐藏 input 的 click'
    );
    // 隐藏 input 仍然存在（导入功能不能被改成空壳）
    assert.ok(src.includes('ref={jsonImportInputRef}'));
    assert.ok(src.includes('ref={oneTabImportInputRef}'));
    assert.ok(src.includes('storage.importDetailed(data)'));
    assert.ok(src.includes('storage.importFromOneTabFormat(text)'));
  });

  it('file input 不在 button 内部（交互元素嵌套是非法的）', () => {
    const src = code(HEADER_DROPDOWN);
    // 按钮与 input 各自独立：input 的 ref 属性紧跟 type="file"
    const inputTags = src.match(/<input[^>]*type="file"[^>]*>/g) ?? [];
    assert.equal(inputTags.length, 2, `两个 file input，实得 ${inputTags.length}`);
    for (const tag of inputTags) {
      assert.ok(
        !/<button/.test(tag),
        'file input 不得嵌在 button 标签里'
      );
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// P0-1：卡片「更多」菜单
// ══════════════════════════════════════════════════════════════════════════

describe('卡片「更多」菜单：方向键、ARIA 与 Tab 序', () => {
  it('四个菜单项都带 role="menuitem"（容器 role="menu" 的子项必须有菜单语义）', () => {
    const src = code(TAB_GROUP);
    // 菜单面板里的四个按钮（在「更多操作」面板的 role="menu" 容器内）
    const panelStart = src.indexOf('role="menu"');
    assert.ok(panelStart > -1, '找不到菜单面板');
    const panel = src.slice(panelStart, panelStart + 3000);
    const buttons = panel.match(/<button[^>]*>/g) ?? [];
    const withRole = panel.match(/<button[^>]*role="menuitem"[^>]*>/g) ?? [];
    assert.ok(buttons.length >= 4, `面板里应至少有四个按钮，实得 ${buttons.length}`);
    assert.equal(
      withRole.length,
      buttons.length,
      `面板里每个按钮都要带 role="menuitem"（${buttons.length} 个按钮，${withRole.length} 个带角色）`
    );
  });

  it('<summary> 补上 aria-expanded 与 aria-haspopup', () => {
    const src = code(TAB_GROUP);
    assert.ok(
      /aria-expanded=\{moreMenuPos !== null\}/.test(src),
      'summary 必须声明 aria-expanded（读屏要能播报「已展开」）'
    );
    assert.ok(
      /aria-haspopup="menu"/.test(src),
      'summary 必须声明 aria-haspopup="menu"'
    );
  });

  it('菜单面板接管方向键（此前完全无反应：8 次 ArrowDown 焦点纹丝不动）', () => {
    const src = code(TAB_GROUP);
    assert.ok(
      src.includes("panel.addEventListener('keydown', handleKeyDown)"),
      '菜单面板必须自己接管 keydown（HeaderDropdown 的处理器只管它自己的容器）'
    );
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
      assert.ok(src.includes(`'${key}'`), `菜单必须支持 ${key}`);
    }
    assert.ok(
      src.includes('collectFocusableMenuItemIndices(panel)'),
      '面板的方向键也必须只选可聚焦的项'
    );
  });

  it('Tab 序：不能保留「穿过整个列表才进得去」（实测 15 标签会话 = 37 次 Tab）', () => {
    const src = code(TAB_GROUP);
    // 面板 portal 到 body 末尾 ⇒ DOM 序在所有卡片之后 ⇒ 天然 Tab 很远。
    // 修法是**显式接管焦点**：summary 上按 Tab/↓ 直接进菜单第一项。
    assert.ok(
      src.includes('handleMoreMenuTriggerKeyDown'),
      'summary 必须接管键盘，把焦点直接送进菜单'
    );
    assert.ok(
      src.includes('items[0].focus()'),
      '打开菜单后必须把焦点落到第一项'
    );
    // Tab 必须被接管（只接 ArrowDown/Enter 不够：Tab 才是「穿列表」的那条路）
    const triggerHandler = src.slice(
      src.indexOf('const handleMoreMenuTriggerKeyDown'),
      src.indexOf('const handleLockedDragBlocked')
    );
    // 判据钉在**打开菜单的按键集合**上：那个集合里必须有 'Tab'。
    // （只看 handler 里有没有 'Tab' 会被别的分支蒙混过关。）
    const opensMatch = triggerHandler.match(/const opens = \[([^\]]*)\]/);
    assert.ok(opensMatch, '找不到「打开菜单的按键集合」');
    assert.ok(
      opensMatch[1].includes("'Tab'"),
      `打开菜单的按键集合必须含 'Tab'（实得：${opensMatch[1].trim()}）`
    );
    // 菜单内 Tab 在菜单项之间循环，不逃到页面别处
    assert.ok(
      /event\.key === 'Tab'/.test(src),
      '菜单面板必须接管 Tab（否则 Tab 会跑到页面最后）'
    );
  });

  it('Tab 到菜单最后一项 ⇒ 关菜单并把焦点送到页面的下一个元素（不把用户困住）', () => {
    const src = code(TAB_GROUP);
    assert.ok(
      src.includes('focusTabOrderSibling(trigger, 1)'),
      'Tab 出菜单时必须把焦点送到页面的下一个可聚焦元素（否则用户出不去菜单）'
    );
  });

  it('Esc 关菜单时焦点回到 summary（不丢到 body）', () => {
    const src = code(TAB_GROUP);
    assert.ok(
      src.includes('moreMenuButtonRef.current?.focus()'),
      'Esc 关菜单后必须把焦点还给 summary'
    );
    // 还焦必须在**文档级**的 Esc 处理器里做：面板自己的处理器只在
    // 「焦点在面板里」时才触发，而焦点可能还在 summary 上。
    const docKeyHandler = src.slice(
      src.indexOf('const onKey = (e: KeyboardEvent) =>'),
      src.indexOf("document.addEventListener('click', onDocClick)")
    );
    assert.ok(
      docKeyHandler.includes('moreMenuButtonRef.current?.focus()'),
      '文档级 Esc 处理器必须还焦到 summary（否则焦点留在别处）'
    );
  });

  it('面板仍然 portal 到 body（不能为了 Tab 序把它搬回卡内）', () => {
    // 搬回卡内会被两层 containment 破坏（实测）：
    //   · 外层 wrapper 带 content-visibility:auto（paint containment）⇒ 面板被裁掉；
    //   · 会话卡带永久 transform ⇒ 卡成了 position:fixed 的包含块 ⇒ 定位全错。
    const src = code(TAB_GROUP);
    assert.ok(src.includes('createPortal('), '面板必须仍然 portal 到 body');
    assert.ok(src.includes('document.body'), 'portal 的挂载点必须是 body');
    assert.ok(
      /position:\s*'fixed'/.test(src),
      'portal 出去的面板必须用 fixed 定位'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// P0-3：确认框关闭后焦点不得丢到 body
// ══════════════════════════════════════════════════════════════════════════

describe('确认框关闭后的焦点：绝不丢到 body，Esc 与「取消」一致', () => {
  /** 造一个最小的「元素是否可用」替身。 */
  const fakeElement = (connected: boolean, tagName = 'button') =>
    ({ isConnected: connected, tagName }) as unknown as HTMLElement;

  it('原触发元素还在时优先还给它', () => {
    const trigger = fakeElement(true);
    const target = resolveFocusRestoreTarget({
      restoreTo: trigger,
      fallback: fakeElement(true),
      container: fakeElement(true),
    });
    assert.equal(target, trigger);
  });

  it('原触发元素已被卸载时降级到 fallback（不变量：不是 body）', () => {
    const fallback = fakeElement(true);
    const target = resolveFocusRestoreTarget({
      restoreTo: fakeElement(false), // 菜单项被卸载
      fallback,
      container: fakeElement(true),
    });
    assert.equal(target, fallback);
  });

  it('原触发元素与 fallback 都不可用时降级到 main 容器', () => {
    const container = fakeElement(true);
    const target = resolveFocusRestoreTarget({
      restoreTo: fakeElement(false),
      fallback: fakeElement(false),
      container,
    });
    assert.equal(target, container);
  });

  it('全部候选都不可用时返回 null（**绝不**返回 body）', () => {
    const target = resolveFocusRestoreTarget({
      restoreTo: fakeElement(false),
      fallback: fakeElement(false),
      container: fakeElement(false),
    });
    assert.equal(target, null);
  });

  it('body 永远不作为还焦落点（它是「用户丢失了位置」）', () => {
    const body = fakeElement(true, 'body');
    const container = fakeElement(true);
    const target = resolveFocusRestoreTarget({
      restoreTo: body,
      fallback: body,
      container,
    });
    assert.equal(target, container, 'body 不该被当成还焦落点');
  });

  it('useFocusTrap 走的是降级链，不是「拒绝还焦」', () => {
    const src = code(KEYBOARD_HOOKS);
    assert.ok(
      src.includes('resolveFocusRestoreTarget('),
      'useFocusTrap 必须调用 resolveFocusRestoreTarget'
    );
    assert.ok(
      !/if \(restoreTo === document\.body \|\| !restoreTo\.isConnected\) return;/.test(src),
      '旧的「拒绝还焦」判据不得复活（它就是焦点丢到 body 的根因）'
    );
    assert.ok(src.includes('consumeFocusReturn()'), '必须消费登记的稳定落点');
  });

  it('确认框的触发点显式登记了稳定落点（两条路径一致的关键）', () => {
    const dropdown = code(HEADER_DROPDOWN);
    assert.ok(
      dropdown.includes('registerFocusReturn('),
      '顶栏菜单打开确认框前必须登记还焦落点'
    );
    assert.ok(
      dropdown.includes('[data-menu-trigger]'),
      '落点应是顶栏的菜单触发按钮（不会随菜单卸载而消失）'
    );

    const group = code(TAB_GROUP);
    assert.ok(
      group.includes('registerFocusReturn('),
      '卡片菜单打开确认框前必须登记还焦落点'
    );
  });

  it('登记的落点优先于「原触发元素」（否则 Esc 与「取消」仍是两个落点）', () => {
    const src = code(KEYBOARD_HOOKS);
    assert.ok(
      /restoreTo:\s*registered\.target\s*\?\?\s*restoreTo/.test(src),
      '登记的稳定落点必须排在原触发元素之前'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// P2-1：重命名输入框不能卡在编辑态
// ══════════════════════════════════════════════════════════════════════════

describe('重命名提交：三种输入都要能退出编辑态', () => {
  it('没改动 ⇒ unchanged（不写盘，但必须退出编辑态）', () => {
    assert.deepEqual(resolveRenameDecision('原名会话', '原名会话'), { kind: 'unchanged' });
    // 前后空白不算改动
    assert.deepEqual(resolveRenameDecision('  原名会话  ', '原名会话'), { kind: 'unchanged' });
  });

  it('清空 ⇒ empty（回滚到原名并退出编辑态）', () => {
    assert.deepEqual(resolveRenameDecision('', '原名会话'), { kind: 'empty' });
    assert.deepEqual(resolveRenameDecision('   ', '原名会话'), { kind: 'empty' });
  });

  it('改名 ⇒ rename，且写入的是 trim 后的名字', () => {
    assert.deepEqual(resolveRenameDecision('  新名字  ', '原名会话'), {
      kind: 'rename',
      name: '新名字',
    });
  });

  it('handleNameSubmit 三个分支都处理了（没改动/清空/改名）', () => {
    const src = code(TAB_GROUP);
    assert.ok(
      src.includes('resolveRenameDecision('),
      'handleNameSubmit 必须走决策函数（纯函数可单测）'
    );
    assert.ok(
      src.includes("decision.kind === 'unchanged'"),
      '必须有「没改动」分支 —— 否则输入框卡在编辑态'
    );
    assert.ok(
      src.includes("decision.kind === 'empty'"),
      '必须有「清空」分支 —— 否则空输入框出不来'
    );
    // unchanged 分支必须退出编辑态
    const unchangedBranch = src.slice(
      src.indexOf("decision.kind === 'unchanged'"),
      src.indexOf("decision.kind === 'empty'")
    );
    assert.ok(
      unchangedBranch.includes('setIsEditing(false)'),
      '「没改动」必须退出编辑态'
    );
    // empty 分支必须回滚 + 退出 + 出声
    const emptyBranch = src.slice(
      src.indexOf("decision.kind === 'empty'"),
      src.indexOf('updateGroupNameAndSync(')
    );
    assert.ok(emptyBranch.includes('setNewName(group.name)'), '清空必须回滚到原名');
    assert.ok(emptyBranch.includes('setIsEditing(false)'), '清空必须退出编辑态');
    assert.ok(
      emptyBranch.includes('showToast('),
      '清空必须出声（静默回滚 = 「我明明改了却没反应」）'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// P2-5：折叠按钮的可访问名必须能区分是哪张卡
// ══════════════════════════════════════════════════════════════════════════

describe('折叠按钮的可访问名', () => {
  it('aria-label 带上会话名（3 张卡不能都叫「折叠会话」）', () => {
    const src = code(TAB_GROUP);
    assert.ok(
      /aria-label=\{isCollapsed \? `展开会话：\$\{group\.name\}` : `折叠会话：\$\{group\.name\}`\}/.test(src),
      '折叠按钮的 aria-label 必须包含会话名'
    );
    assert.ok(
      !/aria-label=\{isCollapsed \? '展开会话' : '折叠会话'\}/.test(src),
      '同名 aria-label 不得复活'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// P1-7：搜索结果数量变化必须被读屏播报
// ══════════════════════════════════════════════════════════════════════════

describe('搜索结果的 live region', () => {
  it('结果容器有常驻的 polite live region 承载动态计数', () => {
    const src = code(SEARCH_RESULT_LIST);
    assert.ok(
      src.includes('aria-live="polite"'),
      '必须有 aria-live="polite"'
    );
    assert.ok(
      src.includes('aria-atomic="true"'),
      '必须有 aria-atomic="true"（整句重读）'
    );
  });

  it('live region 是常驻的，不是挂载式的 {cond && <div>}', () => {
    const src = code(SEARCH_RESULT_LIST);
    // 挂载式写法：区域与文案同一帧插入 ⇒ 多数读屏不播报。
    // 判据只针对**带 aria-live 的**那个区域 —— 文件里另有一个
    // role="status" 的「结果被截断」提示（既有功能，与本条无关）。
    assert.ok(
      !/\{[^}]*&&\s*\(\s*<div[^>]*aria-live/.test(src),
      'live region 不得用挂载式写法'
    );
    // 反向：带 aria-live 的区域必须**没有**条件包裹
    const liveAt = src.indexOf('aria-live="polite"');
    assert.ok(liveAt > -1, '找不到 live region');
    const before = src.lastIndexOf('{', liveAt);
    assert.ok(
      !/&&\s*$/.test(src.slice(before, liveAt).trimEnd()),
      'live region 不得被条件渲染包裹'
    );
  });

  it('动态计数放在 live region 里，不靠 aria-label 承载', () => {
    const src = code(SEARCH_RESULT_LIST);
    // 计数文本必须在 live region 内。
    //
    // 2026-10-20 审计 A-14：计数文案改由共享函数产出（searchBrowseMode），
    // 「会话数 + 标签数」两个维度仍在，但字面量不再写在组件里。
    // 断言因此改成钉**不变量**：live region 必须渲染一个**带两个计数的**表达式
    // （把会话数与标签数都传进去的那次调用）。
    assert.ok(
      /aria-live="polite"[\s\S]{0,600}(searchSummaryCopy|browseSummaryCopy)\(\s*sessionResults\.length\s*,\s*matchingTabs\.length\s*\)/.test(src),
      'live region 必须承载「会话数 + 标签数」这个动态计数'
    );
    // 共享文案函数必须真的把两个维度都写进句子里（否则「传了两个数」也没意义）。
    const browse = code(SEARCH_BROWSE_MODE);
    assert.ok(
      /sessionCount/.test(browse) && /tabCount/.test(browse),
      '结果计数文案必须同时包含会话数与标签数两个维度'
    );
  });

  it('空结果分支也有 live region（两个分支是不同的渲染路径）', () => {
    const src = code(SEARCH_RESULT_LIST);
    const emptyBranchAt = src.indexOf('sessionResults.length === 0');
    assert.ok(emptyBranchAt > -1, '找不到空结果分支');
    const emptyBranch = src.slice(emptyBranchAt, emptyBranchAt + 2000);
    assert.ok(
      emptyBranch.includes('aria-live="polite"'),
      '空结果分支必须也有 live region（有结果的分支在空结果时根本不在 DOM 里）'
    );
    // 2026-10-20 审计 A-14：空结果分支有两种文案 ——
    //   · 有搜索词 ⇒「没有找到与「X」相关的会话或标签」
    //   · 无搜索词但有筛选条件 ⇒「没有找到符合条件的会话」（不能说「没找到 X」，
    //     因为根本没有 X 这件事）
    // 两者都必须**说清没找到**，所以断言钉「播报了一个明确的否定结论」，
    // 而不是某一个具体字面量。
    assert.ok(
      emptyBranch.includes('没有找到') || emptyBranch.includes('browseEmptyTitle'),
      '空结果分支要播报「没有找到」'
    );
  });

  it('live region 用 sr-only 隐藏（不能改变布局）', () => {
    const src = code(SEARCH_RESULT_LIST);
    assert.ok(
      /role="status"[\s\S]{0,300}className="sr-only"/.test(src),
      'live region 必须是 sr-only（只给读屏，不改变视觉）'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 既有契约不得被破坏
// ══════════════════════════════════════════════════════════════════════════

describe('既有契约未被破坏', () => {
  it('ModalFrame 仍然走焦点契约（打开移焦 / Tab 循环 / Escape / 关闭还焦）', () => {
    assert.ok(MODAL_FRAME.includes('useDialogA11y(panelRef, visible, onClose)'));
    assert.ok(MODAL_FRAME.includes('tabIndex={-1}'));
  });

  it('确认框与提示框仍统一继承 ModalFrame（不各自手搓对话框）', () => {
    assert.ok(read('src/components/common/ConfirmDialog.tsx').includes('<ModalFrame'));
  });
});
