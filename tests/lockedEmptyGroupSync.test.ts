// 缺陷 2 · 锁定空组跨同步周期：不得被自动剔除并广播云端删除。
//
// 【本文件是恢复的守卫】2026-10-16 瘦身把整份 tests/lockedEmptyGroupSync.test.ts
// 删除。审计用变异证明：把 src/services/syncEngine.ts 的合并落盘调用点
// `const finalGroups = dropSyncMergedGroups(mergedGroups);` 换成
// `mergedGroups.filter(g => g.tabs.length > 0)` 后，全量 1046 个测试依旧全绿。
// 纯函数 dropSyncMergedGroups 在 tests/mergeEmptyShellGroups.test.ts:135 有覆盖，
// 但**调用点**没有：换掉调用点，纯函数测试照样绿。
//
// 缺陷本体（2026-10-10 修复）：
//   用户锁定一个会话 → 删掉它最后一个标签（applyRemoveTab 锁定豁免，本地留下
//   「0 标签 + isLocked=true」的合法状态）→ 下一次后台同步（≤60s）若用无保护判据
//   把它剔除 → id 进 pendingDeleteIds → 云端行打 is_deleted 墓碑 →
//   **所有设备上永久消失**（v1.22.0 起无回收站），用户毫不知情。
//   把「锁定」翻译成「跨设备永久删除」，与用户按下锁定键时的意图正好相反。
//
// 变异验证口径（本次恢复后实测）：把调用点换成无保护 filter 后，
// 「锁定空组在同步后仍在结果里，且未被登记删除广播」变红（结果缺 L、队列混入 L）；
// 具体输出见交付记录。
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  installFakeSyncBackend,
  resetFakeSyncBackend,
  type FakeSyncBackendHandle,
} from './_helpers/fakeSyncBackend.ts';
import { installEngineStorageEnv, mkGroup } from './_helpers/engineStorageEnv.ts';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

const env = installEngineStorageEnv();

if (!process.env.VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const SYNC_ENGINE_SRC = 'src/services/syncEngine.ts';

let backend: FakeSyncBackendHandle;

before(async () => {
  register(LOADER_PATH);
  backend = await installFakeSyncBackend();
  const { storage } = await import('@/utils/storage');
  await storage.setOpStampMigrated(true);
});

after(async () => {
  await resetFakeSyncBackend();
});

beforeEach(async () => {
  env.failReadKeys.clear();
  const { storage, invalidateGroupsCache } = await import('@/utils/storage');
  await storage.setGroupsImmediate([] as never);
  invalidateGroupsCache();
  backend.calls.broadcastDeletes.length = 0;
});

describe('缺陷 2 · 同步合并落盘：锁定空组必须留下且不得被广播删除', () => {
  it('锁定空组在下载合并后仍在结果里；未锁定的空组照旧被剔除并登记删除', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    const { syncEngine } = await import('@/services/syncEngine');

    // 本地两个有内容的组（证明这不是「本地为空」的形状）
    await storage.setGroupsImmediate([
      mkGroup('L', { isLocked: true, tabs: [] }),
      mkGroup('K'),
    ] as never);
    invalidateGroupsCache();

    // 云端：锁定的零标签组（用户清空最后一个标签后的合法状态）+
    //       未锁定的零标签空壳（老版本设备写入 / 导入剔空，应被清理）+
    //       一个正常组
    backend.groups = [
      mkGroup('L', { isLocked: true, tabs: [] }),
      mkGroup('K'),
      mkGroup('U', { tabs: [] }),
    ] as never;

    const result = await syncEngine.downloadAndMerge({ forceRemote: true });

    assert.equal(result.success, true, `同步必须成功（${result.reason ?? ''}）`);
    const ids = result.groups.map(g => g.id);
    assert.ok(
      ids.includes('L'),
      `锁定空组必须保留：剔除它会被登记成云端删除广播，在所有设备上永久消失。实得 ${ids.join(',')}`
    );
    assert.ok(ids.includes('K'), '正控：有内容的组必须保留');
    assert.equal(ids.includes('U'), false, '正控：未锁定的空壳照旧被剔除（自动清理不能被整体关掉）');

    const queued = await storage.getPendingDeleteIds();
    assert.equal(
      queued.includes('L'),
      false,
      '锁定空组绝不能被登记进删除广播队列：那个队列会让 upload 把云端行打成墓碑'
    );
    assert.ok(queued.includes('U'), '正控：未锁定空壳应进入删除广播队列，等待下一轮广播');

    // 再走一轮上传：确认云端行也没有被标删（队列 → broadcastDeletes 是唯一出口）
    const up = await syncEngine.upload({ syncSettings: false, forcePending: true });
    assert.equal(up.success, true, `上传必须成功（${up.error ?? '无'}）`);
    const broadcast = backend.calls.broadcastDeletes.flat();
    assert.equal(broadcast.includes('L'), false, '云端不得收到 L 的删除广播（它仍是活跃行）');
    assert.ok(broadcast.includes('U'), '正控：U 的删除广播必须真的发出去');
  });
});

describe('缺陷 2 · 语义分层：两条判据不许互相污染（结构层）', () => {
  it('同步合并路径用锁定豁免、导入与视图过滤仍用无保护判据', () => {
    // 结构层：钉住「修法是新增 dropSyncMergedGroups，而不是改 isEmptyGroup 的全局语义」。
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', SYNC_ENGINE_SRC), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.match(
      src,
      /dropSyncMergedGroups\(mergedGroups\)/,
      '同步合并落盘必须走锁定豁免版'
    );
    assert.doesNotMatch(
      src,
      /dropEmptyGroups\(mergedGroups\)/,
      '同步合并落盘不得再用无保护判据 —— 那正是「锁定空组被跨设备永久删除」的直接原因'
    );
  });
});
