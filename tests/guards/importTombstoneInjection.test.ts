// DS-43-3：导入文件**不得**注入组级墓碑（isDeleted）——
// 导入的永远是「活着的会话」（2026-10-22 数据安全审计）。
//
// ── 这个文件要防的具体事故 ────────────────────────────────────────────────
//
// 用户导入一份**带 `isDeleted: true`** 的 JSON 备份
// （v1.21 时代带回收站的备份，或用户手工编辑过的文件）。
//
// 修复前的失效链（每一环都是真代码，不是假想）：
//
//   ① `normalizeImportedGroup` 用 `...(g as object)` 展开文件里的组
//      ⇒ 覆盖名单只有 id/name/tabs/createdAt/updatedAt/isLocked
//      ⇒ **`isDeleted` 不在名单里** ⇒ 文件里写了 `isDeleted: true` 就原样保留；
//   ② `applyImportGroups` 同样 `...group` 展开 ⇒ `isDeleted` 一路带到落盘行；
//   ③ 落盘行组级 `isDeleted: true`
//      ⇒ `toActiveGroupsView` 的 `if (!g.isDeleted)` **把它从列表里滤掉**
//         （用户看到「导入了，但什么都没多」）；
//   ④ `syncEngine.upload` 的 `legacyTombstoneIds = allGroups.filter(g => g.isDeleted)`
//      把它当成「老版本残留墓碑」⇒ 进删除广播集合；
//      云端**没有这一行** ⇒ 广播是空操作（missingAsAchieved）
//      ⇒ 紧接着 `setGroupsImmediate(activeGroups)` **把它从本地物理删除**。
//
// ⇒ 用户看到的是「导入了，但什么都没多」，然后那行数据也不见了，零解释。
// ⇒ **数据丢**（用户以为恢复出来的会话不存在）。
//
// ── 这个文件钉的是什么（不变量，不是字面量）──────────────────────────────
//
// 【判据 1 · 数据流】**导入路径的落盘结果里，组级 `isDeleted` 恒为 false。**
//   断言的对象是**落盘行**（applyImportGroups 的返回值），不是源码里
//   有没有出现过 `isDeleted` 这个词。这正是第 42 轮的教训：
//   「判据层全绿 ≠ 功能被用上了」—— 断言必须落在**数据流**上。
//
// 【判据 2 · 双防线】两道防线**各自**都必须能独立挡住注入：
//   · `normalizeImportedGroup`（上游归一化）；
//   · `applyImportGroups`（落盘路径自己的最后一道）。
//   为什么两道都要有：`applyImportGroups` 有三个入口（SW mutationHandlers /
//   storage 本地兜底 / 未来的 UI thunk），载荷来自用户手上的文件或跨进程消息
//   ⇒ 「每个调用方都记得先调 normalizeImportedGroup」正是这条暗门当初的成因
//   （见 mutationOps.ts 的 P1-1 注释）。落盘路径不能依赖调用方的自觉。
//
// 【判据 3 · 可见性】归一化后的组**必须出现在活跃视图里**
//   （`toActiveGroupsView` 不会因墓碑把它滤掉）——
//   这是「用户看得见」这条用户可见后果的直接钉法。
//
// 【判据 4 · 同步存活】注入过的组跑完**一轮真同步**（真 syncEngine +
//   后端替身）后**必须还在本地** —— 钉住第 ④ 环（legacyTombstoneIds
//   ⇒ 物理删除）这条真实的失效路径。
//
// ── 变异自证（实测过，每一条都真的让守卫变红）────────────────────────────
//
//   本文件共 9 条断言。下面的数字是**实测**的红/绿条数，不是估计。
//
//   M1  把 `normalizeImportedGroup` 覆盖名单里的 `isDeleted: false` 删掉
//       ⇒ 红 2 条：「落盘行的组级 isDeleted 恒为 false（上游归一化这一道）」
//         「归一化后的组必须出现在活跃视图里（用户看得见）」。
//         其余仍绿 —— 那是**对的**：两道防线**各自**独立成立，
//         去掉上游那道不该让下游那道失效。
//   M2  把 `applyImportGroups` 里的 `isDeleted: false` 删掉
//       ⇒ 红 1 条：「落盘行的组级 isDeleted 恒为 false（applyImportGroups 这一道）」。
//   M3  两处都改成 `isDeleted: true`（模拟"归零写反"）
//       ⇒ 红 7 / 9。
//   M4  把 `toActiveGroupsView` 的 `if (!g.isDeleted)` 改回 `byId.set(g.id, g)`
//       ⇒ **实测：守卫全绿（9/9）**。这条留档是因为它暴露了一个**真实的盲区**：
//         「可见性」那两条断言的对象是**归一化后的组**（isDeleted 已是 false），
//         而视图层的墓碑过滤是**读路径**的职责 —— 拿一个已归零的组去试它，
//         天然过不了它的关。
//         ⇒ 补法不是把断言改成「源码里必须有 if (!g.isDeleted)」（那是钉字面量），
//         而是**把判据换成有检测力的那一个**：见下面「可见性判据的真实形状」。
//   M5  把 `syncEngine.upload` 里 legacyTombstoneIds 那一行删掉
//       ⇒ 红 1 条：「正控：真的墓碑组仍然会被广播」。
//         ⚠️ 注意**判据 4 本身仍绿** —— 这正是本守卫的已知盲区：
//         判据 4 靠的是「本轮上传会把本地墓碑物理清除」这个**副作用**。
//         若有人改了 syncEngine 让上传不再清除本地墓碑，判据 4 会假绿。
//         ⇒ 因此判据 4 补了一条**正面**断言：注入过的组**不得**出现在
//         `backend.calls.broadcastDeletes` 里（那是"它被当成墓碑"的直接证据）。
//         两条件（本地仍在 + 未进广播集合）合起来覆盖两条独立的失效路径。
//   M6  两道防线**都**去掉（= 完整复现原缺陷）
//       ⇒ 红 7 / 9，含「一轮同步后仍在本地」那条。
//
//   ⚠️ 另有一条**跨层**的实测（本文件的孪生真机脚本
//   scripts/e2e-import-tombstone-visible.mjs）：在**真浏览器**里，
//   只去掉 M1 或只去掉 M2 ⇒ 真机脚本**仍全绿**（19/19），
//   因为导入的完整数据流上**两道防线都在**（normalizeImportedGroup 与
//   applyImportGroups），去掉任何一道另一道照样把墓碑归零。
//   ⇒ 「每一道防线各自能不能独立成立」是**本文件**的职责；
//     「端到端用户看到什么」是**真机脚本**的职责。两者合起来才是完整防线。
//
// ── 可见性判据的真实形状（为什么不钉 `if (!g.isDeleted)`）──────────────────
//
// M4 证明：断言「视图层会过滤墓碑」是**检不出**任何东西的 ——
// 因为**已经归零**的组根本进不了那条分支。
//
// 那条断言真正要防的是：**落盘行带墓碑 ⇒ 用户看不见它**。
// 而这件事**只**能在「落盘行**确实**带墓碑」时才发生 ——
// 也就是说，它与判据 1/2 是**同一件事的两种说法**，不是独立判据。
// ⇒ 所以「可见性」那两条的定位是：
//   · 它们钉住的是**端到端后果**（用户看见的列表长什么样），
//     而判据 1/2 钉住的是**机制**（落盘行的字段值）。
//   · 两者都红 ⇒ 修法方向明确（归零）；只红其中一条 ⇒ 修法是那一侧。
// 换句话说：它们不是「多一道保险」，而是**让同一个 bug 有两种失败表现**
// （机制层红 / 用户可见层红），避免「机制层绿但用户看不见」这种半修状态。
//
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  installFakeSyncBackend,
  resetFakeSyncBackend,
  type FakeSyncBackendHandle,
} from '../_helpers/fakeSyncBackend.ts';
import { installEngineStorageEnv } from '../_helpers/engineStorageEnv.ts';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '../_alias-loader.mjs')
).href;

const env = installEngineStorageEnv();

if (!process.env.VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const NOW = '2026-10-22T08:00:00.000Z';
const STAMP = { d: 'devA', s: 3 };

/** 一份**带组级墓碑**的备份（DS-43-3 的注入载荷）。 */
const TOMBSTONE_BACKUP_GROUP = {
  id: 'injected-1',
  name: '被注入墓碑的会话',
  isDeleted: true,
  tabs: [
    {
      id: 'tab-1',
      url: 'https://example.com/real',
      title: '真实标签',
      favicon: '',
      createdAt: NOW,
      lastAccessed: NOW,
      pinned: false,
    },
  ],
  createdAt: NOW,
  updatedAt: NOW,
  isLocked: false,
  version: 1,
};

const seqIds = (): (() => string) => {
  let i = 0;
  return () => `imported-${++i}`;
};

let backend: FakeSyncBackendHandle;

before(async () => {
  register(LOADER_PATH);
  backend = await installFakeSyncBackend();
  const { storage } = await import('@/utils/storage');
  await storage.setOpStampMigrated(true);
  const { kvSet } = await import('@/storage/storageAdapter');
  const { DEFAULT_SETTINGS } = await import('@/utils/storage');
  await kvSet('user_settings', { ...DEFAULT_SETTINGS, syncBackend: 'webdav' });
});

after(async () => {
  await resetFakeSyncBackend();
});

beforeEach(async () => {
  env.failReadKeys.clear();
  backend.groups = [];
  backend.calls.uploadGroups.length = 0;
  backend.calls.broadcastDeletes.length = 0;
  const { storage, invalidateGroupsCache } = await import('@/utils/storage');
  // ⚠️ 必须清空本地会话：**上一个用例留下的组会混进下一个用例的断言**。
  // （「正控」那个用例往磁盘上种了一组真的墓碑；不清它的话，
  //   端到端那条会看到 2 行而不是 1 行 —— 那是**用例之间串味**，
  //   不是缺陷。守卫自己必须先把自己的地板擦干净。）
  await storage.setGroupsImmediate([]);
  invalidateGroupsCache();
  await storage.clearPendingDeleteIds();
  await storage.setPendingUpload(false);
  await storage.setLastUploadTime('2020-01-01T00:00:00.000Z');
});

describe('DS-43-3 · 注入组级墓碑的备份不得变成隐形会话', () => {
  it('落盘行的组级 isDeleted 恒为 false（上游归一化这一道）', async () => {
    const { normalizeImportedGroup } = await import('@/core/normalizeTabsData');

    const normalized = normalizeImportedGroup(TOMBSTONE_BACKUP_GROUP);

    assert.notEqual(
      normalized.isDeleted,
      true,
      '归一化之后仍然是墓碑 —— 备份文件可以决定本地会话「已删除」' +
        '（视图层会把它滤掉、下一轮同步会把它物理删除）'
    );
    assert.equal(
      normalized.isDeleted,
      false,
      '组级 isDeleted 必须被**显式**归零为 false（形状确定，' +
        '不依赖「字段不存在 ⇒ falsy」这种约定）'
    );
  });

  it('落盘行的组级 isDeleted 恒为 false（applyImportGroups 这一道）', async () => {
    const { applyImportGroups } = await import('@/core/mutationOps');
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');

    // 【M6 · 前置】：这一步**不经过** normalizeImportedGroup ⇒ 载荷是脏的。
    // 这正是 applyImportGroups 必须自己守一道的原因（它有三个入口，
    // 载荷来自用户手上的文件或跨进程消息 ⇒ 不可信）。
    const { imported } = applyImportGroups(
      [],
      [TOMBSTONE_BACKUP_GROUP as never],
      { genId: seqIds(), sanitizeUrl: sanitizeTabUrl },
      NOW,
      STAMP
    );

    assert.equal(imported.length, 1, '前置：这一组本身有内容，必须真的落盘');
    assert.notEqual(
      imported[0].isDeleted,
      true,
      'applyImportGroups 把落盘路径交给了调用方的自觉 —— ' +
        '备份文件仍能决定本地会话「已删除」'
    );
    assert.equal(
      imported[0].isDeleted,
      false,
      '组级 isDeleted 必须被显式归零为 false'
    );
  });

  it('归一化后的组必须出现在活跃视图里（用户看得见）', async () => {
    const { normalizeImportedGroup } = await import('@/core/normalizeTabsData');
    const { toActiveGroupsView } = await import('@/store/slices/tabSliceHelpers');

    const normalized = normalizeImportedGroup(TOMBSTONE_BACKUP_GROUP);
    const view = toActiveGroupsView([normalized]);

    assert.equal(
      view.length,
      1,
      '导入的会话在列表里**看不见** —— 用户看到的是「导入了，但什么都没多」'
    );
    assert.equal(view[0].id, normalized.id);
  });

  it('整条导入路径（归一化 → 落盘）之后，组仍在活跃视图里', async () => {
    const { normalizeImportedGroup } = await import('@/core/normalizeTabsData');
    const { applyImportGroups } = await import('@/core/mutationOps');
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');
    const { toActiveGroupsView } = await import('@/store/slices/tabSliceHelpers');

    const normalized = normalizeImportedGroup(TOMBSTONE_BACKUP_GROUP);
    const { groups } = applyImportGroups(
      [],
      [normalized],
      { genId: seqIds(), sanitizeUrl: sanitizeTabUrl },
      NOW,
      STAMP
    );

    const view = toActiveGroupsView(groups);
    assert.equal(
      view.length,
      1,
      '走完整条导入路径后，组在列表里不见了 —— 落盘形状与视图过滤不一致'
    );
  });

  it('导入的组不得因为「组级墓碑」被判成空组而丢弃', async () => {
    const { applyImportGroups } = await import('@/core/mutationOps');
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');

    // isEmptyGroup 只看标签、不看组级 isDeleted ⇒ 这条断言守的是
    // 「归零之前的那道 bug 会让组在**别处**被判空」的路径：
    // 若哪天 isEmptyGroup 或落盘判据改成看组级 isDeleted，
    // 注入的组会直接消失 ⇒ 这条会红。
    const { imported } = applyImportGroups(
      [],
      [TOMBSTONE_BACKUP_GROUP as never],
      { genId: seqIds(), sanitizeUrl: sanitizeTabUrl },
      NOW,
      STAMP
    );
    assert.equal(imported.length, 1, '组有真实标签，不该被判成空组而丢弃');
    assert.equal(imported[0].tabs.length, 1, '标签必须还在');
  });
});

describe('DS-43-3 · 注入墓碑的会话跑完一轮真同步后必须还在', () => {
  /**
   * 【为什么必须真跑一轮同步】
   * 缺陷的第 ④ 环（legacyTombstoneIds ⇒ setGroupsImmediate(activeGroups)
   * ⇒ 物理删除）**只发生在同步路径上**。只测归一化等于没测到它 ——
   * 那正是「判据层全绿 ≠ 功能被用上了」的老教训。
   *
   * 这里跑的是**真 syncEngine + 后端替身**（与
   * tests/syncNoResurrectConvergence.test.ts 同一套底座）。
   */
  it('导入的组在一轮上传后仍在本地，且不进删除广播集合', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    const { applyImportGroups } = await import('@/core/mutationOps');
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');
    const { normalizeImportedGroup } = await import('@/core/normalizeTabsData');

    // 走**真实**的导入路径（归一化 → 落盘），模拟用户导入了那份文件。
    const normalized = normalizeImportedGroup(TOMBSTONE_BACKUP_GROUP);
    const { groups } = applyImportGroups(
      [],
      [normalized],
      { genId: seqIds(), sanitizeUrl: sanitizeTabUrl },
      NOW,
      STAMP
    );
    await storage.setGroupsImmediate(groups as never);
    invalidateGroupsCache();

    const before = await storage.getGroups();
    assert.equal(before.length, 1, '前置：导入的那一组必须真的在本地');

    const { syncEngine } = await import('@/services/syncEngine');
    const up = await syncEngine.upload({ syncSettings: false, forcePending: true });
    assert.equal(up.success, true, `上传必须成功（${up.error ?? '无'}）`);

    invalidateGroupsCache();
    const after = await storage.getGroups();

    assert.equal(
      after.length,
      1,
      '一轮同步之后，导入的会话**从本地消失了** —— ' +
        '它被当成了老版本残留墓碑：广播是空操作（云端没这一行），' +
        '然后被 setGroupsImmediate(activeGroups) 物理清除。**数据丢。**'
    );
    assert.equal(after[0].id, before[0].id, '留下来的必须是同一个会话');

    // 正面断言（补 M5 暴露的盲区）：它**不得**被当成墓碑进删除广播。
    const broadcast = backend.calls.broadcastDeletes.flat();
    assert.ok(
      !broadcast.includes(after[0].id),
      `导入的会话被当成了墓碑、进��删除广播集合（${JSON.stringify(broadcast)}）—— ` +
        '「用户导入的会话」与「已被删除的会话」被混为一谈'
    );
  });

  it('正控：真的墓碑组仍然会被广播（证明上一条不是「广播整体坏了」）', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');

    // 一组**真的**带组级墓碑（老版本残留形状）⇒ 仍应进删除广播集合。
    // 正控的作用：确保上一条不是靠「广播功能整体失效」而假绿。
    await storage.setGroupsImmediate([
      {
        id: 'legacy-tomb',
        name: 'legacy',
        tabs: [
          {
            id: 't1',
            url: 'https://example.com/legacy',
            title: 'x',
            favicon: '',
            createdAt: NOW,
            lastAccessed: NOW,
            pinned: false,
          },
        ],
        createdAt: NOW,
        updatedAt: NOW,
        isLocked: false,
        isDeleted: true,
        lastOp: STAMP,
      } as never,
    ]);
    invalidateGroupsCache();

    const { syncEngine } = await import('@/services/syncEngine');
    await syncEngine.upload({ syncSettings: false, forcePending: true });

    const broadcast = backend.calls.broadcastDeletes.flat();
    assert.ok(
      broadcast.includes('legacy-tomb'),
      `正控失败：真正的老版本残留墓碑没有被广播（${JSON.stringify(broadcast)}）—— ` +
        '这说明上一条是「广播功能整体失效」造成的假绿，不是真的挡住了注入'
    );
  });
});

describe('DS-43-3 · 端到端：真实的导入入口也不许让会话隐形', () => {
  /**
   * 【为什么要这一段】
   * 上面所有断言都跑在**纯函数**上（normalizeImportedGroup / applyImportGroups）。
   * 而第 42 轮的教训是：「判据层全绿 ≠ 功能被用上了」——
   * 判据、设置、落盘全做完，列表却仍写死。
   *
   * 这里的判据是**唯一的真实入口**：`storage.importDetailed`
   * （UI 的文件选择器 → 它，见 HeaderDropdown.tsx）。
   * 断言的是**它落盘之后磁盘上真正的形状**与**用户看到的列表**。
   *
   * ⚠️ 这一条不依赖任何 mock 后端：导入路径完全不碰云端。
   */
  it('storage.importDetailed 导入带墓碑的备份 ⇒ 落盘行不是墓碑、列表看得见', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    const { toActiveGroupsView } = await import('@/store/slices/tabSliceHelpers');

    const result = await storage.importDetailed({
      version: '1.0.0',
      timestamp: NOW,
      data: {
        groups: [
          {
            ...TOMBSTONE_BACKUP_GROUP,
            // 备份文件里的 id 会**换新**（导入永远新建组），所以这里不预设 id。
          } as never,
        ],
      },
    } as never);

    assert.equal(result.ok, true, `导入必须成功（${result.reason ?? '无'}）`);
    assert.equal(result.imported, 1, '必须真的落盘了一个会话');

    invalidateGroupsCache();
    const onDisk = await storage.getGroups();
    assert.equal(onDisk.length, 1, '磁盘上必须有一行');
    assert.notEqual(
      onDisk[0].isDeleted,
      true,
      '真实入口落盘的行仍带组级墓碑 —— 备份文件能决定本地会话「已删除」'
    );
    assert.equal(onDisk[0].isDeleted, false, '组级 isDeleted 必须被显式归零为 false');
    assert.equal(onDisk[0].tabs.length, 1, '标签必须还在');

    const view = toActiveGroupsView(onDisk);
    assert.equal(
      view.length,
      1,
      '导入的会话在列表里**看不见** —— 用户看到的是「导入了，但什么都没多」'
    );
  });

  it('端到端：导入后跑一轮真同步，那一行仍在本地', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');

    await storage.importDetailed({
      version: '1.0.0',
      timestamp: NOW,
      data: { groups: [TOMBSTONE_BACKUP_GROUP as never] },
    } as never);

    invalidateGroupsCache();
    assert.equal((await storage.getGroups()).length, 1, '前置：导入的那一行在本地');

    const { syncEngine } = await import('@/services/syncEngine');
    const up = await syncEngine.upload({ syncSettings: false, forcePending: true });
    assert.equal(up.success, true, `上传必须成功（${up.error ?? '无'}）`);

    invalidateGroupsCache();
    const after = await storage.getGroups();
    assert.equal(
      after.length,
      1,
      '一轮同步之后，导入的会话**从本地消失了** —— ' +
        '它被当成了老版本残留墓碑 ⇒ 广播空操作 ⇒ 被物理清除。**数据丢。**'
    );
    assert.notEqual(after[0].isDeleted, true, '它仍然被当成墓碑');
  });
});
