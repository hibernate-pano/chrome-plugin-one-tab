import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { monthsBefore, planCleanup } from '@/core/cleanupPlan';

const g = (over: Record<string, unknown>) => ({
  id: 'x', name: '会话', tabs: [], createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z', isLocked: false, ...over,
}) as any;

describe('monthsBefore：日历月钳制', () => {
  it('3 月 31 日的一个月前是 2 月 28 日（不是 3 月 3 日）', () => {
    assert.equal(
      monthsBefore(new Date('2026-03-31T12:00:00'), 1).toISOString().slice(0, 10),
      '2026-02-28',
    );
  });
  it('闰年 3 月 31 日的一个月前是 2 月 29 日', () => {
    assert.equal(
      monthsBefore(new Date('2024-03-31T12:00:00'), 1).toISOString().slice(0, 10),
      '2024-02-29',
    );
  });
  it('跨年：1 月 15 日的三个月前是上一年的 10 月 15 日', () => {
    assert.equal(
      monthsBefore(new Date('2026-01-15T12:00:00'), 3).toISOString().slice(0, 10),
      '2025-10-15',
    );
  });
});

describe('planCleanup：时间档', () => {
  const now = new Date('2026-10-26T00:00:00.000Z');
  it('按 createdAt 选旧的，新的不选', () => {
    const plan = planCleanup([
      g({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
      g({ id: 'new', createdAt: '2026-10-01T00:00:00.000Z' }),
    ], '3m', now);
    assert.deepEqual(plan.ids, ['old']);
  });
  it('保存时间未知的按 importedAt 计入', () => {
    const plan = planCleanup([
      g({ id: 'imp', createdAt: '2026-10-20T00:00:00.000Z', importedAt: '2025-01-01T00:00:00.000Z' }),
    ], '3m', now);
    assert.deepEqual(plan.ids, ['imp']);
    assert.equal(plan.unknownTimeCount, 1);
  });
  it('导入得晚、createdAt 旧的未知时间件不算（不能只看 createdAt）', () => {
    const plan = planCleanup([
      g({ id: 'imp2', createdAt: '2020-01-01T00:00:00.000Z', importedAt: '2026-10-25T00:00:00.000Z' }),
    ], '3m', now);
    assert.deepEqual(plan.ids, []);
  });
  it('锁定的跳过并计数，不进 ids', () => {
    const plan = planCleanup([
      g({ id: 'lock', createdAt: '2026-01-01T00:00:00.000Z', isLocked: true }),
      g({ id: 'free', createdAt: '2026-01-01T00:00:00.000Z' }),
    ], '3m', now);
    assert.deepEqual(plan.ids, ['free']);
    assert.equal(plan.lockedSkippedCount, 1);
  });
  it('tabCount 是标签页总数，names 按最新在前', () => {
    const plan = planCleanup([
      g({ id: 'a', name: 'A', createdAt: '2026-01-01T00:00:00.000Z', tabs: [{}, {}] }),
      g({ id: 'b', name: 'B', createdAt: '2026-03-01T00:00:00.000Z', tabs: [{}] }),
    ], '3m', now);
    assert.equal(plan.tabCount, 3);
    assert.deepEqual(plan.names, ['B', 'A']);
  });
});

describe('planCleanup：全部两档', () => {
  const now = new Date('2026-10-26T00:00:00.000Z');
  const groups = [
    g({ id: 'lock', createdAt: '2026-10-01T00:00:00.000Z', isLocked: true }),
    g({ id: 'free', createdAt: '2026-10-01T00:00:00.000Z' }),
  ];
  it('保留锁定：只选未锁定', () => {
    assert.deepEqual(planCleanup(groups, 'all-keep-locked', now).ids, ['free']);
  });
  it('含锁定：全选', () => {
    assert.deepEqual(planCleanup(groups, 'all', now).ids, ['lock', 'free']);
  });
  it('全部两档不看时间', () => {
    const fresh = [g({ id: 'today', createdAt: '2026-10-25T00:00:00.000Z' })];
    assert.deepEqual(planCleanup(fresh, 'all-keep-locked', now).ids, ['today']);
  });
});
