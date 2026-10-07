// 本地存储「写入新鲜度 + 持久性」四类缺陷的回归测试。
//
// P0-1 导入与后台同步合并的竞态：导入曾在 popup 进程里 getGroups()（30s 缓存读）
//      → 拼接 → setGroupsImmediate（整表直写），既不盖印记、不进 mutationQueue，
//      也完全不与 SW 协调；后台 60s alarm 的下载合并是「读快照 → 数秒 → 整表覆盖」，
//      两者交错时刚导入的会话当场消失，pending_upload 又把空状态推上云端。
//      修法：导入交 SW 的 importGroups 语义命令（同一个 mutationQueue 串行化，
//      读真值 + 盖 stamp + 直写），无 SW 语境才走本地兜底。
//
// P1-2 三处迁移仍用缓存读 + 整表写（purgeTombstones 恰好在 1.22.0 升级当天首次运行）。
//      修法：统一 getGroupsForWrite()。
//
// P1-3 getSettings 读失败降级成 DEFAULT_SETTINGS，而 syncEngine.upload 末尾
//      uploadSettings(await storage.getSettings()) 是无条件 upsert（无 stamp/无 LWW）
//      → 一次偶发 IndexedDB 读错误把用户真实云端设置覆盖成默认值。
//      修法：getSettings fail-closed 抛错，调用方无法把降级值当真值上传。
//
// P1-4 pendingDeleteIds 读写失败全被 logError 吞掉 → 本地组已物理删除、队列没这条、
//      云端行仍活跃 → 对端下次合并整组加回来，而 UI/handler 全程回报成功。
//      修法：读写一律抛错（不再谎报成功）+ 内存兜底保住同上下文内的广播意图。
//
// 环境桩（IndexedDB / chrome.runtime / fetch）必须在 import 被测模块之前就位。
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { stubSessionJson } from './_helpers/stubSession.ts';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

const g = globalThis as Record<string, unknown>;
const NOW = '2026-09-29T08:00:00.000Z';
const LATER = '2026-09-29T09:00:00.000Z';
const USER_ID = 'user-under-test';
const SESSION_KEY = 'sb-stub-auth-token';

// ── 环境桩 1：localStorage（supabase session + 无 IndexedDB 时的 KV 回退）──
const lsData = new Map<string, string>();
const localStorageStub = {
  get length() {
    return lsData.size;
  },
  key: (i: number) => [...lsData.keys()][i] ?? null,
  getItem: (k: string) => (lsData.has(k) ? (lsData.get(k) as string) : null),
  setItem: (k: string, v: string) => {
    lsData.set(k, String(v));
  },
  removeItem: (k: string) => {
    lsData.delete(k);
  },
  clear: () => lsData.clear(),
};
g.window = { localStorage: localStorageStub };
g.localStorage = localStorageStub;
lsData.set(SESSION_KEY, stubSessionJson(USER_ID));

// ── 环境桩 2：内存版 IndexedDB（可注入读失败 / 写失败的键）────────────────
type Backing = Map<string, unknown>;
let failReadKeys = new Set<string>();
let failWriteKeys = new Set<string>();

function makeRequest(producer: () => unknown) {
  const req: Record<string, unknown> = { result: undefined, error: null };
  queueMicrotask(() => {
    try {
      req.result = producer();
      (req.onsuccess as ((e: unknown) => void) | null)?.({ target: req });
    } catch (error) {
      req.error = error ?? new Error('IndexedDB request failed');
      (req.onerror as ((e: unknown) => void) | null)?.({ target: req });
    }
  });
  return req;
}

const backing: Backing = new Map();

function makeFakeIndexedDb(store: Backing) {
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => undefined,
    close: () => undefined,
    transaction(_storeName: string, _mode: string) {
      const tx: Record<string, unknown> = { error: null };
      tx.objectStore = () => ({
        get(key: string) {
          return makeRequest(() => {
            if (failReadKeys.has(key)) throw new Error(`simulated read failure: ${key}`);
            // 真实实现存的是 { key, value }，由 indexedDbDriver.getItem 解包
            return store.get(key);
          });
        },
        put(record: { key: string; value: unknown }) {
          return makeRequest(() => {
            if (failWriteKeys.has(record.key)) throw new Error(`simulated write failure: ${record.key}`);
            store.set(record.key, record);
            return record.key;
          });
        },
        delete(key: string) {
          return makeRequest(() => {
            if (failWriteKeys.has(key)) throw new Error(`simulated write failure: ${key}`);
            store.delete(key);
            return undefined;
          });
        },
      });
      return tx;
    },
  };

  return {
    open() {
      const req: Record<string, unknown> = { result: db, error: null };
      queueMicrotask(() => {
        (req.onupgradeneeded as ((e: unknown) => void) | null)?.({ target: req });
        (req.onsuccess as ((e: unknown) => void) | null)?.({ target: req });
      });
      return req;
    },
  };
}

g.indexedDB = makeFakeIndexedDb(backing);

// ── 环境桩 3：chrome（runtime.sendMessage 可开关 = 模拟「有 SW / 无 SW」）──
// chrome.storage.local 必须是真内存实现：扩展运行时下 supabase-js 的 session
// 存放在这里（sharedStringStorage 优先 chrome.storage），空壳 get 会让
// requireSessionUserId 一律判定「未登录」。
const chromeStore = new Map<string, unknown>();
chromeStore.set(SESSION_KEY, stubSessionJson(USER_ID));

const sentMessages: any[] = [];
let messageResponder: ((msg: any) => unknown) | null = null;

function chromeLocalStorageApi() {
  return {
    get: async (keys?: string | string[] | null) => {
      if (keys == null) return Object.fromEntries(chromeStore.entries());
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (chromeStore.has(k)) out[k] = chromeStore.get(k);
      return out;
    },
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) chromeStore.set(k, v);
    },
    remove: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) chromeStore.delete(k);
    },
  };
}

/** withRuntime=false 模拟网页版：无 SW，导入必须走本地兜底。 */
function installChrome(withRuntime: boolean): void {
  sentMessages.length = 0;
  messageResponder = null;
  g.chrome = {
    storage: {
      local: chromeLocalStorageApi(),
      onChanged: { addListener: () => undefined, removeListener: () => undefined },
    },
    runtime: withRuntime
      ? {
          sendMessage: async (msg: any) => {
            sentMessages.push(msg);
            return messageResponder ? messageResponder(msg) : { ok: true };
          },
        }
      : undefined,
  };
}

// ── 环境桩 4：假云端（GoTrue 子集 + user_settings 表）────────────────────
const cloud = {
  settings: null as Record<string, unknown> | null,
  /** 记录所有打到 user_settings 的写请求（用于断言「云端设置不会被覆盖」） */
  settingsWrites: [] as Array<Record<string, unknown>>,
  requests: [] as string[],
};

function jsonRes(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

g.fetch = (async (input: any, init: RequestInit = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init.method ?? 'GET').toUpperCase();
  cloud.requests.push(`${method} ${url.pathname}`);

  if (url.pathname.endsWith('/auth/v1/user')) {
    return jsonRes({ id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'ext@test.dev' });
  }
  if (!url.pathname.endsWith('/rest/v1/user_settings')) {
    return jsonRes({ message: 'not found' }, 404);
  }
  if (method === 'GET') {
    return jsonRes(cloud.settings ? [cloud.settings] : []);
  }
  if (method === 'POST' || method === 'PATCH') {
    // 无条件 upsert（onConflict: user_id）——正是「降级值覆盖云端真实设置」的那条路
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    const row = Array.isArray(body) ? body[0] : body;
    cloud.settings = { ...(cloud.settings ?? {}), ...row };
    cloud.settingsWrites.push(row);
    return jsonRes([row], 201);
  }
  return jsonRes({ message: `假云端不认识的请求: ${method}` }, 405);
}) as typeof fetch;

// ── 测试数据 ────────────────────────────────────────────────────────────
function mkGroup(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `group-${id}`,
    tabs: [
      {
        id: `${id}-t1`,
        url: `https://${id}.example.com`,
        title: id,
        createdAt: NOW,
        lastAccessed: NOW,
        pinned: false,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    version: 1,
    ...overrides,
  };
}

/** 需要触发 favicon 迁移的组：favicon 是 javascript: 协议（清洗后会变） */
function mkDirtyFaviconGroup(id: string) {
  return mkGroup(id, {
    tabs: [
      {
        id: `${id}-t1`,
        url: `https://${id}.example.com`,
        title: id,
        favicon: 'javascript:alert(1)',
        createdAt: NOW,
        lastAccessed: NOW,
        pinned: false,
      },
    ],
  });
}

let storage: typeof import('../src/utils/storage.ts').storage;
let kvGet: typeof import('../src/storage-kv/storageAdapter.ts').kvGet;
let kvSet: typeof import('../src/storage-kv/storageAdapter.ts').kvSet;
let cacheManager: typeof import('@/utils/performance').cacheManager;

function rawGroups(): any[] {
  return (backing.get('tab_groups') as { value?: any[] })?.value ?? [];
}

function putRawGroups(groups: any[]) {
  backing.set('tab_groups', { key: 'tab_groups', value: groups });
}

before(async () => {
  register(LOADER_PATH, import.meta.url);
  ({ storage } = await import('../src/utils/storage.ts'));
  ({ kvGet, kvSet } = await import('../src/storage-kv/storageAdapter.ts'));
  ({ cacheManager } = await import('@/utils/performance'));
});

beforeEach(() => {
  failReadKeys = new Set();
  failWriteKeys = new Set();
  cloud.settings = null;
  cloud.settingsWrites.length = 0;
  cloud.requests.length = 0;
  installChrome(true);
  // 跨用例清干净两个缓存键（groups 30s / settings 60s，测试里不等待真实时间）
  cacheManager.getCache('storage').clear();
});

// ════════════════════════════════════════════════════════════════════════
// P0-1 导入：交 SW 单写者串行化 + 真值读 + 盖印记
// ════════════════════════════════════════════════════════════════════════
describe('P0-1 导入与后台同步合并的竞态', () => {
  it('扩展运行时：导入以 importGroups 语义命令交给 SW 串行执行，popup 不再整表直写', async () => {
    installChrome(true);
    putRawGroups([mkGroup('existing')]);
    messageResponder = () => ({ ok: true, payload: [] });

    const ok = await storage.importData({
      version: '1.0.0',
      timestamp: NOW,
      data: { groups: [mkGroup('imported', { createdAt: LATER })], settings: undefined as any },
    });

    assert.equal(ok, true);
    const mutate = sentMessages.filter(m => m?.type === 'MUTATE');
    assert.equal(mutate.length, 1, '导入必须走 MUTATE 消息（SW mutationQueue 与 sync:download 串行）');
    assert.equal(mutate[0].data.op, 'importGroups');
    assert.deepEqual(
      mutate[0].data.groups.map((x: any) => x.id),
      ['imported']
    );
    assert.deepEqual(
      rawGroups().map(x => x.id),
      ['existing'],
      'popup 侧不得再自己整表直写（那条路与后台下载合并无协调）'
    );
  });

  it('SW 拒绝导入时如实报告失败，不退回本地直写（否则竞态原样回来）', async () => {
    installChrome(true);
    putRawGroups([mkGroup('existing')]);
    messageResponder = () => ({ ok: false, error: 'SW 队列拒绝' });

    const ok = await storage.importData({
      version: '1.0.0',
      timestamp: NOW,
      data: { groups: [mkGroup('imported')], settings: undefined as any },
    });

    assert.equal(ok, false, '导入失败必须报告失败，不能假装成功');
    assert.deepEqual(rawGroups().map(x => x.id), ['existing'], '失败路径同样不得直写');
  });

  it('无 SW 兜底路径：导入读真值而不是 30s 缓存（缓存读会抹掉期间写入的会话）', async () => {
    installChrome(false);
    putRawGroups([mkGroup('before-cache')]);
    await storage.getGroups(); // 预热本进程 30s 缓存

    // 期间另一个上下文（SW / 后台）写入了新会话
    putRawGroups([mkGroup('before-cache'), mkGroup('written-during')]);

    const ok = await storage.importData({
      version: '1.0.0',
      timestamp: NOW,
      data: { groups: [mkGroup('imported', { createdAt: LATER })], settings: undefined as any },
    });

    assert.equal(ok, true);
    const ids = rawGroups().map(x => x.id);
    assert.ok(ids.includes('written-during'), '导入读到的必须是真值，期间写入的会话不能被抹掉');
    assert.equal(
      rawGroups().filter(x => x.id === 'before-cache').length,
      1,
      '导入不得把同一批会话写重'
    );
  });

  it('无 SW 兜底路径：导入的组盖上 lastOp 印记（上传 last_op_seq 不再是 null）', async () => {
    installChrome(false);
    putRawGroups([mkGroup('existing', { lastOp: { d: 'dev-old', s: 41 } })]);

    await storage.importData({
      version: '1.0.0',
      timestamp: NOW,
      data: { groups: [mkGroup('imported')], settings: undefined as any },
    });

    const imported = rawGroups().find(g2 => g2.name === 'group-imported');
    assert.ok(imported, '导入的组必须落盘');
    assert.ok(imported.lastOp, '导入的组必须有 lastOp（修复前原样写入、印记为空）');
    assert.equal(typeof imported.lastOp.d, 'string');
    assert.ok(
      imported.lastOp.s > 41,
      `导入印记必须大于已观察到的最大 seq（Lamport），实际 ${imported.lastOp.s}`
    );
  });

  it('OneTab 导入同样走真值读 + 盖印记', async () => {
    installChrome(false);
    putRawGroups([mkGroup('before-cache')]);
    await storage.getGroups(); // 预热缓存
    putRawGroups([mkGroup('before-cache'), mkGroup('written-during')]);

    const text = [
      '*** OneTab ***',
      'https://onetab.example.com',
      '2026-09-29 08:00:00',
      '```',
      'https://a.example.com',
      'https://b.example.com',
      '```',
    ].join('\n');

    const ok = await storage.importFromOneTabFormat(text);
    assert.equal(ok.ok, true, `导入应成功，实际 ${JSON.stringify(ok)}`);
    const ids = rawGroups().map(x => x.id);
    assert.ok(ids.includes('written-during'), 'OneTab 导入同样不得用陈旧缓存');
    const imported = rawGroups().find(x => x.tabs.some((t: any) => t.url === 'https://a.example.com'));
    assert.ok(imported?.lastOp, 'OneTab 导入的组必须带印记');
  });

  // ── 1.22.14 导入诚实化 ────────────────────────────────────────────────

  it('导入等待超时不谎报失败：命令已受理，返回成功且不再发第二次 importGroups（重试会导入出整份副本）', async () => {
    installChrome(true);
    putRawGroups([mkGroup('existing')]);
    // 模拟 popup 30s 协议超时：sendMessage 抛「操作超时…」
    messageResponder = () => {
      throw new Error('操作超时（超过 30 秒无响应）：importGroups');
    };

    const ok = await storage.importData({
      version: '1.0.0',
      timestamp: NOW,
      data: { groups: [mkGroup('imported')], settings: undefined as any },
    });

    assert.equal(ok, true, '超时 ≠ 未受理：命令已进 SW 队列，报失败会诱导用户重试出重复副本');
    const mutateCount = sentMessages.filter(m => m?.type === 'MUTATE' && m.data?.op === 'importGroups').length;
    assert.equal(mutateCount, 1, '只应发出一次导入命令');
  });

  it('导入 SW 明确拒绝（非超时错误）仍如实报失败', async () => {
    installChrome(true);
    putRawGroups([mkGroup('existing')]);
    messageResponder = () => {
      throw new Error('SW 通道已关闭');
    };

    const ok = await storage.importData({
      version: '1.0.0',
      timestamp: NOW,
      data: { groups: [mkGroup('imported')], settings: undefined as any },
    });

    assert.equal(ok, false);
  });

  it('OneTab 文件全是内部地址（chrome:// 等）时如实失败并说明原因，而不是假成功后列表空空', async () => {
    installChrome(false);
    backing.delete('tab_groups');
    const text = 'chrome://version | Version\ncustom-tab://inapp-1 | 内部页\ncustom-tab://inapp-2 | 内部页2';

    const result = await storage.importFromOneTabFormat(text);

    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /chrome:\/\/|可存储的 URL/, '失败原因必须解释 URL 清洗规则');
    assert.equal(rawGroups().length, 0, '不得落盘任何空壳组');
  });

  it('OneTab 文件混有有效与无效 URL 时，有效部分照常导入', async () => {
    installChrome(false);
    const text = 'https://keep.example.com | 保留\ncustom-tab://inapp-1 | 丢弃';

    const result = await storage.importFromOneTabFormat(text);

    assert.equal(result.ok, true);
    const imported = rawGroups().find(x => x.tabs.some((t: any) => t.url === 'https://keep.example.com'));
    assert.ok(imported, '有效 URL 的行必须正常导入');
  });
});

// ════════════════════════════════════════════════════════════════════════
// P1-2 三处迁移：缓存读 + 整表写
// ════════════════════════════════════════════════════════════════════════
describe('P1-2 迁移必须读真值', () => {
  it('migrateFaviconUrls：外部写入的会话不会被陈旧快照整段抹掉', async () => {
    const { migrateFaviconUrls } = await import('@/utils/migrationUtils');
    putRawGroups([mkDirtyFaviconGroup('a')]);
    await storage.getGroups(); // 预热 30s 缓存
    putRawGroups([mkDirtyFaviconGroup('a'), mkGroup('written-during')]);

    await migrateFaviconUrls();

    const ids = rawGroups().map(x => x.id);
    assert.ok(ids.includes('written-during'), '迁移必须读写路径真值（getGroupsForWrite）');
  });

  it('purgeTombstones：清理墓碑时同样基于真值（1.22.0 升级当天首次运行，最危险）', async () => {
    const { purgeTombstones } = await import('@/utils/migrationUtils');
    putRawGroups([mkGroup('a', { isDeleted: true }), mkGroup('alive')]);
    await storage.getGroups(); // 预热缓存
    putRawGroups([
      mkGroup('a', { isDeleted: true }),
      mkGroup('alive'),
      mkGroup('written-during'),
    ]);

    await purgeTombstones();

    const ids = rawGroups().map(x => x.id).sort();
    assert.deepEqual(ids, ['alive', 'written-during'], '墓碑组被清除，期间写入的组必须活下来');
  });

  it('migrateToV2：v2 字段迁移基于真值', async () => {
    const { migrateToV2 } = await import('@/utils/migrationHelper');
    putRawGroups([mkGroup('a', { version: undefined, displayOrder: undefined })]);
    await storage.getGroups(); // 预热缓存
    putRawGroups([
      mkGroup('a', { version: undefined, displayOrder: undefined }),
      mkGroup('written-during', { version: undefined, displayOrder: undefined }),
    ]);

    await migrateToV2();

    const ids = rawGroups().map(x => x.id).sort();
    assert.deepEqual(ids, ['a', 'written-during']);
  });
});

// ════════════════════════════════════════════════════════════════════════
// P1-3 getSettings 读失败不得降级成「看起来合法的默认值」
// ════════════════════════════════════════════════════════════════════════
describe('P1-3 设置读失败 fail-closed：降级值会被无条件覆盖到云端', () => {
  it('getSettings 读失败抛错，不返回 DEFAULT_SETTINGS', async () => {
    await kvSet('user_settings', { groupNameTemplate: '会话 %d', themeStyle: 'prism' });

    // 先成功读一次，让缓存里有真实设置（证明后面失败的是读，不是"本来就没设置"）
    const ok = await storage.getSettings();
    assert.equal(ok.groupNameTemplate, '会话 %d');

    // 失效 settings 缓存（60s TTL），再制造读失败
    cacheManager.getCache('storage').delete('settings');
    failReadKeys = new Set(['user_settings']);
    let outcome: string;
    try {
      outcome = await storage.getSettings().then(
        s => `resolved:${JSON.stringify(s)}`,
        () => 'rejected'
      );
    } finally {
      failReadKeys = new Set();
    }

    assert.equal(outcome, 'rejected', '读失败必须抛错（修复前返回 DEFAULT_SETTINGS 并冒充真值）');
  });

  it('读失败时上传路径不会把默认值写进云端', async () => {
    const { uploadSettings } = await import('@/services/settingsSyncService');
    await kvSet('user_settings', { groupNameTemplate: '真实模板 %d', themeStyle: 'prism' });

    // 对照组先证明「假云端 + 真实 uploadSettings 这条路确实能写进去」
    await uploadSettings(await storage.getSettings());
    assert.equal(cloud.settingsWrites.length, 1, '对照组：读成功时上传照常发生');
    assert.equal(cloud.settings?.group_name_template, '真实模板 %d');
    assert.equal(cloud.settings?.theme_style, 'prism');

    // 现在制造一次读失败，走 syncEngine.upload 尾部的同一道闸门（原样三行）
    cacheManager.getCache('storage').delete('settings');
    cloud.settingsWrites.length = 0;
    failReadKeys = new Set(['user_settings']);
    let blocked = false;
    try {
      try {
        await uploadSettings(await storage.getSettings());
      } catch (err) {
        blocked = true;
      }
    } finally {
      failReadKeys = new Set();
    }

    assert.equal(blocked, true, '降级读必须被上传闸门拦下');
    assert.deepEqual(
      cloud.settingsWrites,
      [],
      '读失败时不得发出任何 user_settings 写请求（一次读错误就能把云端真实设置覆盖成默认值）'
    );
    assert.equal(cloud.settings?.group_name_template, '真实模板 %d', '云端设置保持原样');
    assert.equal(cloud.settings?.theme_style, 'prism', '云端设置保持原样');
  });
});

// ════════════════════════════════════════════════════════════════════════
// P1-4 删除意图的持久化不得静默失败
// ════════════════════════════════════════════════════════════════════════
describe('P1-4 删除广播队列：写失败不得被静默吞掉', () => {
  it('addPendingDeleteId 写失败抛错（不再谎报登记成功），且 id 仍在广播队列里', async () => {
    await storage.clearPendingDeleteIds();

    failWriteKeys = new Set(['pending_delete_ids']);
    let rejected = false;
    try {
      await storage.addPendingDeleteId('group-x');
    } catch {
      rejected = true;
    } finally {
      failWriteKeys = new Set();
    }
    assert.equal(rejected, true, '登记删除意图失败必须抛错（本地组已删，队列没这条 = 删除被撤销）');

    // 补偿：同进程内 upload 仍能取到这条意图并广播到云端
    const queued = await storage.getPendingDeleteIds();
    assert.deepEqual(queued, ['group-x'], '内存兜底必须让上传广播仍能拿到这条删除意图');

    // 云端标记成功 → 清队列（兜底同步清掉，不留幽灵）
    await storage.clearPendingDeleteIds();
    assert.deepEqual(await storage.getPendingDeleteIds(), [], '广播成功后兜底一并清空');
  });

  it('clearPendingDeleteIds 写失败抛错且队列内容保留（不得"清不掉也当清掉了"）', async () => {
    await kvSet('pending_delete_ids', ['g-1', 'g-2']);

    failWriteKeys = new Set(['pending_delete_ids']);
    let rejected = false;
    try {
      await storage.clearPendingDeleteIds();
    } catch {
      rejected = true;
    } finally {
      failWriteKeys = new Set();
    }

    assert.equal(rejected, true);
    const kept = await kvGet<string[]>('pending_delete_ids');
    assert.deepEqual(kept, ['g-1', 'g-2'], '清队列失败必须保留内容供下轮重试');
  });

  it('setPendingUpload 写失败抛错（置位失败 = 本地变更永远不推上云）', async () => {
    failWriteKeys = new Set(['pending_upload']);
    let rejected = false;
    try {
      await storage.setPendingUpload(true);
    } catch {
      rejected = true;
    } finally {
      failWriteKeys = new Set();
    }
    assert.equal(rejected, true, '置位 pending_upload 失败必须抛错');
  });

  it('getPendingDeleteIds 读失败抛错：返回 [] 会让 upload 把队列当空消费掉', async () => {
    await kvSet('pending_delete_ids', ['g-1']);

    failReadKeys = new Set(['pending_delete_ids']);
    let outcome: string;
    try {
      outcome = await storage.getPendingDeleteIds().then(
        ids => `resolved:${JSON.stringify(ids)}`,
        () => 'rejected'
      );
    } finally {
      failReadKeys = new Set();
    }

    assert.equal(outcome, 'rejected', '读失败不得返回 []（upload 会据此清空队列，删除意图永久丢失）');
    assert.deepEqual(await kvGet<string[]>('pending_delete_ids'), ['g-1'], '队列内容保持原样');
  });

  it('getPendingPurgeIds 读失败抛错：purgeTombstones 因此不会删掉没读到的旧队列', async () => {
    const { purgeTombstones } = await import('@/utils/migrationUtils');
    await kvSet('pending_purge_ids', ['legacy-1']);

    failReadKeys = new Set(['pending_purge_ids']);
    let outcome: string;
    try {
      outcome = await storage
        .getPendingPurgeIds()
        .then(ids => `resolved:${JSON.stringify(ids)}`, () => 'rejected');
    } finally {
      failReadKeys = new Set();
    }
    assert.equal(outcome, 'rejected', '旧 purge 队列读失败不得返回 []');

    // 端到端：迁移读失败必须整条失败，且不得删掉旧队列键
    failReadKeys = new Set(['pending_purge_ids']);
    let rejected = false;
    try {
      await purgeTombstones();
    } catch {
      rejected = true;
    } finally {
      failReadKeys = new Set();
    }
    assert.equal(rejected, true, '迁移读失败必须失败（不得把没读到的队列当空队列删掉）');
    assert.deepEqual(await kvGet<string[]>('pending_purge_ids'), ['legacy-1'], '旧队列键未被销毁');
  });
});
