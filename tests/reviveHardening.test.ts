// 复活加固回归测试：
// 1) OpenGuard —— 单 tab 恢复的双击去重（锁定组仅 ~500ms）+ 失败 release 后可重试；
// 2) OpenAllGuard —— 整组恢复按 group.id 的同类在途锁；
// 3) debounceAsync.flush —— setGroupsImmediate 直写前排空未决防抖写入，旧快照先落盘、
//    新数据后写，避免定时器稍后触发用旧数据覆盖新数据。
//
// 文件头部样板与 tests/mutationOps.test.ts 既有模式一致：@/ 别名模块只能在
// register(loader) 之后【动态 import】。
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

describe('OpenGuard 单 tab 恢复去重', () => {
  it('冷却内重复点击被忽略（防双击开出重复浏览器标签）', async () => {
    const { OpenGuard } = await import('@/utils/openGuard');
    const guard = new OpenGuard();
    assert.equal(guard.tryAcquire('tab-1', false, 1000), true);
    assert.equal(guard.tryAcquire('tab-1', false, 1001), false);
    assert.equal(guard.tryAcquire('tab-1', false, 3999), false);
  });

  it('dispatch 失败 release 后允许立即重试', async () => {
    const { OpenGuard } = await import('@/utils/openGuard');
    const guard = new OpenGuard();
    assert.equal(guard.tryAcquire('tab-9', false, 1000), true);
    guard.release('tab-9'); // 对应 TabGroup catch 分支的 guard.release
    assert.equal(guard.tryAcquire('tab-9', false, 1001), true);
  });

  it('锁定组豁免长冷却、仅防双击 ~500ms', async () => {
    const { OpenGuard, openCooldownMs } = await import('@/utils/openGuard');
    assert.equal(openCooldownMs(true), 500);
    assert.equal(openCooldownMs(false), 3000);
    const guard = new OpenGuard();
    assert.equal(guard.tryAcquire('tab-L', true, 1000), true);
    assert.equal(guard.tryAcquire('tab-L', true, 1400), false);
    assert.equal(guard.tryAcquire('tab-L', true, 1600), true);
    // 同一时间尺度下，未锁定组仍在冷却内
    const guard2 = new OpenGuard();
    assert.equal(guard2.tryAcquire('tab-U', false, 1000), true);
    assert.equal(guard2.tryAcquire('tab-U', false, 1600), false);
    assert.equal(guard2.tryAcquire('tab-U', false, 4001), true);
  });

  it('命中过期条目即删，Map 不无限增长', async () => {
    const { OpenGuard } = await import('@/utils/openGuard');
    const guard = new OpenGuard();
    guard.tryAcquire('tab-a', false, 1000);
    guard.tryAcquire('tab-b', false, 1000);
    assert.equal(guard.size, 2);
    // 过期后再次 acquire：旧条目被删后重建，总数不变
    assert.equal(guard.tryAcquire('tab-a', false, 5000), true);
    assert.equal(guard.size, 2);
  });

  it('不同 tab 互不干扰', async () => {
    const { OpenGuard } = await import('@/utils/openGuard');
    const guard = new OpenGuard();
    assert.equal(guard.tryAcquire('tab-1', false, 1000), true);
    assert.equal(guard.tryAcquire('tab-2', false, 1001), true);
  });
});

describe('OpenAllGuard 整组恢复在途锁', () => {
  it('同组在途重复点击被忽略，结束后解锁', async () => {
    const { OpenAllGuard } = await import('@/utils/openGuard');
    const guard = new OpenAllGuard();
    assert.equal(guard.tryAcquire('group-1'), true);
    assert.equal(guard.tryAcquire('group-1'), false);
    guard.release('group-1'); // 对应 dispatch finally / 锁定组开窗消息发出后
    assert.equal(guard.tryAcquire('group-1'), true);
  });

  it('按 group.id 隔离，不同组互不干扰', async () => {
    const { OpenAllGuard } = await import('@/utils/openGuard');
    const guard = new OpenAllGuard();
    assert.equal(guard.tryAcquire('group-1'), true);
    assert.equal(guard.tryAcquire('group-2'), true);
    assert.equal(guard.size, 2);
    guard.release('group-1');
    assert.equal(guard.size, 1);
  });
});

describe('debounceAsync.flush 排空语义', () => {
  it('窗口期内多次调用合并为一次（最后一次参数）', async () => {
    const { debounceAsync } = await import('@/utils/performance');
    const calls: number[][] = [];
    const debounced = debounceAsync(async (v: number) => {
      calls.push([v]);
    }, 30);
    const p1 = debounced(1);
    const p2 = debounced(2);
    const p3 = debounced(3);
    await Promise.all([p1, p2, p3]);
    assert.deepEqual(calls, [[3]]);
  });

  it('flush 立即执行未决写入并让等待者拿到结果', async () => {
    const { debounceAsync } = await import('@/utils/performance');
    let executed = 0;
    const debounced = debounceAsync(async (v: number) => {
      executed++;
      return v * 2;
    }, 10_000);
    const pending = debounced(21);
    assert.equal(executed, 0);
    const flushed = await debounced.flush();
    assert.equal(flushed, 42);
    assert.equal(await pending, 42);
    assert.equal(executed, 1);
  });

  it('无未决调用时 flush 返回 undefined 且不执行 fn', async () => {
    const { debounceAsync } = await import('@/utils/performance');
    let executed = 0;
    const debounced = debounceAsync(async () => {
      executed++;
    }, 10);
    assert.equal(await debounced.flush(), undefined);
    assert.equal(executed, 0);
  });

  it('Immediate 场景：旧快照先排空落盘、新数据后写，最终顺序正确', async () => {
    const { debounceAsync } = await import('@/utils/performance');
    const landed: string[] = [];
    // 模拟 SW 进程内：防抖 setGroups(旧) 未决 + setGroupsImmediate(新) 直写
    const debouncedPersist = debounceAsync(async (v: string) => {
      landed.push(v);
    }, 10_000);
    const waiting = debouncedPersist('old-snapshot');
    // setGroupsImmediate 第一件事就是 flush
    await debouncedPersist.flush();
    landed.push('new-immediate'); // 直写 kv
    await waiting;
    assert.deepEqual(landed, ['old-snapshot', 'new-immediate']);
  });
});
