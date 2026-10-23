/**
 * 「核账号」这一步**必须**有等待上限（2026-10-23，第 52 轮收口）。
 *
 * ── 这条守卫守的是什么 ──────────────────────────────────────────────────
 * 第 51 轮把「读会话」收口成唯一入口（`utils/supabase/sessionRead.ts`），
 * 第 52 轮把「核账号」也收口了（`utils/supabase/session.ts`
 * 的 `requireSessionUser`）—— **但 `download.ts` 的两处没跟上**。
 *
 * 后果（实测，2026-10-23，断网 + 本地会话未过期）：
 *
 *     requireSessionUserId()   5012 ms   ← 已修
 *     downloadTabGroups()     45003 ms   ← 未修
 *
 * ⇒ **9 倍差距**。机制：
 *   ① 断网 ⇒ 探活 `/auth/v1/health` 连不上 ⇒ 判「**不知道**」⇒ **放行**
 *      （这一档放行是**对的**：本地会话没过期时，SDK 读它根本不需要联网）；
 *   ② 本地会话没过期 ⇒ `getSession()` 从存储直接读出，不需要联网 ⇒ 通过；
 *   ③ 然后**裸** `supabase.auth.getUser()` 去打 `/auth/v1/user` ⇒ 挂住
 *      ⇒ 拖满 **45 秒**（SDK 自带的 `fetchWithTimeout` 上限）；
 *   ④ 而同步管线的协议上界是 **30 秒**（`core/mutationProtocol.ts`
 *      的 `DEFAULT_TIMEOUT_MS = 30_000`）⇒ **打爆**
 *      ⇒ 用户只看到「操作超时」，真实原因却是「联系不上云端」
 *      —— 又一句**指错方向的谎**。
 *
 * ⚠️ 为什么 4500+ 个绿灯没抓住（这才是这条守卫存在的理由）：
 * `authOutageUserFacing` / `authSessionSurvivesOutage` /
 * `backendUnavailableHonesty` / `authVerdictHonesty` 那一族守卫守的是
 * 「**会话不许被删**」，测的是 **402**（云端明确不可用）那一档。
 * 而本缺陷发生在**断网**那一档（探活说「不知道」⇒ 放行）⇒
 * 此时**会话确实不会被删** ⇒ 那族守卫的**全部断言仍然成立** ⇒ 照样全绿。
 * ⇒ **它们守的是「会不会说错话」，没守「等多久」。**
 *
 * ── 为什么用**两条**判据（结构 + 行为）──────────────────────────────────
 * ① **结构**：本仓任何 `src/utils/supabase/**` 的文件都**不许**再出现
 *    裸的 `supabase.auth.getUser()` ⇒ 核账号只有**一个**入口。
 *    （AST 判定，不靠正则 —— 正则只能钉字面量。）
 * ② **行为**：真跑一遍 `downloadTabGroups` / `downloadSettings`，
 *    断网 + 用户端点挂住 ⇒ 必须在**上限内**结束，且错误带机器码
 *    `deadline_exceeded`（「核不到」），**不是**「未登录 / 请重新登录」
 *    （重登在弱网时必然失败 ⇒ 死循环）。
 *
 * ⚠️ 行为判据的**前提**要钉住：假云端必须真的挂住用户端点
 * （而不是立刻失败）⇒ 否则「上限还在」与「上限没了」两种情况
 * 都表现为「很快结束」⇒ 判据恒绿。
 *
 * ── 为什么要用**定时器**而不是「永不 resolve」──────────────────────────
 * 永不 resolve 的话，一旦上限被拆掉（正是变异自证要验的），
 * 这条用例会**永远挂着**（node 的测试超时是无限）⇒ 整套测试卡死。
 * 定时器给了它一个确定的终点（15 秒）⇒ 拆掉上限 ⇒ 用例在 15 秒后变红。
 * 与 `authOutageUserFacing.test.ts` 的同一纪律。
 */
import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

import { installEngineStorageEnv } from '../_helpers/engineStorageEnv.ts';
import { stubSessionJson } from '../_helpers/stubSession.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOADER_PATH = pathToFileURL(resolve(ROOT, 'tests/_alias-loader.mjs')).href;
before(async () => {
  register(LOADER_PATH);
});

// ⚠️ 必须在任何 '@/…' 的 import 之前装：storage-kv 在首次 import 时选驱动。
const env = installEngineStorageEnv();

const USER_ID = 'user-r52-deadline';
/** 会话存储键：由 Supabase URL 的 projectRef 派生（stub ⇒ 'stub'）。 */
const SESSION_KEY = 'sb-stub-auth-token';

/**
 * 判据的**上限**（毫秒）。
 *
 * 生产值是 5 秒（`sessionRead.ts` 的 `SESSION_READ_DEADLINE_MS`）。
 * 这里取 8 秒：给机器留余量，但**稳稳地**低于假云端的 15 秒定时器
 * ⇒ 拆掉上限之后**一定**越过判据（而不是擦边混过去）。
 */
const DEADLINE_BUDGET_MS = 8_000;

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * 假云端：**探活连不上**（断网）+ **用户端点挂住**。
 *
 * ⚠️ 这两个条件**缺一不可**：
 *   · 探活连不上 ⇒ 判「**不知道**」⇒ **放行**（这正是本缺陷的触发条件：
 *     若探活判「不可用」，主防线会拦下，`getUser()` 压根不被问
 *     ⇒ 测不到「等多久」这一维）；
 *   · 用户端点挂住 ⇒ 没有上限时它会**一直等** ⇒ 上限有没有生效
 *     才**看得出来**。
 */
interface FakeCloud {
  /** 每个请求的日志（`${method} ${pathname}`）。 */
  requests: string[];
  /** 放行挂住的用户端点（并撤掉它的定时器）—— 让进程能立刻退出。 */
  release(): void;
  restore(): void;
}

const installFakeCloud = (): FakeCloud => {
  const requests: string[] = [];
  let releaseUser: (() => void) | null = null;
  let userTimer: ReturnType<typeof setTimeout> | null = null;
  const previousFetch = globalThis.fetch;

  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(
      typeof input === 'string' ? input : String((input as { url: string }).url),
    );
    requests.push(`${url.pathname}`);

    if (url.pathname.endsWith('/auth/v1/health')) {
      // 断网 ⇒ 探活连不上 ⇒ 判「不知道」⇒ 放行。
      throw new TypeError('Failed to fetch');
    }
    if (url.pathname.endsWith('/auth/v1/user')) {
      // 挂住 ⇒ 没有上限时它会拖到 15 秒（而不是立刻失败）。
      return await new Promise<Response>((resolve) => {
        releaseUser = () => resolve(jsonRes({ id: USER_ID }));
        userTimer = setTimeout(() => resolve(jsonRes({ id: USER_ID })), 15_000);
      });
    }
    return jsonRes({ message: 'not found' }, 404);
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

// ════════════════════════════════════════════════════════════════════════
// ① 结构判据：核账号只有**一个**入口
// ════════════════════════════════════════════════════════════════════════

/**
 * 找出源码里所有**没有上限**的 `supabase.auth.getUser(...)` 调用。
 *
 * ── 判据钉的是**不变量**，不是「只有某一个入口」───────────────────────
 * 「核账号只有一个入口」这条**太窄**：将来再有人加一个入口（哪怕它自己
 * 也带上限），守卫会误报 ⇒ 等于逼着实现不敢改。
 * ⇒ 真正的不变量是：**每一个 `getUser()` 调用都必须被 `withDeadline(...)`
 * 包住** ⇒ 等待永远有界。
 * （`session.ts` 的 `requireSessionUser` 与 `auth.ts` 的 `getCurrentUser`
 *  两处**都**满足这条 —— 它们是**两个**入口，各自都带上限。）
 *
 * ⚠️ 为什么用 AST 而不是正则：
 *   · 正则 `/auth\.getUser\(/` 能被 `supabase['auth']['getUser']()` 躲开；
 *   · 正则也会误伤「注释里提到 getUser」与「字符串里写着 getUser」；
 *   · 而本仓**已经**吃过一次「正则钉字面量」的亏（见
 *     `tests/guards/accountScopeReconcile.test.ts` 的头注：
 *     「本仓库第三次踩『守卫钉字面量挡正确修复』那个坑」）。
 */
const findUnboundedGetUserCalls = (filePath: string): string[] => {
  const source = ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'getUser' &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === 'auth'
    ) {
      // 这个 getUser() 调用**被 withDeadline 包住了吗**？
      //   被包住 ⇒ 等待有界 ⇒ 合规；
      //   没被包住 ⇒ 裸调 ⇒ 弱网时拖满 45 秒 ⇒ 违规。
      const parent = node.parent;
      const wrapped =
        ts.isCallExpression(parent) &&
        ts.isIdentifier(parent.expression) &&
        parent.expression.text === 'withDeadline';
      if (!wrapped) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        found.push(`${filePath}:${line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

describe('第 52 轮：核账号必须走收口入口（不许再有裸的 getUser）', () => {
  it('① src/utils/supabase/** 里每一个 getUser() 都必须被 withDeadline 包住', () => {
    const files = [
      'src/utils/supabase/download.ts',
      'src/utils/supabase/upload.ts',
      'src/utils/supabase/session.ts',
      'src/utils/supabase/auth.ts',
      'src/utils/supabase/probe.ts',
    ];
    const violations: string[] = [];
    for (const rel of files) {
      violations.push(...findUnboundedGetUserCalls(resolve(ROOT, rel)));
    }
    assert.deepEqual(
      violations,
      [],
      '每一个 `supabase.auth.getUser()` 都必须被 `withDeadline(...)` 包住。\n' +
        '裸调没有上限 ⇒ 弱网时拖满 45 秒\n' +
        '（同步管线的协议上界是 30 秒 ⇒ 打爆 ⇒ 用户只看到「操作超时」）。\n' +
        '实测位置：\n' + violations.join('\n'),
    );
  });

  it('①b download.ts 的两处核账号**都**接上了收口入口', () => {
    // ⚠️ 用 AST 数**调用表达式**（不是正则数文本）：
    //   正则会把注释里那句「requireSessionUser()」也算进去 ⇒ 判据钉字面量。
    const filePath = resolve(ROOT, 'src/utils/supabase/download.ts');
    const source = ts.createSourceFile(
      filePath,
      readFileSync(filePath, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    let count = 0;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'requireSessionUser'
      ) {
        count += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.equal(
      count,
      2,
      `download.ts 的两处核账号（downloadTabGroups / downloadSettings）` +
        `都必须走 requireSessionUser()（实测 ${count} 处）`,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════
// ② 行为判据：断网 + 用户端点挂住 ⇒ 必须在上限内结束，且说「核不到」
// ════════════════════════════════════════════════════════════════════════

describe('第 52 轮：下载路径的核账号必须有上限（实测，不许只读源码）', () => {
  let cloud: FakeCloud | null = null;

  afterEach(async () => {
    cloud?.release();
    cloud?.restore();
    cloud = null;
    env.chromeData.clear();
    env.lsData.clear();
    // ⚠️ 必须忘掉「刚刚观测到云端不可用」那条记忆：
    //   `requireCloudAvailable` 有 5 秒的记忆窗口 ⇒ 前一条用例观测到
    //   「不可用」会让后一条**压根不问**（直接吃记忆）⇒ 判据会漂。
    const { __resetOutageTrackerForTests } = await import('@/utils/supabase/outageTracker');
    __resetOutageTrackerForTests();
  });

  /**
   * 跑一次下载的核账号，返回「耗时 + 错误」。
   *
   * ⚠️ 「耗时」必须在**外层**测：被测函数自己不会说自己花了多久。
   */
  const measure = async (
    label: string,
    fn: () => Promise<unknown>,
  ): Promise<{ elapsed: number; error: unknown }> => {
    const started = Date.now();
    let error: unknown = null;
    try {
      await fn();
    } catch (err) {
      error = err;
    }
    const elapsed = Date.now() - started;
    // 前提自证：用户端点**真的被问过** ⇒ 否则「很快结束」可能是因为
    // 压根没走到核账号那一步（那样这条断言就是**空转**）。
    assert.ok(
      cloud!.requests.some(r => r.includes('/auth/v1/user')),
      `[${label}] 前提：核账号必须真的被问过（否则这条判据是空转）。` +
        `实测请求：${JSON.stringify(cloud!.requests)}`,
    );
    return { elapsed, error };
  };

  it('② downloadTabGroups：断网时核账号必须在上限内结束', async () => {
    cloud = installFakeCloud();
    env.chromeData.set(SESSION_KEY, stubSessionJson(USER_ID));

    const { downloadSync } = await import('@/utils/supabase/download');
    const { isDeadlineExceeded } = await import('@/utils/deadline');

    const { elapsed, error } = await measure('downloadTabGroups', () =>
      downloadSync.downloadTabGroups(),
    );

    // ⚠️ 顺序有讲究：**先**断言「在上限内结束」，**后**断言「错误长什么样」。
    //   原因：把上限拆掉之后，核账号会一路挂到假云端的 15 秒定时器 ⇒
    //   那时它是**成功**的（没有错误）⇒ 若先断言「有错误」，
    //   红的位置就跑到别的理由上去了。
    assert.ok(
      elapsed < DEADLINE_BUDGET_MS,
      `downloadTabGroups 的核账号必须在上限内结束（实测 ${elapsed}ms）—— ` +
        '没有上限时它会一路拖到 SDK 自带的 45 秒 fetch 超时，' +
        '而同步管线的协议上界是 30 秒 ⇒ 打爆 ⇒ 用户只看到「操作超时」',
    );
    assert.ok(error, '核账号失败必须把错误带出来（吞掉它就等于说「没登录」）');
    assert.ok(
      isDeadlineExceeded(error),
      '必须是「等到期限」那一个（机器码 deadline_exceeded）—— ' +
        '那才是「核不到」；别的错误会被上游读成「普通失败」',
    );
    const message = error instanceof Error ? error.message : String(error);
    assert.ok(
      !/未登录|会话已过期|请重新登录/.test(message),
      `超时是「核不到」，不是「没登录」（实测：${message}）—— ` +
        '说成「请重新登录」会把用户推向一个必然失败的动作',
    );
  });

  it('② downloadSettings：断网时核账号必须在上限内结束', async () => {
    cloud = installFakeCloud();
    env.chromeData.set(SESSION_KEY, stubSessionJson(USER_ID));

    const { downloadSync } = await import('@/utils/supabase/download');
    const { isDeadlineExceeded } = await import('@/utils/deadline');

    const { elapsed, error } = await measure('downloadSettings', () =>
      downloadSync.downloadSettings(),
    );

    assert.ok(
      elapsed < DEADLINE_BUDGET_MS,
      `downloadSettings 的核账号必须在上限内结束（实测 ${elapsed}ms）—— ` +
        '没有上限时它会一路拖到 SDK 自带的 45 秒 fetch 超时',
    );
    assert.ok(error, '核账号失败必须把错误带出来（吞掉它就等于说「没登录」）');
    assert.ok(
      isDeadlineExceeded(error),
      '必须是「等到期限」那一个（机器码 deadline_exceeded）',
    );
    const message = error instanceof Error ? error.message : String(error);
    assert.ok(
      !/未登录|会话已过期|请重新登录/.test(message),
      `超时是「核不到」，不是「没登录」（实测：${message}）`,
    );
  });
});
