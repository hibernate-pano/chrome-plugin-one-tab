// P0-3 hasRemoteChanges 回归：单调 seq 为主信号，时间戳仅参考。
//
// 【本文件是恢复的守卫，不是新写的规定】2026-10-16 瘦身把整份
// tests/syncReliabilityP0P1.test.ts 删掉时，连这 7 条 hasRemoteChanges
// 纯函数用例一起删了 —— 而 hasRemoteChanges 是**活代码**
// （src/services/syncEngine.ts 的 up_to_date 短路消费它）。
// 审计用变异证明：在它顶部加 `return false;`，全量 1046 个测试仍然全绿。
// 本文件只恢复能跑的纯函数部分；原文件里的 compareUploadReadback /
// compareTombstoneReadback（依赖已随账号体系删除的 @/utils/supabaseFacade）
// 无法恢复，对象模块已不存在。
//
// 变异验证口径（本次恢复后实测）：在 hasRemoteChanges 顶部插入 `return false;`
// ⇒ 本文件「seq 不等 → 有变更」「device 不同但 seq 相同 → 有变更」
// 「最小列 digest + updated_at 不等 → 有变更」等断言逐条变红（具体输出见交付记录）。
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

before(async () => {
  register(LOADER_PATH);
});

const NOW = '2026-09-23T08:00:00.000Z';

function makeGroup(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    tabs: [],
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    version: 1,
    ...overrides,
  };
}

// ── P0-3：hasRemoteChanges seq 为主 ──────────────────────────────────────
describe('P0-3 hasRemoteChanges: 单调 seq 为主信号，时间戳仅参考', () => {
  it('seq 不等 → 有变更（即使 updated_at/version 完全相同）', async () => {
    const { hasRemoteChanges } = await import('@/core/syncDecision');
    const local = [makeGroup('g', { lastOp: { d: 'devA', s: 5 } })];
    const digest = [{ id: 'g', updated_at: NOW, version: 1, last_op_device: 'devA', last_op_seq: 7 }];
    assert.equal(hasRemoteChanges(local as any, digest), true);
  });

  it('云端有印记、本地无印记 → 有变更（迁移前本地 vs 已迁移云端不漏判）', async () => {
    const { hasRemoteChanges } = await import('@/core/syncDecision');
    const local = [makeGroup('g')];
    const digest = [{ id: 'g', updated_at: NOW, version: 1, last_op_device: 'devA', last_op_seq: 3 }];
    assert.equal(hasRemoteChanges(local as any, digest), true);
  });

  it('device 不同但 seq 相同 → 有变更（同 seq 不同设备不可视为同一意图）', async () => {
    const { hasRemoteChanges } = await import('@/core/syncDecision');
    const local = [makeGroup('g', { lastOp: { d: 'devA', s: 5 } })];
    const digest = [{ id: 'g', updated_at: NOW, version: 1, last_op_device: 'devB', last_op_seq: 5 }];
    assert.equal(hasRemoteChanges(local as any, digest), true);
  });

  it('seq/device/version/时间戳全一致 → 无变更（短路成立）', async () => {
    const { hasRemoteChanges } = await import('@/core/syncDecision');
    const local = [makeGroup('g', { lastOp: { d: 'devA', s: 5 } })];
    const digest = [{ id: 'g', updated_at: NOW, version: 1, is_deleted: false, last_op_device: 'devA', last_op_seq: 5 }];
    assert.equal(hasRemoteChanges(local as any, digest), false);
  });

  it('seq 相等但 version 不等 → 仍判有变更（seq 相等不屏蔽其他信号）', async () => {
    const { hasRemoteChanges } = await import('@/core/syncDecision');
    const local = [makeGroup('g', { lastOp: { d: 'devA', s: 5 } })];
    const digest = [{ id: 'g', updated_at: NOW, version: 2, last_op_device: 'devA', last_op_seq: 5 }];
    assert.equal(hasRemoteChanges(local as any, digest), true);
  });

  it('最小列 digest（无印记列）+ 时间戳一致 → 无变更（未迁移云端 fail-open 不误报）', async () => {
    const { hasRemoteChanges } = await import('@/core/syncDecision');
    const local = [makeGroup('g')];
    const digest = [{ id: 'g', updated_at: NOW, version: 1 }];
    assert.equal(hasRemoteChanges(local as any, digest), false);
  });

  it('最小列 digest + updated_at 不等 → 有变更（Web 端只触时间戳的写不漏判）', async () => {
    const { hasRemoteChanges } = await import('@/core/syncDecision');
    const local = [makeGroup('g')];
    const digest = [{ id: 'g', updated_at: '2026-09-23T09:00:00.000Z', version: 1 }];
    assert.equal(hasRemoteChanges(local as any, digest), true);
  });
});
