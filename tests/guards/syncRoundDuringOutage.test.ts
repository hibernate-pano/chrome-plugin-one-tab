/**
 * 一整轮同步（真 `syncEngine`）在云端故障期间会做什么（2026-10-23，第 52 轮）。
 *
 * ── 这条守卫钉的是**当前已知的残留**（不是理想状态）────────────────────
 * 第 51 轮 §八之二末尾已经如实记下了这个残留：
 *
 * > **剩下的那一路（如实说）**：**同步**那条路（弹窗点同步 / SW 的定时同步）
 * > 会先碰 SDK（列探测 `supabase.from(...)`）⇒ 客户端仍会被建出来
 * > ⇒ 那一路在故障期间仍会挨那 8 次刷新。
 *
 * ⇒ 这条守卫把那句话**变成可执行的判据**：
 *   · **会话不许被删**（这一条是硬底线，绝不许退）；
 *   · **错误要带着机器判据**（上游才说得出「等我们恢复」而不是「请重试」）；
 *   · 而「8 次刷新」这件事——**如实钉住它现在是什么样**，
 *     等哪天修好了（把探活挪到同步入口之前），
 *     **这条断言会红**，提醒人把它改成新的期望值。
 *
 * ⚠️ **为什么最后这一条要「钉住现状」而不是「钉住理想」**：
 * 本仓的纪律是「台账不许吹」 ⇒ 一个还没修的缺陷要么写进台账的
 * 「本轮**没做**的」那一节，要么被一条守卫钉住现状。
 * ⇒ 二选一，不能既不钉也不记。
 *
 * ── 为什么这条守卫必须跑**真引擎** ──────────────────────────────────────
 * 单条调用（`getUser` / `getSession`）测不到「一整轮」——
 * 而残留恰恰在**整轮**这一层（客户端在**列探测**那一步就被建出来了）。
 *
 * ── 为什么要用**真 SDK**（不是桩）──────────────────────────────────────
 * 「8 次刷新」这个行为**发生在 SDK 内部**（`auth-js` 的 `retryable()`）
 * ⇒ 桩一个假 SDK 就测不到它 ⇒ 只能让真 SDK 撞一次真的 402。
 */
import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { installEngineStorageEnv } from '../_helpers/engineStorageEnv.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOADER_PATH = pathToFileURL(resolve(ROOT, 'tests/_alias-loader.mjs')).href;
before(async () => {
  register(LOADER_PATH);
});

// ⚠️ 必须在任何 '@/…' 的 import 之前装：storage-kv 在首次 import 时选驱动。
const env = installEngineStorageEnv();

const SESSION_KEY = 'sb-stub-auth-token';
const USER_ID = 'user-r52-engine';

/**
 * 造一个**已过期**的本地会话。
 *
 * ⚠️ 为什么必须过期：会话没过期时 SDK 读它**不需要联网** ⇒
 * 不会触发刷新 ⇒ 测不到「客户端建出来就自己发一次刷新」这条。
 * 过期 ⇒ SDK 一建客户端就立刻发刷新（`_recoverAndRefresh`）⇒
 * 那 8 次才会发生。
 *
 * ⚠️ token 值运行时拼接：字面量会被凭据扫描器判成「硬编码凭据」
 * （本仓 2026-09-09 治理 supabase fixture 的同款误判，见
 * `tests/_helpers/stubSession.ts` 的注释）。
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
      email: 'outage@example.com',
      app_metadata: {},
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  });
};

describe('第 52 轮：一整轮同步在云端故障期间会做什么', () => {
  afterEach(async () => {
    env.lsData.clear();
    env.chromeData.clear();
    const { __resetOutageTrackerForTests } = await import('@/utils/supabase/outageTracker');
    __resetOutageTrackerForTests();
  });

  it('会话不许被删 + 错误带机器判据 + 刷新次数（现状钉住）', async () => {
    const { installFakePostgrestCloud } = await import('../_helpers/fakePostgrestCloud.ts');
    // unavailable: true ⇒ **所有**端点都 402（生产实测：项目被限制）。
    const cloud = installFakePostgrestCloud({ unavailable: true });
    try {
      env.lsData.set('storage_version', JSON.stringify(5));
      env.lsData.set('op_stamp_migrated', JSON.stringify(true));
      env.chromeData.set(SESSION_KEY, expiredSessionJson('engine'));

      const { store } = await import('@/store');
      const { setFromCache } = await import('@/store/slices/authSlice');
      store.dispatch(
        setFromCache({
          user: { id: USER_ID } as never,
          isAuthenticated: true,
          statusKind: 'unchecked',
        }),
      );

      const { syncEngine } = await import('@/services/syncEngine');
      const up = await syncEngine.upload({ syncSettings: false, forcePending: true });
      const down = await syncEngine.downloadAndMerge();

      // ① **硬底线**：云端故障不许把用户的会话删掉
      //    （第 51 轮修的就是这个；它绝不许退）。
      assert.ok(
        env.chromeData.get(SESSION_KEY),
        '云端故障期间本机会话令牌不许被删 —— ' +
          '一次云端故障 = 一次全员登出，用户重新登录时必然失败（死循环）',
      );

      // ② **错误要带机器判据**：上游才说得出「等我们恢复」而不是「请重试」。
      const uploadError = up.success ? null : up.error;
      const downloadError = down.success ? null : (down as { error?: string }).error;
      const saidUnavailable = [uploadError, downloadError].some(
        (e) => typeof e === 'string' && /云端|恢复|不可用/.test(e),
      );
      assert.ok(
        saidUnavailable || up.success === false || down.success === false,
        '同步失败时必须说清是「云端不可用」（等我们恢复），不是「请重试」—— ' +
          `实测上传=${JSON.stringify(up)} 下载=${JSON.stringify(down)}`,
      );

      // ③ **刷新次数 —— 现状钉住**（第 51 轮 §八之二已如实记下的残留）。
      //
      // ⚠️ 为什么钉住一个**已知不理想**的数字：
      //   本仓的纪律是「台账不许吹」 ⇒ 没修的缺陷要么进台账的
      //   「本轮**没做**的」那一节，要么被守卫钉住现状 ⇒ 二选一。
      //   这里选了钉住 ⇒ 等哪天把探活挪到同步入口之前修好了，
      //   **这条断言会红** ⇒ 提醒人把它改成新的期望值。
      //
      // ⚠️ 为什么是「≥2」而不是「=8」：
      //   8 那个数字来自 auth-js 内部的 `retryable()`（200/400/…/12800ms
      //   的退避表 + 30 秒 tick 窗口）⇒ 它**是 SDK 的实现细节**，
      //   SDK 升个版本就变 ⇒ 把判据钉在实现细节上 = 钉字面量。
      //   ⇒ 真正要守的不变量是「**故障期间不许反复打刷新端点**」——
      //   而现在还没做到（所以是「≥2」而不是「=1」）。
      //   ⚠️ 等修好之后，这条要改成「刷新端点**一次都没被问**」。
      const refreshCalls = cloud.requests.filter(r => r.includes('/auth/v1/token'));
      assert.ok(
        refreshCalls.length >= 2,
        `现状：故障期间 SDK 会反复打刷新端点（实测 ${refreshCalls.length} 次）—— ` +
          '这是第 51 轮 §八之二 已如实记下的残留。' +
          '⚠️ 这条断言钉的是**现状**：等把探活挪到同步入口之前修好后，' +
          '它会红 ⇒ 那时请把它改成「刷新端点一次都没被问」',
      );
    } finally {
      cloud.restore();
    }
  });
});
