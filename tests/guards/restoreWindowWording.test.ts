// 恢复的「开在哪个窗口」必须**说一套、做一套**（2026-10-25 立，2026-10-26 改判据）。
//
// ── 这个文件在防什么 ──────────────────────────────────────────────────────
//
// 2026-10-25 审计：点「在当前窗口打开」，提示却写「已在新窗口打开」——
// 标签明明加在**眼前**，提示却说到了别处。⇒ 修法当时是「让成功提示按
// `inCurrentWindow` 分流」。
//
// ── 2026-10-26：判据的**对象**变了（不是结论变了）───────────────────────
//
// 撤销机制下线 ⇒ 恢复整组 / 点开单标签这两条**高频**路径**完全静默**
// ⇒ 那条「已在新窗口打开 N 个标签页」的成功提示**整个消失**了
// ⇒ 「开在哪个窗口」这件事现在**只由按钮自己说**
//   （「在当前窗口打开整个会话」/「在新窗口恢复整个会话」），
//   而**行为**由那条 `OPEN_TABS` 请求里的 `inCurrentWindow` 决定。
//
// ⇒ 缺陷的**形状**没变，只是换了个位置：**按钮上写的**与**实际做的**必须一致。
//   按钮说「在当前窗口打开」而实现开了新窗 ⇒ 用户以为标签在眼前，
//   结果跑去了另一个窗口（原封不动的那个缺陷）。
//
// ── 为什么这一半必须钉在**数据流**上 ──────────────────────────────────────
//
// 「界面上出现了『当前窗口』四个字」**不等于**它开在当前窗口 ——
// 字符串在文件里、行为在另一个函数里。⇒ 断言分两半：
//   ① **文字**（按钮的 tooltip / aria-label 说的是哪个窗口）；
//   ② **数据流**（那颗按钮的 onClick → 处理函数 → `openAllTabs(??)` → 请求里的
//      `inCurrentWindow`），必须**一路带着同一个布尔值**。
//
// 等价的改写（`inCurrentWindow === true`、`Boolean(inCurrentWindow)`）不该变红
// ⇒ 接线那一半判的是**这个参数有没有跟着那个变量走**，不是逐字相等。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

/** 「当前窗口」一族词。 */
const CURRENT_WINDOW = /当前窗口|这个窗口|本窗口/;
/** 「新窗口」一族词。 */
const NEW_WINDOW = /新窗口|另开一扇窗/;

const parse = (rel: string): ts.SourceFile =>
  ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** 找出某个源文件里所有 `openAllTabs(...)` 调用的实参。 */
function findOpenAllTabsArgs(rel: string): Array<{ arg: string; line: number }> {
  const source = parse(rel);
  const calls: Array<{ arg: string; line: number }> = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'openAllTabs'
    ) {
      calls.push({
        arg: node.arguments[0]?.getText(source) ?? '(无参)',
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

/**
 * 找出「说了『当前窗口』/『新窗口』」的那个按钮，并回报它的 onClick。
 *
 * 【为什么要从 tooltip 出发找按钮】按钮本身**没有文字**（它是图标按钮）⇒
 * 「这颗按钮说的是哪个窗口」这件事只写在 tooltip / aria-label 上。
 * ⇒ 从带那段文字的 JSX 元素出发，往里找 `button`，再读它的 onClick。
 */
function findWindowButtons(rel: string): Array<{ label: string; onClick: string }> {
  const source = parse(rel);
  const out: Array<{ label: string; onClick: string }> = [];

  const textOf = (node: ts.Node): string => node.getText(source);

  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node)) {
      const opening = node.openingElement;
      const attrs = opening.attributes.properties.filter(ts.isJsxAttribute);
      // 文字可能写在 content（tooltip）或 aria-label 上，两处都认。
      const attrText = attrs
        .map(a => (a.initializer ? textOf(a.initializer) : ''))
        .join(' ');
      const isCurrent = CURRENT_WINDOW.test(attrText);
      const isNew = NEW_WINDOW.test(attrText);
      if (isCurrent || isNew) {
        // 在这个 JSX 元素内部找 button 的 onClick。
        let onClick = '';
        const findButton = (n: ts.Node) => {
          if (ts.isJsxElement(n) && n.openingElement.tagName.getText(source) === 'button') {
            const handler = n.openingElement.attributes.properties
              .filter(ts.isJsxAttribute)
              .find(a => a.name.getText(source) === 'onClick');
            if (handler?.initializer) onClick = textOf(handler.initializer);
          }
          n.forEachChild(findButton);
        };
        findButton(node);
        out.push({
          label: isCurrent ? 'current' : 'new',
          onClick: onClick.replace(/^\{|\}$/g, ''),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** 这个文件里**真的**往请求体里塞过 `inCurrentWindow` 吗？ */
function sendsInCurrentWindowFlag(rel: string): boolean {
  const source = parse(rel);
  let found = false;
  const visit = (node: ts.Node) => {
    // ⚠️ 请求体里写的是**简写**属性（`{ tabs, inCurrentWindow }`）⇒
    //   它是 ShorthandPropertyAssignment，不是 PropertyAssignment。
    //   只认后者 ⇒ 守卫会对着真实代码报「没带 inCurrentWindow」（假红）。
    const isProperty =
      ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node);
    if (
      isProperty &&
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
// 1. 列表页：两颗按钮的文字与行为必须对上
// ─────────────────────────────────────────────────────────────────────────

describe('列表页：「在当前窗口打开」与「在新窗口恢复」必须各说各的、各做各的', () => {
  const SRC = 'src/components/tabs/TabGroup.tsx';

  it('两颗按钮都在，且分别标成「当前窗口」与「新窗口」', () => {
    const buttons = findWindowButtons(SRC);
    const current = buttons.filter(b => b.label === 'current');
    const fresh = buttons.filter(b => b.label === 'new');
    assert.ok(current.length > 0, `列表页找不到说「当前窗口」的按钮（实得：${JSON.stringify(buttons)}）`);
    assert.ok(fresh.length > 0, `列表页找不到说「新窗口」的按钮（实得：${JSON.stringify(buttons)}）`);
  });

  it('「在当前窗口打开」那颗必须真的走 inCurrentWindow=true', () => {
    const buttons = findWindowButtons(SRC).filter(b => b.label === 'current');
    for (const b of buttons) {
      // 处理函数 → openAllTabs(??)
      const handler = b.onClick;
      assert.ok(
        /handleOpenAllTabsInCurrentWindow/.test(handler),
        `说「当前窗口」的按钮的 onClick 是 ${handler} —— 它不是「在当前窗口打开」那个处理函数`
      );
      const calls = findOpenAllTabsArgs(SRC).filter(
        c => c.arg === 'true' || /inCurrentWindow/.test(c.arg)
      );
      assert.ok(
        calls.length > 0,
        '找不到 openAllTabs(true) 的调用 —— 「在当前窗口打开」这条路径没了'
      );
    }
  });

  it('「在新窗口恢复」那颗必须真的走 inCurrentWindow=false', () => {
    const buttons = findWindowButtons(SRC).filter(b => b.label === 'new');
    for (const b of buttons) {
      const handler = b.onClick;
      assert.ok(
        /handleOpenAllTabs\b/.test(handler) && !/InCurrentWindow/.test(handler),
        `说「新窗口」的按钮的 onClick 是 ${handler} —— 它接到了「当前窗口」那个处理函数`
      );
    }
    const calls = findOpenAllTabsArgs(SRC);
    assert.ok(
      calls.some(c => c.arg === 'false'),
      '找不到 openAllTabs(false) 的调用 —— 「在新窗口恢复」这条路径没了'
    );
  });

  it('OPEN_TABS 请求必须把那个布尔值带上（不带 ⇒ SW 只会新开窗）', () => {
    assert.ok(
      sendsInCurrentWindowFlag(SRC),
      '列表页的 OPEN_TABS 请求里没有 inCurrentWindow ⇒ 「在当前窗口打开」实际开了新窗'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 搜索页：写「新窗口」就不许带 inCurrentWindow
// ─────────────────────────────────────────────────────────────────────────

describe('搜索页：写「新窗口」的那条请求不许带 inCurrentWindow', () => {
  const SRC = 'src/components/search/SearchResultList.tsx';

  it('搜索页的恢复按钮都写着「新窗口」', () => {
    const buttons = findWindowButtons(SRC);
    assert.ok(buttons.length > 0, '搜索页找不到任何说了窗口的恢复按钮');
    for (const b of buttons) {
      assert.equal(
        b.label,
        'new',
        `搜索页有个按钮写着「${b.label === 'current' ? '当前窗口' : '新窗口'}」—— ` +
          '搜索页的恢复一直是「新窗口」，写错就是界面在说谎'
      );
    }
  });

  it('搜索页的请求不许带 inCurrentWindow（带了就会开在当前窗口）', () => {
    assert.ok(
      !sendsInCurrentWindowFlag(SRC),
      '搜索页的 OPEN_TABS 请求带了 inCurrentWindow ⇒ 标签会加在当前窗口，' +
        '而按钮上写的是「新窗口」'
    );
  });
});
