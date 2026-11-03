import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLEANUP_TIER_LABELS,
  cleanupTierLabel,
  monthsBefore,
  planCleanup,
} from '@/core/cleanupPlan';

const g = (over: Record<string, unknown>) => ({
  id: 'x', name: '会话', tabs: [], createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z', isLocked: false, ...over,
}) as any;

/** 本地日历日期（不能用 toISOString —— `monthsBefore` 算的是本地日历）。 */
const localYmd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('monthsBefore：日历月钳制', () => {
  it('3 月 31 日的一个月前是 2 月 28 日（不是 3 月 3 日）', () => {
    assert.equal(
      localYmd(monthsBefore(new Date(2026, 2, 31, 12, 0, 0), 1)),
      '2026-02-28',
    );
  });
  it('闰年 3 月 31 日的一个月前是 2 月 29 日', () => {
    assert.equal(
      localYmd(monthsBefore(new Date(2024, 2, 31, 12, 0, 0), 1)),
      '2024-02-29',
    );
  });
  it('跨年：1 月 15 日的三个月前是上一年的 10 月 15 日', () => {
    assert.equal(
      localYmd(monthsBefore(new Date(2026, 0, 15, 12, 0, 0), 3)),
      '2025-10-15',
    );
  });
  it('31 日回溯到更短的月份——二月（5 月 31 日 → 2 月 28 日）', () => {
    assert.equal(
      localYmd(monthsBefore(new Date(2026, 4, 31, 12, 0, 0), 3)),
      '2026-02-28',
    );
  });
  it('31 日回溯到只有 30 天的月份（5 月 31 日 → 4 月 30 日）', () => {
    assert.equal(
      localYmd(monthsBefore(new Date(2026, 4, 31, 12, 0, 0), 1)),
      '2026-04-30',
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
  it('刚保存的锁定会话不算「被跳过」（它本来就不在候选集里）', () => {
    const plan = planCleanup([
      g({ id: 'recent-lock', createdAt: '2026-10-25T00:00:00.000Z', isLocked: true }),
      g({ id: 'old-lock', createdAt: '2026-01-01T00:00:00.000Z', isLocked: true }),
    ], '3m', now);
    assert.equal(plan.lockedSkippedCount, 1);
  });
  it('时间读不出来的会话不删（fail-safe，绝不当成「很旧」）', () => {
    const plan = planCleanup([
      g({ id: 'bad', createdAt: 'not-a-date' }),
    ], '1m', now);
    assert.deepEqual(plan.ids, []);
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
  it('含锁定：lockedSkippedCount 恒 0（这一档不跳过锁定）', () => {
    assert.equal(planCleanup(groups, 'all', now).lockedSkippedCount, 0);
  });
  it('两档全部都不算「保存时间未知」（这一档没有年龄筛选）', () => {
    const withUnknown = [
      g({ id: 'imp', importedAt: '2025-01-01T00:00:00.000Z' }),
      g({ id: 'imp-lock', importedAt: '2025-01-01T00:00:00.000Z', isLocked: true }),
    ];
    assert.equal(planCleanup(withUnknown, 'all', now).unknownTimeCount, 0);
    assert.equal(planCleanup(withUnknown, 'all-keep-locked', now).unknownTimeCount, 0);
  });
});

describe('菜单行文案', () => {
  /** 纯函数钉子的计划形状（只填文案会读到的字段）。 */
  const planFixture = (over: Record<string, unknown>) =>
    ({
      tier: '1m', ids: [], groupCount: 0, tabCount: 0,
      unknownTimeCount: 0, lockedSkippedCount: 0, lockedCount: 0, names: [],
      ...over,
    }) as any;

  it('四个时间档只显示要删的条数', () => {
    assert.equal(
      CLEANUP_TIER_LABELS['1m'](planFixture({ tier: '1m', groupCount: 3 })),
      '一个月前的会话（3）',
    );
    assert.equal(
      CLEANUP_TIER_LABELS['3m'](planFixture({ tier: '3m', groupCount: 12 })),
      '三个月前的会话（12）',
    );
    assert.equal(
      CLEANUP_TIER_LABELS['6m'](planFixture({ tier: '6m', groupCount: 18 })),
      '六个月前的会话（18）',
    );
    assert.equal(
      CLEANUP_TIER_LABELS['12m'](planFixture({ tier: '12m', groupCount: 24 })),
      '一年前的会话（24）',
    );
  });
  it('保留锁定：只显示锁定数，总数不许混进文案', () => {
    assert.equal(
      CLEANUP_TIER_LABELS['all-keep-locked'](
        planFixture({ tier: 'all-keep-locked', groupCount: 5, lockedSkippedCount: 2 }),
      ),
      '删除所有会话（保留 2 个锁定）',
    );
  });
  it('含锁定：有锁定时显示锁定数', () => {
    assert.equal(
      CLEANUP_TIER_LABELS.all(planFixture({ tier: 'all', groupCount: 5, lockedCount: 2 })),
      '删除所有会话（含 2 个锁定）',
    );
  });
  it('含锁定：没有锁定时显示总数（总数不许丢）', () => {
    assert.equal(
      CLEANUP_TIER_LABELS.all(planFixture({ tier: 'all', groupCount: 5, lockedCount: 0 })),
      '删除所有会话（5）',
    );
  });
  it('六个标签都不许出现第二叫法「删除全部会话」', () => {
    const TIERS = [
      '1m', '3m', '6m', '12m', 'all-keep-locked', 'all',
    ] as const;
    for (const tier of TIERS) {
      const label = CLEANUP_TIER_LABELS[tier](
        planFixture({ tier, groupCount: 5, lockedSkippedCount: 2, lockedCount: 2 }),
      );
      assert.ok(!label.includes('删除全部会话'));
    }
  });

  // ── 走 planCleanup 全路径：文案的数字必须来自同一份计划，不许只有纯函数钉子 ──
  const now = new Date('2026-10-26T00:00:00.000Z');
  it('含锁定：锁定数来自同一个计划（两条锁定 + 一条未锁定）', () => {
    const plan = planCleanup([
      g({ id: 'l1', isLocked: true }),
      g({ id: 'l2', isLocked: true }),
      g({ id: 'f' }),
    ], 'all', now);
    assert.equal(plan.lockedCount, 2);
    assert.equal(
      CLEANUP_TIER_LABELS.all(plan),
      '删除所有会话（含 2 个锁定）',
    );
  });
  it('含锁定：没有锁定时用计划里的总数（总数不许丢）', () => {
    const plan = planCleanup([g({ id: 'f' })], 'all', now);
    assert.equal(plan.lockedCount, 0);
    assert.equal(
      CLEANUP_TIER_LABELS.all(plan),
      '删除所有会话（1）',
    );
  });
  it('保留锁定：保留数来自同一个计划（一条锁定 + 一条未锁定）', () => {
    const plan = planCleanup([
      g({ id: 'lock', isLocked: true }),
      g({ id: 'free' }),
    ], 'all-keep-locked', now);
    assert.equal(plan.lockedSkippedCount, 1);
    assert.equal(
      CLEANUP_TIER_LABELS['all-keep-locked'](plan),
      '删除所有会话（保留 1 个锁定）',
    );
  });
  it('cleanupTierLabel：按计划自己的档位取文案（调用方不挑键）', () => {
    const plan = planCleanup([
      g({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z' }),
      g({ id: 'b', createdAt: '2026-02-01T00:00:00.000Z' }),
    ], '3m', now);
    assert.equal(plan.tier, '3m');
    assert.equal(cleanupTierLabel(plan), '三个月前的会话（2）');
  });
});
