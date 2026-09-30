// 回归：同步合并不得留下空会话卡（无墓碑模型下的空组统一规则）。
//
// 历史 bug（Jasper 报「切双栏多出空标签组、越攒越多」）：旧模型里 URL 去重给
// 败者盖标签级墓碑却从不处理组，被剥空的组以 isDeleted:false 落盘渲染成空卡。
//
// 无墓碑模型（2026-09-29）：合并是组级 LWW 整组覆盖，不存在"被剥空"的中间态；
// 但空组统一规则仍然兜底——合并结果落盘前 dropEmptyGroups 剔除空组（锁定豁免），
// 被剔除的组由 syncEngine 登记删除广播队列（云端行标 is_deleted，防对端复活）。
//
// 这里直测判据与合并结果的衔接（不拉起整个 syncEngine，避免网络与登录态依赖）。

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
  ({ dropEmptyGroups, isEmptyGroup } = await import('../src/core/mutationOps.ts'));
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

  it('锁定但零标签的组按空壳清掉（2026-09-30 语义修订）', () => {
    const groups = [
      group('ok', [tab('t1', 'https://a.com')]),
      group('locked-empty', [], { isLocked: true }),
    ];
    const final = dropEmptyGroups(groups);

    assert.deepEqual(final.map(g => g.id), ['ok'], '零标签的锁定组没有内容可保护');
  });

  it('纯函数：输入不被就地修改', () => {
    const groups = [group('dup', [])];
    const snapshot = JSON.stringify(groups);

    dropEmptyGroups(groups);

    assert.equal(JSON.stringify(groups), snapshot);
  });
});
