// 「恢复」的用户可见后果必须诚实 —— 行为级回归。
//
// ── 2026-10-26：这条守卫的**方向**变了 ───────────────────────────────────
//
// 2026-10-20 审计 A-1 / A-2 要的是「恢复必须有成功反馈」（当时列表页零反馈）。
// 2026-10-25「安静的成功」把范围收窄（锁定路径静默、其余只说事实）。
// 2026-10-26 产品负责人定案：**撤销机制下线**，恢复时标签**已经开在浏览器里**
// ⇒ 结果界面自明 ⇒ 恢复整个会话 / 点开单个标签这两条**高频**路径**完全静默**。
//
// ⇒ 现在这条守卫守的是三件事：
//   ① **高频路径静默**（不许又冒出成功播报 —— 那正是用户嫌吵的东西）；
//   ② **后果仍然诚实**：不可恢复这件事写在按钮的 tooltip / aria-label 上，
//      批量恢复那四笔账仍然说出来（界面表达不了）；
//   ③ **失败仍然出声**：静默的是成功，不是失败。
//
// 断言方式与本仓既有约定一致（见 destructiveActionHonesty.test.ts）：
//   · 文案部分直接调用**已发布的**文案函数，断言它说了该说的；
//   · 接线部分读源码，确认调用真的接上了 —— 只测文案函数的话，
//     把调用删掉测试照样绿，那正是这个缺陷当初能活下来的原因。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

import {
  restoreAllSearchSuccessMessage,
  restoreOutcomeSentence,
} from '../src/components/tabs/restoreFeedbackCopy.ts';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/** 去注释后的源码：注释里提到一个符号不等于生产在用它。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * 抽出 `handleOpenTab` 里 `if (group.isLocked) { … }` 这一支的源码。
 *
 * 用括号配平而不是正则截断：分支里有嵌套的回调（`.then(() => {…})`），
 * 正则会在第一个 `}` 处就停下，截出来的不是完整的分支。
 */
function extractLockedBranch(src: string): string | null {
  const fnStart = src.indexOf('const handleOpenTab');
  if (fnStart < 0) return null;
  const guardAt = src.indexOf('if (group.isLocked)', fnStart);
  if (guardAt < 0) return null;
  const open = src.indexOf('{', guardAt);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// 1. 文案本身：批量恢复那四笔账必须说清（界面表达不了的那部分）
// ─────────────────────────────────────────────────────────────────────────

describe('批量恢复文案：说清两件事（打开了什么 / 记录去哪了）', () => {
  it('批量恢复（搜索页）必须说「移除了几个、其余保留」', () => {
    const msg = restoreAllSearchSuccessMessage({
      matched: 8,
      opened: 8,
      removed: 8,
      keptLocked: 0,
      failedToRemove: 0,
    });
    assert.match(msg, /已恢复 8 个标签页/);
    assert.match(msg, /已从所属会话移除 8 个标签页/);
    assert.match(msg, /会话内其余标签页保留/);
  });

  // ── 2026-10-23 审计 P0-2 ──────────────────────────────────────────────
  // 「打开了几个」与「从会话里移除了几个」是**两件事** ——
  // 锁定会话里的标签页**照样会被打开**，但**不会被移除**（锁定 = 防误删）。
  // 把两件事混成一句就是谎报（用户以为锁定的那几条也被清掉了）。
  it('批量恢复：有锁定命中时必须说清「锁定的那几条仍留在会话里」', () => {
    const msg = restoreAllSearchSuccessMessage({
      matched: 5,
      opened: 5,
      removed: 3,
      keptLocked: 2,
      failedToRemove: 0,
    });
    assert.match(msg, /已恢复 5 个标签页/);
    assert.match(
      msg,
      /另有 2 个在已锁定的会话里，仍保留在会话中/,
      '锁定会话里的那几条一个都没被移除 ⇒ 必须说出来'
    );
  });

  it('批量恢复：一条都没移除时不许说「已从所属会话移除」', () => {
    const allLocked = restoreAllSearchSuccessMessage({
      matched: 3,
      opened: 3,
      removed: 0,
      keptLocked: 3,
      failedToRemove: 0,
    });
    assert.doesNotMatch(
      allLocked,
      /已从所属会话移除/,
      '一条都没移除还说「已移除」= 谎报'
    );
    assert.match(allLocked, /没有任何一条被从会话中移除/);
    assert.match(allLocked, /另有 3 个在已锁定的会话里/);
  });

  it('批量恢复：有条没移除掉时必须说出来（不许藏）', () => {
    const msg = restoreAllSearchSuccessMessage({
      matched: 4,
      opened: 4,
      removed: 2,
      keptLocked: 0,
      failedToRemove: 2,
    });
    assert.match(msg, /另有 2 条未能从会话中移除/);
  });

  it('批量恢复：打不开的那些必须说出来', () => {
    const msg = restoreAllSearchSuccessMessage({
      matched: 4,
      opened: 3,
      removed: 4,
      keptLocked: 0,
      failedToRemove: 0,
      unopenable: 1,
    });
    assert.match(msg, /已恢复 3 个标签页/);
    assert.match(msg, /另有 1 个在当前设备无法打开/);
  });

  it('文案不得出现内部实现词（op 名、SW、协议）', () => {
    const all = restoreAllSearchSuccessMessage({
      matched: 1,
      opened: 1,
      removed: 1,
      keptLocked: 0,
      failedToRemove: 0,
    });
    for (const forbidden of ['OPEN_TABS', 'OPEN_TAB', 'deleteGroup', 'SW', 'mutation']) {
      assert.doesNotMatch(all, new RegExp(forbidden), `文案不应出现「${forbidden}」`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 后果：不可恢复这件事必须说在**按钮提示**上（点之前唯一的告知）
// ─────────────────────────────────────────────────────────────────────────

describe('恢复的后果必须说在按钮提示上', () => {
  it('未锁定：必须说「从列表移除，不可恢复」', () => {
    // ⚠️ 2026-10-26：撤销机制下线 ⇒ 「可撤销」是假话 ⇒ 这里是唯一的告知。
    assert.equal(
      restoreOutcomeSentence(false),
      '恢复后该会话会从列表移除，不可恢复',
      '未锁定的后果必须说清「不可恢复」'
    );
  });

  it('已锁定：必须说「仍保留在列表中」', () => {
    assert.equal(
      restoreOutcomeSentence(true),
      '恢复后该会话仍保留在列表中',
      '锁定的后果仍然是「保留在列表中」'
    );
  });

  it('两个界面都必须在恢复按钮上带上这句后果', () => {
    for (const file of [
      'src/components/tabs/TabGroup.tsx',
      'src/components/search/SearchResultList.tsx',
    ]) {
      const src = stripComments(read(file));
      assert.match(
        src,
        /restoreOutcomeSentence\(/,
        `${file}：恢复按钮必须带上后果说明（点之前唯一的告知）`
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 接线：高频路径静默、低频路径出声、失败永远出声
// ─────────────────────────────────────────────────────────────────────────

/**
 * 数「成功播报」在源码里出现了几次（按**数据流**数，不钉字面量形状）。
 *
 * 文案先落到 fact（判据层与播报共用同一份）⇒ 第一个实参可能是那个变量，
 * **不再紧贴**文案函数调用 ⇒ 原来的正则 `showRestoreSuccessMessage\(\s*文案函数\(`
 * 会数成 0 ⇒ 报「没有成功反馈」—— 红在一个正确的改动上。
 *
 * ⇒ 判据数的是**调用点**：
 *   · 第一个实参直接是 `copyFn(...)`，或
 *   · 第一个实参是某个**由 `copyFn(...)` 初始化**的局部变量。
 */
const countSuccessToasts = (src: string, copyFn: string): number => {
  const source = ts.createSourceFile(
    'counted.tsx',
    stripComments(src),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  // 先收「由文案函数算出来的那些局部变量」。
  const factNames = new Set<string>();
  const collectFacts = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === copyFn
    ) {
      let current: ts.Node | undefined = node;
      while (current && !ts.isVariableDeclaration(current)) current = current.parent;
      if (current && ts.isIdentifier(current.name)) factNames.add(current.name.text);
    }
    node.forEachChild(collectFacts);
  };
  collectFacts(source);

  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === 'showRestoreSuccessMessage' ||
        node.expression.text === 'showToast')
    ) {
      const firstArg = node.arguments[0];
      if (!firstArg) {
        // 没有实参 = 不是「把某句文案播出来」，不计数。
      } else if (firstArg.getText(source).includes(`${copyFn}(`)) {
        count += 1;
      } else if (ts.isIdentifier(firstArg) && factNames.has(firstArg.text)) {
        count += 1;
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  return count;
};

describe('恢复的反馈：高频静默、低频出声、失败永远出声', () => {
  it('列表页：整组恢复与点开单标签的成功路径都**不许播报**', () => {
    const src = read('src/components/tabs/TabGroup.tsx');
    // 撤销机制下线后，「恢复整个会话」「点开单个标签」这两条高频路径静默 ——
    // 标签已经开在浏览器里、卡片从列表消失 ⇒ 界面自明。
    // 列表页剩下的那条成功播报是「拖走最后一条标签 ⇒ 会话消失」的事实（fact）。
    const total = countSuccessToasts(src, 'moveEmptiesSessionMessage');
    assert.equal(
      total,
      1,
      '列表页只许剩下「拖走最后一条标签」那一条事实播报 —— 恢复与点开必须静默'
    );
    assert.doesNotMatch(
      src,
      /restoreGroupSuccessMessage|openSingleTabSuccessMessage/,
      '列表页不许再引用那两条成功文案（它们随静默一起消失）'
    );
  });

  it('搜索页：整组恢复与点开单标签的成功路径都**不许播报**，但批量恢复仍出声', () => {
    const src = read('src/components/search/SearchResultList.tsx');
    assert.equal(
      countSuccessToasts(src, 'restoreAllSearchSuccessMessage'),
      1,
      '搜索页只许剩下「批量恢复」那一条四笔账的事实播报'
    );
    assert.doesNotMatch(
      src,
      /restoreGroupSuccessMessage|openSingleTabSuccessMessage/,
      '搜索页不许再引用那两条成功文案（它们随静默一起消失）'
    );
  });

  it('搜索页与列表页的锁定分支都必须**没有播报、但成功门与失败出口仍在**', () => {
    // 2026-10-22 审计 P1-6：锁定分支原先是 `.then(() => 报成功)`，
    // 而 SW 拒开是 `sendResponse({success:false})` ⇒ promise **resolve 而非
    // reject** ⇒ `.then` 照样跑 ⇒ 界面播「已打开」，实际一个标签都没开。
    //
    // 锁定分支**不播报**（锁定组从不被消费 ⇒ 记录还在 ⇒ 界面自明），但
    // **成功门不许跟着播报一起消失** —— 打不开必须明说「已保留在会话中」，
    // 否则「点了没反应」与「已打开」用户分不出来。
    for (const file of [
      'src/components/search/SearchResultList.tsx',
      'src/components/tabs/TabGroup.tsx',
    ]) {
      // 剥注释后再抽分支：注释里也会出现 `showRestoreError(` / `showToast(`
      // ⇒ 拿原始源码判 `doesNotMatch(/showToast\(/)` 会被注释误伤成假红，
      // `match(/showRestoreError\(/)` 又能被注释满足成假绿。
      const src = stripComments(read(file));
      const branch = extractLockedBranch(src);
      assert.ok(branch, `${file}：应能找到 handleOpenTab 里的锁定分支`);
      assert.doesNotMatch(
        branch,
        /showRestoreSuccessMessage|showToast\(/,
        `${file}：锁定分支必须静默（锁定组从不被消费 ⇒ 那条记录还在 ⇒ 界面自明）`
      );
      assert.match(
        branch,
        /success\s*!==\s*true|success\s*===\s*false/,
        `${file}：锁定分支必须判过成功门 —— 不然 SW 拒开时界面会撒谎`
      );
      assert.match(
        branch,
        /showRestoreError\(/,
        `${file}：锁定分支的失败路径必须出声（打不开必须明说）`
      );
    }
  });

  it('「部分成功」（有几个打不开）必须仍然出声', () => {
    // 静默的是**成功**；「有的没成」是失败事件 —— 必须说，且必须说清是哪几个。
    for (const file of [
      'src/components/tabs/TabGroup.tsx',
      'src/components/search/SearchResultList.tsx',
    ]) {
      const src = stripComments(read(file));
      assert.match(
        src,
        /在当前设备无法打开/,
        `${file}：「有的打不开」必须说出来（失败不许被静默）`
      );
      assert.match(
        src,
        /showRestoreError\(/,
        `${file}：失败提示必须走错误通道`
      );
    }
  });

  it('toastHelper 暴露了自定义成功文案的通道', () => {
    const src = read('src/utils/toastHelper.ts');
    assert.match(src, /showRestoreSuccessMessage/, '必须提供自定义文案的出口');
    // noop 分支也要有，否则 useEnhancedToast 在无 Provider 时会崩
    const noopBranch = src.slice(src.indexOf('return {', src.indexOf('logError')));
    assert.match(noopBranch, /showRestoreSuccessMessage:\s*noop/, 'noop 分支也必须导出它');
  });
});
