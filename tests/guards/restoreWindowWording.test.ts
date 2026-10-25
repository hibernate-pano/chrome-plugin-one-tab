/**
 * 「恢复」的提示必须说清**开在哪个窗口**（2026-10-25 真机发现）。
 *
 * ── 这个文件要防的回归类别 ────────────────────────────────────────────────
 *
 * 恢复有两条路径，开在**不同的窗口**：
 *   · 列表页「在当前窗口打开整个会话」→ 标签加到**当前**窗口；
 *   · 列表页/搜索页「在新窗口恢复」→ 另开一扇窗。
 *
 * 修复前 `restoreGroupSuccessMessage` 把「已在新窗口打开 N 个标签页」**写死**了
 * ⇒ 点「在当前窗口打开」也这么说。**界面在撒谎**：标签明明加在了眼前这个窗口，
 * 提示却说新窗口。
 *
 * 为什么现在才算个事：2026-10-25 产品负责人把「在当前窗口打开」定成**主操作**
 * （卡头第一位 + accent 墨色 + 窄屏常驻）⇒ 这条谎话落在了**最高频**的那条
 * 路径上（真机实测：点它 ⇒ toast 写「已在新窗口打开 3 个标签页」，
 * 而 3 个标签其实加在了当前窗口）。
 *
 * ── 判据钉的是**语义**，不是字面量 ──────────────────────────────────────
 *
 *   · 当前窗口那条 ⇒ 必须说「当前窗口」，且**不得**出现「新窗口」；
 *   · 新窗口那条   ⇒ 必须说「新窗口」，且**不得**出现「当前窗口」；
 *   · 两条**必须不同**（否则 = 压根没分流）；
 *   · **接线**（第 3 个参数）必须真的接上：
 *     列表页那条必须把 `inCurrentWindow` 传进去（不许写死），
 *     搜索页那条必须与它发的那条 OPEN_TABS 请求**一致**。
 *   · 底层真的按 `inCurrentWindow` 分流（SW 选 openTabsInCurrentWindow /
 *     openTabsInNewWindow）—— 否则「当前窗口」这句话本身也是假的。
 *
 * 等价的改写（`inCurrentWindow === true`、`Boolean(inCurrentWindow)`）不该变红
 * ⇒ 接线那一半判的是**这个参数有没有跟着那个变量走**，不是逐字相等。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

import { restoreGroupSuccessMessage } from '../../src/components/tabs/restoreFeedbackCopy.ts';

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

/** 「当前窗口」一族词。 */
const CURRENT_WINDOW = /当前窗口|这个窗口|本窗口/;
/** 「新窗口」一族词。 */
const NEW_WINDOW = /新窗口|另开一扇窗/;

/** 找出某个源文件里所有 `restoreGroupSuccessMessage(...)` 的调用。 */
function findCalls(rel: string): Array<{ args: string[]; line: number }> {
  const file = rel;
  const source = ts.createSourceFile(
    file,
    read(file),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const calls: Array<{ args: string[]; line: number }> = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'restoreGroupSuccessMessage'
    ) {
      calls.push({
        args: node.arguments.map(a => a.getText(source)),
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

/**
 * 这个文件里**真的**往请求体里塞过 `inCurrentWindow` 吗？
 *
 * ⚠️ 必须走 AST，不能 grep 源码里的字样 —— 注释里提到这个词不等于代码发了它
 * （我自己写注释时就踩过：注释里写了「不带 inCurrentWindow」⇒ grep 命中
 * ⇒ 守卫判成了「搜索页会开在当前窗口」⇒ 假红）。
 */
function sendsInCurrentWindowFlag(rel: string): boolean {
  const source = ts.createSourceFile(
    rel,
    read(rel),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === 'inCurrentWindow'
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// ─────────────────────────────────────────────────────────────────────────
// 1. 文案本身：说清开在哪个窗口
// ─────────────────────────────────────────────────────────────────────────

describe('恢复提示：说清「开在哪个窗口」（2026-10-25）', () => {
  it('当前窗口那条：必须说「当前窗口」，且不得说「新窗口」', () => {
    const msg = restoreGroupSuccessMessage(3, true);
    assert.match(msg, CURRENT_WINDOW, '开在当前窗口就必须这么说');
    assert.doesNotMatch(
      msg,
      NEW_WINDOW,
      '这条谎话正是本缺陷：明明加在当前窗口，却说「新窗口」'
    );
  });

  it('新窗口那条：必须说「新窗口」，且不得说「当前窗口」', () => {
    const msg = restoreGroupSuccessMessage(3, false);
    assert.match(msg, NEW_WINDOW);
    assert.doesNotMatch(msg, CURRENT_WINDOW);
  });

  it('两条必须给出不同的话（否则 = 压根没分流）', () => {
    const inPlace = restoreGroupSuccessMessage(3, true);
    const newWindow = restoreGroupSuccessMessage(3, false);
    assert.notEqual(
      inPlace,
      newWindow,
      '两种恢复方式必须被说成两件事 —— 否则用户分不清自己点的是哪颗按钮'
    );
  });

  it('锁定那条已经**没有文案**了（锁定路径整条静默，不许留死分支）', () => {
    // 2026-10-25「安静的成功」：锁定会话恢复后**保留在列表里** ⇒ 界面自明
    // ⇒ 锁定路径不再出声 ⇒「锁定版成功提示」成为死分支 ⇒ 已删。
    // ⇒ 这个文案函数只描述**未锁定**那条（它是被消费的那条）。
    // 断言的是**没有 isLocked 这条岔路**（不是逐字比对某句中文）。
    const msg = restoreGroupSuccessMessage(2);
    assert.doesNotMatch(
      msg,
      /仍保留在列表中/,
      '成功提示只描述未锁定那条（锁定那条已静默）—— 留着就是一条死分支'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 接线：第二个参数必须真的接上
// ─────────────────────────────────────────────────────────────────────────

describe('恢复提示的接线：第二个参数必须跟着「开在哪个窗口」走', () => {
  it('列表页那条必须把 inCurrentWindow 传进去（不许写死）', () => {
    const calls = findCalls('src/components/tabs/TabGroup.tsx');
    assert.ok(calls.length > 0, '列表页必须真的调用这个文案函数');
    for (const call of calls) {
      assert.ok(
        call.args.length >= 2,
        `列表页第 ${call.line} 行的调用少传了第二个参数 ⇒ 文案会自己猜「新窗口」` +
          '（等价于把谎话写死）'
      );
      assert.match(
        call.args[1],
        /inCurrentWindow/,
        `列表页第 ${call.line} 行传的是 ${call.args[1]} ⇒ 那个「当前窗口」的提示` +
          '永远不会被说出来'
      );
    }
  });

  it('搜索页那条必须与它发的那条 OPEN_TABS 请求一致', () => {
    const calls = findCalls('src/components/search/SearchResultList.tsx');
    assert.ok(calls.length > 0, '搜索页必须真的调用这个文案函数');
    const src = 'src/components/search/SearchResultList.tsx';
    // 搜索页的请求不带 inCurrentWindow ⇒ SW 会新开一扇窗 ⇒ 文案必须说「新窗口」。
    const sendsInCurrentWindow = sendsInCurrentWindowFlag(src);
    for (const call of calls) {
      assert.ok(
        call.args.length >= 2,
        `搜索页第 ${call.line} 行的调用少传了第二个参数`
      );
      if (sendsInCurrentWindow) {
        assert.match(call.args[1], /inCurrentWindow/);
      } else {
        assert.match(
          call.args[1],
          /^false$/,
          `搜索页第 ${call.line} 行传的是 ${call.args[1]}，而它发的请求不带 ` +
            'inCurrentWindow ⇒ 标签会开在新窗口，文案却会说自己窗口'
        );
      }
    }
  });

  it('全仓每个调用点都必须显式传第二个参数（不许吃默认值）', () => {
    const files = [
      'src/components/tabs/TabGroup.tsx',
      'src/components/search/SearchResultList.tsx',
    ];
    for (const file of files) {
      for (const call of findCalls(file)) {
        assert.ok(
          call.args.length >= 2,
          `${file}:${call.line} 少传第二个参数 —— 默认值是「新窗口」，` +
            '而列表页有一半路径开在当前窗口'
        );
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 底层：SW 真的按 inCurrentWindow 分流（否则「当前窗口」本身就是假的）
// ─────────────────────────────────────────────────────────────────────────

describe('底层：SW 真的按 inCurrentWindow 分流', () => {
  it('SW 必须按 data.inCurrentWindow 选「当前窗口 / 新窗口」两种开法', () => {
    const src = read('src/service-worker.ts');
    assert.match(
      src,
      /inCurrentWindow[\s\S]{0,200}openTabsInCurrentWindow/,
      'SW 收到 inCurrentWindow 时必须开在当前窗口'
    );
    assert.match(
      src,
      /openTabsInNewWindow/,
      'SW 也必须保留「新窗口」这条开法'
    );
  });
});
