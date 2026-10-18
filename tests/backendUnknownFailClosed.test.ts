// 「读不到本机设置」= 无法回答，不是「用户选了 supabase」（2026-10-18 B 组）。
//
// ── 缺陷形状 ──────────────────────────────────────────────────────────────
// `readConfiguredBackendId` 的 catch 曾 `return 'supabase'`，于是两种完全不同的
// 事从上层不可区分：
//   (a) 用户真的选了 TapStack 云端  → 该去查 Supabase 账号；
//   (b) kvGet 抛错（死句柄看门狗 abort / 事务 abort / quota）→ 该中止本轮。
// 而 (b) 被当成 (a) 的两个后果都出过事故：
//   · 门禁去查 Supabase 账号 ⇒ 自带存储用户看到「用户未登录」，且永远走不到
//     锁定后端那句「去重新解锁」（2026-10-14 真机 E2E 抓到的）；
//   · 首次同步归属待决期的抑制判据若写 `=== 'webdav'`，null 会让抑制关闭
//     ⇒ 上传清单退回全量 ⇒ 历史会话整批推上用户云盘（2026-10-18 P1#4 禁的多传）。
//
// ── 修法 ──────────────────────────────────────────────────────────────────
// 返回值加第三态 `null`（唯一来源是 catch），每个调用点显式判它并中止本轮：
//   · syncEngine.downloadAndMerge ⇒ `reason: 'backend_unknown'`（前置 return）
//   · syncEngine.upload           ⇒ `success:false` + 人话 error（前置 return）
//   · backgroundSync 轮询         ⇒ `{ ok:false, kind:'failed' }`（计入退避）
//   · WebDavSettings.runPush      ⇒ 单独一句「读不到同步设置」
//   · suppressFullUpload          ⇒ 判据 `!== 'supabase'`，null 时**保持抑制**
//
// ── 测试形态的现实约束（重要）──────────────────────────────────────────────
// 本仓库**没有** jsdom / happy-dom / @testing-library，且不允许为此装依赖
// （见 tests/a11yDialogs.test.ts 顶部注释）；`.tsx` 也无法被
// `node --experimental-strip-types` 加载。所以「行为级」在这里只能是两种形态：
//   1) 把决定**算得出行为**的判据抽成不依赖 DOM 的纯函数，直接打行为断言
//      （本文件第 3 组：`decideSuppressFullUpload`）；
//   2) 对真 `SyncEngine` 实例跑真代码，用真实的存储读失败注入
//      （`env.failReadKeys`，即 tests/autoSyncDefaultOff.test.ts 那套现成桩）
//      —— 本文件第 1、2 组。
// 余下的纯接线（哪一行调了谁）只能作源码结构护栏，不当作行为证据。
//
// ── 判别力（每条都必须能因「改坏实现」而红）───────────────────────────────
//   · 删掉 downloadAndMerge 的 null 前置 return ⇒ 第 2 组红（reason 变
//     not_authenticated，restoreAuth 被调用）；
//   · catch 改回 return 'supabase' ⇒ 第 1 组红；
//   · decideSuppressFullUpload 改成恒 true / 恒 false / `=== 'webdav'`
//     ⇒ 第 3 组红。
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  installFakeSyncBackend,
  resetFakeSyncBackend,
  type FakeSyncBackendHandle,
} from './_helpers/fakeSyncBackend.ts';
import { installEngineStorageEnv, mkGroup } from './_helpers/engineStorageEnv.ts';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

const env = installEngineStorageEnv();

if (!process.env.VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

/** 让 `user_settings` 的读抛错 —— 复用 engineStorageEnv 的键级注入能力。 */
const breakSettingsRead = (): void => {
  env.failReadKeys.add('user_settings');
};
const healSettingsRead = (): void => {
  env.failReadKeys.delete('user_settings');
};

let backend: FakeSyncBackendHandle;

before(async () => {
  register(LOADER_PATH);
  backend = await installFakeSyncBackend();
  const { storage } = await import('@/utils/storage');
  await storage.setOpStampMigrated(true);
});

after(async () => {
  await resetFakeSyncBackend();
});

beforeEach(async () => {
  healSettingsRead();
  const { storage, invalidateGroupsCache } = await import('@/utils/storage');
  await storage.setGroupsImmediate([mkGroup('local-1')] as never);
  invalidateGroupsCache();
  backend.calls.uploadGroups.length = 0;
  backend.groups = [];
});

// ── 1. 唯一真值出口：读不到 ⇒ null（不是 'supabase'）──────────────────────
describe('readConfiguredBackendId：读到 / 读不到必须可区分', () => {
  it('user_settings 读抛错 ⇒ 返回 null（不是伪装成 supabase）', async () => {
    const { readConfiguredBackendId } = await import('@/sync-backend');
    breakSettingsRead();
    try {
      assert.equal(
        await readConfiguredBackendId(),
        null,
        '❌ 读失败返回了具体后端 id —— 上层无法区分「读不到」与「用户真的选了它」，' +
          '而这两者的正确动作相反（中止本轮 vs 去查账号）'
      );
    } finally {
      healSettingsRead();
    }
  });

  it('读失败必须出声（catch 至少一条 console 级日志）', async () => {
    const { readConfiguredBackendId } = await import('@/sync-backend');
    const errors: unknown[][] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    breakSettingsRead();
    try {
      await readConfiguredBackendId();
    } finally {
      healSettingsRead();
      console.error = origError;
    }
    assert.equal(errors.length > 0, true, '❌ 读失败静默 —— 排查时无从知道这一轮为什么没同步');
  });

  it('读到 webdav / 读到 supabase / 键缺失 ⇒ 都是「读到了」', async () => {
    const { readConfiguredBackendId } = await import('@/sync-backend');
    const { kvSet } = await import('@/storage-kv/storageAdapter');
    const { DEFAULT_SETTINGS } = await import('@/utils/storage');

    await kvSet('user_settings', { ...DEFAULT_SETTINGS, syncBackend: 'webdav' });
    assert.equal(await readConfiguredBackendId(), 'webdav', '读到 webdav 必须原样返回');

    await kvSet('user_settings', { ...DEFAULT_SETTINGS, syncBackend: 'supabase' });
    assert.equal(await readConfiguredBackendId(), 'supabase', '读到 supabase 必须原样返回');

    // 键缺失是**合法默认**（DEFAULT_SETTINGS.syncBackend='supabase'），不是故障：
    // 新用户从未存过设置时就是它。若这里返回 null，所有新用户的第一轮同步
    // 都会被 backend_unknown 中止 —— 把「读不到」的语义用反了同样是 bug。
    await kvSet('user_settings', null);
    assert.equal(
      await readConfiguredBackendId(),
      'supabase',
      '❌ 键缺失被当成了「读不到」：DEFAULT_SETTINGS 的 supabase 是合法默认值'
    );
  });
});

// ── 2. 调用点：null ⇒ 中止本轮，且**不进**认证门禁 ─────────────────────────
describe('syncEngine.downloadAndMerge：读不到设置 ⇒ backend_unknown 且不查 Supabase 账号', () => {
  it('返回 backend_unknown，且 restoreAuth 一次都没被调用', async () => {
    const { syncEngine } = await import('@/services/syncEngine');

    // 判别力来源：restoreAuth 是「查 Supabase session」的唯一出口
    // （private 方法在运行时只是普通属性，这里替换成计数桩）。
    // 若 null 流进了门禁，`deps.backendId === 'webdav'` 为 false ⇒ 必走它 ⇒
    // 计数 > 0 且 reason 变成 not_authenticated。
    const engine = syncEngine as unknown as { restoreAuth: () => Promise<boolean> };
    const origRestore = engine.restoreAuth;
    let restoreCalls = 0;
    engine.restoreAuth = async () => {
      restoreCalls++;
      return false;
    };

    let result: Awaited<ReturnType<typeof syncEngine.downloadAndMerge>>;
    breakSettingsRead();
    try {
      result = await syncEngine.downloadAndMerge();
    } finally {
      healSettingsRead();
      engine.restoreAuth = origRestore;
    }

    assert.equal(
      result.reason,
      'backend_unknown',
      '❌ 读不到设置时的机器码必须是 backend_unknown；若变成 not_authenticated，' +
        '说明 null 流进了门禁（复现 2026-10-14「WebDAV 用户看到用户未登录」）'
    );
    assert.equal(result.success, false, '读不到后端就不能同步 —— 不能赌一个方向');
    assert.deepEqual(result.groups, [], '中止时不得回吐任何合并结果');
    assert.equal(
      restoreCalls,
      0,
      '❌ 读不到设置时去查了 Supabase session —— 自带存储用户永远没有它，' +
        '于是又变成「用户未登录」且到不了锁定后端那句提示'
    );
  });

  it('下载被中止时不得调用后端（零网络动作）', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage, invalidateGroupsCache, DEFAULT_SETTINGS } = await import('@/utils/storage');
    const { kvSet } = await import('@/storage-kv/storageAdapter');

    // 正对照先行：证明这两个计数器**会动**（否则下面的 0 是恒真断言，
    // 「零网络动作」就成了永远为真的空话）。
    await kvSet('user_settings', { ...DEFAULT_SETTINGS, syncBackend: 'webdav' });
    await storage.setGroupsImmediate([mkGroup('local-1')] as never);
    invalidateGroupsCache();
    await syncEngine.downloadAndMerge();
    assert.equal(
      backend.calls.downloadGroups > 0,
      true,
      '前提：正常一轮确实会调后端（计数器会动），下面的 0 才有意义'
    );

    // 现在让设置读失败，再跑一轮：后端一次都不该被碰。
    backend.calls.downloadGroups = 0;
    backend.calls.uploadGroups.length = 0;
    breakSettingsRead();
    try {
      await syncEngine.downloadAndMerge();
    } finally {
      healSettingsRead();
    }
    assert.equal(backend.calls.downloadGroups, 0, '❌ 读了云端：后端都还没确定就先去拉数据了');
    assert.equal(backend.calls.uploadGroups.length, 0, '❌ 写了云端：先把数据传上去再问传到哪儿');
  });
});

describe('syncEngine.upload：读不到设置 ⇒ 中止并说明「免得传到错误的后端」', () => {
  it('返回 success:false + 人话错误，且 restoreAuth / 后端都没被碰过', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { store } = await import('@/store');
    const { setFromCache } = await import('@/store/slices/authSlice');
    const { kvSet } = await import('@/storage-kv/storageAdapter');
    const { DEFAULT_SETTINGS } = await import('@/utils/storage');

    // ── 正对照先行（否则下面的「0 次上传」是恒真断言）──────────────────
    // 默认后端（supabase）+ store 已认证 ⇒ 上传真的会走到后端。
    // 这一步同时证明计数器会动，也让 restoreAuth 的计数基线归零。
    await kvSet('user_settings', { ...DEFAULT_SETTINGS, syncBackend: 'supabase' });
    store.dispatch(setFromCache({ user: { id: 'u1' } as never, isAuthenticated: true }));
    await syncEngine.upload();
    assert.equal(
      backend.calls.uploadGroups.length > 0,
      true,
      '前提：正常一轮确实会调后端（计数器会动），下面的 0 才有意义'
    );
    backend.calls.uploadGroups.length = 0;

    // ── 现在让设置读失败 ────────────────────────────────────────────────
    const engine = syncEngine as unknown as { restoreAuth: () => Promise<boolean> };
    const origRestore = engine.restoreAuth;
    let restoreCalls = 0;
    engine.restoreAuth = async () => {
      restoreCalls++;
      return true; // 故意返回 true：若 null 漏进门禁，上传会「成功」跑起来
    };

    let result: Awaited<ReturnType<typeof syncEngine.upload>>;
    breakSettingsRead();
    try {
      result = await syncEngine.upload();
    } finally {
      healSettingsRead();
      engine.restoreAuth = origRestore;
    }

    assert.equal(result.success, false, '读不到后端就不能上传');
    assert.match(
      String(result.error ?? ''),
      /读不到本机设置/,
      '❌ 错误文案必须说清根因是「读不到设置」；只说「用户未登录」会把存储故障' +
        '伪装成账号问题，用户去重新登录也修不好'
    );
    assert.equal(
      restoreCalls,
      0,
      '❌ 读不到设置时去查了 Supabase session（null 漏进了门禁）'
    );
    assert.equal(
      backend.calls.uploadGroups.length,
      0,
      '❌ 后端还没确定就上传了 —— 这正是「把数据传到错误的后端」'
    );
  });
});

// ── 3. 抑制判据：读不到时**保持抑制**（多传不可回滚）──────────────────────
//
// 为什么测纯函数而不是跑 upload：`upload()` 在 null 时会提前 return，
// 「null 时抑制是否生效」在运行时不可达（这正是修复的效果）。
// 判据因此抽成 `decideSuppressFullUpload`，对真值组合直接打行为断言。
describe('decideSuppressFullUpload：null（读不到）必须保持抑制', () => {
  it('待决 + 非显式 + 读不到 ⇒ 抑制（=== \'webdav\' 写法在这里会红）', async () => {
    const { decideSuppressFullUpload } = await import('@/services/syncEngine');
    assert.equal(
      decideSuppressFullUpload({
        firstSyncPending: true,
        explicitFirstSync: false,
        overwriteCloud: false,
        configuredBackendId: null,
      }),
      true,
      '❌ 读不到设置时关闭了抑制 ⇒ 上传清单退回全量 activeGroups ⇒ 归属待决期的' +
        '历史会话被整批推上用户云盘（2026-10-18 P1#4 禁的多传，不可回滚）'
    );
  });

  it('待决 + 非显式 + 读到 webdav ⇒ 抑制（自带存储专属概念）', async () => {
    const { decideSuppressFullUpload } = await import('@/services/syncEngine');
    assert.equal(
      decideSuppressFullUpload({
        firstSyncPending: true,
        explicitFirstSync: false,
        overwriteCloud: false,
        configuredBackendId: 'webdav',
      }),
      true,
      '❌ 自带存储的待决期不抑制：历史会话绕过三选一直接上云'
    );
  });

  it('待决 + 非显式 + 读到 supabase ⇒ 不抑制（残留标志不许卡住云端上传）', async () => {
    const { decideSuppressFullUpload } = await import('@/services/syncEngine');
    assert.equal(
      decideSuppressFullUpload({
        firstSyncPending: true,
        explicitFirstSync: false,
        overwriteCloud: false,
        configuredBackendId: 'supabase',
      }),
      false,
      '❌ 对云端也抑制了：白名单早被清空 ⇒ 什么都传不上去，而用户以为在同步'
    );
  });

  it('显式声明归属 ⇒ 不抑制（否则用户在设置页点了推送也推不上去）', async () => {
    const { decideSuppressFullUpload } = await import('@/services/syncEngine');
    for (const id of ['webdav', null] as const) {
      assert.equal(
        decideSuppressFullUpload({
          firstSyncPending: true,
          explicitFirstSync: true,
          overwriteCloud: false,
          configuredBackendId: id,
        }),
        false,
        `❌ ${String(id)} + 显式：三选一是唯一有资格声明归属的入口，抑制它等于让用户点了也没用`
      );
    }
  });

  it('不待决 / 覆盖模式 ⇒ 不抑制（老用户恢复全量能力；覆盖必须真的覆盖）', async () => {
    const { decideSuppressFullUpload } = await import('@/services/syncEngine');
    for (const id of ['webdav', 'supabase', null] as const) {
      assert.equal(
        decideSuppressFullUpload({
          firstSyncPending: false,
          explicitFirstSync: false,
          overwriteCloud: false,
          configuredBackendId: id,
        }),
        false,
        `❌ ${String(id)} + 非待决：老用户的全量上传被永久降级为增量`
      );
      assert.equal(
        decideSuppressFullUpload({
          firstSyncPending: true,
          explicitFirstSync: false,
          overwriteCloud: true,
          configuredBackendId: id,
        }),
        false,
        `❌ ${String(id)} + overwriteCloud：覆盖语义被白名单过滤掉 ⇒ 云端残留不删`
      );
    }
  });
});

// ── 4. 后台轮询：null ⇒ 中止本轮，不是「未登录」的让路 ────────────────────
//
// 这一条跑真代码（performBackgroundSync 经 runBackgroundSyncOnce 暴露），
// 判别力在**返回值语义**上：runBackgroundSyncOnce 只把 `not_logged_in`
// 映射成 false，其余（含本轮的 failed）都是 true。所以：
//   修复后 ⇒ true（真实故障，handleAlarm 会计入退避、下轮 alarm 重试）；
//   null 漏进 `!== 'webdav'` ⇒ 去 getCurrentUser() → 无 session →
//   not_logged_in ⇒ false（自带存储用户每轮都「未登录」自杀）。
describe('backgroundSync 轮询：读不到设置 ⇒ 失败轮，而不是未登录让路', () => {
  it('runBackgroundSyncOnce 返回 true，且日志点名「读不到同步设置」', async () => {
    const { runBackgroundSyncOnce } = await import('@/background/backgroundSync');
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
    breakSettingsRead();
    let result: boolean;
    try {
      result = await runBackgroundSyncOnce();
    } finally {
      healSettingsRead();
      console.error = origError;
    }
    assert.equal(
      result,
      true,
      '❌ 读不到设置被当成了 not_logged_in：那是「用户没登录」的让路语义，' +
        '而这里是存储故障 —— 不计入退避、不清不楚地每轮自杀（2026-10-17 B1 那条链路再次不可达）'
    );
    assert.equal(
      errors.some(l => l.includes('读不到同步设置')),
      true,
      '❌ 读不到设置时必须点名根因（logError）；否则线上日志只有「未登录」，无从排查'
    );
  });

  it('对照：读到 webdav + 无 Supabase 账号 ⇒ 走自带存储分支（不返回 not_logged_in）', async () => {
    // 反向判别力：证明上面那条不是「恒 true」的假断言。
    const { runBackgroundSyncOnce } = await import('@/background/backgroundSync');
    const { kvSet } = await import('@/storage-kv/storageAdapter');
    const { DEFAULT_SETTINGS } = await import('@/utils/storage');
    await kvSet('user_settings', { ...DEFAULT_SETTINGS, syncBackend: 'webdav' });
    assert.equal(
      await runBackgroundSyncOnce(),
      true,
      '读到 webdav 时不该去查 Supabase 账号（查了就会得到 not_logged_in）'
    );
  });
});
