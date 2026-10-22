/**
 * DS-43-17（2026-10-23 数据安全审计）：删除入口的**可访问名**必须带后果。
 *
 * ── 缺陷本体 ──────────────────────────────────────────────────────────────
 * 删除自 v1.22.0 起是**物理清除、无回收站、无撤销** ⇒ 「删除后无法恢复」
 * 是这个按钮**唯一**的预警。而它原先只写在 Tooltip 的 `content` 里。
 *
 * Tooltip 的接线（V-15，`src/components/common/Tooltip.tsx`）是：
 *   · 提示条**只在 `isVisible` 时才渲染**；
 *   · `aria-describedby` **只在 `isVisible` 时**才挂到触发元素上。
 * 于是焦点落到按钮上时读屏先念按钮名（「删除会话」），
 * 300ms 之后提示条出现、`aria-describedby` 被挂上 ——
 * **多数读屏不会重新播报描述** ⇒ 读屏用户从头到尾**听不到**「无法恢复」。
 *
 * 窄屏「更多」菜单里的删除项**根本没有 Tooltip** ⇒ 那条路径上
 * 后果一个字都没有。
 *
 * ── 本文件钉住的三条 ──────────────────────────────────────────────────────
 * ① 文案层（纯函数 `deleteGroupEntryAriaLabel`）：
 *    可访问名必须**同时**含可见文字与「删除后无法恢复」。
 *    ⚠️ WCAG 2.5.3（Label in Name）：可访问名必须**包含**可见文字 ——
 *    否则读屏念的名字与眼睛看到的不是一回事（voice-control 用户会念不出来）。
 * ② 接线层（TabGroup.tsx 源码断言）：
 *    宽屏删除按钮的 `aria-label` 与窄屏菜单项的 `aria-label`
 *    **都**必须取自那一份共享文案。
 * ③ 不许回退：源码里不许再出现裸的 `aria-label={deleteGroupEntryLabel(...)}`
 *    （那正是缺陷本体的写法）。
 *
 * ── 为什么用源码断言 ─────────────────────────────────────────────────────
 * 本仓没有 DOM 测试环境（无 jsdom / @testing-library），node 单测加载不了 JSX。
 * 沿用本仓既有惯例（见 lockedTabDeleteGuard.test.ts、guards/removeTabEntryDisclosure.test.ts）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deleteGroupEntryAriaLabel,
  deleteGroupEntryLabel,
} from '../../src/components/tabs/lockedDeleteCopy.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
/** 剥掉注释：源码断言必须判「代码结构」而不是「注释里提到的话」。 */
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const TAB_GROUP = 'src/components/tabs/TabGroup.tsx';

// ══════════════════════════════════════════════════════════════════════════
// 1. 文案层：可访问名 = 可见文字 + 后果
// ══════════════════════════════════════════════════════════════════════════

describe('DS-43-17：删除入口的可访问名必须说清「删除后无法恢复」', () => {
  it('未锁定态：可访问名里必须有后果', () => {
    const label = deleteGroupEntryAriaLabel(false);
    assert.match(
      label,
      /删除后无法恢复/,
      '读屏用户听不到 tooltip ⇒ 后果必须进可访问名本身'
    );
  });

  it('未锁定态：可访问名必须**包含可见文字**（WCAG 2.5.3）', () => {
    const visible = deleteGroupEntryLabel(false);
    const accessible = deleteGroupEntryAriaLabel(false);
    assert.ok(
      accessible.includes(visible),
      `可访问名「${accessible}」必须包含可见文字「${visible}」—— ` +
        '否则 voice-control 用户念屏幕上看到的字会找不到按钮'
    );
  });

  it('锁定态：同样必须带后果，且仍然包含可见文字', () => {
    const visible = deleteGroupEntryLabel(true);
    const accessible = deleteGroupEntryAriaLabel(true);
    assert.match(accessible, /删除后无法恢复/);
    assert.ok(accessible.includes(visible));
    assert.match(visible, /锁定/, '锁定态的入口必须能看出它删的是自己保护过的东西');
  });

  it('两态的措辞不同（别把锁定态也写成「删除会话」）', () => {
    assert.notEqual(
      deleteGroupEntryAriaLabel(true),
      deleteGroupEntryAriaLabel(false),
      '锁定与否是两个不同的动作，说法必须能区分'
    );
  });

  it('界面文案里不出现英文机器串（全中文界面）', () => {
    for (const locked of [true, false]) {
      assert.doesNotMatch(deleteGroupEntryAriaLabel(locked), /[A-Za-z]{4,}/);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. 接线层：两个入口都走那一份
// ══════════════════════════════════════════════════════════════════════════

describe('DS-43-17：TabGroup 的两个删除入口都必须走共享可访问名', () => {
  const src = code(TAB_GROUP);

  /**
   * 找出「从 lockedDeleteCopy 导出的某个名字」在 TabGroup 里的**本地名**。
   *
   * ── 为什么要认本地名而不是直接钉字面量 ───────────────────────────────────
   * 守卫若写死 `deleteGroupEntryAriaLabel`，那么「import { deleteGroupEntryAriaLabel
   * as x }」这种**纯等价**改写就会误报 ⇒ 等于逼着实现不敢改名字。
   * ⇒ 这里解析 import 块（含 `as` 别名），拿到本地名再往下断言。
   */
  const localNames = (exportName: string): string[] => {
    const imported = src.match(
      /import\s*\{([^}]*)\}\s*from\s*'([^']*lockedDeleteCopy[^']*)'/
    );
    if (!imported) return [];
    return imported[1]
      .split(',')
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => {
        const aliased = part.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
        return aliased
          ? { export: aliased[1], local: aliased[2] }
          : { export: part, local: part };
      })
      .filter(entry => entry.export === exportName)
      .map(entry => entry.local);
  };

  /** 共享可访问名的本地名（必须恰好一个）。 */
  const ariaLocal = (): string => {
    const names = localNames('deleteGroupEntryAriaLabel');
    assert.equal(
      names.length,
      1,
      `必须从 lockedDeleteCopy 引入共享可访问名 deleteGroupEntryAriaLabel（实际 ${names.length} 个）`
    );
    return names[0];
  };

  /** 可见文字的本地名（可能没有 —— 那就说明没人用它，那更好）。 */
  const visibleLocal = (): string | undefined => localNames('deleteGroupEntryLabel')[0];

  it('宽屏删除按钮的 aria-label 取自共享可访问名', () => {
    const local = ariaLocal();
    assert.match(
      src,
      new RegExp(`aria-label=\\{${local}\\(group\\.isLocked\\)\\}`),
      '宽屏删除按钮的可访问名必须带「删除后无法恢复」'
    );
  });

  it('窄屏「更多」菜单里的删除项也带 aria-label（那一条路径没有 tooltip）', () => {
    // 窄屏菜单里有多个 role="menuitem"（重命名 / 锁定 / 删除）⇒ 不能只找
    // 「第一个 menuitem」。按**可见文字**认出删除那一项（它的正文是可见文字
    // 函数的结果），再在同一个 <button> 里找 aria-label。
    const local = ariaLocal();
    const visible = visibleLocal();
    assert.ok(visible, '必须从 lockedDeleteCopy 引入可见文字函数（用来认出删除那一项）');
    const items: string[] = [];
    let at = src.indexOf('role="menuitem"');
    while (at !== -1) {
      const end = src.indexOf('</button>', at);
      items.push(src.slice(at, end === -1 ? src.length : end));
      at = src.indexOf('role="menuitem"', at + 1);
    }
    const deleteItems = items.filter(item =>
      item.includes(`${visible}(group.isLocked)`)
    );
    assert.equal(
      deleteItems.length,
      1,
      `应当恰好有一个窄屏删除菜单项（实际 ${deleteItems.length} 个）`
    );
    assert.match(
      deleteItems[0],
      new RegExp(`aria-label=\\{${local}\\(group\\.isLocked\\)\\}`),
      '窄屏删除项没有 tooltip ⇒ 后果必须在 aria-label 上'
    );
  });

  it('tooltip 的内容也用同一份（界面上看到的那句与读屏听到的那句一致）', () => {
    const local = ariaLocal();
    assert.match(
      src,
      new RegExp(`content=\\{${local}\\(group\\.isLocked\\)\\}`),
      'tooltip 与 aria-label 必须同源'
    );
  });

  it('不许回退成裸的可见文字当可访问名（那正是缺陷本体）', () => {
    const visible = visibleLocal();
    if (!visible) return; // 没人用可见文字函数 ⇒ 不可能回退
    assert.doesNotMatch(
      src,
      new RegExp(`aria-label=\\{${visible}\\(`),
      'aria-label 又变回只有「删除会话」了 ⇒ 读屏用户听不到「无法恢复」'
    );
  });

  it('TabGroup 从 lockedDeleteCopy 引入了共享可访问名', () => {
    assert.ok(
      localNames('deleteGroupEntryAriaLabel').length > 0,
      '共享可访问名必须从 lockedDeleteCopy 引入（不许在组件里现拼）'
    );
  });
});
