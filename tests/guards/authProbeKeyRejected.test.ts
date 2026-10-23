/**
 * 「网关拒了我们的 apikey」这一族故障：**用户的会话不许被删掉**（2026-10-23，第 51 轮）。
 *
 * ── 这个缺陷是什么 ──────────────────────────────────────────────────────
 * 第 51 轮修掉了「云端 402（项目被限制）」这一族；但**同一族**还有另一个成员：
 * **网关拒了我们的 apikey**（key 被轮换 / 项目被暂停 / key 配错）。
 *
 * 生产实测（2026-10-23，对着线上项目打的）：
 *   · 不带 apikey       ⇒ **401** `{"message":"No API key found in request"}`
 *   · 带一个错的 apikey ⇒ **401** `{"message":"Invalid API key"}`
 *   · 带**对的** apikey  ⇒ 200（健康时）
 *
 * ⇒ key 被拒之后，**每一个**请求都会以同样的方式失败 ⇒ 包括 SDK 的
 * **刷新**请求（POST /auth/v1/token）⇒ auth-js 把 401 当成「服务端明确拒绝」
 * ⇒ `_removeSession()` ⇒ **用户的会话被删掉**。
 *
 * 而在那之前，探活（`/auth/v1/health`）**也**会拿到 401 ⇒ 旧判据说
 * 「它答了 ⇒ 它在服务」（401 不在「服务端不可用」的状态码集合里）
 * ⇒ **主防线在这一族故障上完全失效** ⇒ 一次 key 轮换 = 一次全员登出，
 * 而且用户重新登录也登不进去（登录端点同样 401）⇒ 死循环。
 *
 * ── 判据为什么是「401/403 ⇒ 不可用」而不是「401/403 ⇒ 在服务」──────────
 * 因为**探活带了 apikey、不带用户令牌** ⇒ 探活拿到 401 **不可能**是
 * 「用户没登录」⇒ 它只能是「网关拒了我们的 key」。
 * ⇒ fail-closed：判「不可用」⇒ 不碰 SDK ⇒ 会话活下来。
 *
 * ⚠️ 代价（说清楚）：若某个部署的 `/auth/v1/health` 本来就恒回 401，
 * 我们会把所有人挡在「云端不可用」门外 ⇒ 用户看到「稍后重试」而登不进去。
 * 那个代价（**会话还在**，恢复后自动继续）远小于放行的代价
 * （**会话被删**，且再也登不进去）。
 *
 * ── 判据钉的是**行为**，不是源码长相 ─────────────────────────────────────
 * 真的跑一遍：装一个「所有请求都回 401」的假云端 ⇒ 核一次登录态 ⇒
 *   ① 刷新端点**一次都没被问**（会话连读都没被读）；
 *   ② 会话令牌**仍在**存储里；
 *   ③ 界面那一档是「云端不可用」，不是「未登录」。
 *
 * ⚠️ **① 现在是「因为客户端压根没被建出来」才成立的**（2026-10-23，第 51 轮）：
 * `createClient` ⇒ auth-js 构造函数 ⇒ **它自己就 `initialize()`** ⇒
 * `_recoverAndRefresh()` ⇒ 本地会话已过期就**立刻**发一次刷新请求 ——
 * **在我们的任何闸门之前**（那时我们还没拿到客户端）。
 * ⇒ 所以「客户端**惰性创建**」（`utils/supabase/client.ts`）是这条断言的前提：
 *   客户端第一次被**真正用到**时才建 ⇒ 探活判「不可用」就直接抛错
 *   ⇒ 客户端压根没被建 ⇒ 一次刷新请求都不会发。
 * ⇒ 而正因为如此，① 这条断言**有检测力**：客户端一旦被提前建出来（探活失效、
 *   或惰性创建被拆掉），刷新请求立刻出现 ⇒ 变红。
 *   （变异自证见 `tests/guards/authProbeKeyRejectedMutation.test.ts`。）
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOADER_PATH = pathToFileURL(resolve(ROOT, 'tests/_alias-loader.mjs')).href;

before(async () => {
  register(LOADER_PATH);
});

/** 会话存储键：由 Supabase URL 的 projectRef 派生（stub ⇒ `stub`）。 */
const SESSION_KEY = 'sb-stub-auth-token';
const USER_ID = 'user-r51-keyrejected';
const USER_EMAIL = 'keyrejected@example.com';

/**
 * 一份**已过期**的会话（⇒ SDK 会去刷新 ⇒ 刷新撞上 401 ⇒ 会话会被删）。
 *
 * ⚠️ **每条用例必须用不同的刷新令牌**（`refreshTag`）：auth SDK 会把
 * 「上一次刷新失败」缓存 60 秒，而那份缓存是**按刷新令牌**索引的
 * ⇒ 同一枚令牌会让后一条用例**根本不发请求**（直接吃缓存）
 * ⇒ 「SDK 有没有被问去刷新」这条断言就**恒真**（守卫失去检测力，且是假绿）。
 */
const expiredSessionJson = (refreshTag: string): string => {
  const access = ['stub', 'expired', 'access', 'token'].join('-');
  const refresh = ['stub', 'expired', 'refresh', 'token', refreshTag].join('-');
  return JSON.stringify({
    access_token: access,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) - 60,
    refresh_token: refresh,
    user: {
      id: USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      email: USER_EMAIL,
      app_metadata: {},
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  });
};

/**
 * 假云端：**所有**请求都回 401「Invalid API key」（生产实测形状）。
 *
 * ⚠️ 为什么不用 `tests/_helpers/fakePostgrestCloud.ts`：那个 helper 只模拟
 * 「项目被限制（402）」；而这一族是**另一个**形状（网关拒 key）⇒ 在本文件里
 * 单独装一个（不去改共享 helper ⇒ 不会与别的用例的假设打架）。
 */
const installKeyRejectedCloud = () => {
  const requests: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : String((input as { url: string }).url));
    const method = (init.method ?? 'GET').toUpperCase();
    requests.push(`${method} ${url.pathname}`);
    return new Response(
      JSON.stringify({
        hint: 'Double check your Supabase `anon` or `service_role` API key.',
        message: 'Invalid API key',
      }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return {
    requests,
    restore() {
      globalThis.fetch = previousFetch;
    },
  };
};

beforeEach(async () => {
  // 模块级的「云端观测」必须清空，否则上一条用例的观测会让这一条跳过探活。
  const { __resetOutageTrackerForTests } = await import('@/utils/supabase/outageTracker');
  __resetOutageTrackerForTests();
});

describe('探活拿到 401（网关拒了我们的 apikey）⇒ 会话不许被删', () => {
  it('刷新端点一次都不许被问，会话令牌仍在，界面那一档是「云端不可用」', async () => {
    const { installEngineStorageEnv } = await import('../_helpers/engineStorageEnv.ts');
    const env = installEngineStorageEnv();
    const cloud = installKeyRejectedCloud();
    try {
      const { store } = await import('@/store');
      const { setFromCache, getCurrentUser } = await import('@/store/slices/authSlice');

      env.chromeData.set(SESSION_KEY, expiredSessionJson('probe'));
      env.chromeData.set('auth_cache', {
        user: { id: USER_ID, email: USER_EMAIL },
        isAuthenticated: true,
        timestamp: Date.now(),
      });
      store.dispatch(
        setFromCache({
          user: { id: USER_ID, email: USER_EMAIL, lastLogin: new Date().toISOString() },
          isAuthenticated: true,
          statusKind: 'unchecked',
        })
      );

      let rejected = false;
      try {
        await store.dispatch(getCurrentUser()).unwrap();
      } catch {
        rejected = true;
      }
      assert.ok(
        rejected,
        '核不到时 thunk 必须 reject —— resolve(null) 会被界面读成「核到没登录」'
      );

      // ★ 检测点：SDK 的刷新端点**一次都不许被问**。
      // 「会话还在」在「压根没刷新」与「刷新了但没删」两种情况下都成立
      // ⇒ 只断言会话还在是**假绿**。
      //
      // ⚠️ **先让请求都落地**（150ms）：客户端一旦被建出来，auth-js 的
      // `initialize()` ⇒ `_recoverAndRefresh()` 会**异步**发一次刷新请求 ——
      // 它可能比探活**晚几十毫秒**才被记进日志 ⇒ 不等一下就断言 = 竞态
      // ⇒ 守卫时而红时而绿（假绿）。
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.deepEqual(
        cloud.requests.filter(r => r.includes('/auth/v1/token')),
        [],
        '云端的 key 被拒时**不许**让 SDK 去刷新会话 —— ' +
          '刷新拿到 401 ⇒ SDK 当成「刷新令牌已死」⇒ 会话被删 ⇒ 用户被静默登出，' +
          '而 key 被拒期间重新登录必然失败 ⇒ 死循环'
      );
      assert.ok(
        cloud.requests.some(r => r.includes('/auth/v1/health')),
        '应当**问过一句**「云端在吗」（探活请求）—— 没问就是压根没做这道防线'
      );

      assert.ok(
        env.chromeData.get(SESSION_KEY),
        '会话令牌不许被删掉 —— 一次 key 轮换不该等于一次全员登出'
      );

      const auth = store.getState().auth;
      assert.equal(
        auth.authStatusKind,
        'backend_unavailable',
        '这一档必须是「云端不可用」，不是「未登录」—— ' +
          'key 被拒时让用户重新输密码是**错的方向**（那样也登不进去）'
      );
      assert.equal(auth.isAuthenticated, true, '登录态按缓存保留');
    } finally {
      cloud.restore();
    }
  });

  it('兜底防线：真 SDK 刷新撞上 401 之后，会话令牌仍在存储里', async () => {
    const { installEngineStorageEnv } = await import('../_helpers/engineStorageEnv.ts');
    const env = installEngineStorageEnv();
    const cloud = installKeyRejectedCloud();
    try {
      const { supabase } = await import('@/utils/supabase/client');
      env.chromeData.set(SESSION_KEY, expiredSessionJson('fallback'));

      // ⚠️ 这一条**故意绕开**「先问云端在吗」那道闸门（直接调 SDK）：
      // 它验的是**最后一道防线** —— 就算刷新真的发生了（探活之后云端才挂），
      // SDK 也不许把用户的会话删掉。
      //
      // ⚠️ 这一条**要等 25 秒**：401 被翻译成 SDK 眼里的「瞬时故障」后，
      // SDK 会连打 8 次、退避 25.4 秒（`_refreshAccessToken` 的 `retryable()`）。
      // 守卫必须等这阵风暴过去才有检测力（改坏时它**立刻**变红：
      // SDK 第一次失败就把会话删了）。
      const { data, error } = await supabase.auth.getSession();

      // ★ 本条守卫的核心：会话令牌**不许**被删掉。
      //
      // ⚠️ 为什么这条**排在最前面**：改坏时（不翻译 401）SDK 会先删掉会话，
      // 然后把失败**吞成「没有会话」**（`{session: null, error: null}`）⇒
      // 「失败必须被带出来」那条会先红 ⇒ 守卫会「红在别的地方」⇒
      // 变异自证就看不出「它抓的是哪一条」。
      // ⇒ 先钉**最要命的那条**（会话还在不在）。
      assert.ok(
        env.chromeData.get(SESSION_KEY),
        'key 被拒时**不许**删掉用户的会话令牌 —— ' +
          '那不是「你的刷新令牌被拒」，而是「我们的凭证根本没被评估」⇒ 删会话是误伤'
      );
      assert.ok(error, '刷新失败必须把错误带出来（吞掉它 ⇒ 上游读成「没有会话」）');
      assert.equal(
        data?.session ?? null,
        null,
        '这一轮确实没拿到会话（刷新失败）—— 但这不代表用户没登录'
      );
    } finally {
      cloud.restore();
    }
  });

  it('探活抛出的错误必须带**真实**状态码（不许一律写死 402）', async () => {
    const cloud = installKeyRejectedCloud();
    try {
      const { requireCloudAvailable } = await import('@/utils/supabase/cloudAvailability');
      const { readHttpStatus } = await import('@/core/backendUnavailable');

      let caught: unknown = null;
      try {
        await requireCloudAvailable('测试');
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, '探活拿到 401 ⇒ 闸门必须拦下来（抛错）');
      assert.equal(
        readHttpStatus(caught),
        401,
        '错误里必须带**真实**状态码（401）—— 写死 402 会让诊断与日志把 401 说成 402'
      );
    } finally {
      cloud.restore();
    }
  });
});
