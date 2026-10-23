/**
 * 变异自证：「覆盖下载的预览必须与实际落盘结果一致」这条守卫必须真的看得见破口。
 *
 * ── 为什么必须自证 ────────────────────────────────────────────────────────
 * 这条守卫横跨**三个**可以恒绿的缝：
 *   ① 预览的「保住」逻辑 —— 改它（改对或改坏）都不会让任何**类型**报错；
 *   ② 引擎的「保住」逻辑 —— 同一份判据的**另一半**；
 *   ③ 组件的**接线** —— 装配路径有没有真的把跳过清单传进预览。
 * 而更要紧的是：这条守卫如果只会「红」而不会「绿」，就会把正确的改写也判成
 * 回归（⇒ 逼着实现不敢改）⇒ 所以必须同时证明**等价改写仍然绿**。
 *
 * ⇒ 六个方向：
 *   ① **把预览的「保住」拆掉** ⇒ 必须变红（预览开始多报删除）；
 *   ② **把判据本身拆掉**（保住集恒为空）⇒ 必须变红（真引擎开始物理删除）；
 *   ③ **把接线拆掉**（装配路径不传跳过清单）⇒ 必须变红（预览看不见「没读到」）；
 *   ④ **等价的正确改写** ⇒ 必须**仍然绿**（证明它判的是行为，不是长相）；
 *   ⑤ **把「不去重」引回来**（两份清单直接拼接）⇒ 必须变红（同一个 id 被数两遍）；
 *   ⑥ **把「空壳清理」从预览里去掉** ⇒ 必须变红（说不会删，实际真删了）。
 *
 * ⚠️ ③ 特别重要：这一条曾经**零检测力** —— 守卫当时只对着组件的**源码长相**
 * 断言（「这段代码里出现了 skippedRemoteIds」），把清单换成空数组时源码长相
 * 一点没变 ⇒ 守卫照样绿。数据装配搬进 services/syncPreviewLoader.ts 之后，
 * 守卫改成**真的调用**它 ⇒ 这条变异才第一次被抓住。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/overwriteDownloadPreviewMatchesActual.test.ts';

/** 断言消息里的关键片段（守卫改了措辞时，这里要一起改）。 */
const PREVIEW_COUNT_MISMATCH = '预览说的「会删几个」必须等于实际删掉的个数';
const ACTUAL_KEPT_MISSING = '前提：云端读不出来的那组本机那份必须还在';

describe('变异自证：覆盖下载的预览必须与实际一致（这条守卫必须看得见破口）', () => {
  it('变异一：把预览的「保住」拆掉 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '预览不再把「云端读不出来」的那几份算成保住',
        testFile: GUARD,
        targets: [
          {
            path: 'src/utils/syncPreview.ts',
            mutate: source => {
              const anchor = '  const preserved = preservedLocalGroups(activeLocalGroups, skippedIds);';
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到预览里那行「保住」');
              }
              // 变异：保住集恒为空 ⇒ 预览把「不会发生的删除」说成会发生。
              return source.replace(
                anchor,
                '  const preserved = [] as typeof activeLocalGroups;',
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: PREVIEW_COUNT_MISMATCH,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把预览的「保住」拆掉（预览于是多报删除）',
    );
  });

  it('变异二：把判据本身拆掉（保住集恒为空）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '「覆盖下载保住哪几份」的判据恒返回空集',
        testFile: GUARD,
        targets: [
          {
            path: 'src/core/overwriteDownloadPreserve.ts',
            mutate: source => {
              const anchor =
                '  return localGroups.filter(group => !group.isDeleted && skippedIds.has(group.id));';
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到判据那一行');
              }
              // 变异：判据失效 ⇒ 真引擎开始物理删除「云端只是没读到」的那几份。
              return source.replace(anchor, '  return [];');
            },
          },
        ],
        expectRed: true,
        expectedFailure: ACTUAL_KEPT_MISSING,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把「覆盖下载保住哪几份」的判据拆掉（真引擎于是物理删除本机那份）',
    );
  });

  it('变异三：把接线拆掉（装配路径不把跳过清单传进预览）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '下载预览拿不到跳过清单',
        testFile: GUARD,
        targets: [
          {
            path: 'src/services/syncPreviewLoader.ts',
            mutate: source => {
              const anchor =
                "    overwrite: buildDownloadPreviewSummary(localGroups, remote.groups, 'overwrite', {\n      skippedRemoteIds: remote.skippedIds,\n    }),";
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到装配路径里那行「跳过清单」');
              }
              // 变异：清单被换成空数组 ⇒ 预览看不见「云端这轮没读到」这件事。
              return source.replace(
                anchor,
                "    overwrite: buildDownloadPreviewSummary(localGroups, remote.groups, 'overwrite', {\n      skippedRemoteIds: [],\n    }),",
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: PREVIEW_COUNT_MISMATCH,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把接线拆掉（装配路径不把跳过清单传进预览 ⇒ 预览算不出保住数）',
    );
  });

  it('变异四：等价的正确改写（判据换一种写法）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '「保住」判据的等价改写',
        testFile: GUARD,
        targets: [
          {
            path: 'src/core/overwriteDownloadPreserve.ts',
            mutate: source => {
              const anchor =
                '  return localGroups.filter(group => !group.isDeleted && skippedIds.has(group.id));';
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到判据那一行');
              }
              // 等价改写：行为一模一样，只是不用 filter 的复合谓词。
              return source.replace(
                anchor,
                '  return localGroups.filter(group => skippedIds.has(group.id) && !group.isDeleted);',
              );
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      false,
      '把「保住」判据换成等价的正确写法（谓词换序）',
    );
  });

  it('变异五：把「不去重」引回来（两份清单直接拼接）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '预览把「读到的」与「保住的」直接拼接（同一个 id 被数两遍）',
        testFile: GUARD,
        targets: [
          {
            path: 'src/utils/syncPreview.ts',
            mutate: source => {
              const anchor = '  const merged = mergeOpStamped(mergeInputLocal, remoteGroups);';
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到预览里那行「合并」');
              }
              // 变异：不去重 ⇒ 同一个 id（既在读到的、又���读不出来的清单里）
              // 被数两遍 ⇒ 预览说「还剩 2 个」，引擎实际落盘 1 个。
              return source.replace(
                anchor,
                '  const merged = [...mergeInputLocal, ...remoteGroups];',
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '同一个 id 不能被数两遍',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把预览的合并换回「直接拼接」（同一个 id 被数两遍）',
    );
  });

  it('变异六：把「空壳清理」从预览里去掉 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '预览不建模空壳清理（说不会删，实际真删了）',
        testFile: GUARD,
        targets: [
          {
            path: 'src/utils/syncPreview.ts',
            mutate: source => {
              const anchor = '  const shellDropped = dropSyncMergedGroups(merged);';
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到预览里那行「空壳清理」');
              }
              // 变异：空壳不再被剔掉 ⇒ 预览把「引擎会删掉的那一组」算成保留
              // ⇒ **方向相反的谎话**（说不会删，实际真删了）。
              return source.replace(anchor, '  const shellDropped = merged;');
            },
          },
        ],
        expectRed: true,
        expectedFailure: '预览必须报「会删 1 个会话」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把预览的「空壳清理」去掉（预览于是说不会删，实际真删了）',
    );
  });
});
