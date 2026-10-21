// 覆盖上传的删除计划判据（纯函数层）——2026-10-20 P1。
//
// ── 这个文件在防什么 ─────────────────────────────────────────────────────
//
// 判据只有一条：**读不出来 ∧ 本机没有副本** ⇒ 那行云端行受保护，不删。
//
// 纯函数抽出来有两个理由：
//   1. 执行侧（utils/supabase/upload.ts）与预览侧（utils/syncPreview.ts /
//      components/sync/SyncButton.tsx）必须用**同一个**判据 ⇒ 预览预告的
//      「会保留哪几行」与实际保留的必然一致（预览与实际同源）。
//   2. 「本机有副本」的那一条判据在端到端装置里很难单独构造 ⇒ 抽出来才能
//      单独钉住（端到端那层另有 tests/overwriteUploadKeepsUnreadableCloud.test.ts）。
//
// ── 本文件钉的是**不变量**，不是字面量 ─────────────────────────────────────
//
//   1. 受保护的行一定**不在**删除清单里（两个集合不相交）；
//   2. 云端的每一行**要么**被删、**要么**受保护（没有第三种去向）；
//   3. 「本机有副本」的行永远不进入受保护集（它会被本机那份顶上去）；
//   4. 受保护集与本机清单不相交（保证 upsert 不把它变成 UPDATE ⇒ 服务端
//      BEFORE UPDATE 守卫不参与，见 core/overwriteUploadGuard.ts 文件头）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planOverwriteUpload } from '@/core/overwriteUploadGuard';

describe('覆盖上传的删除计划：受保护的行绝不进删除清单', () => {
  it('读不出来 + 本机无副本 ⇒ 受保护；两个集合不相交', () => {
    const plan = planOverwriteUpload({
      cloudIds: ['unreadable-only', 'readable-only'],
      localIds: ['local-1'],
      unrestorableIds: ['unreadable-only'],
    });

    assert.ok(
      plan.protectedIds.includes('unreadable-only'),
      '读不出来且本机无副本的行必须受保护'
    );
    assert.ok(
      !plan.deleteIds.includes('unreadable-only'),
      '受保护的行绝不能同时出现在删除清单里（删了就是永久丢失）'
    );
    assert.ok(
      plan.deleteIds.includes('readable-only'),
      '读得出来的云端独有行照常被删（覆盖语义不能被削弱）'
    );
  });

  it('云端的每一行要么被删、要么受保护（没有第三种去向）', () => {
    const cloudIds = ['a', 'b', 'c', 'd'];
    const plan = planOverwriteUpload({
      cloudIds,
      localIds: ['a'],
      unrestorableIds: ['b', 'd'],
    });

    const accounted = new Set([...plan.deleteIds, ...plan.protectedIds]);
    for (const id of cloudIds) {
      assert.ok(accounted.has(id), `云端行 ${id} 必须有明确去向（删或保留），不能被悄悄忽略`);
    }
    assert.equal(
      accounted.size,
      plan.deleteIds.length + plan.protectedIds.length,
      '删除清单与保护清单不得有交集（否则同一行既删又留）'
    );
  });

  it('「本机有副本」的行永远不进入受保护集（它会被本机那份顶上去）', () => {
    const plan = planOverwriteUpload({
      cloudIds: ['shared'],
      localIds: ['shared'],
      unrestorableIds: ['shared'],
    });

    assert.deepEqual(
      plan.protectedIds,
      [],
      '本机有副本的行不需要保护（覆盖会用本机那份替换它，那是修复不是丢失）'
    );
    assert.deepEqual(
      plan.deleteIds,
      ['shared'],
      '本机有副本的行照常删掉再由 upsert 写回（upsert 必须保持是 INSERT）'
    );
  });

  it('受保护集与本机清单不相交（否则 upsert 把它变成 UPDATE，守卫就会参与）', () => {
    const plan = planOverwriteUpload({
      cloudIds: ['x', 'y'],
      localIds: ['x'],
      unrestorableIds: ['x', 'y'],
    });

    assert.ok(
      !plan.protectedIds.includes('x'),
      '本机有的行不得受保护（那会让 upsert 变成 UPDATE，服务端守卫可能静默吞写）'
    );
  });

  it('空云端 / 空清单 ⇒ 不删任何行，也不保护任何行', () => {
    const plan = planOverwriteUpload({ cloudIds: [], localIds: ['a'], unrestorableIds: [] });
    assert.deepEqual(plan.deleteIds, []);
    assert.deepEqual(plan.protectedIds, []);
  });

  it('重复的 id 只算一次（事实清单可能重复，去向不能重复）', () => {
    const plan = planOverwriteUpload({
      cloudIds: ['dup', 'dup'],
      localIds: [],
      unrestorableIds: ['dup'],
    });
    assert.equal(plan.protectedIds.length, 1);
    assert.equal(plan.deleteIds.length, 0);
  });

  it('纯函数：同样的输入 ⇒ 同样的输出（无随机、无时钟、无 IO）', () => {
    const input = {
      cloudIds: ['a', 'b', 'c'],
      localIds: ['b'],
      unrestorableIds: ['a'],
    };
    const first = planOverwriteUpload(input);
    const second = planOverwriteUpload(input);
    assert.deepEqual(first, second);
  });
});
