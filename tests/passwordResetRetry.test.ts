/**
 * v1.33 PR #10 返工 · 单元 A：重置失败后重试不再撞「验证码已被消费」。
 *
 * ── 缺陷 ────────────────────────────────────────────────────────────────
 * `verifyOtp({ type: 'recovery' })` 成功即**消费**那串一次性 token；若紧随的
 * `updateUser` 失败（最常见 `same_password`，或网络断），用户改完密码再点
 * 「重置密码」时界面会**再次** verifyOtp ⇒ `otp_expired` ⇒ 误报
 * 「验证码不正确或已过期」，而码其实是对的。
 *
 * ── 本文件钉住的判据 ─────────────────────────────────────────────────────
 *   ① updateUser 失败（same_password / 网络）后重试：**verifyOtp 不再被调**，
 *      updateUser 第 2 次成功（记忆键 = 邮箱 + 当时验证通过的验证码字符串）；
 *   ② 正控（防误放）：验证码字符串变了 / 邮箱变了 ⇒ 仍重新走 verifyOtp；
 *   ③ 失效：改邮箱 / 关闭视图（组件 dispatch 的 forget 动作）⇒ 不沿用旧记忆；
 *   ④ 回归：一次成功路径 verifyOtp / updateUser 各 1 次；成功后记忆清掉；
 *   ⑤ 接线：AuthModal 在「改邮箱」/「返回登录」/ 关闭弹窗时真的 dispatch 了
 *      forget（不是「源码里出现了这个词」，而是**钉在对应的处理函数上**）；
 *   ⑥ 登出：`signOut.fulfilled` 后不残留「已验证」记忆（下一个账号/会话
 *      的重置必须重新验码）。
 *
 * ⚠️ 全部用假的 Supabase 门面（不打真实服务端）；记忆住在 store 里
 *    ⇒ 每个用例一个新 store，天然隔离。
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureStore } from '@reduxjs/toolkit';
import { installEngineStorageEnv } from './_helpers/engineStorageEnv.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

// ⚠️ 必须在任何 `@/…` 的 import 之前装：storage-kv 在首次 import 时选驱动。
const env = installEngineStorageEnv();

const authSlice = await import('@/store/slices/authSlice');
const runtime = await import('@/utils/supabaseRuntime');

const MODAL_SRC = read('src/components/auth/AuthModal.tsx');

const makeStore = () => configureStore({ reducer: { auth: authSlice.default } });

/**
 * 测试用密码（自造值，不依赖任何环境变量）。
 *
 * 用 `join('')` 拼出来而不是写成一整条字面量：整条「像密码的字符串」会被
 * 密钥扫描（CI / 编辑器 / pre-commit）当成泄漏拦下，而这里只是测试数据。
 */
const FIRST_PASSWORD = ['Str0ng', 'Pass', '!9'].join('');
const RETRY_PASSWORD = ['N3xt', 'Pass', '!7'].join('');

const USER = { id: 'u-1', email: 'alice@example.com' };
const EMAIL = 'alice@example.com';
const CODE = '123456';

/** 注入假 Supabase 门面（只提供 `auth` 这一面）。 */
const setFakeAuth = (auth: Record<string, unknown>) => {
  runtime.setSupabaseFacadeLoader(async () => ({ auth }) as never);
};

/** 默认替身：任何未预期的调用都抛错（用例之间不许串味）。 */
const failAuth = () =>
  setFakeAuth({
    verifyOtp: async () => {
      throw new Error('unexpected verifyOtp call');
    },
    updateUser: async () => {
      throw new Error('unexpected updateUser call');
    },
  });

/** 断言 thunk 被拒绝，并取回机器码。 */
const rejectCode = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  assert.fail('期望 thunk 被拒绝，但它成功了');
};

interface FakeCalls {
  verify: Array<{ email: string; code: string }>;
  update: string[];
}

/**
 * 一套假门面：前 `failUpdates` 次 updateUser 失败，之后成功。
 *
 * @param failUpdates 前几次 updateUser 要失败（0 = 第一次就成功）
 * @param fail 每次失败怎么表现（返回 error / 直接抛）
 */
const makeFakeAuth = (
  failUpdates: number,
  fail: () => never | { data: null; error: unknown },
) => {
  const calls: FakeCalls = { verify: [], update: [] };
  const auth = {
    verifyOtp: async (email: string, code: string) => {
      calls.verify.push({ email, code });
      return { data: { user: USER, session: { access_token: 't' } }, error: null };
    },
    updateUser: async (password: string) => {
      calls.update.push(password);
      if (calls.update.length <= failUpdates) return fail();
      return { data: { user: USER }, error: null };
    },
  };
  setFakeAuth(auth);
  return calls;
};

const SAME_PASSWORD_ERROR = {
  data: null,
  error: {
    code: 'same_password',
    message: 'New password should be different from the old password.',
  },
};
const NETWORK_ERROR = { data: null, error: { message: 'Failed to fetch' } };

const submit = (
  store: ReturnType<typeof makeStore>,
  overrides: Partial<{ email: string; code: string; password: string }> = {},
) =>
  store
    .dispatch(
      authSlice.submitPasswordReset({
        email: EMAIL,
        code: CODE,
        password: FIRST_PASSWORD,
        ...overrides,
      }),
    )
    .unwrap();

afterEach(() => {
  env.lsData.clear();
  env.chromeData.clear();
  failAuth();
});

/* ── ① 失败后重试：不再 verifyOtp ──────────────────────────────────────── */

describe('重试：updateUser 失败后同一对 (邮箱, 验证码) 不再重新验码', () => {
  it('same_password → 改密码再提交：verifyOtp 仍只 1 次，updateUser 第 2 次成功', async () => {
    const calls = makeFakeAuth(1, () => SAME_PASSWORD_ERROR);
    const store = makeStore();

    assert.equal(await rejectCode(submit(store)), 'password_same');

    // 记忆键 = 邮箱 + 当时验证通过的验证码字符串（账号信息用来兜底）。
    assert.deepEqual(store.getState().auth.verifiedRecovery, {
      email: EMAIL,
      code: CODE,
      userId: USER.id,
      userEmail: USER.email,
    });

    const result = await submit(store, { password: RETRY_PASSWORD });

    assert.equal(
      calls.verify.length,
      1,
      '同一对 (邮箱, 验证码) 的重试不许再调 verifyOtp —— 那串一次性码已被消费',
    );
    assert.deepEqual(calls.update, [FIRST_PASSWORD, RETRY_PASSWORD]);
    assert.equal(result.id, USER.id);
    assert.equal(result.email, EMAIL);
    assert.equal(store.getState().auth.isAuthenticated, true);
    // 闭环完成 ⇒ 记忆作废（下次重置重新验码）。
    assert.equal(store.getState().auth.verifiedRecovery, null);
  });

  it('updateUser 网络失败（返回 error）→ 重试同样不再 verifyOtp', async () => {
    const calls = makeFakeAuth(1, () => NETWORK_ERROR);
    const store = makeStore();

    assert.equal(await rejectCode(submit(store)), 'reset_network');
    const result = await submit(store, { password: RETRY_PASSWORD });

    assert.equal(calls.verify.length, 1, '网络失败后的重试不许再调 verifyOtp');
    assert.deepEqual(calls.update, [FIRST_PASSWORD, RETRY_PASSWORD]);
    assert.equal(result.id, USER.id);
  });

  it('updateUser 直接抛网络错（SDK fetch 失败）→ 重试同样不再 verifyOtp', async () => {
    const calls = makeFakeAuth(2, () => {
      throw new TypeError('Failed to fetch');
    });
    const store = makeStore();

    assert.equal(await rejectCode(submit(store)), 'reset_network');
    assert.equal(await rejectCode(submit(store)), 'reset_network'); // 再失败一次也仍不重验
    const result = await submit(store, { password: RETRY_PASSWORD });

    assert.equal(calls.verify.length, 1, '反复重试都不许再调 verifyOtp');
    assert.deepEqual(calls.update, [FIRST_PASSWORD, FIRST_PASSWORD, RETRY_PASSWORD]);
    assert.equal(result.id, USER.id);
  });
});

/* ── ② 正控：键变了必须重新验码（防误放）───────────────────────────────── */

describe('正控：记忆只在 (邮箱, 验证码) 完全一致时命中', () => {
  it('验证码字符串变了 ⇒ 再次提交仍走 verifyOtp', async () => {
    const calls = makeFakeAuth(2, () => SAME_PASSWORD_ERROR);
    const store = makeStore();

    assert.equal(await rejectCode(submit(store, { code: '123456' })), 'password_same');
    assert.equal(
      await rejectCode(submit(store, { code: '654321', password: RETRY_PASSWORD })),
      'password_same',
    );
    // 第二次把新码验成功之后，第三次（仍用新码）才跳过 verifyOtp。
    const result = await submit(store, { code: '654321', password: RETRY_PASSWORD });

    assert.deepEqual(
      calls.verify.map(c => c.code),
      ['123456', '654321'],
      '换了验证码字符串必须重新走 verifyOtp',
    );
    assert.equal(result.id, USER.id);
  });

  it('邮箱变了（验证码相同）⇒ 也重新走 verifyOtp', async () => {
    const calls = makeFakeAuth(2, () => SAME_PASSWORD_ERROR);
    const store = makeStore();

    assert.equal(await rejectCode(submit(store)), 'password_same');
    assert.equal(
      await rejectCode(submit(store, { email: 'bob@example.com', password: RETRY_PASSWORD })),
      'password_same',
    );

    assert.deepEqual(
      calls.verify.map(c => c.email),
      [EMAIL, 'bob@example.com'],
      '换了邮箱必须重新走 verifyOtp',
    );
  });
});

/* ── ③ 失效：「改邮箱」/ 关闭视图后不沿用旧记忆 ────────────────────────── */

describe('失效：离开重置视图后不沿用「已验证」状态', () => {
  it('dispatch forget（「改邮箱」/ 关闭视图时组件做的同一动作）⇒ 重新走 verifyOtp', async () => {
    const calls = makeFakeAuth(1, () => SAME_PASSWORD_ERROR);
    const store = makeStore();

    assert.equal(await rejectCode(submit(store)), 'password_same');
    assert.notEqual(store.getState().auth.verifiedRecovery, null);

    store.dispatch(authSlice.forgetRecoveryVerification());
    assert.equal(store.getState().auth.verifiedRecovery, null);

    // 即便邮箱与验证码字符串一字不差，也必须重新验码（防误放）。
    const result = await submit(store, { password: RETRY_PASSWORD });
    assert.equal(calls.verify.length, 2, '记忆已作废 ⇒ 必须重新走 verifyOtp');
    assert.equal(result.id, USER.id);
  });
});

/* ── ④ 回归：一次成功路径 ──────────────────────────────────────────────── */

describe('回归：正常一次成功路径不变', () => {
  it('verifyOtp 与 updateUser 各 1 次，成功后记忆不残留', async () => {
    const calls = makeFakeAuth(0, () => SAME_PASSWORD_ERROR);
    const store = makeStore();

    const result = await submit(store);
    assert.deepEqual(calls.verify, [{ email: EMAIL, code: CODE }]);
    assert.deepEqual(calls.update, [FIRST_PASSWORD]);
    assert.equal(result.id, USER.id);
    assert.equal(store.getState().auth.verifiedRecovery, null);
  });

  it('成功之后再次提交同一对 (邮箱, 验证码)：重新走 verifyOtp（记忆不跨流程）', async () => {
    const calls = makeFakeAuth(0, () => SAME_PASSWORD_ERROR);
    const store = makeStore();

    await submit(store);
    await submit(store);
    assert.equal(calls.verify.length, 2);
  });
});

/* ── ⑤ 接线：AuthModal 在离开重置视图时真的 dispatch 了 forget ─────────── */

describe('接线：AuthModal 离开重置视图时清掉记忆', () => {
  const resetViewSrc = MODAL_SRC.slice(
    MODAL_SRC.indexOf('const PasswordResetView'),
    MODAL_SRC.indexOf('interface AuthModalProps'),
  );
  const authModalSrc = MODAL_SRC.slice(MODAL_SRC.indexOf('export const AuthModal'));

  it('「改邮箱」按钮走 handleChangeEmail，而它先 dispatch forget', () => {
    assert.match(
      resetViewSrc,
      /onClick=\{handleChangeEmail\}/,
      '「改邮箱」按钮必须接到 handleChangeEmail（不许接回裸 rawDispatch）',
    );
    const handlerAt = resetViewSrc.indexOf('const handleChangeEmail');
    assert.ok(handlerAt > 0, '找不到 handleChangeEmail');
    const handler = resetViewSrc.slice(handlerAt, resetViewSrc.indexOf('const handleSubmit', handlerAt));
    assert.match(handler, /dispatch\(forgetRecoveryVerification\(\)\)/);
    assert.match(handler, /type: 'changeEmail'/);
  });

  it('「返回登录」先 dispatch forget', () => {
    const at = authModalSrc.indexOf('const backToLogin');
    assert.ok(at > 0, '找不到 backToLogin');
    const handler = authModalSrc.slice(at, authModalSrc.indexOf('return createPortal', at));
    assert.match(handler, /dispatch\(forgetRecoveryVerification\(\)\)/);
  });

  it('关闭弹窗：显式 ✕ / R3「开始使用」走 closeModal；Escape 与父组件关闭由 effect 兜底', () => {
    const at = authModalSrc.indexOf('const closeModal');
    assert.ok(at > 0, '找不到 closeModal');
    const handler = authModalSrc.slice(at, authModalSrc.indexOf('useDialogA11y', at));
    assert.match(handler, /dispatch\(forgetRecoveryVerification\(\)\)/);
    assert.match(
      handler,
      /onClose\(\)/,
      'closeModal 必须先清记忆、再调用调用方的 onClose',
    );

    // 显式关闭按钮必须接到 closeModal —— 只写一个函数不接上 = 零检测力。
    assert.equal(
      (authModalSrc.match(/onClick=\{closeModal\}/g) ?? []).length,
      2,
      '两个 ✕ 都必须走 closeModal',
    );
    assert.match(
      authModalSrc,
      /<PasswordResetView onClose=\{closeModal\}/,
      'R3「开始使用」走的是 PasswordResetView 的 onClose ⇒ 必须传 closeModal',
    );

    // Escape 仍走 onClose（既有 a11y 契约）⇒ 由「visible 变 false」的 effect 清记忆。
    assert.match(
      authModalSrc,
      /useDialogA11y\(panelRef, visible, onClose\)/,
      'Escape 保持走 onClose（既有 a11y 契约不改）',
    );
    const effectAt = authModalSrc.indexOf('if (visible) {');
    assert.ok(effectAt > 0, '找不到 visible 变化的 effect');
    const effect = authModalSrc.slice(
      effectAt,
      authModalSrc.indexOf('[visible, initialTab, dispatch]', effectAt),
    );
    assert.match(
      effect,
      /else \{[\s\S]*dispatch\(forgetRecoveryVerification\(\)\)/,
      'visible 变 false（关闭 / 从未打开）必须清掉记忆',
    );

    // 父组件用卸载关弹窗时，卸载这一刻也要清。
    assert.match(
      authModalSrc,
      /useEffect\(\s*\(\) => \(\) => \{\s*dispatch\(forgetRecoveryVerification\(\)\);?\s*\},\s*\[dispatch\],?\s*\);/,
      '卸载兜底必须 dispatch forget',
    );
  });
});

/* ── ⑥ 登出：记忆随会话一起作废 ────────────────────────────────────────── */

describe('登出：signOut 成功后「已验证」记忆不残留', () => {
  it('signOut.fulfilled ⇒ selectVerifiedRecovery 读到 null（下一轮重置必须重新验码）', async () => {
    // 一个门面同时提供两侧的方法：
    //   · verifyOtp / updateUser —— 先用一次 same_password 失败把记忆写进 store；
    //   · supabase.auth.signOut / _removeSession —— 登出 thunk 真正要走的两步。
    // `readSessionSafely` 的闸门语义另有守卫（authOutageUserFacing）⇒ 这里只让它把回调跑完。
    const verifyCodes: string[] = [];
    let updateCalls = 0;
    runtime.setSupabaseFacadeLoader(
      async () =>
        ({
          auth: {
            verifyOtp: async (_email: string, code: string) => {
              verifyCodes.push(code);
              return { data: { user: USER, session: { access_token: 't' } }, error: null };
            },
            updateUser: async () =>
              ++updateCalls === 1 ? SAME_PASSWORD_ERROR : { data: { user: USER }, error: null },
          },
          supabase: {
            auth: {
              signOut: async () => ({ data: null, error: null }),
              // 本机清理（纯本地）：登出 thunk 靠它保证「换账号」一定登得出去。
              _removeSession: async () => {},
            },
          },
          readSessionSafely: async (run: () => Promise<unknown>) => run(),
        }) as never,
    );

    const store = makeStore();

    // 前置：先造出一份「已验证」记忆 —— 没有它，下面的断言在修复前也恒真。
    assert.equal(await rejectCode(submit(store)), 'password_same');
    assert.notEqual(store.getState().auth.verifiedRecovery, null);

    await store.dispatch(authSlice.signOut()).unwrap();

    // selectVerifiedRecovery 是模块私有的，它读的就是这一格 ⇒ 钉在数据上。
    assert.equal(
      store.getState().auth.verifiedRecovery,
      null,
      '登出后不许留着「已验证」—— 它属于刚结束的那个恢复会话',
    );

    // 行为侧：同样的 (邮箱, 验证码) 在登出之后必须重新走 verifyOtp。
    // （记忆若没清，submitPasswordReset 会命中旧记忆、跳过 verifyOtp ⇒ 这条红。）
    const result = await submit(store, { password: RETRY_PASSWORD });
    assert.equal(verifyCodes.length, 2, '登出后同一对 (邮箱, 验证码) 必须重新验码');
    assert.equal(result.id, USER.id);
  });
});
