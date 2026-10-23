// 云端差量（增量下载）的判据与等价性守卫（2026-10-23，第 53 轮）。
//
// ── 这个文件在防什么 ───────────────────────────────────────────────────────
//
// 云端出网（egress）按「发出去多少字节」计，Free 档 5GB / 30 天，
// 而**超配额是项目级封禁**（连 /auth/v1/health 都返回 402 ⇒ 整个项目不可用，
//   不是「某个用户慢一点」）。
//
// 全量下载 `select *` 会把**每一行**的加密 tabs_data 都拉回来
// （实测：100 组 × 10 标签时 tabs_data 占响应体 **93.5%**），
// 而绝大多数行**根本没变**。后台同步每 10 分钟一轮 ⇒ 一天 144 轮 ⇒
// 出网量 ∝ 库大小 × 轮数 × 设备数 ⇒ 用户一多就撞穿配额。
//
// ⇒ 解法不是「少同步几轮」（那是把症状压小），而是**让每轮只传真正变了的那几行**。
//   而这只有在「用本地副本代表没变的云端行」与「回源取回云端内容」
//   **产生完全相同的合并结果**时才成立 —— 那正是本文件要钉住的不变量。
//
// ── 断言钉的是**不变量**，不是字面量 ───────────────────────────────────────
//
// 核心断言：「差量装配出来的云端集合」与「全量下载拿到的云端集合」
// 喂给 mergeOpStamped 之后，**合并结果必须逐字相同**。
// 这条断言同时覆盖了：印记决胜方向、墓碑处理、云端新增、本地独有、
// 本地墓碑残留 —— 全部由 mergeOpStamped 的真实语义判定，
// 而不是由本文件另写一套「我认为应该怎样」。
//
// ⚠️ 为什么不能只断言「payloadIds 的长度」：那只证明「少取了几行」，
//   证明不了「少取的那几行不影响结果」—— 而后者才是数据安全的全部。
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
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOADER_PATH = pathToFileURL(resolve(ROOT, 'tests/_alias-loader.mjs')).href;

type CloudDeltaModule = typeof import('../src/core/cloudDelta.ts');
type MergeModule = typeof import('../src/core/opStampMerge.ts');
type TabGroup = import('../src/types/tab.ts').TabGroup;
type GroupDigestLike = import('../src/core/syncDecision.ts').GroupDigestLike;

let cloudDelta: CloudDeltaModule;
let mergeOpStamped: MergeModule['mergeOpStamped'];

before(async () => {
  register(LOADER_PATH, import.meta.url);
  cloudDelta = await import('../src/core/cloudDelta.ts');
  ({ mergeOpStamped } = await import('../src/core/opStampMerge.ts'));
});

const NOW = '2026-10-23T08:00:00.000Z';
const LATER = '2026-10-23T09:00:00.000Z';

function tab(id: string) {
  return {
    id,
    url: `https://${id}.example.com/`,
    title: id,
    createdAt: NOW,
    lastAccessed: NOW,
    pinned: false,
  };
}

/** 本地活跃组（有 tab、有印记） */
function localGroup(id: string, seq: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `g-${id}`,
    tabs: [tab(`${id}-t1`)],
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    version: 1,
    lastOp: { d: 'devA', s: seq },
    ...overrides,
  } as unknown as TabGroup;
}

/** 云端指纹行（探活拉回来的形状） */
function digestRow(
  id: string,
  overrides: Partial<GroupDigestLike> = {}
): GroupDigestLike {
  return {
    id,
    updated_at: NOW,
    version: 1,
    is_deleted: false,
    last_op_device: 'devA',
    last_op_seq: 1,
    ...overrides,
  };
}

/**
 * 由指纹行 + 内容造出一个「全量下载会拿到的」云端组。
 *
 * 字段的取法必须与 utils/supabase/download.ts 的构造**一致**
 * （否则本文件比的就不是「真实全量下载」而是「我想象中的全量下载」）。
 */
function cloudGroupOf(row: GroupDigestLike, name = `g-${row.id}`): TabGroup {
  return {
    id: String(row.id),
    name,
    tabs: [tab(`${row.id}-t1`)],
    createdAt: String(row.updated_at),
    updatedAt: String(row.updated_at),
    isLocked: false,
    isDeleted: row.is_deleted === true,
    ...(typeof row.last_op_seq === 'number' && row.last_op_device
      ? { lastOp: { d: String(row.last_op_device), s: row.last_op_seq } }
      : {}),
    ...(typeof row.version === 'number' ? { version: row.version } : {}),
  } as unknown as TabGroup;
}

/** 全量下载的排序口径：created_at DESC, id DESC */
function sortLikeDownload(groups: TabGroup[]): TabGroup[] {
  return [...groups].sort((a, b) => {
    const ta = Date.parse(a.createdAt);
    const tb = Date.parse(b.createdAt);
    const va = Number.isNaN(ta) ? 0 : ta;
    const vb = Number.isNaN(tb) ? 0 : tb;
    if (va !== vb) return vb - va;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/**
 * 跑一遍「全量下载」与「增量装配」两条路，比合并结果。
 *
 * @param localGroups      本地活跃组（合并输入口径）
 * @param localTombstones  本地墓碑残留的 id
 * @param cloudRows        云端全部行（指纹）
 * @param cloudContent     每一行的内容（造 cloudGroupOf 用的名字）
 */
function assertSameMergeOutcome(opts: {
  localGroups: TabGroup[];
  localTombstones?: string[];
  cloudRows: GroupDigestLike[];
  cloudContent?: Record<string, string>;
}): void {
  const localTombstones = opts.localTombstones ?? [];
  const content = opts.cloudContent ?? {};

  // ① 全量下载：把云端每一行都还原成组（读不出来的那几行不在结果里）。
  const fullCloud = sortLikeDownload(
    opts.cloudRows.map(row => cloudGroupOf(row, content[row.id]))
  );

  // ② 差量判据 + 只回源取点名的那几行。
  const delta = cloudDelta.computeCloudDelta({
    localGroups: opts.localGroups,
    localTombstoneIds: localTombstones,
    digest: opts.cloudRows,
  });
  const wanted = new Set(delta.payloadIds);
  const fetched = opts.cloudRows
    .filter(row => wanted.has(String(row.id)))
    .map(row => cloudGroupOf(row, content[row.id]));
  const localById = new Map(opts.localGroups.map(g => [g.id, g]));
  const assembled = cloudDelta.assembleCloudGroups(fetched, delta, localById);

  // ③ 合并结果必须逐字相同。
  const mergedFull = mergeOpStamped(opts.localGroups, fullCloud);
  const mergedAssembled = mergeOpStamped(opts.localGroups, assembled);
  assert.deepEqual(
    mergedAssembled,
    mergedFull,
    '增量装配出来的云端集合，合并结果必须与全量下载**逐字相同** —— ' +
      '否则「少取的那几行」就是在丢用户的数据'
  );

  // ④ 装配出来的云端集合本身也必须与全量一致（行数、id、墓碑计数）。
  assert.deepEqual(
    assembled.map(g => g.id).sort(),
    fullCloud.map(g => g.id).sort(),
    '装配出的云端集合的 id 集合必须与全量下载一致'
  );
  assert.equal(
    assembled.filter(g => g.isDeleted).length,
    fullCloud.filter(g => g.isDeleted).length,
    '云端墓碑行数必须一致（validateMergeResult 的规则 3 与覆盖闸门都数它）'
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 一、差量判据本身
// ══════════════════════════════════════════════════════════════════════════

describe('差量判据：哪些云端行必须回源', () => {
  it('印记相同 ⇒ 不回源（本地那份就能代表它）', () => {
    const delta = cloudDelta.computeCloudDelta({
      localGroups: [localGroup('a', 1)],
      localTombstoneIds: [],
      digest: [digestRow('a', { last_op_seq: 1, last_op_device: 'devA' })],
    });
    assert.deepEqual(delta.payloadIds, [], '没变的行不该回源');
    assert.deepEqual(delta.coveredByLocalIds, ['a']);
  });

  it('云端印记更大 ⇒ 回源（云端那份会赢下合并，不取回来就丢了）', () => {
    const delta = cloudDelta.computeCloudDelta({
      localGroups: [localGroup('a', 1)],
      localTombstoneIds: [],
      digest: [digestRow('a', { last_op_seq: 9, last_op_device: 'devB' })],
    });
    assert.deepEqual(delta.payloadIds, ['a']);
    assert.deepEqual(delta.coveredByLocalIds, []);
  });

  it('本地印记更大 ⇒ 不回源（合并会选本地那份，云端那份被丢弃）', () => {
    const delta = cloudDelta.computeCloudDelta({
      localGroups: [localGroup('a', 9)],
      localTombstoneIds: [],
      digest: [digestRow('a', { last_op_seq: 1, last_op_device: 'devA' })],
    });
    assert.deepEqual(delta.payloadIds, []);
    assert.deepEqual(delta.coveredByLocalIds, ['a']);
  });

  it('云端独有（本地没有）⇒ 回源', () => {
    const delta = cloudDelta.computeCloudDelta({
      localGroups: [],
      localTombstoneIds: [],
      digest: [digestRow('a')],
    });
    assert.deepEqual(delta.payloadIds, ['a']);
  });

  it('本地独有（云端没有）⇒ 两边都不进（保留本地，与全量下载同）', () => {
    const delta = cloudDelta.computeCloudDelta({
      localGroups: [localGroup('a', 1)],
      localTombstoneIds: [],
      digest: [],
    });
    assert.deepEqual(delta.payloadIds, []);
    assert.deepEqual(delta.coveredByLocalIds, []);
    assert.deepEqual(delta.tombstones, []);
  });

  it('本地墓碑残留的云端对应行 ⇒ 回源（D-8 的复活链路要靠它）', () => {
    const delta = cloudDelta.computeCloudDelta({
      localGroups: [],
      localTombstoneIds: ['a'],
      digest: [digestRow('a')],
    });
    assert.deepEqual(delta.payloadIds, ['a'], '本地只剩墓碑时，云端那一行必须照旧取回');
  });

  it('云端墓碑 ⇒ 进 tombstones，且**不进** payloadIds（墓碑不需要 payload）', () => {
    const delta = cloudDelta.computeCloudDelta({
      localGroups: [localGroup('a', 1)],
      localTombstoneIds: [],
      digest: [digestRow('a', { is_deleted: true, last_op_seq: 5, last_op_device: 'devB' })],
    });
    assert.deepEqual(delta.payloadIds, [], '墓碑行的 payload 不必取回');
    assert.equal(delta.tombstones.length, 1);
    assert.equal(delta.tombstones[0].id, 'a');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 二、等价性：增量装配 vs 全量下载 ⇒ 合并结果必须逐字相同
// ══════════════════════════════════════════════════════════════════════════

describe('等价性：增量装配出来的云端集合 ≡ 全量下载拿到的云端集合', () => {
  it('场景一：云端有一组更新了，其余没变', () => {
    assertSameMergeOutcome({
      localGroups: [localGroup('a', 1), localGroup('b', 1), localGroup('c', 1)],
      cloudRows: [
        digestRow('a', { last_op_seq: 1, last_op_device: 'devA' }),
        digestRow('b', { last_op_seq: 7, last_op_device: 'devB', updated_at: LATER }),
        digestRow('c', { last_op_seq: 1, last_op_device: 'devA' }),
      ],
      cloudContent: { b: '云端改过的名字' },
    });
  });

  it('场景二：云端多一组（别的设备新建）', () => {
    assertSameMergeOutcome({
      localGroups: [localGroup('a', 1)],
      cloudRows: [digestRow('a'), digestRow('new', { last_op_seq: 3, last_op_device: 'devB' })],
    });
  });

  it('场景三：云端墓碑且印记更新 ⇒ 本地那组服从删除', () => {
    assertSameMergeOutcome({
      localGroups: [localGroup('a', 1), localGroup('b', 1)],
      cloudRows: [
        digestRow('a', { is_deleted: true, last_op_seq: 9, last_op_device: 'devB' }),
        digestRow('b'),
      ],
    });
  });

  it('场景四：云端墓碑但本地印记更新 ⇒ 本地保留（删除被本地的新改动撤销）', () => {
    assertSameMergeOutcome({
      localGroups: [localGroup('a', 9)],
      cloudRows: [digestRow('a', { is_deleted: true, last_op_seq: 1, last_op_device: 'devA' })],
    });
  });

  it('场景五：本地多一组（云端没有）⇒ 保留本地', () => {
    assertSameMergeOutcome({
      localGroups: [localGroup('a', 1), localGroup('local-only', 2)],
      cloudRows: [digestRow('a')],
    });
  });

  it('场景六：本地墓碑残留 + 云端对应行仍活跃（D-8 的形状）', () => {
    assertSameMergeOutcome({
      localGroups: [localGroup('a', 1)],
      localTombstones: ['legacy-dead'],
      cloudRows: [digestRow('a'), digestRow('legacy-dead', { last_op_seq: 4, last_op_device: 'devB' })],
    });
  });

  it('场景七：云端墓碑行本地没有 ⇒ 删除广播的终点（不进合并结果）', () => {
    assertSameMergeOutcome({
      localGroups: [localGroup('a', 1)],
      cloudRows: [digestRow('a'), digestRow('gone', { is_deleted: true, last_op_seq: 9, last_op_device: 'devB' })],
    });
  });

  it('场景八：混合（新增 + 更新 + 墓碑 + 本地独有 + 本地墓碑）', () => {
    assertSameMergeOutcome({
      localGroups: [localGroup('a', 1), localGroup('b', 2), localGroup('local-only', 3)],
      localTombstones: ['legacy-dead'],
      cloudRows: [
        digestRow('a', { last_op_seq: 1, last_op_device: 'devA' }),
        digestRow('b', { last_op_seq: 8, last_op_device: 'devB', updated_at: LATER }),
        digestRow('new', { last_op_seq: 5, last_op_device: 'devB' }),
        digestRow('gone', { is_deleted: true, last_op_seq: 6, last_op_device: 'devB' }),
        digestRow('legacy-dead', { last_op_seq: 4, last_op_device: 'devB' }),
      ],
      cloudContent: { b: '云端改过的名字', new: '别的设备建的' },
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 三、出网量守恒：字节量必须与「变更量」成正比，而不是与「库大小」成正比
// ══════════════════════════════════════════════════════════════════════════

describe('出网量守恒：回源的行数必须正比于「变更的行数」', () => {
  it('100 组里只有 1 组变了 ⇒ 只回源 1 行（不是 100 行）', () => {
    const localGroups: TabGroup[] = [];
    const cloudRows: GroupDigestLike[] = [];
    for (let i = 0; i < 100; i += 1) {
      localGroups.push(localGroup(`g${i}`, 1));
      cloudRows.push(digestRow(`g${i}`, { last_op_seq: 1, last_op_device: 'devA' }));
    }
    // 只有 g42 变了（另一台设备改的）
    cloudRows[42] = digestRow('g42', { last_op_seq: 9, last_op_device: 'devB', updated_at: LATER });

    const delta = cloudDelta.computeCloudDelta({
      localGroups,
      localTombstoneIds: [],
      digest: cloudRows,
    });

    assert.equal(
      delta.payloadIds.length,
      1,
      '100 组库里只有 1 组变了 ⇒ 回源的行数必须是 1 —— ' +
        '这一条就是「出网量 ∝ 变更量」的可执行表达；' +
        '回源 100 行 ⇒ 出网量又回到 ∝ 库大小 ⇒ 配额必然被吃光'
    );
    assert.deepEqual(delta.payloadIds, ['g42']);
    assert.equal(delta.coveredByLocalIds.length, 99);
  });

  it('什么都没变 ⇒ 一行都不用回源', () => {
    const localGroups: TabGroup[] = [];
    const cloudRows: GroupDigestLike[] = [];
    for (let i = 0; i < 50; i += 1) {
      localGroups.push(localGroup(`g${i}`, 1));
      cloudRows.push(digestRow(`g${i}`, { last_op_seq: 1, last_op_device: 'devA' }));
    }
    const delta = cloudDelta.computeCloudDelta({
      localGroups,
      localTombstoneIds: [],
      digest: cloudRows,
    });
    assert.equal(delta.payloadIds.length, 0);
    assert.equal(delta.coveredByLocalIds.length, 50);
  });
});
