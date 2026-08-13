// 验证 Header 未登录态：登录入口 + AuthModal 流程
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../dist');
const shotsDir = path.resolve(__dirname, '../shots');

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let filePath = path.join(distDir, urlPath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
  if (!fs.existsSync(filePath)) { res.statusCode = 404; res.end('not found'); return; }
  res.setHeader('Content-Type', mime[path.extname(filePath)] || 'application/octet-stream');
  res.end(fs.readFileSync(filePath));
});
await new Promise(r => server.listen(4174, r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 380, height: 600 } });
await page.addInitScript(() => {
  globalThis.chrome = {
    runtime: { id: 'test-extension-id', getManifest: () => ({ name: 'TabStack', version: '1.15.1' }), getURL: p => `/${p}`, onMessage: { addListener: () => {}, removeListener: () => {} }, sendMessage: () => Promise.resolve() },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, session: { get: async () => ({}), set: async () => {} } },
    tabs: { query: async () => [], create: async () => {}, sendMessage: async () => {} },
    windows: { create: async () => {}, getCurrent: async () => ({ id: 1 }) },
    action: { setBadgeText: async () => {}, setTitle: async () => {} },
    contextMenus: { removeAll: async () => {}, create: () => {}, onClicked: { addListener: () => {}, removeListener: () => {} } },
    alarms: { create: () => {}, clear: async () => {}, onAlarm: { addListener: () => {} } },
    notifications: { create: () => {}, clear: async () => {} },
  };
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

await page.goto('http://localhost:4174/src/popup/index.html', { waitUntil: 'networkidle' });
await sleep(2500);

const skipBtn = page.locator('button', { hasText: /跳过|开始使用|稍后/ }).first();
if (await skipBtn.isVisible().catch(() => false)) { await skipBtn.click(); await sleep(500); }

// 1. 未登录状态：Header 应显示「登录」按钮（aria-label="登录后跨设备同步"）
const loginBtn = page.locator('button[aria-label="登录后跨设备同步"]');
console.log('Header 登录按钮可见:', await loginBtn.isVisible() ? '✅' : '❌');
await page.screenshot({ path: path.join(shotsDir, '5-header-unauth.png') });

// 2. 点击 Header 登录按钮 → AuthModal 出现
await loginBtn.click();
await sleep(500);
const emailInput = page.locator('input[placeholder*="邮箱"]').first();
console.log('AuthModal 显示（邮箱输入框）:', await emailInput.isVisible() ? '✅' : '❌');
await page.screenshot({ path: path.join(shotsDir, '6-header-auth-modal.png') });

// 3. 切到注册 tab
await page.locator('button', { hasText: /^注册$/ }).first().click();
await sleep(300);
const registerVisible = await page.locator('input[placeholder*="邮箱"]').first().isVisible();
console.log('切到注册 tab（仍显示表单）:', registerVisible ? '✅' : '❌');

// 4. 关闭 modal（按 Esc）
await page.keyboard.press('Escape');
await sleep(300);
const modalClosed = !(await page.locator('input[placeholder*="邮箱"]').first().isVisible().catch(() => false));
console.log('Esc 关闭 modal:', modalClosed ? '✅' : '❌');

// 5. 改用菜单内登录入口
await page.click('button[aria-label="菜单"]');
await sleep(400);
await page.click('button:has-text("登录 / 注册")');
await sleep(500);
const authFromMenu = await page.locator('input[placeholder*="邮箱"]').first().isVisible();
console.log('菜单入口也能打开 AuthModal:', authFromMenu ? '✅' : '❌');

await browser.close();
server.close();
console.log('done');