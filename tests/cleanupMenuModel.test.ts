/**
 * 「清理旧会话」子菜单的**行模型**（2026-11-03）。
 *
 * ── 这个文件防的具体事故 ──────────────────────────────────────────────────
 *
 * 「哪些行出现」是一组判据，藏不住也不能藏错：
 *   · 算出来 0 条的档位摆出来 ⇒ 用户点下去看到「清理 0 个会话」；
 *   · 没有锁定会话时还摆「保留锁定」那一行 ⇒ 保留 0 个 = 与「全删」同一件事，
 *     多一行就多一次误点；
 *   · 「保留锁定」与「含锁定」两行的**小字说反了** ⇒ 用户以为锁定的会留下，
 *     结果被一起删掉（这是最贵的一种错）。
 *
 * ⇒ 全部按**行为**测（真的调 `cleanupMenuRows`），不是「源码里有没有某句话」。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanupMenuRows } from '@/components/layout/cleanupMenuModel';
import { planCleanup, type CleanupPlan, type CleanupTier } from '@/core/cleanupPlan';

const NOW = new Date('2026-11-03T00:00:00.000Z');

const group = (over: Record<string, unknown>) => ({
  id: 'x',
  name: '会话',
  tabs: [],
  createdAt: OLD,
  updatedAt: '2026-01-01T00:00:00.000Z',
  isLocked: false,
  ...over,
});

/** 六份计划（源同一份会话数组、now 同一个）。 */
const plansOf = (groups: unknown[]): Record<CleanupTier, CleanupPlan> => {
  const plans = {} as Record<CleanupTier, CleanupPlan>;
  for (const tier of ['1m', '3m', '6m', '12m', 'all-keep-locked', 'all'] as CleanupTier[]) {
    plans[tier] = planCleanup(groups as never, tier, NOW);
  }
  return plans;
};

const disc = { isAuthenticated: false, syncBackend: 'supabase' as const };

// NOW = 2026-11-03 ⇒ 四个档的截止点分别是 2026-10-03 / 2026-08-03 /
// 2026-05-03 / 2025-11-03。下面三组数据正好各自落在不同的档位上：
const OLD = '2025-01-01T00:00:00.000Z';   // 四个档都够旧
const MID = '2026-08-01T00:00:00.000Z';   // 够 1m / 3m，不够 6m / 12m
const NEW = '2026-11-01T00:00:00.000Z';   // 四个档都不够旧

describe('时间档', () => {
  it('只有算出来有东西的档位才出现', () => {
    const rows = cleanupMenuRows(
      plansOf([
        group({ id: 'mid', createdAt: MID }),
        group({ id: 'new', createdAt: NEW }),
      ]),
      disc
    );
    const tiers = rows.map(r => r.tier);
    assert.ok(tiers.includes('1m'), '一个月前那一档有货 ⇒ 必须出现');
    assert.ok(tiers.includes('3m'), '三个月前那一档有货 ⇒ 必须出现');
    assert.ok(!tiers.includes('6m'), '六个月前那一档没货 ⇒ 不得出现');
    assert.ok(!tiers.includes('12m'), '一年前那一档没货 ⇒ 不得出现');
  });

  it('行文字带条数，且与计划同源', () => {
    const plans = plansOf([group({ id: 'a', createdAt: OLD })]);
    const row = cleanupMenuRows(plans, disc).find(r => r.tier === '12m');
    assert.ok(row);
    assert.equal(row.label, '一年前的会话（1）');
    assert.equal(row.path, 'deleteGroups');
  });

  it('条数与档位对得上（12m 只算够旧的那些）', () => {
    const plans = plansOf([
      group({ id: 'old', createdAt: OLD }),
      group({ id: 'mid', createdAt: MID }),
    ]);
    const rows = cleanupMenuRows(plans, disc);
    assert.equal(rows.find(r => r.tier === '12m')?.label, '一年前的会话（1）');
    assert.equal(rows.find(r => r.tier === '1m')?.label, '一个月前的会话（2）');
  });
});

describe('两档「全部」', () => {
  it('「含锁定」那一行始终出现（它是「删除所有会话」这个动作本身）', () => {
    const rows = cleanupMenuRows(plansOf([]), disc);
    const row = rows.find(r => r.tier === 'all');
    assert.ok(row, '「删除所有会话」必须始终有入口');
    assert.equal(row.path, 'deleteAll');
  });

  it('没有锁定会话时，「保留锁定」那一行不出现', () => {
    const rows = cleanupMenuRows(
      plansOf([group({ id: 'a', createdAt: OLD })]),
      disc
    );
    assert.ok(!rows.some(r => r.tier === 'all-keep-locked'), '保留 0 个 = 与「全删」同一件事');
  });

  it('有锁定、也有未锁定 ⇒ 「保留锁定」出现，走 deleteGroups', () => {
    const rows = cleanupMenuRows(
      plansOf([
        group({ id: 'a', createdAt: OLD }),
        group({ id: 'b', createdAt: OLD, isLocked: true }),
      ]),
      disc
    );
    const row = rows.find(r => r.tier === 'all-keep-locked');
    assert.ok(row, '有锁定要保留 ⇒ 这一档必须出现');
    assert.equal(row.path, 'deleteGroups');
    assert.match(row.label, /保留 1 个锁定/);
  });

  it('全是锁定 ⇒ 「保留锁定」不出现（没东西可清）', () => {
    const rows = cleanupMenuRows(
      plansOf([group({ id: 'b', createdAt: OLD, isLocked: true })]),
      disc
    );
    assert.ok(!rows.some(r => r.tier === 'all-keep-locked'));
  });
});

describe('小字（只有两档「全部」有）', () => {
  it('时间档没有小字', () => {
    const rows = cleanupMenuRows(
      plansOf([group({ id: 'a', createdAt: OLD })]),
      disc
    );
    const row = rows.find(r => r.tier === '12m');
    assert.ok(row);
    assert.equal(row.warning, undefined, '时间档的小字塞不进 256px 的菜单');
  });

  it('两档「全部」都有小字，且说的正好相反', () => {
    const rows = cleanupMenuRows(
      plansOf([
        group({ id: 'a', createdAt: OLD }),
        group({ id: 'b', createdAt: OLD, isLocked: true }),
      ]),
      disc
    );
    const keep = rows.find(r => r.tier === 'all-keep-locked');
    const all = rows.find(r => r.tier === 'all');
    assert.ok(keep?.warning, '「保留锁定」那行必须说清锁定的会留下');
    assert.ok(all?.warning, '「含锁定」那行必须说清锁定的会被删');
    assert.match(keep!.warning!, /会保留/, '「保留锁定」那行必须说清锁定的会留下');
    assert.match(all!.warning!, /也会被删除/);
  });

  it('小字跟着同步后端变（有后端才说跨设备）', () => {
    const plans = plansOf([group({ id: 'a', createdAt: OLD })]);
    const local = cleanupMenuRows(plans, { isAuthenticated: false, syncBackend: 'supabase' });
    const cloud = cleanupMenuRows(plans, { isAuthenticated: false, syncBackend: 'webdav' });
    const localWarning = local.find(r => r.tier === 'all')?.warning ?? '';
    const cloudWarning = cloud.find(r => r.tier === 'all')?.warning ?? '';
    assert.ok(!localWarning.includes('同步删除'), `纯本地用户不该被告知跨设备删除：${localWarning}`);
    assert.ok(cloudWarning.includes('同步删除'), `自带存储用户的删除同样会广播：${cloudWarning}`);
  });
});

describe('行的顺序', () => {
  it('四个时间档在前，两档「全部」在后', () => {
    const rows = cleanupMenuRows(
      plansOf([
        group({ id: 'a', createdAt: MID }),
        group({ id: 'b', createdAt: OLD, isLocked: true }),
      ]),
      disc
    );
    const tiers = rows.map(r => r.tier);
    assert.deepEqual(tiers, ['1m', '3m', 'all-keep-locked', 'all']);
  });
});
