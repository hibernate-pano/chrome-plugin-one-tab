// E2E 共享 helper —— 6 个脚本原先各自复制了一份，同时各自复制了同样的坑。
//
// ⚠️ 三个关键约定，每条都对应一次真实踩坑（详见测试报告 §4.5）：
//
// 1. 【不要 el.remove() 删引导遮罩】那层遮罩是 React 管理的 DOM 节点，外部删除后
//    React 再 patch 会抛 NotFoundError(insertBefore/removeChild)，把整个应用打进
//    错误边界（现象：「改名/保存后上传按钮消失、界面变成"出现了一些问题"」）。
//    正确做法：点「跳过引导」按钮，让 React 自己收掉。本模块的 dismissOnboarding 只做这件事。
//
// 2. 【IDB 读取失败必须 throw】旧 helper 把错误 resolve 成 []，于是"数据全丢"
//    会被断言当成"没有数据"而假绿。readLocalGroups 对真实故障（打开失败/无 kv store/
//    事务失败）一律 throw；只有"记录尚未写入"才返回 []。
//
// 3. 【下载有 35s 上传保护窗口】decideDownloadPrecheck 在最近上传后 35s 内会 skip
//    下载，固定 sleep 判可靠性为 0。用 downloadUntil 轮询，并用 last_sync_time
//    前进与否确认"下载确实执行过"。
//
// 另外：登录/首屏渲染超时统一 40s —— bundled Chromium 冷启动首次运行会超过 20s
// （实测：同一脚本首跑失败、二跑通过）。

import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';

export const DIST = resolve(process.cwd(), 'dist');

/**
 * 给没有默认超时的操作（page.evaluate / sw.evaluate）套一层超时。
 * 否则一次卡住的 IDB 读取会让整个脚本静默挂死 —— 比失败更难排查。
 */
export const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`超时(${ms}ms): ${label}`)), ms)),
]);
export const LOGIN_TIMEOUT_MS = 40_000;

/** 启动一个加载扩展的持久化上下文（每个 ctx = 一台"设备"） */
export function launchCtx(label) {
  const dir = mkdtempSync(join(tmpdir(), `tapstack-${label}-`));
  return chromium.launchPersistentContext(dir, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
  });
}

export async function extId(ctx) {
  const sw = ctx.serviceWorkers()[0];
  if (!sw) throw new Error('未找到扩展 service worker');
  return new URL(sw.url()).host;
}

/**
 * 关掉首次引导遮罩 —— 只点「跳过引导」，绝不直接删 React 节点（见文件头约定 1）。
 * 遮罩不存在时什么都不做。
 */
export async function dismissOnboarding(page) {
  const overlay = page.locator('.onboarding-overlay');
  const skip = page.locator('button[aria-label="跳过引导"]');

  // 绝大多数情况（非首启）根本没遮罩 → 1.5s 内就能确定，不拖慢测试
  const overlayPresent = await overlay
    .waitFor({ state: 'visible', timeout: 1500 })
    .then(() => true)
    .catch(() => false);
  if (!overlayPresent) return;

  // 有遮罩：它是异步渲染的（首启读完成状态后才挂载），要等「跳过」按钮真正可点再点
  const clickable = await skip
    .waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (clickable) {
    await skip.click({ timeout: 5000 }).catch(() => {});
  } else {
    // 组件内处理 Escape（OnboardingGuide 的 keydown 分支）
    await page.keyboard.press('Escape').catch(() => {});
  }

  // 收尾：确认遮罩消失（绝不直接删 React 节点，见文件头约定 1）
  for (let i = 0; i < 10; i++) {
    const stillVisible = (await overlay.count()) > 0 && (await overlay.isVisible().catch(() => false));
    if (!stillVisible) return;
    await page.waitForTimeout(300);
    if (i === 4) await page.keyboard.press('Escape').catch(() => {});
  }
  console.warn('   ⚠️ 引导遮罩仍在页面上（可能拦截后续点击）—— 检查 dismissOnboarding');
}

/**
 * 直读扩展 IndexedDB（db=tabvaultpro, store=kv）里的 tab_groups 全量（含墓碑与 lastOp 印记）。
 * 真实故障 throw；"记录尚未写入"返回 []（见文件头约定 2）。
 */
export const readLocalGroups = page => withTimeout(page.evaluate(async () => new Promise((resolve, reject) => {
  const r = indexedDB.open('tabvaultpro', 1);
  r.onerror = () => reject(new Error('IDB 打开失败'));
  r.onsuccess = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains('kv')) { db.close(); reject(new Error('IDB 缺少 kv store')); return; }
    const all = db.transaction('kv', 'readonly').objectStore('kv').getAll();
    all.onsuccess = () => {
      db.close();
      const entry = (all.result || []).find(v => v?.key === 'tab_groups');
      resolve(entry ? (entry.value || []) : []);
    };
    all.onerror = () => { db.close(); reject(new Error('IDB 读取 tab_groups 失败')); };
  };
})), 20000, 'readLocalGroups');

/** 读整个 kv store（用于 last_upload_time / last_sync_time / pending_upload 等标志位） */
export const readKvAll = page => withTimeout(page.evaluate(async () => new Promise((resolve, reject) => {
  const r = indexedDB.open('tabvaultpro', 1);
  r.onerror = () => reject(new Error('IDB 打开失败'));
  r.onsuccess = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains('kv')) { db.close(); resolve([]); return; }
    const all = db.transaction('kv', 'readonly').objectStore('kv').getAll();
    all.onsuccess = () => { db.close(); resolve(all.result || []); };
    all.onerror = () => { db.close(); reject(new Error('IDB 读取 kv 失败')); };
  };
})), 20000, 'readKvAll');

export const kvValue = (entries, key) => entries.find(e => e?.key === key)?.value ?? null;

/**
 * 在 **Service Worker 上下文**里执行代码（不挂载 popup）。
 *
 * 为什么必须这样读：popup 每次挂载只要检测到已登录就会自动发一次 download
 * （src/components/app/AuthProvider.tsx 的 sendSyncCommand('download')）。
 * 用「重开 popup 后数据变多」判断后台同步，会被这个自动下载冒充 ——
 * 只有 SW 上下文读取不会触发任何同步，才能干净地判定「后台 alarm 真的跑过」。
 */
export async function swEval(ctx, fn, arg) {
  const sw = ctx.serviceWorkers()[0];
  if (!sw) throw new Error('未找到扩展 service worker 上下文');
  return sw.evaluate(fn, arg);
}

/** 从 SW 上下文读 tab_groups（与 readLocalGroups 同源，但不触发 popup 挂载） */
export const readGroupsFromSW = ctx => withTimeout(swEval(ctx, async () => new Promise((resolve, reject) => {
  const r = indexedDB.open('tabvaultpro', 1);
  r.onerror = () => reject(new Error('IDB 打开失败'));
  r.onsuccess = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains('kv')) { db.close(); resolve([]); return; }
    const all = db.transaction('kv', 'readonly').objectStore('kv').getAll();
    all.onsuccess = () => {
      db.close();
      const e = (all.result || []).find(v => v?.key === 'tab_groups');
      resolve(e ? (e.value || []) : []);
    };
    all.onerror = () => { db.close(); reject(new Error('IDB 读取失败')); };
  };
})), 20000, 'readGroupsFromSW');

/** 从 SW 上下文读标志位（last_sync_time / pending_upload 等） */
export const readKvFromSW = ctx => withTimeout(swEval(ctx, async () => new Promise((resolve, reject) => {
  const r = indexedDB.open('tabvaultpro', 1);
  r.onerror = () => reject(new Error('IDB 打开失败'));
  r.onsuccess = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains('kv')) { db.close(); resolve([]); return; }
    const all = db.transaction('kv', 'readonly').objectStore('kv').getAll();
    all.onsuccess = () => { db.close(); resolve(all.result || []); };
    all.onerror = () => { db.close(); reject(new Error('IDB 读取失败')); };
  };
})), 20000, 'readKvFromSW');

/** UI：手动上传（预览弹窗 → 合并模式） */
export async function manualUpload(page, settleMs = 5000) {
  await page.click('button[title="手动上传本地会话到云端"]', { timeout: 20_000 });
  await page.waitForSelector('.fixed h3:has-text("上传到云端")', { timeout: 20_000 });
  await page.locator('.fixed h4:has-text("合并模式"), .fixed h4:has-text("覆盖模式")').first().click({ timeout: 20_000 });
  await page.waitForTimeout(settleMs);
}

/** UI：手动下载（预览弹窗 → 合并模式） */
export async function manualDownload(page, settleMs = 5000) {
  await page.click('button[title="手动从云端下载会话到本地"]', { timeout: 20_000 });
  await page.waitForSelector('.fixed h3:has-text("下载到本地")', { timeout: 20_000 });
  await page.locator('.fixed h4:has-text("合并模式"), .fixed h4:has-text("覆盖模式")').first().click({ timeout: 20_000 });
  await page.waitForTimeout(settleMs);
}

/**
 * 下载到本地满足条件为止（轮询，替代固定 sleep）。
 * 返回 { groups, attempts, downloaded }，downloaded 依据 last_sync_time 是否前进判断。
 */
export async function downloadUntil(page, pred, label, { attempts = 3, gapMs = 1500 } = {}) {
  let downloaded = false;
  for (let i = 0; i < attempts; i++) {
    const before = kvValue(await readKvAll(page), 'last_sync_time');
    await manualDownload(page);
    const after = kvValue(await readKvAll(page), 'last_sync_time');
    downloaded = Boolean(after) && after !== before;
    const groups = await readLocalGroups(page);
    if (pred(groups)) return { groups, attempts: i + 1, downloaded };
    console.log(`   ...第 ${i + 1} 次下载后未满足「${label}」（下载执行=${downloaded}），重试`);
    await page.waitForTimeout(gapMs);
  }
  return { groups: await readLocalGroups(page), attempts, downloaded };
}

/** 等过 35s 上传保护窗口，避免下载被 decideDownloadPrecheck 静默 skip（约定 3） */
export async function waitOutUploadGuard(page, gapMs = 36_000) {
  const lastUpload = kvValue(await readKvAll(page), 'last_upload_time');
  if (!lastUpload) return;
  const age = Date.now() - new Date(lastUpload).getTime();
  if (age >= 0 && age < gapMs) {
    const wait = gapMs - age + 1000;
    console.log(`   ...距上次上传 ${(age / 1000).toFixed(0)}s，等 ${(wait / 1000).toFixed(0)}s 越过上传保护窗口`);
    await page.waitForTimeout(wait);
  }
}

/** 起一个本地站点，每次访问返回唯一标题的页面（用于"保存当前窗口"造数据） */
export async function startContentSite(prefix = 'E2E-标签') {
  let n = 0;
  const server = createServer((_req, res) => {
    n += 1;
    const title = `${prefix}-${n}`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${title}</title><h1>${title}</h1>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/** 打开 popup 页面（含引导遮罩处理） */
export async function openPopup(ctx, id, { waitMs = 1500 } = {}) {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/src/popup/index.html`);
  await page.waitForTimeout(waitMs);
  await dismissOnboarding(page);
  return page;
}

/**
 * 在扩展管理页所在的同一 Chrome 窗口创建内容标签。
 *
 * Playwright 的 ctx.newPage() 在部分 Chromium/窗口管理器组合下会创建到新窗口，
 * 导致产品保存逻辑的 chrome.tabs.query({ currentWindow: true }) 看不到测试标签，
 * 最终保存 0 个页面。这里显式使用 popup 页的 windowId，保证测试造数符合真实使用场景。
 */
export async function openTabsInSameWindow(popupPage, urls) {
  const windowId = await popupPage.evaluate(async () => {
    const current = await chrome.tabs.getCurrent();
    return current?.windowId;
  });
  if (typeof windowId !== 'number') {
    throw new Error('无法获取扩展管理页所在窗口');
  }

  const pages = [];
  for (const url of urls) {
    const pagePromise = popupPage.context().waitForEvent('page');
    await popupPage.evaluate(
      ({ targetUrl, targetWindowId }) =>
        chrome.tabs.create({ url: targetUrl, windowId: targetWindowId, active: false }),
      { targetUrl: url, targetWindowId: windowId }
    );
    const page = await pagePromise;
    await page.waitForLoadState('domcontentloaded');
    pages.push(page);
  }
  return pages;
}

/**
 * 登录（register=true 时注册）。超时统一 40s（冷启动抖动）。
 * 注意登录/注册表单的密码占位符不同：注册是「请输入密码」，登录是「请输入您的密码」。
 */
export async function login(page, email, password, { register = false } = {}) {
  await dismissOnboarding(page);
  await page.click('button[aria-label="菜单"]', { timeout: LOGIN_TIMEOUT_MS });
  await page.click('button:has-text("登录 / 注册")', { timeout: 20_000 });
  await page.waitForSelector('text=注册', { timeout: 20_000 });
  if (register) await page.click('.fixed button:has-text("注册")', { timeout: 20_000 });
  await page.fill('input[placeholder="请输入您的邮箱"]', email);
  await page.fill(
    register ? 'input[placeholder="请输入密码"]' : 'input[placeholder="请输入您的密码"]',
    password
  );
  if (register) await page.fill('input[placeholder="请再次输入密码"]', password);
  await page.click('button[type="submit"]');
  await page.waitForSelector('button[title="手动上传本地会话到云端"]', { timeout: LOGIN_TIMEOUT_MS });
  await page.waitForTimeout(2000); // 等登录后的初始化流程（自动下载/加载会话）收敛
}
