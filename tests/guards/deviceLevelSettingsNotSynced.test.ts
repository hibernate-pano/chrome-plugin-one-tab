// 设备级设置字段不得上云，也不得被云端覆盖（2026-10-18 round 9）。
//
// 【本文件要防的回归类别】`syncBackend` / `syncEnabled` / `syncIntervalMinutes`
// 描述的是「这台设备拿哪个后端同步、要不要自动同步、多久一次」，而不是用户偏好。
// 让它们跟着云端走，造成的是**静默的行为改变**而不是明显的报错：
//   - `syncBackend`：WebDAV 的地址与口令本来就不进 UserSettings（凭据走独立本地键，
//     见 sync-backend/webdav/config.ts 文件头）。把 syncBackend 同步过去，对端会指向
//     一个它没有凭据的后端 ⇒ 同步坏掉，而 UI 只提示「请先登录」，用户无从判断
//     是自己的后端被换了。
//   - `syncEnabled` / `syncIntervalMinutes`：A 机关掉自动同步、B 机开着，
//     B 一次上传就把 A 的选择改回去。
//
// 【为什么两侧都要做，只做一侧不够】
// 上传侧剔除只保证「以后不再写出去」，但云端**存量行**里已经躺着这些键
// （改设置之前推上去的行、老版本写下的行）。覆盖下载时那句
// `{...localSettings, ...cloudSettings}` 是无条件展开，云端旧值照样回灌本机。
// 反之只做合并侧，则设备级字段继续被写进云端并被对端下载。
//
// 覆盖面：
//   (a) 运行时：toCloudSettings 真的剔掉这三个键，且不动其它任何字段；
//   (b) 运行时：剔除是**非破坏性**的（不改传入对象），否则调用方手里的
//       UserSettings 会跟着少三个字段，下一次写设置就把默认值落盘；
//   (c) 结构：uploadSettings 这条两个后端共用的入口确实走了 toCloudSettings
//       ——WebDAV 的 uploadSettings 是零字段过滤的整份透传，不在这里剔就全写进云盘；
//   (d) 结构：mergeCloudSettingsIntoLocal 在展开前删掉云端给的设备级键。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOADER_PATH = pathToFileURL(resolve(ROOT, 'tests/_alias-loader.mjs')).href;

function code(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('设备级字段的上云与合并', () => {
  let toCloudSettings: typeof import('../../src/services/settingsSyncService.ts').toCloudSettings;
  let DEVICE_LEVEL_SETTING_KEYS: typeof import('../../src/services/settingsSyncService.ts').DEVICE_LEVEL_SETTING_KEYS;

  before(async () => {
    register(LOADER_PATH, import.meta.url);
    ({ toCloudSettings, DEVICE_LEVEL_SETTING_KEYS } = await import(
      '../../src/services/settingsSyncService.ts'
    ));
  });

  it('剔除的正是 syncBackend / syncEnabled / syncIntervalMinutes 三个键', () => {
    assert.deepEqual(
      [...DEVICE_LEVEL_SETTING_KEYS].sort(),
      ['syncBackend', 'syncEnabled', 'syncIntervalMinutes'],
      '设备级字段清单变了：新增字段要重新判断它是否该跨设备，云端承载的是外观与操作偏好',
    );
  });

  it('上云副本不含设备级字段', async () => {
    const settings = {
      themeStyle: 'claude',
      themeMode: 'light',
      layoutMode: 'dual',
      showNotifications: true,
      groupNameTemplate: '会话 {n}',
      syncBackend: 'webdav',
      syncEnabled: true,
      syncIntervalMinutes: 30,
    } as never;

    const cloud = toCloudSettings(settings) as Record<string, unknown>;

    for (const key of DEVICE_LEVEL_SETTING_KEYS) {
      assert.ok(!(key in cloud), `${key} 是设备级字段，不得进云端设置`);
    }
  });

  it('外观与操作偏好一个都不能少（防止把剔除写成整份丢弃）', async () => {
    const settings = {
      themeStyle: 'prism',
      themeMode: 'dark',
      layoutMode: 'triple',
      showNotifications: false,
      showFavicons: false,
      showTabCount: true,
      confirmBeforeDelete: true,
      groupNameTemplate: 'T{n}',
      collectPinnedTabs: true,
      reorderMode: 'manual',
      syncBackend: 'supabase',
      syncEnabled: false,
      syncIntervalMinutes: 5,
    } as never;

    const cloud = toCloudSettings(settings) as Record<string, unknown>;

    for (const key of [
      'themeStyle',
      'themeMode',
      'layoutMode',
      'showNotifications',
      'showFavicons',
      'showTabCount',
      'confirmBeforeDelete',
      'groupNameTemplate',
      'collectPinnedTabs',
      'reorderMode',
    ]) {
      assert.equal(cloud[key], (settings as Record<string, unknown>)[key], `${key} 必须照常上云`);
    }
  });

  it('剔除是非破坏性的：调用方手里的 settings 不被就地修改', async () => {
    const settings = { themeStyle: 'claude', syncBackend: 'webdav' } as never;
    toCloudSettings(settings);
    assert.equal(
      (settings as Record<string, unknown>).syncBackend,
      'webdav',
      '就地 delete 会让调用方的 UserSettings 少三个字段 ⇒ 下一次整份写设置就把默认值落盘',
    );
  });
});

describe('两条同步路径都接上了设备级剔除', () => {
  it('上传走 toCloudSettings（这是 Supabase 与 WebDAV 共同的唯一入口）', () => {
    const src = code('src/services/settingsSyncService.ts');
    const start = src.indexOf('export async function uploadSettings(');
    assert.ok(start !== -1, '找不到 uploadSettings');
    const body = src.slice(start, src.indexOf('\n}', start));
    assert.match(
      body,
      /uploadSettings\(toCloudSettings\(settings\)/,
      'WebDAV 的 uploadSettings 是零字段过滤的整份透传，不在共用入口剔除就会整份写进用户云盘',
    );
  });

  it('覆盖下载的合并：展开前先删掉云端给的设备级键', () => {
    const src = code('src/services/syncEngine.ts');
    const start = src.indexOf('async function mergeCloudSettingsIntoLocal(');
    assert.ok(start !== -1, '找不到 mergeCloudSettingsIntoLocal');
    const body = src.slice(start, src.indexOf('\n}', start));

    const delAt = body.indexOf('delete cloudPreferences[key]');
    assert.ok(delAt !== -1, '合并必须忽略云端给的设备级字段（云端存量行里仍留有旧值）');
    assert.ok(
      delAt < body.indexOf('...cloudPreferences'),
      '剔除必须发生在展开进 convertedSettings 之前 —— 顺序即语义',
    );
    assert.ok(
      body.includes('...localSettings'),
      '本机设备级字段必须仍然是展开后的最终值',
    );
  });
});
