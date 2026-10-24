// 顶栏的「视觉预算」必须给「找回」，不给低频按钮（2026-10-22 审计 U-20）。
//
// ── 2026-10-24：判据已改成 v1.25.1 的口径 ─────────────────────────────────
//
// 2026-10-24 产品负责人要求「界面与交互回到 v1.25.1 的样子」⇒ 本守卫原先钉的
// 那条设计约定（低频入口**不许**回顶栏）**不再成立**。
// **退掉它的是产品决定，不是偷懒。**
//
// 退掉的是哪条：原 ①② 断言「顶栏不得再出现布局切换 / 清理重复这两颗按钮」，
// 原 ④ 断言「菜单里的这两个入口不许被 `sm:hidden` 藏起来」。
// 这三条钉的都是**长相**（按钮在不在顶栏、菜单项在什么宽度出现），
// 而 v1.25.1 的顶栏恰恰**有**那两颗图标按钮（空框 / 垃圾桶），
// 菜单里的同名入口也恰恰是 `sm:hidden` 的**窄屏补偿**。
//
// 留下来的不变式（**一条都不许退**）：
//   · 这两个入口在**顶栏**有（sm 以上可见）—— v1.25.1 的排布；
//   · 这两个入口在**菜单**里也有（窄屏补偿）—— 功能一条不许少，
//     窄屏顶栏上是没有这两颗按钮的（`hidden sm:block`）；
//   · 窄屏补偿必须是 `sm:hidden`（窄屏看得见），不许写成 `hidden sm:block`
//     （那会让这两个入口在窄屏**消失** = 「窄屏少个功能」的老毛病）。
//
// 换句话说：本文件钉的是「**任何宽度下这两个动作都摸得到，且顶栏的长相
// 与 v1.25.1 一致**」，而不是「它们不许在顶栏」。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

/** 去掉注释，避免注释里的字样把断言喂饱。 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const HEADER = stripComments(read('src/components/layout/Header.tsx'));
const DROPDOWN = stripComments(read('src/components/layout/HeaderDropdown.tsx'));

/**
 * 某个元素**直接所在**的 <div> 的 className。
 *
 * 怎么找：从元素位置往上回溯，取**最近的一个开标签**；中途不许出现闭合标签
 * （出现了就说明中间隔着别的容器，那不是「直接所在」）。
 * ⇒ 钉的是「按钮被包在哪个容器里」，不是「文件里某处出现过某个类名」。
 */
function containerClassBefore(src: string, at: number): string {
  const region = src.slice(0, at);
  const open = region.lastIndexOf('<div className="');
  const close = region.lastIndexOf('</div>');
  assert.ok(open > close, '找不到该元素直接所在的 <div> 容器');
  // 开标签是 `<div className="`（16 个字符），内容从第 17 个字符开始。
  const end = region.indexOf('"', open + 16);
  assert.ok(end > open, '找不到该 <div> 的 className 结束引号');
  return region.slice(open + 16, end);
}

describe('顶栏动作预算：低频入口在顶栏（v1.25.1 的排布），且不许在任何宽度消失', () => {
  it('①「切换布局」在顶栏有图标按钮（sm 以上可见）', () => {
    const at = HEADER.indexOf('onClick={handleToggleLayout}');
    assert.ok(at > -1, '顶栏必须有「切换布局」按钮 —— v1.25.1 的顶栏就是四颗图标按钮');
    assert.match(
      HEADER,
      /切换为双栏布局|切换为单栏布局/,
      '顶栏的布局切换按钮必须有无障碍名（读屏要能念出它做什么）'
    );
    assert.equal(
      containerClassBefore(HEADER, at),
      'hidden sm:block',
      '顶栏这两颗按钮只在 sm 以上出现（窄屏由 ⋯ 菜单提供）'
    );
  });

  it('②「清理重复标签」在顶栏有图标按钮（sm 以上可见）', () => {
    const at = HEADER.indexOf('onClick={handleCleanDuplicateTabs}');
    assert.ok(at > -1, '顶栏必须有「清理重复标签」按钮 —— v1.25.1 的顶栏就是四颗图标按钮');
    assert.match(
      HEADER,
      /aria-label="清理重复标签页"/,
      '顶栏的清理按钮必须有无障碍名'
    );
    assert.equal(
      containerClassBefore(HEADER, at),
      'hidden sm:block',
      '顶栏这两颗按钮只在 sm 以上出现（窄屏由 ⋯ 菜单提供）'
    );
  });

  it('③ 菜单必须始终提供这两个入口（挪位置不等于丢功能）', () => {
    assert.match(
      DROPDOWN,
      /onToggleLayout\?\.\(\)/,
      '菜单里必须有「切换布局」入口，且真的调用了回调'
    );
    assert.match(
      DROPDOWN,
      /onRequestCleanDuplicates\?\.\(\)/,
      '菜单里必须有「清理重复标签」入口，且真的调用了回调'
    );
  });

  it('④ 菜单里的这两个入口是**窄屏补偿**：窄屏看得见，宽屏不与顶栏重复', () => {
    // 这条钉的是「窄屏少个功能」这个老毛病的反面：
    // 补偿入口必须 `sm:hidden`（窄屏可见），**不许** `hidden sm:block`
    // （那正是当年让这两个入口在窄屏凭空消失的写法）。
    for (const anchor of ['切换为双栏布局', '清理重复标签']) {
      const at = DROPDOWN.indexOf(anchor);
      assert.ok(at > -1, `菜单里必须能找到「${anchor}」入口`);
      assert.equal(
        containerClassBefore(DROPDOWN, at),
        'sm:hidden',
        `「${anchor}」是窄屏补偿：sm 以下可见（sm 以上顶栏已经有那颗按钮了）`
      );
    }
  });
});
