// 点扩展图标**不得**销毁当前窗口（2026-10-22 审计 P0-1 的回归钉）。
//
// ── 缺陷 ────────────────────────────────────────────────────────────────
//
// `chrome.action.onClicked` 原本是：
//   showNotification('正在保存当前窗口为会话…')
//   → tabManager.saveAllTabs(tabs)      ← 落盘
//   → TabManager 里 `chrome.tabs.create(newtab)` + `chrome.tabs.remove(tabIds)` ← 关标签
//   → openTabManager(true)
// 全程**零确认**，而且没有任何撤销。
//
// 而「点工具栏图标」在所有其它扩展里的心智模型都是「打开它看看」。
// 于是「我想看看上周存的会话」与「我要把这一窗收起来」共用了一个手势，
// 破坏性的那一个总会被误触 —— 而且不可逆。
//
// 这条被独立标记过两次都没修：
//   · `docs/audit-2026-10-20-round1.md:342`（P0，不在当时的修复表里）
//   · `docs/audit-2026-10-22-product-director.md` P0-1（2026-10-22 复核仍成立）
//
// ── 契约 ────────────────────────────────────────────────────────────────
//
// 点图标 = **只打开会话管理器**，不动当前窗口任何一个标签。
//
// 而「保存并关闭」这个核心动作**必须还在**、且必须仍然可达 ——
// 否则这不是「把破坏挪到明确的一步」，而是「把功能删了」。所以本文件
// 同时钉住两半：
//   ① 图标点击里不得出现保存 / 关标签；
//   ② 保存并关闭的三条入口（页面按钮 / 右键菜单 / 快捷键）必须都还在。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const SW = read('src/service-worker.ts');

/** 取出 `chrome.action.onClicked` 监听器里那个函数体的源码。 */
function actionOnClickedBody(): string {
  const at = SW.indexOf('chrome.action.onClicked.addListener');
  assert.ok(at > -1, 'service-worker 必须注册 chrome.action.onClicked');
  const open = SW.indexOf('{', at);
  // 从第一个大括号开始做括号配平，取出整个函数体
  let depth = 0;
  for (let i = open; i < SW.length; i += 1) {
    if (SW[i] === '{') depth += 1;
    else if (SW[i] === '}') {
      depth -= 1;
      if (depth === 0) return SW.slice(open, i + 1);
    }
  }
  assert.fail('chrome.action.onClicked 的函数体没有闭合');
}

describe('点扩展图标：只打开管理器，不销毁当前窗口', () => {
  it('① 图标点击里不得出现「保存」', () => {
    const body = actionOnClickedBody();
    assert.doesNotMatch(
      body,
      /saveAllTabs|saveCurrentTab/,
      '点图标不得触发保存 —— 这正是 P0-1 的根因'
    );
    assert.doesNotMatch(
      body,
      /正在保存当前窗口/,
      '点图标不得再弹「正在保存当前窗口为会话…」—— 那句通知承诺了一个不再发生的保存'
    );
  });

  it('① 图标点击里不得出现「关标签」', () => {
    const body = actionOnClickedBody();
    assert.doesNotMatch(
      body,
      /tabs\.remove|removeTabs|closeTabs/,
      '点图标不得关掉任何标签页'
    );
  });

  it('① 图标点击必须打开会话管理器（不能什么都不做）', () => {
    const body = actionOnClickedBody();
    assert.match(
      body,
      /openTabManager/,
      '点图标必须打开会话管理器 —— 那是「找回」的入口'
    );
  });

  it('② 保存并关闭的三条入口必须都还在（不许把功能一起删掉）', () => {
    // 入口一：快捷键
    const manifest = JSON.parse(read('manifest.json')) as {
      commands: Record<string, { suggested_key?: { default?: string } }>;
    };
    const saveCommands = Object.entries(manifest.commands).filter(([id]) =>
      id.startsWith('save_')
    );
    assert.ok(
      saveCommands.length >= 2,
      `manifest 必须保留至少两个保存快捷键（实际 ${saveCommands.length}）：` +
        '「保存整窗并关闭」与「保存当前页并关闭」是两个不同粒度的动作'
    );

    // 入口二：右键菜单
    assert.match(
      SW,
      /CONTEXT_MENU_IDS\.saveOtherTabs/,
      '右键菜单的「保存其他标签并关闭」必须还在 —— 它是图标不再保存之后的主要归档入口'
    );

    // 入口三：管理页里的按钮
    const header = read('src/components/layout/Header.tsx');
    assert.match(
      header,
      /handleSaveAllTabs/,
      '管理页顶栏的「保存并关闭」按钮必须还在'
    );
  });

  it('② 快捷键处理器必须真的处理这些命令', () => {
    const manifest = JSON.parse(read('manifest.json')) as {
      commands: Record<string, unknown>;
    };
    for (const id of Object.keys(manifest.commands)) {
      assert.match(
        SW,
        new RegExp(`case\\s+['"]${id}['"]`),
        `service-worker 必须处理命令 ${id} —— 否则按下快捷键什么都不会发生`
      );
    }
  });
});
