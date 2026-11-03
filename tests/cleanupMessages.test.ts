/**
 * 「清理旧会话」的确认框与回执文案（2026-11-03）。
 *
 * ── 这个文件防的具体事故 ──────────────────────────────────────────────────
 *
 * 删除是**不可撤销**的（没有回收站），所以确认框是用户与这一步之间**唯一**的
 * 屏障。文案一旦说错，性质和「删除」本身一样严重：
 *   · 说「会保留锁定会话」而实际会删 ⇒ 用户以为安全了；
 *   · 数字与真正会删的对不上（菜单说 12、确认框说 11）⇒ 菜单在撒谎；
 *   · 回执说「其余已被移除」而实际是「被锁定跳过了」⇒ 对锁定情形是假话。
 *
 * ⇒ 这三条各有对应用例。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanupConfirmMessage,
  cleanupConfirmTitle,
  cleanupCountsFromResult,
  cleanupSuccessMessage,
} from '@/components/layout/deleteAllMessages';
import type { CleanupPlan } from '@/core/cleanupPlan';

const entry = (name: string, referenceTime = '2026-01-01T00:00:00.000Z') => ({
  name,
  referenceTime,
});

/** 一份计划（只填文案会读到的字段）。 */
const plan = (over: Record<string, unknown> = {}): CleanupPlan =>
  ({
    tier: '3m',
    ids: ['a', 'b'],
    groupCount: 2,
    tabCount: 17,
    unknownTimeCount: 0,
    lockedSkippedCount: 0,
    lockedCount: 0,
    names: ['A', 'B'],
    entries: [entry('A'), entry('B')],
    ...over,
  }) as unknown as CleanupPlan;

const disc = { isAuthenticated: false, syncBackend: 'webdav' as const };

describe('确认框：标题', () => {
  it('时间档：标题带数量，说「清理」', () => {
    assert.equal(cleanupConfirmTitle(plan()), '清理 2 个会话');
  });

  it('「保留锁定」档：标题说「删除」（那一档不看年龄）', () => {
    const keep = plan({ tier: 'all-keep-locked', lockedSkippedCount: 2 });
    assert.equal(cleanupConfirmTitle(keep), '删除 2 个会话');
  });
});

describe('确认框：正文', () => {
  it('报数量、标签页数、名字', () => {
    const m = cleanupConfirmMessage(plan(), disc);
    assert.match(m, /2 个会话/);
    assert.match(m, /17 个标签页/);
    assert.match(m, /「A」/);
  });

  it('名字超过 6 个只说「等 N 个」（列一堵墙没人读得下去）', () => {
    const many = plan({
      groupCount: 8,
      ids: [],
      names: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
      entries: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map(n => entry(n)),
    });
    const m = cleanupConfirmMessage(many, disc);
    assert.match(m, /等 8 个/);
    assert.ok(!m.includes('「G」'), '第 7 个及以后不放正文');
  });

  it('有未知时间时说明按导入时间算', () => {
    const m = cleanupConfirmMessage(plan({ unknownTimeCount: 1 }), disc);
    assert.match(m, /保存时间未知/);
    assert.match(m, /按导入时间/);
  });

  it('没有未知时间就不说这句', () => {
    assert.ok(!cleanupConfirmMessage(plan(), disc).includes('保存时间未知'));
  });

  it('有锁定跳过时说明不会被清理', () => {
    const m = cleanupConfirmMessage(plan({ lockedSkippedCount: 2 }), disc);
    assert.match(m, /2 个已锁定的会话不会被清理/);
  });

  it('永远声明不可撤销', () => {
    assert.match(cleanupConfirmMessage(plan(), disc), /没有回收站|无法撤销/);
  });

  it('有同步后端时声明跨设备删除', () => {
    assert.match(
      cleanupConfirmMessage(plan(), { isAuthenticated: true, syncBackend: 'supabase' }),
      /同步删除/
    );
  });

  it('纯本地用户（没有同步后端）不出现跨设备那句', () => {
    // isAuthenticated=false 且 syncBackend='supabase' ⇒ 没有可用后端
    const m = cleanupConfirmMessage(plan(), { isAuthenticated: false, syncBackend: 'supabase' });
    assert.ok(!m.includes('同步删除'), `纯本地用户不该被告知跨设备删除：${m}`);
  });

  // 「保留锁定」档与时间档的措辞**必须不同**（R1）：它的锁定不是「不会被清理」
  // 这种偶然结果，而是这一档的名字本身。
  it('保留锁定档：锁定说「会保留」', () => {
    const keep = plan({ tier: 'all-keep-locked', lockedSkippedCount: 2 });
    assert.match(cleanupConfirmMessage(keep, disc), /2 个已锁定的会话会保留/);
  });

  it('保留锁定档不说「保存时间未知」（这一档没有年龄筛选）', () => {
    const keep = plan({ tier: 'all-keep-locked', unknownTimeCount: 3 });
    assert.ok(!cleanupConfirmMessage(keep, disc).includes('保存时间未知'));
  });
});

describe('回执', () => {
  it('数量一致 ⇒ 空串（界面自明，不出声）', () => {
    assert.equal(
      cleanupSuccessMessage({ deletedCount: 2, confirmedCount: 2, skippedLocked: 0 }),
      ''
    );
  });

  it('被锁定跳过 ⇒ 说出真实原因，不许说「其余已被移除」', () => {
    const m = cleanupSuccessMessage({ deletedCount: 1, confirmedCount: 3, skippedLocked: 2 });
    assert.match(m, /2 个.*被锁定.*已跳过/, '锁定跳过必须说出真实原因（不许含糊）');
    assert.ok(!m.includes('已被移除'), '对锁定情形说「已被移除」是假话');
  });

  it('少删但不是锁定 ⇒ 沿用既有说法', () => {
    assert.match(
      cleanupSuccessMessage({ deletedCount: 1, confirmedCount: 3, skippedLocked: 0 }),
      /已被移除/
    );
  });

  it('一个都没删 ⇒ 说清它们在确认之前就没了', () => {
    const m = cleanupSuccessMessage({ deletedCount: 0, confirmedCount: 2, skippedLocked: 0 });
    assert.match(m, /没有会话被删除/);
  });

  it('回执不许按「总数 − 两个数」倒算（磁盘上已不存在的 id 两个数都不计）', () => {
    // 请求 5 个，磁盘上只剩 3 个 ⇒ 实际删 2 个、锁定跳过 0 个。
    // 若按「5 − 2 − 0 = 3 个未处理」倒算，就是把「本来就不在」说成「出了意外」。
    const m = cleanupSuccessMessage({ deletedCount: 2, confirmedCount: 5, skippedLocked: 0 });
    assert.ok(!/未处理|出了意外/.test(m), `不许倒算出「未处理」：${m}`);
  });
});

describe('从回执里取数', () => {
  it('读得到就照读', () => {
    assert.deepEqual(
      cleanupCountsFromResult({ value: { count: 3, skippedLocked: 1 } }),
      { deletedCount: 3, skippedLocked: 1 }
    );
  });

  it('形状不对 ⇒ 一律按 0（不许猜）', () => {
    assert.deepEqual(cleanupCountsFromResult(undefined), { deletedCount: 0, skippedLocked: 0 });
    assert.deepEqual(cleanupCountsFromResult({}), { deletedCount: 0, skippedLocked: 0 });
    assert.deepEqual(
      cleanupCountsFromResult({ value: { count: '3', skippedLocked: null } }),
      { deletedCount: 0, skippedLocked: 0 }
    );
  });
});
