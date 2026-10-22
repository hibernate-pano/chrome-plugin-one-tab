// 锁定会话的删除语义（2026-10-20 审计 A-3）。
//
// 【本文件要防的回归类别】「锁定防误删」是本产品在商店页与引导页上的明确承诺
// （CHROMEWEBSTORE.md「会话整理：……锁定防误删」、README「当前能力」段），
// 而删除自 v1.22.0 起是**物理清除、无回收站、无撤销**。
//
// 修复前的实现把锁定当成了「**不可删除**」：
//   ① `TabGroup.tsx` 的宽屏删除按钮与窄屏「更多」菜单里的「删除会话」都被
//      `{!group.isLocked && (…)}` 包住 ⇒ 锁定后**整个删除入口消失**，
//      用户必须先解锁才能删。而用户锁定的动机是「这个重要，别弄丢」
//      ⇒ 结果变成「永远删不掉」，锁定成了「禁止删除」而不是「防误删」。
//   ② 「删除所有会话」**无视锁定全删**，而确认框一个字不提锁定
//      （`deleteAllConfirmMessage` 只说「将删除本地全部 N 个会话」）——
//      用户以为「锁定的那些是安全的」，实际它们是第一个被清空的。
//
// 【修法】
//   ① 锁定会话**保留删除入口**（宽屏按钮 + 窄屏菜单项），删除它是**更重的
//      动作**：确认框的标题与正文都必须点明「该会话已锁定」。
//      锁定保护的是**会话内部**（不可重命名 / 不可逐条删 / 不可拖走 /
//      不参与清理重复），不是「这张卡不许消失」。
//   ② 「删除所有会话」走**方案 B**（全部删除，但确认框与菜单行写明
//      「其中包含 N 个已锁定的会话」）—— 理由写在 deleteAllMessages.ts 文件头：
//      方案 A（跳过锁定）会留下无处可去的残渣（无回收站 ⇒ 只能逐个解锁再删），
//      而全量物理移除本来就是 v1.22.0 起的明确产品决定，B 只是把它说清楚。
//
// 【本文件钉住的不变量】
//   · 文案层（纯函数）：标题/正文点名「已锁定」；锁定 ⇒ 必须确认，与开关无关。
//   · 结构层（.tsx 源码断言）：两个删除入口**不再**被 `!group.isLocked` 包住；
//     而**逐条**删除的锁（不可重命名 / 不可逐条删 / 不可拖走 / 不参与清理重复）
//     必须**原样保留**（锁定承诺一条都不许放松）。
//   · 披露层：「删除所有会话」的确认框与菜单行都必须带出锁定会话数。
//
// 【为什么用源码结构断言】.tsx 组件在本仓没有 DOM 测试环境（无 jsdom /
// @testing-library），node 单测加载不了 JSX；沿用本仓既有惯例
// （见 guards/lockedTabDeleteGuard.test.ts、guards/audit20261019Ui.test.ts）。
// 断言只钉**渲染分支结构**这一条不变式，不绑定具体 CSS 类名。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  deleteGroupConfirmMessage,
  deleteGroupConfirmTitle,
  deleteGroupEntryLabel,
  deleteGroupRequiresConfirm,
} from '../src/components/tabs/lockedDeleteCopy.ts';
import {
  deleteAllConfirmMessage,
  deleteAllLockedWarning,
  deleteAllMenuWarning,
} from '../src/components/layout/deleteAllMessages.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
/** 剥掉注释：源码断言必须判「代码结构」而不是「注释里提到的话」。 */
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const TAB_GROUP = 'src/components/tabs/TabGroup.tsx';
const DROPDOWN = 'src/components/layout/HeaderDropdown.tsx';

// ── AST 辅助：判断「某个 JSX 元素是否被 !group.isLocked 条件包住」 ─────────
//
// 为什么用 AST 而不是正则：正则只能看「附近有没有那串字符」，
// 判不出**嵌套关系** —— 而本文件要防的正是嵌套（「按钮被条件包住」）。
// AST 能直接回答「这个元素的祖先里有没有 `!group.isLocked && (...)`」。
function parseTsx(rel: string): ts.SourceFile {
  return ts.createSourceFile(
    rel,
    read(rel),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
}

/** 该表达式是否读到了 `group.isLocked`。 */
function mentionsGroupIsLocked(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (
      ts.isPropertyAccessExpression(n) &&
      n.name.text === 'isLocked' &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'group'
    ) {
      found = true;
      return;
    }
    n.forEachChild(visit);
  };
  visit(node);
  return found;
}

/**
 * 该节点是否是 `!group.isLocked` —— 两种形态都认：
 *   · JSX 里的 `{!group.isLocked && (…)}` ⇒ BinaryExpression(&&, !group.isLocked)
 *   · 三元里的 `group.isLocked ? … : …` 的否定分支 ⇒ PrefixUnaryExpression(!…)
 */
function isNotGroupIsLocked(node: ts.Node): boolean {
  if (ts.isPrefixUnaryExpression(node)) {
    if (node.operator !== ts.SyntaxKind.ExclamationToken) return false;
    return mentionsGroupIsLocked(node.operand);
  }
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) return false;
    return isNotGroupIsLocked(node.left);
  }
  return false;
}

/**
 * 找出所有「onClick 里调用了 handleDelete」的 JSX 元素。
 * 返回每个元素**是否**被 `!group.isLocked && (...)` 包住。
 */
function deleteEntryIsLockedGated(rel: string): Array<{ gated: boolean; text: string }> {
  const sf = parseTsx(rel);
  const results: Array<{ gated: boolean; text: string }> = [];

  const visit = (node: ts.Node, gated: boolean) => {
    let childGated = gated;
    // `{!group.isLocked && (…)}` 里的 `&&` 表达式
    if (ts.isBinaryExpression(node) && isNotGroupIsLocked(node)) {
      childGated = true;
    }
    // 三元 `cond ? a : b` 的**否定分支** —— `group.isLocked ? x : y` 里 x 是锁定态
    if (ts.isConditionalExpression(node) && isNotGroupIsLocked(node.condition)) {
      childGated = true;
    }
    if (ts.isJsxElement(node)) {
      const opening = node.openingElement;
      const onClick = opening.attributes.properties.find(
        (p): p is ts.JsxAttribute =>
          ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === 'onClick'
      );
      if (onClick?.initializer) {
        const initText = onClick.initializer.getText(sf);
        if (/handleDelete/.test(initText)) {
          results.push({ gated: childGated, text: initText });
        }
      }
    }
    node.forEachChild(child => visit(child, childGated));
  };
  visit(sf, false);
  return results;
}

/**
 * 找出所有「重命名」入口（宽屏的标题按钮 + 窄屏的菜单项）。
 * 返回每个元素**是否**被 `!group.isLocked` 包住。
 *
 * ── 为什么不能写成正则 ────────────────────────────────────────────────────
 *
 * 原来的断言钉的是字面量 `{!group.isLocked && (<button … 重命名会话`。
 * 那条正则判不出**嵌套关系**，只能判「附近有没有那串字符」——
 * 于是给按钮套一层 <Tooltip>（2026-10-22 审计 U-18：卡片头不再用原生
 * `title=`，换成仓里的 Tooltip）就让它失配，而「锁定时重命名仍被挡住」
 * 这条承诺**根本没有被破坏**。
 *
 * 这是本仓反复踩到的坑：**守卫钉死字面量 ⇒ 把正确的修法判成回归**。
 * 断言必须判「这个元素是不是被 `!group.isLocked` 包着」，
 * 判嵌套就得用 AST（判不了嵌套的正则只会制造假红）。
 */
function renameEntryIsLockedGated(rel: string): Array<{ gated: boolean; text: string }> {
  const sf = parseTsx(rel);
  const results: Array<{ gated: boolean; text: string }> = [];

  const visit = (node: ts.Node, gated: boolean) => {
    let childGated = gated;
    if (ts.isBinaryExpression(node) && isNotGroupIsLocked(node)) {
      childGated = true;
    }
    if (ts.isConditionalExpression(node) && isNotGroupIsLocked(node.condition)) {
      childGated = true;
    }
    if (ts.isJsxElement(node)) {
      const opening = node.openingElement;
      const text = node.getText(sf);
      const onClick = opening.attributes.properties.find(
        (p): p is ts.JsxAttribute =>
          ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === 'onClick'
      );
      // 「重命名」入口的两种形态：
      //   · 宽屏：标题 <h3>（onClick 里 setIsEditing(true)）
      //   · 窄屏：菜单项 <button role="menuitem">，正文是「重命名会话」
      //
      // ⚠️ 只认 button / h3 这两种**真正能点的元素**：用「整段文本里出现
      // 『重命名会话』」来判的话，外层那张卡片 div 也会命中（菜单项在它里面），
      // 而卡片 div 天然不在 `!group.isLocked` 里 ⇒ 断言必假红。
      const tag = opening.tagName.getText(sf);
      const isEntryTag = tag === 'button' || tag === 'h3';
      const isRenameEntry =
        isEntryTag &&
        ((onClick?.initializer
          ? /setIsEditing\(true\)/.test(onClick.initializer.getText(sf))
          : false) ||
          /重命名会话/.test(text));
      if (isRenameEntry) {
        // 「被挡住」有两种实现，判据必须把两种都认：
        //   ① 元素**不渲染**（`{!group.isLocked && (<button …>)}`）；
        //   ② 元素渲染，但点击时**自己先判**（标题 <h3> 的 onClick 里
        //      `!group.isLocked && setIsEditing(true)`）。
        // 锁定态下标题仍然渲染（它还要显示名字、还要能被读屏读到），
        // 所以它的挡法只能是 ② —— 只认 ① 会把它判成「没挡住」。
        const handlerGuards =
          onClick?.initializer ? /!\s*group\.isLocked/.test(onClick.initializer.getText(sf)) : false;
        results.push({
          gated: childGated || handlerGuards,
          text: text.slice(0, 120),
        });
      }
    }
    node.forEachChild(child => visit(child, childGated));
  };
  visit(sf, false);
  return results;
}

// ══════════════════════════════════════════════════════════════════════════
// 1. 锁定会话的删除确认文案（纯函数）
// ══════════════════════════════════════════════════════════════════════════

describe('锁定会话的删除确认：标题与正文都必须点名「已锁定」', () => {
  it('锁定会话的标题里出现「已锁定」', () => {
    const title = deleteGroupConfirmTitle({ name: '重要会话', tabCount: 12, isLocked: true });
    assert.match(title, /已锁定/, '标题必须点明这个会话被锁定过');
    assert.match(title, /重要会话/, '标题仍然要说出是哪个会话');
  });

  it('锁定会话的正文里出现「已锁定」', () => {
    const message = deleteGroupConfirmMessage({ name: '重要会话', tabCount: 12, isLocked: true });
    assert.match(message, /已锁定/, '正文必须点明这个会话被锁定过');
  });

  it('锁定会话的正文仍然说清「永久删除 + 不可恢复 + 标签页数」', () => {
    const message = deleteGroupConfirmMessage({ name: '重要会话', tabCount: 12, isLocked: true });
    // 2026-10-23 审计 H-10：「标签记录」统一成「标签页」
    // （同一个东西在本仓曾有三种叫法：标签页 / 标签 / 标签记录）。
    assert.match(message, /12 个标签页/, '必须说出这次会删掉多少条记录');
    assert.match(message, /无法恢复/, '必须说清不可恢复（无回收站）');
  });

  it('未锁定会话的标题与正文不出现「锁定」字样', () => {
    const title = deleteGroupConfirmTitle({ name: '普通会话', tabCount: 3, isLocked: false });
    const message = deleteGroupConfirmMessage({ name: '普通会话', tabCount: 3, isLocked: false });
    assert.doesNotMatch(title, /锁定/, '未锁定会话不该被说成锁定的');
    assert.doesNotMatch(message, /锁定/, '未锁定会话不该被说成锁定的');
  });

  it('未锁定会话的正文保持既有口径（逐字不变）', () => {
    assert.equal(
      deleteGroupConfirmMessage({ name: '普通会话', tabCount: 3, isLocked: false }),
      '将永久删除该会话内的 3 个标签页，删除后无法恢复。确认继续吗？'
    );
  });

  it('界面文案里不出现英文机器串（全中文界面）', () => {
    for (const isLocked of [true, false]) {
      const text =
        deleteGroupConfirmTitle({ name: '会话', tabCount: 1, isLocked }) +
        deleteGroupConfirmMessage({ name: '会话', tabCount: 1, isLocked });
      assert.doesNotMatch(text, /[A-Za-z]{4,}/, `文案里出现了英文串：${text}`);
    }
  });
});

describe('锁定会话的删除必须确认，且不受「删除会话前确认」开关约束', () => {
  it('锁定 + 开关关闭 ⇒ 仍然必须确认', () => {
    assert.equal(
      deleteGroupRequiresConfirm({ isLocked: true, confirmBeforeDelete: false }),
      true,
      '锁定会话的删除是越权动作：开关关掉就悄悄删，等于把「锁定」变回谎话'
    );
  });

  it('锁定 + 开关打开 ⇒ 确认', () => {
    assert.equal(deleteGroupRequiresConfirm({ isLocked: true, confirmBeforeDelete: true }), true);
  });

  it('未锁定 + 开关打开 ⇒ 确认（既有行为不变）', () => {
    assert.equal(deleteGroupRequiresConfirm({ isLocked: false, confirmBeforeDelete: true }), true);
  });

  it('未锁定 + 开关关闭 ⇒ 不确认（既有行为不变，不给日常删除加噪音）', () => {
    assert.equal(deleteGroupRequiresConfirm({ isLocked: false, confirmBeforeDelete: false }), false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. 结构层：两个删除入口必须对锁定会话仍然渲染
// ══════════════════════════════════════════════════════════════════════════

describe('会话卡片：锁定会话仍渲染删除入口（宽屏按钮 + 窄屏菜单项）', () => {
  const src = code(TAB_GROUP);

  it('存在两个删除入口（宽屏按钮 + 窄屏菜单项）', () => {
    const entries = deleteEntryIsLockedGated(TAB_GROUP);
    assert.equal(
      entries.length,
      2,
      `应有两个调 handleDelete 的入口（宽屏按钮 + 窄屏菜单项），实际 ${entries.length}`
    );
  });

  it('两个删除入口都不再被 !group.isLocked 包住', () => {
    const entries = deleteEntryIsLockedGated(TAB_GROUP);
    for (const [i, entry] of entries.entries()) {
      assert.equal(
        entry.gated,
        false,
        `第 ${i + 1} 个删除入口又被 !group.isLocked 包回去了 —— ` +
          '锁定会话将没有任何删除入口，「锁定」变成了「禁止删除」'
      );
    }
  });

  it('宽屏删除按钮的可访问名对锁定会话说清「已锁定」', () => {
    assert.match(
      src,
      /aria-label=\{deleteGroupEntryLabel\(group\.isLocked\)\}/,
      '锁定会话的删除按钮必须能被读屏区分出来'
    );
  });

  it('窄屏菜单里的删除文案对锁定会话说清「已锁定」', () => {
    assert.match(
      src,
      /\{deleteGroupEntryLabel\(group\.isLocked\)\}/,
      '锁定会话的菜单项必须能被读屏区分出来'
    );
  });

  it('删除入口的文案只有一个来源（两入口不许各写一份）', () => {
    assert.equal(deleteGroupEntryLabel(true), '删除已锁定的会话');
    assert.equal(deleteGroupEntryLabel(false), '删除会话');
    // TabGroup 里不得再出现手写的字面量（改一处漏一处就会出现两种说法）。
    assert.doesNotMatch(
      src,
      /'删除已锁定的会话'/,
      '删除入口的文案必须走 deleteGroupEntryLabel —— 同一件事只允许一种说法'
    );
  });

  it('「重命名会话」仍被锁定挡住（锁定承诺不许放松）', () => {
    // 用 AST 判「被 !group.isLocked 包住」，不用正则钉字面量 ——
    // 包装层（<Tooltip>）一变，正则就失配，而承诺并没有被破坏。
    const entries = renameEntryIsLockedGated(TAB_GROUP);
    assert.ok(entries.length >= 2, `应至少找到两处重命名入口，实得 ${entries.length}`);
    for (const entry of entries) {
      assert.equal(
        entry.gated,
        true,
        `重命名入口必须继续被锁定挡住（未包在 !group.isLocked 里）：${entry.text}`
      );
    }
  });

  it('锁定会话的删除确认框走共享的文案层（两入口同一份措辞）', () => {
    assert.match(src, /deleteGroupConfirmTitle\(copyInput\)/, '标题必须来自共享文案层');
    assert.match(src, /deleteGroupConfirmMessage\(copyInput\)/, '正文必须来自共享文案层');
    assert.match(
      src,
      /deleteGroupRequiresConfirm\(\{ isLocked: group\.isLocked, confirmBeforeDelete \}\)/,
      '确认与否的判据必须来自共享文案层'
    );
  });

  it('删除入口的 onClick 走的是同一个 handleDelete（两入口同一份行为）', () => {
    const entries = deleteEntryIsLockedGated(TAB_GROUP);
    for (const entry of entries) {
      assert.match(entry.text, /handleDelete/, '入口必须调用同一个 handleDelete');
    }
  });
});

describe('锁定承诺一条都不许放松（逐条删除 / 重命名 / 拖走 / 清理重复仍然挡住）', () => {
  const src = code(TAB_GROUP);

  it('重命名仍被锁定挡住（标题与菜单两处）', () => {
    assert.match(src, /onClick=\{\(\) => !group\.isLocked && setIsEditing\(true\)\}/);
    // 锁定态的提示语必须仍然存在，且必须点明「先解锁才能重命名」。
    // 它的**载体**换过（原生 title= → 仓里的 <Tooltip>，2026-10-22 审计 U-18），
    // 所以这里只钉「这句话在、且挂在锁定分支上」，不钉它写在哪个属性上。
    assert.match(
      src,
      /group\.isLocked \? '会话已锁定，先解锁才能重命名'/,
      '锁定态的提示语必须点明「先解锁才能重命名」'
    );
  });

  it('逐条删除仍被锁定挡住（handleDeleteTab 里先判锁定）', () => {
    const start = src.indexOf('const handleDeleteTab = useCallback(');
    assert.ok(start !== -1, '找不到 handleDeleteTab');
    const body = src.slice(start, src.indexOf('\n  };', start));
    const lockAt = body.indexOf('if (group.isLocked)');
    const dispatchAt = body.indexOf('dispatch(deleteTabAndSync(');
    assert.ok(lockAt !== -1 && dispatchAt !== -1 && lockAt < dispatchAt, '逐条删除必须先拦锁定态');
  });

  it('标签仍被传 locked={group.isLocked}（行组件据此不给 ✕ 与拖拽）', () => {
    assert.match(src, /<DraggableTab[\s\S]{0,400}?locked=\{group\.isLocked\}/);
  });

  it('数据层：清理重复仍然跳过锁定组（锁定承诺不许放松）', async () => {
    const { planCleanDuplicates } = await import('../src/core/mutationOps.ts');
    const DUP = 'https://example.com/dup';
    const group = (id: string, isLocked: boolean) =>
      ({
        id,
        name: id,
        isLocked,
        createdAt: '2026-10-20T00:00:00.000Z',
        updatedAt: '2026-10-20T00:00:00.000Z',
        tabs: [
          {
            id: `${id}-t1`,
            url: DUP,
            title: 'dup',
            createdAt: '2026-10-20T00:00:00.000Z',
            lastAccessed: '2026-10-20T00:00:00.000Z',
          },
          {
            id: `${id}-t2`,
            url: DUP,
            title: 'dup',
            createdAt: '2026-10-20T00:00:00.000Z',
            lastAccessed: '2026-10-19T00:00:00.000Z',
          },
        ],
      }) as never;
    const locked = planCleanDuplicates([group('L', true), group('U', false)]);
    const removedFromLocked = locked.removedTabsByGroup.filter(e => e.groupId === 'L');
    assert.equal(
      removedFromLocked.length,
      0,
      '锁定组不得参与「清理重复标签」—— 锁定承诺一条都不许放松'
    );
    assert.equal(
      locked.removedTabsByGroup.filter(e => e.groupId === 'U').length,
      1,
      '对照组：同一场景去掉 isLocked，未锁定组照旧被清理（豁免不是把去重整个关掉）'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 3. 「删除所有会话」必须点名锁定会话（方案 B）
// ══════════════════════════════════════════════════════════════════════════

describe('「删除所有会话」：锁定会话也删，但必须点名有几个', () => {
  it('有锁定会话时，确认框写明「其中包含 N 个已锁定的会话」', () => {
    const message = deleteAllConfirmMessage({
      groupCount: 5,
      lockedCount: 2,
      isAuthenticated: true,
      syncBackend: 'supabase',
    });
    assert.match(message, /其中包含 2 个已锁定的会话/, '确认框必须点名锁定会话的数量');
    assert.match(message, /也会被删除/, '必须说清锁定会话同样会被删掉');
  });

  it('没有锁定会话时，确认框不出现那句（不制造噪音）', () => {
    const message = deleteAllConfirmMessage({
      groupCount: 5,
      lockedCount: 0,
      isAuthenticated: true,
      syncBackend: 'supabase',
    });
    assert.doesNotMatch(message, /已锁定/, '没有锁定会话时不该提锁定');
  });

  it('菜单行副标题同样带出锁定会话数（点开菜单就该看到）', () => {
    const warning = deleteAllMenuWarning({
      lockedCount: 3,
      isAuthenticated: false,
      syncBackend: 'supabase',
    });
    assert.match(warning, /其中包含 3 个已锁定的会话/);
  });

  it('锁定句与跨设备句互不吞掉（两件事都要说）', () => {
    const message = deleteAllConfirmMessage({
      groupCount: 9,
      lockedCount: 4,
      isAuthenticated: true,
      syncBackend: 'supabase',
    });
    assert.match(message, /其中包含 4 个已锁定的会话/);
    assert.match(message, /其他登录设备将同步删除/);
    assert.match(message, /确认继续吗？/);
  });

  it('锁定句在纯函数层单独可测（同一份措辞两处复用）', () => {
    assert.equal(deleteAllLockedWarning({ lockedCount: 1 }), '，其中包含 1 个已锁定的会话，也会被删除');
    assert.equal(deleteAllLockedWarning({ lockedCount: 0 }), '');
  });
});

describe('「删除所有会话」的调用方必须把真实锁定数传进去', () => {
  const src = code(DROPDOWN);

  it('确认框调用带上了 lockedCount', () => {
    const call = src.slice(src.indexOf('deleteAllConfirmMessage({'));
    assert.ok(call.length > 0, '确认框正文必须由 deleteAllConfirmMessage 产出');
    const args = call.slice(0, call.indexOf('})'));
    assert.match(args, /lockedCount: lockedGroupCount/, '确认框必须带上真实锁定数');
    assert.match(args, /groupCount: groups\.length/, '数量必须是当前会话数');
  });

  it('菜单行调用带上了 lockedCount', () => {
    assert.match(
      src,
      /deleteAllMenuWarning\(\{[\s\S]{0,200}?lockedCount: lockedGroupCount/,
      '菜单行副标题必须带上真实锁定数'
    );
  });

  it('锁定数是从当前会话列表数出来的（不是写死的常量）', () => {
    assert.match(
      src,
      /lockedGroupCount\s*=\s*useMemo\([\s\S]{0,200}?groups\.reduce\(/,
      '锁定会话数必须由当前 groups 推导'
    );
    assert.match(src, /g\.isLocked \? acc \+ 1 : acc/, '只数 isLocked 为真的会话');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 4. 删除语义本身不变（方案 B 不许偷偷改成「跳过锁定」）
// ══════════════════════════════════════════════════════════════════════════

describe('「删除所有会话」的物理删除语义不许被文案改动带偏', () => {
  it('applyDeleteAllGroups 仍然全量物理移除（含锁定会话）', async () => {
    const { applyDeleteAllGroups } = await import('../src/core/mutationOps.ts');
    const mk = (id: string, isLocked: boolean) =>
      ({
        id,
        name: id,
        isLocked,
        createdAt: '2026-10-20T00:00:00.000Z',
        updatedAt: '2026-10-20T00:00:00.000Z',
        tabs: [],
      }) as never;
    const out = applyDeleteAllGroups(
      [mk('L', true), mk('U', false)],
      '2026-10-20T00:00:00.000Z',
      { d: 'dev', s: 1 } as never
    );
    assert.equal(out.groups.length, 0, '删除即物理清除（v1.22.0 起的明确产品决定），不得改成跳过锁定');
    assert.deepEqual(out.removedGroupIds.sort(), ['L', 'U'], '锁定会话同样在删除名单里');
    assert.equal(out.count, 2);
  });

  it('单个会话的删除在数据层也没有锁定豁免（锁是 UI 层的守卫，不是数据层的）', async () => {
    const { applyDeleteGroup } = await import('../src/core/mutationOps.ts');
    const out = applyDeleteGroup(
      [
        {
          id: 'L',
          name: 'L',
          isLocked: true,
          createdAt: '2026-10-20T00:00:00.000Z',
          updatedAt: '2026-10-20T00:00:00.000Z',
          tabs: [],
        } as never,
      ],
      'L',
      '2026-10-20T00:00:00.000Z',
      { d: 'dev', s: 1 } as never
    );
    assert.equal(out.removedGroupId, 'L', '锁定会话可以被删 —— 删除入口必须留着');
  });
});
