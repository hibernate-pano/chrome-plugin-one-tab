// 回归：同步合并不得留下空会话卡（无墓碑模型下的空组统一规则）。
//
// 历史 bug（Jasper 报「切双栏多出空标签组、越攒越多」）：旧模型里 URL 去重给
// 败者盖标签级墓碑却从不处理组，被剥空的组以 isDeleted:false 落盘渲染成空卡。
//
// 无墓碑模型（2026-09-29）：合并是组级 LWW 整组覆盖，不存在"被剥空"的中间态；
// 但空组规则仍然兜底——合并结果落盘前由 dropSyncMergedGroups 剔除空组（**锁定豁免**），
// 被剔除的组由 syncEngine 登记删除广播队列（云端行标 is_deleted，防对端复活）。
//
// ── 2026-10-10 语义修订：同步合并路径的「锁定豁免」从注释变成了实现 ────────
// 下面「锁定但零标签的组」那条用例的期望值在本次被**翻转**了，理由写在该用例名
// 与注释里（2026-10-10 缺陷 2）。一句话版本：同步合并路径剔除的组会被登记成
// **跨设备云端删除**，而锁定是用户「别自动清掉我」的显式意图 ⇒ 锁定的空组被剔除
// 等于把锁定翻译成「所有设备上永久删除」（无回收站）。
//
// 这里直测判据与合并结果的衔接（不拉起整个 syncEngine，避免网络与登录态依赖），
// 端到端那一轮（真 syncEngine 落盘 + 删除广播登记）在 tests/lockedEmptyGroupSync.test.ts。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

const NOW = '2026-09-28T10:00:00.000Z';

let dropEmptyGroups: typeof import('../src/core/mutationOps.ts').dropEmptyGroups;
let dropSyncMergedGroups: typeof import('../src/core/mutationOps.ts').dropSyncMergedGroups;
let isEmptyGroup: typeof import('../src/core/mutationOps.ts').isEmptyGroup;
let mergeOpStamped: typeof import('../src/core/opStampMerge.ts').mergeOpStamped;

function tab(id: string, url: string, extra: Record<string, unknown> = {}) {
  return { id, url, title: id, createdAt: NOW, lastAccessed: NOW, pinned: false, ...extra };
}

function group(id: string, tabs: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id, name: `g-${id}`, tabs,
    createdAt: NOW, updatedAt: NOW, isLocked: false, version: 1, ...extra,
  } as any;
}

before(async () => {
  register(LOADER_PATH, import.meta.url);
  ({ dropEmptyGroups, dropSyncMergedGroups, isEmptyGroup } = await import('../src/core/mutationOps.ts'));
  ({ mergeOpStamped } = await import('../src/core/opStampMerge.ts'));
});

describe('同步合并 · 空会话卡不留', () => {
  it('组级 LWW 下云端整组赢时，空 tabs 的云端组被判为空组（兜底剔除的对象）', () => {
    // 老版本设备可能上传 tabs:[] 的组；新模型下它作为 LWW 赢家整组到达，
    // 必须被空组判据识别（无内容可保留）
    const local = [group('g1', [tab('t1', 'https://a.com')], { lastOp: { d: 'devA', s: 1 } })];
    const cloud = [group('g1', [], { lastOp: { d: 'devB', s: 50 } })];

    const merged = mergeOpStamped(local, cloud);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].tabs.length, 0, '云端整组赢 → 本地整组被覆盖');
    assert.equal(isEmptyGroup(merged[0]), true, '空组判据命中，落盘前必须剔除');
  });

  it('合并结果落盘前剔除空组：UI 侧永远拿不到空会话卡', () => {
    const merged = [
      group('empty', [], { lastOp: { d: 'devB', s: 50 } }),
      group('ok', [tab('t3', 'https://b.com')], { lastOp: { d: 'devB', s: 51 } }),
    ];
    const final = dropEmptyGroups(merged);

    assert.deepEqual(final.map(g => g.id), ['ok'], '空组不进落盘结果');
  });

  it('有内容的组与有内容的锁定组一律保留（不得误伤）', () => {
    const groups = [
      group('ok', [tab('t1', 'https://a.com')]),
      group('locked-full', [tab('t2', 'https://b.com')], { isLocked: true }),
    ];
    const final = dropEmptyGroups(groups);

    assert.deepEqual(final.map(g => g.id), ['ok', 'locked-full'], '锁定但有内容的组豁免自动清理');
  });

  it('【期望值 2026-10-10 已翻转】dropEmptyGroups（纯本地清理）仍清掉锁定空壳', () => {
    // ⚠️ 这条断言的**对象换了**，所以期望值不再是「被清掉」——细节见下一条。
    // 保留它是因为 dropEmptyGroups 本身没变：导入路径与本地视图清理仍在用它，
    // 且那些路径不碰云端，误删最坏只丢一份刚被 sanitizeUrl 剔空的本地空壳。
    const groups = [
      group('ok', [tab('t1', 'https://a.com')]),
      group('locked-empty', [], { isLocked: true }),
    ];
    const final = dropEmptyGroups(groups);

    assert.deepEqual(final.map(g => g.id), ['ok'], '纯本地清理路径：无保护判据照旧清掉零标签组');
  });

  it('【2026-10-10 缺陷 2 · 期望值翻转】同步合并路径必须保留锁定空壳（原期望是清掉）', () => {
    // ── 为什么翻转这条期望（重要：不是「改测试让代码过」）──────────────────
    //
    // 旧用例原文：「锁定但零标签的组按空壳清掉（2026-09-30 语义修订）」。
    // 它是 2026-09-30 一次真实故障（两条逐字相同的锁定空组躺了 7 个月、双栏撞
    // React 重复 key）的修复留下的期望，**当时是对的**：那条路径是纯本地的 UI
    // 视图过滤（toActiveGroupsView），清掉一个零标签组最坏只是让列表少一张空卡。
    //
    // 但它被**复用**到了同步合并落盘路径（syncEngine 的 dropEmptyGroups），而那条
    // 路径的语义完全不同：剔除的 id 会进 pendingDeleteIds → 云端行打 is_deleted
    // 墓碑 → **所有设备上永久消失**（v1.22.0 起无回收站）。于是：
    //   用户锁定一个会话 → 删掉它最后一个标签（applyRemoveTab 锁定豁免，本地
    //   留下「0 标签 + isLocked=true」的合法状态）→ **下一次后台同步（≤60s）**
    //   把它剔除并广播云端墓碑 → 该会话在所有设备上被永久删除，用户毫不知情。
    // 把「锁定」翻译成「跨设备永久删除」，与用户按下锁定键时的意图正好相反。
    //
    // 两条语义必须分开（这也是修法为什么是新增 dropSyncMergedGroups 而不是改
    // isEmptyGroup —— 改了会连带改变导入时的空壳合并行为）：
    //   · 自动清理路径（导入、toActiveGroupsView 视图过滤）= isEmptyGroup，不看锁定
    //   · 同步合并落盘路径（本条）= 锁定豁免
    //   · 用户当场动作（applyRemoveTab / applyMoveTab / applyCleanDuplicates）
    //     = shouldAutoDeleteAfterTabRemoval，一直就是锁定豁免
    //
    // 2026-10-10：用户拍板「锁定跨同步周期有效」。
    const groups = [
      group('ok', [tab('t1', 'https://a.com')]),
      group('locked-empty', [], { isLocked: true }),
      group('unlocked-empty', []),
    ];
    const final = dropSyncMergedGroups(groups);

    assert.deepEqual(
      final.map(g => g.id),
      ['ok', 'locked-empty'],
      '同步合并落盘路径：未锁定的空壳照旧剔除；锁定但零标签的组必须留下 —— ' +
        '它不是垃圾，是用户「留着、等着再填」的合法状态。剔除它会被登记成云端删除广播，' +
        '在所有设备上永久消失（无回收站），且用户毫不知情。'
    );
    assert.ok(
      dropEmptyGroups(groups).map(g => g.id).includes('locked-empty') === false,
      '对照：纯本地清理路径（导入 / 视图过滤）仍用无保护判据清掉它 —— 两条语义不许合并'
    );
  });

  it('纯函数：输入不被就地修改', () => {
    const groups = [group('dup', [])];
    const snapshot = JSON.stringify(groups);

    dropEmptyGroups(groups);

    assert.equal(JSON.stringify(groups), snapshot);
  });
});
