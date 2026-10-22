/**
 * 顶栏几何缺陷的回归守卫（2026-10-20）。
 *
 * 这一批修的全是**实测出来的布局几何缺陷**：
 *
 *   G1 品牌名「TapStack」被裁成「TapSta」（半个字，无任何提示）
 *   G2 顶栏提示条压住搜索框（400px 下 34.4%、700px 下 17.5%）
 *   G3 「删除所有会话」被菜单底边裁掉 13px（在可视区外）
 *   G4 顶栏同步按钮命中区只有 32×28px
 *   G5 窄屏保存文案与宽屏漂移（「保存并关标签」vs「保存并关闭」）
 *
 * 判据纪律：
 *   · **能变红的才算数** —— 每个断言都钉住一条不变量，不是钉字面量。
 *   · 几何判定尽量做成**纯函数**（brandLayout / tooltipPlacement /
 *     dropdownLayout / hitTarget），直接喂真机量到的数字测；
 *   · DOM 测不了的部分（CSS、TSX）断言**不变量**：
 *     「阈值必须等于那个常量」「必须按视口剩余空间算，不能按 vh 算」
 *     「命中区必须 ≥36px」「窄屏文案不得比宽屏文案长」。
 *
 * 真机基线（Playwright + 真实扩展，2026-10-20）见下面的 MEASURED。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BRAND_ICON_ONLY_MAX_VIEWPORT_WIDTH,
  isBrandContentClipped,
} from '../../src/components/layout/brandLayout.ts';
import {
  resolveTooltipAvoid,
  boxesOverlap,
} from '../../src/components/common/tooltipPlacement.ts';
import { remainingViewportHeight } from '../../src/components/layout/dropdownLayout.ts';
import {
  MIN_HIT_TARGET_PX,
  parseTailwindMinSize,
  meetsHitTarget,
} from '../../src/components/layout/hitTarget.ts';
import {
  saveAndCloseLabel,
  saveAndCloseShortLabel,
} from '../../src/components/layout/saveActionCopy.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');
/** 去掉注释，避免注释里的字样被当成代码判据。 */
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const GLOBAL_CSS = code('src/styles/global.css');
const HEADER = code('src/components/layout/Header.tsx');
const TOOLTIP = code('src/components/common/Tooltip.tsx');
const DROPDOWN = code('src/components/layout/HeaderDropdown.tsx');
const SYNC_BUTTON = code('src/components/sync/SyncButton.tsx');

/**
 * 真机基线（Playwright + 真实扩展，2026-10-20）。
 * 改动这些数字 = 布局又变了，必须重新量一遍。
 */
const MEASURED = {
  /** 400px 视口下，12 个会话 ⇒ 必然出现 8px 滚动条 gutter */
  narrowViewport: 400,
  narrowClientWidth: 392,
  /** 品牌盒实际拿到 79.6px，而「图标 + 文字」需要 87.8px */
  narrowBrandBox: 79.6,
  brandNeeded: 87.8,
  brandGap: 8,
  actionsWidth: 280,
  headerPadding: 24,
  /** 各平台滚动条 gutter 的宽度上限（Windows 15–17px，取 19 留余量） */
  widestGutter: 19,
  /** 顶栏提示条 / 搜索框的实测矩形（x, y, w, h） */
  saveTipAt400: { x: 207.6, y: 56, w: 134.4, h: 118 },
  searchAt400: { x: 12, y: 54, w: 368, h: 34 },
  saveTipAt700: { x: 506.7, y: 58, w: 121.3, h: 138 },
  searchAt700: { x: 90, y: 56, w: 512, h: 34 },
  saveTipAt1280: { x: 1026.7, y: 58, w: 121.3, h: 138 },
  searchAt1280: { x: 319.3, y: 13, w: 423.1, h: 34 },
  /** 400×600 下菜单的实测几何 */
  menuTop: 54,
  menuContentHeight: 442,
  /** 窄屏按钮里可用宽度 78.4px（6 个汉字）⇒ 约 13.07px/字 */
  narrowButtonTextBudget: 78.4,
  charWidth: 78.4 / 6,
} as const;

const toBox = (r: { x: number; y: number; w: number; h: number }) => ({
  top: r.y,
  bottom: r.y + r.h,
  left: r.x,
  right: r.x + r.w,
});

// ══════════════════════════════════════════════════════════════════════════
// G1：品牌名要么完整可见，要么完全消失
// ══════════════════════════════════════════════════════════════════════════
describe('G1 品牌名不许被「半个字」地裁掉', () => {
  it('降级阈值必须覆盖「图标+文字+操作区+内边距+gutter」的物理下限', () => {
    // 400px 视口下「图标+文字+操作区+内边距」就已经是 399.8px，
    // 再扣掉最宽平台的滚动条 gutter（19px）就放不下了。
    const budget =
      MEASURED.brandNeeded +
      MEASURED.brandGap +
      MEASURED.actionsWidth +
      MEASURED.headerPadding +
      MEASURED.widestGutter;
    assert.ok(
      BRAND_ICON_ONLY_MAX_VIEWPORT_WIDTH >= budget,
      `降级阈值 ${BRAND_ICON_ONLY_MAX_VIEWPORT_WIDTH} 必须 ≥ 实测物理下限 ${budget.toFixed(1)}` +
        `（否则某个平台/某个宽度上又会把「TapStack」切成「TapSta」）`
    );
  });

  it('降级阈值必须是实测出来的那个值（CSS 与常量必须一致）', () => {
    const blocks = [
      ...GLOBAL_CSS.matchAll(/@media\s*\(max-width:\s*(\d+)px\)\s*\{([\s\S]*?)\n\}/g),
    ];
    const brandBlocks = blocks.filter(([, , body]) => /app-header-brand-name/.test(body));
    assert.equal(
      brandBlocks.length,
      1,
      `必须有且只有一处「品牌名只留图标」的媒体查询（实际 ${brandBlocks.length} 处）`
    );
    assert.equal(
      Number(brandBlocks[0][1]),
      BRAND_ICON_ONLY_MAX_VIEWPORT_WIDTH,
      'CSS 里的降级阈值必须等于 brandLayout.ts 的常量 —— 两处各写各的，迟早漂'
    );
  });

  it('判据能抓住实测的那一刀，也不会误报「刚好放下」', () => {
    // 400px 实测：文字墨迹右边界 99.8px，品牌盒右边界 91.6px ⇒ 被裁 8.2px
    assert.equal(isBrandContentClipped(99.8, 91.6), true, '裁了 8.2px 必须判为裁切');
    // 无滚动条时：墨迹 99.8px = 盒子右边界 99.8px ⇒ 刚好放下，不算裁
    assert.equal(isBrandContentClipped(99.8, 99.8), false, '刚好放下不得判成裁切');
    // 亚像素噪声（±0.4px）不算裁
    assert.equal(isBrandContentClipped(100, 99.6), false, '亚像素误差不得误报');
    // 量不出来的时候（NaN / Infinity）不许瞎判
    assert.equal(isBrandContentClipped(Number.NaN, 100), false);
    assert.equal(isBrandContentClipped(100, Number.POSITIVE_INFINITY), false);
  });

  it('运行期兜底：被裁时把名字整体隐藏，而不是截断成半个词', () => {
    assert.match(
      HEADER,
      /isBrandContentClipped/,
      'Header 必须用同一个判据做运行期兜底（只靠媒体查询，覆盖不到平台差异）'
    );
    assert.match(
      HEADER,
      /nameClassName=\{[^}]*invisible/,
      '被裁时品牌名必须整体隐藏（visibility: hidden）'
    );
    assert.doesNotMatch(
      HEADER,
      /app-header-brand-name[^\n]*truncate/,
      '不得用省略号截断品牌名（截断仍是半个词）'
    );
  });

  it('滚动条必须恒定占位，否则整条顶栏会随列表长度横向抖', () => {
    // 实测：列表长 → clientWidth 392 / 列表短 → clientWidth 400，
    // 顶栏（品牌盒、操作区、搜索框）整体挪 8px。
    //
    // 注意：这里要的是「**恒定占位**」这个结果，不是某一条具体写法。
    // 本仓把 ::-webkit-scrollbar 定制成了占位型滚动条（6px），实测下
    // `html { scrollbar-gutter: stable }` 在 Chrome 里不生效（根元素的
    // gutter 不会作用到视口），真正生效的是让根元素自己成为滚动容器。
    // 所以判据写成「html 上必须有让滚动条恒定占位的声明」。
    const htmlBlock = GLOBAL_CSS.match(/\n\s*html\s*\{([\s\S]*?)\n\s*\}/);
    assert.ok(htmlBlock, '找不到 html 的基础样式块');
    assert.match(
      htmlBlock[1],
      /overflow-y:\s*scroll|scrollbar-gutter:\s*stable/,
      '根元素必须让滚动条恒定占位，否则列表一变长整条顶栏就横移 8px'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// G2：顶栏提示条不得压住搜索框
// ══════════════════════════════════════════════════════════════════════════
describe('G2 顶栏提示条不得压住搜索框', () => {
  it('400px 实测几何：避让后重叠面积必须为 0', () => {
    const result = resolveTooltipAvoid({
      side: 'bottom',
      tooltip: toBox(MEASURED.saveTipAt400),
      avoid: [toBox(MEASURED.searchAt400)],
      viewportHeight: 600,
    });
    assert.equal(result.cleared, true, '必须完全避开搜索框');
    const moved = toBox(MEASURED.saveTipAt400);
    moved.top += result.offset;
    moved.bottom += result.offset;
    assert.equal(
      boxesOverlap(moved, toBox(MEASURED.searchAt400)),
      false,
      `避让后仍与搜索框相交（offset=${result.offset}）`
    );
    assert.ok(
      moved.bottom <= 600,
      `提示条不能被推出视口（下沿 ${moved.bottom} > 600）`
    );
  });

  it('700px 实测几何（两行顶栏）：同样必须完全避开', () => {
    const result = resolveTooltipAvoid({
      side: 'bottom',
      tooltip: toBox(MEASURED.saveTipAt700),
      avoid: [toBox(MEASURED.searchAt700)],
      viewportHeight: 800,
    });
    assert.equal(result.cleared, true);
    const moved = toBox(MEASURED.saveTipAt700);
    moved.top += result.offset;
    moved.bottom += result.offset;
    assert.equal(boxesOverlap(moved, toBox(MEASURED.searchAt700)), false);
  });

  it('1280px 单行顶栏：本来就不相交，必须保持原位（不许无谓挪动）', () => {
    const result = resolveTooltipAvoid({
      side: 'bottom',
      tooltip: toBox(MEASURED.saveTipAt1280),
      avoid: [toBox(MEASURED.searchAt1280)],
      viewportHeight: 800,
    });
    assert.equal(result.offset, 0, '没有重叠就不该动');
    assert.equal(result.cleared, true);
  });

  it('没有要避让的元素 ⇒ 位移必须是 0', () => {
    const result = resolveTooltipAvoid({
      side: 'bottom',
      tooltip: toBox(MEASURED.saveTipAt400),
      avoid: [],
      viewportHeight: 600,
    });
    assert.equal(result.offset, 0);
    assert.equal(result.cleared, true);
  });

  it('往下挪会掉出视口时：必须退让到「留在视口内」，并如实报告没避干净', () => {
    // 要避让的元素比提示条还长、一直伸到提示条下沿之外 ⇒ 往下挪多少都避不开
    const result = resolveTooltipAvoid({
      side: 'bottom',
      tooltip: { top: 500, bottom: 560, left: 0, right: 100 },
      avoid: [{ top: 500, bottom: 590, left: 0, right: 100 }],
      viewportHeight: 600,
    });
    assert.equal(result.cleared, false, '放不下就该说没避干净，而不是假装避开了');
    assert.ok(
      result.offset >= 0 && result.offset <= 40,
      `位移必须把提示条留在视口内（offset=${result.offset}）`
    );
  });

  it('机制接线：提示条要认 data-tooltip-avoid，搜索框要标上它', () => {
    assert.match(
      TOOLTIP,
      /data-tooltip-avoid/,
      'Tooltip 必须按 data-tooltip-avoid 找要避让的元素'
    );
    assert.match(
      HEADER,
      /className="app-header-search"[^>]*data-tooltip-avoid|data-tooltip-avoid[^>]*className="app-header-search"/,
      '顶栏搜索框必须标 data-tooltip-avoid，否则提示条压的就是它'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// G3：菜单高度上限按视口剩余空间算
// ══════════════════════════════════════════════════════════════════════════
describe('G3「删除所有会话」不许被裁在可视区外', () => {
  it('400×600 实测：菜单必须拿得到容下整份菜单的高度', () => {
    const maxHeight = remainingViewportHeight({
      viewportHeight: 600,
      menuTop: MEASURED.menuTop,
    });
    assert.ok(
      maxHeight >= MEASURED.menuContentHeight,
      `菜单上限 ${maxHeight}px 必须 ≥ 菜单内容高度 ${MEASURED.menuContentHeight}px` +
        '（否则「删除所有会话」会被裁在可视区外）'
    );
  });

  it('上限必须跟着「菜单顶边到视口底边」走，而不是跟着视口比例走', () => {
    assert.doesNotMatch(
      DROPDOWN,
      /max-h-\[70vh\]/,
      '70vh 与菜单顶边无关：600px 视口下 70vh=420px，菜单底边 474 < 删除项底边 487'
    );
    assert.match(
      DROPDOWN,
      /remainingViewportHeight/,
      '菜单高度上限必须由视口剩余空间算出来'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// G4：命中区 ≥36×36
// ══════════════════════════════════════════════════════════════════════════
describe('G4 顶栏按钮命中区必须够大', () => {
  it('判据能识别 Tailwind 的最小尺寸类', () => {
    assert.deepEqual(parseTailwindMinSize('min-w-9 min-h-9'), {
      minWidthPx: 36,
      minHeightPx: 36,
    });
    assert.deepEqual(parseTailwindMinSize('min-w-8 min-h-8'), {
      minWidthPx: 32,
      minHeightPx: 32,
    });
    assert.deepEqual(parseTailwindMinSize('min-w-[36px] min-h-[36px]'), {
      minWidthPx: 36,
      minHeightPx: 36,
    });
    // 只有 padding 的（缺陷形态）：没有任何最小尺寸约束
    assert.deepEqual(parseTailwindMinSize('flex items-center whitespace-nowrap px-2 py-1.5'), {
      minWidthPx: 0,
      minHeightPx: 0,
    });
  });

  it('36px 是本项目采用的下限（AA 的 24px 之上、AAA 的 44px 之下）', () => {
    assert.equal(MIN_HIT_TARGET_PX, 36);
    assert.ok(MIN_HIT_TARGET_PX >= 24, '至少要满足 WCAG 2.2 SC 2.5.8 (AA) 的 24px');
    assert.equal(
      meetsHitTarget('min-w-9 min-h-9'),
      true,
      'min-w-9 min-h-9 = 2.25rem = 36px，达到下限'
    );
    assert.equal(
      meetsHitTarget('px-2 py-1.5'),
      false,
      '缺陷形态（只有 padding）不算达标'
    );
    assert.equal(meetsHitTarget('min-w-9 min-h-8'), false, '高度不够就不算达标');
  });

  it('两颗同步按钮都必须带上达标的最小尺寸', () => {
    // 【锚点】按 **aria-label** 找按钮，不按类名字符串找。
    // 原来的锚点是 `rounded-md text-sm flat-interaction` —— 那是**会被
    // 主题改造换掉**的类名片段：2026-10-22 审计 U-14 把这两颗按钮的
    // 圆角从写死的 rounded-md 改成读 --radius-btn 的 theme-radius-btn，
    // 判据本身没问题，锚点却过时了 ⇒ 守卫报「实际 0 颗按钮」而红。
    // 判据钉的是「这两颗按钮的命中区够大」，所以只该钉**稳定**的锚点：
    // 无障碍名（aria-label）是给读屏软件看的，不会因为换主题而变。
    const SYNC_BUTTON_LABELS = ['上传本地会话到云端', '从云端下载会话到本地'];
    const buttonClassNames = SYNC_BUTTON_LABELS.map(label => {
      const at = SYNC_BUTTON.indexOf(`aria-label="${label}"`);
      assert.ok(at !== -1, `SyncButton 里找不到 aria-label="${label}" 的按钮`);
      // 往前找这个按钮自己的 <button 开头，再往后取它的 className。
      const open = SYNC_BUTTON.lastIndexOf('<button', at);
      assert.ok(open !== -1, `找不到 aria-label="${label}" 所属的 <button 标签`);
      const segment = SYNC_BUTTON.slice(open, at);
      const m = /className=\{`([^`]+)`\}/.exec(segment);
      assert.ok(m, `找不到 aria-label="${label}" 对应按钮的 className`);
      return m[1];
    });
    assert.equal(
      buttonClassNames.length,
      2,
      `应当正好是上传 / 下载两颗同步按钮（实际 ${buttonClassNames.length}）`
    );
    for (const cls of buttonClassNames) {
      assert.ok(
        meetsHitTarget(cls),
        `同步按钮的命中区不得小于 ${MIN_HIT_TARGET_PX}px：${cls}`
      );
    }
  });

  it('顶栏 .btn-icon 的 CSS 下限不得低于同一个数', () => {
    const rule = GLOBAL_CSS.match(/\.btn-icon\s*\{[^}]*min-width:\s*([\d.]+)rem[^}]*\}/);
    assert.ok(rule, '找不到 .btn-icon 的最小尺寸规则');
    const px = parseFloat(rule[1]) * 16;
    assert.ok(
      px >= MIN_HIT_TARGET_PX,
      `.btn-icon 的 min-width 是 ${px}px，不得低于 ${MIN_HIT_TARGET_PX}px`
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// G5：窄屏保存文案不得与宽屏漂移
// ══════════════════════════════════════════════════════════════════════════
describe('G5 窄屏保存文案不得漂移', () => {
  it('窄屏文案必须是「短版本」，不能是另一句话', () => {
    assert.ok(
      saveAndCloseShortLabel.length <= saveAndCloseLabel.length,
      `窄屏文案「${saveAndCloseShortLabel}」不得比宽屏文案「${saveAndCloseLabel}」更长 —— ` +
        '那说明它不是同一个动作的另一种写法'
    );
    assert.match(saveAndCloseShortLabel, /关/, '关闭的披露不能被截掉');
    assert.match(saveAndCloseShortLabel, /标签|关闭/, '必须说清关的是标签');
  });

  it('窄屏文案必须是宽屏文案的前缀：同一个动作只能有两种长短，不能是两种说法', () => {
    // 缺陷形态：宽屏「保存并关闭」/ 窄屏「保存并关标签」——
    // 窄屏那句话是宽屏那句话的前缀吗？不是 ⇒ 两个断点在说两件事。
    assert.ok(
      saveAndCloseLabel.startsWith(saveAndCloseShortLabel),
      `窄屏文案「${saveAndCloseShortLabel}」必须是宽屏文案「${saveAndCloseLabel}」的前缀 —— ` +
        '否则两个断点上的按钮在说两件不同的事'
    );
  });

  it('窄屏文案必须放得进窄屏按钮（实测可用宽度 78.4px）', () => {
    const width = saveAndCloseShortLabel.length * MEASURED.charWidth;
    assert.ok(
      width <= MEASURED.narrowButtonTextBudget,
      `窄屏文案「${saveAndCloseShortLabel}」约 ${width.toFixed(1)}px，` +
        `放不进 ${MEASURED.narrowButtonTextBudget}px 的按钮`
    );
  });
});
