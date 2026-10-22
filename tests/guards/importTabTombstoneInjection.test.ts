// DS-43-3（**标签级**）：导入文件**不得**注入标签级墓碑（isDeleted）——
// 导入的永远是「活着的会话 / 活着的标签」（2026-10-23 数据安全审计）。
//
// ── 这个文件防的具体事故 ────────────────────────────────────────────────
//
// 组级墓碑注入由 tests/guards/importTombstoneInjection.test.ts 钉住；
// 那一组里的**标签级**墓碑此前没人管 —— 而它同样是一条完整的数据丢失路径，
// 而且有**两种**形状：
//
//   形状 A（部分标签带墓碑）：组留着，但那条标签在视图里隐形；
//   形状 B（全部标签带墓碑）：整组被判成「空组」⇒ **这一组被直接丢弃**。
//
// 失效链（每一环都是真代码，不是假想）：
//
//   ① `normalizeImportedTab` 用 `...(t as object)` 展开文件里的标签
//      ⇒ 覆盖名单只有 id/url/title/favicon/pinned/createdAt/lastAccessed
//      ⇒ **`isDeleted` 不在名单里** ⇒ 文件里写了 `isDeleted: true` 就原样保留；
//   ② `applyImportGroups` 同样 `...tab` 展开 ⇒ 一路带到落盘行；
//   ③ 落盘行里那条标签带 `isDeleted: true`
//      ⇒ 形状 A：`toActiveGroupsView` 的 `stripTombstonedTabs`
//         **把它从视图里滤掉**（用户看到会话卡少了一条标签，零解释）；
//      ⇒ 形状 B：`isEmptyGroup` 只数**非墓碑**标签 ⇒ 整组被判空
//         ⇒ `applyImportGroups` 的 `.filter(group => !isEmptyGroup(group))`
//            **把这一组整个丢弃** ⇒ 用户看到「导入成功，0 个会话」
//            （而提示会甩锅「文件里有空会话」—— 文件里明明有内容）；
//   ④ `serializeTab`（core/tabDataCodec.ts）把 `isDeleted` 写成 `is_deleted`
//      存进云端 `tabs_data`，`deserializeTab` 再读回来
//      ⇒ **别的设备上那条标签也不见了**
//      ⇒ 一条明明躺在用户备份文件里的标签，在所有设备上永久隐形。
//
// ⇒ 数据丢（用户以为恢复出来了，实际少了一条 / 少了一组）。
//
// ── 这个文件钉的是什么（不变量，不是字面量）──────────────────────────────
//
// 【判据 1 · 数据流】导入路径的落盘结果里，**每个标签**的 `isDeleted` 恒为 false。
//   断言的对象是**落盘行**（applyImportGroups 的返回值），不是源码里
//   有没有出现过 `isDeleted` 这个词。这正是第 42 轮的教训：
//   「判据层全绿 ≠ 功能被用上了」—— 断言必须落在**数据流**上。
//
// 【判据 2 · 双防线】两道防线**各自**都必须能独立挡住注入：
//   · `normalizeImportedGroup`（上游归一化）；
//   · `applyImportGroups`（落盘路径自己的最后一道）。
//   为什么两道都要有：applyImportGroups 有三个入口（SW mutationHandlers /
//   storage 本地兜底 / 未来的 UI thunk），载荷来自用户手上的文件或跨进程消息
//   ⇒ 「每个调用方都记得先调 normalizeImportedGroup」正是这条暗门当初的成因
//   （见 mutationOps.ts 的 P1-1 注释）。落盘路径不能依赖调用方的自觉。
//
// 【判据 3 · 用户可见后果】两种形状都不许发生：
//   · 形状 A ⇒ 视图里标签数**不减**；
//   · 形状 B ⇒ 那一组**不许被丢弃**（导入数仍是 1）。
//
// 【判据 4 · 跨设备后果】落盘行的标签经 `serializeTab` 上云时**不得**带
//   `is_deleted`，经 `deserializeTab` 读回来也不得变成墓碑 ——
//   这是「别的设备上那条标签也不见了」这条路径的直接钉法。
//
// 【判据 5 · 印记】导入的标签**不得**带着文件里（别的设备）的操作印记：
//   印记里的 `s` 是本机 Lamport 时钟的输入（utils/seqRegistry.ts 的
//   maxObservedSeq）⇒ 一份被手改过/被篡改的备份能把本机时钟顶上天文数字
//   ⇒ 本机之后的每次写入都用天文数字的序号 ⇒ 合并时别的设备的较新编辑
//   **一律输给本机** ⇒ 那些编辑被覆盖丢失。
//
// ── 变异自证 ─────────────────────────────────────────────────────────────
//
// 见 tests/guards/importTabTombstoneInjectionMutation.test.ts。
// 每一条变异都实测过：改坏 ⇒ 守卫变红（红在目标断言上）；
// 等价改写 ⇒ 守卫**仍然绿**（证明它钉的是行为，不是长相）。
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
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

// ⚠️ 必须在任何 `await import('@/...')` 之前装好环境（storage-kv 首次 import
// 时就要挑驱动）。每个测试文件是独立进程，桩不跨文件泄漏。
installEngineStorageEnv();

if (!process.env.VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const NOW = '2026-10-23T08:00:00.000Z';
/** 本机这次导入操作盖的印记（落盘层盖的就是它）。 */
const STAMP = { d: 'devA', s: 3 };

/** 一份**部分标签带墓碑**的备份（形状 A：组留着，那条标签隐形）。 */
const PARTIAL_TOMBSTONE_GROUP = {
  id: 'injected-tab-1',
  name: '被注入标签墓碑的会话',
  tabs: [
    {
      id: 'tab-live',
      url: 'https://example.com/live',
      title: '活着的标签',
      createdAt: NOW,
      lastAccessed: NOW,
      pinned: false,
    },
    {
      id: 'tab-dead',
      url: 'https://example.com/dead',
      title: '被注入墓碑的标签',
      createdAt: NOW,
      lastAccessed: NOW,
      pinned: false,
      // ← 注入载荷：文件里的标签级墓碑（isDeleted 与它的时刻 deletedAt）
      isDeleted: true,
      deletedAt: NOW,
    },
  ],
  createdAt: NOW,
  updatedAt: NOW,
  isLocked: false,
  version: 1,
};

/** 一份**每个标签都带墓碑**的备份（形状 B：整组被判空丢弃）。 */
const ALL_TOMBSTONE_GROUP = {
  id: 'injected-tab-2',
  name: '整组带墓碑的会话',
  tabs: [
    {
      id: 'tab-a',
      url: 'https://example.com/a',
      title: 'A',
      createdAt: NOW,
      lastAccessed: NOW,
      pinned: false,
      isDeleted: true,
    },
    {
      id: 'tab-b',
      url: 'https://example.com/b',
      title: 'B',
      createdAt: NOW,
      lastAccessed: NOW,
      pinned: false,
      isDeleted: true,
    },
  ],
  createdAt: NOW,
  updatedAt: NOW,
  isLocked: false,
  version: 1,
};

/**
 * 一份标签带着**外来印记**的备份。
 *
 * v1.2x 的正常导出就会带 `lastOp`（每条标签都盖过印记），所以这不是
 * 「假想载荷」，而是**真实存在的文件形状**。区别只在数值：一个正常文件里的
 * `s` 与源设备当时的号位同量级，而被手改过的文件可以写一个天文数字。
 */
const FOREIGN_STAMP_GROUP = {
  id: 'injected-stamp-1',
  name: '带着外来印记的会话',
  tabs: [
    {
      id: 'tab-x',
      url: 'https://example.com/x',
      title: 'X',
      createdAt: NOW,
      lastAccessed: NOW,
      pinned: false,
      lastOp: { d: 'otherDevice', s: 1e15 },
    },
  ],
  createdAt: NOW,
  updatedAt: NOW,
  isLocked: false,
  version: 1,
};

/** 每次调用给一个新 id（导入永远新建组/标签）。 */
const seqIds = (): (() => string) => {
  let i = 0;
  return () => `imported-${++i}`;
};

before(async () => {
  register(LOADER_PATH);
  const { storage } = await import('@/utils/storage');
  await storage.setOpStampMigrated(true);
});

beforeEach(async () => {
  const { storage, invalidateGroupsCache } = await import('@/utils/storage');
  // ⚠️ 必须擦干净地板：上一个用例留下的组会混进下一个用例的断言。
  await storage.setGroupsImmediate([]);
  invalidateGroupsCache();
});

describe('DS-43-3（标签级）· 注入标签墓碑的备份不得让标签隐形', () => {
  it('归一化层：每个标签的 isDeleted 恒为 false（上游归一化这一道）', async () => {
    const { normalizeImportedGroup } = await import('@/core/normalizeTabsData');

    const normalized = normalizeImportedGroup(PARTIAL_TOMBSTONE_GROUP);

    assert.equal(normalized.tabs.length, 2, '前置：两条标签都得在');
    for (const tab of normalized.tabs) {
      assert.notEqual(
        tab.isDeleted,
        true,
        '归一化之后标签仍带墓碑 —— 备份文件可以决定本地标签「已删除」' +
          '（视图层会把它滤掉、别的设备上它也会消失）'
      );
      assert.equal(
        tab.isDeleted,
        false,
        '标签级 isDeleted 必须被**显式**归零为 false（形状确定，' +
          '不依赖「字段不存在 ⇒ falsy」这种约定）'
      );
      assert.equal(
        tab.deletedAt,
        undefined,
        '墓碑的**时刻**也必须归零 —— 它是同一个墓碑的另一个字段名，' +
          '留着它等于给下一个人留一把「改判定口径就复活」的钥匙'
      );
    }
  });

  it('落盘层：每个标签的 isDeleted 恒为 false（applyImportGroups 这一道）', async () => {
    const { applyImportGroups } = await import('@/core/mutationOps');
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');

    // 【前置】这一步**不经过** normalizeImportedGroup ⇒ 载荷是脏的。
    // 这正是 applyImportGroups 必须自己守一道的原因（它有三个入口，
    // 载荷来自用户手上的文件或跨进程消息 ⇒ 不可信）。
    const { imported } = applyImportGroups(
      [],
      [PARTIAL_TOMBSTONE_GROUP as never],
      { genId: seqIds(), sanitizeUrl: sanitizeTabUrl },
      NOW,
      STAMP
    );

    assert.equal(imported.length, 1, '前置：这一组本身有内容，必须真的落盘');
    assert.equal(imported[0].tabs.length, 2, '两条标签都必须落盘');
    for (const tab of imported[0].tabs) {
      assert.notEqual(
        tab.isDeleted,
        true,
        'applyImportGroups 把落盘路径交给了调用方的自觉 —— ' +
          '备份文件仍能决定本地标签「已删除」'
      );
      assert.equal(tab.isDeleted, false, '标签级 isDeleted 必须被显式归零为 false');
      assert.equal(
        tab.deletedAt,
        undefined,
        '墓碑的时刻也必须归零（否则将来改用 deletedAt 判定，墓碑又活了）'
      );
    }
  });

  it('形状 A：落盘后视图里的标签数不减（用户看得见那条标签）', async () => {
    const { applyImportGroups } = await import('@/core/mutationOps');
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');
    const { toActiveGroupsView } = await import('@/store/slices/tabSliceHelpers');

    const { groups } = applyImportGroups(
      [],
      [PARTIAL_TOMBSTONE_GROUP as never],
      { genId: seqIds(), sanitizeUrl: sanitizeTabUrl },
      NOW,
      STAMP
    );

    const view = toActiveGroupsView(groups);
    assert.equal(view.length, 1, '导入的会话在列表里看不见');
    assert.equal(
      view[0].tabs.length,
      2,
      '导入的会话在列表里**少了一条标签** —— 用户看到的是「导入了，但少了一条」，零解释'
    );
  });

  it('形状 B：整组标签都带墓碑的那一组不许被丢弃（不许「导入成功，0 个会话」）', async () => {
    const { applyImportGroups } = await import('@/core/mutationOps');
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');

    const { imported } = applyImportGroups(
      [],
      [ALL_TOMBSTONE_GROUP as never],
      { genId: seqIds(), sanitizeUrl: sanitizeTabUrl },
      NOW,
      STAMP
    );

    assert.equal(
      imported.length,
      1,
      '整组被判成「空组」而丢弃 —— 用户导入了，列表里一个会话都没多，' +
        '而提示还会甩锅「文件里有空会话」（文件里明明有内容）'
    );
    assert.equal(imported[0].tabs.length, 2, '两条标签都必须还在');
  });

  it('上云载荷不得带墓碑（跨设备后果：别的设备上那条标签也不见了）', async () => {
    const { applyImportGroups } = await import('@/core/mutationOps');
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');
    const { serializeTab, deserializeTab } = await import('@/core/tabDataCodec');

    const { imported } = applyImportGroups(
      [],
      [PARTIAL_TOMBSTONE_GROUP as never],
      { genId: seqIds(), sanitizeUrl: sanitizeTabUrl },
      NOW,
      STAMP
    );
    const persisted = imported[0];

    for (const tab of persisted.tabs) {
      const wire = serializeTab(tab);
      assert.equal(
        wire.is_deleted,
        undefined,
        '上云的标签行里带着 `is_deleted` ⇒ 别的设备读回来就是墓碑 ⇒ ' +
          '那条标签在**每一台设备**上都不见了'
      );

      const back = deserializeTab(wire, persisted.id);
      assert.notEqual(
        back?.isDeleted,
        true,
        '标签经「上云 → 读回」往返后变成了墓碑 —— 跨设备的静默删除'
      );
    }
  });

  it('导入的标签不得带着文件里（别的设备）的操作印记', async () => {
    const { applyImportGroups } = await import('@/core/mutationOps');
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');
    const { maxObservedSeq } = await import('@/utils/seqRegistry');

    const { imported } = applyImportGroups(
      [],
      [FOREIGN_STAMP_GROUP as never],
      { genId: seqIds(), sanitizeUrl: sanitizeTabUrl },
      NOW,
      STAMP
    );
    const persisted = imported[0];

    for (const tab of persisted.tabs) {
      assert.deepEqual(
        tab.lastOp,
        STAMP,
        '导入的标签还挂着**别的设备**的印记 —— 导入产生的行是本机新写的行，' +
          '它的印记必须由本机这次操作盖'
      );
    }

    assert.equal(
      maxObservedSeq(imported),
      STAMP.s,
      '本机 Lamport 时钟被文件里的数字顶了上去 —— 之后本机每次写入都用天文数字的序号，' +
        '合并时别的设备的较新编辑一律输给本机 ⇒ 那些编辑被覆盖丢失'
    );
  });
});

describe('DS-43-3（标签级）· 端到端：真实的导入入口也不许让标签隐形', () => {
  /**
   * 【为什么要有这一段】
   * 上面所有断言都跑在**纯函数**上（normalizeImportedGroup / applyImportGroups）。
   * 而第 42 轮的教训是：「判据层全绿 ≠ 功能被用上了」。
   *
   * 这里的判据是**唯一的真实入口**：`storage.importDetailed`
   * （UI 的文件选择器 → 它，见 HeaderDropdown.tsx）。
   * 断言的是**它落盘之后磁盘上真正的形状**与**用户看到的列表**。
   */
  it('storage.importDetailed 导入带标签墓碑的备份 ⇒ 落盘标签不是墓碑、视图里标签数不减', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    const { toActiveGroupsView } = await import('@/store/slices/tabSliceHelpers');

    const result = await storage.importDetailed({
      version: '1.0.0',
      timestamp: NOW,
      data: { groups: [PARTIAL_TOMBSTONE_GROUP as never] },
    } as never);

    assert.equal(result.ok, true, `导入必须成功（${result.reason ?? '无'}）`);
    assert.equal(result.imported, 1, '必须真的落盘了一个会话');

    invalidateGroupsCache();
    const onDisk = await storage.getGroups();
    assert.equal(onDisk.length, 1, '磁盘上必须有一行');
    for (const tab of onDisk[0].tabs) {
      assert.notEqual(
        tab.isDeleted,
        true,
        '真实入口落盘的标签仍带墓碑 —— 备份文件能决定本地标签「已删除」'
      );
      assert.equal(tab.isDeleted, false, '标签级 isDeleted 必须被显式归零为 false');
    }
    assert.equal(onDisk[0].tabs.length, 2, '两条标签都必须还在（被注入墓碑的那条不许凭空消失）');

    const view = toActiveGroupsView(onDisk);
    assert.equal(view.length, 1, '导入的会话在列表里看不见');
    assert.equal(
      view[0].tabs.length,
      2,
      '导入的会话在列表里少了一条标签 —— 用户看到的是「导入了，但少了一条」，零解释'
    );
  });

  it('端到端：整组标签都带墓碑的备份 ⇒ 导入数仍是 1（不许「成功但 0 个会话」）', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');

    const result = await storage.importDetailed({
      version: '1.0.0',
      timestamp: NOW,
      data: { groups: [ALL_TOMBSTONE_GROUP as never] },
    } as never);

    assert.equal(result.ok, true, `导入必须成功（${result.reason ?? '无'}）`);
    assert.equal(
      result.imported,
      1,
      '整组被判空丢弃 —— 用户看到「导入成功」，列表里却一个会话都没多。**数据丢。**'
    );

    invalidateGroupsCache();
    const onDisk = await storage.getGroups();
    assert.equal(onDisk.length, 1, '磁盘上必须有一行');
    assert.equal(onDisk[0].tabs.length, 2, '两条标签都必须还在');
  });
});
