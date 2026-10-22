// 顶栏的「视觉预算」必须给「找回」，不给低频按钮（2026-10-22 审计 U-20）。
//
// ── 缺陷 ────────────────────────────────────────────────────────────────
//
// 顶栏是三段栅格 `auto | minmax(0, 1fr) | auto`：左边品牌、中间搜索框、右边操作区。
// 操作区是 `flex-shrink: 0`，中间那一列的轨道下限是 **0** ⇒
// **操作区永远赢，搜索框永远是输家**。
//
// 1280px 实测：操作区 434px，搜索框 428px —— 「找回」这个核心入口
// 比「存档 + 同步 + 换肤」的总和还窄一点点。再加一颗按钮，搜索框就开始被压；
// 而这条防线历史上真的塌过一次（700px 视口下搜索框实测 **0 宽**，
// 整框消失且没有任何报错，见 global.css 的 F-1 注释）。
//
// ── 错在哪 ──────────────────────────────────────────────────────────────
//
// Header 里原本有「切换布局」和「清理重复标签」两颗图标按钮，注释写着
// 「顶栏宽度优先给搜索，布局切换是低频偏好设置，不值得占掉信息获取入口的位置」——
// 但它们的类名是 `hidden sm:block`：**只在 ≥640px 出现**，而那正是宽度最紧的时候。
// 也就是说，注释声明的优先级与实现的行为正好相反。
//
// ── 修法 ────────────────────────────────────────────────────────────────
//
// 两件事都收进 ⋯ 菜单（菜单里本来就有这两个入口，原来只在窄屏显示）：
//   · 「切换布局」是低频的**视图偏好**，本就不该占顶栏黄金位；
//   · 「清理重复标签」是**破坏性**动作且要弹确认，藏在菜单里误触成本更低。
// 顶栏因此释放 72px，全部给搜索框；功能一条不少。
//
// ── 这份文件钉什么 ──────────────────────────────────────────────────────
//
// 钉的是**不变量**，不是「按钮长什么样」：
//   ① 这两个低频入口在 Header.tsx 里不得再是可点击元素（不许回流到顶栏）；
//   ② 菜单必须始终提供这两个入口（不许因为挪位置而丢功能）；
//   ③ 菜单里的这两个入口必须在**所有宽度**可见（不许再被 `sm:hidden` 藏起来）。
//
// 特别注意 ③：它钉的是「窄屏补偿」这个**曾经的反模式**不许回来 ——
// 当年就是因为 `sm:hidden` 让这两个入口只在窄屏出现，才导致宽屏反而没地方放。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

/** 去掉注释，避免注释里的字样把断言喂饱。 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const HEADER = stripComments(read('src/components/layout/Header.tsx'));
const DROPDOWN = stripComments(read('src/components/layout/HeaderDropdown.tsx'));

describe('顶栏动作预算：低频入口不进顶栏，但不许消失', () => {
  it('①「切换布局」不得再是顶栏里的可点击元素', () => {
    assert.doesNotMatch(
      HEADER,
      /onClick=\{handleToggleLayout\}/,
      '「切换布局」已移进 ⋯ 菜单 —— 它若回流到顶栏，操作区就会重新挤压搜索框'
    );
    assert.doesNotMatch(
      HEADER,
      /切换为双栏布局|切换为单栏布局/,
      '顶栏不得再出现布局切换按钮的可访问名'
    );
  });

  it('②「清理重复标签」不得再是顶栏里的可点击元素', () => {
    assert.doesNotMatch(
      HEADER,
      /onClick=\{handleCleanDuplicateTabs\}/,
      '「清理重复标签」是破坏性动作，已移进 ⋯ 菜单'
    );
    assert.doesNotMatch(
      HEADER,
      /aria-label="清理重复标签页"/,
      '顶栏不得再出现清理重复按钮的可访问名'
    );
  });

  it('③ 菜单必须始终提供这两个入口（挪位置不等于丢功能）', () => {
    assert.match(
      DROPDOWN,
      /onToggleLayout\?\.\(\)/,
      '菜单里必须有「切换布局」入口，且真的调用了回调'
    );
    assert.match(
      DROPDOWN,
      /onRequestCleanDuplicates\?\.\(\)/,
      '菜单里必须有「清理重复标签」入口，且真的调用了回调'
    );
  });

  it('④ 菜单里的这两个入口在所有宽度都可见（不许再被 sm:hidden 藏起来）', () => {
    // 这条钉的是当年那个反模式：`sm:hidden` 让入口只在窄屏出现，
    // 于是宽屏反而没地方放，只能把按钮塞回顶栏 —— 循环回原点。
    const anchor = DROPDOWN.indexOf('切换为双栏布局');
    assert.ok(anchor > -1, '菜单里必须能找到布局切换入口的文案');

    // 从这段入口往上回溯 1200 字符，找它所在容器的开标签
    const region = DROPDOWN.slice(Math.max(0, anchor - 1200), anchor);
    assert.doesNotMatch(
      region,
      /sm:hidden/,
      '这两个入口所在容器不得带 sm:hidden —— 它们必须在所有宽度都可见'
    );
  });
});
