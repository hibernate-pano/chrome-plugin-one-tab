/**
 * 云端故障（402）期间，**面向用户的那几句话**必须说得对（2026-10-23，第 52 轮）。
 *
 * ── 这一轮修的是三处「说错方向 / 做不到」───────────────────────────────
 * ① **登录 / 注册在云端故障时说错了话**：说的是「登录失败，请稍后重试」——
 *    那是**错方向**（`core/authSdkStatus.ts` 自己就是这么判的）：项目被限制时
 *    重试一万次也一样，而用户会以为**自己密码错了** ⇒ 反复改密码、重新注册。
 *    第 51 轮修好会话之后，用户更可能真的走到登录这一步 ⇒ 撞上这句话的概率更高。
 *
 * ② **云端故障期间登不出去（换不了账号）**：auth-js 2.118 的 `_signOut`
 *    **先**走 `_useSession` ⇒ 本地会话过期时它先去刷新 ⇒ 刷新撞上故障 ⇒
 *    `_signOut` **直接早退** ⇒ `_removeSession()` 压根没被调用
 *    ⇒ 本机会话原样留着 ⇒ 用户想换个账号时登不出去。
 *
 * ③ **核账号没有上限**：`getUser()` 不在 5 秒上限内 ⇒ 弱网时整段「核对会话」
 *    仍可能拖到 45 秒（SDK 自带的 fetch 超时）⇒ 用户只看到「转圈」。
 *
 * ── 为什么这些断言必须是**行为级** ─────────────────────────────────────
 * 「源码里出现了某个判断」= 零检测力（把那个分支换成空数组，源码长相一点没变）。
 * ⇒ 这里**真的 dispatch 那些 thunk**、**真的对着假云端跑**，
 *   然后看**结果**（store 的那一档、错误里的机器标记、存储里的会话令牌）。
 *
 * ── 假云端为什么自己写一份（不用 `tests/_helpers/fakePostgrestCloud.ts`）──
 * 那份 helper 的 `unavailable: true` 会让**所有**端点都返回 402
 * ⇒ 探活端点（/auth/v1/health）也 402 ⇒ 「云端不可用」这一档只能被**假装**。
 * 而 ② 的两个关键场景需要**分别**控制「探活」与「登出端点」：
 *   · 探活 402 ⇒ 云端不可用 ⇒ **不许碰 SDK**（它会先刷新 ⇒ 卡 25 秒）；
 *   · 探活 200 + 登出 402 ⇒ 竞态 ⇒ SDK 的登出会失败 ⇒ 本机这一侧必须由我们兜住。
 * ⇒ 这里自己装一个能分别控制两端的假云端（并记下每个请求）。
 */
import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { installEngineStorageEnv } from '../_helpers/engineStorageEnv.ts';
import { stubSessionJson } from '../_helpers/stubSession.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOADER_PATH = pathToFileURL(resolve(ROOT, 'tests/_alias-loader.mjs')).href;
before(async () => {
  register(LOADER_PATH);
});

// ⚠️ 必须在任何 '@/…' 的 import 之前装：storage-kv 在首次 import 时选驱动。
const env = installEngineStorageEnv();

const USER_ID = 'user-r52-outage';
const USER_EMAIL = 'outage@example.com';
/** 会话存储键：由 Supabase URL 的 projectRef 派生（stub ⇒ 'stub'）。 */
const SESSION_KEY = 'sb-stub-auth-token';

/** 生产实测的 402 报文（项目被限制 / egress 配额超限）。 */
const RESTRICTED_BODY = {
  code: 402,
  error_code: 'project_restricted',
  message:
    'Service for this project is restricted due to the following violations: ' +
    'daily egress exceeded for project',
};

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** 假云端的可选项。 */
interface FakeCloudOptions {
  /** 探活端点（/auth/v1/health）的状态码。 */
  healthStatus: number;
  /** 其它端点的状态码。 */
  otherStatus: number;
  /** /auth/v1/user 要不要**挂住**（用来验「核账号有上限」）。 */
  hangUser?: boolean;
}

/** 假云端句柄。 */
interface FakeCloud {
  /** 每个请求的日志（`${method} ${pathname}${search}`）。 */
  requests: string[];
  /** 放行挂住的用户端点（并撤掉它的定时器）—— 让进程能立刻退出。 */
  release(): void;
  restore(): void;
}

/**
 * 装一个能**分别**控制探活端点与其它端点的假云端。
 *
 * ⚠️ 「用户端点挂住」用**定时器**而不是「永不 resolve」：
 *    永不 resolve 的话，一旦实现里那个上限被拆掉（正是变异自证要验的），
 *    这条用例会**永远挂着**（node 的测试超时是无限）⇒ 整套测试卡死。
 *    定时器给了它一个确定的终点（15 秒）⇒ 拆掉上限 ⇒ 用例在 15 秒后变红。
 *
 *    为什么是 15 秒：判据是「核账号必须在 8 秒内结束」⇒ 挂 15 秒 ⇒
 *    拆掉上限之后**稳稳地**越过判据（而不是擦边 7.9s 混过去）。
 */
const installFakeCloud = (opts: FakeCloudOptions): FakeCloud => {
  const requests: string[] = [];
  let releaseUser: (() => void) | null = null;
  let userTimer: ReturnType<typeof setTimeout> | null = null;
  const previousFetch = globalThis.fetch;

  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(
      typeof input === 'string' ? input : String((input as { url: string }).url),
    );
    const method = (init.method ?? 'GET').toUpperCase();
    requests.push(`${method} ${url.pathname}${url.search}`);

    if (url.pathname.endsWith('/auth/v1/health')) {
      return jsonRes({ healthy: true }, opts.healthStatus);
    }
    if (url.pathname.endsWith('/auth/v1/user')) {
      if (opts.hangUser) {
        return await new Promise<Response>((resolve) => {
          releaseUser = () => resolve(jsonRes({ id: USER_ID }));
          userTimer = setTimeout(() => resolve(jsonRes({ id: USER_ID })), 15_000);
        });
      }
      return jsonRes(
        { id: USER_ID, aud: 'authenticated', role: 'authenticated' },
        opts.otherStatus,
      );
    }
    // 登出端点 / 刷新端点 / 其它：统一按「服务端不可用」应答。
    return jsonRes(RESTRICTED_BODY, opts.otherStatus);
  }) as typeof fetch;

  return {
    requests,
    release() {
      if (userTimer) {
        clearTimeout(userTimer);
        userTimer = null;
      }
      releaseUser?.();
      releaseUser = null;
    },
    restore() {
      globalThis.fetch = previousFetch;
    },
  };
};

/** 把「这台机器登录着」摆进 store（模拟冷启动后缓存那份登录态）。 */
const seedLoggedIn = async (): Promise<void> => {
  const { store } = await import('@/store');
  const { setFromCache } = await import('@/store/slices/authSlice');
  store.dispatch(
    setFromCache({
      user: { id: USER_ID, email: USER_EMAIL, lastLogin: new Date().toISOString() },
      isAuthenticated: true,
      statusKind: 'authenticated',
    }),
  );
};

/** 把 store 复位成「没登录」（用例之间互不串味）。 */
const resetStore = async (): Promise<void> => {
  const { store } = await import('@/store');
  const { setFromCache } = await import('@/store/slices/authSlice');
  store.dispatch(
    setFromCache({ user: null, isAuthenticated: false, statusKind: 'not_authenticated' }),
  );
};

describe('第 52 轮：云端故障期间，这几句话必须说得对', () => {
  let facadeOverride: unknown = null;

  before(async () => {
    // 真实门面（SDK 客户端要真的在那儿 —— ② 的断言落在**真存储**上）。
    const realFacade = await import('@/utils/supabaseFacade');
    const { setSupabaseFacadeLoader } = await import('@/utils/supabaseRuntime');
    // 注入一个**会转发**的加载器：默认给真门面，用例需要时可以换成假门面。
    setSupabaseFacadeLoader(async () => (facadeOverride ?? realFacade) as never);
  });

  afterEach(async () => {
    facadeOverride = null;
    env.lsData.clear();
    env.chromeData.clear();
    // ⚠️ 必须忘掉「刚刚观测到云端不可用」那条记忆：
    //   `requireCloudAvailable` 有 5 秒的记忆窗口（省掉重复的探活往返）
    //   ⇒ 前一条用例观测到 402 会让后一条**压根不问**（直接吃记忆）
    //   ⇒ 「问过一句」那条断言会变成**假红**，「没碰 SDK」那条会变成**假绿**。
    const { __resetOutageTrackerForTests } = await import('@/utils/supabase/outageTracker');
    __resetOutageTrackerForTests();
    await resetStore();
  });

  it('① 402 期间登录失败 ⇒ 带「云端不可用」的机器标记，且不说「登录失败」', async () => {
    const cloud = installFakeCloud({ healthStatus: 402, otherStatus: 402 });
    try {
      const { store } = await import('@/store');
      const { signIn } = await import('@/store/slices/authSlice');
      const { isBackendUnavailableError } = await import('@/core/backendUnavailable');

      let rejected: unknown = null;
      try {
        await store.dispatch(signIn({ email: USER_EMAIL, password: 'pw' })).unwrap();
      } catch (err) {
        rejected = err;
      }

      assert.ok(rejected, '云端 402 时登录必须失败');
      assert.ok(
        isBackendUnavailableError(rejected),
        '402 期间登录失败必须带「云端不可用」的机器标记 —— ' +
          '否则上层读不到 backend_unavailable，界面就会说「登录失败，请稍后重试」（错方向）',
      );

      const auth = store.getState().auth;
      assert.equal(
        auth.authStatusKind,
        'backend_unavailable',
        '这一档必须是「云端不可用」，不是「未登录」',
      );
      assert.equal(auth.backendUnavailable, true, '机器标记必须留在 store 里');
      assert.ok(
        !/登录失败，请稍后重试/.test(auth.error ?? ''),
        `云端不可用时不许说「登录失败，请稍后重试」（实测：${auth.error}）—— ` +
          '那是错方向：用户会以为是自己密码错了，反复改密码、重新注册',
      );
      assert.match(auth.error ?? '', /云端/, '必须说清是「云端」这一侧的问题');
    } finally {
      cloud.restore();
    }
  });

  it('② 探活说「云端不可用」⇒ 不碰 SDK，本机照样登出去（用户能换账号）', async () => {
    const cloud = installFakeCloud({ healthStatus: 402, otherStatus: 402 });
    try {
      env.chromeData.set(SESSION_KEY, stubSessionJson(USER_ID));
      await seedLoggedIn();

      const { store } = await import('@/store');
      const { signOut } = await import('@/store/slices/authSlice');

      await store.dispatch(signOut()).unwrap();

      const auth = store.getState().auth;
      assert.equal(
        auth.isAuthenticated,
        false,
        '云端故障期间也必须登得出去 —— 登不出去 = 用户换不了账号',
      );
      assert.equal(auth.authStatusKind, 'not_authenticated', '本机登出是核到了的「没登录」');
      assert.equal(
        env.chromeData.get(SESSION_KEY),
        undefined,
        '本机会话令牌必须被清掉 —— 留着的话下次启动又登录上了',
      );
      assert.equal(auth.error, null, '本机登出成功了，不许说「退出登录失败」');

      // ⚠️ 「不许碰 SDK」要钉成**一个请求都不许发**，而不是只盯登出端点。
      //   （只盯登出端点的话，刷新端点被问过也照样绿 —— 而刷新端点一被问，
      //   SDK 就会把 401/402 当成「刷新令牌已死」⇒ 把用户的会话删掉。）
      //
      //   ⚠️ 这条断言成立的前提是**本机会话没过期**（本用例用的就是没过期那份）。
      //   原因（实测，2026-10-23）：`src/utils/supabase/client.ts` 在**模块加载时**
      //   就构造客户端（`export const supabase = initSupabaseClient()`）
      //   ⇒ auth-js 的 `initialize()` → `_recoverAndRefresh()`
      //   （GoTrueClient.js:4084）看到**过期**会话就自己发一次刷新
      //   ⇒ **探活闸门跑在构造之后，拦不住它**（云端 402 + 会话过期 ⇒ 实测仍打出
      //   4 次 `POST /auth/v1/token`）。⇒ 会话没过期时，构造期不发任何请求，
      //   这条断言才是「真的一个请求都没发」。
      const sdkRequests = cloud.requests.filter(r => !r.includes('/auth/v1/health'));
      assert.deepEqual(
        sdkRequests,
        [],
        '云端明确不可用 ⇒ 一个 SDK 请求都不许发 —— ' +
          'SDK 的 signOut 会先去刷新会话，刷新撞上故障就连打 8 次、退避 25.4 秒（界面卡 25 秒）',
      );
      // 探活必须真的问过（否则上面那条「没碰 SDK」的断言可能是因为压根没走到）。
      // ⚠️ 顺序：**先**钉「没碰 SDK」这条**危害**，**后**钉「问过探活」这条**前提** ——
      //   反过来（先钉前提）的话，「绕过闸门直接问 SDK」这个变异会红在前提上
      //   （绕过了闸门 ⇒ 压根没探活），而真正要钉的「SDK 被碰了」永远轮不到。
      assert.ok(
        cloud.requests.some(r => r.includes('/auth/v1/health')),
        '应当问过一句「云端在吗」（探活请求）',
      );
      assert.match(
        auth.notice ?? '',
        /已从本机登出/,
        '文案必须说清是「本机」这一档 —— scope=local 撤的是这一台，不是所有设备',
      );
    } finally {
      cloud.restore();
    }
  });

  it('② 探活过了但登出请求失败（竞态）⇒ 本机照样登出，且用 scope=local', async () => {
    const cloud = installFakeCloud({ healthStatus: 200, otherStatus: 402 });
    try {
      env.chromeData.set(SESSION_KEY, stubSessionJson(USER_ID));
      await seedLoggedIn();

      const { store } = await import('@/store');
      const { signOut } = await import('@/store/slices/authSlice');

      await store.dispatch(signOut()).unwrap();

      const auth = store.getState().auth;
      assert.equal(auth.isAuthenticated, false, '本机必须登出去了');
      assert.equal(
        env.chromeData.get(SESSION_KEY),
        undefined,
        '本机会话令牌必须被清掉',
      );
      assert.equal(
        auth.error,
        null,
        '服务端那一侧失败**不许**说成「退出登录失败」—— 本机已经登出去了',
      );

      const logoutRequest = cloud.requests.find(r => r.includes('/auth/v1/logout'));
      assert.ok(logoutRequest, '必须真的向服务端登出过（否则这条断言恒真）');
      assert.match(
        logoutRequest!,
        /scope=local/,
        '必须是 scope=local（只撤这一台）—— 全局登出会让用户以为所有设备都退了',
      );
    } finally {
      cloud.restore();
    }
  });

  it('② SDK 的登出失败且**没清本机会话** ⇒ 本机这一侧由我们自己兜住', async () => {
    const cloud = installFakeCloud({ healthStatus: 200, otherStatus: 200 });
    try {
      const realFacade = await import('@/utils/supabaseFacade');
      const realClient = realFacade.supabase.auth;
      const signOutCalls: Array<{ scope?: string }> = [];

      // ⚠️ 这里只**替换一件**东西：SDK 的 signOut 失败（且不清本机会话）。
      // 那不是编的：auth-js 2.118 的 `_signOut` 在「刷新失败」时**早退**
      // （GoTrueClient.js:3434-3436）⇒ `_removeSession()` 没被调用
      // ⇒ 本机会话原样留着。
      // 而**本机清理**用的是**真的** SDK 实现（bound 到真客户端）
      // ⇒ 断言落在**真存储**上，不是落在假身上。
      const fakeClient = {
        signOut: async (options: { scope?: string }) => {
          signOutCalls.push(options);
          return {
            data: null,
            error: Object.assign(
              new Error('Service for this project is restricted due to the following violations'),
              { status: 503 },
            ),
          };
        },
        _removeSession: (
          realClient as unknown as { _removeSession: () => Promise<void> }
        )._removeSession.bind(realClient),
      };
      facadeOverride = {
        readSessionSafely: realFacade.readSessionSafely,
        outageTracker: realFacade.outageTracker,
        supabase: { auth: fakeClient },
      };

      env.chromeData.set(SESSION_KEY, stubSessionJson(USER_ID));
      await seedLoggedIn();

      const { store } = await import('@/store');
      const { signOut } = await import('@/store/slices/authSlice');

      await store.dispatch(signOut()).unwrap();

      assert.equal(
        env.chromeData.get(SESSION_KEY),
        undefined,
        '本机会话必须被清掉 —— 哪怕 SDK 的 signOut 失败（它早退时不会清）',
      );
      const auth = store.getState().auth;
      assert.equal(auth.isAuthenticated, false, '本机必须登出去了');
      assert.deepEqual(
        signOutCalls,
        [{ scope: 'local' }],
        '必须用 scope=local（只撤这一台）',
      );
    } finally {
      facadeOverride = null;
      cloud.restore();
    }
  });

  it('③ 核账号超时 ⇒ 被截断成「核不到」，而不是拖满 45 秒', async () => {
    const cloud = installFakeCloud({ healthStatus: 200, otherStatus: 200, hangUser: true });
    try {
      env.chromeData.set(SESSION_KEY, stubSessionJson(USER_ID));

      const { requireSessionUserId } = await import('@/utils/supabase/session');
      const { isDeadlineExceeded } = await import('@/utils/deadline');
      const started = Date.now();
      let failed: unknown = null;
      try {
        await requireSessionUserId();
      } catch (err) {
        failed = err;
      }
      const elapsed = Date.now() - started;

      // ⚠️ 顺序有讲究：**先**断言「在上限内结束」，**后**断言「错误长什么样」。
      //   原因：把上限拆掉之后，核账号会一路挂到假云端的 15 秒定时器 ⇒
      //   那时它是**成功**的（没有错误）⇒ 若先断言「有错误」，红的位置就跑到
      //   别的理由上去了（看不出是「上限没了」）。⇒ 先钉时间，失败理由才指向
      //   这条守卫真正要守的东西。
      assert.ok(
        elapsed < 8_000,
        `核账号必须在上限内结束（实测 ${elapsed}ms）—— ` +
          '没有上限时它会一路拖到 SDK 自带的 45 秒 fetch 超时',
      );
      assert.ok(failed, '核账号失败必须把错误带出来（吞掉它就等于说「没登录」）');
      assert.ok(
        isDeadlineExceeded(failed),
        '必须是「等到期限」那一个（机器码 deadline_exceeded）—— ' +
          '没有上限时它会一路挂到 SDK 自带的 45 秒 fetch 超时',
      );
      const message = failed instanceof Error ? failed.message : String(failed);
      assert.ok(
        !/未登录|会话已过期|请重新登录/.test(message),
        `超时是「核不到」，不是「没登录」（实测：${message}）—— ` +
          '说成「请重新登录」会把用户推向一个必然失败的动作',
      );
    } finally {
      cloud.release();
      cloud.restore();
    }
  });
});
