// 「本设备打不开」这一行的长相与无障碍名必须按 URL 现算（2026-10-18）。
//
// 【本文件要防的回归类别】`tab.unopenable` 是纯函数 isOpenableTabUrl 的**缓存**，
// 而全仓只有云端读取路径（tabDataCodec.deserializeTab）会给它盖章：本地保存的
// file: / blob: / view-source: 标签（保存门放行、打开门拒收）与 WebDAV 还原的标签
// 都不带这个字段。于是同一个本机 PDF 标签会出现两种长相：
//   · 本地路径 → 列表页长得完全正常，aria 还宣称「打开标签页: …」，点下去被拒开；
//   · 云端路径 → 灰掉 + 划掉标题 + aria 说「此标签在当前设备无法打开」。
// 同一个标签换个后端就换一种长相，且其中一种在撒谎（声明必须等于行为）。
// 修法是渲染侧按 URL 现算——同一份真值，三条读取路径必然一致。
//
// 为什么用源码断言：组件是 .tsx（node:test 只做类型剥离、不转译 JSX），
// 本仓对组件类不变式一律读源码断言（themeToggleVisibleEffect / lockedTabDeleteGuard 同惯例）。
// 行为面由真机 dist 探针把关（/tmp/one-tab-loop/verify-round17.mjs）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 去注释后的源码：注释里会引用旧写法与标记名，不能参与断言。 */
function code(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 会渲染标签行的两个界面：会话列表页、搜索结果页。 */
const RENDERERS = ['src/components/dnd/DraggableTab.tsx', 'src/components/search/SearchResultList.tsx'];

describe('打不开的标签：渲染侧按 URL 现算', () => {
  for (const rel of RENDERERS) {
    const src = code(rel);

    it(`${rel} 不再读 unopenable 标记（它只有云端读取路径会盖章）`, () => {
      assert.ok(
        !/tab\.unopenable/.test(src),
        '渲染侧要按 isOpenableTabUrl(tab.url) 现算——标记是缓存，本地保存与 WebDAV 还原都不盖章'
      );
      assert.match(
        src,
        /const isUnopenable = !isOpenableTabUrl\(tab\.url\);/,
        '每条读取路径都走同一个纯函数，才不会「换个后端换一种长相」'
      );
    });

    it(`${rel} 的降级样式由现算值驱动`, () => {
      assert.match(
        src,
        /\$\{isUnopenable \? ' ?tab-item-unopenable' : ''\}/,
        '灰掉 + 划掉标题必须挂在现算值上，否则本地保存的 file: 标签看起来能点开'
      );
    });
  }

  // 「标签」/「标签页」两种量词都接受 —— 这条守卫管的是**降级分支存在且由现算值驱动**，
  // 不是管它用哪个量词（量词统一由 P2-7 那条守卫管；把量词钉死在这里，两条守卫会互相打架）。
  it('列表页 aria 只在现算「打不开」时才不说「打开标签页」', () => {
    const src = code('src/components/dnd/DraggableTab.tsx');
    assert.match(
      src,
      /isUnopenable\s*\?\s*`\$\{tabTitle\}（此标签页?在当前设备无法打开，仍保留在会话中）/,
      'aria 的降级分支必须由现算值决定，而不是由没盖章的标记决定'
    );
    assert.match(
      src,
      /: `打开标签页: \$\{tabTitle\}/,
      '能打开时仍要宣称可打开（这句是给读屏用户的操作提示，不能顺手删掉）'
    );
  });

  it('搜索页的每一行也标出「打不开」（此前列表页标、搜索页不标）', () => {
    const src = code('src/components/search/SearchResultList.tsx');
    assert.match(
      src,
      /aria-label=\{isUnopenable \? `\$\{tab\.title\}（此标签页?在当前设备无法打开，仍保留在会话中）` : undefined\}/,
      '点下去才弹错太晚——读屏用户点之前就该知道这一行打不开'
    );
  });

  it('云端读取路径的标记与本文件现算值同源（判据未分叉）', () => {
    const src = code('src/core/tabDataCodec.ts');
    assert.match(
      src,
      /unopenable: isOpenableTabUrl\(url\) \? undefined : true/,
      '标记与渲染必须用同一个判据；若这里换了判据，两处结论会开始分叉'
    );
  });
});
