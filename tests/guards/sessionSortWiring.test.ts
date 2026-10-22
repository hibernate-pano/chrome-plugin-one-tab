/**
 * 排序键的**接线**守卫（2026-10-22 审计 L-10 收口）。
 *
 * ── 为什么这道守卫必须存在 ──────────────────────────────────────────────
 * L-10 落地时，判据层（`core/sessionSort.ts`）、设置层（Redux）、持久化层
 * （`storage.ts`）全都有，守卫也全绿（39 条）—— 但**列表侧根本没接线**：
 * 下拉里能选「最近活动 / 名称 / 会话大小」，列表顺序**一动不动**。
 *
 * 这类缺陷**判据层守不住**：它守的是「排序算得对不对」，而这里的问题是
 * 「排序有没有被用上」。所以必须有一道**结构层**的守卫钉住接缝：
 *   ① 面板把选择写进 `state.settings.sessionSort`；
 *   ② 列表从**同一个** store 字段读出来；
 *   ③ 列表把它喂给 `sortSessions`。
 *
 * 【为什么强调「同一个字段」】面板与列表各读各的字段是最隐蔽的一种错法：
 * 两边都「接上了」，各自单测都绿，但用户在面板里选的东西不影响列表。
 * 所以这里比的不是「两边都有 sessionSort」，而是
 * **「列表传给 sortSessions 的那个变量，就是列表从 store 里读出来的那个变量」**。
 *
 * 【为什么不钉行号 / 具体写法】接线可以换写法（换个变量名、换种 selector
 * 写法），但「同一个字段、同一条数据流」不能变。判据钉在**数据流**上，
 * 不钉在**长相**上。
 *
 * 【自证检测力】判据写成了**纯函数**（吃源码文本、吐结构）⇒ 测试可以
 * 直接喂它一段「接线被摘掉」的源码，断言它**看得见**这个破口。
 * 这比「改文件→跑→改回来」更可靠，也不会在失败时留下半改的工作区。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8');

const LIST = 'src/components/tabs/TabList.tsx';
const PANEL = 'src/components/search/SearchFilterPanel.tsx';

/** 列表侧的接线结构。 */
interface ListWiring {
  /** 从 `state.settings.sessionSort` 读出排序键时用的变量名。 */
  bindings: string[];
  /** 喂给 `sortSessions` 的第二个参数（排序键）的名字。 */
  fed: string[];
  /** 从 store 读到的路径（形如 `state.settings.sessionSort`）。 */
  selectorPaths: string[];
}

/** 解析一份源码文本，抽出列表侧的接线结构（纯函数，无 IO）。 */
function analyzeListWiring(source: string): ListWiring {
  const src = ts.createSourceFile(
    'analyze.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );

  const bindings: string[] = [];
  const fed: string[] = [];
  const selectorPaths: string[] = [];

  const visit = (n: ts.Node): void => {
    // 变量声明：const xxx = useAppSelector(state => state.settings.sessionSort)
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const initText = n.initializer.getText(src);
      if (initText.includes('state.settings.sessionSort')) {
        if (ts.isIdentifier(n.name)) bindings.push(n.name.text);
      }
    }

    // useAppSelector(state => state.settings.sessionSort) 里的 store 路径
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'useAppSelector' &&
      n.arguments.length > 0
    ) {
      const collect = (m: ts.Node): void => {
        if (ts.isPropertyAccessExpression(m)) {
          const text = m.getText(src);
          if (text.endsWith('settings.sessionSort')) selectorPaths.push(text);
        }
        m.forEachChild(collect);
      };
      collect(n.arguments[0]);
    }

    // sortSessions(a, b) 的第二个参数
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'sortSessions' &&
      n.arguments.length >= 2
    ) {
      const second = n.arguments[1];
      if (ts.isIdentifier(second)) fed.push(second.text);
    }

    n.forEachChild(visit);
  };
  visit(src);

  return { bindings, fed, selectorPaths };
}

test('排序键：列表从 store 读出来的那一个，就是喂给 sortSessions 的那一个', () => {
  const { bindings, fed } = analyzeListWiring(read(LIST));

  assert.ok(
    bindings.length > 0,
    `${LIST} 必须从 state.settings.sessionSort 读出当前排序键（否则下拉选了也不生效）`
  );
  assert.ok(
    fed.length > 0,
    `${LIST} 必须调用 sortSessions(...)（列表必须真的按排序键排）`
  );
  for (const arg of fed) {
    assert.ok(
      bindings.includes(arg),
      `sortSessions 的第二个参数「${arg}」必须就是从 state.settings.sessionSort 读出来的那个变量` +
        `（当前读出来的是：${bindings.join('、')}）—— 两边不是同一个东西，用户在下拉里选的就白选了`
    );
  }
});

test('排序键：面板与列表读的是同一个 store 字段（不许各读各的）', () => {
  const list = analyzeListWiring(read(LIST));
  const panel = analyzeListWiring(read(PANEL));

  assert.ok(
    panel.selectorPaths.length > 0,
    `${PANEL} 必须从 state.settings.sessionSort 读当前排序键`
  );
  assert.ok(
    list.selectorPaths.length > 0,
    `${LIST} 必须从 state.settings.sessionSort 读当前排序键`
  );
  assert.equal(
    list.selectorPaths[0],
    panel.selectorPaths[0],
    '面板与列表必须读同一个 store 字段（当前面板读 ' +
      `${panel.selectorPaths[0]}、列表读 ${list.selectorPaths[0]}）`
  );
});

test('排序键：面板改的是同一个 store 字段（写回与读取必须成对）', () => {
  const panel = read(PANEL);
  assert.ok(
    /setSessionSort\s*\(/.test(panel),
    `${PANEL} 必须用 setSessionSort 写回排序键（直接改本地 state 会丢在重启里）`
  );
  assert.ok(
    /sortSessions\s*\(/.test(read(LIST)),
    `${LIST} 必须调用 sortSessions(...)`
  );
});

test('接线一旦被摘掉，这道守卫必须看得见（自证检测力）', () => {
  const original = read(LIST);

  // 破口一：整段接线摘掉（判据层都做完了、列表忘了接 —— 就是 L-1x 的实况）
  const unwired = original.replace(/sortSessions\s*\(/, 'notSortSessions(');
  assert.notEqual(unwired, original, '本用例前提没成立：源码里找不到 sortSessions( 调用');
  const afterUnwire = analyzeListWiring(unwired);
  assert.equal(
    afterUnwire.fed.length,
    0,
    '判据失效：接线被摘掉后仍应识别出「没有 sortSessions 调用」'
  );

  // 破口二：接上了，但喂给 sortSessions 的不是从 store 读出来的那个变量
  const mismatched = original.replace(
    /sortSessions\((\w+),\s*\w+\)/,
    (_m, first: string) => `sortSessions(${first}, DEFAULT_SESSION_SORT)`
  );
  assert.notEqual(mismatched, original, '本用例前提没成立：源码里找不到可替换的 sortSessions 调用');
  const afterMismatch = analyzeListWiring(mismatched);
  assert.ok(
    afterMismatch.fed.length > 0,
    '判据失效：破口二没有被检出'
  );
  assert.ok(
    !afterMismatch.fed.every(arg => afterMismatch.bindings.includes(arg)),
    '判据失效：喂给 sortSessions 的变量与从 store 读出的变量不一致时，必须看得见'
  );
});
