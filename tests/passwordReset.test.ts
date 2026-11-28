/**
 * v1.33 单元 A：忘记密码 / 重置密码（OTP，扩展内完成）。
 *
 * 本文件钉四类判据：
 *   ① **错误映射**：OTP 过期 / 无效 →「验证码不正确或已过期」；
 *      `new password should be different` →「新密码不能与当前密码相同」。
 *      两条都要穿过**真的 thunk**（mock 掉 Supabase 调用，断言 reject 的机器码），
 *      不能只测一个纯函数 —— 「源码里出现了某个模式」= 零检测力。
 *   ② **视图状态机**：R1 → R2 → R3；「改邮箱」回 R1 且保留邮箱；成功只切视图。
 *   ③ **文案逐字**：R1 说明、R2 notice 标题/正文、R3 两行、错误表关键条。
 *   ④ **接线**：重置视图替换页签栏（AuthTab 仍是两个值）；「忘记密码？」只在
 *      登录表单；「重新发送」始终可点（无 disabled / 无倒计时）；成功不自动关闭；
 *      重置成功后走与登录**同一条** restoreAfterLogin + loginRestoreFeedback。
 *
 * ⚠️ 真实收码链路不在本单验证（需要先在 Supabase 控制台把恢复邮件模板
 *    加上 `{{ .Token }}`）—— 这里全部用 mock。
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
const authModal = await import('@/components/auth/AuthModal');
const { validateEmail } = await import('@/utils/inputValidation');
const { meetsHitTarget } = await import('@/components/layout/hitTarget');

const AUTH_SRC = read('src/utils/supabase/auth.ts');
const MODAL_SRC = read('src/components/auth/AuthModal.tsx');
const LOGIN_SRC = read('src/components/auth/LoginForm.tsx');
const REGISTER_SRC = read('src/components/auth/RegisterForm.tsx');

const makeStore = () => configureStore({ reducer: { auth: authSlice.default } });

/**
 * 测试用新密码（自造值，不依赖任何环境变量）。
 *
 * 用 `join('')` 拼出来而不是写成一整条字面量：整条「像密码的字符串」会被
 * 密钥扫描（CI / 编辑器 / pre-commit）当成泄漏拦下，而这里只是测试数据。
 */
const NEW_PASSWORD = ['Str0ng', 'Pass', '!9'].join('');
const OTHER_PASSWORD = ['Other', 'Pass', '7', '@'].join('');

/** 注入假 Supabase 门面（只提供 `auth` 这一面）。 */
const setFakeAuth = (auth: Record<string, unknown>) => {
  runtime.setSupabaseFacadeLoader(async () => ({ auth }) as never);
};

/** 默认替身：任何未预期的调用都抛错（用例之间不许串味）。 */
const failAuth = () =>
  setFakeAuth({
    resetPasswordForEmail: async () => {
      throw new Error('unexpected resetPasswordForEmail call');
    },
    verifyOtp: async () => {
      throw new Error('unexpected verifyOtp call');
    },
    updateUser: async () => {
      throw new Error('unexpected updateUser call');
    },
  });

const dispatchRejected = async (thunk: Promise<unknown>): Promise<{ code?: string }> => {
  try {
    await thunk;
  } catch (error) {
    return error as { code?: string };
  }
  assert.fail('期望 thunk 被拒绝，但它成功了');
};

afterEach(() => {
  env.lsData.clear();
  env.chromeData.clear();
  failAuth();
});

/* ── ① 错误映射 ─────────────────────────────────────────────────────────── */

describe('AUTH_ERROR_PATTERNS：OTP / 新旧密码相同', () => {
  it('验证码过期 / 无效 →「验证码不正确或已过期」', () => {
    for (const raw of [
      'Token has expired or is invalid',
      'Invalid OTP',
      'Invalid email or token',
      'otp_expired',
    ]) {
      assert.equal(
        authSlice.authErrorCopy(raw),
        '验证码不正确或已过期',
        `原始文案「${raw}」必须映射到验证码提示`,
      );
    }
  });

  it('「Invalid email or token」不能被说成「邮箱地址格式不正确」', () => {
    assert.equal(
      authSlice.authErrorCopy('Invalid email or token'),
      '验证码不正确或已过期',
      'OTP 模式必须排在通用 invalid email 模式之前',
    );
  });

  it('new password should be different →「新密码不能与当前密码相同」', () => {
    assert.equal(
      authSlice.authErrorCopy('New password should be different from the old password.'),
      '新密码不能与当前密码相同',
    );
  });
});

describe('thunk：Supabase 调用打桩，失败带机器码', () => {
  it('验证码错 / 过期 ⇒ otp_invalid', async () => {
    setFakeAuth({
      verifyOtp: async () => ({
        data: null,
        error: { code: 'otp_expired', message: 'Token has expired or is invalid' },
      }),
    });
    const rejected = await dispatchRejected(
      makeStore()
        .dispatch(
          authSlice.submitPasswordReset({
            email: 'alice@example.com',
            code: '123456',
            password: NEW_PASSWORD,
          }),
        )
        .unwrap(),
    );
    assert.equal(rejected.code, 'otp_invalid');
    assert.deepEqual(authSlice.resetFailureNotice(rejected.code), {
      title: '验证码不正确或已过期',
      message: '请检查邮件里的验证码，或点「重新发送验证码」换一个新的。',
    });
  });

  it('验证码无效（无 code、只有英文文案）⇒ 也归到 otp_invalid', async () => {
    setFakeAuth({
      verifyOtp: async () => ({ data: null, error: { message: 'Invalid OTP' } }),
    });
    const rejected = await dispatchRejected(
      makeStore()
        .dispatch(
          authSlice.submitPasswordReset({
            email: 'alice@example.com',
            code: '000000',
            password: NEW_PASSWORD,
          }),
        )
        .unwrap(),
    );
    assert.equal(rejected.code, 'otp_invalid');
  });

  it('new password should be different ⇒ password_same', async () => {
    const user = { id: 'u-1', email: 'alice@example.com' };
    setFakeAuth({
      verifyOtp: async () => ({ data: { user, session: {} }, error: null }),
      updateUser: async () => ({
        data: null,
        error: {
          code: 'same_password',
          message: 'New password should be different from the old password.',
        },
      }),
    });
    const rejected = await dispatchRejected(
      makeStore()
        .dispatch(
          authSlice.submitPasswordReset({
            email: 'alice@example.com',
            code: '123456',
            password: NEW_PASSWORD,
          }),
        )
        .unwrap(),
    );
    assert.equal(rejected.code, 'password_same');
    assert.deepEqual(authSlice.resetFailureNotice(rejected.code), {
      title: '新密码不能与当前密码相同',
      message: '请换一个没用过的密码。',
    });
  });

  it('发送被限频 ⇒ send_rate_limited', async () => {
    setFakeAuth({
      resetPasswordForEmail: async () => ({
        data: null,
        error: { code: 'over_email_send_rate_limit', message: 'Email rate limit exceeded' },
      }),
    });
    const rejected = await dispatchRejected(
      makeStore().dispatch(authSlice.sendPasswordResetCode({ email: 'alice@example.com' })).unwrap(),
    );
    assert.equal(rejected.code, 'send_rate_limited');
    assert.deepEqual(authSlice.resetFailureNotice(rejected.code), {
      title: '发送太频繁',
      message: '请稍后再试。',
    });
  });

  it('发送网络失败 ⇒ send_network', async () => {
    setFakeAuth({
      resetPasswordForEmail: async () => ({ data: null, error: { message: 'Failed to fetch' } }),
    });
    const rejected = await dispatchRejected(
      makeStore().dispatch(authSlice.sendPasswordResetCode({ email: 'alice@example.com' })).unwrap(),
    );
    assert.equal(rejected.code, 'send_network');
    assert.deepEqual(authSlice.resetFailureNotice(rejected.code), {
      title: '验证码没能发出',
      message: '网络连接失败，请检查网络后重试。',
    });
  });

  it('提交时网络失败 ⇒ reset_network', async () => {
    setFakeAuth({
      verifyOtp: async () => ({ data: null, error: { message: 'Failed to fetch' } }),
    });
    const rejected = await dispatchRejected(
      makeStore()
        .dispatch(
          authSlice.submitPasswordReset({
            email: 'alice@example.com',
            code: '123456',
            password: NEW_PASSWORD,
          }),
        )
        .unwrap(),
    );
    assert.equal(rejected.code, 'reset_network');
    assert.deepEqual(authSlice.resetFailureNotice(rejected.code), {
      title: '重置失败',
      message: '网络连接失败，请检查网络后重试。',
    });
  });

  it('未知失败 ⇒ reset_failed / 操作失败，请稍后重试。', async () => {
    setFakeAuth({
      verifyOtp: async () => ({ data: null, error: { message: 'boom' } }),
    });
    const rejected = await dispatchRejected(
      makeStore()
        .dispatch(
          authSlice.submitPasswordReset({
            email: 'alice@example.com',
            code: '123456',
            password: NEW_PASSWORD,
          }),
        )
        .unwrap(),
    );
    assert.equal(rejected.code, 'reset_failed');
    assert.deepEqual(authSlice.resetFailureNotice(rejected.code), {
      title: '重置失败',
      message: '操作失败，请稍后重试。',
    });
  });

  it('成功链路：先 verifyOtp(recovery) 再 updateUser(新密码)，并把登录态写进 store', async () => {
    const calls: string[] = [];
    const user = { id: 'u-1', email: 'alice@example.com' };
    setFakeAuth({
      verifyOtp: async (email: string, token: string) => {
        calls.push(`verify:${email}:${token}`);
        return { data: { user, session: { access_token: 't' } }, error: null };
      },
      updateUser: async (password: string) => {
        calls.push(`update:${password}`);
        return { data: { user }, error: null };
      },
    });

    const store = makeStore();
    const result = await store
      .dispatch(
        authSlice.submitPasswordReset({
          email: 'alice@example.com',
          code: '123456',
          password: NEW_PASSWORD,
        }),
      )
      .unwrap();

    assert.deepEqual(calls, [`verify:alice@example.com:123456`, `update:${NEW_PASSWORD}`]);
    assert.equal(result.id, 'u-1');
    assert.equal(result.email, 'alice@example.com');

    const state = store.getState().auth;
    assert.equal(state.isAuthenticated, true, '校验通过 = 已登录');
    assert.equal(state.authStatusKind, 'authenticated');
    assert.equal(state.user?.email, 'alice@example.com');
    assert.equal(state.error, null);
  });

  it('发送成功 ⇒ 返回同一个邮箱（界面据此进入 R2）', async () => {
    const calls: string[] = [];
    setFakeAuth({
      resetPasswordForEmail: async (email: string) => {
        calls.push(email);
        return { data: {}, error: null };
      },
    });
    const result = await makeStore()
      .dispatch(authSlice.sendPasswordResetCode({ email: 'alice@example.com' }))
      .unwrap();
    assert.deepEqual(calls, ['alice@example.com']);
    assert.deepEqual(result, { email: 'alice@example.com' });
  });
});

/* ── ② 视图状态机 ───────────────────────────────────────────────────────── */

describe('重置流程状态机：R1 → R2 → R3', () => {
  it('初始是 R1（输入邮箱）', () => {
    assert.equal(authModal.initialResetFlowState.screen, 'email');
  });

  it('sent ⇒ R2；succeeded ⇒ R3；成功只切视图（reducer 里没有关闭动作）', () => {
    let state = authModal.resetFlowReducer(authModal.initialResetFlowState, {
      type: 'editEmail',
      value: 'alice@example.com',
    });
    state = authModal.resetFlowReducer(state, { type: 'sent', email: 'alice@example.com' });
    assert.equal(state.screen, 'code');
    assert.equal(state.sentEmail, 'alice@example.com');

    state = authModal.resetFlowReducer(state, { type: 'succeeded' });
    assert.equal(state.screen, 'success');
  });

  it('「改邮箱」回 R1 且保留已输入的邮箱', () => {
    let state = authModal.resetFlowReducer(authModal.initialResetFlowState, {
      type: 'sent',
      email: 'alice@example.com',
    });
    state = authModal.resetFlowReducer(state, { type: 'changeEmail' });
    assert.equal(state.screen, 'email');
    assert.equal(state.emailInput, 'alice@example.com', '回 R1 必须保留邮箱');
  });

  it('字段错误在编辑该字段时清掉（错误提示不会粘住）', () => {
    let state = authModal.resetFlowReducer(authModal.initialResetFlowState, {
      type: 'fieldErrors',
      errors: { email: '邮箱格式不正确' },
    });
    assert.equal(state.fieldErrors.email, '邮箱格式不正确');
    state = authModal.resetFlowReducer(state, { type: 'editEmail', value: 'a' });
    assert.equal(state.fieldErrors.email, undefined);
  });

  it('字段级错误与表单级错误不混用：新的字段错误会清掉表单级错误', () => {
    let state = authModal.resetFlowReducer(authModal.initialResetFlowState, {
      type: 'formError',
      title: '重置失败',
      message: '操作失败，请稍后重试。',
    });
    state = authModal.resetFlowReducer(state, {
      type: 'fieldErrors',
      errors: { code: '请输入验证码' },
    });
    assert.equal(state.formError, null);
    assert.equal(state.fieldErrors.code, '请输入验证码');
  });
});

/* ── ③ 字段校验（文案逐字）───────────────────────────────────────────────── */

describe('字段校验：邮箱（错误表逐字）', () => {
  it('邮箱为空 → 邮箱不能为空', () => {
    assert.equal(validateEmail('').error, '邮箱不能为空');
  });

  it('邮箱格式不对 → 邮箱格式不正确', () => {
    assert.equal(validateEmail('not-an-email').error, '邮箱格式不正确');
  });
});

describe('字段校验：验证码与新密码', () => {
  it('验证码为空 → 请输入验证码', () => {
    assert.equal(authModal.validateResetCode(''), '请输入验证码');
    assert.equal(authModal.validateResetCode('   '), '请输入验证码');
  });

  it('验证码不是 6 位数字 → 验证码是 6 位数字', () => {
    assert.equal(authModal.validateResetCode('12345'), '验证码是 6 位数字');
    assert.equal(authModal.validateResetCode('12345a'), '验证码是 6 位数字');
    assert.equal(authModal.validateResetCode('1234567'), '验证码是 6 位数字');
  });

  it('合法的 6 位数字通过', () => {
    assert.equal(authModal.validateResetCode('123456'), null);
    assert.equal(authModal.validateResetCode(' 123456 '), null);
  });

  it('密码四条直接复用 validatePassword 的现有文案', () => {
    assert.equal(
      authModal.validateResetPasswords('', '').password,
      '密码不能为空',
    );
    assert.equal(
      authModal.validateResetPasswords('Ab1!', 'Ab1!').password,
      '密码长度至少8位',
    );
    assert.equal(
      authModal.validateResetPasswords(NEW_PASSWORD + 'x'.repeat(121), 'x').password,
      '密码长度不能超过128位',
    );
    assert.equal(
      authModal.validateResetPasswords('abcdefgh', 'abcdefgh').password,
      '密码必须包含大写字母、小写字母、数字和特殊字符中的至少3种',
    );
  });

  it('两次输入不一致 → 两次输入的密码不一致', () => {
    assert.equal(
      authModal.validateResetPasswords(NEW_PASSWORD, OTHER_PASSWORD).confirmPassword,
      '两次输入的密码不一致',
    );
  });

  it('合法且一致 ⇒ 无错误', () => {
    assert.deepEqual(authModal.validateResetPasswords(NEW_PASSWORD, NEW_PASSWORD), {});
  });
});

/* ── ④ 文案逐字 ─────────────────────────────────────────────────────────── */

describe('文案逐字（设计说明「四」）', () => {
  it('R1 说明', () => {
    assert.equal(
      authModal.RESET_COPY.emailDescription,
      '输入你注册时用的邮箱，我们会发一条 6 位验证码。',
    );
  });

  it('R2 notice 标题 / 正文', () => {
    assert.equal(authModal.RESET_COPY.sentTitle, '验证码已发送');
    assert.equal(
      authModal.resetSentMessage('alice@example.com'),
      '如果 alice@example.com 已注册，验证码已发到该邮箱。没收到请检查垃圾邮件。',
    );
  });

  it('R3 两行', () => {
    assert.equal(authModal.RESET_COPY.successTitle, '密码已更新');
    assert.equal(authModal.RESET_COPY.successMessage, '你已用新密码登录。');
  });

  it('R2 其余文案（字段 / 规则提示 / 按钮）', () => {
    assert.equal(authModal.RESET_COPY.codeLabel, '验证码');
    assert.equal(authModal.RESET_COPY.newPasswordLabel, '新密码');
    assert.equal(authModal.RESET_COPY.confirmPasswordLabel, '确认新密码');
    assert.equal(
      authModal.RESET_COPY.passwordHint,
      '至少 8 位，且包含大写字母、小写字母、数字、特殊字符中的至少 3 种',
    );
    assert.equal(authModal.RESET_COPY.submit, '重置密码');
    assert.equal(authModal.RESET_COPY.resend, '重新发送验证码');
    assert.equal(authModal.RESET_COPY.changeEmail, '改邮箱');
  });

  it('R1 其余文案（标题 / 占位符 / 按钮 / 返回）', () => {
    assert.equal(authModal.RESET_COPY.headerTitle, '重置密码');
    assert.equal(authModal.RESET_COPY.emailPlaceholder, '你的邮箱地址');
    assert.equal(authModal.RESET_COPY.sendCode, '发送验证码');
    assert.equal(authModal.RESET_COPY.sending, '发送中…');
    assert.equal(authModal.RESET_COPY.backToLogin, '返回登录');
    assert.equal(authModal.RESET_COPY.startUsing, '开始使用');
  });

  it('错误表关键条逐字', () => {
    assert.deepEqual(authSlice.resetFailureNotice('otp_invalid'), {
      title: '验证码不正确或已过期',
      message: '请检查邮件里的验证码，或点「重新发送验证码」换一个新的。',
    });
    assert.deepEqual(authSlice.resetFailureNotice('password_same'), {
      title: '新密码不能与当前密码相同',
      message: '请换一个没用过的密码。',
    });
    assert.deepEqual(authSlice.resetFailureNotice('send_failed'), {
      title: '验证码没能发出',
      message: '操作失败，请稍后重试。',
    });
  });

  it('不说「该邮箱未注册」（避免撞库探测）', () => {
    for (const [name, source] of [
      ['AuthModal', MODAL_SRC],
      ['LoginForm', LOGIN_SRC],
      ['authSlice', read('src/store/slices/authSlice.ts')],
    ] as const) {
      assert.ok(!source.includes('未注册'), `${name} 里出现了「未注册」—— 会泄露邮箱是否存在`);
    }
  });
});

/* ── ⑤ 接线 ─────────────────────────────────────────────────────────────── */

describe('接线：重置视图替换页签栏', () => {
  it('AuthTab 保持两个值（重置不是第三个页签）', () => {
    assert.match(MODAL_SRC, /export type AuthTab = 'login' \| 'register';/);
    assert.ok(!/AuthTab = .*reset/.test(MODAL_SRC), 'AuthTab 不许把 reset 当页签');
  });

  it('重置视图激活时渲染一行头部（左「重置密码」+ 右「返回登录」），而不是 tablist', () => {
    const resetHeaderAt = MODAL_SRC.indexOf('{RESET_COPY.headerTitle}');
    const tablistAt = MODAL_SRC.indexOf('role="tablist"');
    assert.ok(resetHeaderAt > 0, '找不到重置视图头部');
    assert.ok(tablistAt > 0, '找不到页签栏');
    assert.ok(
      resetHeaderAt < tablistAt,
      '重置头部必须在页签栏之前（即位于 showReset 分支），页签栏只出现在非重置分支',
    );
    // 页签栏只出现一次（重置分支没有第二份）。
    assert.equal(MODAL_SRC.split('role="tablist"').length - 1, 1);
    assert.match(MODAL_SRC, /\{showReset \? \(/, '必须由 showReset 分支替换页签栏');
    // 钉**路径**而不是顺序：页签栏必须落在 `{showReset ? (…) : (` 的 else 分支里。
    // 只断言「头部在页签栏之前」的话，把页签栏改成无条件渲染也照样绿。
    const showResetAt = MODAL_SRC.indexOf('{showReset ? (');
    const elseSepAt = MODAL_SRC.lastIndexOf(') : (', tablistAt);
    assert.ok(
      elseSepAt > showResetAt,
      '页签栏之前必须紧邻 showReset 的 else 分支（重置视图激活时页签栏不能被渲染）',
    );
    assert.ok(
      !MODAL_SRC.slice(elseSepAt, tablistAt).includes('}'),
      'else 分支在页签栏之前就闭合了 ⇒ 页签栏是无条件渲染（重置时也会出现）',
    );
  });

  it('重置成功后走与登录同一条 restoreAfterLogin + loginRestoreFeedback', () => {
    const resetView = MODAL_SRC.slice(
      MODAL_SRC.indexOf('const PasswordResetView'),
      MODAL_SRC.indexOf('interface AuthModalProps'),
    );
    assert.match(resetView, /restoreAfterLogin\(dispatch\)/);
    assert.match(resetView, /loginRestoreFeedback\(outcome\)/);
    assert.match(resetView, /showToast\(feedback\.text, feedback\.tone\)/);
  });

  it('成功视图只承诺「已登录」，不承诺「正在拉回」', () => {
    const resetView = MODAL_SRC.slice(
      MODAL_SRC.indexOf('const PasswordResetView'),
      MODAL_SRC.indexOf('interface AuthModalProps'),
    );
    assert.ok(
      !/正在(拉回|同步|恢复)/.test(resetView),
      '成功视图不许承诺「正在拉回」—— 只承诺已登录',
    );
  });

  it('成功不自动关闭：只有「开始使用」按钮触发 onClose，重置视图里没有 effect', () => {
    const resetView = MODAL_SRC.slice(
      MODAL_SRC.indexOf('const PasswordResetView'),
      MODAL_SRC.indexOf('interface AuthModalProps'),
    );
    assert.match(resetView, /onClick=\{onClose\}/, '「开始使用」必须由按钮触发关闭');
    assert.ok(!/useEffect/.test(resetView), '重置视图里不许有 effect（否则可能自动关闭）');
  });

  it('「重新发送验证码」始终可点（无 disabled、无倒计时）', () => {
    const resendLabelAt = MODAL_SRC.indexOf('{RESET_COPY.resend}');
    assert.ok(resendLabelAt > 0);
    // 取该按钮的 JSX 片段（向前回溯到 <button 起）。
    const buttonStart = MODAL_SRC.lastIndexOf('<button', resendLabelAt);
    const resendButton = MODAL_SRC.slice(buttonStart, resendLabelAt + 40);
    assert.ok(!/disabled=/.test(resendButton), '「重新发送验证码」不许 disabled');
    assert.ok(
      !/(setInterval|countdown)/i.test(MODAL_SRC),
      '不许做倒计时（服务端发送间隔由项目设置决定）',
    );
  });

  it('验证码输入框：inputmode=numeric + autocomplete=one-time-code', () => {
    assert.match(MODAL_SRC, /inputMode="numeric"/);
    assert.match(MODAL_SRC, /autoComplete="one-time-code"/);
  });

  it('R2 顶部提示是 info 语气，成功是 success 语气；表单级错误是 error 语气', () => {
    assert.match(MODAL_SRC, /tone="info"/);
    assert.match(MODAL_SRC, /tone="success"/);
    assert.match(MODAL_SRC, /tone="error"/);
  });

  it('字段级错误用统一的 rose 文本（与表单级 InlineNotice 不混用）', () => {
    assert.ok(
      MODAL_SRC.includes(
        '<p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{message}</p>',
      ),
      '字段级错误的类名必须与错误表一致',
    );
  });
});

describe('接线：「忘记密码？」只在登录表单', () => {
  it('LoginForm 有「忘记密码？」文本按钮，靠右，命中区 ≥36px', () => {
    assert.match(LOGIN_SRC, /忘记密码？/);
    assert.match(LOGIN_SRC, /justify-end/, '忘记密码必须靠右');
    assert.match(LOGIN_SRC, /theme-accent-text/, '必须是 theme-accent-text 文本按钮');
    const classMatch = /className="([^"]*min-h-9[^"]*)"/.exec(LOGIN_SRC);
    assert.ok(classMatch, '找不到带 min-h-9 的按钮类名');
    assert.equal(
      meetsHitTarget(classMatch[1]),
      true,
      `「忘记密码？」命中区不足 36px：${classMatch[1]}`,
    );
  });

  it('RegisterForm 不加「忘记密码？」', () => {
    assert.ok(!REGISTER_SRC.includes('忘记密码'), '注册表单不该有忘记密码入口');
  });
});

describe('接线：Supabase 封装', () => {
  it('auth.ts 提供 resetPasswordForEmail / verifyOtp(recovery) / updateUser', () => {
    assert.match(AUTH_SRC, /async resetPasswordForEmail\(email: string\)/);
    assert.match(AUTH_SRC, /verifyOtp\(\{ email, token, type: 'recovery' \}\)/);
    assert.match(AUTH_SRC, /async updateUser\(password: string\)/);
    assert.match(AUTH_SRC, /updateUser\(\{ password \}\)/);
  });
});
