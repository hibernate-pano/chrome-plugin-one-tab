// 真实环境验证：保存会话后自动上传触发链路
// 真实证据路径：保存（不点手动上传） → 等 8s → 用 supabase-js 以同一账号登录
//   → 查 public.tab_groups 应有新行（标题含 "AUTO-1-自动同步"）

import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const DIST = resolve(process.cwd(), 'dist');
const EMAIL = `e2e-auto-${randomUUID().slice(0, 6)}@test.tapstack.dev`;
const PWD = 'SyncTest#2026!';

// 读 .env
const env = {};
for (const l of readFileSync(resolve('.env'), 'utf8').split('\n')) {
  const t = l.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i > 0) env[t.slice(0, i)] = t.slice(i + 1);
}
const SUPA_URL = env.VITE_SUPABASE_URL;
const SUPA_ANON = env.VITE_SUPABASE_ANON_KEY;

function launchCtx() {
  const dir = mkdtempSync(join(tmpdir(), `tapstack-auto-${randomUUID().slice(0, 4)}-`));
  return chromium.launchPersistentContext(dir, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
  });
}
async function extId(ctx) {
  return new URL(ctx.serviceWorkers()[0].url()).host;
}
async function ensureNoOverlay(page) {
  await page.evaluate(() =>
    document.querySelectorAll('.onboarding-overlay, [role=dialog][aria-label="用户引导"]').forEach(el => el.remove())
  ).catch(() => {});
}

const ctx = await launchCtx();
let server;
try {
  let n = 0;
  server = createServer((req, res) => {
    n++;
    const t = `AUTO-${n}-自动同步`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${t}</title><h1>${t}</h1>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => {});
  const id = await extId(ctx);
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/src/popup/index.html`);
  await page.waitForTimeout(1500);
  await ensureNoOverlay(page);

  // 注册
  await page.click('button[aria-label="菜单"]');
  await page.click('button:has-text("登录 / 注册")');
  await page.click('.fixed button:has-text("注册")');
  await page.fill('input[placeholder="请输入您的邮箱"]', EMAIL);
  await page.fill('input[placeholder="请输入密码"]', PWD);
  await page.fill('input[placeholder="请再次输入密码"]', PWD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('button[title="手动上传本地会话到云端"]', { timeout: 25000 });
  console.log('✅ registered:', EMAIL);

  // 打开 3 个真实页面
  for (let i = 1; i <= 3; i++) {
    const p = await ctx.newPage();
    await p.goto(`${base}/p${i}`);
    await p.waitForSelector('h1');
  }

  // 保存会话（关键：永远不点手动上传按钮）
  await page.locator('[aria-label="保存当前窗口中的所有标签页为会话"]').first().click();
  console.log('✅ saved (no manual upload clicked)');

  // 等 scheduleUpload(3000ms) 防抖 + 网络往返
  console.log('⏳ waiting 8s for auto-upload to fire…');
  await page.waitForTimeout(8000);

  // 直接查云端：用同一账号密码登录 supabase-js，列 tab_groups
  const supa = createClient(SUPA_URL, SUPA_ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signInErr } = await supa.auth.signInWithPassword({ email: EMAIL, password: PWD });
  if (signInErr) {
    console.log('❌ supabase 登录失败:', signInErr.message);
    process.exitCode = 1;
  } else {
    const { data: cloudGroups, error: cloudErr } = await supa
      .from('tab_groups')
      .select('id, name, user_id, is_deleted, updated_at')
      .eq('is_deleted', false);
    if (cloudErr) {
      console.log('❌ 云端查询失败:', cloudErr.message);
      process.exitCode = 1;
    } else {
      console.log(`📊 云端 tab_groups (${cloudGroups?.length || 0} 条):`);
      for (const g of cloudGroups || []) {
        console.log(`   - ${g.name} (id=${g.id.slice(0, 8)}, updated=${g.updated_at})`);
      }
      // 自动上传应包含 AUTO-1/2/3 标签——会话名是默认时间戳，但点开看 tab_url 应当含 127.0.0.1
      const { data: fullRows } = await supa
        .from('tab_groups')
        .select('id, name, tabs_data, updated_at')
        .eq('is_deleted', false)
        .order('updated_at', { ascending: false });
      let hasAutoUpload = false;
      for (const row of fullRows || []) {
        if (typeof row.tabs_data === 'string' && row.tabs_data.startsWith('ENCRYPTED_')) {
          // 解密 blobs 需要 user key；我们只验证"有加密数据上云"——即非空 ENCRYPTED_V2_S: 字符串
          hasAutoUpload = true;
          console.log(`   🔐 上传的会话（密文长度 ${row.tabs_data.length}）: ${row.name}`);
        }
      }
      if (hasAutoUpload && (cloudGroups?.length || 0) > 0) {
        console.log('\n✅ 自动上传验证通过：');
        console.log('   保存会话后未点手动上传按钮，TabManager.saveAllTabs 自动触发');
        console.log('   syncEngine.scheduleUpload(3000) 推到云端，云端 tab_groups 有新行 + 密文');
        process.exitCode = 0;
      } else {
        console.log('\n❌ 自动上传验证失败：云端未找到会话（保存后从未手动上传）');
        process.exitCode = 1;
      }
    }
  }
} finally {
  try { server?.close(); } catch {}
  try { await ctx.close(); } catch {}
}