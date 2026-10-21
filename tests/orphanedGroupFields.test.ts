// 1.22.13 下线的「会话备注 / 收藏」残留字段的收敛（2026-10-20 审计 U-1）。
//
// ── 这个缺陷长什么样 ──────────────────────────────────────────────────────
// 1.22.13 把「备注」与「收藏」整条下线（提交 `a7671ef`，产品负责人拍板
// 「不是核心功能就不要上去」）：类型、写入入口、读取入口、搜索权重全部删除。
//
// 但用户磁盘上已经躺着的数据没人管：
//   · 存储层**不裁字段**（`setGroupsImmediate` 整份数组落盘；
//     `normalizeImportedGroup` 用 `...(g as object)` 展开）⇒ 数据**还在**；
//   · 产品里**没有任何入口**能看见、编辑、搜到它 ⇒ 变成**孤儿数据**；
//   · 一次跨端合并（`core/opStampMerge.ts` 的「活跃 vs 活跃：整组覆盖，
//     赢家通吃」）会把本地那份换成云端版本 ⇒ **字段物理消失，不可恢复**
//     （v1.22.0 起无回收站、删除即物理清除）。
//
// ── 本文件钉的不变量（钉行为，不钉字面量）────────────────────────────────
// ① 有残留 ⇒ 迁移后那一条**不再带**那两个键（危害在形状上）；
// ② 无残留 ⇒ 落盘内容与迁移前**逐字段相同**，且**不写盘**；
// ③ 幂等 ⇒ 跑两遍 = 跑一次（第二遍不写盘）；
// ④ 不丢信息 ⇒ 原 name 与原备注都**原样**出现在新 name 里；
// ⑤ 不扰动仲裁 ⇒ 迁移前后 `lastOp` / `updatedAt` / `version` 逐字段相同；
// ⑥ 不触发上传 ⇒ 迁移后 `pending_upload` 仍为 false。
//
// 变异验证口径（改坏实现必须变红）：
//   · 让「无残留也写盘」        → ②红
//   · 让迁移改 `lastOp`/`updatedAt` → ⑤红
//   · 让迁移调 `scheduleUpload` → ⑥红
//   · 让迁移把备注**丢掉**（不并进 name） → ④红
//   · 让迁移把那两个键**留着**   → ①红
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { installEngineStorageEnv } from './_helpers/engineStorageEnv.ts';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOADER_PATH = pathToFileURL(resolve(ROOT, 'tests/_alias-loader.mjs')).href;

// 必须在 import 被测模块之前就位：storage-kv 在首次 import 时选择 driver。
const env = installEngineStorageEnv();

if (!process.env.VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const NOW = '2026-10-20T08:00:00.000Z';

/** 一条带 1.22.12 残留字段的会话（形状不可信 ⇒ 用 `as never` 绕过类型）。 */
function legacyGroup(
  id: string,
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    name: `会话-${id}`,
    tabs: [
      {
        id: `${id}-t1`,
        url: `https://${id}.example.com/`,
        title: id,
        createdAt: NOW,
        lastAccessed: NOW,
        pinned: false,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    version: 3,
    lastOp: { d: 'dev-a', s: 42 },
    ...over,
  };
}

/** 读取磁盘上真正落盘的会话数组（未经任何缓存）。 */
async function readDisk(): Promise<Record<string, unknown>[]> {
  const { kvGet } = await import('@/storage-kv/storageAdapter');
  const { STORAGE_KEYS } = await import('@/storage-kv/keys');
  const raw = await kvGet<Record<string, unknown>[]>(STORAGE_KEYS.GROUPS);
  return Array.isArray(raw) ? raw : [];
}

/**
 * 「写盘」的计数口径 = **会话数据键**被写的次数。
 *
 * 为什么不能数 `env.writes` 的全部：存储驱动每做一次可用性探测就会写一次
 * `__tv_test__`（见 `storage-kv/localStorageFallback.ts` 的
 * `isLocalStorageAvailable`）—— 那是驱动的探针，不是「迁移写了数据」。
 * 数全部会把「探针写了几次」误判成「迁移写了几次盘」⇒ 判据失真。
 */
function dataWriteCount(): number {
  return env.writes.filter(k => k === 'tab_groups').length;
}

let storage: typeof import('../src/utils/storage.ts').storage;
let migrateOrphanedGroupFieldsOnce: typeof import('../src/utils/migrationUtils.ts').migrateOrphanedGroupFieldsOnce;
let migrateOrphanedGroupFields: typeof import('../src/core/orphanedGroupFields.ts').migrateOrphanedGroupFields;
let hasOrphanedGroupFields: typeof import('../src/core/orphanedGroupFields.ts').hasOrphanedGroupFields;

before(async () => {
  register(LOADER_PATH, import.meta.url);
  ({ storage } = await import('../src/utils/storage.ts'));
  ({ migrateOrphanedGroupFieldsOnce } = await import('../src/utils/migrationUtils.ts'));
  ({ migrateOrphanedGroupFields, hasOrphanedGroupFields } = await import(
    '../src/core/orphanedGroupFields.ts'
  ));
});

beforeEach(() => {
  env.lsData.clear();
  env.chromeData.clear();
  env.failReadKeys.clear();
  env.writes.length = 0;
});

// ════════════════════════════════════════════════════════════════════════
// ① 纯函数层：形状与内容的不变量
// ════════════════════════════════════════════════════════════════════════

describe('残留字段的判定只看「键在不在」，不看值', () => {
  it('空备注与未标记同样算残留（危害在形状上，不在值上）', () => {
    // `notes: ''` 与 `isFavorite: false` 都没有用户可见内容，但它们仍会被
    // 整份写盘带走、被跨端合并替换掉 ⇒ 必须同样被摘掉。
    assert.equal(hasOrphanedGroupFields(legacyGroup('a', { notes: '' })), true);
    assert.equal(hasOrphanedGroupFields(legacyGroup('a', { isFavorite: false })), true);
    assert.equal(hasOrphanedGroupFields(legacyGroup('a', { notes: undefined })), true);
  });

  it('干净的会话判为无残留', () => {
    assert.equal(hasOrphanedGroupFields(legacyGroup('a')), false);
    assert.equal(hasOrphanedGroupFields(null), false);
    assert.equal(hasOrphanedGroupFields(undefined), false);
    assert.equal(hasOrphanedGroupFields('不是对象'), false);
  });
});

describe('收敛：内容不丢、形状干净、其余字段不动', () => {
  it('用户写下的原文与原会话名都原样出现在新名里', () => {
    const input = [legacyGroup('a', { notes: '给客户看的报价单' })];
    const r = migrateOrphanedGroupFields(input);

    const name = String(r.groups[0].name);
    assert.ok(
      name.includes('会话-a'),
      `原会话名必须原样保留在合并后的名字里（实际：${name}）`
    );
    assert.ok(
      name.includes('给客户看的报价单'),
      `用户写的原文必须原样出现在合并后的名字里（实际：${name}）`
    );
    // 原名是前缀、原文是后缀 ⇒ 可原样拆回（不丢信息）。
    assert.ok(name.startsWith('会话-a'), '原名必须是前缀');
    assert.ok(name.endsWith('给客户看的报价单'), '原文必须是后缀');
  });

  it('收敛后那一条不再带那两个键（危害在形状上）', () => {
    const r = migrateOrphanedGroupFields([legacyGroup('a', { notes: 'x', isFavorite: true })]);
    assert.equal('notes' in r.groups[0], false, 'notes 必须被摘掉');
    assert.equal('isFavorite' in r.groups[0], false, 'isFavorite 必须被摘掉');
  });

  it('不扰动仲裁相关字段：lastOp / updatedAt / version 逐字段不变', () => {
    // lastOp 是跨端整组覆盖的**裁决依据** —— 动它 = 改仲裁结果。
    const r = migrateOrphanedGroupFields([
      legacyGroup('a', { notes: 'x', isFavorite: true }),
    ]);
    assert.deepEqual(r.groups[0].lastOp, { d: 'dev-a', s: 42 }, 'lastOp 不得被改动');
    assert.equal(r.groups[0].updatedAt, NOW, 'updatedAt 不得被改动');
    assert.equal(r.groups[0].version, 3, 'version 不得被改动');
    assert.equal(r.groups[0].id, 'a', 'id 不得被改动');
  });

  it('没有备注就不往名字里塞东西（不造「原名 · 」这种脏尾巴）', () => {
    // 用户写过什么才算有内容：空串 / 纯空白 / 非字符串一律视为「没写过」。
    // 若把它们也并进去，名字会变成「原名 · 」—— 一个带空分隔符的脏尾巴。
    for (const notes of ['', '   ', '\n\t', null, undefined, 42, {}] as unknown[]) {
      const r = migrateOrphanedGroupFields([legacyGroup('a', { notes })]);
      assert.equal(
        r.groups[0].name,
        '会话-a',
        `空备注（${JSON.stringify(notes)}）不得改变会话名 —— 不许造出「原名 · 」这种空壳`
      );
    }
  });

  it('只有标记位、没有内容时，名字一个字符都不动', () => {
    // 这一条专门钉住「残留里只有标记位」这一种形状：旧版收藏过的会话，
    // 它的备注字段往往根本没写过（空串）。
    const r = migrateOrphanedGroupFields([
      legacyGroup('a', { notes: '', isFavorite: true }),
    ]);
    assert.equal(
      r.groups[0].name,
      '会话-a',
      '标记位不得进入会话名（收藏功能已下线，不得换个形状复活）'
    );
    assert.equal(r.notesMerged, 0, '空备注不得被计为「已并入」');
    assert.equal(r.favoritesDropped, 1, '标记位应被计为「已丢弃」');
  });

  it('标记位不进入会话名（收藏功能已下线，不得换个形状复活）', () => {
    const r = migrateOrphanedGroupFields([legacyGroup('a', { isFavorite: true })]);
    assert.equal(r.groups[0].name, '会话-a', '标记位不得改变会话名');
    assert.equal(r.favoritesDropped, 1, '标记位应被计为已丢弃');
  });

  it('无残留的会话原样引用（整体零改动）', () => {
    const clean = legacyGroup('a');
    const r = migrateOrphanedGroupFields([clean]);
    assert.equal(r.migrated, 0);
    assert.equal(r.groups[0], clean, '没动过的会话必须是**同一个对象引用**');
  });

  it('幂等：跑两次 = 跑一次', () => {
    const once = migrateOrphanedGroupFields([legacyGroup('a', { notes: '备注', isFavorite: true })]);
    const twice = migrateOrphanedGroupFields(once.groups);

    assert.equal(twice.migrated, 0, '第二遍不得再改动任何会话');
    assert.deepEqual(
      twice.groups.map(g => g.name),
      once.groups.map(g => g.name),
      '第二遍的结果必须与第一遍逐字相同'
    );
    assert.deepEqual(
      twice.groups.map(g => g.lastOp),
      once.groups.map(g => g.lastOp),
      '第二遍不得再动 lastOp'
    );
  });
});

// ════════════════════════════════════════════════════════════════════════
// ② 真实落盘路径：写盘、不写盘、不触发上传
// ════════════════════════════════════════════════════════════════════════

describe('真实落盘路径：无残留时不写盘，有残留时才写', () => {
  it('无残留 ⇒ 落盘内容逐字段不变，且**一次都不写盘**', async () => {
    const before = [legacyGroup('a'), legacyGroup('b')];
    await storage.setGroupsImmediate(before as never);
    const writesBefore = dataWriteCount();

    await migrateOrphanedGroupFieldsOnce();

    assert.equal(
      dataWriteCount(),
      writesBefore,
      '无残留时不得写盘（连直写都不许 —— 「顺手统一格式」是数据安全的敌人）'
    );
    assert.deepEqual(
      await readDisk(),
      before,
      '无残留时落盘内容必须与迁移前逐字段相同'
    );
  });

  it('有残留 ⇒ 落盘后那一条不再带那两个键，且原名与原文都在', async () => {
    await storage.setGroupsImmediate([
      legacyGroup('a', { notes: '周末要交的作业' }),
      legacyGroup('b'),
    ] as never);

    await migrateOrphanedGroupFieldsOnce();

    const disk = await readDisk();
    const a = disk.find(g => g.id === 'a');
    assert.ok(a, '带残留的会话必须还在');
    assert.equal('notes' in a!, false, 'notes 必须被摘掉');
    assert.ok(
      String(a!.name).includes('周末要交的作业'),
      '用户写的原文必须落到会话名里'
    );
    const b = disk.find(g => g.id === 'b');
    assert.deepEqual(b, legacyGroup('b'), '不含残留的会话必须逐字段不变');
  });

  it('幂等（落盘层）：第二遍不写盘', async () => {
    await storage.setGroupsImmediate([
      legacyGroup('a', { notes: '备注', isFavorite: true }),
    ] as never);

    await migrateOrphanedGroupFieldsOnce();
    const diskAfterFirst = await readDisk();
    const writesAfterFirst = dataWriteCount();

    await migrateOrphanedGroupFieldsOnce();

    assert.equal(
      dataWriteCount(),
      writesAfterFirst,
      '第二遍不得写盘（迁移必须幂等）'
    );
    assert.deepEqual(await readDisk(), diskAfterFirst, '第二遍不得改变任何内容');
  });

  it('不触发上传：pending_upload 仍为 false', async () => {
    await storage.setGroupsImmediate([
      legacyGroup('a', { notes: '备注' }),
    ] as never);
    assert.equal(await storage.getPendingUpload(), false, '前置条件：本来就没有待上传');

    await migrateOrphanedGroupFieldsOnce();

    assert.equal(
      await storage.getPendingUpload(),
      false,
      '迁移是**本机**整理，不得把整理结果推上云（不得触发上传）'
    );
  });

  it('不扰动仲裁（落盘层）：lastOp / updatedAt / version 逐字段不变', async () => {
    await storage.setGroupsImmediate([
      legacyGroup('a', { notes: '备注', isFavorite: true }),
    ] as never);

    await migrateOrphanedGroupFieldsOnce();

    const a = (await readDisk()).find(g => g.id === 'a')!;
    assert.deepEqual(a.lastOp, { d: 'dev-a', s: 42 }, 'lastOp 是裁决依据，迁移不得动它');
    assert.equal(a.updatedAt, NOW, 'updatedAt 不得被改动');
    assert.equal(a.version, 3, 'version 不得被改动');
  });
});

// ════════════════════════════════════════════════════════════════════════
// ③ 接入真实升级路径（runMigrations）
// ════════════════════════════════════════════════════════════════════════

describe('接入真实升级路径', () => {
  it('runMigrations 会跑这条迁移（不是只在某个 UI 分支里才走的死路）', async () => {
    const { runMigrations } = await import('@/utils/migrationUtils');
    await storage.setGroupsImmediate([
      legacyGroup('a', { notes: '备注' }),
    ] as never);

    await runMigrations();

    const a = (await readDisk()).find(g => g.id === 'a')!;
    assert.equal('notes' in a, false, 'runMigrations 必须跑到这条迁移上');
    assert.ok(String(a.name).includes('备注'), '备注必须落到会话名里');
  });

  it('残留字段在「迁移已跑过」之后重新出现时，仍然会被处理（不得用标志位）', async () => {
    // 这一条钉的是「**不用迁移标志位**」这个决策。
    //
    // 为什么不能用标志位：用户导入一份旧版备份（`normalizeImportedGroup` 用
    // `...(g as object)` 展开 ⇒ 备份里带的残留字段原样进库）⇒ 残留字段
    // 可能在「迁移早就跑过」之后**重新出现**。用标志位 ⇒ 这批永远不被处理
    // ⇒ 孤儿数据又回来了，而「迁移已跑过」这件事让所有人以为没问题。
    //
    // 幂等必须由**数据形状**保证：只摘键、不加键 ⇒ 跑完就没有残留 ⇒
    // 下次检测不到 ⇒ 不动。标志位反而是第二个真相源，冲突时只能信用户的数据。
    const { runMigrations } = await import('@/utils/migrationUtils');

    // 第一轮：有残留 ⇒ 被处理掉。
    await storage.setGroupsImmediate([legacyGroup('a', { notes: '第一轮' })] as never);
    await runMigrations();
    assert.equal(
      'notes' in (await readDisk()).find(g => g.id === 'a')!,
      false,
      '第一轮必须处理掉残留'
    );

    // 第二轮：用户导入了一份旧备份 ⇒ 残留字段**重新出现**。
    // 此刻若实现里有标志位，这一轮就会被跳过 ⇒ 残留留在磁盘上。
    await storage.setGroupsImmediate([legacyGroup('b', { notes: '导入带回来的' })] as never);

    await runMigrations();

    const b = (await readDisk()).find(g => g.id === 'b');
    assert.ok(b, '导入的那份必须还在');
    assert.equal(
      'notes' in b!,
      false,
      '迁移标志位置位之后重新出现的残留字段仍必须被处理 —— ' +
        '用标志位会永久漏掉这批（导入旧备份带来的），孤儿数据就回来了'
    );
    assert.ok(
      String(b!.name).includes('导入带回来的'),
      '用户写的原文必须落到会话名里'
    );
  });

  it('SW 的升级路径必然经过它（enqueue 内的 runStorageMigrations）', () => {
    // 源码接线断言：升级路径上必然经过的位置才是对的。
    // 判据 = 「service-worker 的 runMigrations 在单写者队列里调了
    // runStorageMigrations」，而 runStorageMigrations 就是 migrationUtils 的
    // runMigrations（改名导入）⇒ 这条迁移必然在升级路径上。
    const sw = readFileSync(resolve(ROOT, 'src/service-worker.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    assert.match(
      sw,
      /enqueue\(\s*'storageMigrations'[\s\S]{0,600}?runStorageMigrations\(\)/,
      'SW 的升级路径必须在单写者队列里调 runStorageMigrations —— ' +
        '否则这条迁移只在某个 UI 分支里走，不是升级必经之路'
    );
  });
});
