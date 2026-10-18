// 覆盖下载被中止时，设置也不得被云端覆写（2026-10-18 round 10）。
//
// 【本文件要防的回归类别】下载路径上有三道「中止闸门」，每一道都承诺
// 「本地数据没被动过」：
//   ① `overwrite_empty_cloud_refused`：云端一行都没有，拿它覆盖会清空本机会话。
//      REASON_COPY 对用户说「你的本地数据没有变化」。
//   ② `validation_failed`：合并校验失败 → restoreSnapshot 回滚会话。
//   ③ `failsafe_triggered`：一次删除超过阈值 → 日志写「本轮下载已中止
//      （未写入任何数据）」，注释写「本地数据根本没被动过」。
//
// 但 mergeCloudSettingsIntoLocal 在 2026-10-17 只被挪到了①之后，②③仍排在它
// 后面 ⇒ 熔断/校验失败时用户的设置（主题、布局、通知开关）已经从云端覆写进
// 本地了，而上面那两句话是假的。restoreSnapshot 只回滚**会话**、不回滚设置，
// 所以「没被动过」在实现上根本没有兜底。
//
// 这是①在 2026-10-17 修过的同一个缺陷（tests/forceRemoteEmptyCloudGate.test.ts
// 的「refuse 时**设置**也不得被覆写」），只是当时只修了一道闸门。
//
// 覆盖面：
//   (a) 运行时：真 syncEngine + 后端替身，云端带着设置造一次熔断中止，
//       断言 settings 保持本地值（这是本文件的主用例，不是结构断言）；
//   (b) 结构：三道闸门的 return 都排在 mergeCloudSettingsIntoLocal 之前，
//       且 merge 排在 setGroupsImmediate 之前 —— 再加闸门时别再漏掉这句。

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  installFakeSyncBackend,
  resetFakeSyncBackend,
  type FakeSyncBackendHandle,
} from '../_helpers/fakeSyncBackend.ts';
import { installEngineStorageEnv, mkGroup } from '../_helpers/engineStorageEnv.ts';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOADER_PATH = pathToFileURL(resolve(ROOT, 'tests/_alias-loader.mjs')).href;

const env = installEngineStorageEnv();

if (!process.env.VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

function code(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

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
  env.failReadKeys.clear();
  const { storage, invalidateGroupsCache, DEFAULT_SETTINGS } = await import('@/utils/storage');
  // syncBackend:'webdav' 是必须的：downloadAndMerge 开头按 readConfiguredBackendId
  // 决定查不查 Supabase 账号，漏掉它会在闸门之前就被 not_authenticated 挡掉，
  // 用例变成永远为绿的假通过（同样的坑见 forceRemoteEmptyCloudGate.test.ts）。
  await storage.setSettings({
    ...DEFAULT_SETTINGS,
    syncBackend: 'webdav',
    layoutMode: 'double',
    showNotifications: true,
  });
  await storage.setGroupsImmediate([mkGroup('local-1')] as never);
  invalidateGroupsCache();
  backend.calls.broadcastDeletes.length = 0;
  backend.remoteSettings = null;
  backend.groups = [];
});

describe('覆盖下载中止时设置不得被云端覆写', () => {
  it('删除熔断中止 ⇒ 设置必须保持本地值（restoreSnapshot 不回滚设置）', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');

    // 云端：6 个有内容的组 + 3 个空壳。空壳由 dropSyncMergedGroups 剔除，
    // 于是「本轮丢弃 3 个 / 合并结果 9 个」= 33% > 20% 阈值（且总数 > 5）⇒ 熔断。
    backend.groups = [
      ...Array.from({ length: 6 }, (_, i) => mkGroup(`cloud-${i}`)),
      ...Array.from({ length: 3 }, (_, i) => mkGroup(`shell-${i}`, { tabs: [] })),
    ] as never;
    // 云端必须**真的带着设置**，否则 mergeCloudSettingsIntoLocal 会 early-return，
    // 无论顺序如何都不写 —— 用例就成了假通过。
    backend.remoteSettings = { layoutMode: 'single', showNotifications: false };

    const result = await syncEngine.downloadAndMerge({ forceRemote: true, syncSettings: true });

    assert.equal(
      result.reason,
      'failsafe_triggered',
      '前提：这一轮必须真的被熔断拦下（云端 9 个、丢弃 3 个）',
    );

    const after = await storage.getSettings();
    assert.equal(
      after.layoutMode,
      'double',
      '熔断的日志写着「未写入任何数据」、注释写着「本地数据根本没被动过」—— 设置也被覆写就等于那两句话是假的',
    );
    assert.equal(
      after.showNotifications,
      true,
      '设置不得被云端覆写；restoreSnapshot 只回滚会话，设置没有任何兜底',
    );
  });

  it('三道中止闸门都排在 mergeCloudSettingsIntoLocal 之前，且 merge 排在写入之前', () => {
    const src = code('src/services/syncEngine.ts');

    const gateReasons = [
      "'overwrite_empty_cloud_refused'",
      '`validation_failed: ${validation.reason}`',
      "'failsafe_triggered'",
    ];
    const gateAt = gateReasons.map(reason => {
      const at = src.indexOf(`reason: ${reason}`);
      assert.ok(at !== -1, `找不到闸门 ${reason}`);
      return at;
    });

    const mergeAt = src.indexOf('await mergeCloudSettingsIntoLocal()');
    assert.ok(mergeAt !== -1, '找不到 mergeCloudSettingsIntoLocal 调用点');
    const writeAt = src.indexOf('await storage.setGroupsImmediate(finalGroups)');
    assert.ok(writeAt !== -1, '找不到写入点');

    for (const [i, at] of gateAt.entries()) {
      assert.ok(
        mergeAt > at,
        `闸门 ${gateReasons[i]} 排在设置合并之后 ⇒ 中止时设置已被云端覆写，而闸门承诺「本地数据没被动过」`,
      );
    }
    assert.ok(mergeAt < writeAt, '设置合并必须排在写入之前（顺序即语义：先判定该不该覆写，再执行附带动作）');
  });

  it('设置合并仍只在「覆盖下载 + 明确要求同步设置」时发生', () => {
    const src = code('src/services/syncEngine.ts');
    const start = src.indexOf('await mergeCloudSettingsIntoLocal()');
    const guard = src.slice(Math.max(0, start - 400), start);
    assert.match(
      guard,
      /if \(opts\?\.forceRemote && opts\?\.syncSettings\) \{/,
      '普通合并下载不得碰设置（挪动位置时容易把这层门禁丢掉）',
    );
  });
});
