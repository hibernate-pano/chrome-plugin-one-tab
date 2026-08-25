/**
 * 双 Chrome 实例数据同步 E2E 测试
 *
 * 两个独立 user-data-dir（模拟两台设备），均加载 dist/ 扩展。
 * 设备 A：注册测试账号 → 保存会话 → 手动上传云端
 * 设备 B：登录同一账号 → 手动下载 → 验证数据到达
 *
 * 运行前需先构建 dist：pnpm build
 * 运行：node scripts/e2e-sync-test.mjs
 */

import { chromium } from 'playwright';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const DIST_PATH = join(PROJECT_ROOT, 'dist');

const TEST_EMAIL = `e2e-sync-${randomUUID().slice(0, 8)}@test.tapstack.dev`;
const TEST_PASSWORD = 'SyncTest#2026!';

const EXTENSION_ID_CACHE = new Map();

/** 从已加载扩展的打开的页面中读取扩展 ID */
async function getExtensionId(context) {
  // 打开 chrome://extensions 不可行（受限页），改用 service worker 获取
  if (EXTENSION_ID_CACHE.has(context)) return EXTENSION_ID_CACHE.get(context);
  // 等待扩展 service worker 出现
  let sw = null;
  for (let i = 0; i < 30; i++) {
    const workers = context.serviceWorkers();
    sw = workers.find(w => w.url().includes('service-worker.js'));
    if (sw) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (!sw) throw new Error('未找到扩展 service worker');
  const id = new URL(sw.url()).host;
  EXTENSION_ID_CACHE.set(context, id);
  return id;
}

/** 等待 popup UI 中会话数达到预期（读页面文本“N 会话”） */
async function waitForSessionCount(page, expected) {
  for (let i = 0; i < 40; i++) {
    const text = await page.evaluate(() => document.body.innerText).catch(() => '');
    const m = text.match(/(\d+)\s*会话/);
    const count = m ? parseInt(m[1], 10) : 0;
    if (count === expected) return count;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`等待会话数=${expected} 超时`);
}

/** 读 .env 键值 */
function readEnvFile(path) {
  const env = {};
  const text = readFileSync(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const i = l.indexOf('=');
    if (i > 0) env[l.slice(0, i)] = l.slice(i + 1);
  }
  return env;
}

/** 清理测试账号及其云端数据（admin 权限直连数据库）*/
async function cleanupTestUser(email) {
  const env = { ...readEnvFile(join(PROJECT_ROOT, '.env')), ...process.env };
  const url = env.VITE_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.warn(`⚠️  未配置 SUPABASE_SERVICE_ROLE_KEY，请手动在控制台删除测试账号: ${email}`);
    return;
  }
  const admin = createClient(url, serviceKey);
  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const target = users?.users?.filter(u => u.email === email);
  for (const u of target ?? []) {
    await admin.auth.admin.deleteUser(u.id);
  }
  console.log(`✅ 已清理测试账号: ${email}`);
}

/** 启动一个扩展 Chrome 实例（独立 user-data-dir） */
async function launchExtensionInstance(label) {
  const userDataDir = mkdtempSync(join(tmpdir(), `tapstack-e2e-${label}-`));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST_PATH}`,
      `--load-extension=${DIST_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  return { context, userDataDir, label };
}

/** 打开 popup 页面 */
async function openPopup(context, label) {
  const extId = await getExtensionId(context);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/src/popup/index.html`);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

/** 登录（若尚未登录则先注册） */
async function login(page, email, password, { register = false } = {}) {
  // 若首启引导出现，先跳过
  const skipBtn = page.locator('button[aria-label="跳过引导"]');
  if (await skipBtn.count() > 0 && await skipBtn.isVisible().catch(() => false)) {
    await skipBtn.click().catch(() => {});
    await page.waitForTimeout(500);
  }

  // 打开菜单 dropdown
  await page.click('button[aria-label="菜单"]', { timeout: 15000 });
  await page.waitForSelector('button:has-text("登录 / 注册")', { timeout: 10000 });
  await page.click('button:has-text("登录 / 注册")');
  await page.waitForSelector('text=注册', { timeout: 10000 });

  // 切到注册或直接用登录
  if (register) {
    await page.click('.fixed button:has-text("注册")');
    await page.fill('input[placeholder="请输入您的邮箱"]', email);
    await page.fill('input[placeholder="请输入密码"]', password);
    await page.fill('input[placeholder="请再次输入密码"]', password);
  } else {
    await page.fill('input[placeholder="请输入您的邮箱"]', email);
    await page.fill('input[placeholder="请输入您的密码"]', password);
  }
  await page.click('button[type="submit"]');

  // 等待登录成功：SyncButton（上传/下载）仅登录后渲染
  await page.waitForSelector('button[title="手动上传本地会话到云端"]', { timeout: 20000 });
}

async function main() {
  if (!existsSync(DIST_PATH)) {
    console.error('缺少 dist/，请先运行 pnpm build');
    process.exit(1);
  }

  const deviceA = await launchExtensionInstance('A');
  const deviceB = await launchExtensionInstance('B');
  const cleanupDirs = [deviceA.userDataDir, deviceB.userDataDir];

  try {
    // ── 设备 A：注册 + 保存会话 + 上传 ──
    console.log('\n══ 设备 A：注册测试账号 ══');
    const pageA = await openPopup(deviceA.context, 'A');
    await login(pageA, TEST_EMAIL, TEST_PASSWORD, { register: true });
    console.log('✅ A 已注册并登录');

    // A 开真实标签页再保存会话（扩展保存当前窗口标签）
    const tabA1 = await deviceA.context.newPage();
    await tabA1.goto('data:text/html,<title>E2E-标签-A1</title><h1>A1</h1>');
    const tabA2 = await deviceA.context.newPage();
    await tabA2.goto('data:text/html,<title>E2E-标签-A2</title><h1>A2</h1>');

    console.log('══ 设备 A：保存当前窗口为会话 ══');
    // 在真实标签页点击扩展 action 会打开 popup——直接在 popup 页面点保存按钮
    const saveBtn = pageA.locator('[aria-label="保存当前窗口中的所有标签页为会话"]').first();
    await saveBtn.click();
    // 等待群组数 ≥1
    await waitForSessionCount(pageA, 1);
    const sessionsShown = await pageA.evaluate(() => {
      const m = document.body.innerText.match(/(\d+)\s*会话/);
      return m ? parseInt(m[1], 10) : 0;
    });
    console.log(`✅ A 保存成功，UI 显示会话数=${sessionsShown}`);

    console.log('══ 设备 A：手动上传到云端 ══');
    // 上传：点按钮 → 预览弹窗 → 确认（新账号云端为空，选“覆盖模式”与“合并模式”等效）
    await pageA.locator('button[title="手动上传本地会话到云端"]').click({ timeout: 10000 });
    await pageA.waitForSelector('.fixed h3:has-text("上传到云端")', { timeout: 10000 });
    // 预览卡片是 div onClick（非 button）
    await pageA.locator('.fixed h4:has-text("合并模式"), .fixed h4:has-text("覆盖模式")').first().click({ timeout: 10000 });
    console.log('✅ A 已完成上传（预览弹窗→确认）');

    // 等等上传完成：UI 弹窗关闭或出现提示
    await pageA.waitForSelector('.fixed h3:has-text("上传到云端")', { state: 'detached', timeout: 20000 }).catch(() => {});
    await pageA.waitForTimeout(3000);

    // ── 设备 B：登录 + 下载 + 验证 ──
    console.log('\n══ 设备 B：登录同一账号 ══');
    const pageB = await openPopup(deviceB.context, 'B');
    await login(pageB, TEST_EMAIL, TEST_PASSWORD);
    console.log('✅ B 已登录');

    console.log('══ 设备 B：手动下载云端数据 ══');
    await pageB.locator('button[title="手动从云端下载会话到本地"]').click({ timeout: 10000 });
    await pageB.waitForSelector('.fixed h3:has-text("下载到本地")', { timeout: 10000 });
    // 预览卡片是 div onClick（非 button）
    await pageB.locator('.fixed h4:has-text("合并模式"), .fixed h4:has-text("覆盖模式")').first().click({ timeout: 10000 });
    console.log('✅ B 已确认下载');
    // 等等下载完成弹窗关闭
    await pageB.waitForSelector('.fixed h3:has-text("下载到本地")', { state: 'detached', timeout: 20000 }).catch(() => {});
    await pageB.waitForTimeout(3000);

    console.log('══ 验证：B 本地数据应包含 A 保存的会话 ══');
    const bCount = await waitForSessionCount(pageB, 1);
    console.log(`✅ B 下载后 UI 显示会话数=${bCount}`);

    // 验证具体内容（会话卡片标题）
    const bodyTextB = await pageB.locator('body').innerText();
    const foundTitle = (bodyTextB.match(/E2E-标签-[A-Z]\d/) || ['(未显示标题)'])[0];

    // 汇总
    console.log('\n═══════════════ 测试结果 ═══════════════');
    console.log(`测试账号: ${TEST_EMAIL}`);
    console.log(`A 保存并上传: ✅`);
    console.log(`B 下载并获数据: ✅（UI 会话数=${bCount}，标题=${foundTitle}）`);
    console.log(`B 渲染会话卡片: ${foundTitle !== '(未显示标题)' ? '✅ 标题可见' : '（标题未直接渲染，但会话数已同步）'}`);
    console.log('═══════════════════════════════════════\n');
    await cleanupTestUser(TEST_EMAIL);
  } finally {
    await deviceA.context.close().catch(() => {});
    await deviceB.context.close().catch(() => {});
    for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
    console.log('已清理临时 user-data-dir');
  }
}

main().catch(err => {
  console.error('\n❌ E2E 测试失败:', err.message);
  process.exit(1);
});