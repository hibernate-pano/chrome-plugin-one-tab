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
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * 启动一个加载扩展的持久化上下文（每个 ctx = 一台"设备"）。
 * @param label 设备/用途标签，仅用于临时 profile 目录命名
 * @param dist  要加载的扩展目录；默认 dist/，WebDAV 真机脚本传 prepareDavDist() 的返回值
 */
export function launchCtx(label, dist = DIST) {
  const dir = mkdtempSync(join(tmpdir(), `tapstack-${label}-`));
  return chromium.launchPersistentContext(dir, {
    headless: false,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-first-run'],
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
  await page.locator('.fixed h4:has-text("合并模式")').first().click({ timeout: 20_000 });
  await page.waitForTimeout(settleMs);
}

/** UI：手动下载（预览弹窗 → 合并模式） */
export async function manualDownload(page, settleMs = 5000) {
  await page.click('button[title="手动从云端下载会话到本地"]', { timeout: 20_000 });
  await page.waitForSelector('.fixed h3:has-text("下载到本地")', { timeout: 20_000 });
  await page.locator('.fixed h4:has-text("合并模式")').first().click({ timeout: 20_000 });
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
 * ☠️ 已失效：账号体系已删除，不要再 import 这个函数。
 *
 * 2026-10-16 Supabase 下线时，src 里的登录/注册 UI 整块删除；本函数点的
 * `button:has-text("登录 / 注册")` 全仓已无处渲染，调用它只会在 20s 超时后失败。
 * 保留函数体是为了留痕：任何 ORDER 里登记的脚本若还 import `login`，
 * scripts/run-e2e.mjs 的登记表门禁（findDeadLoginImports）会直接判失败。
 * 需要账号的旧脚本已在同一批删除；WebDAV 脚本请改用 seedWebDav()。
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

// ─────────────────────────────────────────────────────────────────────────
// WebDAV 真机 e2e 支撑（2026-10-16 账号体系删除后新建）
//
// 这一段替代原来的「注册/登录 + Supabase 账号」：本地 dufs 当云盘，配置与会话
// 凭据直接种进解析层真正读取的位置（storage-kv / chrome.storage.session），
// 然后照常驱动真实扩展 UI 上传/下载。只有两处是测试专用适配，且各自有理由：
//
//   1) 【必须拷贝 dist 并补 host_permissions】真机上 WebDAV 走
//      optional_host_permissions，必须由用户在权限气泡里点「允许」。无人值守
//      下点不了（scripts/e2e-webdav-lock.mjs 记录过第一版挂死在这里），所以
//      prepareDavDist() 复制一份 dist，把回环地址提升为**必选** host 权限。
//      这改变了权限声明，不改变任何业务代码；权限声明本身由
//      scripts/e2e-webdav-permission.mjs 对**原版 dist** 单独验证 —— 两边
//      各测各的，不相互冒充。
//   2) 【直接种配置】而不是走设置页表单。设置页走的是受控输入 + 权限申请，
//      时序脆弱且同样会弹权限气泡；种到解析层读取的位置后回读证明「种对了」
//      （.memory/e2e-assertion-must-distinguish-failure-modes.md 的纪律）。
//
// 测试结束后脚本必须调用 davDist 的 rmSync 与 dufs.stop()，避免残留进程/临时目录。
// ─────────────────────────────────────────────────────────────────────────

/**
 * 复制 dist 为「WebDAV e2e 专用构建」：只改 manifest 的 host_permissions，
 * 把回环地址从可选提升为必选（原因见上方段落 1）。
 * @returns 临时 dist 目录，调用方负责在 finally 里 rmSync 掉。
 */
export function prepareDavDist() {
  const dir = mkdtempSync(join(tmpdir(), 'tapstack-dav-dist-'));
  cpSync(DIST, dir, { recursive: true });
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const loopback = ['http://127.0.0.1/*', 'http://localhost/*'];
  manifest.host_permissions = Array.from(new Set([...(manifest.host_permissions || []), ...loopback]));
  manifest.optional_host_permissions = (manifest.optional_host_permissions || []).filter(
    p => !loopback.includes(p)
  );
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

/**
 * 起一个本地 dufs（真实 WebDAV 服务端，Rust 独立实现）当云盘。
 * `--allow-all` = 无鉴权；配置里的 username/password 只是满足客户端形状，
 * 本函数不校验它们。
 *
 * @returns { dir, port, origin, proc, stop() } —— stop() kill 进程、确认退出并删临时目录，
 *          返回是否确认退出（调用方应把它纳入脚本退出码，与仓库既有清理惯例一致）。
 */
export async function startDufs(label = 'dav') {
  const dir = mkdtempSync(join(tmpdir(), `tapstack-${label}-`));
  const port = 43000 + Math.floor(Math.random() * 5000);
  const origin = `http://127.0.0.1:${port}`;
  const proc = spawn('dufs', [dir, '--bind', '127.0.0.1', '--port', String(port), '--allow-all'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  proc.stdout.on('data', d => log.push(String(d)));
  proc.stderr.on('data', d => log.push(String(d)));
  let exitSeen = false;
  proc.on('exit', () => { exitSeen = true; });
  const hasExited = () => exitSeen || proc.exitCode !== null || proc.signalCode !== null;

  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) {
    await new Promise(r => setTimeout(r, 100));
    try {
      ready = (await fetch(origin, { method: 'OPTIONS' })).status > 0;
    } catch {
      /* 还没起来 */
    }
  }
  if (!ready) {
    proc.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`dufs 未在 5 秒内就绪：${log.join('').slice(-500)}`);
  }

  const stop = async () => {
    if (!hasExited()) {
      proc.kill('SIGTERM');
      for (let i = 0; i < 15 && !hasExited(); i++) await new Promise(r => setTimeout(r, 100));
      if (!hasExited()) proc.kill('SIGKILL');
      for (let i = 0; i < 15 && !hasExited(); i++) await new Promise(r => setTimeout(r, 100));
    }
    rmSync(dir, { recursive: true, force: true });
    return hasExited();
  };

  return { dir, port, origin, proc, stop };
}

/**
 * 把 WebDAV 配置 + 会话凭据种到**解析层真正读取的位置**，等价于用户走完
 * 「填地址 → 解锁」。必须在扩展页面（popup/options）上下文调用。
 *
 * @param page  扩展页面（任意一个都行：popup / options / 扩展内新页）
 * @param opts.origin    dufs 的 origin（无尾斜杠）
 * @param opts.autoSync  是否开启自动同步；开启时按 intervalMinutes 注册后台 alarm
 * @param opts.username/password/rootPath/passphrase  测试凭据；passphrase 非空才用 required 加密
 * @returns 回读结果 { backend, baseUrl, unlocked, syncEnabled }，供脚本断言「种对了」
 */
export async function seedWebDav(page, {
  origin,
  autoSync = false,
  intervalMinutes = 5,
  username = 'e2e-user',
  password = 'e2e-pass',
  rootPath = 'TapStack',
  passphrase = null,
} = {}) {
  if (!origin) throw new Error('seedWebDav 需要 origin');
  return withTimeout(page.evaluate(async args => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('tabvaultpro', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const existing = await new Promise((resolve, reject) => {
      const g = db.transaction('kv', 'readonly').objectStore('kv').get('user_settings');
      g.onsuccess = () => resolve(g.result?.value ?? null);
      g.onerror = () => reject(g.error);
    });
    const settings = {
      ...(existing && typeof existing === 'object' ? existing : {}),
      syncBackend: 'webdav',
      syncEnabled: args.autoSync,
      syncIntervalMinutes: args.intervalMinutes,
    };
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ key: 'user_settings', value: settings });
      tx.objectStore('kv').put({
        key: 'webdav_sync_config_v1',
        value: {
          baseUrl: args.origin + '/',
          username: args.username,
          rootPath: args.rootPath,
          encryption: args.passphrase ? 'required' : 'plain',
        },
      });
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    await chrome.storage.session.set({
      webdav_session_secrets_v1: {
        username: args.username,
        password: args.password,
        passphrase: args.passphrase,
      },
    });
    // 回读：证明种到的是解析层会读的那两处，而不是「看起来很像」的地方
    const back = await new Promise((resolve, reject) => {
      const req2 = indexedDB.open('tabvaultpro', 1);
      req2.onblocked = () => reject(new Error('回读 IndexedDB 被阻塞'));
      req2.onsuccess = () => {
        const db2 = req2.result;
        const g = db2.transaction('kv', 'readonly').objectStore('kv').getAll();
        g.onsuccess = () => {
          db2.close();
          const entries = g.result || [];
          const val = k => entries.find(e => e?.key === k)?.value ?? null;
          resolve({
            backend: val('user_settings')?.syncBackend ?? null,
            baseUrl: val('webdav_sync_config_v1')?.baseUrl ?? null,
            syncEnabled: val('user_settings')?.syncEnabled === true,
          });
        };
        g.onerror = () => { db2.close(); reject(g.error); };
      };
      req2.onerror = () => reject(req2.error);
    });
    const secrets = await chrome.storage.session.get('webdav_session_secrets_v1');
    return { ...back, unlocked: !!secrets?.webdav_session_secrets_v1?.password };
  }, { origin, autoSync, intervalMinutes, username, password, rootPath, passphrase }), 15000, 'seedWebDav');
}

/**
 * 通知 SW「设置变了，重新解析后端 + 重建 alarm」。
 * 必须做：popup/options 与 SW 是独立 JS 上下文，种配置不会自动刷新 SW 的
 * activeBackend 缓存（见 src/service-worker.ts 的 resyncAlarm 分支注释）。
 */
export async function resyncAlarm(page) {
  return page.evaluate(() => new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'SYNC', data: { op: 'resyncAlarm' } }, () =>
      resolve(chrome.runtime.lastError?.message ?? null)
    );
    setTimeout(() => resolve('TIMEOUT'), 10000);
  }));
}

/**
 * 提前触发后台同步 alarm（不是等用户档位：最小档位也是 5 分钟）。
 * chrome.alarms 最小延迟 0.5 分钟，实际约 30s 后触发；脚本随后轮询即可。
 * 用途：验证「popup 关闭时 alarm 驱动的同步确实执行」——测的是 onAlarm 处理链，
 * 不是「用户设置了 5 分钟所以 5 分钟后一定响」（后者是 Chrome 的职责）。
 */
export async function nudgeSyncAlarm(page) {
  return page.evaluate(() => chrome.alarms.create('tapstack-background-sync', { delayInMinutes: 0.5 }));
}

/** 轮询直到 predicate 为真或超时；返回最后一次的值。用于等 alarm 唤醒 SW 后落盘。 */
export async function pollUntil(fn, pred, { timeoutMs = 60_000, gapMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (pred(last)) return last;
    if (Date.now() >= deadline) return last;
    await new Promise(r => setTimeout(r, gapMs));
  }
}
