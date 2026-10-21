// SW 侧的设置读必须取真值（2026-10-18 round 7）。
//
// 【本文件要防的回归类别】settings 读路径带 60s **进程内**缓存，而写方在另一个
// 执行上下文（设置页 / popup）。SW 是长活上下文，它手里的 settings 可能是
// 「用户改设置之前」的快照 —— 与 @/sync-backend 的 readConfiguredBackendId
// 注释里 2026-10-14 那条同一个根因（那里已改为绕过缓存直读存储真值）。
//
// SW 里有两处读点吃这份陈旧值，且都会造成**静默数据损坏**：
//   ① syncEngine.upload 末尾 `uploadSettings(await storage.getSettings())`
//      —— uploadSettings 是无 stamp / 无 version / 无 LWW 的无条件 upsert，
//      陈旧值直接整行覆盖云端设置（实测：设置页切成「自带存储（WebDAV）」后点
//      「检查并推送到云端」，云端 settings.json 里 syncBackend 仍是 supabase）；
//   ② mergeCloudSettingsIntoLocal 以 `store.getState().settings` 为合并基准
//      —— SW 冷启动时 Redux 是代码默认值，云端没有的字段会被整份写成默认值。
//
// 覆盖面：
//   (a) 运行时：getSettingsForWrite 真的越过陈旧缓存（真跑代码）；
//   (b) 运行时：防抖窗口内的待落盘写必须在「失效缓存」之前落盘，否则失效后
//       读回来的是磁盘旧值 —— 顺序即语义；
//   (c) 结构：syncEngine 两处读点都改走真值读，且 merge 基准不再取自 Redux。

import { describe, it, before, beforeEach } from 'node:test';
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

// ── 无 indexedDB 环境下的存储桩（与 overwriteDownloadSettingsRefresh 同一套）──
const lsData = new Map<string, string>();
const localStorageStub = {
  get length() { return lsData.size; },
  key: (i: number) => [...lsData.keys()][i] ?? null,
  getItem: (k: string) => (lsData.has(k) ? (lsData.get(k) as string) : null),
  setItem: (k: string, v: string) => { lsData.set(k, String(v)); },
  removeItem: (k: string) => { lsData.delete(k); },
  clear: () => lsData.clear(),
};
(globalThis as Record<string, unknown>).window = { localStorage: localStorageStub };
(globalThis as Record<string, unknown>).localStorage = localStorageStub;
(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => undefined, remove: async () => undefined },
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
};

describe('SW 的设置读：越过陈旧缓存', () => {
  let storage: typeof import('../../src/utils/storage.ts').storage;
  let invalidateSettingsCache: typeof import('../../src/utils/storage.ts').invalidateSettingsCache;

  before(async () => {
    register(LOADER_PATH, import.meta.url);
    ({ storage, invalidateSettingsCache } = await import('../../src/utils/storage.ts'));
  });

  beforeEach(() => {
    lsData.clear();
  });

  it('另一个上下文改过设置后，普通读取仍返回旧值，真值读返回新值', async () => {
    const base = {
      ...(await storage.getSettingsForLocalUse()),
      themeStyle: 'legacy' as const,
      layoutMode: 'single' as const,
      syncIntervalMinutes: 5,
    };
    await storage.setSettings(base as never);
    // 前置：本上下文缓存被填上旧值（SW 早先读过一次设置，60s TTL 未过期）
    await storage.getSettings();

    // 模拟设置页写入：直接落盘，不碰 SW 的缓存
    localStorageStub.setItem(
      'user_settings',
      JSON.stringify({ ...base, themeStyle: 'claude', syncIntervalMinutes: 30 }),
    );

    assert.equal(
      (await storage.getSettings()).themeStyle,
      'legacy',
      '前置：缓存未过期时普通读取本就返回旧值 —— 这正是缺陷窗口的形状',
    );

    const fresh = await storage.getSettingsForWrite();
    assert.equal(fresh.themeStyle, 'claude', '真值读必须越过 60s 缓存');
    assert.equal(fresh.syncIntervalMinutes, 30, '数值型字段同样要取真值，否则会把旧的同步档位推上云端');
  });

  it('防抖窗口内的待落盘写必须先落盘，否则失效缓存后读到的是磁盘旧值', async () => {
    const base = { ...(await storage.getSettingsForLocalUse()), themeStyle: 'legacy' as const };
    await storage.setSettings(base as never);

    // 本进程刚写设置、防抖（500ms）尚未落盘
    const pending = storage.setSettings({ ...base, themeStyle: 'claude' } as never);

    // 前置：只失效缓存、不落盘，读回来的是**磁盘**旧值 ——
    // 这正是「缺 flush 的真值读」会推上云端的那份值
    invalidateSettingsCache();
    assert.equal(
      (await storage.getSettings()).themeStyle,
      'legacy',
      '前置：pending 写没落盘时，失效缓存后读到的是磁盘旧值',
    );

    const fresh = await storage.getSettingsForWrite();
    await pending;
    assert.equal(
      fresh.themeStyle,
      'claude',
      '真值读必须先落盘 pending 写：否则读回旧值，被无条件 upsert 推上云端',
    );
  });
});

describe('syncEngine 两处设置读都走真值', () => {
  it('上云路径不再读 60s 缓存', () => {
    const src = code('src/services/syncEngine.ts');
    const branchStart = src.indexOf('if (opts?.syncSettings) {');
    assert.ok(branchStart !== -1, '找不到上传设置分支');
    const branch = src.slice(branchStart, branchStart + 400);
    assert.match(
      branch,
      /uploadSettings\(await storage\.getSettingsForWrite\(\)\)/,
      '上传的设置必须取真值：uploadSettings 是无条件 upsert，陈旧值直接覆盖云端',
    );
    assert.doesNotMatch(
      src,
      /storage\.getSettings\(\)/,
      'syncEngine 里不得再出现吃 60s 缓存的设置读（写方在别的执行上下文）',
    );
  });

  it('覆盖下载的合并基准取存储真值，不是 SW 里可能是默认值的 Redux', () => {
    const src = code('src/services/syncEngine.ts');
    const start = src.indexOf('async function mergeCloudSettingsIntoLocal(');
    assert.ok(start !== -1, '找不到 mergeCloudSettingsIntoLocal');
    const body = src.slice(start, src.indexOf('\n}', start));

    const readAt = body.indexOf('await storage.getSettingsForWrite()');
    assert.ok(readAt !== -1, '合并基准必须读存储真值');

    // 2026-10-20 审计 A-21：这条断言原来靠 `body.indexOf('...cloudSettings')`
    // 定位「云端值进入本地设置」的位置 —— 而那个子串**只**在
    // `const cloudPreferences = { ...cloudSettings }` 这种写法里存在。
    // A-21 把这段换成共用函数 `stripNonPortableSettings(cloudSettings)`
    // ⇒ 子串消失 ⇒ `indexOf` 返回 -1 ⇒ 断言「readAt < -1」为假 ⇒ **假红**。
    //
    // 【为什么这是「守卫钉写法」的典型】断言表达的意图是对的
    // （基准读取必须发生在云端值进来之前），但它**碰巧**依赖了一个子串。
    // ⇒ 改成用**语义锚点**定位「云端值进入本地设置」这一步：
    //   · 展开进 convertedSettings 的那个对象（`...cloudPreferences`），
    //   · 或「把云端值变成可合并对象」的那次调用。
    // 两者的位置都必须在基准读取**之后**。
    const cloudEnterAt = Math.min(
      ...[body.indexOf('...cloudPreferences'), body.indexOf('stripNonPortableSettings(')].filter(
        i => i !== -1
      )
    );
    assert.ok(
      cloudEnterAt !== Infinity,
      '找不到「云端值进入本地设置」这一步（展开或剔除调用）',
    );
    assert.ok(
      readAt < cloudEnterAt,
      '基准读取必须发生在云端值进入本地设置之前 —— 顺序即语义',
    );
    assert.match(
      body,
      /catch[\s\S]*?store\.getState\(\)/,
      '读失败才回退 Redux 现值（宁可少合一项，不可把代码默认值写进存储）',
    );
  });

  it('getSettingsForWrite 三步齐全：落盘、失效、再读', () => {
    const src = code('src/utils/storage.ts');
    const start = src.indexOf('async getSettingsForWrite(');
    assert.ok(start !== -1, '找不到 getSettingsForWrite');
    const body = src.slice(start, src.indexOf('\n  }', start));

    const flushAt = body.indexOf('debouncedPersistSettings.flush()');
    const invalidateAt = body.indexOf('invalidateSettingsCache()');
    const readAt = body.indexOf('return this.getSettings()');
    assert.ok(flushAt !== -1, '必须落盘 pending 的防抖写（否则失效后读到磁盘旧值）');
    assert.ok(invalidateAt !== -1, '必须失效 60s 缓存（否则读回本进程的旧快照）');
    assert.ok(readAt !== -1, '最后才读');
    assert.ok(flushAt < readAt && invalidateAt < readAt, '落盘与失效都必须排在这条读之前');
  });
});
