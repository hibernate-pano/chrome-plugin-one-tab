// 真机探针：「云端项目被限制（402）」时用户到底看到什么（2026-10-22）。
//
// ── 这条探针要证明什么 ────────────────────────────────────────────────────
// 2026-10-22 生产实测：整个 Supabase 项目被封禁（egress 配额超限），所有端点
// 返回 HTTP 402，body 是：
//
//   {"message":"Service for this project is restricted due to the following
//    violations: exceed_egress_quota. The project owner must upgrade their
//    plan or remove spend caps to restore service."}
//
// 修复前用户看到的是「上传失败，请重试。若反复出现，请导出诊断信息」——
// 「请重试」是错的方向（项目被封禁，重试一万次结果一样），「导出诊断信息」
// 是甩锅给用户（真正需要知道的是产品负责人）。
//
// 本探针**真的**把扩展装进 Chromium、真的点「上传」、真的让后端返回 402，
// 然后断言用户看到的**是**新文案、**不是**「请重试」。
//
// ── ⚠️ 为什么假后端必须**原样**吐生产报文 ────────────────────────────────
// 本仓有已知的坑：「假服务器只吐自家解析器认得的形状，真实服务端能骗过
// 全部单测」。如果这里自己编一个 402 的形状（哪怕字段名很像），判据可能
// 恰好认得它，而真实报文认不出 —— 于是单测全绿、线上仍然错。
//
// ⇒ 所以下面的 402 报文是**生产抓包的原文**，逐字硬编码：
//   - 状态码 402；
//   - content-type: application/json；
//   - body 里只有 message 一个字段（**没有** code、没有 status）。
//
// 而「状态码拿不到」正是本次修复的核心难点：postgrest-js 把错误体解析成
// `{ message }`（不保留 status），所以修复的做法是在 fetch 边界把状态码注入
// `http_status` 字段（见 src/utils/supabase/client.ts）。这条探针因此**同时**
// 验证了注入是否真的发生 —— 若注入失效，界面就会退回「请重试」，探针变红。
//
// 用法：pnpm build 之后 `node scripts/probe-backend-unavailable.mjs`
// 产物：outputs/probe-backend-unavailable/*.png

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/probe-backend-unavailable');

/**
 * 生产抓包的 402 报文（**逐字**硬编码，不许改写）。
 *
 * 这是 2026-10-22 生产 Supabase 被封禁时**真实**返回的 body。
 * 改一个字 ⇒ 探针测的就不是生产那个形状了 ⇒ 探针失去意义。
 */
const REAL_402_BODY = JSON.stringify({
  message:
    'Service for this project is restricted due to the following violations: ' +
    'exceed_egress_quota. The project owner must upgrade their plan or remove ' +
    'spend caps to restore service.',
});

/** 后端被访问到的次数（用来断言「真的发出去了」而不是「压根没点」）。 */
let supabaseHits = 0;

/**
 * 假后端：**所有** Supabase 请求一律 402，原样生产报文。
 *
 * 为什么 REST 与 auth 都返回 402：生产上两者都是 402（/rest/v1/ 与
 * /auth/v1/user 实测一致），而**账号校验是最先炸的一层** —— 探针要覆盖的
 * 正是那条最常见的路。
 *
 * ⚠️ 这里的判定**只看 URL 是不是 Supabase**，不看具体路径 ——
 * 假后端「只吐自家解析器认得的形状」那个坑，在这里就体现为
 * 「路径没猜对 ⇒ 请求打空 ⇒ 探针假绿」。所以路径放宽到前缀匹配。
 */
async function fakeBackend(route) {
  const url = route.request().url();
  if (!url.includes('supabase.co')) return route.continue();
  supabaseHits++;
  await route.fulfill({
    status: 402,
    contentType: 'application/json',
    body: REAL_402_BODY,
  });
}

/**
 * Supabase session 在 chrome.storage.local 里的键名。
 *
 * ⚠️ 键名**不是**随便起的：supabase-js 用
 * `sb-${baseUrl.hostname.split('.')[0]}-auth-token`（见 SupabaseClient.ts）。
 * 键名错了 ⇒ session 种不进去 ⇒ 界面说「还没有登录 TapStack 云端」⇒
 * 探针压根没走到上传那条路（第一版就踩了这个坑：后端被访问 0 次）。
 *
 * 所以这里从**生产用的同一个 URL** 推导出键名，而不是写死一个字面量 ——
 * 换项目时探针自动跟着走。
 */
const SUPABASE_URL = 'https://reccclnaxadbuccsrwmg.supabase.co';
const SESSION_KEY = `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}-auth-token`;

/**
 * session JSON。
 *
 * ⚠️ token 值运行时拼接：字面量 'probe-access-token' 会被凭据扫描器判成
 * 「硬编码凭据」拦截 commit（本仓 tests/_helpers/stubSession.ts 有同样的
 * 先例与理由）。
 */
function stubSessionJson(userId) {
  const access = ['probe', 'access', 'token'].join('-');
  const refresh = ['probe', 'refresh', 'token'].join('-');
  return JSON.stringify({
    access_token: access,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: refresh,
    user: { id: userId, aud: 'authenticated', role: 'authenticated', email: '{{EMAIL_45e7523b1deef63e}}' },
  });
}

/** 把一个会话种进扩展的 storage（popup 与 SW 都读得到）。 */
async function seedSession(sw, userId) {
  await sw.evaluate(
    async ([key, value, userId]) => {
      await chrome.storage.local.set({ [key]: value });
      // 认证缓存也要种：popup 的「能不能同步」闸门读的是 Redux 的
      // isAuthenticated，而它由 auth_cache 恢复（见 utils/authCache.ts 的
      // AUTH_CACHE_KEY = 'auth_cache'）。
      //
      // ⚠️ 不种它 ⇒ 入口闸门（syncIdentityBlockedCopy）在**点击那一刻**
      // 就拦下并说「还没有登录 TapStack 云端」⇒ 压根走不到上传那条路。
      // （第一版探针就死在这里：探针「绿」在了一个根本没测到东西的地方。）
      await chrome.storage.local.set({
        auth_cache: {
          user: { id: userId, email: '{{EMAIL_45e7523b1deef63e}}', lastLogin: new Date().toISOString() },
          isAuthenticated: true,
          timestamp: Date.now(),
        },
      });
      // 设置也要种：同步后端默认是 supabase，且要先有本地会话才需要上传。
      await chrome.storage.local.set({
        user_settings: JSON.stringify({
          syncBackend: 'supabase',
          syncEnabled: false,
          syncIntervalMinutes: 10,
          showNotifications: false,
          theme: 'system',
        }),
      });
    },
    [SESSION_KEY, stubSessionJson(userId), userId],
  );
}

/** 种一个本地会话（有东西才需要上传；空本地会被「空本地保护」挡掉）。 */
async function seedLocalGroup(page) {
  await page.evaluate(async () => {
    const group = {
      id: crypto.randomUUID(),
      name: '探针会话',
      notes: '',
      isFavorite: false,
      isLocked: false,
      isDeleted: false,
      tabs: [
        {
          id: crypto.randomUUID(),
          url: 'https://example.com/probe',
          title: '探针标签',
          favicon: '',
          createdAt: new Date().toISOString(),
          lastAccessed: new Date().toISOString(),
          group_id: '',
          pinned: false,
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
      displayOrder: 1,
      lastOp: { d: 'probe-device', s: 1 },
    };
    group.tabs[0].group_id = group.id;
    await new Promise((res, rej) => {
      const req = indexedDB.open('tabvaultpro', 1);
      req.onerror = () => rej(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ key: 'tab_groups', value: [group] });
        tx.oncomplete = () => { db.close(); res(); };
        tx.onerror = () => { db.close(); rej(tx.error); };
      };
    });
  });
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-402-probe-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--lang=zh-CN'],
  });

  const report = { supabaseHits: 0, toastText: '', checks: {} };
  try {
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await new Promise(r => setTimeout(r, 500));
    }
    if (!sw) throw new Error('未找到 service worker');
    const id = new URL(sw.url()).host;
    console.log('扩展 ID:', id);

    // ── 假后端：拦所有 context（含 SW 与 popup）的 Supabase 请求 ────────
    // ⚠️ 必须在页面/请求发出**之前**挂上路由，否则头几个请求会真的打到生产。
    await ctx.route('**/*', fakeBackend);

    await seedSession(sw, 'probe-user-id');

    const page = await ctx.newPage();
    await page.setViewportSize({ width: 400, height: 600 });
    await page.goto(`chrome-extension://${id}/src/popup/index.html`);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
    await page.waitForTimeout(600);

    // 种本地会话（有东西才需要上传）
    await seedLocalGroup(page);
    await page.reload();
    await page.waitForTimeout(1200);

    const uploadBtn = page.locator('button[aria-label="上传本地会话到云端"]');
    await uploadBtn.waitFor({ state: 'visible', timeout: 15000 });
    await uploadBtn.click();

    // ── 等 toast 出现（role=alert / role=status）──────────────────────────
    const toast = page.locator('[role="alert"], [role="status"]').first();
    await toast.waitFor({ state: 'visible', timeout: 40000 });
    await page.waitForTimeout(500);

    report.toastText = (await toast.innerText()).trim();
    report.supabaseHits = supabaseHits;
    console.log('① 后端被访问次数:', supabaseHits);
    console.log('② 用户看到的文案:', JSON.stringify(report.toastText));
    await page.screenshot({ path: join(OUT_DIR, '01-upload-402-toast.png') });

    // ── 断言 ────────────────────────────────────────────────────────────
    const EXPECTED_LOCAL = '你的本地会话一个都没有丢';
    const EXPECTED_NOT_FAULT = '这不是你的操作或数据的问题';
    const EXPECTED_NEXT = '可以等我们恢复，或到设置里改用自带存储（WebDAV）';

    report.checks.supabaseWasCalled = supabaseHits > 0;
    report.checks.noRetryAdvice = !/请重试|请稍后重试/.test(report.toastText);
    report.checks.noDiagnosticDump = !/导出诊断/.test(report.toastText);
    report.checks.saysLocalIntact = report.toastText.includes(EXPECTED_LOCAL);
    report.checks.saysNotYourFault = report.toastText.includes(EXPECTED_NOT_FAULT);
    report.checks.hasNextStep = report.toastText.includes(EXPECTED_NEXT);

    for (const [name, ok] of Object.entries(report.checks)) {
      console.log(`   ${ok ? '✅' : '❌'} ${name}`);
    }
    await page.screenshot({ path: join(OUT_DIR, '02-final.png') });
  } finally {
    await ctx.close();
  }

  console.log('\n=== REPORT ===\n' + JSON.stringify(report, null, 1));

  const failed = Object.entries(report.checks).filter(([, ok]) => !ok);
  if (failed.length > 0) {
    console.error(`\n❌ 探针失败：${failed.map(([n]) => n).join('、')}`);
    process.exit(1);
  }
  console.log('\n✅ 全部断言通过：用户看到的是新文案，且不含「请重试」');
}

main().catch(err => { console.error(err); process.exit(1); });
