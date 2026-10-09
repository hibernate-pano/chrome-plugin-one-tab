// S2 存储 KV 收敛锁定测试（行为零变化证明）。
//
// 覆盖：
// - 键常量单源：STORAGE_KEYS 全量字面值锁定 + STORAGE_VERSION + MIGRATION_KEYS 同源引用
// - driver 单源唯一性：drivers 只剩 @/storage-kv/* 一处实现，adapter 直连其单例
// - 门面 re-export 同一性：@/utils/storage 的 STORAGE_KEYS 与共享单源同一引用
// - sharedStringStorage 三环境语义（扩展 chrome.storage / 网页 localStorage / 双无降级）
// - 双路径语义保留：防抖 setGroups（last-write-wins 合并）vs 直写 setGroupsImmediate
// - supabase 模块在改线后仍可正常初始化（client 占位创建不抛错）
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

/** 仓库根与 src 根（源码断言用，路径相对本文件位置）。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ROOT = resolve(ROOT, 'src');

/**
 * STORAGE_KEYS 的 名字→值 映射（从源码**解析**得到，不手抄）。
 *
 * 为什么要它：调用方常常写 `secureStorage.set(STORAGE_KEYS.MIGRATION_FLAGS, …)`
 * 而不是字面量 —— 只按字面量找调用方会把真实调用误判成「零写入方」。
 * 而手抄这张表又会引入新的漂移面（这正是本次修掉的那个问题本身）。
 * 解析出来 = 与被测对象同源，不存在第二份真相。
 */
const STORAGE_KEY_LITERALS: { name: string; value: string }[] = (() => {
  const keysSrc = readFileSync(resolve(SRC_ROOT, 'storage-kv/keys.ts'), 'utf8');
  const body = keysSrc.match(/export const STORAGE_KEYS[^=]*=\s*\{([\s\S]*?)\n\} as const;/);
  if (!body) return [];
  return (body[1].match(/(\w+):\s*'([^']+)'/g) || []).map(pair => {
    const m = pair.match(/(\w+):\s*'([^']+)'/);
    return { name: m![1], value: m![2] };
  });
})();

// ── 最小浏览器存储环境 ──────────────────────────────────────────────
// storageAdapter 在无 indexedDB 时回退 window.localStorage，用 Map 模拟。
// chrome.storage.local 另用 Map 模拟，支撑 sharedStringStorage 扩展路径。
const lsData = new Map<string, string>();
const chromeData = new Map<string, unknown>();

function makeLocalStorageLike(backing: Map<string, string>) {
  return {
    get length() {
      return backing.size;
    },
    key: (i: number) => Array.from(backing.keys())[i] ?? null,
    getItem: (k: string) => (backing.has(k) ? (backing.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      backing.set(k, String(v));
    },
    removeItem: (k: string) => {
      backing.delete(k);
    },
    clear: () => backing.clear(),
  };
}

const webLsBacking = new Map<string, string>();

(globalThis as Record<string, unknown>).window = {
  localStorage: makeLocalStorageLike(lsData),
};
(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: async (keys?: string | string[] | Record<string, unknown>) => {
        if (typeof keys === 'string') return { [keys]: chromeData.get(keys) };
        if (Array.isArray(keys)) {
          return Object.fromEntries(keys.map(k => [k, chromeData.get(k)]));
        }
        return Object.fromEntries(chromeData.entries());
      },
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) chromeData.set(k, v);
      },
      remove: async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) chromeData.delete(k);
      },
    },
  },
  runtime: { getManifest: () => ({ version: 'test' }) },
};
// 网页回退路径用裸 localStorage（supabase session 层语义）
(globalThis as Record<string, unknown>).localStorage = makeLocalStorageLike(webLsBacking);

before(async () => {
  register(LOADER_PATH);
});

const NOW = '2026-09-23T08:00:00.000Z';

function makeGroup(id: string) {
  return {
    id,
    name: `group-${id}`,
    tabs: [],
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    version: 1,
  };
}

describe('S2 键常量单源', () => {
  /**
   * 搬迁时既有的键：字面值是**用户数据的物理位置**，改一个就等于让存量数据
   * 变成孤儿（旧键没人再读、新键永远读不到值）。这份清单是逐字快照，不许动。
   */
  const LEGACY_PINNED_KEYS: Record<string, string> = {
    VERSION: 'storage_version',
    GROUPS: 'tab_groups',
    SETTINGS: 'user_settings',
    DELETED_GROUPS: 'deleted_tab_groups',
    DELETED_TABS: 'deleted_tabs',
    LAST_SYNC_TIME: 'last_sync_time',
    SYNC_SNAPSHOT: 'sync_snapshot',
    PRODUCT_EVENTS: 'product_events',
    MIGRATION_FLAGS: 'migration_flags',
    PENDING_UPLOAD: 'pending_upload',
    LAST_UPLOAD_TIME: 'last_upload_time',
    PENDING_PURGE_IDS: 'pending_purge_ids',
    PENDING_DELETE_IDS: 'pending_delete_ids',
    DEVICE_SEQ: 'device_seq',
    JOURNAL: 'journal',
    LAST_SYNCED_SEQ: 'last_synced_seq',
    OP_STAMP_MIGRATED: 'op_stamp_migrated',
  };

  /**
   * 搬迁之后**新增**的键（新增不改存量数据位置，与改名是两回事）。
   *
   * 为什么单独一张表而不是把新键塞进上面那份快照：上面那份的断言含义是
   * 「与搬迁前逐字一致」，混进新键会让这句话变成假的，而且看不出哪个是历史键、
   * 哪个是后来加的。分开之后，改历史键 → 上面那条断言红；加新键 → 必须在这里
   * 显式登记一行，代码评审看得见。
   *
   * - PERF_SPANS：性能 span 环形缓冲（v1.22.9 起，诊断观测用，不含用户会话数据）。
   */
  const ADDED_KEYS: Record<string, string> = {
    PERF_SPANS: 'perf_spans',
  };

  it('STORAGE_KEYS 字面值与搬迁前逐字一致', async () => {
    const { STORAGE_KEYS, STORAGE_VERSION } = await import('@/storage-kv/keys');
    const actual = { ...STORAGE_KEYS };
    // 历史键必须逐字在位且值不变（改名/删键/改值都在这里红）。
    const actualByKey: Record<string, string> = actual;
    for (const [key, value] of Object.entries(LEGACY_PINNED_KEYS)) {
      assert.equal(actualByKey[key], value, `历史键 ${key} 的字面值变了（存量数据会变孤儿）`);
    }
    // 全集 = 历史键 ∪ 显式登记的新增键。多出未登记的键同样红：
    // 新增键必须在上面的 ADDED_KEYS 里写一行，避免键表悄悄长胖。
    assert.deepEqual(actual, { ...LEGACY_PINNED_KEYS, ...ADDED_KEYS });
    assert.equal(STORAGE_VERSION, 5);
  });

  it('MIGRATION_KEYS 与 STORAGE_KEYS/LEGACY_KEYS 同源（值相等且引用同一单源）', async () => {
    const { STORAGE_KEYS, MIGRATION_KEYS, MIGRATION_SCAN_KEYS, LEGACY_KEYS } =
      await import('@/storage-kv/keys');

    // 2026-10-07 P1-7：MIGRATION_KEYS 原本是一张**手抄的 9 项子集**，
    // STORAGE_KEYS 当时已有 16 项 —— 漏掉的 pending_delete_ids / device_seq /
    // last_upload_time 等键会让 v1.21.x 直升的老用户静默丢掉删除广播队列与
    // Lamport 时钟。因此扫描键改为**由 STORAGE_KEYS 全量派生**，
    // 本断言随之从「逐字相等」升级为「覆盖 STORAGE_KEYS 全集」。

    // 迁移扫描必须覆盖每一个会落盘的 STORAGE_KEYS —— 这才是「不分叉」的可执行定义。
    const storageKeyValues = Object.values(STORAGE_KEYS);
    for (const key of storageKeyValues) {
      assert.ok(
        MIGRATION_SCAN_KEYS.includes(key),
        `STORAGE_KEYS 的 ${key} 不在 MIGRATION_SCAN_KEYS 里 —— ` +
          '该键在 chrome.storage → KV 迁移中会被漏掉。新增业务键后请确认派生表已跟上。'
      );
    }

    // 且必须包含全部历史键名（只存在于 chrome.storage 的旧键）。
    for (const key of Object.values(LEGACY_KEYS)) {
      assert.ok(
        MIGRATION_SCAN_KEYS.includes(key),
        `LEGACY_KEYS 的 ${key} 不在 MIGRATION_SCAN_KEYS 里 —— 存量数据会变孤儿`
      );
    }

    // 反向：扫描表不得凭空引入不存在的键（防止把无关键也搬一遍）。
    const allKnown = new Set<string>([...storageKeyValues, ...Object.values(LEGACY_KEYS)]);
    const invented = MIGRATION_SCAN_KEYS.filter(k => !allKnown.has(k));
    assert.deepEqual(
      invented,
      [],
      `MIGRATION_SCAN_KEYS 混入了未登记的键：${invented.join(', ')}。` +
        '新增键必须先进 STORAGE_KEYS 或 LEGACY_KEYS。'
    );

    // 别名表本身仍须同源引用（非各自手写字符串）。
    assert.equal(MIGRATION_KEYS.tabGroups, STORAGE_KEYS.GROUPS);
    assert.equal(MIGRATION_KEYS.migrationFlags, STORAGE_KEYS.MIGRATION_FLAGS);
    assert.equal(MIGRATION_KEYS.deviceId, LEGACY_KEYS.DEVICE_ID);
    assert.equal(MIGRATION_KEYS.legacyDeviceId, LEGACY_KEYS.LEGACY_DEVICE_ID);
    assert.equal(MIGRATION_KEYS.legacyTabGroups, LEGACY_KEYS.LEGACY_TAB_GROUPS);
    assert.equal(MIGRATION_KEYS.tabGroupPrefix, LEGACY_KEYS.TAB_GROUP_PREFIX);
  });

  it('@/utils/storage 门面 re-export 的 STORAGE_KEYS 与单源同一引用', async () => {
    const facade = await import('@/utils/storage');
    const shared = await import('@/storage-kv/keys');
    assert.equal(facade.STORAGE_KEYS, shared.STORAGE_KEYS);
    assert.equal(facade.STORAGE_VERSION, shared.STORAGE_VERSION);
  });
});

describe('S2 原位置转发同一性（调用方 import 不动）', () => {
  it('storageAdapter 旧路径与新路径导出同一函数', async () => {
    const oldMod = await import('@/storage/storageAdapter');
    const newMod = await import('@/storage-kv/storageAdapter');
    for (const name of ['kvGet', 'kvSet', 'kvRemove', 'initStorage', 'getActiveBackend'] as const) {
      assert.equal(oldMod[name], newMod[name], `${name} 应为同一引用`);
    }
  });

  it('drivers 已收敛为单源：storageAdapter 直连 storage-kv 的 driver 单例', async () => {
    const idb = await import('@/storage-kv/indexedDbClient');
    const ls = await import('@/storage-kv/localStorageFallback');
    // 旧路径（@/storage/indexedDbClient、@/storage/localStorageFallback）已物理删除，
    // drivers 只剩 storage-kv 一处实现。因此这里锁的是「单例唯一」而不是「双路径同引用」：
    // 同一模块重复 import 必须给出同一 driver 对象，防止有人再复制一份实现。
    const idbAgain = await import('@/storage-kv/indexedDbClient');
    const lsAgain = await import('@/storage-kv/localStorageFallback');
    assert.equal(idb.indexedDbDriver, idbAgain.indexedDbDriver, 'indexedDbDriver 必须是单例');
    assert.equal(ls.localStorageDriver, lsAgain.localStorageDriver, 'localStorageDriver 必须是单例');
    // 且 adapter 选中的后端必须与实际可用的 driver 一致（本环境无 indexedDB → 落 localStorage）
    const { getActiveBackend, initStorage } = await import('@/storage-kv/storageAdapter');
    assert.equal(idb.isIndexedDbAvailable(), false, 'node 测试环境没有 indexedDB');
    assert.equal(ls.isLocalStorageAvailable(), true, 'window.localStorage 桩应可用');
    // backend 是懒初始化的：必须先走一次 initStorage（否则拿到的是未初始化的 null），
    // 这正是下面那条「经由旧路径的 kv 读写」用例断言 localStorage 的前提。
    await initStorage();
    assert.equal(getActiveBackend(), 'localStorage');
  });

  it('经由旧路径的 kv 读写落盘可用（localStorage 后端）', async () => {
    const { kvSet, kvGet, kvRemove, getActiveBackend } = await import('@/storage/storageAdapter');
    await kvSet('s2_probe', { a: 1 });
    assert.deepEqual(await kvGet('s2_probe'), { a: 1 });
    await kvRemove('s2_probe');
    assert.equal(await kvGet('s2_probe'), null);
    assert.equal(getActiveBackend(), 'localStorage');
  });
});

describe('S2 sharedStringStorage 三环境语义（与旧 supabaseSharedStorage 逐字一致）', () => {
  it('扩展环境：走 chrome.storage.local，不碰 localStorage', async () => {
    const { sharedStringStorage } = await import('@/storage-kv/stringStore');
    await sharedStringStorage.setItem('sb-x-auth-token', 'tok-1');
    assert.equal(chromeData.get('sb-x-auth-token'), 'tok-1');
    assert.equal(webLsBacking.has('sb-x-auth-token'), false);
    assert.equal(await sharedStringStorage.getItem('sb-x-auth-token'), 'tok-1');
    await sharedStringStorage.removeItem('sb-x-auth-token');
    assert.equal(await sharedStringStorage.getItem('sb-x-auth-token'), null);
  });

  it('网页环境（无 chrome）：回退裸 localStorage', async () => {
    const g = globalThis as Record<string, unknown>;
    const savedChrome = g.chrome;
    delete g.chrome;
    try {
      const { sharedStringStorage } = await import('@/storage-kv/stringStore');
      const { hasExtensionStorage } = await import('@/storage-kv/env');
      assert.equal(hasExtensionStorage(), false, '无 chrome 时共享 env 判定为非扩展环境');
      await sharedStringStorage.setItem('sb-y-auth-token', 'tok-2');
      assert.equal(webLsBacking.get('sb-y-auth-token'), 'tok-2');
      assert.equal(await sharedStringStorage.getItem('sb-y-auth-token'), 'tok-2');
      await sharedStringStorage.removeItem('sb-y-auth-token');
      assert.equal(await sharedStringStorage.getItem('sb-y-auth-token'), null);
    } finally {
      g.chrome = savedChrome;
    }
  });

  it('双无环境（SW 无 window.localStorage 且无 chrome）：读 null、写不抛', async () => {
    const g = globalThis as Record<string, unknown>;
    const savedChrome = g.chrome;
    const savedLs = g.localStorage;
    delete g.chrome;
    delete g.localStorage;
    try {
      const { sharedStringStorage } = await import('@/storage-kv/stringStore');
      const { hasWebStorage } = await import('@/storage-kv/env');
      assert.equal(hasWebStorage(), false);
      assert.equal(await sharedStringStorage.getItem('sb-z-auth-token'), null);
      await sharedStringStorage.setItem('sb-z-auth-token', 'tok-3');
      await sharedStringStorage.removeItem('sb-z-auth-token');
    } finally {
      g.chrome = savedChrome;
      g.localStorage = savedLs;
    }
  });
});

describe('S2 双路径语义保留（防抖 setGroups vs 直写 setGroupsImmediate）', () => {
  it('直写路径：await 返回即落盘，无需等 500ms 防抖窗口', async () => {
    const { storage } = await import('@/utils/storage');
    const { kvGet } = await import('@/storage/storageAdapter');
    await storage.setGroupsImmediate([makeGroup('g-direct')]);
    const raw = await kvGet<unknown[]>('tab_groups');
    assert.ok(Array.isArray(raw), '直写后 kv 应立即可读');
    assert.deepEqual((raw as Array<{ id: string }>).map(g => g.id), ['g-direct']);
  });

  it('防抖路径：窗口期内多次调用合并为一次落盘（last-write-wins），各调用方均可 await', async () => {
    const { storage } = await import('@/utils/storage');
    const { kvGet } = await import('@/storage/storageAdapter');
    const p1 = storage.setGroups([makeGroup('g-deb-1')]);
    const p2 = storage.setGroups([makeGroup('g-deb-2')]);
    await Promise.all([p1, p2]);
    const raw = (await kvGet<Array<{ id: string }>>('tab_groups')) ?? [];
    assert.deepEqual(raw.map(g => g.id), ['g-deb-2'], '最终落盘必须为最后一次写入');
    // 门面缓存亦同步为最终值（后续 getGroups 读一致）
    const groups = await storage.getGroups();
    assert.deepEqual(groups.map(g => (g as { id: string }).id), ['g-deb-2']);
  });

  it('新鲜读：getGroupsFresh 绕过 30s 缓存读到旁路写入', async () => {
    const { storage } = await import('@/utils/storage');
    const { kvSet } = await import('@/storage/storageAdapter');
    await storage.setGroupsImmediate([makeGroup('g-cached')]);
    await storage.getGroups(); // 预热 30s 缓存
    await kvSet('tab_groups', [makeGroup('g-fresh')]); // 模拟 SW 旁路写入
    const fresh = await storage.getGroupsFresh();
    assert.deepEqual(fresh.map(g => (g as { id: string }).id), ['g-fresh']);
  });
});

describe('S2 supabase 改线冒烟', () => {
  it('supabase 模块在共享存储改线后仍可初始化', async () => {
    const mod = await import('@/utils/supabaseFacade');
    assert.ok(mod.supabase, 'supabase client 应成功创建');
    assert.equal(typeof mod.isSupabaseConfigured, 'function');
    assert.equal(typeof mod.supportsOpStamp, 'function');
    assert.equal(typeof mod.supportsCloudTombstone, 'function');
  });
});

describe('SecureStorage 的敏感键清单不得漂移（2026-10-09 架构 P2-1）', () => {
  // 修正前的清单：['deviceId','migration_flags','auth_cache','user_preferences','sync_tokens']
  // 五项里只有 deviceId 真的经由 SecureStorage 落盘；另四项分别是「零写入方的预留名」
  // 与「走别的存储层」，等于承诺一个不会发生的加密。
  //
  // 这条守卫防的是**两种漂移方向**：
  //   ① 往清单里塞没有写入方的键（预留名）→ 清单假装在保护其实不存在的东西
  //   ② 清单与真实写入路径脱节 → 读代码的人以为某键已加密
  const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

  it('清单里的每个键都必须有真实写入方（不许塞预留名）', () => {
    const src = read('src/utils/secureStorage.ts');
    const m = src.match(/const SENSITIVE_KEYS: readonly string\[\] = \[([\s\S]*?)\];/);
    assert.ok(m, '找不到 SENSITIVE_KEYS 字面量');
    const keys = (m[1].match(/'([^']+)'/g) || []).map(s => s.replace(/'/g, ''));
    assert.ok(keys.length > 0, 'SENSITIVE_KEYS 是空数组 —— 那 secureStorage 就是明文存储');

    // 逐个键在 src/ 下找真实调用方（本文件自己的清单不算）。
    //
    // 【为什么不逐目录 walk】第一版用递归 walk + return，结果 `hasWriter` 置位后
    // 只退出递归的当前层，外层 for 继续跑；而更糟的是它把 deviceId 也判成
    // 「有写入方」——因为 STORAGE_KEYS 里并没有 deviceId，我却在 viaConst 分支
    // 里对**任意** key 都去试 MIGRATION_FLAGS 那个正则。逻辑本身是错的。
    //
    // 现在改成：一次性把所有 .ts/.tsx 拼成一个大文本，再逐键匹配两种形态。
    // 简单、无递归状态、也不会把一个键的证据错记给另一个。
    const allSrc = join(SRC_ROOT, '..');
    const collectTs = (dir: string): { path: string; text: string }[] => {
      const out: { path: string; text: string }[] = [];
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          out.push(...collectTs(full));
        } else if (/\.tsx?$/.test(entry) && !full.endsWith('secureStorage.ts')) {
          out.push({ path: full, text: readFileSync(full, 'utf8') });
        }
      }
      return out;
    };
    void allSrc;
    const files = collectTs(ROOT).filter(f => f.path.includes('/src/'));

    // 判据分两类：**写**必须存在（否则是预留名在假装保护）；
    // **只读兼容**可以没有写方 —— deviceId 就是这种：写入方 deviceUtils 走 KV，
    // 但历史数据可能已加密，encryptionUtils 仍需走解密才能读出（get 侧有明文回退，
    // 所以本来没加密也不会出错）。
    const READ_ONLY_COMPAT: Record<string, string> = {
      deviceId: 'encryptionUtils.ts 的 secureStorage.get<string>(\'deviceId\') —— 只读解密兼容',
    };
    const orphans = keys.filter(key => {
      // 形态①：字面量 —— secureStorage.set('deviceId', …)
      const literal = new RegExp(
        `secureStorage\\.(set|get|remove)\\s*\\(\\s*['"]${key}['"]`
      );
      if (files.some(f => literal.test(f.text))) return false;
      // 形态②：常量引用 —— secureStorage.set(STORAGE_KEYS.XXX, …)
      //        只有当该常量的**值**恰好等于本键时才算证据。
      const constName = STORAGE_KEY_LITERALS.find(e => e.value === key)?.name;
      if (!constName) return !READ_ONLY_COMPAT[key];
      const viaConst = new RegExp(
        `secureStorage\\.(set|get|remove)\\s*\\(\\s*STORAGE_KEYS\\.${constName}\\b`
      );
      if (files.some(f => viaConst.test(f.text))) return false;
      // 无写入方时，只读兼容是合法的（必须在 READ_ONLY_COMPAT 里登记理由）
      return !READ_ONLY_COMPAT[key];
    });

    assert.deepEqual(
      orphans,
      [],
      `SENSITIVE_KEYS 里的键没有真实写入方：${orphans.join('、')} —— ` +
        '零写入方的键让清单看起来在保护什么，实际什么都不保护；下一个人会据此误判某键已加密'
    );
  });

  it('auth_cache 的处置必须是「显式待决」，不能靠清单里列着它假装已加密', () => {
    const src = read('src/utils/secureStorage.ts');
    const m = src.match(/const SENSITIVE_KEYS: readonly string\[\] = \[([\s\S]*?)\];/);
    const keys = (m?.[1] ?? '').match(/'([^']+)'/g) || [];

    if (!keys.some(k => k.includes('auth_cache'))) {
      // 当前状态：auth_cache 走明文 chrome.storage（authCache.ts 直接 set）。
      // 这是**已知待决项**，必须在 secureStorage.ts 里有对应说明，
      // 否则下一个人看到「auth_cache 不在清单」会以为它不需要保护。
      assert.match(
        src,
        /auth_cache/,
        'auth_cache 不在 SENSITIVE_KEYS 里，但源码没有任何说明 —— ' +
          '它真实存在且敏感（含 email 与登录态），必须留下「为何暂不加密」的显式说明，' +
          '不能靠沉默'
      );
    }
  });
});

describe('键名与主题集合不得有第二份来源（2026-10-09 架构 P2-2 / P2-3）', () => {
  // ⚠️ 注意：本 describe 里所有源码断言都**先剥注释再匹配**。
  // 注释本身就是知识资产，会引用旧写法（例如「原先这里是手抄联合类型 'legacy'」），
  // 不剥注释就断言会把「解释历史的注释」误判成「旧实现回来了」——
  // 这是子串断言必须剥注释的同一条纪律（见 tests/deadCodeGuards）。
  const strip = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const readCode = (rel: string) => strip(read(rel));


  // 这些值此前在多个文件里各手抄一份。它们之间**没有编译期关联**：
  // 改键名漏改一处 ⇒ 旧数据静默读不到（不报错）；给主题加成员漏改数组 ⇒
  // 合法值被判无效、静默回落 legacy。两类都属于「不报错的坑」。
  const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

  it('journal / device_seq / 设备键不得手抄字面量', () => {
    const cases: { file: string; literal: string; via: string }[] = [
      { file: 'src/utils/journal.ts', literal: "'journal'", via: 'STORAGE_KEYS.JOURNAL' },
      { file: 'src/utils/seqRegistry.ts', literal: "'device_seq'", via: 'STORAGE_KEYS.DEVICE_SEQ' },
      { file: 'src/utils/deviceUtils.ts', literal: "'tabvaultpro_device_id'", via: 'LEGACY_KEYS.DEVICE_ID' },
    ];
    for (const c of cases) {
      const src = read(c.file);
      // 允许注释里提到字面量（那是解释），禁止出现在赋值右侧
      const assignment = new RegExp(
        `=\\s*${c.literal.replace(/'/g, "['\"]")}\\s*;`
      );
      assert.ok(
        !assignment.test(src),
        `${c.file} 又手抄了 ${c.literal} 作为键名 —— 改用 ${c.via}` +
          '（键名两份 = 改名时必然漏改一处，旧数据静默丢失且不报错）'
      );
      assert.match(src, new RegExp(c.via.replace(/\./g, '\\.')), `${c.file} 应引用 ${c.via}`);
    }
  });

  it('service-worker 的旧键迁移不得手抄键名', () => {
    const src = readCode('src/service-worker.ts');
    // chrome.storage.local.get(['tabGroups']) / ['tab_groups'] 这类字面量数组
    assert.ok(
      !/chrome\.storage\.local\.get\(\s*\[\s*['"]tabGroups['"]/.test(src),
      'service-worker 又手抄了旧键 tabGroups —— 改用 LEGACY_KEYS.LEGACY_TAB_GROUPS'
    );
    assert.ok(
      !/chrome\.storage\.local\.get\(\s*\[\s*['"]tab_groups['"]/.test(src),
      'service-worker 又手抄了现行键 tab_groups —— 改用 STORAGE_KEYS.GROUPS'
    );
    assert.match(src, /LEGACY_KEYS\.LEGACY_TAB_GROUPS/, '应引用权威键表');
    assert.match(src, /STORAGE_KEYS\.GROUPS/, '应引用权威键表');
  });

  it('VALID_THEME_STYLES 不得是手抄数组（必须引用 THEME_STYLES）', () => {
    const src = readCode('src/utils/storage.ts');
    assert.match(
      src,
      /VALID_THEME_STYLES[^=]*=\s*THEME_STYLES/,
      'VALID_THEME_STYLES 应直接引用 THEME_STYLES 常量，而不是再抄一份字面量'
    );
    assert.ok(
      !/VALID_THEME_STYLES[^=]*=\s*\[\s*['"]legacy['"]/.test(src),
      'VALID_THEME_STYLES 又变回手抄数组 —— 加主题时会被漏掉，合法值静默回落 legacy'
    );
    // 【2026-10-09 变异验证记录】单向防护的诚实说明：
    // 把类型手工加成 `(typeof THEME_STYLES)[number] | 'neon'`（数组不加），
    // tsc **不报错** —— 联合类型加成员本来就是合法 TS。派生方案解决的是反方向：
    // 给**数组**加成员时类型自动包含（无需手动同步）；数组漏加时运行期校验数组
    // 仍然是权威（VALID_THEME_STYLES 直接引用它），且「不得手抄」断言会红。
    // 「类型多加、数组没加」这一方向派生方案确实防不住 —— 但它不是危险方向：
    // 类型多一个成员只会让**类型检查变宽**（accept 更多的值），不会让合法值
    // 被运行时判无效；反过来（数组漏加）才会静默回落 legacy。
    // 不要在这里追求双向穷尽性断言：它的维护成本高于它防的那个坑。
    // 主题类型必须由常量派生（而不是手抄联合类型）
    const types = readCode('src/types/tab.ts');
    assert.match(
      types,
      /export\s+type\s+ThemeStyle\s*=\s*\(\s*typeof\s+THEME_STYLES\s*\)\s*\[\s*number\s*\]/,
      'ThemeStyle 必须由 THEME_STYLES 派生 —— 手抄联合类型与运行时数组没有编译期关联'
    );
    assert.ok(
      !/export\s+type\s+ThemeStyle\s*=\s*['"]legacy['"]/.test(types),
      'ThemeStyle 又变回手抄联合类型 —— 常量加了成员而类型没加，tsc 不报错，运行期静默失效'
    );
  });

  it('主题数量与 README 声明一致（6 套）', async () => {
    const { THEME_STYLES } = await import('@/types/tab');
    assert.equal(
      THEME_STYLES.length,
      6,
      `THEME_STYLES 实到 ${THEME_STYLES.length} 项：README / 商店文案都写「6 套主题风格」，` +
        '改动主题集合时必须同步那两处（tests/docsAlignment.test.ts 另有断言）'
    );
  });
});
