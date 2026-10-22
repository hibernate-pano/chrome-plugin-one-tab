// 真机验证：service worker 侧「我现在在哪个云端库」必须与页面侧一致（2026-10-23 审计 P0-1）。
//
// ── 这个缺陷的形状 ────────────────────────────────────────────────────────
//
// 「本机当前指向哪个云端库」这件事，本机有两处要算：
//   · 页面（设置页 / 弹窗）：`await import(...)` ⇒ 能加载后端模块 ⇒ 算得出真值；
//   · **Service Worker**：`import()` 被 Chrome 禁止（HTML 规范）⇒ 算不出来。
// 而「归属待决位」（这些会话归不归这个库）是**按库寻址**的（`storage-kv/firstSyncPendingRecord.ts`），
// 于是 SW 侧算不出库 ⇒ 落进「不知道是哪个库 ⇒ 只要有一格待决就算待决」的保守分支
// ⇒ **SW 永远以为归属决策没做完** ⇒ 自动上传被永久降级成「只传本次改动过的那几个」。
// 而页面侧算得出真值 ⇒ 界面显示「决策已完成」⇒ **两边对不上，且用户毫无提示**。
//
// 后果：**「上传被永久挡住」**（不是「该挡的没挡」）：本机的历史会话再也传不上用户自己的云盘，
// 而界面/回包还报「成功」。
//
// ── 为什么必须真机 ────────────────────────────────────────────────────────
//
// 这个缺陷在单测里是**看不出来**的：Node 的 `import()` 是合法的 ⇒ 单测里 SW 侧照样算得出真值。
// 只有真 Chrome 的 service worker 才会把 `import()` 拒掉。
// （同仓教训：memory「SW 启动即崩这一类缺陷」——Chrome 上不存在的行为不报类型错也不报 lint。）
//
// ── 这个脚本怎么测 ────────────────────────────────────────────────────────
//
// 摆一个**两个 realm 会给出不同答案**的现场：
//   · 磁盘上配好库 L（页面侧算得出 L）；
//   · 待决位记录 = { L: false（决策已完成）, 另一个库: true（历史遗留的待决格）}；
//     ⇒ 页面侧按 L 读 ⇒ 「决策已完成」；
//     ⇒ SW 侧若算不出库 ⇒ 保守分支 ⇒ 「还有一个库待决」⇒ 抑制全量上传。
//   · 本机有 1 个会话，且它**不在**「本次改动过的会话」白名单里（= 历史会话）。
//
// 然后跑两轮上传（同一个环境、同一份现场，只差一个标志）：
//   · 自动上传（用户没点「检查并推送」）：归属待决时**必须**只传白名单；
//   · 显式上传（`explicitFirstSync: true`，= 用户已确认归属）：**必须**走全量。
// 两轮的差别只来自「SW 算不算得出库」⇒ **两轮结果必须同形**。
// 若自动上传「成功」而显式上传「失败」，那说明自动上传**根本没碰到后端**（什么都没传），
// 而界面会把它当成功 ⇒ 这就是缺陷本身。
//
// 产出：outputs/lead-verify-sw-library-scope/report.json。
//
// 用法：pnpm build 之后 node scripts/lead-verify-sw-library-scope.mjs

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/lead-verify-sw-library-scope');
const ROOT = resolve(process.cwd());

/** 探针用的假库身份（假的域名，永远连不上 —— 我们要测的是「有没有去连」）。 */
const PROBE_BASE_URL = 'https://dav.probe.invalid/';
const PROBE_USERNAME = 'probe-user';
const PROBE_ROOT = 'TapStack';

/**
 * WebDAV 配置键（`src/sync-backend/webdav/config.ts` 里的模块私有常量）。
 *
 * 为什么在运行时从源码里取，而不是把字面量抄进脚本：
 *   · 抄一份 ⇒ 两份字面量必然漂移（改了源码，探针还在往老键里写 ⇒ 探针瞎了还不报错）；
 *   · 打印出来 ⇒ 凭据键名进了日志/报告。
 * 取法：读源码 → 正则取出常量 → 只在内存里用，**从不打印**。
 */
function webdavConfigKey() {
  const src = readFileSync(resolve(ROOT, 'src/sync-backend/webdav/config.ts'), 'utf8');
  const m = src.match(/const CONFIG_KEY = '([^']+)'/);
  if (!m) throw new Error('在 src/sync-backend/webdav/config.ts 里找不到 CONFIG_KEY');
  return m[1];
}

/** 库的「作用域键」：地址 | 账号 | 目录 三者任一变化 = 另一个库（见 libraryIdentity.ts）。 */
function scopeKeyOf(baseUrl, username, rootPath) {
  const url = new URL(baseUrl);
  let pathname = url.pathname || '/';
  if (!pathname.endsWith('/')) pathname += '/';
  const normalized = `${url.protocol}//${url.host}${pathname}`;
  const root = String(rootPath ?? '').trim().replace(/^\/+|\/+$/g, '');
  return JSON.stringify([normalized, String(username ?? '').trim(), root || 'TapStack']);
}

const LIB_SCOPE = scopeKeyOf(PROBE_BASE_URL, PROBE_USERNAME, PROBE_ROOT);
const OTHER_SCOPE = scopeKeyOf('https://other.probe.invalid/', 'other-user', 'TapStack');

/** 探针用的本地会话（形状对齐 TabGroup；放进去的是「历史会话」）。 */
const PROBE_GROUP = {
  id: 'probe-history-group',
  name: '探针历史会话',
  tabs: [
    {
      id: 'probe-history-tab',
      url: 'https://probe-history.invalid/page',
      title: '探针历史标签',
      createdAt: '2026-10-23T00:00:00.000Z',
      lastAccessed: '2026-10-23T00:00:00.000Z',
      pinned: false,
    },
  ],
  createdAt: '2026-10-23T00:00:00.000Z',
  updatedAt: '2026-10-23T00:00:00.000Z',
  isLocked: false,
  version: 1,
};

/** 把若干键值写进扩展的 KV（IndexedDB tabvaultpro / kv）。在 SW realm 里执行。 */
async function writeKv(sw, entries) {
  return await sw.evaluate(async items => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('tabvaultpro', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('indexedDB open blocked'));
    });
    try {
      if (!db.objectStoreNames.contains('kv')) throw new Error('KV store 不存在');
      await new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        const store = tx.objectStore('kv');
        for (const [key, value] of items) store.put({ key, value });
        tx.oncomplete = () => resolve(undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      return true;
    } finally {
      db.close();
    }
  }, entries);
}

/** 读 KV 里的若干键（SW realm）。 */
async function readKv(sw, keys) {
  return await sw.evaluate(async wanted => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('tabvaultpro', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const out = {};
      for (const key of wanted) {
        out[key] = await new Promise((resolve, reject) => {
          const tx = db.transaction('kv', 'readonly');
          const req = tx.objectStore('kv').get(key);
          req.onsuccess = () => resolve(req.result ? req.result.value : undefined);
          req.onerror = () => reject(req.error);
        });
      }
      return out;
    } finally {
      db.close();
    }
  }, keys);
}

/** 页面侧发一条 SW 消息并等回包。 */
async function sendSync(page, data) {
  return await page.evaluate(async payload => {
    try {
      return await chrome.runtime.sendMessage({ type: 'SYNC', data: payload });
    } catch (e) {
      return { ok: false, error: `消息失败：${e?.message ?? e}` };
    }
  }, data);
}

/**
 * 在一个 realm 里算出「本机当前指向哪个库」。
 *
 * 为什么写得这么绕：构建产物的模块导出名**会被压缩**（Vite 会把
 * `export{... as a}` 里的公开名也一起压掉，只在模块命名空间对象上保留原名），
 * 所以不能假设 `m.currentLibraryScope` 一定在 ⇒ 改成在命名空间里**找**
 * 那个提供 `currentLibraryScope` 的对象（找不到就如实说找不到）。
 */
const PICK_NS = `
  function pick(m) {
    if (typeof m?.currentLibraryScope === 'function') return m;
    for (const v of Object.values(m ?? {})) {
      if (v && typeof v === 'object' && typeof v.currentLibraryScope === 'function') return v;
    }
    return null;
  }
`;

/** 在某个 realm（页面或 SW）里读出库作用域。 */
async function readScopeInPage(page, chunk) {
  return await page.evaluate(
    async ({ chunkName, pickSrc }) => {
      const pick = new Function(`${pickSrc}\nreturn pick;`)();
      try {
        const m = await import(chrome.runtime.getURL(chunkName));
        const ns = pick(m);
        if (!ns) return { ok: false, error: '构建产物里找不到 currentLibraryScope' };
        return { ok: true, scope: await ns.currentLibraryScope() };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    },
    { chunkName: chunk, pickSrc: PICK_NS }
  );
}

/** 在 SW realm 里读出库作用域（顺便证明 SW 里 import() 到底能不能用）。 */
async function readScopeInSw(sw, chunk) {
  return await sw.evaluate(
    async ({ chunkName, pickSrc }) => {
      const pick = new Function(`${pickSrc}\nreturn pick;`)();
      const out = {};
      try {
        const m = await import(chrome.runtime.getURL(chunkName));
        out.importOk = true;
        const ns = pick(m);
        if (!ns) {
          out.error = '构建产物里找不到 currentLibraryScope';
        } else {
          try {
            out.scope = await ns.currentLibraryScope();
          } catch (e) {
            out.scopeError = String(e?.message ?? e);
          }
        }
      } catch (e) {
        out.importOk = false;
        out.error = String(e?.message ?? e);
      }
      return out;
    },
    { chunkName: chunk, pickSrc: PICK_NS }
  );
}

/** 两轮回包是否「同形」（这是本探针的核心判据）。 */
function sameShape(a, b) {
  const shape = r => ({
    ok: r?.ok === true,
    success: r?.payload?.success === true,
    locked: r?.payload?.locked === true,
    skipped: typeof r?.payload?.skippedGroups === 'number' ? r.payload.skippedGroups : 0,
  });
  const sa = shape(a);
  const sb = shape(b);
  return (
    sa.ok === sb.ok &&
    sa.success === sb.success &&
    sa.locked === sb.locked &&
    sa.skipped === sb.skipped
  );
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const problems = [];
  const facts = {};
  const steps = [];

  const configKey = webdavConfigKey();
  // libraryIdentity 的构建产物（页面侧动态加载的 chunk）。
  // 修好之后 SW 侧是静态 import，这个 chunk 可能不再单独存在 —— 测不到就如实说测不到。
  const identityChunk = existsSync(DIST)
    ? readdirSync(DIST).find(f => f.startsWith('libraryIdentity-') && f.endsWith('.js')) ?? null
    : null;

  const profile = mkdtempSync(join(tmpdir(), 'tapstack-scope-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--lang=zh-CN',
    ],
    viewport: { width: 1280, height: 900 },
  });

  try {
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await new Promise(r => setTimeout(r, 500));
    }
    if (!sw) throw new Error('扩展的 service worker 没有起来');
    const id = new URL(sw.url()).host;

    // ── 事实 1：SW realm 里 import() 到底能不能用 ────────────────────────
    if (identityChunk) {
      const probe = await readScopeInSw(sw, identityChunk);
      facts.swRealmDynamicImport = probe;
      steps.push({ step: '事实：SW realm 里的动态 import', ...probe });
    } else {
      facts.swRealmDynamicImport = { skipped: '构建产物里没有独立的 libraryIdentity chunk' };
      steps.push({ step: '事实：SW realm 里的动态 import', skipped: true });
    }

    // ── 事实 2：页面 realm 里的动态 import（对照组）──────────────────────
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    await page.goto(`chrome-extension://${id}/src/popup/index.html`);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
    await page.waitForTimeout(500);

    if (identityChunk) {
      const probe = await readScopeInPage(page, identityChunk);
      facts.pageRealmDynamicImport = probe;
      steps.push({ step: '事实：页面 realm 里的动态 import', ...probe });
    }

    // ── 摆现场 ───────────────────────────────────────────────────────────
    await writeKv(sw, [
      ['user_settings', { syncBackend: 'webdav', syncEnabled: true }],
      [
        configKey,
        {
          baseUrl: PROBE_BASE_URL,
          username: PROBE_USERNAME,
          rootPath: PROBE_ROOT,
          encryption: 'plain',
        },
      ],
      // 归属待决位：当前库已决策（false），另一个库还留着历史遗留的待决格（true）。
      ['webdav_first_sync_pending', { [LIB_SCOPE]: false, [OTHER_SCOPE]: true }],
      ['tab_groups', [PROBE_GROUP]],
      // 「本次改动过的会话」白名单：**空的** —— 这个会话是历史会话，不在白名单里。
      ['pending_upload_group_ids', []],
      ['pending_upload', true],
    ]);
    steps.push({ step: '摆现场', libScope: LIB_SCOPE, otherScope: OTHER_SCOPE });

    // SW 侧的后端解析有进程内缓存 ⇒ 必须让它重读设置与配置。
    await sendSync(page, { op: 'resyncAlarm' });
    await page.waitForTimeout(1500);

    // ── 事实 3：页面 realm 算出来的库（真值基准）─────────────────────────
    let pageScope = null;
    if (identityChunk) {
      const probe = await readScopeInPage(page, identityChunk);
      pageScope = probe.ok ? probe.scope : null;
      facts.pageScope = probe;
      steps.push({ step: '页面 realm 算出的库作用域', ...probe });
    }
    if (pageScope !== LIB_SCOPE) {
      problems.push(
        '现场没摆对：页面 realm 算出来的库作用域不是我们配的那个库' +
          `（实得 ${pageScope ?? '（读不出来）'}，期望 ${LIB_SCOPE}）。` +
          '后面的判据全部依赖这个基准，先修现场再谈结论。'
      );
    }

    // ── 事实 3bis：SW realm 算出来的库（走**注册进来的加载器**）────────────
    //
    // 这才是 P0-1 的**直接**判据。
    //
    // 「事实 1」（SW realm 里的动态 import 失败）只证明了**根因** ——
    // 而那条路在修复后**仍然**失败，因为那条路本来就不该再用
    // （service worker 里 import() 被 Chrome 禁止）。
    //
    // 真正要验的是「SW 侧算出来的库 == 页面侧算出来的库」：
    // 待决位是**按库寻址**的 ⇒ 两边对不上 ⇒ 判据就会打架
    // ⇒ SW 永远以为归属待决 ⇒ 历史会话被永久挡在用户自己的云盘之外。
    //
    // 走 SW 的 `LIBRARY_SCOPE` 诊断通道（只读；用「不吞异常」的版本 ——
    // 算不出就是**报错**，而不是悄悄兜底成 no-library 让人误判成「算出来了」）。
    const swScopeRes = await page.evaluate(async () => {
      try {
        return await chrome.runtime.sendMessage({ type: 'LIBRARY_SCOPE' });
      } catch (e) {
        return { ok: false, error: `消息失败：${e?.message ?? e}` };
      }
    });
    facts.swScope = swScopeRes;
    steps.push({ step: 'SW realm 算出的库作用域（走注册进来的加载器）', ...swScopeRes });
    if (!swScopeRes?.ok) {
      problems.push(
        'SW 侧算不出库作用域：' +
          (swScopeRes?.error ?? '（无回包）') +
          ' —— 待决位是按库寻址的 ⇒ SW 永远以为归属待决 ⇒ ' +
          '历史会话被永久挡在用户自己的云盘之外，而回包还报「成功」。'
      );
    } else if (swScopeRes.scope !== LIB_SCOPE) {
      problems.push(
        `SW 侧算出的库作用域与页面不一致（SW：${swScopeRes.scope}，页面：${LIB_SCOPE}）—— ` +
          '两边对不上 ⇒ 待决位的判据会打架（页面说「决策已完成」、后台说「还没决策」）。'
      );
    }

    // ── 两轮上传：自动 vs 显式（只差 explicitFirstSync）────────────────────
    const auto = await sendSync(page, { op: 'upload' });
    steps.push({ step: '自动上传（用户没确认归属）', result: auto });
    await page.waitForTimeout(500);
    const explicit = await sendSync(page, { op: 'upload', explicitFirstSync: true });
    steps.push({ step: '显式上传（用户已确认归属 = 对照组）', result: explicit });

    // ── 判据 ─────────────────────────────────────────────────────────────
    // 对照组必须真的走到后端那一层（locked = 后端解析跑到了、只是没有权限）。
    if (explicit?.payload?.locked !== true) {
      problems.push(
        '对照组没走到后端那一层（回包里没有 locked 标记）—— ' +
          '这说明现场/环境不对（后端解析没跑起来），两轮结果不可比，先修现场。' +
          `实得：${JSON.stringify(explicit)}`
      );
    }
    if (!sameShape(auto, explicit)) {
      problems.push(
        'SW 侧把「自动上传」判成了归属待决（于是只传白名单、而白名单是空的 ⇒ 什么都没传），' +
          '但同一次显式上传（用户已确认归属）却走到了后端。' +
          '⇒ SW 侧算不出「本机当前指向哪个库」，历史会话被永久挡在用户自己的云盘之外，' +
          '而回包还报「成功」。' +
          `\n  自动上传：${JSON.stringify(auto)}\n  显式上传：${JSON.stringify(explicit)}`
      );
    }
    if (pageErrors.length) {
      problems.push(`页面报错 ${pageErrors.length} 条：${pageErrors.slice(0, 2).join(' | ')}`);
    }
  } catch (error) {
    problems.push(`脚本自身出错：${error.message}`);
  } finally {
    await ctx.close().catch(() => {});
  }

  const report = { problems, facts, steps };
  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (problems.length) process.exitCode = 1;
}

main();
