/**
 * 提示条（Tooltip）不许被挤成「一个汉字一行」的竖条（2026-10-24）。
 *
 * ── 缺陷本体 ──────────────────────────────────────────────────────────────
 * 真机实测（Playwright + 真实扩展，修复前）：
 *
 *   顶栏「切换双栏布局」提示条：宽 **26px**、高 **118px**、文字竖排 6 行
 *
 * 根因不是配色也不是动画，是**宽度是怎么算出来的**：
 * 提示条是 `position: absolute; right: 0`（`width` 没写）⇒ 它的收缩宽度
 * 是**包含块**的宽度，而包含块是那个 `relative inline-block` 的包装层 ——
 * 也就是**触发元素本身**（顶栏图标按钮 36px）。
 * ⇒ 中文没有空格，浏览器只能在「每个字都能断」的地方断 ⇒ 一个字一行。
 *
 * 修法两条：
 *   ① `w-max`（= `width: max-content`）⇒ 按**内容**的自然宽度展开；
 *      上限仍由 `max-w-[min(20rem,calc(100vw-1.5rem))]` 管着，
 *      长句仍在上限处换行（不许撑破视口）。
 *   ② 宽度变大之后，靠左边的触发元素会把提示条**顶出视口左缘** ⇒
 *      量一次，夹回视口内（`resolveTooltipClamp`，纯函数）。
 *
 * ── 这条守卫钉的是三件事 ─────────────────────────────────────────────────
 *
 * ① **判据层**：夹回视口的算式（纯函数，可单测）。
 * ② **接线**：组件的 class 必须带 `w-max` —— 没有它就又缩回 36px。
 * ③ **接线**：组件必须真的调用判据层并把位移落到样式上。
 *
 * 真机那一环（宽度到底是不是一行、有没有出视口）由
 * `scripts/verify-tooltip-width.mjs` 负责（要真浏览器，单测替不了）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveTooltipClamp,
  TOOLTIP_VIEWPORT_MARGIN,
} from '../../src/components/common/tooltipPlacement.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');
/** 去掉注释，避免注释里的字样被当成代码判据。 */
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const TOOLTIP = code('src/components/common/Tooltip.tsx');

describe('提示条不许被挤成竖排', () => {
  it('判据：溢出左缘要往右挪回来', () => {
    const result = resolveTooltipClamp({
      tooltip: { top: 100, bottom: 140, left: -56, right: 48 },
      viewportWidth: 400,
    });
    assert.equal(result.fits, true, '宽度放得下 ⇒ 挪一下就完整可见');
    assert.equal(
      result.shift,
      TOOLTIP_VIEWPORT_MARGIN + 56,
      `必须正好挪到左缘留白处（shift=${result.shift}）`
    );
    const movedLeft = -56 + result.shift;
    assert.ok(
      movedLeft >= TOOLTIP_VIEWPORT_MARGIN,
      `挪完之后左缘必须留出空隙（left=${movedLeft}）`
    );
  });

  it('判据：溢出右缘要往左挪回来', () => {
    const result = resolveTooltipClamp({
      tooltip: { top: 100, bottom: 140, left: 340, right: 444 },
      viewportWidth: 400,
    });
    assert.equal(result.fits, true);
    assert.equal(
      result.shift,
      400 - TOOLTIP_VIEWPORT_MARGIN - 444,
      `必须正好挪到右缘留白处（shift=${result.shift}）`
    );
    assert.ok(444 + result.shift <= 400 - TOOLTIP_VIEWPORT_MARGIN, '挪完之后不得超出右缘');
  });

  it('判据：本来就放得下 ⇒ 一动不动（不许无谓挪动）', () => {
    const result = resolveTooltipClamp({
      tooltip: { top: 100, bottom: 140, left: 200, right: 304 },
      viewportWidth: 400,
    });
    assert.equal(result.shift, 0);
    assert.equal(result.fits, true);
  });

  it('判据：提示条本身就比视口还宽 ⇒ 别乱挪，如实说放不下', () => {
    const result = resolveTooltipClamp({
      tooltip: { top: 100, bottom: 140, left: -20, right: 420 },
      viewportWidth: 400,
    });
    assert.equal(result.fits, false, '放不下就该说放不下，而不是假装挪好了');
    assert.equal(result.shift, 0, '放不下时乱挪只会让它更糟');
  });

  it('接线：提示条必须按内容的自然宽度展开（w-max）', () => {
    assert.match(
      TOOLTIP,
      /tooltip absolute[^`]*\bw-max\b/,
      'Tooltip 的 class 里必须有 w-max —— 少了它，绝对定位元素就按**包含块**' +
        '（= 触发元素那个 36px 的按钮）收缩宽度 ⇒ 中文提示语被压成「一个汉字一行」'
    );
  });

  it('接线：上限仍然管着（不许撑破视口），长句仍然允许换行', () => {
    assert.match(
      TOOLTIP,
      /max-w-\[min\(20rem,calc\(100vw-1\.5rem\)\)\]/,
      '宽度上限必须留着 —— w-max 只是让它别被压扁，不许变成「想多宽就多宽」'
    );
    assert.match(
      TOOLTIP,
      /whitespace-normal/,
      '提示语必须允许换行（whitespace-nowrap 会让它在窄屏撑破视口）'
    );
  });

  it('接线：组件必须真的把「夹回视口」的位移落到样式上', () => {
    assert.match(
      TOOLTIP,
      /resolveTooltipClamp\(/,
      'Tooltip 必须调用判据层 resolveTooltipClamp —— 宽度变大之后靠左的按钮' +
        '会把提示条顶出视口，没有这一步就只是把「竖排」换成「看不见」'
    );
    assert.match(
      TOOLTIP,
      /right:\s*-horizontalShift|left:\s*horizontalShift/,
      '判据层算出来的位移必须落到样式上（right: -shift / left: shift）—— ' +
        '算了不用等于没算'
    );
  });
});
