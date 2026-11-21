/**
 * 同步策略的 IO 层守卫（2026-11-21）。
 *
 * ── 这个文件钉住的行为契约 ───────────────────────────────────────────────
 *  A. 缓存新鲜 ⇒ **不联网**（策略是慢变量；每轮同步都去拉一次网络 = 拿时延换流量）。
 *  B. 缓存过期 ⇒ 后台刷新，**本轮不等**（本轮用旧值）。
 *  C. 拉取失败 + 有缓存 ⇒ 沿用缓存（**不是**停同步）。
 *  D. 拉取失败 + 无缓存 ⇒ 用默认策略（**不是**停同步）。
 *  E. 强制刷新 ⇒ 等它拉完（拉完仍失败 ⇒ 沿用旧缓存/默认）。
 *
 * ── 为什么用注入依赖而不是断言源码长相 ────────────────────────────────────
 * 「源码里出现了 fetchPolicy()」这种断言**零检测力**：把 fetchPolicy 换成
 * `async () => ({})` 它照样绿。而这里注入假的 fetch/KV，**真的调用那条路径**，
 * 于是「失败时会不会停同步」是行为级的断言。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SYNC_POLICY, type SyncPolicy } from '@/core/syncPolicy';
import {
  createSyncPolicyService,
  SYNC_POLICY_TTL_MS,
  type CachedSyncPolicy,
  type SyncPolicyDeps,
} from '@/services/syncPolicyRuntime';

const NOW = 1_700_000_000_000;

const makeDeps = (overrides: Partial<SyncPolicyDeps> = {}) => {
  let cache: CachedSyncPolicy | null = null;
  let fetchCalls = 0;
  const deps: SyncPolicyDeps = {
    fetchPolicy: async () => {
      fetchCalls += 1;
      return { revision: 7, idleIntervalMinutes: 45 };
    },
    readCache: async () => cache,
    writeCache: async (next: CachedSyncPolicy) => {
      cache = next;
    },
    now: () => NOW,
    // 单测里允许"联网"（用的是注入的假 fetch，不是真网络）。
    canReachNetwork: () => true,
    ...overrides,
  };
  return {
    deps,
    get fetchCalls() {
      return fetchCalls;
    },
    get cache() {
      return cache;
    },
    set cache(v: CachedSyncPolicy | null) {
      cache = v;
    },
  };
};

describe('同步策略 · IO 层', () => {
  it('缓存新鲜 ⇒ 不联网，且用缓存里的策略', async () => {
    const h = makeDeps();
    h.cache = { policy: { ...DEFAULT_SYNC_POLICY, revision: 3 }, fetchedAt: NOW - 1000 };
    const svc = createSyncPolicyService(h.deps);
    const policy = await svc.readPolicy();
    assert.equal(policy.revision, 3);
    assert.equal(h.fetchCalls, 0, '新鲜的缓存不该触发任何网络请求');
  });

  it('缓存过期 ⇒ 后台刷新，本轮仍用旧值（不阻塞）', async () => {
    const h = makeDeps();
    h.cache = { policy: { ...DEFAULT_SYNC_POLICY, revision: 3 }, fetchedAt: NOW - SYNC_POLICY_TTL_MS - 1 };
    const svc = createSyncPolicyService(h.deps);
    const policy = await svc.readPolicy();
    assert.equal(policy.revision, 3, '本轮用旧值');
    // 后台刷新是异步的 ⇒ 让出一次事件循环再断言它真的发生了。
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(h.fetchCalls, 1, '过期缓存应触发一次后台刷新');
    assert.equal(h.cache?.policy.revision, 7, '刷新结果应写回缓存');
  });

  it('拉取失败 + 有缓存 ⇒ 沿用缓存（不是停同步）', async () => {
    const h = makeDeps({
      fetchPolicy: async () => {
        throw new Error('offline');
      },
    });
    h.cache = { policy: { ...DEFAULT_SYNC_POLICY, revision: 5 }, fetchedAt: NOW - SYNC_POLICY_TTL_MS - 1 };
    const svc = createSyncPolicyService(h.deps);
    const policy = await svc.readPolicy();
    assert.equal(policy.revision, 5, '拉不到就用旧缓存，不该把策略打成"停用"');
    await new Promise((r) => setTimeout(r, 0));
  });

  it('拉取失败 + 无缓存 ⇒ 默认策略（不是停同步）', async () => {
    const h = makeDeps({
      fetchPolicy: async () => {
        throw new Error('offline');
      },
    });
    const svc = createSyncPolicyService(h.deps);
    const policy = await svc.readPolicy();
    assert.deepEqual(policy, DEFAULT_SYNC_POLICY);
    await new Promise((r) => setTimeout(r, 0));
  });

  it('强制刷新 ⇒ 等它拉完并用新值', async () => {
    const h = makeDeps();
    const svc = createSyncPolicyService(h.deps);
    const policy = await svc.readPolicy({ forceRefresh: true });
    assert.equal(policy.revision, 7);
    assert.equal(h.fetchCalls, 1);
  });

  it('强制刷新失败 ⇒ 沿用旧缓存', async () => {
    const h = makeDeps({
      fetchPolicy: async () => {
        throw new Error('offline');
      },
    });
    h.cache = { policy: { ...DEFAULT_SYNC_POLICY, revision: 9 }, fetchedAt: NOW - 1 };
    const svc = createSyncPolicyService(h.deps);
    const policy = await svc.readPolicy({ forceRefresh: true });
    assert.equal(policy.revision, 9);
  });

  it('远端给回垃圾形状 ⇒ 合并后仍是合法策略', async () => {
    const h = makeDeps({
      fetchPolicy: async () => ({ revision: 'x', idleIntervalMinutes: -1, previewEnabled: 'false' }),
    });
    const svc = createSyncPolicyService(h.deps);
    const policy = await svc.readPolicy({ forceRefresh: true });
    const asPolicy: SyncPolicy = policy;
    assert.equal(asPolicy.revision, DEFAULT_SYNC_POLICY.revision);
    assert.equal(asPolicy.idleIntervalMinutes, 0, '-1 被夹到 0（空闲档关闭）');
    assert.equal(asPolicy.previewEnabled, DEFAULT_SYNC_POLICY.previewEnabled);
  });
});
