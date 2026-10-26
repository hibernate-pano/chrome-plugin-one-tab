// 「恢复必须有成功反馈」——2026-10-20 审计 A-1 / A-2 的行为级回归。
//
// 两个真实缺陷（主审在真实 popup 上点出来的，非推测）：
//
//   A-1  列表页整组恢复**零反馈**：窗口开了、会话卡从列表消失、屏幕上什么都不动。
//        「我的卡片怎么没了？」是用户看到卡片凭空消失时的第一反应，而它其实是成功。
//        搜索页同一动作早就有 showRestoreSuccess —— 同一产品两个界面两种反馈，
//        而列表页才是主界面。
//
//   A-2  点开单个标签也是零反馈，而它是一次**不可撤销的删除**（无回收站）：
//        标签行消失、页面打开，用户无法区分「已打开」与「被删了」。
//        这是本产品最高频的动作。
//
// 断言方式与本仓既有约定一致（见 destructiveActionHonesty.test.ts）：
//   · 文案部分直接调用**已发布的**文案函数，断言它说了该说的；
//   · 接线部分读源码，确认调用真的接上了 —— 只测文案函数的话，
//     把调用删掉测试照样绿，那正是这个缺陷当初能活下来的原因。
//
// ── 2026-10-25「安静的成功」：断言**收窄** ──────────────────────────────────
//
// 锁定会话恢复后**保留在列表里** ⇒ 那张卡还在 ⇒ 界面自明 ⇒ 锁定路径**静默**
// （不再要求它播报）。锁定版的两条成功文案随死分支一起删掉。
// 但锁定分支仍然必须：① 判过成功门；② 失败路径出声。
// 未锁定路径相反：必须播报，且那条提示上必须挂着撤销。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

import {
  openSingleTabSuccessMessage,
  restoreAllSearchSuccessMessage,
  restoreGroupSuccessMessage,
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
// 1. 文案本身：必须说清「发生了什么」与「为什么卡片不见了」
// ─────────────────────────────────────────────────────────────────────────

describe('恢复成功文案：说清两件事（打开了什么 / 记录去哪了）', () => {
  it('整组恢复（未锁定）必须说「已打开」与「已从列表移除」', () => {
    const msg = restoreGroupSuccessMessage(5);
    assert.match(msg, /已在新窗口打开 5 个标签页/, '必须说清打开了几个');
    assert.match(msg, /已从列表移除/, '必须解释卡片为什么不见了');
  });

  it('点开单标签（未锁定）必须说清「记录被移除了」', () => {
    // 2026-10-25「安静的成功」：成功文案不再复述用户刚点过的那一下
    // （「已打开该标签页」—— 界面自明），只留下**界面表达不了的那件事**：
    // 那条记录被移除了（不可逆、无回收站）。
    const msg = openSingleTabSuccessMessage();
    assert.match(msg, /从会话中移除/);
  });

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
    const all = [
      restoreGroupSuccessMessage(1),
      openSingleTabSuccessMessage(),
      restoreAllSearchSuccessMessage({
        matched: 1,
        opened: 1,
        removed: 1,
        keptLocked: 0,
        failedToRemove: 0,
      }),
    ].join('\n');
    for (const forbidden of ['OPEN_TABS', 'OPEN_TAB', 'deleteGroup', 'SW', 'mutation']) {
      assert.doesNotMatch(all, new RegExp(forbidden), `文案不应出现「${forbidden}」`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 接线：调用真的接上了吗
// ─────────────────────────────────────────────────────────────────────────

/**
 * 数一数「成功播报」的调用点。
 *
 * 2026-10-22 审计 P0-4：「恢复即消费」是不可逆的删除，所以成功播报现在
 * 多了一条路 —— 走共享 hook（`showConsumeToast`，它内部再走
 * `showRestoreSuccessMessage`，额外挂一个「撤销」按钮）。两条路都是
 * 「出声了」，所以这里数的是**两者之和**；只认某一条字面量的话，
 * 换个出口就会被误判成「没接上」。
 */
/**
 * 数「成功播报」在源码里出现了几次。
 *
 * ── 2026-10-25 终审修复：改按**数据流**数，不再钉字面量形状 ────────────────
 *
 * 文案现在先落到 fact（判据层与播报共用同一份）⇒ `showConsumeToast` 的第一个
 * 实参是那个变量，**不再紧贴** `restoreGroupSuccessMessage(`。原来的正则
 * `showConsumeToast\(\s*文案函数\(` 会数成 0 ⇒ 报「没有成功反馈」——
 * 红在一个正确的改动上（本仓的教训：先怀疑守卫钉错了值，不是回退实现）。
 *
 * ⇒ 判据要数的是**调用点**：
 *   · 第一个实参直接是 `copyFn(...)`，或
 *   · 第一个实参是某个**由 `copyFn(...)` 初始化**的局部变量。
 *   注释 / 空白出现在哪里都不影响（AST 已经看不见注释）。
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
      (node.expression.text === 'showConsumeToast' ||
        node.expression.text === 'showRestoreSuccessMessage')
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

describe('恢复成功反馈真的接到了两个界面', () => {
  // ── 2026-10-25「安静的成功」：断言**收窄** ──────────────────────────────
  //
  // 锁定会话恢复后**保留在列表里** ⇒ 那张卡还在 ⇒ 界面自明 ⇒ 锁定路径
  // **静默**（不再要求它播报）。但它仍然必须：
  //   ① 判过**成功门**（SW 拒开不许谎报成功）；
  //   ② 失败路径**出声**（打不开必须明说，记录原样保留）。
  //
  // 未锁定路径相反：必须播报，且那条提示上必须挂着**撤销**。
  // 细则（接线 / 退路 / 成功门）见 tests/guards/quietSuccess.test.ts。
  it('列表页（TabGroup）：未锁定的整组恢复与点开单标签都要出声', () => {
    const src = read('src/components/tabs/TabGroup.tsx');
    // 两个动作各一次成功反馈（**未锁定**那一条）
    const groupRestore = countSuccessToasts(src, 'restoreGroupSuccessMessage');
    const singleOpen = countSuccessToasts(src, 'openSingleTabSuccessMessage');
    assert.equal(groupRestore, 1, '列表页整组恢复必须有一次成功反馈（未锁定那条）');
    // countSuccessToasts 返回的是**数字**（两条路的计数之和）。
    // 早先这里写的是 `singleOpen.length >= 2` —— 数字上的 .length 是
    // undefined，断言永远为假 ⇒ 这条守卫从来没有真正生效过
    // （把两条成功播报全删掉它也不会红）。修的是守卫，不是实现。
    // 2026-10-25：锁定那条已静默 ⇒ 这里是 **1**（未锁定那条）而不是 2。
    assert.equal(
      singleOpen,
      1,
      '列表页点开单标签（未锁定那条）必须有成功反馈（锁定那条已静默）'
    );
  });

  it('列表页必须从共享模块取文案，不能自己拼字符串', () => {
    const src = read('src/components/tabs/TabGroup.tsx');
    assert.match(
      src,
      /import\s*\{[^}]*restoreGroupSuccessMessage[^}]*\}\s*from\s*'@\/components\/tabs\/restoreFeedbackCopy'/,
      '列表页必须引用共享文案模块（两处各写一遍文案迟早漂移）'
    );
  });

  it('搜索页（SearchResultList）也用同一份共享文案', () => {
    const src = read('src/components/search/SearchResultList.tsx');
    assert.match(
      src,
      /restoreAllSearchSuccessMessage/,
      '搜索页必须引用共享文案模块'
    );
    assert.doesNotMatch(
      src,
      /showRestoreSuccess\(\s*matchingTabs\.length\s*\)/,
      '旧的固定模板调用应已换成共享文案（否则两处措辞会漂移）'
    );
  });

  // ───────────────────────────────────────────────────────────────────────
  // 搜索页的三条路径（2026-10-22 审计 P1-4）
  //
  // 缺陷：搜索页「恢复整个会话」与「点开单标签」**零成功反馈** ——
  // 窗口开了、会话卡从列表消失、屏幕上什么都不动；而列表页（主界面）早就有播报。
  // 同一个产品动作，两个界面两种反馈。
  // 守卫盲区：下面原来只查了列表页与搜索页的**批量**恢复，
  // 单会话恢复与单标签点开两条路径**既没实现、也没被守**。
  // ───────────────────────────────────────────────────────────────────────
  it('搜索页：恢复整个会话必须有成功反馈', () => {
    const src = read('src/components/search/SearchResultList.tsx');
    assert.equal(
      countSuccessToasts(src, 'restoreGroupSuccessMessage'),
      1,
      '搜索页整组恢复必须有一次成功反馈（未锁定那条）'
    );
  });

  it('搜索页：点开单标签（未锁定那条）必须有成功反馈', () => {
    const src = read('src/components/search/SearchResultList.tsx');
    const singleOpen = countSuccessToasts(src, 'openSingleTabSuccessMessage');
    assert.equal(
      singleOpen,
      1,
      '搜索页点开单标签（未锁定那条）必须有成功反馈（锁定那条已静默）'
    );
  });

  it('搜索页与列表页的锁定分支都必须**没有播报、但成功门与失败出口仍在**', () => {
    // 2026-10-22 审计 P1-6：锁定分支原先是 `.then(() => 报成功)`，
    // 而 SW 拒开是 `sendResponse({success:false})` ⇒ promise **resolve 而非
    // reject** ⇒ `.then` 照样跑 ⇒ 界面播「已打开」，实际一个标签都没开。
    //
    // 2026-10-25「安静的成功」：锁定分支**不再播报**（锁定组从不被消费 ⇒
    // 记录还在 ⇒ 界面自明），但**成功门不许跟着播报一起消失** ——
    // 打不开必须明说「已保留在会话中」，否则「点了没反应」与「已打开」
    // 用户分不出来。
    for (const file of [
      'src/components/search/SearchResultList.tsx',
      'src/components/tabs/TabGroup.tsx',
    ]) {
      // 剥注释后再抽分支：注释里也会出现 `showRestoreError(` / `showToast(`
      // （本任务就在锁定分支里写了一整段解释）⇒ 拿原始源码判
      // `doesNotMatch(/showToast\(/)` 会被注释误伤成假红，
      // `match(/showRestoreError\(/)` 又能被注释满足成假绿。
      // （2026-10-25 修复轮 1，与 tests/guards/quietSuccess.test.ts 同口径。）
      const src = stripComments(read(file));
      const branch = extractLockedBranch(src);
      assert.ok(branch, `${file}：应能找到 handleOpenTab 里的锁定分支`);
      assert.doesNotMatch(
        branch,
        /showRestoreSuccessMessage|showConsumeToast|showToast\(/,
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

  it('toastHelper 暴露了自定义成功文案的通道', () => {
    const src = read('src/utils/toastHelper.ts');
    assert.match(src, /showRestoreSuccessMessage/, '必须提供自定义文案的出口');
    // noop 分支也要有，否则 useEnhancedToast 在无 Provider 时会崩
    const noopBranch = src.slice(src.indexOf('return {', src.indexOf('logError')));
    assert.match(noopBranch, /showRestoreSuccessMessage:\s*noop/, 'noop 分支也必须导出它');
  });
});
