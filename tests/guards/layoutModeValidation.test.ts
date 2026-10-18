// 布局模式必须 fail-safe 收敛（2026-10-18 round 12）。
//
// 【本文件要防的回归类别】`layoutMode` 是唯一**被当作开关语义**使用、却没有校验的
// 枚举字段。它决定的是「点一下会变成什么」，而不是只影响渲染：
//   - 顶栏按钮读它决定目标值：`Header.handleToggleLayout` 的 `switch`（single↔double，
//     其余一律落 `default: 'single'`）；
//   - 图标的 title / aria-label 读它决定说「切换为双栏」还是「切换为单栏」
//     （`layoutMode === 'single' ? '切换双栏' : '切换单栏'`）；
//   - 列表只认 `'double'`：`TabList` 里 `layoutMode === 'double' ? 双栏 : 单栏`。
//
// 于是值一旦落在 `'single' | 'double'` 之外（老版本写下的 `'triple'`、手改过的
// 存储、另一台设备同步过来的旧行、导入的旧备份），三种读法互相矛盾：
// 列表按单栏渲染，顶栏却说「切换为单栏布局」（等于说现在是双栏），而点一下按钮
// 走 default 分支又落回 `'single'` —— 列表毫无变化。用户看到的是
// 「布局开关第一下没反应，得再点一次」。
//
// 【为什么在 storage 层修，而不是在 Header 里加判空】与 themeStyle / themeMode /
// syncIntervalMinutes 同一纪律：非法值在**读路径**就回落（fail-safe、不抛错），
// 谁读都是干净的。在 UI 层各自兜底等于把同一条规则抄 N 份，半年后必漂移。
//
// 覆盖面：
//   (a) 运行时：存储里躺着脏值时，读回来的是回落值（真跑代码，含脏值自愈回写）；
//   (b) 运行时：写路径（两个外部来源都从 setSettings 进来）收敛脏值，不落盘；
//   (c) 结构：两处校验点（真正落盘的 debouncedPersistSettings + setSettings）
//       字段清单一致 —— 只改一处会让另一条路把脏值写出去。

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

describe('布局模式的 fail-safe 收敛', () => {
  let storage: typeof import('../../src/utils/storage.ts').storage;
  let validateLayoutMode: typeof import('../../src/utils/storage.ts').validateLayoutMode;
  let DEFAULT_SETTINGS: typeof import('../../src/utils/storage.ts').DEFAULT_SETTINGS;

  before(async () => {
    register(LOADER_PATH, import.meta.url);
    ({ storage, validateLayoutMode, DEFAULT_SETTINGS } = await import('../../src/utils/storage.ts'));
    await storage.setOpStampMigrated(true);
  });

  beforeEach(() => {
    env.failReadKeys.clear();
  });

  it('判定函数：枚举内原样返回，枚举外回落单栏', () => {
    assert.equal(validateLayoutMode('single'), 'single');
    assert.equal(validateLayoutMode('double'), 'double');
    // 老版本的三栏值：类型里早没了，但存量存储/云端行/旧备份里可能还留着
    assert.equal(validateLayoutMode('triple'), 'single', '枚举外的值必须回落，否则布局开关会出现「点一下没反应」');
    assert.equal(validateLayoutMode(undefined), 'single');
    assert.equal(validateLayoutMode(null), 'single');
    assert.equal(validateLayoutMode(1), 'single', '数字 1 不能被当成合法值');
  });

  it('读路径：存储里是脏值时读回回落值（并顺手自愈回写）', async () => {
    const { kvSet } = await import('@/storage-kv/storageAdapter');
    // 直接写存储，模拟「另一台设备同步过来的旧行 / 手改过的存储」
    await kvSet('user_settings', { ...DEFAULT_SETTINGS, layoutMode: 'triple' });
    const { invalidateSettingsCache } = await import('../../src/utils/storage.ts');
    invalidateSettingsCache();

    const settings = await storage.getSettings();
    assert.equal(
      settings.layoutMode,
      'single',
      '脏值必须在这一层就被收敛：顶栏的开关语义与列表的渲染读的是同一个值',
    );
  });

  it('写路径：设置对象带脏值时不落盘（导入/云端合并都从这条路进来）', async () => {
    await storage.setSettings({ ...DEFAULT_SETTINGS, layoutMode: 'single' } as never);
    // 模拟导入备份：文件里 layoutMode 是老版本的值
    await storage.setSettings({ ...DEFAULT_SETTINGS, layoutMode: 'triple' } as never);
    const { invalidateSettingsCache } = await import('../../src/utils/storage.ts');
    invalidateSettingsCache();

    const after = await storage.getSettings();
    assert.equal(after.layoutMode, 'single', '外部来源的脏值不得落盘');
  });
});

describe('两处校验点的字段清单一致', () => {
  it('debouncedPersistSettings（真正落盘处）与 setSettings 都收敛 layoutMode', () => {
    const src = code('src/utils/storage.ts');

    const persistStart = src.indexOf('debouncedPersistSettings = debounceAsync(');
    assert.ok(persistStart !== -1, '找不到 debouncedPersistSettings');
    const persistBody = src.slice(persistStart, src.indexOf('}, 500);', persistStart));
    assert.match(
      persistBody,
      /layoutMode: validateLayoutMode\(settings\.layoutMode\)/,
      '真正写盘的那一步必须收敛 layoutMode —— 否则另一条调用路径会把脏值写出去',
    );

    const setStart = src.indexOf('async setSettings(settings: UserSettings)');
    assert.ok(setStart !== -1, '找不到 setSettings');
    const setBody = src.slice(setStart, src.indexOf('\n  }', setStart));
    assert.match(
      setBody,
      /layoutMode: validateLayoutMode\(settings\.layoutMode\)/,
      'setSettings 也要收敛：导入备份与云端行合并都从它进来',
    );
  });

  it('读路径把收敛后的值参与 needsUpdate 判定，脏值会被回写清掉', () => {
    const src = code('src/utils/storage.ts');
    assert.match(
      src,
      /const validatedLayoutMode = validateLayoutMode\(normalizedSettings\.layoutMode\);/,
      '读路径必须校验 layoutMode（与 themeStyle/themeMode 同处）',
    );
    assert.match(
      src,
      /normalizedSettings\.layoutMode !== validatedLayoutMode/,
      '脏值必须触发 needsUpdate，否则每次读都要重新校验、脏值一直留在存储里',
    );
  });
});
