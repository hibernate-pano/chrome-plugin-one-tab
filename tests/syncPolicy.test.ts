/**
 * 同步策略的判据层守卫（2026-11-21）。
 *
 * ── 这个文件钉住的行为契约 ───────────────────────────────────────────────
 *  A. 合并远端策略：非法字段逐项退回默认；越界值被夹紧；字符串 'false' 不算 false。
 *  B. 轮询间隔：**策略永远不能把同步变快**（用户的档位是下限）。
 *     · 热档 = 用户档位；空闲档 = max(用户档位, 空闲间隔)。
 *  C. 弹窗自动下载：策略总闸关掉 ⇒ 不跑；距上次成功同步不足最小间隔 ⇒ 不跑。
 *  D. 指纹失败的全量回退：首次同步 / 覆盖下载**必须**放行；其余看冷却。
 *  E. 预览闸门：策略能停掉预览（停掉后覆盖按钮不可用，但合并仍可用）。
 *
 * ── 为什么这些必须逐字钉住 ────────────────────────────────────────────────
 * 这层判据是「出网配额」的唯一闸门，而它的失效方向是**静默多跑**（多烧配额）
 * 或**静默停跑**（用户的跨设备同步没了）。两种失效都不会报错 ⇒ 只能靠断言钉。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SYNC_POLICY,
  decideAutoDownload,
  decideFullDownloadFallback,
  decidePollInterval,
  decidePreview,
  mergeSyncPolicy,
} from '@/core/syncPolicy';

describe('同步策略 · 合并远端 JSON', () => {
  it('非对象 ⇒ 原样退回默认', () => {
    assert.deepEqual(mergeSyncPolicy(null), DEFAULT_SYNC_POLICY);
    assert.deepEqual(mergeSyncPolicy('nope'), DEFAULT_SYNC_POLICY);
    assert.deepEqual(mergeSyncPolicy(42), DEFAULT_SYNC_POLICY);
  });

  it('未知字段被忽略（不把拼错的字段当成生效的配置）', () => {
    const merged = mergeSyncPolicy({ revision: 3, idleIntervalMinuts: 99 });
    assert.equal(merged.revision, 3);
    assert.equal(merged.idleIntervalMinutes, DEFAULT_SYNC_POLICY.idleIntervalMinutes);
  });

  it('越界值被夹紧到合法区间', () => {
    const merged = mergeSyncPolicy({
      minIntervalMinutes: 0,
      idleIntervalMinutes: 99999,
      idleRoundsBeforeSlowdown: -5,
      minAutoDownloadIntervalMinutes: 100000,
      fullDownloadFallbackCooldownMinutes: -1,
      jitterSeconds: 100000,
    });
    assert.equal(merged.minIntervalMinutes, 5, '间隔下限不得低于用户可选的最小档位 5 分钟');
    assert.equal(merged.idleIntervalMinutes, 1440);
    assert.equal(merged.idleRoundsBeforeSlowdown, 0);
    assert.equal(merged.minAutoDownloadIntervalMinutes, 1440);
    assert.equal(merged.fullDownloadFallbackCooldownMinutes, 0);
    assert.equal(merged.jitterSeconds, 300);
  });

  it('字符串 "false" 不算 false（总闸只认真布尔）', () => {
    const merged = mergeSyncPolicy({ autoSyncEnabled: 'false' });
    assert.equal(merged.autoSyncEnabled, DEFAULT_SYNC_POLICY.autoSyncEnabled);
    const off = mergeSyncPolicy({ autoSyncEnabled: false });
    assert.equal(off.autoSyncEnabled, false, '真布尔 false 必须能关掉总闸');
  });

  it('非数字字段退回默认（不被 NaN 污染）', () => {
    const merged = mergeSyncPolicy({ idleIntervalMinutes: 'abc', revision: null });
    assert.equal(merged.idleIntervalMinutes, DEFAULT_SYNC_POLICY.idleIntervalMinutes);
    assert.equal(merged.revision, DEFAULT_SYNC_POLICY.revision);
  });
});

describe('同步策略 · 轮询间隔（热档 / 空闲档）', () => {
  const policy = { ...DEFAULT_SYNC_POLICY, idleIntervalMinutes: 30, idleRoundsBeforeSlowdown: 3 };

  it('热档 = 用户档位（策略的间隔下限不得把用户拉快）', () => {
    const d = decidePollInterval({
      userIntervalMinutes: 10,
      policy: { ...policy, minIntervalMinutes: 5 },
      consecutiveIdleRounds: 0,
    });
    assert.equal(d.periodMinutes, 10);
    assert.equal(d.cold, false);
  });

  it('策略的间隔下限只能把用户推慢，不能推快', () => {
    const d = decidePollInterval({
      userIntervalMinutes: 30,
      policy: { ...policy, minIntervalMinutes: 5 },
      consecutiveIdleRounds: 0,
    });
    assert.equal(d.periodMinutes, 30, '用户选 30 分钟 ⇒ 至少 30 分钟');
  });

  it('空闲轮数达标 ⇒ 进空闲档', () => {
    const d = decidePollInterval({
      userIntervalMinutes: 10,
      policy,
      consecutiveIdleRounds: 3,
    });
    assert.equal(d.cold, true);
    assert.equal(d.periodMinutes, 30);
  });

  it('空闲档不得快于用户档位（用户选 60 ⇒ 空闲档也是 60）', () => {
    const d = decidePollInterval({
      userIntervalMinutes: 60,
      policy,
      consecutiveIdleRounds: 99,
    });
    assert.equal(d.periodMinutes, 60);
  });

  it('空闲档关闭（idleIntervalMinutes=0）⇒ 永远热档', () => {
    const d = decidePollInterval({
      userIntervalMinutes: 10,
      policy: { ...policy, idleIntervalMinutes: 0 },
      consecutiveIdleRounds: 99,
    });
    assert.equal(d.cold, false);
    assert.equal(d.periodMinutes, 10);
  });
});

describe('同步策略 · 弹窗自动下载闸门', () => {
  const base = { ...DEFAULT_SYNC_POLICY, minAutoDownloadIntervalMinutes: 5 };

  it('策略总闸关掉 ⇒ 不跑', () => {
    const d = decideAutoDownload({
      policy: { ...base, autoSyncEnabled: false },
      lastSyncAt: null,
      now: 1000,
    });
    assert.equal(d.allowed, false);
  });

  it('距上次成功同步不足最小间隔 ⇒ 不跑', () => {
    const d = decideAutoDownload({
      policy: base,
      lastSyncAt: 0,
      now: 60_000, // 1 分钟 < 5 分钟
    });
    assert.equal(d.allowed, false);
  });

  it('超过最小间隔 ⇒ 跑', () => {
    const d = decideAutoDownload({
      policy: base,
      lastSyncAt: 0,
      now: 6 * 60_000,
    });
    assert.equal(d.allowed, true);
  });

  it('从没同步过 ⇒ 跑（首次不能被节流挡住）', () => {
    const d = decideAutoDownload({ policy: base, lastSyncAt: null, now: 1000 });
    assert.equal(d.allowed, true);
  });
});

describe('同步策略 · 指纹失败的全量回退冷却', () => {
  const policy = { ...DEFAULT_SYNC_POLICY, fullDownloadFallbackCooldownMinutes: 60 };

  it('首次同步必须全量（冷却不适用）', () => {
    const d = decideFullDownloadFallback({
      policy,
      lastFullDownloadAt: 0,
      now: 1000,
      isFirstSync: true,
      forceRemote: false,
    });
    assert.equal(d.allowed, true);
  });

  it('覆盖下载必须全量（冷却不适用）', () => {
    const d = decideFullDownloadFallback({
      policy,
      lastFullDownloadAt: 0,
      now: 1000,
      isFirstSync: false,
      forceRemote: true,
    });
    assert.equal(d.allowed, true);
  });

  it('冷却期内 ⇒ 不回退全量', () => {
    const d = decideFullDownloadFallback({
      policy,
      lastFullDownloadAt: 0,
      now: 10 * 60_000,
      isFirstSync: false,
      forceRemote: false,
    });
    assert.equal(d.allowed, false);
  });

  it('冷却期外 ⇒ 回退全量', () => {
    const d = decideFullDownloadFallback({
      policy,
      lastFullDownloadAt: 0,
      now: 61 * 60_000,
      isFirstSync: false,
      forceRemote: false,
    });
    assert.equal(d.allowed, true);
  });

  it('冷却为 0 ⇒ 永远允许回退（关掉这个闸门的形态）', () => {
    const d = decideFullDownloadFallback({
      policy: { ...policy, fullDownloadFallbackCooldownMinutes: 0 },
      lastFullDownloadAt: 0,
      now: 1000,
      isFirstSync: false,
      forceRemote: false,
    });
    assert.equal(d.allowed, true);
  });
});

describe('同步策略 · 预览闸门', () => {
  it('策略关掉预览 ⇒ 不允许', () => {
    const d = decidePreview({ ...DEFAULT_SYNC_POLICY, previewEnabled: false });
    assert.equal(d.allowed, false);
  });

  it('默认允许预览', () => {
    assert.equal(decidePreview(DEFAULT_SYNC_POLICY).allowed, true);
  });
});
