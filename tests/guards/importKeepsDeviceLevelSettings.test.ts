// 导入备份不得把设备级字段带进本机（2026-10-18 round 11）。
//
// 【本文件要防的回归类别】导出/备份文件是**用户手上的外来文件**，而
// `importDetailed` 会把它整份展开进本机设置（`{...currentSettings, ...settings}`）。
// 其中 `syncBackend` / `syncEnabled` / `syncIntervalMinutes` 是设备级字段
// （定义见 @/types/tab 的 DEVICE_LEVEL_SETTING_KEYS）：
//   - B 机导入 A 机的备份 ⇒ 本机 syncBackend 变成 A 机那个后端，而 WebDAV
//     凭据不进 UserSettings ⇒ 同步立刻坏掉，用户只看到「同步失败/请先登录」，
//     无从判断是自己的后端被换了。
//   - syncEnabled / syncIntervalMinutes 描述本机后台行为，被 A 机的选择改掉。
//
// 这与 round 9（上云）和 round 10（云端合并）是同一条线：云端与备份只承载
// 外观与操作偏好。三条外来设置路径都要剔，这条是第三条。
//
// 覆盖面：
//   (a) 运行时：真 storage.importDetailed，备份里带着另一台机器的三个字段，
//       断言本机三个字段保持原值、**同时**外观偏好确实被应用
//       （后半句是本用例的防假绿判据：若导入整体失败，设置压根不会合并，
//        前半句会「意外」通过）；
//   (b) 结构：剔除发生在 setSettings 之前，且用的是同一份 DEVICE_LEVEL_SETTING_KEYS
//       ——不许在导入路径上手抄一份键名，那是半年后漂移的起点。

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
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

describe('导入备份不得带进设备级字段', () => {
  let storage: typeof import('../../src/utils/storage.ts').storage;

  before(async () => {
    register(LOADER_PATH, import.meta.url);
    ({ storage } = await import('../../src/utils/storage.ts'));
    await storage.setOpStampMigrated(true);
  });

  beforeEach(async () => {
    env.failReadKeys.clear();
    const { DEFAULT_SETTINGS } = await import('../../src/utils/storage.ts');
    // 本机这台设备的选择：自带存储 + 关掉自动同步 + 10 分钟档。
    await storage.setSettings({
      ...DEFAULT_SETTINGS,
      syncBackend: 'webdav',
      syncEnabled: false,
      syncIntervalMinutes: 10,
      layoutMode: 'double',
      showNotifications: true,
    });
  });

  it('备份里的设备级字段被忽略，外观偏好照常应用', async () => {
    const result = await storage.importDetailed({
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      data: {
        groups: [mkGroup('imported-1')],
        // 另一台机器的设置：后端是 TapStack 云端、自动同步开着、5 分钟档，
        // 同时外观偏好也不同（单栏、关通知）。
        settings: {
          syncBackend: 'supabase',
          syncEnabled: true,
          syncIntervalMinutes: 5,
          layoutMode: 'single',
          showNotifications: false,
        },
      },
    } as never);

    assert.equal(result.ok, true, '前提：这次导入必须真的成功，否则设置压根不会合并');

    const after = await storage.getSettings();

    // 防假绿：外观偏好必须真的被应用（证明设置合并这条支路跑到了）
    assert.equal(after.layoutMode, 'single', '外观偏好是备份该恢复的内容，必须照常应用');
    assert.equal(after.showNotifications, false, '同上');

    // 设备级字段必须保持本机原值
    assert.equal(after.syncBackend, 'webdav', '同步后端是本机选择：备份里的 supabase 不得生效（本机没有那里的登录态）');
    assert.equal(after.syncEnabled, false, '自动同步开关描述本机后台行为，不得被备份改掉');
    assert.equal(after.syncIntervalMinutes, 10, '轮询间隔同理');
  });
});

describe('导入路径的剔除接线', () => {
  it('剔除发生在 setSettings 之前，且复用同一份 DEVICE_LEVEL_SETTING_KEYS', () => {
    const src = code('src/utils/storage.ts');
    const start = src.indexOf('async importDetailed(');
    assert.ok(start !== -1, '找不到 importDetailed');
    const body = src.slice(start, src.indexOf('\n  }\n', start));

    const stripAt = body.indexOf('delete importedSettings[key]');
    assert.ok(stripAt !== -1, '导入必须剔除设备级字段（备份是外来文件，可能来自另一台机器）');
    assert.ok(
      stripAt < body.indexOf('await this.setSettings('),
      '剔除必须发生在写设置之前 —— 顺序即语义',
    );
    assert.match(
      body,
      /for \(const key of DEVICE_LEVEL_SETTING_KEYS\)/,
      '不许在导入路径上手抄一份键名：三处路径必须共用同一份定义，否则半年后就漂移',
    );
  });

  it('剔除是非破坏性的：传入的 data 不被就地修改', () => {
    const src = code('src/utils/storage.ts');
    const start = src.indexOf('async importDetailed(');
    const body = src.slice(start, src.indexOf('\n  }\n', start));
    assert.match(
      body,
      /const importedSettings = \{ \.\.\.data\.data\.settings \};/,
      '必须拷一份再删；就地 delete 会把调用方手里的对象改掉',
    );
  });
});
