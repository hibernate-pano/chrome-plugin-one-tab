// 回归：2026-09-28 同步审计发现的三类数据丢失/额度问题。
//
// 1) 读不出来的会话不得被当成空组删掉（download.ts）
//    解密失败或 tabs_data 形状无法恢复时，旧代码降级成"零标签的组"，
//    下游按空壳硬删除 + 登记云端 purge → 云端仅存的那份数据被 DELETE。
//    原则：读不出来就不碰——整组跳过，云端行原封保留。
//
// 2) purge 队列必须伴随 pending_upload 置位（syncEngine）
//    只入队不置位 → 后台永不上传 → 云端行删不掉；同时云端多出的行让
//    hasRemoteChanges 的行数比对恒不等 → 探活永久失效 → 每 60 秒全量下载。
//
// 3) 读回校验要能区分"被守卫静默吞写"与"被更新一侧合法取代"（readback）
//    遗留 version 守卫（NEW.version < OLD.version → RETURN NULL）会静默丢弃
//    落后设备的写入。若一律判失败，整台上传永久卡死，且上传失败会连带跳过
//    下载（怕旧云端覆盖本地），该设备就此既不能上传也不能下载。

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

const NOW = '2026-09-28T14:00:00.000Z';

let compareUploadReadback: typeof import('../src/utils/supabase/readback.ts').compareUploadReadback;
let isSupersededByCloud: typeof import('../src/utils/supabase/readback.ts').isSupersededByCloud;
let normalizeTabsData: typeof import('../src/core/normalizeTabsData.ts').normalizeTabsData;
let isEmptyShellGroup: typeof import('../src/core/mutationOps.ts').isEmptyShellGroup;

before(async () => {
  register(LOADER_PATH, import.meta.url);
  ({ compareUploadReadback, isSupersededByCloud } = await import('../src/utils/supabase/readback.ts'));
  ({ normalizeTabsData } = await import('../src/core/normalizeTabsData.ts'));
  ({ isEmptyShellGroup } = await import('../src/core/mutationOps.ts'));
});

describe('同步审计修复 · 读回校验能识别"被合法取代"', () => {
  it('云端 version 更高 → 判为被取代而非失败（否则整台上传永久卡死）', () => {
    const r = compareUploadReadback(
      [{ id: 'g1', updatedAt: NOW, version: 1 }],
      [{ id: 'g1', updated_at: '2026-09-29T00:00:00.000Z', version: 5 }],
      { checkStamp: false, checkTombstone: false }
    );
    assert.equal(r.ok, true, '云端更新时本次写入输掉竞争属预期，不算失败');
    assert.deepEqual(r.superseded, ['g1']);
  });

  it('云端 version 不更高 → 仍判失败（读回校验的安全网不能被削弱）', () => {
    const r = compareUploadReadback(
      [{ id: 'g1', updatedAt: NOW, version: 5 }],
      [{ id: 'g1', updated_at: '2026-09-27T00:00:00.000Z', version: 2 }],
      { checkStamp: false, checkTombstone: false }
    );
    assert.equal(r.ok, false, '云端没有更新却没写上 = 真被守卫吞写，必须报错');
  });

  it('isSupersededByCloud：任一侧缺 version 时不误判', () => {
    assert.equal(isSupersededByCloud({ id: 'a', version: 1 }, { id: 'a', updated_at: NOW, version: null }), false);
    assert.equal(isSupersededByCloud({ id: 'a', version: null }, { id: 'a', updated_at: NOW, version: 9 }), false);
    assert.equal(isSupersededByCloud({ id: 'a', version: 3 }, { id: 'a', updated_at: NOW, version: 3 }), false);
    assert.equal(isSupersededByCloud({ id: 'a', version: 3 }, { id: 'a', updated_at: NOW, version: 4 }), true);
  });
});

describe('同步审计修复 · 读不出来 ≠ 是空的', () => {
  it('形状无法恢复的 tabs_data 归一化成空数组后会被判为空壳（这正是隐患）', () => {
    // 旧行为：这里返回 []，下游当成"零标签的组" → 硬删除 + purge 云端行
    const normalized = normalizeTabsData({ someUnrecoverableShape: 1 }, 'g1');
    assert.deepEqual(normalized, []);

    const wouldBeShell = isEmptyShellGroup({
      id: 'g1', name: 'g', tabs: normalized,
      createdAt: NOW, updatedAt: NOW, isLocked: false, version: 1,
    } as any);
    assert.equal(wouldBeShell, true, '确认：空数组会被判为空壳——所以下载侧必须提前跳过');
  });

  it('真正的空数组仍然归一化为空（不能把合法的空组也当不可信）', () => {
    assert.deepEqual(normalizeTabsData([], 'g1'), []);
  });

  it('wrapper 对象仍能恢复（修复不能误伤历史坏行的兼容路径）', () => {
    const tabs = [{ id: 't1', url: 'https://a.com', title: 'A' }];
    assert.deepEqual(normalizeTabsData({ tabs }, 'g1'), tabs);
  });
});
