/**
 * 登录态的判定 —— 四档，不是两个（2026-10-23 第 47 轮）。
 *
 * ── 为什么这条不变量值得一整份守卫 ────────────────────────────────────────
 * 「登录 / 没登录」看着是两个事实，但真实世界有**第三、第四种**：
 *
 *   · **服务端整体不可用**（生产实测 402：项目被限制）⇒ **用户确实登录着**，
 *     只是我们**确认不了**；
 *   · **断网** ⇒ 我们**不知道**。
 *
 * 这两种都**不许**被读成「没登录」—— 那是一句**更重的谎**：
 * 用户会去重新登录、重新输密码，甚至以为账号被删了，而真正的原因是
 * 「我们的云端项目被限制」（他做什么都没用）。
 *
 * ⇒ 判据必须是**四档**，而且「不可用 / 不知道」两档都必须**保留本机缓存
 * 那份登录态**（宁可暂定，也不要在用户眼前一闪变成「没登录」）。
 *
 * ── 钉的是**判据**，不是代码形状 ──────────────────────────────────────────
 * · 纯函数那一半（`core/authStatus.ts`）直接做行为断言；
 * · IO 那一半（`background/authStatus.ts`，后台侧核登录态）对着**假云端**
 *   真跑一遍 ⇒ 核到 / 没核到 / 服务端不可用，三种结果各钉一次。
 *
 * ⚠️ 假云端那一档（`unavailable: true` ⇒ 全部 402）是**必须**的：
 * 只用「假服务器吐自家解析器认得的形状」的话，服务端不可用这一支
 * 永远只被**假装**过（memory「假服务器的自证式盲区」）。
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installEngineStorageEnv } from '../_helpers/engineStorageEnv.ts';
import { installFakePostgrestCloud } from '../_helpers/fakePostgrestCloud.ts';
import { stubSessionJson } from '../_helpers/stubSession.ts';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

// ⚠️ 必须在任何 '@/…' 的 import 之前装：storage-kv 在首次 import 时选驱动。
const env = installEngineStorageEnv();

const USER_A = 'user-a-11111111-1111-4111-8111-111111111111';
const USER_B = 'user-b-22222222-2222-4222-8222-222222222222';
const SESSION_KEY = 'sb-stub-auth-token';

describe('登录态判定：四档，不是两个', () => {
  it('核到了 ⇒ 已登录，且身份是核到的那个（不是缓存那份）', async () => {
    const { decideAuthStatus } = await import('@/core/authStatus.ts');
    const status = decideAuthStatus({
      verifiedUser: { id: USER_A, email: 'a@example.com' },
      cachedUser: { id: USER_B, email: 'b@example.com' },
    });
    assert.equal(status.kind, 'authenticated');
    assert.equal(status.user?.id, USER_A);
  });

  it('服务端整体不可用 ⇒ 那一档，且**保留缓存那份**（不许说「没登录」）', async () => {
    const { decideAuthStatus } = await import('@/core/authStatus.ts');
    const status = decideAuthStatus({
      verifiedUser: null,
      cachedUser: { id: USER_A, email: 'a@example.com' },
      backendUnavailable: true,
    });
    assert.equal(
      status.kind,
      'backend_unavailable',
      '服务端不可用必须单独成一档 —— 混进「没登录」会让用户去重新登录（白折腾）'
    );
    assert.equal(
      status.user?.id,
      USER_A,
      '服务端不可用时必须保留缓存那份登录态（用户确实登录着，只是确认不了）'
    );
  });

  it('断网 / 核不到 ⇒ 「不知道」那一档，**同样不许说「没登录」**', async () => {
    const { decideAuthStatus } = await import('@/core/authStatus.ts');
    const status = decideAuthStatus({
      verifiedUser: null,
      cachedUser: { id: USER_A, email: 'a@example.com' },
      failureDetail: 'network error',
    });
    assert.equal(status.kind, 'unknown');
    assert.equal(status.user?.id, USER_A, '「不知道」时也保留缓存那份');
  });

  it('明确核到「没有会话」⇒ 才是「没登录」，且缓存那份必须被丢掉', async () => {
    const { decideAuthStatus } = await import('@/core/authStatus.ts');
    const status = decideAuthStatus({
      verifiedUser: null,
      cachedUser: { id: USER_A, email: 'a@example.com' },
      // ⚠️ 2026-10-23（第 50 轮）：「没登录」必须是**明确核到的事实**，
      // 靠一个布尔把「服务端说没有会话」与「我们什么都没问到」区分开。
      verifiedNoSession: true,
    });
    assert.equal(status.kind, 'not_authenticated');
    assert.equal(
      status.user,
      null,
      '真的没登录时，缓存那份必须丢掉 —— 否则用户明明登出了，界面还显示「已登录」'
    );
  });

  // ── 2026-10-23（第 50 轮）：**默认**必须是「不知道」，不是「没登录」─────
  //
  // 修复前判据靠 `failureDetail` 的真伪来区分「核到了没登录」与「没核到」——
  // 于是「核失败但没有失败原因」会被读成「没登录」。
  // **失败原因的长相不该决定事实的性质** ⇒ 改成显式的 `verifiedNoSession`。
  it('没有任何事实（既没核到账号、也没核到「没有会话」）⇒ 必须是「不知道」', async () => {
    const { decideAuthStatus } = await import('@/core/authStatus.ts');
    const status = decideAuthStatus({
      verifiedUser: null,
      cachedUser: { id: USER_A, email: 'a@example.com' },
    });
    assert.equal(
      status.kind,
      'unknown',
      '「什么都没问到」绝不能被读成「没登录」—— 那是本轮修掉的那个谎'
    );
    assert.equal(status.user?.id, USER_A, '「不知道」时保留缓存那份（暂定事实）');
  });

  it('「服务端不可用」与「没登录」在界面上必须是**两句不同的话**', async () => {
    const { decideAuthStatus, authStatusCopy } = await import('@/core/authStatus.ts');
    const unavailable = decideAuthStatus({
      verifiedUser: null,
      cachedUser: { id: USER_A, email: 'a@example.com' },
      backendUnavailable: true,
    });
    const notLoggedIn = decideAuthStatus({
      verifiedUser: null,
      cachedUser: null,
      verifiedNoSession: true, // 明确核到「没有会话」
    });
    const copy = {
      backendUnavailable: '云端暂时不可用，本地数据没丢',
      unknown: '暂时联系不上云端，先按本机状态显示',
    };
    const a = authStatusCopy(unavailable, copy);
    const b = authStatusCopy(notLoggedIn, copy);
    assert.notEqual(
      a,
      b,
      '这两档必须说出不同的话 —— 混成一句 ⇒ 用户在服务端故障时去重新登录'
    );
    assert.equal(b, null, '「没登录」不是故障，不该由这一层出声（界面另有出口）');
  });
});

describe('后台核登录态：对着假云端真跑一遍', () => {
  let cloud: ReturnType<typeof installFakePostgrestCloud>;

  before(async () => {
    // authSlice / authCache 的首次 import 需要环境桩已经装好。
    await import('@/utils/authCache.ts');
  });

  after(() => {
    cloud?.restore();
  });

  beforeEach(() => {
    env.lsData.clear();
    env.chromeData.clear();
    cloud?.restore();
    cloud = installFakePostgrestCloud();
  });

  /** 把登录态与 session 都摆好（模拟「这台机器登录着」）。 */
  async function signInAs(userId: string): Promise<void> {
    const { authCache } = await import('@/utils/authCache.ts');
    await authCache.saveAuthState(
      { id: userId, email: 'a@example.com', lastLogin: new Date().toISOString() },
      true
    );
    env.chromeData.set(SESSION_KEY, stubSessionJson(userId));
    cloud.setSessionUser(userId);
  }

  it('登录着 ⇒ 核到「已登录」', async () => {
    await signInAs(USER_A);
    const { readAuthStatus } = await import('@/background/authStatus.ts');
    const status = await readAuthStatus();
    assert.equal(status.kind, 'authenticated');
    assert.equal(status.user?.id, USER_A);
  });

  it('没登录 ⇒ 核到「没登录」，且缓存那份被丢掉', async () => {
    const { readAuthStatus } = await import('@/background/authStatus.ts');
    const status = await readAuthStatus();
    assert.equal(status.kind, 'not_authenticated');
    assert.equal(status.user, null);
  });

  it('服务端整体不可用（402）⇒ 核到「不可用」，**保留缓存那份**', async () => {
    await signInAs(USER_A);
    cloud.restore();
    cloud = installFakePostgrestCloud({ unavailable: true });

    const { readAuthStatus } = await import('@/background/authStatus.ts');
    const status = await readAuthStatus();
    assert.equal(
      status.kind,
      'backend_unavailable',
      '402 那一类必须单独成一档 —— 生产实测：项目被限制时连账号校验都是 402'
    );
    assert.equal(
      status.user?.id,
      USER_A,
      '用户确实登录着（缓存里有）⇒ 必须保留 —— 说成「没登录」会让他去重新登录'
    );
  });
});
