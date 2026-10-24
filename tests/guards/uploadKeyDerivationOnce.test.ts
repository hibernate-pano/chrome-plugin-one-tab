/**
 * PERF-05：上传路径**每个会话只派生一次密钥**（2026-10-24 审计）。
 *
 * ── 这条防的具体事故 ────────────────────────────────────────────────────
 *
 * 上传每组数据的流程是「加密 → 自检解回来」。修复前自检调的是
 * `decryptData(payload, userId)` —— 它会**从头再派生一次 PBKDF2-100k**
 * （实测 9.1ms/次），而同一份载荷刚加密时已经派生过同盐同 userId 的密钥
 * ⇒ 每组的 18.9ms 里有 8.9ms 是纯重复。1000 组白花约 2.6 秒墙钟
 * （并发 8 的实测基数换算），而且这段时间全在 Service Worker 的单写者
 * 队列里 —— 用户此刻点「删除会话」得排在它后面。
 *
 * ── 为什么这样量 ────────────────────────────────────────────────────────
 *
 * 判据必须落在**真实上传路径**上（接线守卫的老教训：断言「源码里调用了
 * 某个函数」= 零检测力）。所以这里跑真的 `uploadTabGroups`，并在
 * `crypto.subtle.deriveKey` 外面套一层计数器 —— PBKDF2 的每次派生都要经过它。
 *
 * 用**差值**而不是绝对值：上传路径上还有别的派生（如设备密钥），
 * 那部分是常量，两次上传相减就抵消了 ⇒ 剩下的就是「每组多少次派生」。
 *
 * ⚠️ 同时断言 d1 ≥ 1：否则「计数器没装上」会让 d3 − d1 === 0 === 期望值，
 * 变成一条恒真的断言（假绿）。
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { stubSessionJson } from '../_helpers/stubSession.ts';
import { installFakePostgrestCloud } from '../_helpers/fakePostgrestCloud.ts';

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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOADER_PATH = pathToFileURL(resolve(ROOT, 'tests/_alias-loader.mjs')).href;

const USER_ID = 'user-perf05-derive-once';
const SESSION_KEY = 'sb-stub-auth-token';
const V3_PREFIX = 'ENCRYPTED_V3_Z:';
const NOW = '2026-10-24T08:00:00.000Z';
const LATER = '2026-10-24T09:00:00.000Z';

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

/** 10 条标签的会话（能压进 V3：极小载荷会退回 V2，两者都只该派生一次）。 */
function mkGroup(id: string) {
  return {
    id,
    name: `工作 · ${id}`,
    tabs: Array.from({ length: 10 }, (_, i) => ({
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
  };
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

/** PBKDF2 派生计数器：套在 `crypto.subtle.deriveKey` 外面。 */
function countDerivations(): { stop: () => number } {
  const subtle = crypto.subtle as unknown as Record<string, unknown>;
  const original = subtle['deriveKey'] as (...args: unknown[]) => Promise<unknown>;
  let count = 0;
  subtle['deriveKey'] = (...args: unknown[]) => {
    count += 1;
    return original.apply(subtle, args);
  };
  return {
    stop: () => {
      subtle['deriveKey'] = original;
      return count;
    },
  };
}

describe('PERF-05：上传每组数据只派生一次密钥', () => {
  it('每多一个会话只多一次 PBKDF2 派生（自检复用同一次派生）', async () => {
    const { uploadSync } = await loadUpload();

    // 预热：让一次性的派生（设备密钥等）先落定，别混进差值里。
    await uploadSync.uploadTabGroups([mkGroup('perf05-warmup')], true);

    const one = countDerivations();
    await uploadSync.uploadTabGroups([mkGroup('perf05-a')], true);
    const d1 = one.stop();

    const three = countDerivations();
    await uploadSync.uploadTabGroups(
      [mkGroup('perf05-b'), mkGroup('perf05-c'), mkGroup('perf05-d')],
      true
    );
    const d3 = three.stop();

    assert.ok(d1 >= 1, `计数器没装上？1 个会话至少要有 1 次派生（实测 ${d1} 次）`);
    assert.equal(
      d3 - d1,
      2,
      `3 个会话与 1 个会话的派生次数应当只差 2（每会话一次）；` +
        `实测 d1=${d1}、d3=${d3}、差=${d3 - d1} —— ` +
        '差值翻倍说明自检又从头派生了一遍（修复前就是这样）'
    );
  });

  it('省掉那次派生之后，载荷仍然是 V3 且解回来与本机逐字相同（检测力没被省掉）', async () => {
    const { uploadSync } = await loadUpload();
    const group = mkGroup('perf05-roundtrip');
    await uploadSync.uploadTabGroups([group], true);

    const row = cloud.rows.get('perf05-roundtrip');
    assert.ok(row, '这一行必须真的上了云');
    const payload = String(row.tabs_data);
    assert.ok(
      payload.startsWith(V3_PREFIX),
      `载荷仍必须是 V3（实际前缀：${payload.slice(0, 16)}）`
    );

    const { decryptData } = await import('@/utils/encryptionUtils');
    const decoded = await decryptData<Array<{ url: string }>>(payload, USER_ID);
    assert.deepEqual(
      decoded.map(t => t.url),
      group.tabs.map(t => t.url),
      '写坏的载荷会静静地上云 —— 自检必须真的验到内容'
    );
  });
});
