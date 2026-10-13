// localStorage 回退驱动的 fail-closed 守卫（2026-10-12 P0）。
//
// 【为什么这个文件必须存在】同目录下 storageFailClosed.test.ts 锁死了
// **IndexedDB** 驱动的 fail-closed，但那条不变式当时只做在了那一个驱动上：
// localStorageFallback 从项目第一天起就是 `if (!isLocalStorageAvailable()) return null`，
// 而 storageAdapter.pickBackend() 在无 indexedDB 时会降级到它 —— 于是这条
// fail-open 路径一直可达，且没有任何守卫覆盖它。
//
// 实测的丢数据链（修复前）：
//   localStorage 整体不可用（配额满 / 隐私模式 / 站点数据被清）
//     → getItem 返回 null，与「键不存在」同形
//     → storage.getGroups() 把 null 判成「首次使用」→ 返回 []
//     → getGroupsForWrite() 不抛错（它只 flush + 失效缓存）
//     → applySaveGroup([], group) → setGroupsImmediate 真写成功
//     → 用户全部会话被替换成刚保存的那一条，界面报「已保存」，无回收站。
//
// 【为什么这里断言行为、不只断言返回值】
// 「getItem 抛错」本身不足以锁死回归：真正的不变式是
// **「读失败不得让 getGroups 拿到 []，从而整库覆盖」**。
// 只钉返回值的守卫，会被「抛错但被上层 catch 兜成 []」的改法骗过。
// 所以本文件同时跑通 storage 层的真实链路，断言落盘数据保持原样。
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

// ── 环境桩：可控的 localStorage ─────────────────────────────────────
// available=false 模拟「存储存在但操作失败」（配额满 / 隐私模式）；
// 不设 window 则模拟「环境根本没有 localStorage」（MV3 SW / Node）。
type Backing = Map<string, string>;

function makeLocalStorageLike(backing: Backing) {
  const state = { available: true };
  const stub = {
    state,
    get length() {
      return backing.size;
    },
    key: (i: number) => [...backing.keys()][i] ?? null,
    getItem: (k: string) => (backing.has(k) ? (backing.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      if (!state.available) throw new Error('QuotaExceededError: 模拟配额满');
      backing.set(k, String(v));
    },
    removeItem: (k: string) => {
      if (!state.available) throw new Error('QuotaExceededError: 模拟配额满');
      backing.delete(k);
    },
    clear: () => backing.clear(),
  };
  return stub;
}

const backing: Backing = new Map();
const lsStub = makeLocalStorageLike(backing);
const g = globalThis as Record<string, unknown>;
g.window = { localStorage: lsStub };

const NOW = '2026-10-12T08:00:00.000Z';
const existingGroups = [
  { id: 'g-1', name: '会话一', tabs: [], createdAt: NOW, updatedAt: NOW, isLocked: false, version: 1 },
  { id: 'g-2', name: '会话二', tabs: [], createdAt: NOW, updatedAt: NOW, isLocked: false, version: 1 },
  { id: 'g-3', name: '会话三', tabs: [], createdAt: NOW, updatedAt: NOW, isLocked: false, version: 1 },
];

describe('localStorage 回退驱动必须 fail-closed（2026-10-12 P0）', () => {
  before(async () => {
    await register(LOADER_PATH);
  });

  beforeEach(() => {
    lsStub.state.available = true;
    g.window = { localStorage: lsStub };
    backing.clear();
    backing.set('tab_groups', JSON.stringify(existingGroups));
    backing.set('storage_version', JSON.stringify(5));
  });

  it('存储存在但读写失败：getItem 必须抛错，不得与「键不存在」同形', async () => {
    const { localStorageDriver } = await import('@/storage-kv/localStorageFallback');
    lsStub.state.available = false;
    await assert.rejects(
      () => localStorageDriver.getItem('tab_groups'),
      /localStorage.*不可用/,
      '❌ 回归：读失败返回了 null —— 上层会把它当成「用户没有会话」'
    );
  });

  it('存储存在但写失败：setItem 必须抛错（静默 no-op 就是谎报成功）', async () => {
    const { localStorageDriver } = await import('@/storage-kv/localStorageFallback');
    lsStub.state.available = false;
    await assert.rejects(
      () => localStorageDriver.setItem('tab_groups', []),
      /localStorage.*不可用/,
      '❌ 回归：写失败被静默吞掉 —— 调用方会以为已落盘'
    );
    assert.equal(
      backing.get('tab_groups'),
      JSON.stringify(existingGroups),
      '❌ 落盘数据不得被空数组覆盖'
    );
  });

  it('三种「拿不到」必须区分：环境不存在 → null；存储故障 → 抛错；键真的没有 → null', async () => {
    const { localStorageDriver, hasLocalStorage, isLocalStorageAvailable } = await import(
      '@/storage-kv/localStorageFallback'
    );

    // (a) 环境根本没有 localStorage（MV3 SW 正是这个环境）
    //     这是**事实**不是故障：SW 无 window，本地数据一律走 chrome.storage。
    delete g.window;
    assert.equal(hasLocalStorage(), false);
    assert.equal(isLocalStorageAvailable(), false);
    assert.equal(await localStorageDriver.getItem('tab_groups'), null);
    await localStorageDriver.setItem('x', 1); // 不得抛错

    // (b) 存储存在但故障（配额满）—— 这是 P0 的真实现，必须抛错
    g.window = { localStorage: lsStub };
    lsStub.state.available = false;
    assert.equal(hasLocalStorage(), true, '存储存在 ⇒ hasLocalStorage 为 true');
    assert.equal(isLocalStorageAvailable(), false, '探测写失败 ⇒ 不可用');
    await assert.rejects(() => localStorageDriver.getItem('tab_groups'), /localStorage.*不可用/);

    // (c) 存储正常但这条键真的不存在 —— null 是正确答案
    lsStub.state.available = true;
    assert.equal(isLocalStorageAvailable(), true);
    assert.equal(await localStorageDriver.getItem('never-written-key'), null);
    assert.deepEqual(await localStorageDriver.getItem('tab_groups'), existingGroups);
  });

  it('端到端：读失败时整库覆盖不得发生，落盘三条会话保持原样', async () => {
    // 这一条是本文件的核心：前三条钉的是驱动契约，这一条钉的是**用户后果**。
    // 即便有人把驱动改回 fail-open、或给 storage 层加了个兜底把错误吞成 []，
    // 只要「读失败 ⇒ 落盘被整表覆盖」这条路还通，这里就会红。
    //
    // 【为什么这里必须只认读侧的报错】变异验证实测：把驱动的**读侧**改回
    // `if (!isLocalStorageAvailable()) return null`（即 P0 的原始形状）后，
    // 本用例一度仍然通过 —— 因为 getGroupsForWrite 内部先写 storage_version，
    // **写侧**的抛错先命中了断言，而写侧修复与本条要守的读侧不变式无关。
    // 那时的绿是假绿。所以这里只匹配读侧那句「无法读取」，
    // 写侧/其它报错一律不算通过。
    const { storage } = await import('@/utils/storage');
    lsStub.state.available = false;

    // 读路径必须失败（而不是交出 []）
    await assert.rejects(
      () => storage.getGroupsForWrite(),
      /无法读取/,
      '❌ getGroupsForWrite 在读失败时返回了 [] —— 这是整库覆盖的第一步'
    );

    // 写路径整条失败：即使强行调用，落盘数据也不得被改写
    const before = backing.get('tab_groups');
    await storage.setGroupsImmediate([{ ...existingGroups[0], name: '被覆盖的写入' }]).catch(() => {
      /* 抛错即期望行为 */
    });
    assert.equal(
      backing.get('tab_groups'),
      before,
      '❌ 存储不可用时落盘数据被改写 —— 用户会话在无声中消失'
    );

    // 恢复可用后，原数据必须完好可读（没有被此前的失败写污染）
    lsStub.state.available = true;
    const restored = await storage.getGroupsForWrite();
    assert.equal(restored.length, 3, '❌ 原三条会话不得减少');
    assert.deepEqual(
      restored.map(x => x.id),
      ['g-1', 'g-2', 'g-3']
    );
  });
});
