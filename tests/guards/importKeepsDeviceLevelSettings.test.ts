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
import { DEVICE_LEVEL_SETTING_KEYS, RETIRED_SETTING_KEYS, stripNonPortableSettings } from '@/types/tab';

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
  it('剔除发生在 setSettings 之前，且复用同一份剔除表', () => {
    const src = code('src/utils/storage.ts');
    const start = src.indexOf('async importDetailed(');
    assert.ok(start !== -1, '找不到 importDetailed');
    const body = src.slice(start, src.indexOf('\n  }\n', start));

    // 2026-10-20 审计 A-21：剔除逻辑被抽成共用函数
    // `stripNonPortableSettings`（@/types/tab），四条外来设置路径共用。
    //
    // 【为什么守卫要跟着改，而不是把代码改回去】
    // 旧守卫钉的是**写法**（`for (const key of DEVICE_LEVEL_SETTING_KEYS)`
    // + `delete importedSettings[key]`）。A-21 把这段换成了共用函数，
    // **行为完全等价**（运行时那条断言仍然是绿的）——
    // ⇒ 旧守卫会把**正确的改动**判成违规。
    // 这正是本仓反复吃的亏：守卫钉的是写法，不是事实。
    //
    // ⇒ 现在钉的是**不变量**：
    //   ① 导入路径确实调用了共用剔除函数（不是手抄一份键名）
    //   ② 剔除发生在写设置之前（顺序即语义）
    const stripAt = body.indexOf('stripNonPortableSettings(');
    assert.ok(stripAt !== -1, '导入必须剔除设备级字段（备份是外来文件，可能来自另一台机器）');
    assert.ok(
      stripAt < body.indexOf('await this.setSettings('),
      '剔除必须发生在写设置之前 —— 顺序即语义',
    );
  });

  it('四条外来设置路径共用同一个剔除函数（不许各写一份）', () => {
    const importSide = code('src/utils/storage.ts');
    const uploadSide = code('src/services/settingsSyncService.ts');
    const mergeSide = code('src/services/syncEngine.ts');

    for (const [label, src] of [
      ['导入备份', importSide],
      ['导出备份', importSide],
      ['上云', uploadSide],
      ['云端合并', mergeSide],
    ] as const) {
      assert.match(
        src,
        /stripNonPortableSettings\(/,
        `${label}这条路径没有走共用剔除函数 —— ` +
          '四条路径各写一份 ⇒ 迟早漂移（导出侧就漏过一次，2026-10-20 审计 A-21）'
      );
    }
  });

  it('剔除是非破坏性的：传入的 data 不被就地修改', () => {
    const input = {
      syncBackend: 'webdav',
      syncEnabled: true,
      layoutMode: 'double',
    } as never;

    const out = stripNonPortableSettings(input);

    assert.equal(
      (input as Record<string, unknown>).syncBackend,
      'webdav',
      '必须拷一份再删；就地 delete 会把调用方手里的对象改掉'
    );
    assert.equal(
      (out as Record<string, unknown>).layoutMode,
      'double',
      '非设备级字段必须原样保留'
    );
  });
});

describe('导出备份同样不得带出设备级字段（2026-10-20 审计 A-21）', () => {
  let storage: typeof import('../../src/utils/storage.ts').storage;

  before(async () => {
    register(LOADER_PATH, import.meta.url);
    ({ storage } = await import('../../src/utils/storage.ts'));
  });

  beforeEach(async () => {
    const { DEFAULT_SETTINGS } = await import('../../src/utils/storage.ts');
    await storage.setSettings({
      ...DEFAULT_SETTINGS,
      syncBackend: 'webdav',
      syncEnabled: true,
      syncIntervalMinutes: 30,
      layoutMode: 'double',
      showNotifications: true,
    });
  });

  it('导出的备份文件里不含设备级字段与已退役字段', async () => {
    /**
     * 【为什么导出侧也必须剔】
     * 导入侧会剔这三个键 ⇒ 写在备份文件里就是**文件内容在表达一个假承诺**：
     * 用户打开备份看到 `syncBackend: "supabase"`，理所当然以为
     * 「导入后同步设置也会跟着走」—— 而实际不会。
     *
     * 这与「上云」「云端合并」是同一条线：
     * **云端与备份只承载外观与操作偏好**。
     */
    // 【关键：绕过 setSettings 硬塞脏键】
    // `setSettings` 在**写路径**上就剔掉了退役键 ⇒ 若只经它写设置，
    // 本地存储里**本来就没有**退役键 ⇒ 「导出时不含退役键」这条断言
    // **永远成立** ⇒ **假绿**（实测：把剔除逻辑删掉，守卫照样绿）。
    //
    // ⇒ 直接用 kvSet 往底层存储写一份「带脏键」的设置，
    // 模拟「老版本客户端写下的数据」这个真实场景。
    const { kvSet, kvGet } = await import('@/storage-kv/storageAdapter');
    const { STORAGE_KEYS } = await import('@/storage-kv/keys');
    const { DEFAULT_SETTINGS } = await import('../../src/utils/storage.ts');

    const dirty = {
      ...DEFAULT_SETTINGS,
      syncBackend: 'webdav',
      syncEnabled: true,
      syncIntervalMinutes: 30,
      layoutMode: 'double',
      showNotifications: true,
      // 老版本客户端留下的退役键（正常路径写不进来，只能硬塞）
      groupNameTemplate: '标签组 {n}',
      allowDuplicateTabs: true,
      deleteStrategy: 'trash',
    } as unknown as Record<string, unknown>;

    await kvSet(STORAGE_KEYS.SETTINGS, dirty);

    // 防假绿：先确认脏键**真的**在底层存储里（否则下面全是空断言）
    const raw = (await kvGet<Record<string, unknown>>(STORAGE_KEYS.SETTINGS)) ?? {};
    assert.ok(
      'groupNameTemplate' in raw,
      '前提失败：退役键没能写进底层存储 —— 这条用例会变成假绿'
    );
    assert.ok(
      'syncBackend' in raw,
      '前提失败：设备级键没能写进底层存储 —— 这条用例会变成假绿'
    );

    const exported = await storage.exportData();
    const settings = exported.data.settings as Record<string, unknown>;

    for (const key of DEVICE_LEVEL_SETTING_KEYS) {
      assert.ok(
        !(key in settings),
        `导出的备份里带着设备级字段「${key}」—— ` +
          '它在导入时会被静默忽略 ⇒ 文件内容在表达一个假承诺'
      );
    }
    // 【已退役键：这一层的剔除是**防御**，不是唯一的防线】
    // `getSettings()` 在**读路径**上就剔掉了退役键（并触发自愈回写）⇒
    // 导出侧拿到的设置本来就没有它们 ⇒ 这条断言在当前实现下
    // **恒成立**（把剔除逻辑删掉，守卫照样绿 —— 实测过）。
    //
    // ⇒ 它守的是「导出侧**也**有一道防线」，防的是
    // 「将来 getSettings 不再过滤」的那一天。
    // 【为什么不删这条断言】删掉就等于**主动放弃**这道防线；
    // 而「恒成立」不等于「无意义」—— 冗余防御本来就该有守卫钉着，
    // 否则下一次重构会顺手把它删掉（而没人会注意到）。
    for (const key of RETIRED_SETTING_KEYS) {
      assert.ok(
        !(key in settings),
        `导出的备份里带着已退役字段「${key}」—— 它在本地也不生效，纯噪声`
      );
    }

    // 防假绿：外观偏好必须**真的**在文件里（证明剔除没有过头）
    assert.equal(settings.layoutMode, 'double', '外观偏好必须照常导出');
    assert.equal(settings.showNotifications, true, '同上');
  });
});
