// Web 删除语义（无墓碑模型，2026-09-29）· 往返锁定测试：
// Web 物理移除 tab + 组 stamp 提升 → 扩展下载合并整组覆盖 → 不复活。
//
// 覆盖两种云端载荷形状：
//   A. 扩展写入形：TabData[]（snake_case，serializeTab 产物，加密前形态）
//   B. Web/旧客户端写入形：wrapper 对象 { tabs: Tab[]（camelCase）, version, displayOrder }
//
// 不变量（与扩展端 applyRemoveTab / mergeOpStamped 组级 LWW 同口径）：
//   1. Web 删除后目标 tab 从载荷中**物理消失**（无墓碑双写），其余形状/键保留
//   2. 组 stamp 提升（OLD+1）→ 扩展本地滞留的旧 stamp 副本在下轮合并被整组覆盖 → 不复活
//   3. 删空未锁定组 → autoDeleteGroup=true（调用方对整行做删除广播）
//   4. 幂等：重复删除不存在的 tab → found=false，不写云
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

describe('mintWebStamp: 归属写者本设备，序号压过两个下界', () => {
  it('云端 seq=7 → 新 stamp s=8 且 d=本设备', async () => {
    const { mintWebStamp } = await import('@/core/webTombstone');
    assert.deepEqual(mintWebStamp('devWeb', 7), { d: 'devWeb', s: 8 });
  });

  it('云端无印记（null）→ 从 s=1 起', async () => {
    const { mintWebStamp } = await import('@/core/webTombstone');
    assert.deepEqual(mintWebStamp('devWeb', null), { d: 'devWeb', s: 1 });
    assert.deepEqual(mintWebStamp('devWeb', undefined), { d: 'devWeb', s: 1 });
  });

  it('观测到更高印记时取观测值 +1，不退回裸 OLD+1', async () => {
    const { mintWebStamp } = await import('@/core/webTombstone');
    // 本行 OLD 只有 3，但同一账号别的行已被推到 12 → 必须铸 13
    assert.deepEqual(mintWebStamp('devWeb', 3, 12), { d: 'devWeb', s: 13 });
    // 观测值低于本行 OLD 时取本行 OLD（服务端严格 LT 守卫放行优先）
    assert.deepEqual(mintWebStamp('devWeb', 30, 12), { d: 'devWeb', s: 31 });
    // 观测值缺省 / 0 / null 时退化成裸 OLD+1，与修复前同口径
    assert.deepEqual(mintWebStamp('devWeb', 7, 0), { d: 'devWeb', s: 8 });
    assert.deepEqual(mintWebStamp('devWeb', 7, null), { d: 'devWeb', s: 8 });
  });

  // 回归钉子：裸 OLD+1 会输掉对端已上传的更高印记，导致用户在网页上的删除被静默撤销。
  // 这条在加入 Lamport 下限之前必然失败。
  it('回归：Web 铸的删除 stamp 必须赢过对端已上传的更高印记', async () => {
    const { mintWebStamp } = await import('@/core/webTombstone');
    const { compareStamps } = await import('@/core/opStamp');

    // 对端设备 E 已把本组上传到 {E,12}；本行 OLD 仍是 8（Web 读到的就是 8）
    const remote = { d: 'devE', s: 12 };

    // 修复前的铸法：裸 OLD+1 = 9 → 输给对端，删除被撤销
    const naive = { d: 'devWeb', s: 8 + 1 };
    assert.equal(compareStamps(remote, naive), 1, '裸 OLD+1 确实会输（这正是被修掉的 bug）');

    // 修复后：观察到全表最大值 12 → 铸 13 → 赢过对端
    const fixed = mintWebStamp('devWeb', 8, 12);
    assert.equal(compareStamps(fixed, remote), 1, 'Web 的删除印记必须压过对端');
    assert.equal(compareStamps(remote, fixed), -1);
  });
});

describe('形状A：扩展形 TabData[] → Web 物理移除 → 合并整组覆盖', () => {
  it('删除后目标 tab 物理消失，广播经组 stamp 提升 + 整组覆盖传播', async () => {
    const { applyWebRemoveTab, mintWebStamp } = await import('@/core/webTombstone');
    const { serializeTab, deserializeTab } = await import('@/core/tabDataCodec');
    const { normalizeTabsData } = await import('@/core/normalizeTabsData');
    const { mergeOpStamped } = await import('@/core/opStampMerge');

    // 云端现状（扩展此前上传）：t1/t2 均活跃，组 stamp s=7
    const cloudPayload = [serializeTab({ ...mkTab('t1', 'https://a.com'), group_id: 'g1' } as never), serializeTab({ ...mkTab('t2', 'https://b.com'), group_id: 'g1' } as never)];

    // ── Web 写：删 t2（物理移除，组 stamp OLD+1）──
    const stamp = mintWebStamp('devWeb', 7);
    // 整条链的承重不变量：Web 铸出的删除印记必须严格压过上传前云端那枚 s=7。
    // 本地之所以会输、t2 之所以不复活，全靠这一条；以前这里是写死的字面量 8，
    // 铸出来却不用，等于没人验证过「Web 的 stamp 一定比旧的大」。
    assert.ok(stamp.s > 7, `Web 铸出的删除印记必须大于云端原有的 7，实得 ${stamp.s}`);
    const r = applyWebRemoveTab(cloudPayload, 't2', { isLocked: false });
    assert.equal(r.found, true);
    assert.equal(r.autoDeleteGroup, false);
    const updated = r.updated as Array<Record<string, unknown>>;
    assert.equal(updated.length, 1, '目标 tab 从载荷中物理消失');
    assert.equal(updated[0].id, 't1');
    assert.equal(updated.some(t => (t as { is_deleted?: boolean }).is_deleted), false, '无墓碑双写');

    // ── 扩展读：下载链还原（无墓碑模型下无 is_deleted 噪音）──
    const normalized = normalizeTabsData(updated, 'g1');
    const extTabs = normalized
      .map(td => deserializeTab(td, 'g1'))
      .filter(t => t !== null);
    assert.deepEqual(extTabs.map(t => t!.id), ['t1']);

    // ── 合并：扩展本地滞留 t2 活跃副本（旧组 stamp s=7）──
    //    云端组 stamp 已被 Web 删除提升为 s=8 → 整组覆盖，本地整组输
    const localStale = [{
      id: 'g1', name: 'g1', tabs: [
        { ...mkTab('t1', 'https://a.com'), group_id: 'g1' },
        { ...mkTab('t2', 'https://b.com'), group_id: 'g1' },
      ],
      createdAt: EARLIER, updatedAt: EARLIER, isLocked: false, lastOp: { ...OLD_STAMP },
    }];
    const cloudSide = [{
      id: 'g1', name: 'g1', tabs: extTabs,
      createdAt: EARLIER, updatedAt: NOW, isLocked: false, lastOp: { ...stamp },
    }];
    const merged = mergeOpStamped(localStale as never, cloudSide as never);
    const mg = merged.find(g => g.id === 'g1')!;
    assert.ok(mg, '合并结果应保留组 g1');
    assert.equal(mg.tabs.some(t => t.id === 't2'), false, '被删的 t2 不复活（整组覆盖）');
    assert.deepEqual(mg.tabs.map(t => t.id), ['t1']);
  });

  it('未命中 tab → found=false（调用方抛错，不写云）', async () => {
    const { applyWebRemoveTab } = await import('@/core/webTombstone');
    const { serializeTab } = await import('@/core/tabDataCodec');
    const payload = [serializeTab({ ...mkTab('t1', 'https://a.com'), group_id: 'g1' } as never)];
    const r = applyWebRemoveTab(payload, 'nope', {});
    assert.equal(r.found, false);
    assert.deepEqual(r.updated, payload, '未命中时载荷原样返回');
  });
});

describe('形状B：Web 形 wrapper { tabs, version, displayOrder } → 物理移除', () => {
  it('wrapper 其余键保留、目标 tab 消失、扩展链可还原', async () => {
    const { applyWebRemoveTab } = await import('@/core/webTombstone');
    const { normalizeTabsData } = await import('@/core/normalizeTabsData');
    const { deserializeTab } = await import('@/core/tabDataCodec');

    const wrapper = {
      id: 'g1', name: 'g1', version: 2, displayOrder: 0,
      tabs: [mkTab('t1', 'https://a.com'), mkTab('t2', 'https://b.com')],
    };
    const r = applyWebRemoveTab(wrapper, 't1', { isLocked: false });
    assert.equal(r.found, true);
    assert.equal(r.autoDeleteGroup, false);
    const updated = r.updated as Record<string, unknown>;
    // wrapper 其余键原样保留
    assert.equal(updated.version, 2);
    assert.equal(updated.displayOrder, 0);
    const tabs = updated.tabs as Array<Record<string, unknown>>;
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].id, 't2');

    // 扩展下载链可还原（wrapper 经 normalizeTabsData 恢复为数组）
    const extTabs = normalizeTabsData(updated, 'g1')
      .map(td => deserializeTab(td, 'g1'))
      .filter(t => t !== null);
    assert.deepEqual(extTabs.map(t => t!.id), ['t2']);
  });

  it('锁定组删空 → tabs 保留为空数组，autoDeleteGroup=false（锁定豁免）', async () => {
    const { applyWebRemoveTab } = await import('@/core/webTombstone');
    const wrapper = {
      id: 'g1', name: 'g1', version: 1,
      tabs: [mkTab('t1', 'https://a.com')],
    };
    const r = applyWebRemoveTab(wrapper, 't1', { isLocked: true });
    assert.equal(r.found, true);
    assert.equal(r.autoDeleteGroup, false);
    const tabs = (r.updated as Record<string, unknown>).tabs as Array<Record<string, unknown>>;
    assert.equal(tabs.length, 0);
  });

  it('未锁定组删掉最后一个 tab → autoDeleteGroup=true（整行删除广播信号）', async () => {
    const { applyWebRemoveTab } = await import('@/core/webTombstone');
    const wrapper = {
      id: 'g1', name: 'g1', version: 1,
      tabs: [mkTab('t1', 'https://a.com')],
    };
    const r = applyWebRemoveTab(wrapper, 't1', { isLocked: false });
    assert.equal(r.found, true);
    assert.equal(r.autoDeleteGroup, true);
    const tabs = (r.updated as Record<string, unknown>).tabs as Array<Record<string, unknown>>;
    assert.equal(tabs.length, 0);
  });
});
