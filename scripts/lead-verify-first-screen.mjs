// 真机验证：popup 首屏瘦身（2026-10-23）。
//
// ── 为什么要真机 ────────────────────────────────────────────────────────
//
// 体积数字只能证明「产物里有多少字节」，证明不了「用户点开弹窗时
// 浏览器**什么时候**下载它们、**首屏有没有被它们挡住**」。
//
// 这次改造的核心手段是**把依赖从静态改成动态**（`await import()`）。
// 静态改动态这件事，单元测试与体积门都看不见它的**运行时**后果：
//   · 动态 import 在 MV3 模块化 Service Worker 里到底能不能跑
//     （本仓 2026-10-14 踩过一次：动态 import 在 SW 里抛
//      `document is not defined`，症状与「根本没修」一模一样）；
//   · 首屏是不是真的**先渲染、后补登录态**（而不是反过来）；
//   · 懒加载的模块**最终**有没有被加载（不然就是「把功能删了换体积」）。
//
// 所以下面六条判据全部在**真 Chrome + 真扩展**里跑：
//   ① 首屏真的渲染出了会话列表（功能没被改坏）；
//   ② **渲染阻塞集**里没有同步栈（首屏不再被云端栈挡住）；
//   ③ 首帧之前真正下载了多少字节（真机口径，不靠 gzip 估算）；
//   ④ 同步栈**最终**确实被下载了（证明是「延后」不是「删掉」）；
//   ⑤ Service Worker 侧的动态 import 还能跑（SYNC 消息拿得到结构化响应，
//      且没有 `document is not defined` 这类模块加载错误）；
//   ⑥ 登录 / 撤销两条用户路径仍然有明确结果（不是静默失败）。
//
// ── 为什么用 CDP 而不是页面内的 performance API ────────────────────────
// 页面内的 `performance.getEntriesByType('resource')` 在
// `chrome-extension://` 页面里**是空的**（实测 resourceCount = 0），
// 所以「哪些字节在首帧前下载的」根本测不出来。
// 改用 CDP：`Network.requestWillBeSent` / `Network.responseReceived`
// 给出请求与响应，`Page.lifecycleEvent` 给出 firstContentfulPaint ——
// 两者**同一个时钟**（MonotonicTime），可以直接比先后。
//
// 产出：outputs/lead-verify-first-screen/*.png + 一份 JSON 报告。

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/lead-verify-first-screen');
const now = Date.now();
const iso = ms => new Date(ms).toISOString();

/**
 * 怎么认出「同步栈」的那几块？
 *
 * 不能靠文件名（Rollup 起的名字会随代码变），也不能靠 chunk 名里
 * 'supabase'/'adapter' 这种子串（太松，会误伤）。
 *
 * 靠**内容标记**：SDK 那一块里必然有 auth-js 的端点路径 `auth/v1`；
 * WebDAV 传输那一块里必然有 `PROPFIND`（WebDAV 的方法名，
 * 只有 webdav/client.ts 用得到）。这两个标记都来自**依赖库自己的字面量**，
 * 不会因为我们改代码而漂移。
 */
const SUPABASE_SDK_MARKER = 'auth/v1';
const WEBDAV_MARKER = 'PROPFIND';

/** 在 dist 里扫出「哪些产物文件是同步栈」。构建后跑，标记命中即算。 */
function classifyDistChunks() {
  const sdk = [];
  const webdav = [];
  for (const f of readdirSync(DIST)) {
    if (!f.endsWith('.js')) continue;
    const src = readFileSync(join(DIST, f), 'utf8');
    if (src.includes(SUPABASE_SDK_MARKER)) sdk.push(f);
    if (src.includes(WEBDAV_MARKER)) webdav.push(f);
  }
  return { sdk, webdav };
}

/**
 * 首屏的**渲染阻塞集** = 构建出来的 popup HTML 里那些 modulepreload / script 引用。
 *
 * 这与 scripts/report-bundle-size.mjs 量的是同一份 HTML ⇒
 * 「体积门说首屏多大」与「真机说首屏阻塞哪些请求」是同一个口径，
 * 不会出现「门里算 175KB、真机下载 260KB」这种两套口径。
 */
function readFirstScreenManifest() {
  const html = readFileSync(join(DIST, 'src/popup/index.html'), 'utf8');
  return [...html.matchAll(/(?:href|src)="([^"]+\.js)"/g)].map(m =>
    (m[1].split('/').pop() || '').split('?')[0]
  );
}

function tab(groupId, url, title) {
  return {
    id: crypto.randomUUID(),
    url,
    title,
    favicon: '',
    createdAt: iso(now - 3600e3),
    lastAccessed: iso(now - 3600e3),
    group_id: groupId,
    pinned: false,
  };
}

function group(name, tabs) {
  const id = crypto.randomUUID();
  return {
    id,
    name,
    notes: '',
    isFavorite: false,
    isLocked: false,
    isDeleted: false,
    tabs: tabs.map(([url, title]) => tab(id, url, title)),
    createdAt: iso(now - 7200e3),
    updatedAt: iso(now - 3600e3),
    version: 1,
    displayOrder: 1,
    lastOp: { d: 'verify-device', s: 1 },
  };
}

const groups = [
  group('首屏瘦身验证会话', [
    ['https://example.com/alpha', 'Alpha 页面'],
    ['https://example.com/beta', 'Beta 页面'],
  ]),
];

async function injectGroups(page, data) {
  await page.evaluate(async rows => {
    await new Promise((res, rej) => {
      const req = indexedDB.open('tabvaultpro', 1);
      req.onerror = () => rej(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ key: 'tab_groups', value: rows });
        tx.oncomplete = () => { db.close(); res(); };
        tx.onerror = () => { db.close(); rej(tx.error); };
      };
    });
  }, data);
}

async function launchWithExtension(profile) {
  const args = [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    '--no-first-run',
    '--lang=zh-CN',
  ];
  const opts = { headless: false, args, viewport: { width: 1440, height: 900 } };
  try {
    return await chromium.launchPersistentContext(profile, opts);
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (!/Executable doesn't exist/i.test(msg)) throw err;
    console.error('[提示] Playwright 自带的 Chromium 没装，改用系统 Chrome。');
    return await chromium.launchPersistentContext(profile, { ...opts, channel: 'chrome' });
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const distChunks = classifyDistChunks();
  const firstScreenFiles = readFirstScreenManifest();
  console.log('[产物分类] Supabase SDK 块：', distChunks.sdk.join(', ') || '(无)');
  console.log('[产物分类] WebDAV 传输块：', distChunks.webdav.join(', ') || '(无)');
  console.log('[首屏清单] 渲染阻塞集：', firstScreenFiles.join(', '));

  const profile = mkdtempSync(join(tmpdir(), 'tapstack-first-screen-'));
  const ctx = await launchWithExtension(profile);
  const problems = [];
  const report = { distChunks, firstScreenFiles, steps: [] };
  try {
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await new Promise(r => setTimeout(r, 500));
    }
    if (!sw) throw new Error('扩展的 service worker 没有起来');
    const id = new URL(sw.url()).host;

    const page = await ctx.newPage();
    const consoleErrors = [];
    const swErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));
    const attachSw = worker => {
      worker.on('console', m => { if (m.type() === 'error') swErrors.push(m.text()); });
      worker.on('close', () => { swErrors.push('service worker 被关闭了'); });
    };
    attachSw(sw);
    ctx.on('serviceworker', worker => attachSw(worker));

    // ── CDP：请求 / 响应 / 绘制事件（同一个时钟，可直接比先后）──────────
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true });
    const requests = [];
    const responses = [];
    const finished = [];
    const lifecycle = [];
    cdp.on('Network.requestWillBeSent', e => {
      requests.push({
        id: e.requestId,
        url: e.request.url,
        ts: e.timestamp,
        frameId: e.frameId ?? '',
        loaderId: e.loaderId ?? '',
        type: e.type ?? '',
      });
    });
    cdp.on('Network.responseReceived', e => {
      responses.push({
        id: e.requestId,
        url: e.response.url,
        ts: e.timestamp,
        bytes: e.response.encodedDataLength,
      });
    });
    // ⚠️ 字节数要用 loadingFinished 的 encodedDataLength：
    // responseReceived 里的那个只算**响应头**，不含 body（本地文件也是 0）。
    cdp.on('Network.loadingFinished', e => {
      finished.push({ id: e.requestId, bytes: e.encodedDataLength, ts: e.timestamp });
    });
    cdp.on('Page.lifecycleEvent', e => lifecycle.push({ name: e.name, ts: e.timestamp }));

    await page.goto(`chrome-extension://${id}/src/popup/index.html`);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
    await injectGroups(page, groups);
    await page.reload();

    // ── 判据 ①：首屏真的渲染出了会话列表 ──────────────────────────────
    await page.waitForSelector('text=首屏瘦身验证会话', { timeout: 20000 });
    await page.waitForTimeout(1500);
    const rendered = await page.locator('text=首屏瘦身验证会话').first().isVisible();
    if (!rendered) problems.push('① 会话列表没渲染出来 —— 首屏被改坏了');
    report.steps.push({ step: '① 会话列表已渲染', rendered });
    await page.screenshot({ path: join(OUT_DIR, '01-popup-rendered.png') });

    // ── 判据 ②③④：请求时间线（CDP 口径）──────────────────────────────
    const fileOf = url => ((url || '').split('/').pop() || '').split('?')[0];
    const sdkFiles = new Set(distChunks.sdk);
    const webdavFiles = new Set(distChunks.webdav);
    const syncFiles = new Set([...sdkFiles, ...webdavFiles]);
    const staticFiles = new Set(firstScreenFiles);
    const fcpEvent = lifecycle.filter(e => e.name === 'firstContentfulPaint').pop();
    const fcp = fcpEvent ? fcpEvent.ts : null;
    // 只看**最后一次导航**（脚本为了注入数据 reload 过一次）：
    // 上一轮的请求混进来会让「谁先谁后」的比较失真。
    const navTs = requests
      .filter(r => r.type === 'Document')
      .reduce((n, r) => Math.max(n, r.ts), 0);
    const requestsOfLastLoad = requests.filter(r => r.ts >= navTs);

    // ②a 渲染阻塞集里没有同步栈（与体积门同一份 HTML）
    const inStatic = [...syncFiles].filter(f => staticFiles.has(f));
    if (inStatic.length) {
      problems.push(
        `② 渲染阻塞集里就有同步栈：${inStatic.join(', ')} —— 首屏仍然被云端栈挡住`,
      );
    }
    // ②b 真机口径：同步栈的请求必须**晚于**首屏静态清单的请求
    //    （晚 = 由应用自己的动态 import 触发，而不是被 modulepreload 拖着一起下）
    const staticReqs = requestsOfLastLoad.filter(r => staticFiles.has(fileOf(r.url)));
    const lastStaticTs = staticReqs.length ? Math.max(...staticReqs.map(r => r.ts)) : -1;
    const earlySync = requestsOfLastLoad.filter(
      r => syncFiles.has(fileOf(r.url)) && lastStaticTs >= 0 && r.ts <= lastStaticTs
    );
    if (earlySync.length) {
      problems.push(
        `② 同步栈与首屏静态清单同时被请求：${earlySync.map(r => fileOf(r.url)).join(', ')} —— ` +
          '懒加载没生效（它们本该在应用挂载后才被动态 import 触发）',
      );
    }
    report.steps.push({
      step: '② 渲染阻塞集里没有同步栈',
      staticFiles: [...staticFiles],
      syncFiles: [...syncFiles],
      syncRequested: requestsOfLastLoad.filter(r => syncFiles.has(fileOf(r.url))).map(r => ({
        file: fileOf(r.url),
        afterStatic: lastStaticTs >= 0 ? r.ts > lastStaticTs : null,
      })),
      // 全量请求时间线（排查用：谁在什么时候被拉下来；相对首帧，毫秒）
      timeline: requestsOfLastLoad.map(r => ({
        file: fileOf(r.url),
        ts: Math.round((r.ts - (fcpEvent ? fcpEvent.ts : 0)) * 1000),
        type: r.type,
      })),
      fcpTs: fcpEvent ? fcpEvent.ts : null,
      lastStaticTs,
    });

    // ── 判据 ③：首帧之前真正下载了多少字节 ────────────────────────────
    //
    // 「首帧之前下载的字节」= **请求**发生在首帧之前的那些资源的大小
    // （首帧必然晚于渲染阻塞资源加载完 ⇒ 用响应时间比会永远是 0）。
    const reqById = new Map(requests.map(r => [r.id, r]));
    const bytesById = new Map(finished.map(f => [f.id, f.bytes]));
    const urlById = new Map(responses.map(r => [r.id, r.url]));
    const loadOf = id => ({
      file: fileOf(urlById.get(id) ?? reqById.get(id)?.url ?? ''),
      ts: reqById.get(id)?.ts ?? 0,
      bytes: bytesById.get(id) ?? 0,
    });
    const loads = finished
      .filter(f => (reqById.get(f.id)?.ts ?? 0) >= navTs)
      .map(f => loadOf(f.id));
    if (fcp === null) {
      problems.push('② 拿不到 first-contentful-paint —— 判据无法成立（测量失效，不是产品缺陷）');
    }
    const beforeFcp = loads.filter(r => fcp !== null && r.ts < fcp);
    const bytesBeforeFcp = beforeFcp.reduce((n, r) => n + (r.bytes || 0), 0);
    const staticBytes = loads
      .filter(r => staticFiles.has(r.file))
      .reduce((n, r) => n + (r.bytes || 0), 0);
    report.steps.push({
      step: '③ 首屏字节（真机口径）',
      // 渲染阻塞集 = HTML 里 modulepreload 清单的那些 = 首帧必须等的东西。
      renderBlockingBytes: staticBytes,
      renderBlockingKB: Math.round((staticBytes / 1024) * 10) / 10,
      // 「首帧之前被请求的字节」还包含挂载后那一波（SDK 是其中最大的一块）。
      // 它**不阻塞**首帧（动态 import 不是渲染阻塞脚本），但确实在首帧事件
      // 之前就发出了请求 —— 因为首帧本身要 ~90ms，而登录态检查在挂载后就启动了。
      requestedBeforeFcpBytes: bytesBeforeFcp,
      requestedBeforeFcpKB: Math.round((bytesBeforeFcp / 1024) * 10) / 10,
      beforeFcp: beforeFcp.map(r => ({ file: r.file, bytes: r.bytes })),
      inPagePaint: await page.evaluate(() =>
        performance.getEntriesByType('paint').map(p => ({ name: p.name, ms: Math.round(p.startTime) }))
      ),
    });

    // ── 判据 ④：同步栈**最终**确实被下载了（延后 ≠ 删掉）──────────────
    const syncLoaded = requestsOfLastLoad.filter(r => syncFiles.has(fileOf(r.url)));
    if (syncLoaded.length === 0) {
      problems.push(
        '④ 同步栈**始终没有**被下载 —— 这不是「延后加载」，是把功能删了换体积。' +
          '（登录态检查必须真的跑起来）',
      );
    }
    report.steps.push({
      step: '④ 同步栈最终被加载（延后而非删除）',
      loaded: syncLoaded.map(r => ({ file: fileOf(r.url), ts: r.ts })),
    });

    // ── 判据 ⑤：SW 侧的动态 import 还能跑 ────────────────────────────
    //
    // 为什么这条最要紧：2026-10-14 踩过一次「动态 import 在 SW 里抛
    // `document is not defined`」⇒ 症状与「根本没修」一模一样，
    // 从症状上不可区分。所以这里**主动**走一条会经过动态 import 的路：
    // SYNC download → syncEngine → tabGroupSyncService → `await import('@/sync-backend')`。
    const swResult = await page.evaluate(async () => {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'SYNC', data: { op: 'download' } });
        return { ok: true, res };
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    });
    if (!swResult.ok) {
      problems.push(`⑤ SW 消息通道失败：${swResult.error} —— SW 可能没起来`);
    } else if (!swResult.res || typeof swResult.res !== 'object') {
      problems.push(`⑤ SW 的 SYNC 回包不是结构化结果：${JSON.stringify(swResult.res)}`);
    }
    const swModuleErrors = [...swErrors, ...consoleErrors].filter(t =>
      /document is not defined|Failed to fetch dynamically imported module|Importing a module script failed|Cannot use import statement/i.test(t)
    );
    if (swModuleErrors.length) {
      problems.push(`⑤ 出现模块加载错误：${swModuleErrors.slice(0, 3).join(' | ')}`);
    }
    report.steps.push({
      step: '⑤ SW 侧动态 import 可用',
      swResult,
      swErrors: swErrors.slice(0, 5),
      moduleErrors: swModuleErrors,
    });

    // ── 判据 ⑥a：登录路径（懒加载的 facade 真跑了）────────────────────
    //
    // 走真实表单提交：一次无效登录 ⇒ Supabase 返回 "Invalid login credentials"
    // ⇒ 界面必须显示**中文**。显示中文 = SDK 真的加载并跑完了、
    // 错误翻译链路没坏；显示 "document is not defined" = 懒加载炸了。
    //
    // 入口在**右上角菜单**里（文案「去登录」），不在空态里 ——
    // 空态那条路在这个场景里不成立（我们注入了会话，列表非空）。
    const menuBtn = page.locator('[data-menu-trigger]').first();
    let loginCopy = '';
    if (await menuBtn.isVisible().catch(() => false)) {
      await menuBtn.click();
      const loginItem = page.locator('button[role="menuitem"]', { hasText: '去登录' }).first();
      const itemVisible = await loginItem
        .waitFor({ state: 'visible', timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      if (!itemVisible) {
        problems.push('⑥a 菜单里找不到「去登录」—— 判据无法成立');
      } else {
        await loginItem.click();
        const email = page.locator('input[type="email"]').first();
        const pwd = page.locator('input[type="password"]').first();
        if (await email.isVisible().catch(() => false)) {
          await email.fill(`first-screen-probe-${Date.now()}@example.invalid`);
          // 密码必须**通过前端的复杂度校验**（大小写/数字/特殊字符至少 3 类），
          // 否则请求根本发不出去 ⇒ 测到的是「表单校验」而不是「后端拒绝」。
          await pwd.fill('Probe-Passw0rd!2026');
          await pwd.press('Enter');
          await page.waitForTimeout(6000);
          loginCopy = await page.evaluate(() => {
            // 错误提示挂在登录弹窗（role=dialog）里，标题固定是「登录失败」。
            // 为什么不按 class 找：错误提示的样式来自主题（tone 映射），
            // 按 class 名找会随主题改动而失效 ⇒ 判据自己先坏掉。
            const dialog = document.querySelector('[role="dialog"]');
            const text = (dialog?.textContent || '').replace(/\s+/g, ' ').trim();
            const m = text.match(/登录失败[^登]*/);
            return m ? m[0].slice(0, 120) : '';
          });
          if (!loginCopy) {
            problems.push('⑥a 登录提交后界面上没有任何提示 —— 错误链路没走到用户');
          } else if (!/[一-鿿]/.test(loginCopy)) {
            problems.push(`⑥a 登录提示不是中文：${loginCopy} —— 错误翻译链路可能没跑（懒加载炸了？）`);
          }
        } else {
          problems.push('⑥a 登录弹窗里找不到邮箱输入框 —— 判据无法成立');
        }
      }
    } else {
      problems.push('⑥a 找不到右上角菜单按钮 —— 判据无法成立');
    }
    report.steps.push({ step: '⑥a 登录路径有明确的中文结果', loginCopy });
    await page.screenshot({ path: join(OUT_DIR, '02-login-result.png') });
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);

    // ── 判据 ⑥b：撤销仍然够得着（回归烟测）──────────────────────────
    // 消费一条标签 ⇒ 「撤销」按钮必须出现。
    const alpha = page.locator('text=Alpha 页面').first();
    let undoVisible = false;
    if (await alpha.isVisible().catch(() => false)) {
      await alpha.click();
      await page.waitForTimeout(800);
      undoVisible = await page.locator('button', { hasText: '撤销' }).first().isVisible().catch(() => false);
      if (!undoVisible) {
        problems.push('⑥b 消费之后看不到「撤销」按钮 —— 撤销路径被改坏了');
      }
    } else {
      problems.push('⑥b 找不到标签行 —— 判据无法成立');
    }
    report.steps.push({ step: '⑥b 撤销按钮出现', undoVisible });
    await page.screenshot({ path: join(OUT_DIR, '03-undo-toast.png') });

    // 只把「与本次改造有关」的报错算问题。
    //
    // ��两条是**环境现状**，不是回归：
    //   · 402 / egress_quota：生产 Supabase 项目当前被配额封禁
    //     （仓库 .memory 有记录：提审前必须先探一次生产库）
    //     ⇒ 登录请求必然被服务端拒绝。
    //   · 「登录失败 / 登录异常」：本次探针**故意**提交一次无效登录 ⇒
    //     失败是预期结果（判据 ⑥a 要的正是「失败被翻译成中文并显示出来」）。
    const EXPECTED_NOISE = /402|egress_quota|登录失败|登录异常|Invalid login credentials/i;
    const realErrors = consoleErrors.filter(
      t => !/favicon|ERR_FILE_NOT_FOUND/i.test(t) && !EXPECTED_NOISE.test(t)
    );
    if (realErrors.length) {
      problems.push(`控制台报错 ${realErrors.length} 条：${realErrors.slice(0, 3).join(' | ')}`);
    }
    report.consoleErrors = realErrors.slice(0, 10);

    writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify({ problems, ...report }, null, 2));
    console.log(JSON.stringify({
      problems,
      renderBlockingKB: report.steps.find(s => s.step.startsWith('③'))?.renderBlockingKB,
      requestedBeforeFcpKB: report.steps.find(s => s.step.startsWith('③'))?.requestedBeforeFcpKB,
      inPagePaint: report.steps.find(s => s.step.startsWith('③'))?.inPagePaint,
      syncRequestedAt: report.steps.find(s => s.step.startsWith('②'))?.syncRequested,
    }, null, 2));
    if (problems.length) process.exitCode = 1;
  } finally {
    await ctx.close();
  }
}

main().catch(err => {
  console.error('验证脚本失败：', err);
  process.exit(1);
});
