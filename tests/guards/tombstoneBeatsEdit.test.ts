// DS-3（2026-10-24 审计 P0）：**云端墓碑一律压过本地活跃副本**。
//
// ── 这个守卫在防什么 ───────────────────────────────────────────────────────
//
// 两台设备的操作印记来自**各自独立**的计数器（`utils/seqRegistry.ts` 的
// Lamport 时钟只保证「本机发出的号 > 它观察到的任何号」）⇒ 一台**离线**设备上
// 的编辑，它的号与另一台设备上的删除号**没有任何因果关系** ⇒ 谁大谁小等于
// 掷硬币。
//
// 旧语义「比印记，谁大谁赢」⇒ 有半边概率：A 明确删掉的会话被 B 的离线编辑
// 悄悄撤销（而且回来的是 B 的版本，A 那份内容被顶掉）。用户看到的是「我删了」
// 与「它又回来了」，中间没有任何提示。
//
// ⇒ 现在：**云端墓碑无条件赢**。本守卫把这条规则钉在**三条真实路径**上：
//   ① 合并侧    `core/opStampMerge.ts` 的 mergeOpStamped
//   ② Supabase  `utils/supabase/upload.ts` 的 shouldConcedeGroup（上传前预检）
//   ③ WebDAV    `core/remoteAdjudication.ts` 的 shouldConcedeToRemote
//                （自带存储适配器 uploadGroups / 删除广播都在调它）
//
// ⚠️ 必须调用**真实的实现**，不能把规则在这里重写一遍再和自己比
//    （那是零检测力：实现漂移了这条守卫照样绿）。
//
// ⚠️ 必须覆盖**印记大小的两种方向**。只测「墓碑号更大」的话，一个
//    「只认严格更大的墓碑」的实现照样绿 —— 而那正是旧语义的核心。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TabGroup } from '@/types/tab';

const NOW = '2026-10-24T00:00:00.000Z';

/**
 * 墓碑号 × 本地编辑号的**全矩阵**。
 *
 * 覆盖三种关键相对关系：
 *   · 本地号更大（墓碑号 1 vs 本地号 1000）⇒ 旧语义会让本地赢（删除被撤销）
 *   · 本地号更小（墓碑号 1000 vs 本地号 1）⇒ 旧语义也让删除生效
 *   · 两边同号（靠设备号字典序决胜）⇒ 旧语义的胜负取决于设备号的首字母
 *
 * 设备号刻意取 'dev-A' / 'dev-B'：在「同号」那一格里，字典序让 dev-A 赢 ——
 * 旧语义下若墓碑在 dev-A 上，删除被撤销；若墓碑在 dev-B 上，删除生效。
 * ⇒ 同一件事两种结果，正是这个守卫要按住的地方。
 */
const TOMBSTONE_SEQS = [1, 7, 100, 1000];
const EDIT_SEQS = [1, 7, 99, 100, 101, 1000];
const DEVICE_PAIRS: Array<[string, string]> = [
  ['dev-A', 'dev-B'],
  ['dev-B', 'dev-A'],
];

function mkGroup(id: string, over: Partial<TabGroup> = {}): TabGroup {
  return {
    id,
    name: `会话 ${id}`,
    tabs: [
      { id: `${id}-t1`, url: `https://example.com/${id}`, title: '标题', createdAt: NOW, lastAccessed: NOW, pinned: false },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    ...over,
  } as TabGroup;
}

/** 全部矩阵格子（每个格子是「墓碑 vs 本地编辑」的一组输入）。 */
function* matrix(): Generator<{
  tombstoneSeq: number;
  editSeq: number;
  tombstoneDevice: string;
  editDevice: string;
}> {
  for (const tombstoneSeq of TOMBSTONE_SEQS) {
    for (const editSeq of EDIT_SEQS) {
      for (const [tombstoneDevice, editDevice] of DEVICE_PAIRS) {
        yield { tombstoneSeq, editSeq, tombstoneDevice, editDevice };
      }
    }
  }
}

describe('DS-3：云端墓碑一律压过本地活跃副本（三个真实路径）', () => {
  it('合并侧 mergeOpStamped：墓碑 vs 本地活跃 ⇒ 本地副本必须被物理移除', async () => {
    const { mergeOpStamped } = await import('@/core/opStampMerge');
    for (const cell of matrix()) {
      const local = [mkGroup('g1', { lastOp: { d: cell.editDevice, s: cell.editSeq }, name: '本地活跃' })];
      const cloud = [
        mkGroup('g1', { lastOp: { d: cell.tombstoneDevice, s: cell.tombstoneSeq }, name: '云端墓碑', isDeleted: true }),
      ];
      const out = mergeOpStamped(local, cloud);
      assert.equal(
        out.length,
        0,
        `❌ 回归：墓碑(${cell.tombstoneDevice},${cell.tombstoneSeq}) vs 本地编辑` +
          `(${cell.editDevice},${cell.editSeq}) ⇒ 本地副本必须被移除（删除不得被离线编辑撤销）`
      );
    }
  });

  it('Supabase 预检 shouldConcedeGroup：云端是墓碑 ⇒ 必须认输', async () => {
    const { shouldConcedeGroup } = await import('@/utils/supabase/upload');
    for (const cell of matrix()) {
      const local = mkGroup('g1', { lastOp: { d: cell.editDevice, s: cell.editSeq } });
      const cloud = {
        id: 'g1',
        updated_at: NOW,
        version: 3,
        last_op_device: cell.tombstoneDevice,
        last_op_seq: cell.tombstoneSeq,
        is_deleted: true,
      };
      assert.equal(
        shouldConcedeGroup(local, cloud as never),
        true,
        `❌ 回归：预检没有认输 ⇒ 本地活跃行会 upsert 上去把云端墓碑覆盖掉` +
          `（墓碑 ${cell.tombstoneDevice},${cell.tombstoneSeq} vs 编辑 ${cell.editDevice},${cell.editSeq}）`
      );
    }
  });

  it('WebDAV 预检 shouldConcedeToRemote：云端是墓碑 ⇒ 必须认输', async () => {
    const { shouldConcedeToRemote, resolveRemoteState } = await import('@/core/remoteAdjudication');
    for (const cell of matrix()) {
      const concede = shouldConcedeToRemote(
        { lastOp: { d: cell.editDevice, s: cell.editSeq } },
        resolveRemoteState({
          content: { lastOp: { d: cell.tombstoneDevice, s: cell.tombstoneSeq }, isDeleted: true },
        })
      );
      assert.equal(
        concede,
        true,
        `❌ 回归：自带存储的认输预检没有认输 ⇒ 旧内容会盖掉云端墓碑` +
          `（墓碑 ${cell.tombstoneDevice},${cell.tombstoneSeq} vs 编辑 ${cell.editDevice},${cell.editSeq}）`
      );
    }
  });

  it('两个后端的裁决必须一致（墓碑方向上不许漂移）', async () => {
    const { shouldConcedeToRemote, resolveRemoteState } = await import('@/core/remoteAdjudication');
    const { shouldConcedeGroup } = await import('@/utils/supabase/upload');
    for (const cell of matrix()) {
      const local = mkGroup('g1', { lastOp: { d: cell.editDevice, s: cell.editSeq } });
      const cloud = {
        id: 'g1',
        updated_at: NOW,
        version: 3,
        last_op_device: cell.tombstoneDevice,
        last_op_seq: cell.tombstoneSeq,
        is_deleted: true,
      };
      const supabase = shouldConcedeGroup(local, cloud as never);
      const webdav = shouldConcedeToRemote(
        { lastOp: { d: cell.editDevice, s: cell.editSeq } },
        resolveRemoteState({
          content: { lastOp: { d: cell.tombstoneDevice, s: cell.tombstoneSeq }, isDeleted: true },
        })
      );
      assert.equal(supabase, webdav, '两个后端对同一组输入必须给出同一结论');
      assert.equal(supabase, true, '墓碑方向上两边都必须认输');
    }
  });
});

describe('DS-3：规则是单向的 —— 活跃的云端行**不**能删掉本地副本', () => {
  it('云端是活跃行 ⇒ 本地活跃副本必须留下（别把规则做过头）', async () => {
    const { mergeOpStamped } = await import('@/core/opStampMerge');
    for (const cell of matrix()) {
      const local = [mkGroup('g1', { lastOp: { d: cell.editDevice, s: cell.editSeq }, name: '本地活跃' })];
      const cloud = [
        mkGroup('g1', { lastOp: { d: cell.tombstoneDevice, s: cell.tombstoneSeq }, name: '云端活跃' }),
      ];
      const out = mergeOpStamped(local, cloud);
      assert.equal(
        out.length,
        1,
        `❌ 回归：云端是活跃行时本地副本被删了（墓碑优先不等于「云端优先」）` +
          `（${cell.tombstoneDevice},${cell.tombstoneSeq} vs ${cell.editDevice},${cell.editSeq}）`
      );
    }
  });

  it('云端是活跃行 ⇒ Supabase 预检不得拦（交给服务端守卫 + 读回裁决）', async () => {
    const { shouldConcedeGroup } = await import('@/utils/supabase/upload');
    const local = mkGroup('g1', { lastOp: { d: 'dev-B', s: 10 } });
    const cloud = {
      id: 'g1',
      updated_at: NOW,
      version: 3,
      last_op_device: 'dev-A',
      last_op_seq: 20,
      is_deleted: false,
    };
    assert.equal(
      shouldConcedeGroup(local, cloud as never),
      false,
      '❌ 回归：活跃 vs 活跃也拦 ⇒ 本地编辑永远上不去'
    );
  });
});
