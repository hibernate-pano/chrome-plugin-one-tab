/**
 * 云端不可用（402）时，**本机会话不许被删掉**（2026-10-23，第 51 轮）。
 *
 * ── 这条缺陷是什么 ──────────────────────────────────────────────────────
 * 2026-10-23 的真机验证（`scripts/lead-verify-auth-unknown.mjs`）抓到的：
 * 云端返回 **402（项目被限制 / egress 配额超限，生产实测 2026-10-22）** 时，
 *
 *   ① **auth SDK 认定「刷新令牌被拒」⇒ 删掉用户存储里的会话**
 *      （`@supabase/auth-js` 2.118 的 `_callRefreshToken`：非「瞬时故障」的
 *      错误 + 访问令牌已过期 ⇒ `_removeSession()`）；
 *   ② 我们的界面于是说「未登录」，并把本机登录缓存一起清掉；
 *   ③ 用户去重新输密码 —— 而 402 期间重新登录**必然失败** ⇒ 死循环；
 *   ④ 云端恢复后，用户**必须**重新登录（会话令牌已经被 SDK 删了）。
 *
 * ① 这一步发生在**我们的代码之外**（在 SDK 里）⇒ 只测「我们怎么分类一个错误」
 * 的单测**永远绿** ⇒ 必须拿**真 SDK** 打一次 402 才看得见。
 *
 * ── 两道防线，各自都要有守卫 ────────────────────────────────────────────
 *   · **第一道（主）**：**先问一句**「云端在吗」（`utils/supabase/cloudAvailability.ts`）
 *     —— 明确不可用就**不碰 SDK** ⇒ 刷新压根不发生 ⇒ 会话连读都没被读。
 *   · **第二道（兜底）**：万一云端在「问」与「刷」之间挂掉（竞态），
 *     那就靠**状态码翻译**（`core/authSdkStatus.ts`）：把「服务端现在不服务」
 *     在 auth 端点上翻译成 SDK 眼里的「瞬时故障」⇒ SDK 不删会话。
 *
 * ⚠️ 两道防线**互相不替代**：只有第一道 ⇒ 竞态那一次仍会删会话；
 * 只有第二道 ⇒ 每次故障都要打 8 次、退避 25.4 秒（用户白等 25 秒）。
 *
 * ── 判据不靠文案匹配 ────────────────────────────────────────────────────
 * 与本仓纪律一致：分类依据一律是**机器字段**（HTTP 状态码 / 错误类名），
 * 文案只在最后一步被断言（「界面说了什么」本身就是「说谎」这件事的定义）。
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

/**
 * 每条用例之前把「云端观测」清空。
 *
 * ⚠️ 为什么必须清（2026-10-23，第 51 轮）：观测状态是**模块级**的
 * （`utils/supabase/outageTracker.ts`）—— 前一条用例观测到「不可用」，
 * 这一条就会**跳过探活**（直接吃记忆）⇒
 *   · 「应当问过一句「云端在吗」」那条断言会变成**假红**；
 *   · 「不许问刷新端点」那条会变成**假绿**（压根没经过闸门）。
 */
beforeEach(async () => {
  const { __resetOutageTrackerForTests } = await import('@/utils/supabase/outageTracker');
  __resetOutageTrackerForTests();
});

/**
 * 会话存储键：由 Supabase URL 的 projectRef 派生。
 * 测试环境里 URL 是 `https://stub.supabase.co` ⇒ projectRef = `stub`。
 */
const SESSION_KEY = 'sb-stub-auth-token';
const USER_ID = 'user-r51-outage';
const USER_EMAIL = 'outage@example.com';

/**
 * 一份**已过期**的会话（⇒ SDK 会去刷新 ⇒ 刷新撞上 402）。
 *
 * ⚠️ token 值必须运行时拼接：字面量会被凭据扫描器判成「硬编码凭据」
 * （见 `tests/_helpers/stubSession.ts` 的同款说明）。
 *
 * ⚠️ **每条用例必须用不同的刷新令牌**（`refreshTag`）：auth SDK 会把
 * 「上一次刷新失败」缓存 60 秒，而那份缓存是**按刷新令牌**索引的
 * （`lastRefreshFailure.refreshToken === refreshToken`）⇒
 * 同一枚令牌会让后一条用例**根本不发请求**（直接吃缓存）⇒
 * 「SDK 有没有被问去刷新」这条断言就**恒真**（守卫失去检测力，且是假绿）。
 */
const expiredSessionJson = (userId: string, refreshTag: string): string => {
  const access = ['stub', 'expired', 'access', 'token'].join('-');
  const refresh = ['stub', 'expired', 'refresh', 'token', refreshTag].join('-');
  return JSON.stringify({
    access_token: access,
    token_type: 'bearer',
    expires_in: 3600,
    // 已过期 ⇒ getSession() 会去刷新（这正是要走的路径）
    expires_at: Math.floor(Date.now() / 1000) - 60,
    refresh_token: refresh,
    user: {
      id: userId,
      aud: 'authenticated',
      role: 'authenticated',
      email: USER_EMAIL,
      app_metadata: {},
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  });
};

describe('第 51 轮：云端不可用（402）时，本机会话不许被删掉', () => {
  it('① 兜底防线：真 SDK 刷新撞上 402 之后，会话令牌仍在存储里', async () => {
    const { installEngineStorageEnv } = await import('../_helpers/engineStorageEnv.ts');
    const env = installEngineStorageEnv();
    const { installFakePostgrestCloud } = await import('../_helpers/fakePostgrestCloud.ts');
    // 假云端模拟「整个项目被限制」：所有请求都返回 402（生产实测形状）。
    const cloud = installFakePostgrestCloud({ unavailable: true });
    try {
      const { supabase } = await import('@/utils/supabase/client');
      env.chromeData.set(SESSION_KEY, expiredSessionJson(USER_ID, 'one'));

      // ⚠️ 这一条**故意绕开**「先问云端在吗」那道闸门（直接调 SDK）：
      // 它验的是**最后一道防线** —— 就算刷新真的发生了（竞态），
      // SDK 也不许把用户的会话删掉。
      //
      // ⚠️ 这一条**要等 25 秒**：402 被翻译成 SDK 眼里的「瞬时故障」后，
      // SDK 会连打 8 次、退避 25.4 秒（`_refreshAccessToken` 的 `retryable()`）。
      // 守卫必须等这阵风暴过去才有检测力（改坏时它**立刻**变红：SDK 第一次
      // 失败就把会话删了）。
      const { data, error } = await supabase.auth.getSession();

      // ★ 本条守卫的核心：会话令牌**不许**被删掉。
      //
      // ⚠️ 为什么这条**排在最前面**（2026-10-23 当天续写）：改坏时（不翻译
      // 402）SDK 会先删掉会话，再把失败**吞成「没有会话」**
      // （`{session: null, error: null}`）⇒ 「失败必须被带出来」那条会先红
      // ⇒ 变异自证就看不出「它抓的是哪一条」⇒ 报「红在别的断言上」。
      // ⇒ 先钉**最要命的那条**（会话还在不在）。
      assert.ok(
        env.chromeData.get(SESSION_KEY),
        '云端不可用时**不许**删掉用户的会话令牌 —— ' +
          'SDK 把 402 当成「刷新令牌被拒」⇒ 会话被删 ⇒ 用户被静默登出，' +
          '而 402 期间重新登录必然失败 ⇒ 死循环'
      );

      // 失败必须被带出来（吞掉它 ⇒ 上游读成「没有会话」⇒ 说「未登录」）。
      assert.ok(error, '刷新失败必须把错误带出来（吞掉它就等于说「没登录」）');
      assert.equal(
        data?.session ?? null,
        null,
        '这一轮确实没拿到会话（刷新失败）—— 但这不代表用户没登录'
      );

      // 分类：必须是「服务端不可用」，不是「会话真的死了」。
      const { classifySessionFailure } = await import('@/core/sessionFailure');
      assert.equal(
        classifySessionFailure(error).kind,
        'backend_unavailable',
        '402 必须被分类成「服务端不可用」（等我们恢复），不是「请重新登录」'
      );
    } finally {
      cloud.restore();
    }
  });

  it('② 主防线：云端不可用时**根本不问 SDK 刷新**，界面也不说「未登录」', async () => {
    const { installEngineStorageEnv } = await import('../_helpers/engineStorageEnv.ts');
    const env = installEngineStorageEnv();
    const { installFakePostgrestCloud } = await import('../_helpers/fakePostgrestCloud.ts');
    const cloud = installFakePostgrestCloud({ unavailable: true });
    try {
      const { store } = await import('@/store');
      const { setFromCache, getCurrentUser } = await import('@/store/slices/authSlice');

      // 界面首屏读的就是这份缓存（auth_cache）。
      env.chromeData.set(SESSION_KEY, expiredSessionJson(USER_ID, 'two'));
      env.chromeData.set('auth_cache', {
        user: { id: USER_ID, email: USER_EMAIL },
        isAuthenticated: true,
        timestamp: Date.now(),
      });
      // 弹窗/设置页首屏：先把缓存那份登录态送进 store（= 界面第一帧的样子）。
      store.dispatch(
        setFromCache({
          user: { id: USER_ID, email: USER_EMAIL, lastLogin: new Date().toISOString() },
          isAuthenticated: true,
          statusKind: 'unchecked',
        })
      );

      // 核一次（核不到 ⇒ thunk 必须 **reject**，不能 resolve(null)）。
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

      const auth = store.getState().auth;
      assert.equal(
        auth.authStatusKind,
        'backend_unavailable',
        '这一档必须是「云端不可用」，不是「未登录」'
      );
      assert.equal(
        auth.isAuthenticated,
        true,
        '登录态按缓存保留（用户多半登录着，只是确认不了）'
      );
      assert.ok(
        env.chromeData.get('auth_cache'),
        '本机登录缓存不许被清掉 —— 清掉它 = 告诉用户「你没登录」'
      );
      assert.ok(
        env.chromeData.get(SESSION_KEY),
        '会话令牌不许被清掉'
      );

      // ★ 主防线的**检测点**：SDK 的刷新端点**一次都不许被问**。
      //
      // 为什么必须断言「没发生什么」：会话「还在」这件事，在「刷新压根没发生」
      // 与「刷新发生了但没删会话」两种情况下**都成立** ⇒ 只断言会话还在，
      // 这条守卫在「主防线被拆掉」时**照样绿**（假绿）。
      // ⇒ 唯一能区分的办法是看**请求日志**：刷新端点被问过 ⇒ 主防线没起作用。
      const tokenRequests = cloud.requests.filter(r => r.includes('/auth/v1/token'));
      assert.deepEqual(
        tokenRequests,
        [],
        '云端明确不可用时**不许**让 SDK 去刷新会话 —— ' +
          '刷新撞上 402 会让 SDK 删掉用户的会话（一次云端故障 = 一次全员登出）'
      );
      assert.ok(
        cloud.requests.some(r => r.includes('/auth/v1/health')),
        '应当**问过一句**「云端在吗」（探活请求）—— 没问就是压根没做这道防线'
      );
    } finally {
      cloud.restore();
    }
  });

  it('③ 判据层：「服务端不可用」在 auth 端点上必须被翻译成 SDK 眼里的「瞬时故障」', async () => {
    const { statusForAuthSdk, AUTH_SDK_TRANSIENT_STATUSES } = await import(
      '@/core/authSdkStatus'
    );
    const { UNAVAILABLE_STATUS_CODES } = await import('@/core/backendUnavailable');
    const { classifyAvailabilityStatus } = await import('@/core/cloudAvailability');

    const authUrl = 'https://stub.supabase.co/auth/v1/token?grant_type=refresh_token';
    const loginUrl = 'https://stub.supabase.co/auth/v1/token?grant_type=password';
    const restUrl = 'https://stub.supabase.co/rest/v1/tab_groups';

    // auth 端点上的「服务端不可用」⇒ 翻译成 SDK 当作瞬时故障的状态码。
    for (const status of UNAVAILABLE_STATUS_CODES) {
      const translated = statusForAuthSdk(authUrl, status);
      assert.ok(
        AUTH_SDK_TRANSIENT_STATUSES.has(translated),
        `auth 端点上的 HTTP ${status} 必须翻译成 SDK 眼里的「瞬时故障」` +
          `（否则 SDK 会把一次云端故障当成「刷新令牌已死」并删掉用户的会话）`
      );
      assert.equal(
        statusForAuthSdk(authUrl, status),
        translated,
        '同一个输入必须得到同一个输出（纯函数）'
      );
    }

    // REST 端点不翻译（那边没有破坏性后果，范围越小越安全）。
    assert.equal(
      statusForAuthSdk(restUrl, 402),
      402,
      'REST 端点的状态码不许被改（判据读的是它注入的 http_status）'
    );

    // 用户侧错误**不许**被翻译 —— 400 是「刷新令牌真的被拒」，
    // 那时 SDK 删会话是**对的**，翻译它会把「请重新登录」变成谎话。
    //
    // ⚠️ 429 是**例外**，且只限**刷新端点**（2026-10-23，第 51 轮）：
    // 刷新端点上的 429 = 「慢一点（限流）」，不是「你的凭证不对」
    // ⇒ 不翻译 ⇒ SDK 当成「明确拒绝」⇒ **删掉用户的会话**
    // ⇒ 一次限流 = 一次全员登出。
    // 而**登录**端点上的 429 = 「尝试太频繁」⇒ 那句话本来就该给用户看
    // ⇒ 不许翻译。
    for (const status of [400, 404, 409, 422]) {
      assert.equal(
        statusForAuthSdk(authUrl, status),
        status,
        `HTTP ${status} 是用户侧问题，不许被翻译成「瞬时故障」`
      );
    }
    assert.equal(
      statusForAuthSdk(authUrl, 429),
      503,
      '**刷新端点**上的 429（限流）必须被翻译成「瞬时故障」—— ' +
        '否则一次限流就是一次全员登出（SDK 把 429 当成「刷新令牌已死」）'
    );
    assert.equal(
      statusForAuthSdk(loginUrl, 429),
      429,
      '**登录端点**上的 429（尝试太频繁）不许被翻译 —— ' +
        '那句话本来就该给用户看，翻译了就变成「等我们恢复」'
    );

    // ── 刷新端点上的 401/403：只有「网关拒了我们的 key」才翻译 ────────────
    //
    // ⚠️ 为什么这两个码要单独判（2026-10-23，第 51 轮）：生产实测，
    // key 被拒（key 轮换 / 项目暂停 / key 配错）时网关回的是 **401**：
    //   · 不带 apikey       ⇒ 401（message: No API key found in request）
    //   · 带一个错的 apikey ⇒ 401（message: Invalid API key）
    // ⇒ 那不是「你的刷新令牌被拒」，而是「**我们的凭证根本没被评估**」
    // ⇒ 删掉用户的会话是**误伤** ⇒ 必须翻译成「瞬时故障」。
    //
    // ⚠️ 但**反过来**：**GoTrue 自己的判决**不许被翻译 ——
    // 刷新令牌真的被拒 ⇒ 会话真的死了 ⇒ 删掉它是对的
    // ⇒ 用户该看到「请重新登录」，而不是「等我们恢复」。
    // ⇒ 判据是「body 里有没有 GoTrue 的**机器字段**」（error / error_code /
    //    code），不是「句子里写了什么」—— 与本仓「文案不许成为判据」同源。
    assert.equal(
      statusForAuthSdk(authUrl, 401),
      503,
      '刷新端点上的 401（body 里没有 GoTrue 的机器字段）必须被翻译 —— ' +
        '那是「网关拒了我们的 key」，凭证根本没被评估，删会话是误伤'
    );
    assert.equal(
      statusForAuthSdk(authUrl, 403),
      503,
      '刷新端点上的 403（同一族）同样必须被翻译'
    );
    assert.equal(
      statusForAuthSdk(authUrl, 401, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' }),
      401,
      'GoTrue 自己判的 401（body 里有 error 字段）不许被翻译 —— 会话真的死了'
    );
    assert.equal(
      statusForAuthSdk(authUrl, 401, { code: 'refresh_token_not_found' }),
      401,
      'GoTrue 自己判的 401（body 里有 code 字段）不许被翻译 —— 会话真的死了'
    );
    assert.equal(
      statusForAuthSdk(loginUrl, 401),
      401,
      '**登录端点**上的 401（密码不对）不许被翻译 —— 那是用户侧的问题'
    );
    assert.equal(
      statusForAuthSdk(restUrl, 401),
      401,
      'REST 端点的状态码不许被改（那边没有破坏性后果）'
    );

    // ── 探活的判据：状态码 ⇒ 云端在不在服务 ──────────────────────────────
    for (const status of UNAVAILABLE_STATUS_CODES) {
      assert.equal(
        classifyAvailabilityStatus(status),
        'unavailable',
        `HTTP ${status} 必须判成「云端不可用」（等我们恢复）`
      );
    }
    // 401/403：**探活带了 apikey、不带用户令牌** ⇒ 这不可能是「用户没登录」，
    // 只能是「网关拒了我们的 key」。生产实测（2026-10-23，对着线上项目打的）：
    //   · 不带 apikey      ⇒ 401 `{"message":"No API key found in request"}`
    //   · 带一个错的 apikey ⇒ 401 `{"message":"Invalid API key"}`
    // ⇒ key 被拒之后**每个**请求都会以同样方式失败 ⇒ 刷新请求也会拿到 401
    // ⇒ SDK 删掉用户的会话 ⇒ 探活这一关必须 fail-closed（判「不可用」）。
    for (const status of [401, 403]) {
      assert.equal(
        classifyAvailabilityStatus(status),
        'unavailable',
        `探活拿到 HTTP ${status} ⇒「我们的 key 被拒」⇒ 必须判成「云端不可用」—— ` +
          '放行 ⇒ SDK 刷新拿到 401 ⇒ 用户的会话被删掉（一次配置故障 = 一次全员登出）'
      );
    }
    // 其它任何应答都判「在服务」—— 它**答了**就是还在服务
    //（404 是健康检查的常见回答；判成「不可用」就是把用户的网络说成我们挂了）。
    for (const status of [200, 201, 204, 400, 404, 409, 429]) {
      assert.equal(
        classifyAvailabilityStatus(status),
        'available',
        `HTTP ${status} 说明云端**答了** ⇒ 必须判成「在服务」`
      );
    }
  });
});
