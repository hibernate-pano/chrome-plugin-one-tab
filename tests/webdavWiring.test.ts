// 后端接线的真实行为测试（2026-10-13，阶段 2）。
//
// 阶段 0 铺好接缝、阶段 1 造好适配器之后，真正的风险转移到了**接线**：
//   · 老用户会不会因为升级被静默切到没配过的 WebDAV（升级即失能）
//   · 「选了加密但忘了输口令」⇒ 数据明文上云
//   · 配了 WebDAV 但同步悄悄走了 Supabase（无声回退）
// 这几条都是**静默**的失败模式，所以必须逐条钉住。
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

if (!process.env.VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

import {
  primeSyncBackend,
  getLastBackendResolution,
  resetActiveSyncBackend,
  setBackendFactory,
} from '@/sync-backend';
import {
  clearSessionSecrets,
  saveWebDavConfig,
  setSessionSecrets,
} from '@/sync-backend/webdav/config';
import { validateSyncBackend, DEFAULT_SETTINGS } from '@/utils/storage';
import type { SyncBackendPort } from '@/sync-backend/ports';

// ── 内存 KV：让 chrome.storage 这一层可控 ───────────────────────────────
const store = new Map<string, unknown>();
const kv = {
  async get<T>(k: string) {
    return store.has(k) ? (store.get(k) as T) : null;
  },
  async set<T>(k: string, v: T) {
    store.set(k, v);
  },
  async remove(k: string) {
    store.delete(k);
  },
};

/**
 * 给 storage-kv 层铺一个 localStorage 底座。
 *
 * ⚠️ 为什么必须铺：`resolveBackendOutcome()` 读设置走的是
 * **真实的 storage-kv 适配层**（`kvGet('user_settings')`），不是我们传进去的
 * `kv` 实例。第一版测试只往 `store` 里塞值却没铺 localStorage，于是解析读到
 * 空 ⇒ 一律回落 supabase ⇒ 4 条用例全红 looked like 实现坏了。
 * 实际是「测试没接上」，不是实现错 —— 这两者的区别是：
 * 实现错要改产品代码，测试没接上要改测试，改错方向会引入真 bug。
 *
 * ⚠️ 第二个坑（更难）：**灌值必须在 storage 初始化之后**。
 * `ensureInitialized()` 会跑 `migrateFromLocalStorage()`，它把 localStorage 里
 * 的键搬进驱动后**逐个 removeItem 清掉源键**；而 `user_settings` 不在
 * 迁移白名单（`STORAGE_KEYS` 覆盖的是业务键）里，但它仍会被
 * `migrateFromLocalStorage` 的清理循环扫到。
 * 于是「初始化前灌值」= 值被迁移流程清掉 ⇒ 后续解析读到空 ⇒ 又全部回落。
 * 这就是第一版铺了 localStorage 仍然 6 条全红的原因。
 *
 * ⚠️ 第三个坑（最隐蔽）：**灌值必须走真实的 kvSet，不能往自己的 Map 塞**。
 * 驱动选中 localStorage 时，它读写的就是上面那个 `localStorage` 对象；
 * 测试自己那份 `kv` Map 是**另一个数据源**。往 `kv` 塞值而驱动去读
 * localStorage ⇒ 解析永远读到空。看起来像「解析逻辑坏了」，
 * 实际是数据没进对地方。第三版才通过 `seed()` 统一走 kvSet 才转绿。
 */
let storageReady: Promise<void> | null = null;
function ensureStorageReady(): Promise<void> {
  if (!storageReady) {
    storageReady = (async () => {
      const { initStorage } = await import('@/storage-kv/storageAdapter');
      await initStorage();
    })();
  }
  return storageReady;
}

{
  const ls = {
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => (store.has(k) ? String(store.get(k)) : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  (globalThis as Record<string, unknown>).window = { localStorage: ls };
}

/** 往底层存储灌一个值（会先等 storage 初始化完，避免被迁移流程清掉）。 */
async function seed(k: string, value: unknown) {
  await ensureStorageReady();
  const { kvSet } = await import('@/storage-kv/storageAdapter');
  await kvSet(k, value);
}

/**
 * 「真实」的 KV 句柄 = storage-kv 适配层本身。
 *
 * ⚠️ 第三版才想清楚的一层：`loadWebDavConfig()` 默认用 `chromeKvAdapter`
 *（包着真实 storage-kv）。测试若把配置存进**自己那份 kv Map**，
 * 解析时 `loadWebDavConfig()` 去读真实适配层 —— 读不到，于是回落原因
 * 变成「没填云服务信息」而不是「需要重新解锁」，看起来像解析逻辑排错了序。
 * 这类「数据存 A、读 B」的错位最难自查：每一段单独看都对。
 */
const realKv = {
  async get<T>(k: string) {
    await ensureStorageReady();
    const { kvGet } = await import('@/storage-kv/storageAdapter');
    return kvGet<T>(k);
  },
  async set<T>(k: string, v: T) {
    await ensureStorageReady();
    const { kvSet } = await import('@/storage-kv/storageAdapter');
    return kvSet(k, v);
  },
  async remove(k: string) {
    await ensureStorageReady();
    const { kvRemove } = await import('@/storage-kv/storageAdapter');
    return kvRemove(k);
  },
};

/** 清空底层存储（走真实驱动，避免「清了另一个数据源」的假象）。 */
async function resetStorage() {
  await ensureStorageReady();
  const { kvSet } = await import('@/storage-kv/storageAdapter');
  for (const k of [...store.keys()]) {
    if (k.startsWith('webdav_')) await kvSet(k, undefined);
  }
  await kvSet('user_settings', undefined);
}

const fakeBackend = (id: 'supabase' | 'webdav'): SyncBackendPort =>
  ({
    id,
    label: id,
    async fetchFingerprints() {
      return [];
    },
    async downloadGroups() {
      return [];
    },
    async uploadGroups() {
      return { writtenIds: [] };
    },
    async broadcastDeletes() {},
    async purgeExpiredDeletes() {
      return 0;
    },
    async uploadSettings() {},
    async downloadSettings() {
      return null;
    },
  }) satisfies SyncBackendPort;

describe('syncBackend 设置的校验单点', () => {
  it('合法值原样通过', () => {
    assert.equal(validateSyncBackend('webdav'), 'webdav');
    assert.equal(validateSyncBackend('supabase'), 'supabase');
  });

  it('非法值回落 supabase（老用户路径永远可用）', () => {
    for (const bad of [undefined, null, 'dropbox', 42, {}, 'WebDAV']) {
      assert.equal(validateSyncBackend(bad), 'supabase', `应回落：${String(bad)}`);
    }
  });

  it('默认值是 supabase —— 存量用户零行为变化，不得默认 webdav', () => {
    // 「升级即失能」的唯一防线：默认若是 webdav，所有升级用户会在
    // 没配过任何云服务的情况下被切到新后端，打开扩展就要求配置。
    assert.equal(DEFAULT_SETTINGS.syncBackend, 'supabase');
  });
});

describe('后端解析：老用户零行为变化', () => {
  beforeEach(async () => {
    await clearSessionSecrets();
    resetActiveSyncBackend();
    setBackendFactory(null);
    await resetStorage();
  });

  it('存储里没有 syncBackend 字段（存量用户）→ 解析为 supabase', async () => {
    const stored = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
    delete stored.syncBackend;
    await seed('user_settings', stored);
    const out = await primeSyncBackend();
    assert.equal(out.requestedId, 'supabase');
    assert.equal(out.resolvedId, 'supabase');
    assert.equal(out.fallbackReason, undefined, '正常路径不该有回落原因');
  });

  it('存储里是脏数据 → 仍解析为 supabase，不抛错', async () => {
    await seed('user_settings', '这不是对象');
    const out = await primeSyncBackend();
    assert.equal(out.resolvedId, 'supabase');
  });
});

describe('后端解析：选了 webdav 时的回落都必须出声', () => {
  beforeEach(async () => {
    await clearSessionSecrets();
    resetActiveSyncBackend();
    setBackendFactory(null);
    await resetStorage();
    await seed('user_settings', { ...DEFAULT_SETTINGS, syncBackend: 'webdav' });
  });

  it('选了 webdav 但没填云服务 → 锁定（不回落 Supabase）+ 给出可读原因', async () => {
    const out = await primeSyncBackend();
    assert.equal(out.requestedId, 'webdav');
    // 2026-10-14 修 P0：锁定占位，后端 id 仍是 webdav，绝不切回 supabase。
    // 否则重启浏览器（口令清空是常态）后自动同步把数据传到用户没选的后端。
    assert.equal(out.resolvedId, 'webdav');
    assert.match(out.lockedReason ?? '', /云服务信息/);
    assert.equal(out.fallbackReason, undefined);
    // 占位后端的任何操作都必须抛同一句可读错（失败要出声）。
    await assert.rejects(() => out.backend.fetchFingerprints(), /云服务信息/);
    await assert.rejects(() => out.backend.downloadGroups(), /云服务信息/);
  });

  it('填了但未解锁 → 锁定（不回落 Supabase）+ 说明是「需要重新输入」', async () => {
    await saveWebDavConfig(
      { baseUrl: 'https://dav.example.com/dav/', username: 'u', rootPath: 'TapStack', encryption: 'plain' },
      realKv
    );
    const out = await primeSyncBackend();
    assert.equal(out.requestedId, 'webdav');
    assert.equal(out.resolvedId, 'webdav');
    assert.match(out.lockedReason ?? '', /解锁/);
    assert.equal(out.fallbackReason, undefined);
    await assert.rejects(() => out.backend.uploadGroups([]), /解锁/);
    await assert.rejects(() => out.backend.downloadSettings(), /解锁/);
  });

  it('配好并解锁 → 解析为 webdav，无回落，且凭据确实传到了工厂', async () => {
    await saveWebDavConfig(
      { baseUrl: 'https://dav.example.com/dav/', username: 'u', rootPath: 'TapStack', encryption: 'plain' },
      realKv
    );
    await setSessionSecrets('u', 'app-password', null);
    // 用数组而不是 `let x: T | null`：TS 会把「只在闭包里赋值」的变量
    // 收窄成 null（访问属性时报 Property does not exist on type 'never'）——
    // 它假定闭包不会被调用。而这里正是要验证「闭包被调用且参数正确」。
    const factoryCalls: Array<{ cfg: { baseUrl: string }; secrets: { password: string } }> = [];
    setBackendFactory((cfg, secrets) => {
      factoryCalls.push({ cfg, secrets });
      return fakeBackend('webdav');
    });

    const out = await primeSyncBackend();
    assert.equal(out.requestedId, 'webdav');
    assert.equal(out.resolvedId, 'webdav');
    assert.equal(out.fallbackReason, undefined);
    assert.equal(factoryCalls.length, 1, '工厂必须被调用一次');
    assert.equal(factoryCalls[0].cfg.baseUrl, 'https://dav.example.com/dav/');
    assert.equal(factoryCalls[0].secrets.password, 'app-password');
  });

  it('锁定信息可被 UI 读取（否则就只是日志里的一句话）', async () => {
    await primeSyncBackend(); // 未配置 → 锁定
    const last = getLastBackendResolution();
    assert.ok(last, '必须记录最近一次解析结果');
    assert.equal(last?.requestedId, 'webdav');
    assert.equal(last?.resolvedId, 'webdav');
    assert.ok((last?.lockedReason ?? '').length > 0);
  });
});

describe('生产接线：defaultFactory 必须注入权限守卫（2026-10-14 P1，变异4）', () => {
  // 背景：变异验证发现，删掉 defaultFactory 里 guard 那行（index.ts 的第 3 参数）
  // 后 1291 个测试照样全绿 —— 机制层（client.ts 的预检 + 测试）钉住了，
  // 但「生产构造到底传没传 guard」没有任何测试断言。
  // 这条钉的是**接线本身**：走真实 defaultFactory，不注入任何 fake factory。
  beforeEach(async () => {
    await clearSessionSecrets();
    resetActiveSyncBackend();
    setBackendFactory(null); // 必须走真实 defaultFactory，否则测的就不是生产接线
    await resetStorage();
    await seed('user_settings', { ...DEFAULT_SETTINGS, syncBackend: 'webdav' });
    await saveWebDavConfig(
      { baseUrl: 'https://dav.example.com/dav/', username: 'u', rootPath: 'TapStack', encryption: 'plain' },
      realKv
    );
    await setSessionSecrets('u', 'app-password', null);
  });

  // 清理统一走用例内的 finally（chrome 全局 + 会话密钥 + 后端缓存），
// 不用 afterEach 钩子：本文件既有风格是各用例自带 beforeEach 做隔离。
  it('未授权时生产构造的后端必须抛权限文案（而不是静默发请求）', async () => {
    // 只否认 contains 即可：同步路径只查 contains，不调 request。
    (globalThis as Record<string, unknown>).chrome = {
      permissions: { contains: async () => false },
    };
    try {
      const out = await primeSyncBackend();
      // 若回落说明测试 setup 错（配置/解锁没接上），不是实现错 —— 先钉住这个前提。
      assert.equal(out.resolvedId, 'webdav', '生产必须解析为 webdav 而不是回落');
      // fetchFingerprints 第一件事就是 loadManifest → client.get，必经 guard。
      // 只断言「用户看到什么」（文案），不断言 guard 的实现细节（status 0 / 标记）。
      await assert.rejects(
        () => out.backend.fetchFingerprints(),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /权限|测试连接/, '必须抛可指导操作的权限文案');
          return true;
        }
      );
    } finally {
      delete (globalThis as Record<string, unknown>).chrome;
    }
  });
});

describe(
  '生产接线：defaultFactory 必须注入 peekDeviceSeq（2026-10-17 P0，变异验证）',
  () => {
    // 背景：适配器的 `peekDeviceSeq ?? (() => 0)` 兜底，会让「水位线的 seq 时钟
    // 回退自检」永远拿到 0，`current < deviceSeq` 恒假 ⇒ loadWatermark 的守卫
    // 在生产环境是死代码。而 defaultFactory 此前**恰好没注入**它。
    //
    // 后果就是 Supabase 侧早已修过的那个 P0（utils/supabase/syncWatermark.ts
    // 头注释）：本地 device_seq 被清零（换机 / 清数据 / IndexedDB 被回收）而
    // 水位线存活时，新会话 lastOp.s 从 1 重新起算，永远低于旧水位 ⇒
    // **新会话静默永不上传**；下一拍下载合并又以云端大 seq 赢 ⇒
    // **新会话被静默删除，而 UI 报「同步成功」**。1.22.0 起无回收站。
    //
    // 为什么机制层测试抓不到：webdavAdapter.test.ts 一直显式注入
    // `peekDeviceSeq: async () => opts.deviceSeq ?? 0`，测的是「注入了以后的行为」，
    // 而生产走的是「不注入」那条分支 —— 两者从未交叉验证。
    // 这条钉的正是**接线本身**，与上面那条权限守卫测试同一范式：
    // 走真实 defaultFactory（setBackendFactory(null)），不注入任何 fake factory。
    beforeEach(async () => {
      await clearSessionSecrets();
      resetActiveSyncBackend();
      setBackendFactory(null); // 必须走真实 defaultFactory，否则测的就不是生产接线
      await resetStorage();
      await seed('user_settings', { ...DEFAULT_SETTINGS, syncBackend: 'webdav' });
      await saveWebDavConfig(
        { baseUrl: 'https://dav.example.com/dav/', username: 'u', rootPath: 'TapStack', encryption: 'plain' },
        realKv
      );
      await setSessionSecrets('u', 'app-password', null);
    });

    it('生产构造的后端必须把真实 seq 计数器接进水位自检', async () => {
      // 造一条「时钟已推进」的基线：device_seq = 99。
      // 若 defaultFactory 漏注入，适配器里的 peekDeviceSeq() 恒返回 0，
      // 水位里记下的 deviceSeq 基线就会是 0 而不是 99 —— 时钟回退自检随之失效。
      await realKv.set('device_seq', 99);

      // 走真实 defaultFactory ⇒ client 用的是全局 fetch，所以必须铺一个
      // 假的 DAV 服务端（否则会真的去请求 https://dav.example.com）。
      const files = new Map<string, string>();
      // ⚠️ 这个假服务器必须**说 WebDAV 协议**。
      // 2026-10-20：它原先对 PROPFIND 也回「请求正文」，于是响应里没有
      // 任何 <multistatus> ⇒ 适配器判「目录读不懂」⇒ fail-closed ⇒
      // 上传被中止。本条要测的是「水位基线有没有接上真实 seq 计数器」，
      // 被列目录的失败挡住就测不到它了 —— 所以这里必须回一份**合法的
      // DAV 清单**（Depth:0/1 都回），而不是随便回个 200。
      const davResponseXml = (url: string) => {
        const rel = url.replace('https://dav.example.com/dav/', '').replace(/\/+$/, '');
        const childEntries = [...files.keys()]
          .filter(k => {
            const krel = k.replace('https://dav.example.com/dav/', '');
            return krel !== rel && krel.startsWith(rel + '/') && !krel.slice(rel.length + 1).includes('/');
          })
          .map(k => {
            const krel = k.replace('https://dav.example.com/dav/', '');
            const isDir = !krel.slice(rel.length + 1).includes('/');
            return (
              `<D:response><D:href>https://dav.example.com/dav/${krel}${isDir ? '/' : ''}</D:href>` +
              `<D:propstat><D:prop><D:resourcetype>${isDir ? '<D:collection/>' : ''}</D:resourcetype>` +
              `<D:getetag>"x1"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
            );
          });
        return (
          '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">' +
          `<D:response><D:href>https://dav.example.com/dav/${rel}/</D:href>` +
          '<D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype>' +
          '<D:getetag>"x1"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>' +
          childEntries.join('') +
          '</D:multistatus>'
        );
      };
      const fakeFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'PROPFIND') {
          // 目录也可能不存在（还没建库）⇒ 404 = 「列不出来」。
          const rel = url.replace('https://dav.example.com/dav/', '').replace(/\/+$/, '');
          const known =
            rel === '' ||
            [...files.keys()].some(k => k.replace('https://dav.example.com/dav/', '').startsWith(rel));
          if (!known) return new Response(null, { status: 404 });
          return new Response(davResponseXml(url), {
            status: 207,
            headers: { 'Content-Type': 'application/xml' },
          });
        }
        if (method === 'GET') {
          const body = files.get(url);
          if (body === undefined) return new Response(null, { status: 404 });
          return new Response(body, { status: 200 });
        }
        files.set(url, String(init?.body ?? ''));
        // PUT 必须回 ETag，否则会走「不返 ETag 时读回」的补偿路径。
        return new Response(null, { status: method === 'MKCOL' ? 201 : 200, headers: { ETag: '"x1"' } });
      };

      (globalThis as Record<string, unknown>).chrome = {
        permissions: { contains: async () => true },
      };
      (globalThis as Record<string, unknown>).fetch = fakeFetch;
      try {
        const out = await primeSyncBackend();
        assert.equal(out.resolvedId, 'webdav', '生产必须解析为 webdav（前提钉住，否则测的不是本条）');

        // 走一次真实上传，让适配器自己把水位写进它自己的 kv。
        // 之后把水位读回来，断言 deviceSeq 基线 = 99。
        // 漏注入时这个值会是 0 —— 这就是本条的可观测判据。
        const uploaded = await out.backend.uploadGroups([
          {
            id: 'w1',
            name: '会话',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            isLocked: false,
            lastOp: { d: 'dev-A', s: 100 },
            tabs: [],
          } as never,
        ]);
        assert.ok(uploaded, '上传必须成功，否则水位不会被写入');

        // 水位键按 baseUrl|username|root 哈希寻址（adapter.watermarkKey），
        // 不能凭空拼字面量 —— 遍历底层 store 找唯一的 webdav_sync_watermark:* 条目。
        let wm: { seq: number; deviceSeq: number } | null = null;
        for (const k of [...store.keys()]) {
          if (k.startsWith('webdav_sync_watermark:')) {
            wm = (await realKv.get<{ seq: number; deviceSeq: number }>(k)) ?? null;
          }
        }
        assert.ok(wm, '上传后必须落下水位，否则增量上传无法收敛');
        assert.equal(
          wm.deviceSeq,
          99,
          '水位里的 deviceSeq 基线必须来自真实 seq 计数器；等于 0 说明 defaultFactory ' +
            '漏注入 peekDeviceSeq，时钟回退自检在生产环境是死代码'
        );
      } finally {
        delete (globalThis as Record<string, unknown>).chrome;
        delete (globalThis as Record<string, unknown>).fetch;
      }
    });
  }
);

describe('凭据存储：绝不落盘', () => {
  beforeEach(async () => {
    await clearSessionSecrets();
    await resetStorage();
  });
  it('保存的配置里只有地址/账号/目录/加密选择，没有口令', async () => {
    await saveWebDavConfig(
      {
        baseUrl: 'https://dav.example.com/dav/',
        username: 'me@example.com',
        rootPath: 'TapStack',
        encryption: 'required',
      },
      realKv
    );
    const raw = JSON.stringify(store.get('webdav_sync_config_v1'));
    assert.ok(!raw.includes('password'), '应用密码不得落盘');
    assert.ok(!raw.includes('passphrase'), '加密口令不得落盘');
    assert.ok(raw.includes('dav.example.com'));
  });
});

describe('「选了加密但没口令」必须报错，不得明文上云', () => {
  const group = {
    id: 'g1',
    name: 'n',
    tabs: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    isLocked: false,
  };

  function makeAdapter(fakeFetch: typeof fetch, requireEncryption: boolean) {
    return import('@/sync-backend/webdav/adapter').then(
      async ({ WebDavBackendAdapter }) => {
        const { WebDavClient } = await import('@/sync-backend/webdav/client');
        return new WebDavBackendAdapter({
          client: new WebDavClient(
            { baseUrl: 'https://dav.example.com/dav/', username: 'u', password: 'p' },
            fakeFetch
          ),
          config: {
            baseUrl: 'https://dav.example.com/dav/',
            username: 'u',
            password: 'p',
            passphrase: null, // 本次忘了输口令
            requireEncryption,
          },
          kv,
        });
      }
    );
  }

  // ⚠️ 注意末尾的 `()`：`(() => async () => {...})` 只是**造了个函数**，
  // 没调用它，于是 fetchImpl 是「返回 undefined 的 async 函数」——
  // 适配器于是报「GET 失败（HTTP undefined）」。前两版都栽在这里：
  // 看起来像产品代码在乱抛错，其实是桩没被调用。
  const notFoundFetch = ((_url: string | URL, init?: RequestInit) => {
    const method = String(init?.method ?? 'GET');
    // 每个分支都必须给出确定的 status。
    const status = method === 'PUT' || method === 'MKCOL' ? 201 : 404;
    return Promise.resolve({
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => null },
      text: async () => '',
    } as unknown as Response);
  }) as unknown as typeof fetch;

  it('requireEncryption=true 且无口令 ⇒ uploadGroups 抛错（不写任何数据）', async () => {
    const adapter = await makeAdapter(notFoundFetch, true);
    // 断言的是「因为缺口令而中止」，不是「因为任何原因失败」。
    // 若只断言 /抛错/，网络层先失败（GET 404）也会绿 —— 那是假绿：
    // 删掉 requireEncryption 分支后这条依然会红吗？会，但红的原因不同，
    // 而断言必须能区分「因为口令」与「因为别的」。
    await assert.rejects(() => adapter.uploadGroups([group]), /没有提供口令|明文/);
  });

  it('选了「不加密」且无口令 ⇒ 允许（合法选择，不是故障）', async () => {
    const adapter = await makeAdapter(notFoundFetch, false);
    const out = await adapter.uploadGroups([group]);
    assert.equal(out.writtenIds.length, 1, '合法的不加密选择应能正常写入');
  });
});

