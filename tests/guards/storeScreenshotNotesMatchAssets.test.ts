// 商店页的「Screenshot Notes」必须与**实际有的图**一致（2026-10-20 L-18 收尾）。
//
// ── 这个文件要防的具体事故 ────────────────────────────────────────────────
//
// 那一栏此前写的是：
//
//   「建议截图内容：1) 双列布局下有多个已保存会话的主界面；2) 搜索过滤效果；
//     3) 行内重命名编辑态。」
//
// 而实际资产是：
//
//   ① screenshot-1-main.png    —— **单栏**布局（脚本不设 layoutMode，用默认值）
//   ② screenshot-2-search.png  —— 搜索命中态，**没有**展开筛选面板
//   ③ 行内重命名编辑态          —— **根本没有这张图**
//
// ⇒ 那一栏与资产对不上。审核员按它去找「双列布局」找不到（那是**建议**，不是承诺），
// 而**真正存在**的「单栏主界面」反而没被描述。
//
// ── 根因 ──────────────────────────────────────────────────────────────────
//
// 那一栏写的是**愿望**（「建议拍什么」），而商店页的其余部分写的都是**事实**
// （「已发布的是 1.22.12」「线上隐私政策是这个 URL」）。
// ⇒ 愿望会漂（没人保证会去拍），事实不会。
// ⇒ 修法：**只写实际有的**。
//
// ── 这个文件守什么 ────────────────────────────────────────────────────────
//
// ① Screenshot Notes 里提到的**每一张图**都必须真实存在（文件名可解析）。
// ② 资产表里标着「✅ Ready」的**每一张图**都必须在 Screenshot Notes 里被提到
//    （否则就是「有图但没描述」—— 审核员不知道该看什么）。
// ③ 不得出现「建议 / 待拍 / 计划中」这类**愿望式**措辞。
//    【为什么这条重要】愿望式措辞是漂移的源头：它让这一栏同时承担
//    「事实」与「待办」两种职责，而待办永远不会变成事实。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const STORE = read('CHROMEWEBSTORE.md');

/** 「Screenshot Notes」那一栏的正文。 */
const notes = (): string => {
  const section = STORE.split('### Screenshot Notes')[1];
  assert.ok(section, '商店文档里找不到「### Screenshot Notes」—— 判据锚点丢了');
  // 到下一个二级标题为止
  return section.split('\n## ')[0].split('\n### ')[0];
};

/** 资产表里标着「✅ Ready」的文件名。 */
const readyAssets = (): string[] => {
  const table = STORE.split('## Graphics & Assets')[1]?.split('\n## ')[0] ?? '';
  const names: string[] = [];
  for (const row of table.split('\n')) {
    if (!row.trimStart().startsWith('|') || !row.includes('✅')) continue;
    for (const m of row.matchAll(/store-assets\/([A-Za-z0-9._-]+\.(?:png|jpg|jpeg|svg|webp))/g)) {
      names.push(m[1]);
    }
  }
  return names;
};

/**
 * 资产表里标着「✅ Ready」的**截图**文件名。
 *
 * 【为什么不包括宣传图与图标】资产表里还有 `promo-tile-440x280.png`
 * （Small Promo Tile）与 `icons/icon128.png`（Store Icon）——
 * 它们**不是截图**，不需要在「Screenshot Notes」里逐个描述
 * （那一栏讲的是「这几张截图分别展示什么」）。
 * ⇒ 只认文件名以 `screenshot-` 开头的。
 */
const readyScreenshots = (): string[] =>
  readyAssets().filter(name => /^screenshot-/i.test(name));

describe('Screenshot Notes ① 提到的图必须真的存在', () => {
  it('Notes 里提到的每个图都存在', () => {
    /**
     * 【为什么同时认「带路径」与「裸文件名」】Notes 里写「screenshot-1-main.png」
     * 是更自然的写法（读者看得到文件名就够了），而资产表里写的是完整路径。
     * ⇒ 两种都认。
     */
    const text = notes();
    const mentioned = [
      ...new Set(
        [...text.matchAll(/(?:store-assets\/)?(screenshot-[A-Za-z0-9._-]+\.(?:png|jpg|jpeg|webp))/g)].map(m => m[1])
      ),
    ];
    assert.ok(
      mentioned.length > 0,
      'Screenshot Notes 里一个截图名都没提 —— 判据锚点丢了（这一栏必须写出实际有什么图）'
    );
    for (const name of mentioned) {
      assert.ok(
        existsSync(resolve(ROOT, 'store-assets', name)),
        `Screenshot Notes 提到了 ${name}，但这个文件不存在`
      );
    }
  });
});

describe('Screenshot Notes ② 有图就必须被提到', () => {
  it('资产表里标着 ✅ Ready 的截图都在 Notes 里被提到', () => {
    const text = notes();
    for (const name of readyScreenshots()) {
      const mentioned = text.includes(name) || text.includes(name.replace(/\.[a-z]+$/, ''));
      assert.ok(
        mentioned,
        `资产表里有 ${name}，但 Screenshot Notes 里没提到它 —— ` +
          '「有图但没描述」意味着审核员不知道该看什么。'
      );
    }
  });
});

describe('Screenshot Notes ③ 不得写愿望，只写事实', () => {
  it('可见正文里不得出现「建议 / 待拍 / 计划 / 稍后」这类措辞', () => {
    /**
     * 【为什么只扫可见正文】这一栏里的 HTML 注释是**给自己看的历史说明**
     * （例如「曾经这一栏写的是『建议截图内容：…』」）——
     * 那是**记录**，不是承诺，扫它会判假红。
     * 而**审核员能看到的**是可见正文 —— 那里才不许有愿望式措辞。
     *
     * ⇒ 判据：先剥掉 HTML 注释，再扫。
     */
    const visible = notes().replace(/<!--[\s\S]*?-->/g, '');
    const wishful = [
      '建议截图',
      '建议拍',
      '待拍',
      '计划中',
      '稍后补',
      '未来补',
      'TODO',
    ];
    const hits = wishful.filter(w => visible.includes(w));
    assert.deepEqual(
      hits,
      [],
      `Screenshot Notes 的可见正文里出现了愿望式措辞：${hits.join('、')}—— ` +
        '这一栏若同时写「事实」与「待办」，待办就永远不会变成事实，' +
        '而审核员是按这一栏去核对资产的。'
    );
  });

  it('可见正文不得为空（这一栏整段被注释包着 ⇒ 审核员看到的是空白）', () => {
    /**
     * 【为什么这条独立】**这一栏有内容**与**审核员看得到这一栏**是两件事。
     * 整段被 HTML 注释包着时，仓库里看得到、商店页渲染出来是**空的**。
     */
    const visible = notes().replace(/<!--[\s\S]*?-->/g, '').trim();
    assert.ok(
      visible.length > 0,
      'Screenshot Notes 的可见正文是空的 —— 整段被 HTML 注释包住了？' +
        '审核员在商店页上看到的是**空白**，而仓库里以为「已经写好了」。'
    );
  });
});
