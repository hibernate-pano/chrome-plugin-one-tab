// 完整验证 HeaderDropdown 菜单：位置、内容、子菜单、滚动
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
await new Promise(r => server.listen(4173, r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 380, height: 600 } });
await page.addInitScript(() => {
  globalThis.chrome = {
    runtime: { id: 'test-extension-id', getManifest: () => ({ name: 'TabStack', version: '1.15.0' }), getURL: p => `/${p}`, onMessage: { addListener: () => {}, removeListener: () => {} }, sendMessage: () => Promise.resolve() },
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

await page.goto('http://localhost:4173/src/popup/index.html', { waitUntil: 'networkidle' });
await sleep(2500);

const skipBtn = page.locator('button', { hasText: /跳过|开始使用|稍后/ }).first();
if (await skipBtn.isVisible().catch(() => false)) { await skipBtn.click(); await sleep(500); }

// 1. 打开菜单
await page.click('button[aria-label="菜单"]');
await sleep(500);

const dropdown = page.locator('div.absolute.right-0.w-64').first();
const dbox = await dropdown.boundingBox();
console.log('菜单 bbox:', JSON.stringify(dbox), '（viewport 380x600）');
console.log('菜单底部:', dbox.y + dbox.height, '（<600 则完整可见）');
const inView = dbox.y >= 0 && dbox.y + dbox.height <= 600;
console.log('菜单完整可见:', inView ? '✅' : '❌');

// 2. 菜单内 section 文本
const texts = await dropdown.innerText();
console.log('菜单内容:', texts.replace(/\n+/g, ' | ').slice(0, 200));

// 3. 截图
await page.screenshot({ path: path.join(shotsDir, '2-menu-open.png') });

// 4. 子菜单：导出数据
await page.click('button:has-text("导出数据")');
await sleep(300);
const exportSub = await page.locator('button:has-text("JSON 备份")').first().isVisible();
console.log('导出子菜单可见:', exportSub ? '✅' : '❌');
await page.click('button:has-text("导出数据")'); // 收起
await sleep(200);

// 5. 滚动菜单到底部，检查「清空所有会话」
await dropdown.evaluate(el => el.scrollTop = 99999);
await sleep(300);
const clearBtn = await page.locator('button:has-text("清空所有会话")').first().isVisible();
console.log('清空所有会话（滚动后可达）:', clearBtn ? '✅' : '❌');
await page.screenshot({ path: path.join(shotsDir, '3-menu-bottom.png') });

// 6. 菜单外点击关闭
await page.mouse.click(10, 400);
await sleep(300);
const closed = await dropdown.count() === 0;
console.log('外部点击关闭:', closed ? '✅' : '❌');

// 7. 登录弹窗（点击登录/注册）
await page.click('button[aria-label="菜单"]');
await sleep(400);
await page.click('button:has-text("登录 / 注册")');
await sleep(500);
const authVisible = await page.locator('text=登录').first().isVisible();
console.log('登录弹窗显示:', authVisible ? '✅' : '❌');
await page.screenshot({ path: path.join(shotsDir, '4-auth-modal.png') });

await browser.close();
server.close();
console.log('done');
