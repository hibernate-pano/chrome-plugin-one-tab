// 换云盘时的归属决策闸门（2026-10-20）。
//
// ── 缺陷形状 ──────────────────────────────────────────────────────────────
// 归属待决标志（`FIRST_SYNC_PENDING`）原先是**全局单值**，判据是
// 「本机此前有没有配过自带存储」（`WebDavSettings` 的 `wasConfigured`）。
//
// 于是「**换云盘**」与「**同一个云盘重设密码**」在判据上**完全一样**
// （两者都是 `wasConfigured === true` ⇒ 两者都不置位）——
// 而它们的**后果完全不同**：
//   · 重设密码 ⇒ 还是同一个库 ⇒ 归属决定不变；
//   · 换云盘   ⇒ **另一个库** ⇒ 归属是**另一个决定**。
//
// 后果：换到云盘 B 时，本机的历史会话被**全量推上 B**
// （适配器见远端为空 ⇒ `firstSync = true` ⇒ 全量上传），
// 而用户从来没有被问过「这些会话归 B 吗」。
// 那正是 2026-10-18 P1#4 明令禁止的「多传」，**不可回滚**。
//
// ── 修法 ──────────────────────────────────────────────────────────────────
// 待决位改成**按库寻址**（口径与同步水位线一致：
// `baseUrl | username | rootPath` 三者任一变化都意味着「另一个库」），
// 判据从「配没配过」升级为「**库的身份变了没有**」。
//
// ── 这份测试钉的是**不变量**，不是字面量 ─────────────────────────────────
//   1. 首次配置 ⇒ 置位（拦得住）；
//   2. 换云盘（地址 / 账号 / 目录**任一**变化）⇒ 重新置位（拦得住）；
//   3. 同一个库重设密码 ⇒ **不**重新置位（不误拦）；
//   4. 归属决策做完 ⇒ 待决位清掉；
//   5. 老用户磁盘上的旧格式待决位 ⇒ 读出来的语义明确且安全（保守方向）。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { installEngineStorageEnv } from '../_helpers/engineStorageEnv.ts';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '_alias-loader.mjs')
).href;

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

if (!process.env.VERBOSE) {
  console.log = () => {};
}

/** 一个具体的库（地址 / 账号 / 目录）。 */
const lib = (over: Partial<{ baseUrl: string; username: string; rootPath: string }> = {}) => ({
  baseUrl: over.baseUrl ?? 'https://dav.example.com/dav/',
  username: over.username ?? 'me@example.com',
  rootPath: over.rootPath ?? 'TapStack',
});

before(async () => {
  register(LOADER_PATH);
  // ⚠️ 必须搭出扩展运行时的存储环境（localStorage 桩）——
  // 缺了它 `kvSet` 会**静默不写**（storageAdapter:184 `if (!driver) return`），
  // 于是「set 成功但 get 恒 false」（见 firstSyncPendingGate.test.ts 的同一提醒）。
  installEngineStorageEnv();
});

// ════════════════════════════════════════════════════════════════════════
// 1. 判据本身（纯函数）：什么情况该重新置位
// ════════════════════════════════════════════════════════════════════════
describe('归属闸门判据：库的身份变了没有', () => {
  it('首次配置（从没有库到有库）⇒ 必须重新置位', async () => {
    const { shouldEnterOwnershipPending } = await import('@/sync-backend/webdav/firstSyncDecision');
    assert.equal(
      shouldEnterOwnershipPending({ saved: null, target: lib() }),
      true,
      '首次配置必须置位 —— 那是 2026-10-18 真机实测出来的那条保护，别动'
    );
  });

  it('换云盘：地址 / 账号 / 目录**任一**变化 ⇒ 必须重新置位', async () => {
    const { shouldEnterOwnershipPending } = await import('@/sync-backend/webdav/firstSyncDecision');
    const saved = lib();
    // 三个维度各自变化一次 —— 每一个都必须触发重新置位。
    // ⚠️ 少写一个维度，那个维度的换盘就会**静默多传**（不可回滚）。
    for (const [label, target] of [
      ['地址变了', lib({ baseUrl: 'https://other.example.com/dav/' })],
      ['账号变了', lib({ username: 'other@example.com' })],
      ['目录变了', lib({ rootPath: 'OtherDir' })],
    ] as const) {
      assert.equal(
        shouldEnterOwnershipPending({ saved, target }),
        true,
        `${label} ⇒ 另一个库 ⇒ 必须重新置位（否则历史会话被静默推上新库）`
      );
    }
  });

  it('同一个库重设密码 / 改加密口令 ⇒ **不得**重新置位（不误拦）', async () => {
    const { shouldEnterOwnershipPending } = await import('@/sync-backend/webdav/firstSyncDecision');
    const saved = lib();
    // 「重设密码」在配置层**不改变**这三个字段 ⇒ 身份没变 ⇒ 不置位。
    // 拦了会让同步莫名停摆且零提示 —— 那是老用户重设密码的既有行为。
    assert.equal(
      shouldEnterOwnershipPending({ saved, target: lib() }),
      false,
      '同一个库重设密码不得被重新拦住（否则用户刚解锁就又要重做一次归属决定）'
    );
  });

  it('地址的写法差异（尾斜杠 / 大小写 host）不算换库', async () => {
    const { shouldEnterOwnershipPending } = await import('@/sync-backend/webdav/firstSyncDecision');
    // 规范化口径与运行时一致（`client.ts` 的 `normalizeBaseUrl`：
    // 目录地址统一带尾斜杠；host 由 URL 解析器小写化）。
    const saved = lib();
    const sameButWrittenDifferently = lib({ baseUrl: 'https://DAV.example.com/dav' });
    assert.equal(
      shouldEnterOwnershipPending({ saved, target: sameButWrittenDifferently }),
      false,
      '同一个库换个写法不该被当成换库（否则用户白跑一次归属决定）'
    );
  });

  it('目录留空 = 默认目录 ⇒ 不算换库', async () => {
    const { shouldEnterOwnershipPending } = await import('@/sync-backend/webdav/firstSyncDecision');
    // 「表单里目录空着」与「磁盘上写着 TapStack」是**同一个库** ——
    // 否则用户只是重填了一次密码就被重新拦住。
    const saved = lib({ rootPath: 'TapStack' });
    const target = lib({ rootPath: '' });
    assert.equal(
      shouldEnterOwnershipPending({ saved, target }),
      false,
      '空目录 = 默认目录，不得被当成换库'
    );
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2. 库的身份口径（纯函数）
// ════════════════════════════════════════════════════════════════════════
describe('库的身份：口径必须与水位线一致', () => {
  it('地址 / 账号 / 目录任一变化 ⇒ 身份不同', async () => {
    const { sameLibrary } = await import('@/sync-backend/webdav/libraryIdentity');
    const base = lib();
    assert.equal(sameLibrary(base, base), true, '同一个库必须认得出来');
    assert.equal(sameLibrary(base, lib({ baseUrl: 'https://b.example.com/' })), false);
    assert.equal(sameLibrary(base, lib({ username: 'x@example.com' })), false);
    assert.equal(sameLibrary(base, lib({ rootPath: 'X' })), false);
  });

  it('null（没配过）与任何库都不同', async () => {
    const { sameLibrary } = await import('@/sync-backend/webdav/libraryIdentity');
    assert.equal(
      sameLibrary(null, lib()),
      false,
      '「没配过」不是「某个库」—— 第一次配置必须当成新库'
    );
  });

  it('账号大小写不同 ⇒ 不同库（WebDAV 账号通常大小写敏感）', async () => {
    const { sameLibrary } = await import('@/sync-backend/webdav/libraryIdentity');
    assert.equal(
      sameLibrary(lib({ username: 'Me@Example.com' }), lib({ username: 'me@example.com' })),
      false,
      '账号大小写折叠会把两个不同的账号当成同一个 ⇒ 归属决定被错误继承'
    );
  });

  it('身份串不会因为分隔符而撞车（账号/路径里可能含 | ）', async () => {
    const { libraryIdentityOf } = await import('@/sync-backend/webdav/libraryIdentity');
    // 直接拼 `a|b|c` 的话，这两组会撞成同一个：
    const a = libraryIdentityOf({ baseUrl: 'https://x/|', username: 'c', rootPath: 'r' });
    const b = libraryIdentityOf({ baseUrl: 'https://x/', username: '|c', rootPath: 'r' });
    assert.notEqual(
      a,
      b,
      '身份串撞车 ⇒ 一个库的归属决定被另一个库继承 ⇒ 多传（不可回滚）'
    );
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3. 存储层：按库寻址的待决位（真存储、真读写）
// ════════════════════════════════════════════════════════════════════════
describe('存储层：待决位按库寻址', () => {
  it('A 库待决 ⇒ 读 A 库为真；读 B 库（没记录）为假', async () => {
    const { storage } = await import('@/utils/storage');
    const { libraryScopeKey } = await import('@/sync-backend/webdav/libraryIdentity');
    const scopeA = libraryScopeKey(lib({ baseUrl: 'https://a.example.com/' }));
    const scopeB = libraryScopeKey(lib({ baseUrl: 'https://b.example.com/' }));

    await storage.setFirstSyncPending(true, scopeA);
    assert.equal(
      await storage.getFirstSyncPending(scopeA),
      true,
      '置位必须可读回'
    );
    assert.equal(
      await storage.getFirstSyncPending(scopeB),
      false,
      'B 库没有待决记录 ⇒ 读 B 库不该被 A 库的待决状态污染'
    );
  });

  it('A 库归属决策做完 ⇒ A 库清掉，且**不影响** B 库', async () => {
    const { storage } = await import('@/utils/storage');
    const { libraryScopeKey } = await import('@/sync-backend/webdav/libraryIdentity');
    const scopeA = libraryScopeKey(lib({ baseUrl: 'https://a.example.com/' }));
    const scopeB = libraryScopeKey(lib({ baseUrl: 'https://b.example.com/' }));

    await storage.setFirstSyncPending(true, scopeA);
    await storage.setFirstSyncPending(true, scopeB);
    await storage.setFirstSyncPending(false, scopeA);
    assert.equal(await storage.getFirstSyncPending(scopeA), false, 'A 库的归属决策做完了');
    assert.equal(
      await storage.getFirstSyncPending(scopeB),
      true,
      'B 库的未决决定不能被 A 库的决定清掉（那是另一个决定）'
    );
  });

  it('切换读写作用域 = 模拟「换云盘后重新进入待决」', async () => {
    const { storage } = await import('@/utils/storage');
    const { libraryScopeKey } = await import('@/sync-backend/webdav/libraryIdentity');
    const scopeA = libraryScopeKey(lib({ baseUrl: 'https://a.example.com/' }));
    const scopeB = libraryScopeKey(lib({ baseUrl: 'https://b.example.com/' }));

    // A 库：归属决策做完了（待决位已清）。
    await storage.setFirstSyncPending(false, scopeA);
    // 换到 B 库 ⇒ 置位（B 库没有过归属决定）。
    await storage.setFirstSyncPending(true, scopeB);
    assert.equal(
      await storage.getFirstSyncPending(scopeB),
      true,
      '换云盘后必须重新拦住（历史会话不能被静默推上新库）'
    );
  });
});

// ════════════════════════════════════════════════════════════════════════
// 4. 旧格式的迁移（老用户磁盘上的全局单值）
// ════════════════════════════════════════════════════════════════════════
describe('旧格式的全局单值：迁移语义必须明确且安全', () => {
  it('旧值 true ⇒ 保守方向：没有显式记录的库都算待决', async () => {
    const { kvSet } = await import('@/storage-kv/storageAdapter');
    const { STORAGE_KEYS } = await import('@/storage-kv/keys');
    const { storage } = await import('@/utils/storage');
    const { libraryScopeKey } = await import('@/sync-backend/webdav/libraryIdentity');

    // 老用户磁盘上的形状：一个全局布尔值。
    await kvSet(STORAGE_KEYS.FIRST_SYNC_PENDING, true);
    const scope = libraryScopeKey(lib({ baseUrl: 'https://legacy.example.com/' }));
    assert.equal(
      await storage.getFirstSyncPending(scope),
      true,
      '旧值 true ⇒ 当前库算待决（保守方向：多挡一次、少传一次；「多传」不可回滚）'
    );
  });

  it('旧值 false ⇒ 不挡（老用户升级后不被无端降级）', async () => {
    const { kvSet } = await import('@/storage-kv/storageAdapter');
    const { STORAGE_KEYS } = await import('@/storage-kv/keys');
    const { storage } = await import('@/utils/storage');
    const { libraryScopeKey } = await import('@/sync-backend/webdav/libraryIdentity');

    await kvSet(STORAGE_KEYS.FIRST_SYNC_PENDING, false);
    const scope = libraryScopeKey(lib({ baseUrl: 'https://legacy.example.com/' }));
    assert.equal(
      await storage.getFirstSyncPending(scope),
      false,
      '旧值 false ⇒ 没有待决 ⇒ 不能让老用户被无端挡住同步'
    );
  });

  it('显式记录**优先于**旧格式（归属决策做完 ⇒ 不该被陈旧的旧值重新拦住）', async () => {
    const { kvSet } = await import('@/storage-kv/storageAdapter');
    const { STORAGE_KEYS } = await import('@/storage-kv/keys');
    const { storage } = await import('@/utils/storage');
    const { libraryScopeKey } = await import('@/sync-backend/webdav/libraryIdentity');

    await kvSet(STORAGE_KEYS.FIRST_SYNC_PENDING, true);
    const scope = libraryScopeKey(lib({ baseUrl: 'https://legacy.example.com/' }));
    // 用户在这个库上做完归属决策 ⇒ 写入显式记录。
    await storage.setFirstSyncPending(false, scope);
    assert.equal(
      await storage.getFirstSyncPending(scope),
      false,
      '显式的「已完成」必须压住旧格式的 true（否则用户刚做完三选一又被拦住）'
    );
  });

  it('迁移是**幂等**的：反复读写不会变形', async () => {
    const { kvSet } = await import('@/storage-kv/storageAdapter');
    const { STORAGE_KEYS } = await import('@/storage-kv/keys');
    const { storage } = await import('@/utils/storage');
    const { libraryScopeKey } = await import('@/sync-backend/webdav/libraryIdentity');
    const scope = libraryScopeKey(lib({ baseUrl: 'https://legacy.example.com/' }));

    await kvSet(STORAGE_KEYS.FIRST_SYNC_PENDING, true);
    // 第一次写：旧格式被规范化成记录（形状**必然**变一次 —— 那就是迁移本身）。
    await storage.setFirstSyncPending(true, scope);
    const first = await kvGetRaw();
    // 第二次写：形状必须**一字不变**（这才是幂等）。
    await storage.setFirstSyncPending(true, scope);
    const second = await kvGetRaw();
    assert.equal(
      JSON.stringify(second),
      JSON.stringify(first),
      '重复置位不得改变记录的形状（幂等）'
    );
    // 语义也不能变：仍是待决。
    assert.equal(
      await storage.getFirstSyncPending(scope),
      true,
      '迁移后语义不变（仍待决）'
    );
  });

  const kvGetRaw = async (): Promise<unknown> => {
    const { kvGet } = await import('@/storage-kv/storageAdapter');
    const { STORAGE_KEYS } = await import('@/storage-kv/keys');
    return kvGet(STORAGE_KEYS.FIRST_SYNC_PENDING);
  };
});

// ════════════════════════════════════════════════════════════════════════
// 5. 接线：真实的保存流程必须走新的判据
// ════════════════════════════════════════════════════════════════════════
describe('接线：设置页的保存流程走「库的身份变了没有」', () => {
  const STRIP = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const readSrc = async (p: string): Promise<string> => {
    const { readFileSync } = await import('node:fs');
    // 本文件在 `tests/guards/` 下 ⇒ 仓库根要往上两级。
    return STRIP(
      readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', p), 'utf8')
    );
  };

  it('保存流程必须用 shouldEnterOwnershipPending（不再是「有没有配过」）', async () => {
    const src = await readSrc('src/components/sync/WebDavSettings.tsx');
    assert.match(
      src,
      /shouldEnterOwnershipPending\(/,
      '保存流程必须走「库的身份变了没有」这个判据'
    );
    // 旧判据必须**不再**是置位的条件：只要它在，缺陷就还在
    // （它对「换云盘」返回 false ⇒ 不置位 ⇒ 历史会话被推上新库）。
    assert.ok(
      !/if\s*\(\s*!\s*wasConfigured\s*\)/.test(src),
      '「!wasConfigured」不能再作为置位条件 —— 那是缺陷本身的判据'
    );
  });

  it('待决位的写入必须带作用域（按库寻址）', async () => {
    const src = await readSrc('src/components/sync/WebDavSettings.tsx');
    // 置位的那次调用必须指向**目标库**的作用域。
    assert.match(
      src,
      /setFirstSyncPending\(\s*pending\s*,\s*targetScope\s*\)|storage\.setFirstSyncPending\(pending, targetScope\)/,
      '置位必须写到目标库的作用域（写错了库 ⇒ 决定记在别处 ⇒ 下次又被拦住）'
    );
  });

  it('引擎侧读待决位时必须能落到「本机当前指向的库」', async () => {
    const src = await readSrc('src/utils/storage.ts');
    // 省略 scope ⇒ 自动解析为「本机当前指向的库」（读磁盘上的已保存配置）。
    assert.match(
      src,
      /scope\s*\?\?\s*\(await resolveCurrentLibraryScope\(\)\)/,
      '省略 scope 时必须自动解析成当前库（后台引擎读的就是它）'
    );
  });

  it('被拦住时，界面必须**如实说明**为什么（并给出下一步）', async () => {
    const { ownershipPendingNotice } = await import('@/sync-backend/webdav/firstSyncDecision');
    const notice = ownershipPendingNotice({ localCount: 12, scopeLabel: 'https://dav.example.com/' });
    // 三件事：发生了什么 / 为什么 / 下一步做什么。
    assert.match(notice, /12/, '必须报出真实的会话数（不许编）');
    assert.match(notice, /需要你来决定|不会替你决定/, '必须说清「为什么被拦住」');
    assert.match(notice, /检查并推送/, '必须给出可操作的下一步');
  });

  it('读不到会话数时**不报数字**（不许编一个）', async () => {
    const { ownershipPendingNotice } = await import('@/sync-backend/webdav/firstSyncDecision');
    const notice = ownershipPendingNotice({ localCount: null, scopeLabel: 'x' });
    assert.ok(
      !/\d+\s*个会话/.test(notice),
      '读不到会话数时不得报一个数字（那是谎话）'
    );
    assert.match(notice, /检查并推送/, '机制与下一步照说（那部分不依赖计数）');
  });

  it('设置页必须把待决状态渲染出来（否则用户只看到「同步不动」）', async () => {
    const src = await readSrc('src/components/sync/WebDavSettings.tsx');
    assert.match(
      src,
      /ownershipPendingNotice\(/,
      '设置页必须渲染归属待决的说明'
    );
  });
});
