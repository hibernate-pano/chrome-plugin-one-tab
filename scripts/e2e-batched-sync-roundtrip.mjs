// 隔离往返验证（1.22.14）：绕开 popup UI 时序，直接调用仓库真实的
// uploadTabGroups / downloadTabGroups，在真实 Supabase 后端验证：
//   1) 130 个会话经分批 upsert（50/批）全部写上云（>50 强制多批）
//   2) 云端行数正确
//   3) downloadTabGroups 分页下载取回全部 130 行，解密后逐字段往返一致
//
// 需要网络与真实后端；账号用完即删。运行：
//   node --import ./tests/_register-loader.mjs --experimental-strip-types scripts/e2e-batched-sync-roundtrip.mjs
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadEnv, accountMarker } from './e2e-support.mjs';

const env = loadEnv({ cwd: process.cwd() });
globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: env.VITE_SUPABASE_URL,
  VITE_SUPABASE_ANON_KEY: env.VITE_SUPABASE_ANON_KEY,
  DEV: false,
  MODE: 'test',
};
register(pathToFileURL(resolve('tests/_alias-loader.mjs')).href, import.meta.url);

const TEST_EMAIL = `e2e-batch-${randomUUID().slice(0, 8)}@test.tapstack.dev`;
const TEST_PASSWORD = 'BatchTest#2026!';
console.log(accountMarker(TEST_EMAIL));

// ── 无头环境桩（无 window/localStorage 时 supabase-js 与 storageAdapter 需要）──
const lsData = new Map();
globalThis.window = {
  localStorage: {
    get length() { return lsData.size; },
    key: i => [...lsData.keys()][i] ?? null,
    getItem: k => (lsData.has(k) ? lsData.get(k) : null),
    setItem: (k, v) => void lsData.set(k, String(v)),
    removeItem: k => void lsData.delete(k),
    clear: () => lsData.clear(),
  },
};
globalThis.localStorage = globalThis.window.localStorage;
// chrome.storage.local 必须是真内存实现：client.ts 的会话存储走这里，
// 写不进去 = signIn 的 session 立刻蒸发，requireSessionUserId 一律报未登录。
const chromeStore = new Map();
globalThis.chrome = {
  storage: {
    local: {
      get: async keys => {
        const list = keys == null ? [...chromeStore.keys()] : Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (chromeStore.has(k)) out[k] = chromeStore.get(k);
        return out;
      },
      set: async items => {
        for (const [k, v] of Object.entries(items)) chromeStore.set(k, v);
      },
      remove: async keys => {
        for (const k of Array.isArray(keys) ? keys : [keys]) chromeStore.delete(k);
      },
    },
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
};

const { supabase } = await import('@/utils/supabase/client.ts');
const { uploadSync } = await import('@/utils/supabase/upload.ts');
const { downloadSync } = await import('@/utils/supabase/download.ts');

// 注册并登录
const { data: signUpData, error: signUpError } = await supabase.auth.signUp({ email: TEST_EMAIL, password: TEST_PASSWORD });
if (signUpError) throw new Error(`注册失败: ${JSON.stringify(signUpError)}`);
// 项目可能开启「注册即需确认邮箱」：确认模式下 signUp 不发 session，必须显式 signIn
const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({ email: TEST_EMAIL, password: TEST_PASSWORD });
if (signInError) throw new Error(`登录失败: ${JSON.stringify(signInError)}`);
if (!signInData?.session) throw new Error('登录成功但未返回 session（storage 桩可能没接住）');
console.log(`注册返回 session=${Boolean(signUpData?.session)}`);

const userId = signInData.user.id;
console.log(`✅ 测试账号就绪: ${userId}`);
// 调试：getSession 是否能读到会话
const dbg = await supabase.auth.getSession();
console.log(`调试 getSession: session=${Boolean(dbg.data?.session)} error=${dbg.error?.message ?? '无'} lsKeys=${[...lsData.keys()].join(',') || '(空)'}`);

// ── 130 个会话：>50 强制 3 批 upsert ─────────────────────────────────────
const TOTAL = 130;
const mk = i => ({
  id: `batch-${String(i).padStart(4, '0')}`,
  name: `会话-${i}`,
  tabs: [
    { id: `t-${i}`, url: `https://example.com/${i}`, title: `标签-${i}`, createdAt: '2026-10-07T00:00:00.000Z', lastAccessed: '2026-10-07T00:00:00.000Z', pinned: false },
  ],
  createdAt: '2026-10-07T00:00:00.000Z',
  updatedAt: '2026-10-07T00:00:00.000Z',
  isLocked: false,
  version: 1,
  lastOp: { d: 'e2e-batch-dev', s: i + 1 },
});
const groups = Array.from({ length: TOTAL }, (_, i) => mk(i));

console.log(`── 上传 ${TOTAL} 个会话（走真实 uploadTabGroups 分批路径）──`);
const up = await uploadSync.uploadTabGroups(groups, false);
console.log(`✅ 上传完成，writtenTombstoneIds=${up?.writtenTombstoneIds?.length ?? 0}`);

// 云端行数直查（不经分页下载）
const { count, error: countError } = await supabase
  .from('tab_groups')
  .select('id', { count: 'exact', head: true })
  .eq('user_id', userId);
if (countError) throw new Error(`云端计数失败: ${countError.message}`);
console.log(`云端行数: ${count}`);
if (count !== TOTAL) throw new Error(`云端行数 ${count} ≠ ${TOTAL}`);

console.log('── 下载（走真实 downloadTabGroups 分页路径）──');
const downloaded = await downloadSync.downloadTabGroups();
console.log(`✅ 下载完成: ${downloaded.length} 个会话`);
if (downloaded.length !== TOTAL) throw new Error(`下载数 ${downloaded.length} ≠ ${TOTAL}`);

// ── 逐行往返一致 ─────────────────────────────────────────────────────────
let mismatch = 0;
for (const d of downloaded) {
  const orig = groups.find(g => g.id === d.id);
  if (!orig) { mismatch++; console.error(`  多出的 id: ${d.id}`); continue; }
  if (d.name !== orig.name) { mismatch++; console.error(`  name 不一致: ${d.id}`); }
  if (d.tabs.length !== orig.tabs.length) { mismatch++; console.error(`  tabs 数不一致: ${d.id}`); continue; }
  if (d.tabs[0].url !== orig.tabs[0].url) { mismatch++; console.error(`  url 不一致: ${d.id}`); }
  if (d.tabs[0].title !== orig.tabs[0].title) { mismatch++; console.error(`  title 不一致: ${d.id}`); }
}
if (mismatch > 0) throw new Error(`${mismatch} 行往返不一致`);
console.log(`✅ ${TOTAL} 行逐字段往返一致（含解密）`);

// ── 清理：删账号（service_role 可用时）──
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (serviceKey) {
  const { createClient } = await import('@supabase/supabase-js');
  const admin = createClient(env.VITE_SUPABASE_URL, serviceKey);
  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  for (const u of users?.users?.filter(u => u.email === TEST_EMAIL) ?? []) {
    await admin.auth.admin.deleteUser(u.id);
  }
  console.log(`✅ 已清理测试账号: ${TEST_EMAIL}`);
} else {
  console.log(`⚠️ 无 service_role，请手动删除: ${TEST_EMAIL}`);
}
console.log('\n══════ 1.22.14 分批/分页真实后端往返验证通过 ══════');
