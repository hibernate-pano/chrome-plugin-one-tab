// S5 删除语义统一 · 往返锁定测试：Web 写墓碑 → 扩展读 → 合并 → Web 读，不复活。
//
// 覆盖两种云端载荷形状：
//   A. 扩展写入形：TabData[]（snake_case，serializeTab 产物，加密前形态）
//   B. Web/旧客户端写入形：wrapper 对象 { tabs: Tab[]（camelCase）, version, displayOrder }
//
// 不变量（与扩展端 applyRemoveTab / mergeOpStamped 同口径）：
//   1. Web 删除后载荷内保留墓碑（isDeleted/is_deleted 双写 + stamp 双写），不物理移除
//   2. 扩展下载链（normalizeTabsData + deserializeTab）能还原删除意图与印记
//   3. 合并时墓碑（新 stamp）盖过对端滞留的活跃副本（旧 stamp）→ 不复活
//   4. 墓碑本体保留在合并结果中（向第三方设备传播）
//   5. Web 回读（fetchGroups 的 strip 口径：过滤 isDeleted）不展示墓碑
//   6. 幂等：重复删除已墓碑 tab 不改写；删空未锁定组 → 整组墓碑信号
//
// 文件样板与 tests/mutationOps.test.ts 一致：@/ 别名模块只能动态 import。
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

const NOW = '2026-09-23T10:00:00.000Z';
const EARLIER = '2026-09-20T10:00:00.000Z';
const OLD_STAMP = { d: 'devExt', s: 7 };

function mkTab(id: string, url: string) {
  return {
    id, url, title: `tab ${id}`, favicon: '',
    createdAt: EARLIER, lastAccessed: EARLIER, pinned: false,
  };
}

describe('S5 mintWebStamp: OLD+1 归属写者本设备', () => {
  it('云端 seq=7 → 新 stamp s=8 且 d=本设备', async () => {
    const { mintWebStamp } = await import('@/utils/webTombstone');
    assert.deepEqual(mintWebStamp('devWeb', 7), { d: 'devWeb', s: 8 });
  });

  it('云端无印记（null）→ 从 s=1 起', async () => {
    const { mintWebStamp } = await import('@/utils/webTombstone');
    assert.deepEqual(mintWebStamp('devWeb', null), { d: 'devWeb', s: 1 });
    assert.deepEqual(mintWebStamp('devWeb', undefined), { d: 'devWeb', s: 1 });
  });
});

describe('S5 形状A往返：扩展形 TabData[] → Web 墓碑 → 扩展读 → 合并不复活 → Web 读', () => {
  it('全链路：墓碑保留、合并剔除活跃副本、Web 读隐藏', async () => {
    const { applyWebRemoveTab, mintWebStamp } = await import('@/utils/webTombstone');
    const { serializeTab, deserializeTab } = await import('@/utils/tabDataCodec');
    const { normalizeTabsData } = await import('@/utils/normalizeTabsData');
    const { mergeOpStamped } = await import('@/utils/opStampMerge');

    // 云端现状（扩展此前上传）：t1/t2 均活跃，组 stamp s=7
    const cloudPayload = [serializeTab({ ...mkTab('t1', 'https://a.com'), group_id: 'g1' } as never), serializeTab({ ...mkTab('t2', 'https://b.com'), group_id: 'g1' } as never)];

    // ── Web 写：删 t2 ──
    const stamp = mintWebStamp('devWeb', 7);
    const r = applyWebRemoveTab(cloudPayload, 't2', stamp, NOW, { isLocked: false });
    assert.equal(r.found, true);
    assert.equal(r.alreadyTombstoned, false);
    assert.equal(r.autoDeleteGroup, false);
    // 物理保留：仍是 2 条，t2 为墓碑且双写
    const updated = r.updated as Array<Record<string, unknown>>;
    assert.equal(updated.length, 2);
    const tomb = updated.find(t => t.id === 't2')!;
    assert.equal(tomb.is_deleted, true);
    assert.equal(tomb.isDeleted, true);
    assert.deepEqual(tomb.lastOp, { d: 'devWeb', s: 8 });
    assert.equal(tomb.last_op_device, 'devWeb');
    assert.equal(tomb.last_op_seq, 8);

    // ── 扩展读：下载链还原 ──
    const normalized = normalizeTabsData(updated, 'g1');
    const extTabs = normalized
      .map(td => deserializeTab(td, 'g1'))
      .filter(t => t !== null);
    const extTomb = extTabs.find(t => t.id === 't2')!;
    assert.ok(extTomb, '扩展下载链必须还原出 t2 墓碑');
    assert.equal(extTomb.isDeleted, true);
    assert.deepEqual(extTomb.lastOp, { d: 'devWeb', s: 8 });

    // ── 合并：对端（扩展本地）仍滞留 t2 活跃副本（旧 stamp）──
    const localStale = [{
      id: 'g1', name: 'g1', tabs: [
        { ...mkTab('t1', 'https://a.com'), group_id: 'g1' },
        { ...mkTab('t2', 'https://b.com'), group_id: 'g1', lastOp: { ...OLD_STAMP } },
      ],
      createdAt: EARLIER, updatedAt: EARLIER, isLocked: false, lastOp: { ...OLD_STAMP },
    }];
    const cloudSide = [{
      id: 'g1', name: 'g1', tabs: extTabs,
      createdAt: EARLIER, updatedAt: NOW, isLocked: false, lastOp: { d: 'devWeb', s: 8 },
    }];
    const merged = mergeOpStamped(localStale as never, cloudSide as never);
    const mg = merged.find(g => g.id === 'g1')!;
    assert.ok(mg, '合并结果应保留组 g1');
    assert.equal(mg.tabs.filter(t => !t.isDeleted).some(t => t.id === 't2'), false, '滞留活跃副本不得复活');
    assert.ok(mg.tabs.some(t => t.id === 't2' && t.isDeleted), '墓碑本体保留以向第三方传播');
    assert.ok(mg.tabs.some(t => t.id === 't1' && !t.isDeleted), '无关活跃 tab 不误删');

    // ── Web 读：fetchGroups strip 口径（过滤 isDeleted）──
    const webVisible = mg.tabs.filter(t => !t.isDeleted);
    assert.deepEqual(webVisible.map(t => t.id), ['t1']);
  });

  it('幂等：重复删除已墓碑 tab 不改写载荷', async () => {
    const { applyWebRemoveTab, mintWebStamp } = await import('@/utils/webTombstone');
    const { serializeTab } = await import('@/utils/tabDataCodec');
    const payload = [serializeTab({ ...mkTab('t1', 'https://a.com'), group_id: 'g1' } as never)];
    const first = applyWebRemoveTab(payload, 't1', mintWebStamp('devWeb', 3), NOW, {});
    assert.equal(first.autoDeleteGroup, true); // 删后无活跃 tab → 整组墓碑信号
    const second = applyWebRemoveTab(first.updated, 't1', mintWebStamp('devWeb', 4), NOW, {});
    assert.equal(second.found, true);
    assert.equal(second.alreadyTombstoned, true);
    assert.deepEqual(second.updated, first.updated);
  });

  it('未命中 tab → found=false（调用方抛错，不写云）', async () => {
    const { applyWebRemoveTab, mintWebStamp } = await import('@/utils/webTombstone');
    const { serializeTab } = await import('@/utils/tabDataCodec');
    const payload = [serializeTab({ ...mkTab('t1', 'https://a.com'), group_id: 'g1' } as never)];
    const r = applyWebRemoveTab(payload, 'nope', mintWebStamp('devWeb', 3), NOW, {});
    assert.equal(r.found, false);
  });
});

describe('S5 形状B往返：Web 形 wrapper { tabs, version, displayOrder } → 同口径墓碑', () => {
  it('wrapper 键保留、墓碑双写、扩展链可还原、合并不复活', async () => {
    const { applyWebRemoveTab, mintWebStamp } = await import('@/utils/webTombstone');
    const { normalizeTabsData } = await import('@/utils/normalizeTabsData');
    const { deserializeTab } = await import('@/utils/tabDataCodec');
    const { mergeOpStamped } = await import('@/utils/opStampMerge');

    const wrapper = {
      id: 'g1', name: 'g1', version: 2, displayOrder: 0,
      tabs: [mkTab('t1', 'https://a.com'), mkTab('t2', 'https://b.com')],
    };
    const stamp = mintWebStamp('devWeb', 5);
    const r = applyWebRemoveTab(wrapper, 't1', stamp, NOW, { isLocked: false });
    assert.equal(r.found, true);
    assert.equal(r.autoDeleteGroup, false);
    const updated = r.updated as Record<string, unknown>;
    // wrapper 其余键原样保留
    assert.equal(updated.version, 2);
    assert.equal(updated.displayOrder, 0);
    const tabs = updated.tabs as Array<Record<string, unknown>>;
    assert.equal(tabs.length, 2);
    const tomb = tabs.find(t => t.id === 't1')!;
    assert.equal(tomb.isDeleted, true);
    assert.equal(tomb.is_deleted, true);
    assert.equal(tomb.last_op_seq, 6);

    // 扩展下载链可还原（wrapper 经 normalizeTabsData 恢复为数组）
    const extTabs = normalizeTabsData(updated, 'g1')
      .map(td => deserializeTab(td, 'g1'))
      .filter(t => t !== null);
    const extTomb = extTabs.find(t => t.id === 't1')!;
    assert.equal(extTomb.isDeleted, true);
    assert.deepEqual(extTomb.lastOp, { d: 'devWeb', s: 6 });

    // 合并：对端滞留活跃 t1（旧 stamp s=5，小于 Web 新铸 s=6）不得复活
    const staleB = { d: 'devExt', s: 5 };
    const localStale = [{
      id: 'g1', name: 'g1',
      tabs: [{ ...mkTab('t1', 'https://a.com'), group_id: 'g1', lastOp: { ...staleB } }],
      createdAt: EARLIER, updatedAt: EARLIER, isLocked: false, lastOp: { ...staleB },
    }];
    const cloudSide = [{
      id: 'g1', name: 'g1', tabs: extTabs,
      createdAt: EARLIER, updatedAt: NOW, isLocked: false, lastOp: { d: 'devWeb', s: 6 },
    }];
    const merged = mergeOpStamped(localStale as never, cloudSide as never);
    const mg = merged.find(g => g.id === 'g1')!;
    assert.deepEqual(mg.tabs.filter(t => !t.isDeleted).map(t => t.id), ['t2'], '滞留活跃 t1 不得复活，无关活跃 t2 保留');
    assert.ok(mg.tabs.some(t => t.id === 't1' && t.isDeleted), '墓碑本体保留');
  });

  it('锁定组删空 → 不整组墓碑（tab 墓碑仍保留在载荷内）', async () => {
    const { applyWebRemoveTab, mintWebStamp } = await import('@/utils/webTombstone');
    const wrapper = {
      id: 'g1', name: 'g1', version: 1,
      tabs: [mkTab('t1', 'https://a.com')],
    };
    const r = applyWebRemoveTab(wrapper, 't1', mintWebStamp('devWeb', 1), NOW, { isLocked: true });
    assert.equal(r.found, true);
    assert.equal(r.autoDeleteGroup, false);
    const tabs = (r.updated as Record<string, unknown>).tabs as Array<Record<string, unknown>>;
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].isDeleted, true);
  });

  it('历史墓碑不计活跃：仅剩墓碑 + 删最后一个活跃 → 整组墓碑信号', async () => {
    const { applyWebRemoveTab, mintWebStamp } = await import('@/utils/webTombstone');
    const { serializeTab } = await import('@/utils/tabDataCodec');
    const t2 = serializeTab({ ...mkTab('t2', 'https://b.com'), group_id: 'g1' } as never);
    (t2 as Record<string, unknown>).is_deleted = true; // 历史墓碑
    const payload = [serializeTab({ ...mkTab('t1', 'https://a.com'), group_id: 'g1' } as never), t2];
    const r = applyWebRemoveTab(payload, 't1', mintWebStamp('devWeb', 2), NOW, {});
    assert.equal(r.autoDeleteGroup, true);
  });
});
