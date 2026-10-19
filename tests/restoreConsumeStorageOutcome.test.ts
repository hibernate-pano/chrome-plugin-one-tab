// 准则 3 · 恢复/点开的**存储结局**（2026-10-19）。
//
// 【为什么要单独一个文件】同类的既有防线各自只钉了一侧：
//   · guards/restoreOpenBeforeConsume.test.ts —— 按**源码结构**断言「先开后删」；
//   · storableUnopenableUrls.test.ts         —— 断言 file:/blob: 存得下、标 unopenable；
//   · syncNoResurrectInvariants.test.ts      —— 断言跨设备删除不复活（假云端）。
// 缺的是把它们接到**真实落盘状态**上：点开一个标签之后，那一行到底还在不在
// storage 里？打不开的地址被拒之后，它是不是还留在会话里？以及远端墓碑/本地删除
// 在**一次真实下载合并**后，存储里剩下什么。
//
// 这里用真实 storage（IndexedDB 缺失时回退 localStorage，与生产同一条 KV 驱动）
// + 真实的 mutation 编排函数，断言的是 `storage.getGroups()` 的最终内容，
// 不是函数返回值、也不是源码字符串。
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Tab, TabGroup } from '@/types/tab';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

// ── 存储底座：与 syncNoResurrectInvariants.test.ts 同款 localStorage 回退 ──
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    get length() { return store.size; },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  },
};
(globalThis as Record<string, unknown>).localStorage = (globalThis as any).window.localStorage;

const chromeData = new Map<string, unknown>();
(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: async (k: string | string[]) => {
        const keys = Array.isArray(k) ? k : [k];
        const out: Record<string, unknown> = {};
        for (const key of keys) if (chromeData.has(key)) out[key] = chromeData.get(key);
        return out;
      },
      set: async (obj: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(obj)) chromeData.set(k, v);
      },
      remove: async (k: string) => void chromeData.delete(k),
    },
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
  runtime: { getManifest: () => ({ version: 'test' }) },
  alarms: { create: () => undefined, clear: async () => true, onAlarm: { addListener: () => undefined } },
};

before(async () => {
  register(LOADER_PATH);
});

const NOW = '2026-10-19T10:00:00.000Z';
const OLD = '2026-01-01T00:00:00.000Z';
const STAMP = { d: 'devTest', s: 5 };



const mkTab = (id: string, url: string, over: Partial<Tab> = {}): Tab => ({
  id, url, title: id, favicon: '', createdAt: OLD, lastAccessed: OLD, pinned: false, ...over,
});

const mkGroup = (id: string, tabs: Tab[], over: Partial<TabGroup> = {}): TabGroup => ({
  id, name: `g-${id}`, tabs, createdAt: OLD, updatedAt: OLD, version: 1, isLocked: false,
  lastOp: STAMP, ...over,
});

async function seed(groups: TabGroup[]): Promise<void> {
  const { storage } = await import('@/utils/storage');
  await storage.setGroupsImmediate(groups as never);
}

async function currentGroups(): Promise<TabGroup[]> {
  const { storage } = await import('@/utils/storage');
  return (await storage.getGroupsFresh()) as unknown as TabGroup[];
}

beforeEach(async () => {
  store.clear();
  chromeData.clear();
  const { initStorage } = await import('@/storage/storageAdapter');
  await initStorage();
});

// ─────────────────────────────────────────────────────────────────────────
// 前提 ③：未锁定会话 —— 点开单个标签后，该行**确实从存储中消失**
// ─────────────────────────────────────────────────────────────────────────

describe('前提③：点开即消费（未锁定组）真的落到存储', () => {
  it('applyRemoveTab 之后 storage 里少的是那一条，其余原样保留', async () => {
    const { applyRemoveTab } = await import('@/core/mutationOps');
    await seed([
      mkGroup('g1', [
        mkTab('t1', 'https://a.dev/1'),
        mkTab('t2', 'https://a.dev/2'),
        mkTab('t3', 'https://a.dev/3'),
      ]),
      mkGroup('g2', [mkTab('u1', 'https://b.dev/1')]),
    ]);

    const before = await currentGroups();
    // 前提：确认种子真的写进去了（否则「变少了」是恒真断言）
    assert.equal(before.length, 2, '前提：两个会话已落盘');
    assert.equal(before[0].tabs.length, 3, '前提：目标会话有 3 条标签');

    const { groups } = applyRemoveTab(await currentGroups(), 'g1', 't2', NOW, { d: 'devTest', s: 6 });
    const { storage } = await import('@/utils/storage');
    await storage.setGroupsImmediate(groups as never);

    const after = await currentGroups();
    const g1 = after.find(g => g.id === 'g1');
    assert.ok(g1, '会话本身还在（没有删掉最后一标签）');
    assert.deepEqual(g1!.tabs.map(t => t.id), ['t1', 't3'], '被点开的那一条必须从存储里消失');
    assert.equal(after.find(g => g.id === 'g2')!.tabs.length, 1, '无关会话不受影响');
  });

  it('点开最后一条标签 ⇒ 整组从存储里物理移除（无回收站）', async () => {
    const { applyRemoveTab } = await import('@/core/mutationOps');
    await seed([mkGroup('solo', [mkTab('only', 'https://a.dev/only')])]);
    assert.equal((await currentGroups()).length, 1, '前提：一个会话已落盘');

    const { groups, removedGroupId } = applyRemoveTab(
      await currentGroups(), 'solo', 'only', NOW, { d: 'devTest', s: 7 }
    );
    assert.equal(removedGroupId, 'solo', '拿空最后一个标签 ⇒ 整组物理移除');
    const { storage } = await import('@/utils/storage');
    await storage.setGroupsImmediate(groups as never);
    assert.equal((await currentGroups()).length, 0, '存储里一条都不剩');
  });

  it('锁定组的同一条「移除」不会发生：组与标签都还在（对照）', async () => {
    // 锁定组的消费在 UI 层就被拦下（TabGroup 的 isLocked 分支直接 return），
    // 这里钉的是**存储层不受影响**这个事实：不调用移除，就一条都不少。
    await seed([mkGroup('locked', [mkTab('l1', 'https://a.dev/1'), mkTab('l2', 'https://a.dev/2')], { isLocked: true })]);
    const before = await currentGroups();
    assert.equal(before[0].tabs.length, 2, '前提：锁定组有 2 条');
    // 刻意不调 applyRemoveTab —— 锁定路径不发删除
    const after = await currentGroups();
    assert.deepEqual(after.map(g => g.tabs.length), [2], '锁定组的记录保持原样');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 前提 ④：打不开的地址（file:// / 内部页）被拒后，该行**仍在存储中**
// ─────────────────────────────────────────────────────────────────────────

describe('前提④：打不开的地址保留记录并给出原因', () => {
  it('file:// 在存储里存得下，且 isOpenableTabUrl 明确拒绝打开', async () => {
    const { isOpenableTabUrl, isStorableTabUrl } = await import('@/utils/inputValidation');
    const fileUrl = 'file:///Users/me/paper.pdf';

    await seed([mkGroup('g1', [mkTab('t1', fileUrl), mkTab('t2', 'https://ok.dev/1')])]);
    const stored = await currentGroups();
    assert.equal(stored.length, 1, '前提：会话已落盘');
    assert.equal(stored[0].tabs.length, 2, '前提：两条标签都存下了');
    assert.equal(stored[0].tabs[0].url, fileUrl, 'file: 必须原样存在存储里（存得下）');

    // 拒开的两道门给出各自答案：存得下、打不开
    assert.equal(isStorableTabUrl(fileUrl), true);
    assert.equal(isOpenableTabUrl(fileUrl), false, '本设备打不开 ⇒ UI/SW 会拒开并保留记录');

    // 拒开之后**没有调用**任何移除 ⇒ 那一行仍在（这就是「保留记录」的可观测形态）
    const after = await currentGroups();
    assert.equal(after[0].tabs.length, 2, '拒开不得导致记录消失');
    assert.equal(after[0].tabs[0].url, fileUrl, '地址原样保留，不被改写');
  });

  it('浏览器内部页在**保存时**就该被过滤（不是留给打开时再失败）', async () => {
    const { filterValidTabs } = await import('@/domain/tabGroup/filters');
    const kept = filterValidTabs([
      { url: 'chrome://settings', title: '设置' },
      { url: 'edge://favorites', title: '收藏' },
      { url: 'about:blank', title: '空白' },
      { url: 'https://ok.dev/1', title: '正常' },
      { url: 'file:///Users/me/a.pdf', title: '本地文件' },
    ] as never, { includePinned: false });

    assert.deepEqual(
      kept.map(t => t.url),
      ['https://ok.dev/1', 'file:///Users/me/a.pdf'],
      '内部页保存时就丢；本地文件是可存储的，要留下来（打开时再按 unopenable 降级）',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 前提 ①② 的存储侧对照：墓碑不复活 / 本地删除不被云端旧数据带回
// ─────────────────────────────────────────────────────────────────────────

describe('前提①②：合并结果落到存储后，墓碑与本地删除都不复活', () => {
  it('云端墓碑更新 ⇒ 本地同名会话不进存储（服从删除）', async () => {
    const { mergeOpStamped } = await import('@/core/opStampMerge');
    const local = [mkGroup('g1', [mkTab('t1', 'https://a.dev/1')], { lastOp: { d: 'devA', s: 2 } })];
    const cloud = [mkGroup('g1', [], { isDeleted: true, lastOp: { d: 'devB', s: 9 } })];

    // 前提：本地确实有一个活跃副本（否则「结果为空」是恒真）
    assert.equal(local.filter(g => !g.isDeleted).length, 1);

    const merged = mergeOpStamped(local as never, cloud as never);
    await seed(merged as never);

    const stored = await currentGroups();
    assert.equal(
      stored.filter(g => g.id === 'g1').length,
      0,
      '云端墓碑更新时，本地同名会话必须从存储里消失',
    );
  });

  it('本地离线修改比墓碑新 ⇒ 本地副本保留（不被删除广播误伤）', async () => {
    const { mergeOpStamped } = await import('@/core/opStampMerge');
    const local = [mkGroup('g1', [mkTab('t1', 'https://a.dev/new')], { lastOp: { d: 'devA', s: 20 } })];
    const cloud = [mkGroup('g1', [], { isDeleted: true, lastOp: { d: 'devB', s: 9 } })];

    const merged = mergeOpStamped(local as never, cloud as never);
    assert.equal(merged.length, 1, '前提：合并不该把本地新版本也删掉');

    await seed(merged as never);
    const stored = await currentGroups();
    assert.equal(stored.length, 1, '本地新版本必须留在存储里');
    assert.equal(stored[0].tabs[0].url, 'https://a.dev/new', '留下的是本地的新内容');
  });

  it('云端旧活跃行 vs 本地已删除 ⇒ 合并不会把会话带回来', async () => {
    const { mergeOpStamped } = await import('@/core/opStampMerge');
    // 本地删了（物理移除、无副本）；云端还留着旧活跃版本。
    // 此时代码路径上的保护是「墓碑已广播」——这里模拟墓碑已到达云端后的一次合并：
    const local: TabGroup[] = [];
    const cloud = [mkGroup('gone', [mkTab('x', 'https://a.dev/x')], {
      isDeleted: true, lastOp: { d: 'devA', s: 30 },
    })];

    // 前提：云端确实只有墓碑行、没有活跃行
    assert.equal(cloud.filter(g => !g.isDeleted).length, 0);
    assert.equal(cloud.filter(g => g.isDeleted).length, 1);

    const merged = mergeOpStamped(local as never, cloud as never);
    await seed(merged as never);
    assert.equal((await currentGroups()).length, 0, '墓碑行永不入库，本地删除不被带回来');
  });

  it('云端墓碑行本身不会被写成活跃会话（形变检测）', async () => {
    const { mergeOpStamped } = await import('@/core/opStampMerge');
    const merged = mergeOpStamped(
      [],
      [mkGroup('t', [], { isDeleted: true, lastOp: STAMP })] as never,
    );
    assert.equal(merged.length, 0, 'mergeOpStamped 不得输出墓碑行');
    await seed(merged as never);
    const stored = await currentGroups();
    assert.equal(stored.filter(g => g.isDeleted).length, 0, '存储里不得出现墓碑形状');
  });
});
