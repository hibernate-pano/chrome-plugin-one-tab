// 钉死本设备 seq 计数器（规格 §4.1 + Lamport 修订）：
// - nextSeq 单调递增且持久化；重启后从持久化恢复
// - **观察到的全网（含他设备）最大印记必须被超越** —— 这是跨设备可比性的唯一来源，
//   也是「新设备/重装设备编辑被云端回滚」这个 P0 的回归防线
// - 每次取号都重新推导，不缓存旧基线（下载合并中途带进高印记时必须立刻生效）
//
// 文件样板与 tests/mutationOps.test.ts 一致：@/ 别名需在 register(loader) 之后动态 import。
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

type Deps = {
  kvGet: <T>(k: string) => Promise<T | null>;
  kvSet: (k: string, v: unknown) => Promise<void>;
  getGroups: () => Promise<unknown[]>;
};

function makeDeps(kv: Map<string, unknown>, groupsRef: { current: unknown[] }): Deps {
  return {
    kvGet: async <T>(k: string) => (kv.get(k) ?? null) as T | null,
    kvSet: async (k: string, v: unknown) => { kv.set(k, v); },
    getGroups: async () => groupsRef.current,
  };
}

describe('seqRegistry: 本设备 seq 计数器（Lamport）', () => {
  it('nextSeq 单调递增且持久化', async () => {
    const { createSeqRegistry } = await import('@/utils/seqRegistry');
    const kv = new Map<string, unknown>();
    const reg = createSeqRegistry(makeDeps(kv, { current: [] }) as any);
    assert.equal(await reg.getDeviceSeq(), 0);
    assert.equal(await reg.nextSeq(), 1);
    assert.equal(await reg.nextSeq(), 2);
    assert.equal(await reg.getDeviceSeq(), 2);
  });

  it('重启后从持久化恢复，不重复发号', async () => {
    const { createSeqRegistry } = await import('@/utils/seqRegistry');
    const kv = new Map<string, unknown>([['device_seq', 5]]);
    const reg = createSeqRegistry(makeDeps(kv, { current: [] }) as any);
    assert.equal(await reg.getDeviceSeq(), 5);
    assert.equal(await reg.nextSeq(), 6);
  });

  // ★ P0 回归：旧实现只看「本设备」印记，新设备 seq 从 0 起 → 永远发不过老设备
  it('必须超越观察到的他设备印记（新设备不再发出过小序号）', async () => {
    const { createSeqRegistry } = await import('@/utils/seqRegistry');
    const kv = new Map<string, unknown>(); // 全新设备：无持久化序号、无自身印记
    const groups = {
      current: [
        { id: 'g1', lastOp: { d: 'devA', s: 400 } }, // 老设备几百号
        { id: 'g2', tabs: [{ id: 't1', lastOp: { d: 'devA', s: 380 } }] },
      ],
    };
    const reg = createSeqRegistry(makeDeps(kv, groups) as any);
    const seq = await reg.nextSeq();
    assert.ok(seq > 400, `新设备首个序号 ${seq} 必须大于观察到的最大印记 400，否则上传被触发器拒收、本地被云端覆盖`);
    assert.equal(kv.get('device_seq'), seq);
  });

  it('不需要在下载后重启：新观察到的印记立即影响下一个序号', async () => {
    const { createSeqRegistry } = await import('@/utils/seqRegistry');
    const kv = new Map<string, unknown>([['device_seq', 1]]);
    const groups = { current: [{ id: 'g1', lastOp: { d: 'devA', s: 1 } }] as unknown[] };
    const reg = createSeqRegistry(makeDeps(kv, groups) as any);
    assert.equal(await reg.nextSeq(), 2);

    // 模拟 SW 存活期间发生的下载合并：把云端（他设备高印记）写进本地
    groups.current = [{ id: 'g1', lastOp: { d: 'devB', s: 900 } }];
    assert.equal(
      await reg.nextSeq(),
      901,
      '缓存的旧基线会让本设备继续发小号：上传被吞、本地编辑被云端回滚'
    );
  });

  it('本地印记被合并覆盖后序号仍不回退（持久化值为地板）', async () => {
    const { createSeqRegistry } = await import('@/utils/seqRegistry');
    const kv = new Map<string, unknown>([['device_seq', 300]]);
    // 本地已无本设备印记（被云端赢的合并覆盖掉），持久化值必须仍然兜住
    const reg = createSeqRegistry(makeDeps(kv, { current: [{ id: 'g1', lastOp: { d: 'devB', s: 10 } }] }) as any);
    assert.equal(await reg.nextSeq(), 301);
  });

  it('bumpSeqIfLower 仅在 candidate 更高时更新', async () => {
    const { createSeqRegistry } = await import('@/utils/seqRegistry');
    const kv = new Map<string, unknown>([['device_seq', 100]]);
    const reg = createSeqRegistry(makeDeps(kv, { current: [] }) as any);
    assert.equal(await reg.bumpSeqIfLower(50), 100); // 不更新
    assert.equal(await reg.bumpSeqIfLower(150), 150); // 更新
    assert.equal(await reg.getDeviceSeq(), 150);
  });

  it('tab 级印记也计入观察值（removeTab 的墓碑不能反过来输给后续编辑）', async () => {
    const { createSeqRegistry } = await import('@/utils/seqRegistry');
    const kv = new Map<string, unknown>();
    const groups = { current: [{ id: 'g1', tabs: [{ id: 't1', lastOp: { d: 'devA', s: 77 } }] }] };
    const reg = createSeqRegistry(makeDeps(kv, groups) as any);
    assert.ok((await reg.nextSeq()) > 77);
  });
});

// ── 跨设备端到端（组合 seqRegistry + mutationOps + mergeOpStamped）──────────
// 这是「换机/重装/清扩展数据后编辑什么都存不住」那个 P0 的完整回归：
// 单独看每个模块都没错，错的是它们组合后的跨设备语义。
describe('跨设备端到端：新设备的编辑必须能胜出', () => {
  const T = '2026-01-01T00:00:00.000Z';
  const cloudRow = {
    id: 'g1', name: '云端名', tabs: [], createdAt: T, updatedAt: T,
    version: 5, isDeleted: false, isLocked: false, lastOp: { d: 'devA', s: 400 },
  };

  it('全新设备（无持久化序号、无自身印记）改名后：上传不被守卫拒收、合并不被云端回滚', async () => {
    const { createSeqRegistry } = await import('@/utils/seqRegistry');
    const { applyRenameGroup } = await import('@/utils/mutationOps');
    const { mergeOpStamped } = await import('@/utils/opStampMerge');

    // 设备 B：本地内容 = 刚从云端下载到的行；device_seq 为空（全新安装）
    const kv = new Map<string, unknown>();
    const groupsRef = { current: [{ ...cloudRow }] as unknown[] };
    const reg = createSeqRegistry(makeDeps(kv, groupsRef) as any);

    const stamp = { d: 'devB', s: await reg.nextSeq() };
    const localGroups = applyRenameGroup(groupsRef.current as any, 'g1', 'B 改的名', T, stamp).groups;

    // 服务端守卫（20260910 修复版）：NEW.s >= OLD.s 才放行
    assert.ok(
      stamp.s >= 400,
      `B 发出的 s=${stamp.s} 不大于云端 400 → 上传被触发器静默丢弃，本地又被云端覆盖`
    );
    // 客户端合并：必须判 B 赢，否则下次下载就把改名回滚掉
    const merged = mergeOpStamped(localGroups as any, [{ ...cloudRow }] as any);
    assert.equal(merged[0].name, 'B 改的名');
  });

  it('两台设备交替编辑：后观察者后写必胜（Lamport 因果序）', async () => {
    const { createSeqRegistry } = await import('@/utils/seqRegistry');
    const { mergeOpStamped } = await import('@/utils/opStampMerge');

    // B 先编辑（观察过 A 的 400）
    const kvB = new Map<string, unknown>();
    const regB = createSeqRegistry(makeDeps(kvB, { current: [{ ...cloudRow }] }) as any);
    const stampB = { d: 'devB', s: await regB.nextSeq() };

    // A 随后看到 B 的写入，再编辑
    const observedByA = { id: 'g1', name: 'B 的名', tabs: [], createdAt: T, updatedAt: T, version: 6, isDeleted: false, isLocked: false, lastOp: stampB };
    const kvA = new Map<string, unknown>([['device_seq', 400]]);
    const regA = createSeqRegistry(makeDeps(kvA, { current: [observedByA] }) as any);
    const stampA = { d: 'devA', s: await regA.nextSeq() };

    assert.ok(stampA.s > stampB.s, 'A 在见过 B 的写入后必须发出更大的序号');
  });
});
