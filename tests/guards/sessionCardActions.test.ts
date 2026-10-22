/**
 * 会话卡片头与标签行的动作层守卫（2026-10-22 审计 U-10 / U-11 / U-15 / U-18 / U-21）。
 *
 * ── 这个文件防的具体事故 ────────────────────────────────────────────────
 *
 * U-15 卡片没有视觉身份：SafeFavicon 只出现在**标签行**，卡片级一处都没有
 *      ⇒ 行的辨识度比卡还高，层级倒挂。一屏十张「标签组 10月22日 09:12」，
 *      用户扫不出哪张是哪张。
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
// U-15 · 卡片必须有视觉身份（favicon）
// ══════════════════════════════════════════════════════════════════════════

describe('U-15 · 会话卡头必须有 favicon（层级不倒挂）', () => {
  it('卡头渲染了 SafeFavicon', () => {
    assert.match(
      TAB_GROUP,
      /<SafeFavicon/,
      '卡头必须渲染 favicon —— 标签行有、卡片没有 ⇒ 行的辨识度比卡还高'
    );
  });

  it('favicon 的 src 来自 pickDominantTab（不许硬编码某一个标签）', () => {
    // 断了 ⇒ 图标与会话名来自不同站点（「名字是 github.com、图标是 figma 的」），
    // 自相矛盾；而且换个站点就显示错的图标。
    assert.match(
      TAB_GROUP,
      /pickDominantTab\(/,
      '卡头必须调用 pickDominantTab 决定用哪个标签的 favicon'
    );
    assert.match(
      TAB_GROUP,
      /<SafeFavicon[\s\S]{0,200}?src=\{[^}]*dominantTab[^}]*\.favicon/,
      'SafeFavicon 的 src 必须取自 pickDominantTab 的结果，不能写死某个下标'
    );
  });

  it('装饰性图片：alt 必须是空串（不参与读屏朗读）', () => {
    // alt="" ⇒ 读屏跳过它。写成 alt="图标" 会让读屏在标题前念一句废话，
    // 而站点的身份本来就由标题承担。
    assert.match(
      TAB_GROUP,
      /<SafeFavicon[\s\S]{0,200}?alt=""/,
      '卡头的 favicon 是装饰性的，alt 必须为空串'
    );
  });

  it('没有 favicon 时整块不渲染（不留灰方块占位）', () => {
    // 占位方块会让人以为「这里本该有个图标但没加载出来」，
    // 而事实是「这个会话确实没有图标」—— 那是另一种撒谎。
    assert.match(
      TAB_GROUP,
      /\{dominantTab\?\.favicon\s*&&\s*\(\s*<SafeFavicon/,
      'favicon 缺失时必须整块不渲染，而不是画一个占位球'
    );
  });

  it('不得引入新的图标来源（不许绕过 pickDominantTab 抓 group.tabs[0]）', () => {
    // 取 group.tabs[0] 是「看起来对」的做法，但一个会话里第一个标签
    // 未必是主力站点 ⇒ 图标与名字对不上。
    assert.doesNotMatch(
      TAB_GROUP,
      /group\.tabs\[0\][^;]{0,80}favicon/,
      '不许直接取 group.tabs[0] 的 favicon —— 必须走 pickDominantTab'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// U-10 · 两枚「打开」图标必须在**形状**上可分
// ══════════════════════════════════════════════════════════════════════════

describe('U-10 · 两枚「打开」图标 16px 下必须能区分', () => {
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

  it('「就地打开」的图形与「新窗口」不同源（不是同一张图换个箭头朝向）', () => {
    const newWindow = pathDataOf('OpenAllIcon');
    const inPlace = pathDataOf('OpenAllInPlaceIcon');
    // 交集为空 ⇒ 两者的基础形状真的不一样（不是共用一个矩形框）。
    // 只差朝向的画法必然会有完全相同的那条矩形 path。
    const shared = inPlace.filter(d => newWindow.includes(d));
    assert.equal(
      shared.length,
      0,
      `两枚图标共用同一条 path（${shared.length} 条）⇒ 遮住颜色后仍是同一个轮廓`
    );
  });

  it('主操作（新窗口恢复）用 accent 实底，另一个保持描边', () => {
    // 「在新窗口恢复整个会话」是这个产品的「找回」入口 ⇒ 唯一高亮。
    assert.match(
      TAB_GROUP,
      /theme-cta/,
      '「在新窗口恢复整个会话」必须是 accent 实底的主操作（.theme-cta）'
    );
    assert.doesNotMatch(
      TAB_GROUP,
      /OpenAllInPlaceIcon[\s\S]{0,120}?theme-cta/,
      '「在当前窗口打开」不得也用实底 —— 两个实心按钮就没有主次了'
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
