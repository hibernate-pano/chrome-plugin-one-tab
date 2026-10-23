// 真机验证：核**不到**登录态时，弹窗必须**保留**缓存里的登录态（第 48 轮四档判据的真机版）。
//
// ── 验的是什么 ────────────────────────────────────────────────────────
// 第 48 轮把「核登录态」搬到了 service worker，并把「登录 / 没登录」拆成四档：
//   authenticated / not_authenticated / backend_unavailable / unknown。
// 那一档的核心承诺是：**核不到**（服务端 402 / 断网 / 通道断了）时，
// 弹窗**不许**把登录态归零 ——
//
//   归零 = 界面说「你没登录」⇒ 用户会去重新登录、重新输密码，
//   甚至以为账号被删了，而真正的原因是「我们的云端项目被限制」。
//
// ⚠️ 这条承诺**静态判据看得见**
//   （tests/guards/backendUnavailableHonesty.test.ts 用 AST 判
//   「归零只许有一处，且必须落在 not_authenticated 那一支」），
//   但**真机上它到底长什么样**没人验过 ——
// 而本仓的教训反复是「守卫全绿 ≠ 行为对」。
//
// ── 怎么造出「核不到」 ────────────────────────────────────────────────
// ① 给扩展的 chrome.storage.local 种一个**假的 Supabase 会话**
//    （key = sb-<project-ref>-auth-token，ref 从产物里读，不写死）
//    ⇒ 后台核登录态时**真的会去联网** ⇒ 要么撞上生产项目当前的
//      402（云端项目被配额封禁，仓库 memory 有记录），要么撞上网络失败；
//    ⚠️ 假 token 绝不会「核成功」⇒ 不存在「假绿」。
// ② 同时种一条**本机缓存的登录态**（auth_cache）⇒ 界面上应该显示这个账号。
//
// ⇒ 期望（三条都要成立）：
//   A. 后台答的档位是「核不到」（backend_unavailable 或 unknown）；
//   B. **弹窗继续显示那个账号**（没有归零）—— 核心承诺；
//   C. **弹窗页面一次也没下载过 Supabase SDK** —— 第 48 轮的核心主张。
//
// 产出：outputs/lead-verify-auth-cache-first-frame/report.json。

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/lead-verify-auth-cache-first-frame');

/** 产物的内容标记：SDK 那一块里必然有 auth-js 的端点路径 `auth/v1`。 */
const SUPABASE_SDK_MARKER = 'auth/v1';

const PROBE_USER_ID = 'probe-user-0000-0000-0000-000000000001';
const PROBE_EMAIL = 'cache-probe@example.invalid';

/** base64url（造一个「像 JWT」的假 token —— supabase-js 只解 payload，不验签名）。 */
const b64url = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');

/** 从产物里读出真实的 Supabase 项目 ref（不写死 ⇒ 换项目也不用改脚本）。 */
function readProjectRef() {
  for (const f of readdirSync(DIST)) {
    if (!f.endsWith('.js')) continue;
    const src = readFileSync(join(DIST, f), 'utf8');
    const m = src.match(/https:\/\/([a-z0-9]{12,})\.supabase\.co/);
    if (m && m[1] !== 'placeholder') return m[1];
  }
  throw new Error('产物里找不到真实的 Supabase 项目 ref');
}

/** 产物里哪些块是 Supabase SDK。 */
function classifySdkChunks() {
  const sdk = [];
  for (const f of readdirSync(DIST)) {
    if (!f.endsWith('.js')) continue;
    if (readFileSync(join(DIST, f), 'utf8').includes(SUPABASE_SDK_MARKER)) sdk.push(f);
  }
  return sdk;
}

/** 一个「还没过期」的假会话（supabase-js 存的是 JSON 字符串）。 */
function fakeSession() {
  const nowSec = Math.floor(Date.now() / 1000);
  const jwt = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({
    sub: PROBE_USER_ID,
    exp: nowSec + 3600,
    email: PROBE_EMAIL,
  })}.probe-signature`;
  return JSON.stringify({
    access_token: jwt,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: nowSec + 3600,
    refresh_token: 'probe-refresh-token',
    user: {
      id: PROBE_USER_ID,
      email: PROBE_EMAIL,
      aud: 'authenticated',
      role: 'authenticated',
    },
  });
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
    if (!/Executable doesn't exist/i.test(String(err?.message ?? err))) throw err;
    console.error('[提示] Playwright 自带的 Chromium 没装，改用系统 Chrome。');
    return await chromium.launchPersistentContext(profile, { ...opts, channel: 'chrome' });
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const ref = readProjectRef();
  const sdkChunks = classifySdkChunks();
  console.log('[产物] 项目 ref =', ref, '｜SDK 块 =', sdkChunks.join(', ') || '(无)');

  const profile = mkdtempSync(join(tmpdir(), 'tapstack-auth-probe-'));
  const ctx = await launchWithExtension(profile);
  const problems = [];
  const report = { ref, sdkChunks, steps: [] };
  try {
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await new Promise(r => setTimeout(r, 500));
    }
    if (!sw) throw new Error('扩展的 service worker 没有起来');
    const id = new URL(sw.url()).host;

    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e?.message ?? e)));
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    const requests = [];
    cdp.on('Network.requestWillBeSent', e => {
      requests.push({ url: e.request.url, ts: e.timestamp, type: e.type ?? '' });
    });

    await page.goto(`chrome-extension://${id}/src/popup/index.html`);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip
      .waitFor({ state: 'visible', timeout: 8000 })
      .then(() => skip.click())
      .catch(() => {});

    // ── 种下「假会话 + 缓存登录态」────────────────────────────────────
    const seeded = await page.evaluate(
      async ({ sessionKey, session, user, email }) => {
        await chrome.storage.local.set({
          [sessionKey]: session,
          auth_cache: { user, isAuthenticated: true, timestamp: Date.now() },
        });
        const after = await chrome.storage.local.get(['auth_cache', sessionKey]);
        return {
          hasAuthCache: !!after.auth_cache,
          hasSession: !!after[sessionKey],
        };
      },
      {
        sessionKey: `sb-${ref}-auth-token`,
        session: fakeSession(),
        user: { id: PROBE_USER_ID, email: PROBE_EMAIL },
        email: PROBE_EMAIL,
      },
    );
    if (!seeded.hasAuthCache || !seeded.hasSession) {
      problems.push('种数据失败 —— 判据无法成立');
    }

    // 重新加载：让弹窗在「有缓存登录态」的状态下冷启动。
    const before = requests.length;
    await page.reload();
    await page.waitForTimeout(2500);

    // ── 判据 A：后台答的档位是「核不到」 ──────────────────────────────
    const roundTrip = await page.evaluate(async () => {
      const timeout = new Promise(r =>
        setTimeout(() => r({ ok: false, error: '30 秒内后台没回包' }), 30000),
      );
      try {
        const res = await Promise.race([
          chrome.runtime.sendMessage({ type: 'AUTH_STATUS' }),
          timeout,
        ]);
        return { ok: true, res };
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    });
    const kind = roundTrip.ok ? roundTrip.res?.status?.kind : null;
    if (!roundTrip.ok) {
      problems.push(`A 后台没回包：${roundTrip.error}`);
    } else if (!['backend_unavailable', 'unknown'].includes(kind)) {
      problems.push(
        `A 后台答的档位是「${kind}」而不是「核不到」—— ` +
          '这轮探针没造出「核不到」的处境（假 token 不该核成功 ⇒ ' +
          '若它核成功了，说明探针的前提没成立，判据无效）'
      );
    }
    report.steps.push({ step: 'A 后台答「核不到」', roundTrip, kind });

    // ── 判据 B：弹窗继续显示那个账号（没有归零）────────────────────────
    const menuBtn = page.locator('[data-menu-trigger]').first();
    let emailVisible = false;
    let menuText = '';
    if (await menuBtn.isVisible().catch(() => false)) {
      await menuBtn.click();
      await page.waitForTimeout(800);
      menuText = (await page.evaluate(() => {
        const m = document.querySelector('[role="menu"]');
        return (m?.textContent || '').replace(/\s+/g, ' ').trim();
      })) ?? '';
      emailVisible = menuText.includes(PROBE_EMAIL);
    } else {
      problems.push('B 找不到右上角菜单按钮 —— 判据无法成立');
    }
    if (!emailVisible) {
      problems.push(
        `B 菜单里看不到本机缓存的那个账号（${PROBE_EMAIL}）—— ` +
          '后台明明答的是「核不到」，弹窗却把登录态归零了：' +
          '界面于是说「你没登录」，而你明明登录着。' +
          `（菜单实际内容：${menuText.slice(0, 120)}）`
      );
    }
    report.steps.push({ step: 'B 弹窗保留缓存登录态', emailVisible, menuText: menuText.slice(0, 200) });
    await page.screenshot({ path: join(OUT_DIR, '01-menu.png') });

    // ── 判据 C：弹窗页面一次也没下载过 SDK ────────────────────────────
    const fileOf = url => ((url || '').split('/').pop() || '').split('?')[0];
    const sdkRequested = requests
      .slice(before)
      .map(r => fileOf(r.url))
      .filter(f => sdkChunks.includes(f));
    if (sdkRequested.length) {
      problems.push(
        `C 弹窗打开时下载了 SDK：${[...new Set(sdkRequested)].join(', ')} —— ` +
          '用户点开弹窗只想看本机会话列表，这 ≈75KB 跟他要干的事毫无关系。'
      );
    }
    report.steps.push({
      step: 'C 弹窗打开时不下载 SDK',
      sdkRequested: [...new Set(sdkRequested)],
      requestedFiles: requests.slice(before).map(r => fileOf(r.url)),
    });

    if (pageErrors.length) {
      problems.push(`页面报错 ${pageErrors.length} 条：${pageErrors.slice(0, 2).join(' | ')}`);
    }

    writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify({ problems, ...report }, null, 2));
    console.log(JSON.stringify({ problems, kind, emailVisible, sdkRequested }, null, 2));
    if (problems.length) process.exitCode = 1;
  } finally {
    await ctx.close();
  }
}

main().catch(err => {
  console.error('验证脚本失败：', err);
  process.exit(1);
});
