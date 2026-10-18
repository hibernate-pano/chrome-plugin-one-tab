// 菜单里的子菜单（导出 / 导入）必须落在菜单盒之内、真的可点（2026-10-18）。
//
// 【本文件要防的回归类别】菜单容器是 `max-h-[70vh] overflow-y-auto`。按 CSS 规范，
// 一个轴设成非 visible 时另一轴的 `visible` 会计算成 `auto`（实测 overflow 计算值为
// auto/auto）—— 于是这个容器同时也是一个**横向裁剪盒**。往里面放 `absolute left-full`
// 的浮层，浮层就整个落在右边界之外：真机实测菜单盒 [152,408]、子菜单 [411,603]，
// 在子菜单中心做 elementFromPoint 返回 null（连滚动条都得靠横向拖才能瞥见）。
// 用户点「导出数据」屏幕毫无变化 —— 而全仓只有这一处入口，等于备份与恢复双双不可达。
//
// 为什么用源码结构断言：这条缺陷只在**几何**上成立（组件的 React 树完全正常），
// 单测里没有布局引擎可跑；本仓已有同惯例（restoreOpenBeforeConsume / focusRingVisibility）。
// 真机几何由 /tmp/one-tab-loop/verify-round15.mjs 探针把关（改前 inside:false / hitInside:false）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 去注释后的源码：注释里会引用旧写法，不能参与断言。 */
function code(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 取 `anchor` 之后第一个 className 的内容（= 该子菜单面板的类名）。 */
function panelClassAfter(src: string, anchor: string): string {
  const at = src.indexOf(anchor);
  assert.ok(at !== -1, `应能找到 ${anchor}`);
  const seg = src.slice(at, at + 400);
  const m = seg.match(/className="([^"]+)"/);
  assert.ok(m, `${anchor} 之后应紧跟面板的 className`);
  return m[1];
}

const SRC = code('src/components/layout/HeaderDropdown.tsx');

describe('下拉菜单的子菜单可达', () => {
  it('前提：菜单容器仍是滚动盒（两轴裁剪的成立条件）', () => {
    assert.ok(
      /max-h-\[70vh\] overflow-y-auto/.test(SRC),
      '菜单容器的滚动盒一旦改掉，本文件的对策要重新论证（横向裁剪来自 overflow-y-auto）'
    );
  });

  it('不得再用会落到裁剪盒之外的浮层锚点', () => {
    assert.ok(
      !/(^|[\s"'])(left|right)-full/.test(SRC),
      'left-full / right-full 会把面板推到菜单盒之外并被横向裁掉（真机实测命中测试为 null）'
    );
  });

  it('导出 / 导入面板都在流内，不再绝对定位', () => {
    for (const anchor of ["{openSubmenu === 'export' && (", "{openSubmenu === 'import' && ("]) {
      const cls = panelClassAfter(SRC, anchor);
      assert.ok(
        !/\babsolute\b/.test(cls),
        `${anchor} 的面板不得绝对定位（会被菜单的裁剪盒吃掉）：${cls}`
      );
    }
  });

  it('展开后必须把面板带进视野（否则仍可能是「点了没反应」）', () => {
    assert.ok(SRC.includes('scrollIntoView'), '展开时要 scrollIntoView，避免展开项落在滚动视口之外');
    const refs = SRC.split('ref={submenuRef}').length - 1;
    assert.equal(refs, 2, `两个子菜单面板都要挂 ref，实得 ${refs}`);
  });

  it('可达性 = 功能可达：导出 / 导入仍接在真实处理函数上', () => {
    for (const fn of ['handleExportData', 'storage.importDetailed', 'importFromOneTabFormat']) {
      assert.ok(SRC.includes(fn), `子菜单必须仍然调用 ${fn}（不能被改成空壳）`);
    }
  });

  it('可访问性声明要与行为一致：disclosure 用 aria-expanded，不再宣称 popup menu', () => {
    assert.ok(
      !SRC.includes('aria-haspopup="menu"'),
      '面板已是就地展开的 disclosure，aria-haspopup="menu" 是在声明一个不存在的弹出菜单'
    );
    const expanded = SRC.split('aria-expanded={openSubmenu ===').length - 1;
    assert.equal(expanded, 2, `两个父行都要有 aria-expanded，实得 ${expanded}`);
  });
});
