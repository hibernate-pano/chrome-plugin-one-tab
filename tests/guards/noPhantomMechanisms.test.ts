// 注释与单测**不得给一个不存在的机制背书**（2026-10-22 架构审计 D1 / D2）。
//
// ── 这个文件要防的回归类别 ────────────────────────────────────────────────
//
// 「**说了一个不存在的机制**」—— 代码里其实没有，但注释写着「有」，
// 单测也测了它对应的纯函数。于是：
//   · 读代码的人以为机制已生效（照着它做设计 / 评审 / 排期）；
//   · 守卫全绿，掩盖了「其实没有」这件事；
//   · 最坏的情况：一条**注释里的承诺**被当成产品事实写进商店文案或对外文档。
//
// 两个真实例子：
//   D1  搜索结果「分片渲染」：`searchWindowing.ts` 的 `computeVisibleChunks` /
//        `chunkResults` / `SEARCH_CHUNK_SIZE` **零生产调用点**，而
//        `SearchResultList.tsx` 的注释写着「两道防线」、`searchWindowing.test.ts`
//        有 8 个用例在测它们 ⇒ 读代码的人以为「搜索路径已做渲染上限」，
//        而 200 条截断只管住**标签条数**、管不住**卡头数**。
//   D2  命中区判据 `hitTarget.ts` 的 `meetsHitTarget()`：生产代码一次都没调用过
//        （唯一的**代码**引用在测试里），而它的文件头把 36px 论证得像生产规范
//        ⇒ 新人以为「改一个常量就能改全站尺寸」，改了却零生产变化。
//
// ── 判据 ─────────────────────────────────────────────────────────────────
//
// 对每个「已设计但可能没接线」的导出，二选一：
//   ① 它在**生产代码**里被引用（src/ 下、且不是它自己的定义文件）；或
//   ② 它的定义文件**明说**「还没接线 / 生产不调用」。
// 两条都不满足 ⇒ 有人在给一个不存在的机制背书 ⇒ 红。
//
// ⚠️ 这条判据**故意不钉具体措辞**：它认的是「有没有说清楚」，
// 不是「说了哪句话」—— 否则改一次文案就得改一次守卫。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** 递归列出 src/ 下的源码文件（相对仓库根的路径）。 */
const listSourceFiles = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      listSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
};

const SOURCE_FILES = listSourceFiles(resolve(ROOT, 'src'));

/**
 * 去注释后的源码。
 *
 * 必须去注释再找符号：**注释里提到一个符号不等于生产在用它** ——
 * 而本文件要防的恰恰是「注释里提到它、于是读代码的人以为它存在」。
 * 去掉注释后，「SearchResultList 的注释里写了 computeVisibleChunks」不再算引用。
 */
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 除定义文件自身外，生产代码里是否**在代码里**引用了这个符号。 */
const referencedInProduction = (symbol: string, definingFile: string): boolean =>
  SOURCE_FILES.some(file => {
    const rel = file.slice(ROOT.length + 1);
    if (rel === definingFile) return false;
    return new RegExp(`\\b${symbol}\\b`).test(stripComments(readFileSync(file, 'utf8')));
  });

/**
 * 定义文件是否**明说**「还没接线 / 生产不调用」。
 *
 * 认的是「有没有这句话」，不认「是哪句话」：
 * 关键词覆盖「未接线 / 还没接线 / 没有接线 / 生产不调用 / 零生产调用点 /
 * 仅供测试 / 尚未接入」这几种自然说法。
 */
const declaresNotWired = (definingFile: string): boolean =>
  /未接线|还没接线|没有接线|尚未接线|生产不调用|零调用点|零生产调用点|仅供测试|尚未接入|没有生产调用点/.test(
    read(definingFile),
  );

interface UnwiredCandidate {
  /** 定义文件（相对仓库根）。 */
  file: string;
  /** 导出符号。 */
  symbol: string;
  /** 为什么它「看起来像个机制」。 */
  why: string;
}

const CANDIDATES: UnwiredCandidate[] = [
  {
    file: 'src/components/search/searchWindowing.ts',
    symbol: 'computeVisibleChunks',
    why: '搜索结果的「分片渲染」判据 —— 注释曾声称搜索路径有「两道防线」',
  },
  {
    file: 'src/components/search/searchWindowing.ts',
    symbol: 'chunkResults',
    why: '同上：把结果列表切片的函数',
  },
  {
    file: 'src/components/search/searchWindowing.ts',
    symbol: 'SEARCH_CHUNK_SIZE',
    why: '同上：分片大小常量',
  },
  {
    file: 'src/components/layout/hitTarget.ts',
    symbol: 'meetsHitTarget',
    why: '命中区判据 —— 文件头把 36px 论证得像生产在用的规范',
  },
];

describe('已设计但可能没接线的机制：要么真的接线，要么明说没接线', () => {
  for (const candidate of CANDIDATES) {
    it(`${candidate.symbol}：${candidate.why}`, () => {
      const wired = referencedInProduction(candidate.symbol, candidate.file);
      if (wired) return; // 真接线了 ⇒ 无所谓
      assert.ok(
        declaresNotWired(candidate.file),
        `${candidate.symbol} 在生产代码里零调用点，而 ${candidate.file} 没有明说「未接线」—— ` +
          '注释与单测正在给一个不存在的机制背书'
      );
    });
  }
});

describe('（规则自测）判据本身不能是空转的', () => {
  it('认得「已接线」的样子：一个被生产引用的符号必须被判为已接线', () => {
    // 用一个确定被生产引用的符号做对照，确保 referencedInProduction 不是永远 false
    //（否则上面几条会「因为 declaresNotWired 为真」而恒绿，判据退化）。
    assert.ok(
      referencedInProduction('buildResultWindow', 'src/components/search/searchWindowing.ts'),
      'buildResultWindow 确实在生产里被引用 —— 判据能认出「已接线」'
    );
  });

  it('认得「没接线」的样子：一个只在测试里出现的符号必须被判为未接线', () => {
    assert.ok(
      !referencedInProduction('computeVisibleChunks', 'src/components/search/searchWindowing.ts'),
      'computeVisibleChunks 确实没有生产调用点'
    );
  });
});
