// 上传路径的接线守卫：**真的**把压缩载荷写上云（2026-10-23，第 54 轮）。
//
// ── 这个文件在防什么 ─────────────────────────────────────────────────────
//
// 压缩格式做在 `encryptionUtils` 里是容易的，难的是**它有没有真的被上传路径
// 用上**。一个典型的失效：格式实现了、测试也过了，但上传路径还在调旧的
// `encryptData` ⇒ 云端一行 V3 都没有 ⇒ 出网量一点没降，而**所有单测照样绿**
// （它们测的是那个没人调的函数）。
//
// ⚠️ 这就是「接线守卫必须真的调用那条路径」的由来：
//   断言「源码里出现了 encryptCompressedData」= **零检测力**
//   （把它换成 encryptData，断言照样绿）；
//   断言「上传之后云端那一行的载荷是 V3」= 有检测力。
//
// 本文件做三件事：
//   ① 跑**真实**的 uploadTabGroups，看云端那一行里装的是什么；
//   ② 把云端那一行解回来，必须与本机的标签**逐字相同**（压缩不许丢东西）；
//   ③ 跑一次「上传 → 下载」全链路，确认压缩过的行**能被读回来**。
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { stubSessionJson } from './_helpers/stubSession.ts';
import { installFakePostgrestCloud } from './_helpers/fakePostgrestCloud.ts';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

if (!process.env.VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOADER_PATH = pathToFileURL(resolve(ROOT, 'tests/_alias-loader.mjs')).href;

const USER_ID = 'user-compressed-upload';
const SESSION_KEY = 'sb-stub-auth-token';
const V3_PREFIX = 'ENCRYPTED_V3_Z:';
const NOW = '2026-10-23T08:00:00.000Z';
const LATER = '2026-10-23T09:00:00.000Z';

// ── 浏览器/扩展环境桩（必须在被测模块被 import 之前就位）───────────────
const lsData = new Map<string, string>();
const localStorageStub = {
  get length() {
    return lsData.size;
  },
  key: (i: number) => [...lsData.keys()][i] ?? null,
  getItem: (k: string) => (lsData.has(k) ? (lsData.get(k) as string) : null),
  setItem: (k: string, v: string) => void lsData.set(k, String(v)),
  removeItem: (k: string) => void lsData.delete(k),
  clear: () => void lsData.clear(),
};
(globalThis as Record<string, unknown>).window = { localStorage: localStorageStub };
(globalThis as Record<string, unknown>).localStorage = localStorageStub;

const chromeData = new Map<string, unknown>();
(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: async (k: string | string[]) => {
        const keys = Array.isArray(k) ? k : [k];
        const out: Record<string, unknown> = {};
        for (const key of keys) if (chromeData.has(key)) out[key] = chromeData.get(key);
        return out;
      },
      set: async (obj: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(obj)) chromeData.set(k, v);
      },
      remove: async (k: string) => void chromeData.delete(k),
    },
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
  runtime: { getManifest: () => ({ version: 'test' }) },
  alarms: {
    create: () => undefined,
    clear: async () => true,
    onAlarm: { addListener: () => undefined },
  },
};

const cloud = installFakePostgrestCloud();
cloud.setSessionUser(USER_ID);

/** 造一个「典型」的会话：10 条标签、URL/标题/时间戳各不相同（有压缩空间）。 */
function mkGroup(id: string, tabCount = 10) {
  return {
    id,
    name: `工作 · ${id}`,
    tabs: Array.from({ length: tabCount }, (_, i) => ({
      id: `V1StGXR8_Z5jdHi6B-my${i}`,
      url: `https://www.example${i}.com/some/article/path?ref=nav`,
      title: `示例站点 ${i} 的页面标题 — 一个比较长的标题`,
      favicon: `https://www.google.com/s2/favicons?domain=example${i}.com&sz=32`,
      createdAt: NOW,
      lastAccessed: NOW,
      pinned: false,
    })),
    createdAt: NOW,
    updatedAt: LATER,
    isLocked: false,
    version: 1,
  } as any;
}

before(async () => {
  register(LOADER_PATH, import.meta.url);
  lsData.set('storage_version', JSON.stringify(5));
  lsData.set(SESSION_KEY, stubSessionJson(USER_ID));
  chromeData.set(SESSION_KEY, stubSessionJson(USER_ID));
});

beforeEach(() => {
  cloud.rows.clear();
  cloud.ops.length = 0;
  cloud.requests.length = 0;
});

async function loadUpload() {
  const probe = await import('@/utils/supabase/probe');
  probe.__resetCloudColumnProbeCacheForTests();
  const { uploadSync } = await import('@/utils/supabase/upload');
  return { uploadSync };
}

describe('上传路径：云端那一行装的是压缩载荷', () => {
  it('上传 10 标签的会话 ⇒ 云端行的 tabs_data 是 V3，且解回来与本机逐字相同', async () => {
    const { uploadSync } = await loadUpload();
    const group = mkGroup('g-compress-1');

    await uploadSync.uploadTabGroups([group], true);

    const row = cloud.rows.get('g-compress-1');
    assert.ok(row, '这一行必须真的上了云（否则下面验的是空气）');
    const payload = String(row.tabs_data);
    assert.ok(
      payload.startsWith(V3_PREFIX),
      `云端那一行必须装 V3 压缩载荷（实际前缀：${payload.slice(0, 16)}）—— ` +
        '上传路径没接上压缩，这一轮改动就等于没做'
    );

    const { decryptData } = await import('@/utils/encryptionUtils');
    const decoded = await decryptData<any[]>(payload, USER_ID);
    assert.equal(decoded.length, group.tabs.length);
    for (let i = 0; i < group.tabs.length; i += 1) {
      assert.equal(decoded[i].id, group.tabs[i].id);
      assert.equal(decoded[i].url, group.tabs[i].url);
      assert.equal(decoded[i].title, group.tabs[i].title);
    }
  });

  it('压缩后上云的字节确实比旧格式少（出网量按字节计费，这是这轮的全部意义）', async () => {
    const { uploadSync } = await loadUpload();
    const group = mkGroup('g-compress-2');

    await uploadSync.uploadTabGroups([group], true);

    const row = cloud.rows.get('g-compress-2');
    assert.ok(row, '这一行必须真的上了云');
    const payload = String(row.tabs_data);
    const { encryptData } = await import('@/utils/encryptionUtils');
    const { serializeTab } = await import('@/core/tabDataCodec');
    const legacy = await encryptData(group.tabs.map(serializeTab), USER_ID);

    assert.ok(
      payload.length < legacy.length * 0.7,
      `压缩载荷应比旧格式至少小 30%（旧=${legacy.length} B，新=${payload.length} B）`
    );
  });

  it('上传 → 下载 全链路：压缩过的行能被读回来，标签一条不少', async () => {
    const { uploadSync } = await loadUpload();
    const group = mkGroup('g-compress-3');
    await uploadSync.uploadTabGroups([group], true);

    // 走真实的下载路径（同一份载荷被读回来）
    const { downloadSync } = await import('@/utils/supabase/download');
    const groups = await downloadSync.downloadTabGroups();

    const found = groups.find(g => g.id === 'g-compress-3');
    assert.ok(found, '刚上传的会话必须能被下载回来');
    assert.equal(
      found!.tabs.length,
      group.tabs.length,
      '标签一条都不能少 —— 压缩丢一条就是丢用户的数据'
    );
    assert.deepEqual(
      found!.tabs.map((t: { url: string }) => t.url),
      group.tabs.map((t: { url: string }) => t.url),
      '下载回来的 URL 顺序与内容必须与上传时一致'
    );
  });
});
