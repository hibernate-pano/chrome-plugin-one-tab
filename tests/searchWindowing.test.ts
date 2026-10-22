// 搜索结果必须有渲染上限 —— 2026-10-20 审计 A-11 的行为级回归。
//
// 真实缺陷（主审用 `scripts/prod-stress.mjs` 在真机上测出来的，不是推测）：
//
//   400 会话 × 20 标签 = 8000 个标签，搜一个宽泛词（如 "https"）⇒
//   · 搜索响应 **1250ms**
//   · 搜索态 DOM 节点 **91311**
//   · 滚动最大帧间隔 **88ms（≈11fps）**
//
//   而「找回会话」是本产品的核心动作，搜索是最高频路径。
//   主列表早有虚拟化（lazyTabRows + useNearViewport），搜索这条路完全没有。
//
// 修复方式是**截断 + 说清**：命中很多时只渲染最靠前的部分
// （AdvancedSearch 已按相关度排好序 ⇒ 截断是排序的兑现，不是信息损失），
// 并且**必须告诉用户还有多少条没显示** —— 不说的话，用户会以为
// 「只找到这么多条」（与 2026-10-19 审计 F-5「重复导入被误报成备份坏了」同类）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SEARCH_CHUNK_SIZE,
  SEARCH_RESULT_DISPLAY_LIMIT,
  buildResultWindow,
  chunkResults,
  computeVisibleChunks,
  resultTruncationMessage,
} from '../src/components/search/searchWindowing.ts';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

// ─────────────────────────────────────────────────────────────────────────
// 1. 截断决策
// ─────────────────────────────────────────────────────────────────────────

describe('搜索结果上限：数量必须有界', () => {
  it('少量结果时不截断', () => {
    const w = buildResultWindow(10);
    assert.equal(w.visible, 10);
    assert.equal(w.hidden, 0);
    assert.equal(w.truncated, false);
  });

  it('超量时截断到上限，hidden 记差额', () => {
    const w = buildResultWindow(5000, 200);
    assert.equal(w.visible, 200);
    assert.equal(w.hidden, 4800);
    assert.equal(w.truncated, true);
  });

  it('恰好等于上限时不算截断（没有「还有 0 条」这种废话提示）', () => {
    const w = buildResultWindow(200, 200);
    assert.equal(w.hidden, 0);
    assert.equal(w.truncated, false);
  });

  it('上限必须是正数（0 会让界面空掉）', () => {
    const w = buildResultWindow(100, 0);
    assert.equal(w.visible, 0);
    assert.equal(w.hidden, 100);
    // 上限为 0 仍然是「有界」的，不许因为上限非法就放行全部
    assert.equal(w.truncated, true);
  });

  it('默认上限有界且不夸张（200 条 ≈ 一屏多，DOM 节点数有界）', () => {
    assert.ok(SEARCH_RESULT_DISPLAY_LIMIT > 0);
    assert.ok(SEARCH_RESULT_DISPLAY_LIMIT <= 500, '上限过大会让 DOM 重新失控');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 截断提示文案：必须说清「还有多少」与「下一步」
// ─────────────────────────────────────────────────────────────────────────

describe('截断提示：不说等于骗用户', () => {
  it('文案必须给出未显示的条数', () => {
    const msg = resultTruncationMessage(4800);
    assert.match(msg, /4800/, '必须说出还有多少条没显示');
  });

  it('文案必须说清是按相关度截断的（否则用户以为是漏了）', () => {
    const msg = resultTruncationMessage(100);
    assert.match(msg, /相关度/, '要说明显示的是最靠前的部分');
  });

  it('文案必须给出下一步动作', () => {
    const msg = resultTruncationMessage(100);
    assert.match(msg, /关键词|筛选/, '要告诉用户怎么缩小范围');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 分片渲染
// ─────────────────────────────────────────────────────────────────────────

describe('分片渲染：只渲染视口附近的片', () => {
  it('片数按总数与片大小算出', () => {
    const chunks = chunkResults([1, 2, 3, 4, 5, 6, 7, 8, 9], 4);
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].items.length, 4);
    assert.equal(chunks[2].items.length, 1);
    assert.equal(chunks[1].startIndex, 4);
  });

  it('分片不丢数据（拼起来等于原数组）', () => {
    const src = Array.from({ length: 37 }, (_, i) => i);
    const flat = chunkResults(src, 8).flatMap(c => c.items);
    assert.deepEqual(flat, src);
  });

  it('视口在中间时只渲染附近的片，不渲染全部', () => {
    const visible = computeVisibleChunks(1000, 50, SEARCH_CHUNK_SIZE, 1);
    assert.ok(visible.length < 10, `只应渲染少数几片，实际 ${visible.length}`);
    assert.ok(visible.includes(50), '必须包含当前片');
  });

  it('首尾边界不越界', () => {
    assert.deepEqual(computeVisibleChunks(10, 0, 4, 1), [0, 1]);
    const last = computeVisibleChunks(10, 9, 4, 1);
    assert.ok(last.every(i => i >= 0 && i < 3));
  });

  it('空结果不渲染任何片', () => {
    assert.deepEqual(computeVisibleChunks(0, 0, 8, 1), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. 接线：搜索结果真的走了截断
// ─────────────────────────────────────────────────────────────────────────

describe('搜索结果真的接上了截断', () => {
  it('渲染的是截断后的结果，不是全量', () => {
    const src = read('src/components/search/SearchResultList.tsx');
    assert.match(src, /visibleSessionResults\.map\(/, '渲染循环必须用截断后的列表');
    assert.doesNotMatch(
      src,
      /\{sessionResults\.map\(/,
      '不能还留着全量渲染（那正是 91311 个 DOM 节点的来源）'
    );
  });

  it('批量操作作用于**全部**匹配标签，不是只显示的那部分', () => {
    const src = read('src/components/search/SearchResultList.tsx');
    // 「恢复所有匹配标签页」「删除所有搜索到的标签页」必须覆盖全部匹配 ——
    // 按钮文案说的是「共 N 个标签页」，N 取自 matchingTabs（全部）。
    // 若改成只作用于可见部分，就会出现「按钮说 500 个、实际只处理 200 个」。
    assert.match(src, /const tabsPayload = matchingTabs\.map\(/, '批量恢复必须用全部匹配标签');
    // 2026-10-23 审计 P0-2：批量恢复的「哪些会被消费」改由判据层给出
    // （`planBatchRestore(matchingTabs)`）⇒ 断言也钉在那份判据上：
    // 它必须**覆盖全部匹配**（而不是可见的那部分）。
    assert.match(
      src,
      /planBatchRestore\(matchingTabs\)/,
      '批量恢复的判据必须覆盖全部匹配标签'
    );
  });

  it('截断时必须渲染提示条', () => {
    const src = read('src/components/search/SearchResultList.tsx');
    assert.match(src, /resultWindow\.truncated/, '必须按截断状态显示提示');
    assert.match(src, /resultTruncationMessage\(/, '提示文案必须来自共享文案函数');
  });

  it('徽章显示的是标签数而不是会话数', () => {
    const src = read('src/components/search/SearchResultList.tsx');
    // 搜 "React" 命中 1 个会话里的 2 个标签 ⇒ 徽章要显示 2（标签数），
    // 显示 1（会话数）会让用户以为只有 1 条结果。
    //
    // 断言必须落在**徽章的文本内容**上，不能笼统地搜「文件里有没有
    // matchingTabs.length」—— 那个字符串同时出现在 title 属性里，
    // 徽章改回会话数时断言依然会绿（第一版就是这么漏掉的）。
    const badgeSpan = src.match(
      /<span\s+className="tab-group-count flex-shrink-0"[\s\S]*?<\/span>/
    );
    assert.ok(badgeSpan, '必须能找到徽章 span');
    // 去掉 title 属性后再看剩下的 —— 那才是徽章显示给用户的内容
    const badgeText = badgeSpan[0].replace(/title=\{[^}]*\}/, '');
    assert.match(
      badgeText,
      /\{matchingTabs\.length\}/,
      '徽章的显示内容必须是匹配标签数'
    );
    assert.doesNotMatch(
      badgeText,
      /\{sessionResults\.length\}/,
      '徽章不能显示会话数（会让用户以为只有 1 条结果）'
    );
  });
});
