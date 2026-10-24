/**
 * 会话卡片头与标签行的动作层守卫（2026-10-22 审计 U-10 / U-11 / U-15 / U-18 / U-21）。
 *
 * ── 这个文件防的具体事故 ────────────────────────────────────────────────
 *
 * U-10 两枚「打开」图标在 16px 下近乎同形：原先两个都是「同一个圆角矩形 +
 *      只差箭头朝向」⇒ 90% 像素一样。而它们是全产品最高频的两个动作
 *      （恢复 / 就地打开），并排出现在每一张卡上。
 *
 * U-11 锁定按钮的 tooltip 没说清「现在是什么状态」与「点了会发生什么」，
 *      而锁定改变的是「恢复后还在不在」这条最容易被误解的规则。
 *
 * U-18 顶栏用仓里的 <Tooltip>（300ms、样式可控、触屏能出现），
 *      卡片头却用原生 `title=`（≈1s、样式不可控、**触屏永远不出现**）。
 *
 * U-21 标签行的删除键在 ≥768px 是 `opacity: 0` 但 `pointer-events: auto`
 *      ⇒ 在按钮中心做 elementFromPoint，命中的**就是那个不可撤销的删除按钮**。
 *      鼠标用户有 hover 兜底；**触屏没有 hover** ⇒ 用户看不见却可能点到。
 *
 * ── 2026-10-24：U-15 与 U-10 的「形状可分」已按产品决定退掉 ─────────────
 *
 * 产品负责人 2026-10-24 判断「当前 UI 和设计的交互还要再往前推一版」，
 * 指认 **v1.25.1** ⇒ 卡片头**回到 v1.25.1 的样子**。被退掉的是两条
 * **钉长相**的要求，退掉它们是**产品决定**，不是偷懒：
 *
 *   · **U-15（卡头有 favicon）** —— v1.25.1 的卡头没有网站图标。
 *     ⇒ 断言整块删除。`@/domain/tabGroup/pickDominantTab` 这个纯函数
 *     **保留**（它有四条契约、另有单测守着，且 src/domain/ 不在本次
 *     改动范围内），只是界面不再消费它。
 *   · **U-10 的「两枚图标必须形状可分」** —— v1.25.1 的两枚图标是
 *     「同一个闭合框 + 各自的一笔箭头」，16px 下确实很接近。
 *     ⇒ 那条断言删除；**「两个图标不许完全相同」那条保留**
 *     （它是更弱但仍成立的不变量：两个动作的图标不能是同一张图）。
 *     U-10 的另一半（主操作要更醒目）改判成 v1.25.1 的做法：
 *     **靠墨色分主次**（accent 墨色 vs 中性描边），不再靠实底。
 *
 * U-11（锁定态可区分 + 提示说清后果）、U-18（不用原生 title=）、
 * U-21（看不见的东西不许能点）**一条没退** —— 它们守的是诚实度与
 * 可达性，不是长相。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 *
 * ① 钉**不变量**，不钉字面量：断言「渲染处调用了 pickDominantTab」，
 *    而不是「src 等于某个字符串」；断言「两段 path 不相等」，
 *    而不是「path 等于某条具体路径」—— 换一个更好的画法不该让守卫变红。
 * ② 每条断言都写清「破了会怎样」—— 守卫的价值在于失败时能立刻说出后果。
 * ③ TSX 里的 JSX 无法在 node 里加载（无 DOM），所以这一层断言源码结构；
 *    纯函数（pickDominantTab）另有单测守着契约本身。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** 去掉注释：源码断言必须判「代码结构」，不能被注释里提到的话喂饱。 */
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const TAB_GROUP = code('src/components/tabs/TabGroup.tsx');
const DRAGGABLE_TAB = code('src/components/dnd/DraggableTab.tsx');
const GLOBAL_CSS = code('src/styles/global.css');

/** 抽出某个图标组件里所有 <path> 的 d 属性。 */
function pathDataOf(iconName: string): string[] {
  const start = TAB_GROUP.indexOf(`const ${iconName} = (`);
  assert.ok(start > -1, `找不到图标组件 ${iconName}`);
  const end = TAB_GROUP.indexOf('\n);', start);
  assert.ok(end > start, `图标组件 ${iconName} 的结尾找不到`);
  const body = TAB_GROUP.slice(start, end);
  return [...body.matchAll(/d="([^"]+)"/g)].map(m => m[1]);
}

// ══════════════════════════════════════════════════════════════════════════
// U-15 · 卡头 favicon —— **2026-10-24 按产品决定退掉**
// ══════════════════════════════════════════════════════════════════════════
//
// 原要求：「卡头必须有一枚网站图标」（层级不倒挂：标签行有、卡片没有 ⇒
// 一屏十张卡长得一模一样）。
//
// 退掉它的**是产品决定**：2026-10-24 产品负责人指认 v1.25.1 为目标长相，
// 而 v1.25.1 的卡头**没有**这枚图标 ⇒ 界面回到 v1.25.1 ⇒ 这条设计约定
// 不再成立。
//
// ⚠️ `@/domain/tabGroup/pickDominantTab` **没有删**：
//   · 它是纯函数，四条契约有独立单测（tests/guards/sessionNaming.test.ts）；
//   · src/domain/ 不在本次「界面回退」的改动范围里。
//   ⇒ 它只是**不再被界面消费**。哪天要恢复卡头图标，直接接回去即可。

// ══════════════════════════════════════════════════════════════════════════
// U-10 · 两枚「打开」图标不许是同一张图
// ══════════════════════════════════════════════════════════════════════════

describe('U-10 · 两枚「打开」图标不许完全相同', () => {
  it('两枚图标的 path 不完全相同', () => {
    const newWindow = pathDataOf('OpenAllIcon');
    const inPlace = pathDataOf('OpenAllInPlaceIcon');
    assert.ok(newWindow.length > 0, 'OpenAllIcon 至少要有一条 path');
    assert.ok(inPlace.length > 0, 'OpenAllInPlaceIcon 至少要有一条 path');
    assert.notDeepEqual(
      newWindow,
      inPlace,
      '两个「打开」图标的 path 完全相同 ⇒ 16px 下就是同一个图形，' +
        '用户分不清「新窗口恢复」与「就地打开」'
    );
  });

  // ── 已退：'两枚图标必须**形状**上可分' ──────────────────────────────────
  //
  // 原断言是「两者不许共用同一条 path」（⇒ 基础形状真的不同，遮住颜色也能分）。
  // 2026-10-24 产品负责人要求界面回到 v1.25.1，而 v1.25.1 的两枚图标正是
  // 「同一个闭合框 + 各自的一笔箭头」⇒ 这条要求不再成立，退掉。
  //
  // 退掉它**不等于**「两个图标可以是同一张图」：上面那条
  // 「path 不完全相同」仍在守着（两个动作的图标不能一模一样）。
  //
  // 主次靠**墨色**分（见下一条），不靠形状。

  it('主操作（新窗口恢复）仍要比另一个醒目 —— 用 accent 墨色，不靠实底', () => {
    // 「在新窗口恢复整个会话」是这个产品的「找回」入口 ⇒ 必须是主操作。
    //
    // v1.25.1 的做法：accent **墨色**的描边图标（tab-group-action-accent），
    // 「在当前窗口打开」是中性描边 ⇒ 主次一样分得开，只是不再靠实底。
    // 第 42 轮审计 U-10 把它加成了 .theme-cta 实底按钮，2026-10-24 已按
    // 产品决定退回 v1.25.1 的做法（见 TabGroup.tsx 的按钮注释）。
    assert.match(
      TAB_GROUP,
      /tab-group-action-accent/,
      '「在新窗口恢复整个会话」必须用 accent 墨色（.tab-group-action-accent）标出主次'
    );
    assert.doesNotMatch(
      TAB_GROUP,
      /OpenAllInPlaceIcon[\s\S]{0,120}?tab-group-action-accent/,
      '「在当前窗口打开」不得也用 accent 墨色 —— 两个都醒目就没有主次了'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// U-11 · 锁定态必须能被区分，且 tooltip 要说清状态与后果
// ══════════════════════════════════════════════════════════════════════════

describe('U-11 · 锁定态必须视觉可区分 + tooltip 说清后果', () => {
  it('锁定与未锁定两支的 class 与 aria-label 都不同', () => {
    // 断了 ⇒ 一屏卡片里锁没锁看不出来，用户只能逐个点。
    assert.match(
      TAB_GROUP,
      /aria-label=\{group\.isLocked \? '解锁会话' : '锁定会话'\}/,
      '锁定按钮的可访问名必须区分锁定 / 解锁'
    );
    assert.match(
      TAB_GROUP,
      /group\.isLocked \? 'tab-group-lock-icon' : ''/,
      '锁定按钮的 class 必须区分锁定 / 未锁定（锁定态要有强调色）'
    );
    // 形状差异：闭锁与开锁是两条不同的 path。
    const locked = pathDataOf('LockIcon');
    assert.ok(locked.length >= 2, 'LockIcon 必须有闭锁 / 开锁两条分支');
    assert.notEqual(
      locked[0],
      locked[1],
      '闭锁与开锁画成了同一张图 ⇒ 「形状＝状态」这条读法失效'
    );
  });

  it('锁定的 tooltip 同时说明「当前状态」与「点了会发生什么」', () => {
    // 原文案只有「锁定会话」三个字 —— 用户既不知道现在是不是锁着，
    // 也不知道锁定会带来哪些后果。
    assert.match(
      TAB_GROUP,
      /会话已锁定/,
      '锁定态的提示语必须点明「当前已锁定」'
    );
    assert.match(
      TAB_GROUP,
      /会话未锁定/,
      '未锁定态的提示语必须点明「当前未锁定」'
    );
    assert.match(
      TAB_GROUP,
      /清理重复标签/,
      '提示语必须说出锁定的后果（不会被清理 / 不能重命名 / 不能逐条删除）'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// U-18 · 卡片头不再用原生 title=
// ══════════════════════════════════════════════════════════════════════════

describe('U-18 · 卡片头不得再用原生 title=', () => {
  it('TabGroup 里没有原生 title 属性', () => {
    // 原生 title：≈1s 延迟、样式不可控、**触屏永远不出现**，
    // 而卡片头恰恰是新手最需要提示的地方。
    assert.doesNotMatch(
      TAB_GROUP,
      /\btitle=\{/,
      '卡片头不得再用原生 title= —— 换成套里的 <Tooltip>（300ms、触屏可出现）'
    );
    assert.doesNotMatch(
      TAB_GROUP,
      /\btitle="/,
      '卡片头不得再用原生 title= —— 换成套里的 <Tooltip>'
    );
  });

  it('卡片头的动作按钮由 <Tooltip> 包裹', () => {
    assert.match(
      TAB_GROUP,
      /<Tooltip content=/,
      '卡片头的动作按钮必须用 <Tooltip> 包裹'
    );
    // 折叠 / 两个打开 / 重命名 / 锁定 / 删除 = 6 处。
    const count = (TAB_GROUP.match(/<Tooltip/g) ?? []).length;
    assert.ok(
      count >= 6,
      `卡片头至少 6 个动作按钮都要有 Tooltip（实得 ${count} 处）`
    );
  });

  it('aria-label 一处都没丢（读屏文案不动）', () => {
    for (const label of [
      '在新窗口恢复整个会话',
      '在当前窗口打开整个会话',
      '重命名会话',
      '解锁会话',
      '锁定会话',
    ]) {
      assert.match(
        TAB_GROUP,
        new RegExp(label),
        `aria-label「${label}」必须保留 —— 换成 Tooltip 不等于可以删可访问名`
      );
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// U-21 · 看不见的东西不许能点
// ══════════════════════════════════════════════════════════════════════════

describe('U-21 · 标签行删除键：隐形时必须不可点', () => {
  it('精细指针下 .tab-item-actions 必须 pointer-events: none', () => {
    // 破了 ⇒ 用户在完全看不见的位置点到一个不可撤销的删除
    // （v1.22.0 起物理清除、无回收站、无撤销）。
    const fine = GLOBAL_CSS.match(
      /@media \(min-width: 768px\) and \(pointer: fine\) \{([\s\S]*?)\n {2}\}/
    );
    assert.ok(
      fine,
      '找不到「精细指针且 ≥768px」的媒体查询 —— 隐形可点的缺陷会回来'
    );
    const block = fine[1];
    const actionsRule = block.match(/\.tab-item-actions \{([\s\S]*?)\}/);
    assert.ok(actionsRule, '该媒体查询里必须有 .tab-item-actions 规则');
    assert.match(
      actionsRule[1],
      /pointer-events:\s*none/,
      '精细指针下不可见的操作条必须 pointer-events: none —— 看不见的东西不许能点'
    );
    assert.match(
      actionsRule[1],
      /opacity:\s*0/,
      '精细指针下不可见的操作条必须真的 opacity: 0'
    );
  });

  it('hover / focus-within 时必须恢复可点且显形', () => {
    // 键盘用户不能因此失去这个按钮：Tab 序列不受 pointer-events 影响，
    // 但 :focus-within 必须让它显形且可点，否则键盘用户对着空白按 Enter。
    const fine = GLOBAL_CSS.match(
      /@media \(min-width: 768px\) and \(pointer: fine\) \{([\s\S]*?)\n {2}\}/
    );
    assert.ok(fine);
    const block = fine[1];
    assert.match(
      block,
      /\.tab-item:hover \.tab-item-actions/,
      '鼠标悬停时必须恢复可点（否则删除键在桌面端永远点不到）'
    );
    assert.match(
      block,
      /\.tab-item:focus-within \.tab-item-actions/,
      '键盘聚焦时必须恢复可点（否则键盘用户失去这个按钮）'
    );
    assert.match(
      block,
      /pointer-events:\s*auto/,
      'hover / focus-within 必须恢复 pointer-events: auto'
    );
  });

  it('粗指针（触屏）下操作按钮始终可见且可点', () => {
    // 触屏没有 hover ⇒ 靠 :hover 显形的那条路在触屏上永远不成立。
    const coarse = GLOBAL_CSS.match(/@media \(pointer: coarse\) \{([\s\S]*?)\n {2}\}/);
    assert.ok(coarse, '找不到 @media (pointer: coarse) 分支');
    const rule = coarse[1].match(/\.tab-item-actions \{([\s\S]*?)\}/);
    assert.ok(rule, '粗指针分支里必须有 .tab-item-actions 规则');
    assert.match(
      rule[1],
      /opacity:\s*1/,
      '触屏下操作按钮必须始终可见 —— 没有 hover 就没有显形时机'
    );
    assert.match(
      rule[1],
      /pointer-events:\s*auto/,
      '触屏下操作按钮必须始终可点'
    );
  });

  it('标签行的删除键不再被 padding 压到 36px 以下（U-03）', () => {
    // `.btn-icon` 已无条件给 36×36 命中区下限；再叠 `p-1` 会把它压回
    // 22×22（低于 WCAG 2.2 SC 2.5.8 AA 的 24px），而它删掉的东西不可恢复。
    assert.doesNotMatch(
      DRAGGABLE_TAB,
      /tab-item-delete-btn[^"]*"[^"]*p-1\b/,
      '删除键不得再用 p-1 压小命中区 —— 让 .btn-icon 的 36px 规则说了算'
    );
  });
});
