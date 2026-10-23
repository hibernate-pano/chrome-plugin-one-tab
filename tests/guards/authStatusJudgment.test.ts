/**
 * 「云端状态」的判据守卫（2026-10-23，第 51 轮）。
 *
 * ── 这条守卫盯三件事 ──────────────────────────────────────────────────────
 * ① **「等到期限」这一档落在哪儿**（`core/backendUnavailable.ts` 的
 *    `classifyDeadlineOutcome` + `utils/supabase/sessionRead.ts` 的落地）：
 *    「等到期限」只说明「我们不等了」⇒ 它**本身**是「**不知道**」；
 *    但若刚刚真的**观测到**「云端不可用」，那一档就是「云端不可用」
 *    （等我们恢复），**不是「请重试」**（项目被限制时重试一万次结果一样）。
 *
 * ② **真实 HTTP 状态码压过响应体里的自报状态码**（`readHttpStatus`）：
 *    `status` / `httpStatus` 是**顶层**字段（传输层/SDK 写上去的 ⇒ 真实）；
 *    `http_status` 在**响应体里**（服务端的自述 ⇒ 可能是假的）。
 *    ⇒ 真 503 被自报的 400 压过 ⇒ 判据说「不是服务端不可用」⇒ 说「请重试」。
 *
 * ③ **配置读取读不到就返回 null**（`utils/supabase/config.ts`）：
 *    `import.meta.env` 的读取**本身**可能抛 ⇒ 它抛 ⇒ 探活抛 ⇒
 *    「**不知道**」被读成「**崩了**」。
 *
 * ── 为什么必须是**行为级**断言 ────────────────────────────────────────────
 * 这三条判据都藏在**函数**里：把它们改坏（改对或改坏）都不会让任何**类型**
 * 报错 ⇒ 只能靠「真的调它、看结果」来验。
 * 只对着**源码长相**断言 ⇒ 把判据换成空实现也照样绿 = 零检测力
 * （本仓已知的坑，见 `tests/guards/overwriteDownloadPreviewMatchesActual.test.ts`
 * 的头注）。
 *
 * ── 为什么这条守卫**自包含** ──────────────────────────────────────────────
 * 自己装环境桩、自己 `register` 别名加载器 ⇒ 不依赖别的测试文件留下的状态
 * （模块级状态会跨用例残留，见 `utils/supabase/outageTracker.ts` 的
 * `__resetOutageTrackerForTests` 的注释）。
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * 环境桩（**必须在任何 `await import('@/utils/supabase/...')` 之前**装好）。
 *
 * ⚠️ 为什么它必须是一个**对象引用**而不是每次现造：别名加载器
 * （`tests/_alias-loader.mjs`）把 `import.meta.env` 换成
 * `globalThis.__TABSTACK_META_ENV__` 的**引用** ⇒ 之后**改这个对象的属性**，
 * 被测模块读到的就是改后的值 —— ③ 那条「env 读取会抛」正是靠这个做的
 * （把属性换成会抛的 getter）。
 */
const ENV_STUB = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
globalThis.__TABSTACK_META_ENV__ = ENV_STUB;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOADER_PATH = pathToFileURL(resolve(ROOT, 'tests/_alias-loader.mjs')).href;

before(async () => {
  register(LOADER_PATH);
});

/** 装一个「云端答了 200」的 fetch 桩（探活要问一句 `/auth/v1/health`）。 */
const installFetchStub = (): (() => void) => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
};

/** 一个**永不 settle** 的 Promise（模拟「SDK 还在退避重试，迟迟不返回」）。 */
const neverSettles = (): Promise<never> =>
  new Promise<never>(() => {
    /* 故意不 settle */
  });

/** 抓住一次异步调用抛出的错误（不吞、不改写）。 */
const captureError = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  return null;
};

/** 让出一次事件循环（等探活那一问走完）。 */
const nextTick = (): Promise<void> =>
  new Promise<void>(resolve => setTimeout(resolve, 0));

/** 读会话的等待上限（测试里缩短；生产值是 `SESSION_READ_DEADLINE_MS` = 5 秒）。 */
const TEST_DEADLINE_MS = 200;

describe('① 「等到期限」这一档：观测到「云端不可用」⇒ 说「云端不可用」，否则说「不知道」', () => {
  beforeEach(async () => {
    // 模块级状态会跨用例残留 ⇒ 每条用例都从「什么都没观测到」开始。
    const { __resetOutageTrackerForTests } = await import('@/utils/supabase/outageTracker');
    __resetOutageTrackerForTests();
  });

  it('期限到了 + 期间观测到「云端不可用」⇒ 抛 BackendUnavailableError（机器码 backend_unavailable）', async () => {
    const { readSessionSafely } = await import('@/utils/supabase/sessionRead');
    const { outageTracker } = await import('@/utils/supabase/outageTracker');
    const { BackendUnavailableError } = await import('@/core/backendUnavailable');
    const { isDeadlineExceeded } = await import('@/utils/deadline');

    const restoreFetch = installFetchStub();
    try {
      const pending = readSessionSafely(
        () => neverSettles(),
        '同步侧读会话',
        TEST_DEADLINE_MS,
      );
      // 让探活先跑完（它问了一句「云端在吗」⇒ 答了 200）。
      await nextTick();
      // ⚠️ 故障发生在**等待期间**：SDK 的刷新撞上 402 ⇒ fetch 咽喉记一笔
      // 「刚刚不可用」⇒ 这一次的「等不到」是**有证据**的，不是猜的。
      outageTracker.noteUnavailable();

      const err = await captureError(() => pending);
      assert.ok(
        err instanceof BackendUnavailableError,
        '期限到了 + 已观测到「云端不可用」⇒ 那一档必须是「云端不可用」（等我们恢复），' +
          '不是「请重试」—— 项目被限制时重试一万次结果一样',
      );
      assert.equal(
        (err as { code?: string }).code,
        'backend_unavailable',
        '机器码必须活着（上游按它分类，不解析 message）',
      );
      assert.equal(
        isDeadlineExceeded(err),
        false,
        '不许还是「等到期限了」—— 那一档对上游没有意义（它不知道该说等我们恢复还是说请重试）',
      );
    } finally {
      restoreFetch();
    }
  });

  it('期限到了 + **没有**观测到「云端不可用」⇒ 那一档是「不知道」（原样带出 DeadlineExceededError）', async () => {
    const { readSessionSafely } = await import('@/utils/supabase/sessionRead');
    const { isDeadlineExceeded } = await import('@/utils/deadline');
    const { isBackendUnavailableError } = await import('@/core/backendUnavailable');

    const restoreFetch = installFetchStub();
    try {
      const pending = readSessionSafely(
        () => neverSettles(),
        '同步侧读会话',
        TEST_DEADLINE_MS,
      );
      await nextTick();

      const err = await captureError(() => pending);
      assert.ok(
        isDeadlineExceeded(err),
        '没有观测到「云端不可用」时，「等到期限」就是「**不知道**」—— ' +
          '绝不许被读成「没登录」，也绝不许被读成「云端不可用」',
      );
      assert.equal(
        isBackendUnavailableError(err),
        false,
        '「不知道」不许被说成「云端不可用」（那会把用户的网络说成我们挂了）',
      );
    } finally {
      restoreFetch();
    }
  });

  it('机器码在**归一**这一步也不许丢（没带状态码的专用错误不能被降级成普通 Error）', async () => {
    const { toSessionReadError } = await import('@/utils/supabase/sessionRead');
    const { BackendUnavailableError, isBackendUnavailableError } = await import(
      '@/core/backendUnavailable'
    );
    // 改判出来的错误**没有状态码**（观测只记了「什么时候不可用」）。
    // 归一那一步若只认状态码 ⇒ 它会被降级成普通 Error ⇒ `code` 丢掉
    // ⇒ 上游又落回「请重试」。
    const normalized = toSessionReadError(
      new BackendUnavailableError('云端项目暂时不可用（测试）'),
      '标签',
    );
    assert.equal(
      isBackendUnavailableError(normalized),
      true,
      '机器码「backend_unavailable」不许在归一这一步丢掉 —— ' +
        '丢掉它就等于退回到「请重试」（项目被限制时重试一万次结果一样）',
    );
  });

  it('判据层（纯函数）：只有「期限到了 **且** 观测到不可用」才是「云端不可用」', async () => {
    const { classifyDeadlineOutcome } = await import('@/core/backendUnavailable');
    assert.equal(
      classifyDeadlineOutcome({
        deadlineExceeded: true,
        cloudUnavailableObserved: true,
      }),
      'backend_unavailable',
    );
    assert.equal(
      classifyDeadlineOutcome({
        deadlineExceeded: true,
        cloudUnavailableObserved: false,
      }),
      'unknown',
      '没有观测就是「不知道」',
    );
    assert.equal(
      classifyDeadlineOutcome({
        deadlineExceeded: false,
        cloudUnavailableObserved: true,
      }),
      'unknown',
      '不是「等到期限」就与这一档无关（那一条是别的失败，不许被改判）',
    );
  });
});

describe('② 真实 HTTP 状态码必须压过响应体里的自报状态码', () => {
  it('顶层 status（传输层观测到的）压过响应体里的 http_status（服务端自述）', async () => {
    const { readHttpStatus } = await import('@/core/backendUnavailable');
    // 形状：REST 错误体（服务端自己带了一个 http_status）+ 传输层看到的真实状态码。
    assert.equal(
      readHttpStatus({ message: 'Service for this project is restricted', http_status: 400, status: 503 }),
      503,
      '真实状态码必须压过自报状态码 —— 真 503 被读成 400 ⇒ 判据说「不是服务端不可用」⇒ 界面说「请重试」',
    );
  });

  it('既有三种形状一个都不能丢：postgrest（http_status）/ auth-js（status）/ 我们的（httpStatus）', async () => {
    const { readHttpStatus, BackendUnavailableError } = await import('@/core/backendUnavailable');

    // postgrest-js 2.118 的错误**没有** status（错误体只有 message/code/…）。
    assert.equal(
      readHttpStatus({ message: 'Service for this project is restricted', http_status: 402 }),
      402,
      'postgrest 形状必须仍然读得到 402',
    );
    // auth-js 的 AuthApiError 带 status。
    assert.equal(
      readHttpStatus(Object.assign(new Error('boom'), { name: 'AuthApiError', status: 402 })),
      402,
      'auth-js 形状必须仍然读得到 402',
    );
    // 我们的 BackendUnavailableError 用 httpStatus。
    assert.equal(
      readHttpStatus(new BackendUnavailableError('云端项目暂时不可用', 503)),
      503,
      '我们自己的错误类必须仍然读得到状态码',
    );
  });

  it('专用错误的**机器码**必须被 isBackendUnavailable 认（没状态码时也不许漏判）', async () => {
    const { isBackendUnavailable, BackendUnavailableError } = await import(
      '@/core/backendUnavailable'
    );

    // 401 **不在** `UNAVAILABLE_STATUS_CODES` 里（那个集合的语义是「哪些 HTTP
    // 状态码算服务端不服务」，另有用途，不许为此改它）⇒ 只认状态码就漏判。
    assert.equal(
      isBackendUnavailable(new BackendUnavailableError('云端项目暂时不可用（apikey 被拒）', 401)),
      true,
      '专用错误必须被 isBackendUnavailable 认 —— 网关拒了 apikey 那一档拿到的就是 401，' +
        '而 401 不在「不可用状态码」集合里 ⇒ 漏判它 ⇒ 用户看到「请稍后重试」（错方向）',
    );

    // 「没有状态码」不是假设：探活的记忆窗口那一支、期限改判那一支都是这一形状。
    assert.equal(
      isBackendUnavailable(new BackendUnavailableError('云端项目暂时不可用')),
      true,
      '**没有状态码**的专用错误同样必须被认（探活记忆窗口 / 期限改判都是这一形状）',
    );

    // 反面：普通错误不许被误判（这一档只在「我们自己下的结论」上放宽）。
    assert.equal(
      isBackendUnavailable(new Error('请稍后重试')),
      false,
      '普通 Error 不许被说成「云端不可用」（那是甩锅给云端）',
    );
  });

  it('真 503 被自报的 400 压过时，判据仍说「云端不可用」', async () => {
    const { isBackendUnavailable } = await import('@/core/backendUnavailable');
    assert.equal(
      isBackendUnavailable({ message: '网关错误', http_status: 400, status: 503 }),
      true,
      'HTTP 503 必须在「服务端不可用」这一档里（等我们恢复，不是请重试）',
    );
  });
});

describe('③ 配置读不到就返回 null（不许抛）', () => {
  afterEach(async () => {
    // 还原 env（③ 那条用例把它换成会抛的 getter）。
    Object.defineProperty(ENV_STUB, 'VITE_SUPABASE_URL', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: 'https://stub.supabase.co',
    });
    const { __resetSupabaseConfigCacheForTests } = await import('@/utils/supabase/config');
    __resetSupabaseConfigCacheForTests();
  });

  it('env 读取抛错 ⇒ 返回 null（把「不知道」读成「崩了」是不允许的）', async () => {
    const { getSupabaseConfig, __resetSupabaseConfigCacheForTests } = await import(
      '@/utils/supabase/config'
    );
    __resetSupabaseConfigCacheForTests();

    // 把 env 的读取换成**会抛**的 getter（模拟 env 被换掉 / getter 炸了）。
    Object.defineProperty(ENV_STUB, 'VITE_SUPABASE_URL', {
      configurable: true,
      get() {
        throw new Error('env 读取炸了');
      },
    });

    // ⚠️ 断言必须落在**我们自己**的句子上 ⇒ 所以这里自己接住异常：
    // 否则「抛出来」会让用例以异常结束，失败输出里看不到我们写的判据。
    let config: unknown = 'NOT_CALLED';
    let thrown: unknown = null;
    try {
      config = getSupabaseConfig();
    } catch (err) {
      thrown = err;
    }
    assert.equal(
      thrown,
      null,
      '读不到配置必须返回 null（= 还没配 / 不知道），不许把「不知道」抛成「崩了」',
    );
    assert.equal(
      config,
      null,
      '读不到配置必须返回 null（= 还没配 / 不知道），不许把「不知道」抛成「崩了」',
    );
  });

  it('成功的那次结果被缓存（不再重读 env）⇒ DEV 日志也只会打一次', async () => {
    const { getSupabaseConfig, __resetSupabaseConfigCacheForTests } = await import(
      '@/utils/supabase/config'
    );
    __resetSupabaseConfigCacheForTests();

    const first = getSupabaseConfig();
    assert.ok(first, '前提：配置读得到');

    // 让 env 变成会抛的 ⇒ 再读一次**仍然拿得到配置** ⇒ 说明它来自缓存。
    Object.defineProperty(ENV_STUB, 'VITE_SUPABASE_URL', {
      configurable: true,
      get() {
        throw new Error('env 读取炸了');
      },
    });

    let second: unknown = 'NOT_CALLED';
    let thrown: unknown = null;
    try {
      second = getSupabaseConfig();
    } catch (err) {
      thrown = err;
    }
    assert.equal(thrown, null, '读配置不许抛（读不到就是 null）');
    assert.deepEqual(
      second,
      first,
      '成功的那次结果必须被缓存 —— 配置是构建期常量（运行时不变），' +
        '每次探活都重跑一遍解析是纯浪费，DEV 日志也会一行行刷屏',
    );
  });
});
