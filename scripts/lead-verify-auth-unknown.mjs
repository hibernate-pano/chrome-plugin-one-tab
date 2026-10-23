// 真机验证：云端不可用时，界面不许说「未登录」，且**本机会话不许被删掉」。
// （2026-10-23，第 50 轮起；第 51 轮扩成两个场景）
//
// ── 为什么必须真机 ────────────────────────────────────────────────────────
//
// 单测能证明「分类函数把失败分成三档」，但证明不了**真实浏览器里**：
//   · 弹窗首屏到底显示哪一行；
//   · 菜单里那一行到底写的是「未登录」还是「联系不上」；
//   · 设置页给不给「登录 / 注册」表单；
//   · **本机缓存有没有被清掉**（数据安全那一半，单测里没有真实存储）；
//   · **本机会话令牌有没有被删掉**（第 51 轮：SDK 在 402 时会删它 ⇒ 一次云端
//     故障 = 一次全员登出；这发生在 SDK 内部，单测必须真打一次 SDK 才看得见）。
//
// ⇒ 这里在**真 Chrome + 真扩展**里跑**两个场景**：
//   A. **断网**：把 Supabase 域名**掐断**（DNS 直接解析失败）⇒ 真实的
//      「核不到」（`AuthRetryableFetchError`）⇒ 界面说「联系不上」；
//   B. **402（生产实况）**：不掐 DNS ⇒ 请求真的到云端 ⇒ 真的 402
//      （2026-10-22 实测：整个项目被 egress 配额限制）⇒ 界面说「云端暂时不可用」。
//
// ⚠️ 场景 A **必须加 `--no-proxy-server`**：
//   本机有系统代理（127.0.0.1:7897），而**代理会自己解析域名**
//   ⇒ `--host-resolver-rules` 的 DNS 掐断**对代理无效**
//   ⇒ 请求照样到了云端 ⇒ 拿到的是 402 而不是「断网」
//   ⇒ 场景 A 会静默地变成场景 B（看起来绿，其实没验到断网）。
//
// 用法：先 `pnpm build`，再 `node scripts/lead-verify-auth-unknown.mjs`
// 产出：outputs/lead-verify-auth-unknown/*.png + report.json
// 退出码非 0 = 有问题。

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/lead-verify-auth-unknown');
mkdirSync(OUT_DIR, { recursive: true });

/** 读 .env（本仓的 Supabase 项目）。**只在本机跑**，不进产物。 */
const readEnv = () => {
  const out = {};
  try {
    for (const line of readFileSync(resolve(process.cwd(), '.env'), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {
    /* 没有 .env 就用下面的兜底 */
  }
  return out;
};
const ENV = readEnv();
/** 本仓的 Supabase 项目（.env 的 VITE_SUPABASE_URL）。session 存储键由它派生。 */
const SUPABASE_URL = ENV.VITE_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = ENV.VITE_SUPABASE_ANON_KEY ?? '';
const SUPABASE_PROJECT = (() => {
  try {
    return new URL(SUPABASE_URL).hostname.split('.')[0];
  } catch {
    return 'reccclnaxadbuccsrwmg';
  }
})();
const SESSION_KEY = `sb-${SUPABASE_PROJECT}-auth-token`;

const problems = [];
const notes = [];
const gate = (ok, label, detail = '') => {
  (ok ? notes : problems).push(`${ok ? '✅' : '❌'} ${label}${detail ? ` —— ${detail}` : ''}`);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

/** 一个「已过期」的访问令牌（真 JWT 形状：解码得出来、exp 在过去 ⇒ SDK 会去刷新）。 */
const expiredAccessToken = (sub, email) => {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({
    sub,
    email,
    aud: 'authenticated',
    role: 'authenticated',
    exp: now - 3600,
    iat: now - 7200,
    session_id: 'verify-session',
  });
  return `${header}.${payload}.${b64url({ sig: 'verify' })}`;
};

/** 弹窗/设置页里**不该**出现的措辞（云端不可用时说出来就是谎）。 */
const FORBIDDEN = ['未登录', '尚未登录', '登录 / 注册', '请重新登录'];
/** 「核不到」时**应该**出现的措辞。 */
const EXPECTED_UNKNOWN = ['联系不上', '暂时无法确认', '正在确认'];
/** 「云端项目被限制」时**应该**出现的措辞。 */
const EXPECTED_UNAVAILABLE = ['云端暂时不可用', '无法验证你的账号'];

/** 造一份「登录着」的本机事实（会话 + 缓存）。 */
const buildSeeds = (user) => ({
  sessionKey: SESSION_KEY,
  sessionJson: JSON.stringify({
    access_token: expiredAccessToken(user.id, user.email),
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) - 3600,
    refresh_token: 'verify-refresh-token',
    user: {
      id: user.id,
      aud: 'authenticated',
      role: 'authenticated',
      email: user.email,
      app_metadata: {},
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  }),
  // ⚠️ auth_cache 存的是**对象**（authCache.saveAuthState 写的是 cacheData 本体），
  // 不是 JSON 字符串 —— 写错形状的话，界面读到的就是「没有缓存」。
  cacheJson: {
    user,
    isAuthenticated: true,
    timestamp: Date.now(),
  },
});

/**
 * 跑一个场景：起浏览器 → 种本机事实 → 看弹窗菜单 → 看设置页 → 查本机存储。
 *
 * @param scenario 场景名（产出文件名用）
 * @param extraArgs 这个场景专属的 Chrome 参数
 * @param expected 界面上**应该**出现的措辞（任一命中即可）
 */
async function runScenario(scenario, extraArgs, expected) {
  const args = [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    '--no-first-run',
    '--lang=zh-CN',
    ...extraArgs,
  ];
  const opts = { headless: false, args, viewport: { width: 1440, height: 900 } };
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), `tapstack-${scenario}-`)), opts);
  } catch (err) {
    if (!/Executable doesn't exist/i.test(String(err?.message ?? err))) throw err;
    ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), `tapstack-${scenario}-`)), {
      ...opts,
      channel: 'chrome',
    });
  }

  try {
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await sleep(500);
    }
    if (!sw) {
      problems.push(`❌ [${scenario}] 未找到扩展 service worker`);
      return;
    }
    const id = new URL(sw.url()).host;

    // ── 种一份「登录着」的本机事实 ────────────────────────────────────────
    const USER = { id: `verify-user-${scenario}`, email: 'verify@example.com' };
    const seeds = buildSeeds(USER);
    const seeded = await sw.evaluate(
      async ({ sessionKey, sessionJson, cacheJson }) => {
        await chrome.storage.local.set({ [sessionKey]: sessionJson, auth_cache: cacheJson });
        const read = await chrome.storage.local.get([sessionKey, 'auth_cache']);
        return {
          hasSession: typeof read[sessionKey] === 'string',
          cacheIsAuth: read.auth_cache?.isAuthenticated === true,
        };
      },
      seeds,
    );
    gate(seeded.hasSession, `[${scenario}] 会话已种进 chrome.storage.local`);
    gate(seeded.cacheIsAuth, `[${scenario}] 本机登录缓存已种下（isAuthenticated=true）`);

    // ── 弹窗：菜单那一行 ──────────────────────────────────────────────────
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${id}/src/popup/index.html`);
    await page.waitForSelector('[data-menu-trigger]', { timeout: 20000 });
    // 首次启动有引导遮罩，它会**拦住**所有点击 ⇒ 先按它自己的「跳过引导」走。
    // ⚠️ 只点按钮，不删 React 节点（那是另一个脚本的教训）。
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => skip.click())
      .catch(() => undefined);
    await sleep(800);
    // 给 SW 核登录态一点时间（探活 1 次 + 最多 5 秒的等待上限 ⇒ 留 12 秒）。
    await sleep(12000);
    await page.click('[data-menu-trigger]');
    await page.waitForSelector('[role="menu"]', { timeout: 10000 });
    await sleep(600);

    const menuText = await page.locator('[role="menu"]').innerText();
    await page.screenshot({ path: resolve(OUT_DIR, `popup-menu-${scenario}.png`) });

    const menuForbidden = FORBIDDEN.filter((w) => menuText.includes(w));
    gate(
      menuForbidden.length === 0,
      `[${scenario}] 弹窗菜单里没有「未登录 / 登录」类措辞`,
      menuForbidden.length ? `出现了：${menuForbidden.join('、')}｜菜单原文：${menuText.replace(/\s+/g, ' ').slice(0, 220)}` : ''
    );
    const menuExpected = expected.filter((w) => menuText.includes(w));
    gate(
      menuExpected.length > 0,
      `[${scenario}] 弹窗菜单里说出了「云端这一档」`,
      menuExpected.length ? '' : `菜单原文：${menuText.replace(/\s+/g, ' ').slice(0, 220)}`
    );

    // ── 设置页 ────────────────────────────────────────────────────────────
    const opt = await ctx.newPage();
    await opt.goto(`chrome-extension://${id}/src/options/index.html`);
    // 等它核完（核不到 ⇒ 账号区显示「暂时无法确认登录状态」）。
    await opt
      .waitForFunction(() => document.body.innerText.includes('暂时无法确认登录状态'), null, {
        timeout: 25000,
      })
      .catch(() => undefined);
    await sleep(3000);
    const optText = await opt.locator('body').innerText();
    await page.screenshot({ path: resolve(OUT_DIR, `options-${scenario}.png`), fullPage: true });

    const optForbidden = FORBIDDEN.filter((w) => optText.includes(w));
    gate(
      optForbidden.length === 0,
      `[${scenario}] 设置页里没有「未登录 / 登录」类措辞，也没有登录表单`,
      optForbidden.length ? `出现了：${optForbidden.join('、')}` : ''
    );
    const optExpected = expected.filter((w) => optText.includes(w));
    gate(
      optExpected.length > 0,
      `[${scenario}] 设置页说清了「云端这一档」`,
      optExpected.length ? '' : `页面原文：${optText.replace(/\s+/g, ' ').slice(0, 300)}`
    );

    // ── 数据安全那一半：本机缓存与会话**都不许**被清掉 ────────────────────
    const after = await sw.evaluate(async (sessionKey) => {
      const read = await chrome.storage.local.get([sessionKey, 'auth_cache']);
      return {
        cacheExists: !!read.auth_cache,
        cacheIsAuth: read.auth_cache?.isAuthenticated === true,
        sessionExists: typeof read[sessionKey] === 'string',
      };
    }, SESSION_KEY);
    gate(
      after.cacheExists && after.cacheIsAuth,
      `[${scenario}] 本机登录缓存**没有被清掉**（修好前：读会话失败 ⇒ clearAuthState ⇒ 缓存没了）`,
      JSON.stringify(after)
    );
    // ★ 第 51 轮最要紧的一条：SDK 在 402 时会**删掉会话令牌**
    //   （它把「服务端不服务」当成「刷新令牌已死」）⇒ 一次云端故障 = 一次全员登出。
    gate(
      after.sessionExists,
      `[${scenario}] 本机会话令牌**没有被清掉**（SDK 不许把一次云端故障当成「会话已死」）`,
      JSON.stringify(after)
    );
  } catch (err) {
    problems.push(`❌ [${scenario}] 脚本异常：${err?.message ?? err}`);
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

async function main() {
  // ── 场景 B 的前提：云端现在**真的**是被限制的状态 ────────────────────────
  // 不是的话（云端恢复了）就**如实跳过**，而不是让场景 B 变成一次「假红」。
  let realStatus = null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: SUPABASE_ANON_KEY },
      signal: AbortSignal.timeout(8000),
    });
    realStatus = res.status;
  } catch (err) {
    notes.push(`ℹ️ 探活失败（${err?.message ?? err}）⇒ 场景 B（真 402）跳过`);
  }

  // ── 场景 A：断网 ────────────────────────────────────────────────────────
  // ⚠️ `--no-proxy-server`：本机的系统代理会自己解析域名 ⇒ 不加它的话
  //    DNS 掐断**不生效**，请求照样到云端（拿到 402）⇒ 场景 A 静默变成场景 B。
  await runScenario(
    'offline',
    ['--no-proxy-server', '--host-resolver-rules=MAP *.supabase.co ~NOTFOUND'],
    EXPECTED_UNKNOWN,
  );

  // ── 场景 B：生产实况（真 402）────────────────────────────────────────────
  if (realStatus === 402) {
    await runScenario('cloud-402', [], EXPECTED_UNAVAILABLE);
  } else {
    notes.push(
      `ℹ️ 云端现在**不是**被限制的状态（探活 HTTP ${realStatus}）⇒ ` +
        '场景 B（真 402）跳过（不是「过了」，是「没条件验」）',
    );
  }
}

await main();

const report = { at: new Date().toISOString(), problems, notes };
writeFileSync(resolve(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
for (const line of [...notes, ...problems]) console.log(line);
console.log(problems.length ? `\n❌ ${problems.length} 项不通过` : '\n✅ 全部通过');
process.exit(problems.length ? 1 : 0);
