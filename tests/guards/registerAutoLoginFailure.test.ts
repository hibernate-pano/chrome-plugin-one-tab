// 注册成功但自动登录失败时，不许当成登录成功（2026-10-18 round 23）。
//
// 【要防的回归类别】`RegisterForm` 原先写的是：
//     const result = await dispatch(signUp(...)).unwrap();   // ← 这个 unwrap 了
//     if (result) {
//       setRegistrationSuccess(true);
//       await dispatch(signIn({ email, password }));          // ← 这个没有
//       if (onSuccess) onSuccess();                           // ← 无条件执行
//     }
// 而 RTK 的 `await dispatch(thunk)` 在 thunk 抛错时**不抛**，只 resolve 成一个
// rejected action ⇒ 自动登录失败被当成成功：onSuccess（= AuthModal 的 onClose）照样执行，
// 弹窗关闭、用户以为已登录，authSlice 写下的 error 随组件卸载永远看不到；
// 此后点同步才收到「请先登录」，想重试注册又只会得到「已注册」——死胡同。
// 同目录的 LoginForm 一直是 `.unwrap()` 的，同一个动作两个口径。
//
// 本守卫钉三件事：① RTK 那条「await dispatch 不抛」的行为（根因，真跑一次）；
// ② RegisterForm 必须 unwrap 且失败时不关窗、不报「注册失败」；③ 两个表单口径一致。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureStore, createAsyncThunk } from '@reduxjs/toolkit';
import authReducer, { signUp, signIn } from '@/store/slices/authSlice';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

describe('根因：await dispatch(rejected thunk) 不抛，只有 .unwrap() 才抛', () => {
  const boom = createAsyncThunk('t/boom', async () => {
    throw new Error('自动登录失败');
  });
  const store = configureStore({ reducer: (s = {}) => s });

  it('await dispatch(...) 会 resolve 成 rejected action —— 不看结果就等于把失败当成功', async () => {
    const action = await store.dispatch(boom());
    assert.ok(action.type.endsWith('/rejected'), `期望 rejected action，实际 ${action.type}`);
  });

  it('.unwrap() 才会抛 —— 这是唯一能拦住「失败当成功」的写法', async () => {
    // 抛出来的是 RTK 的 SerializedError（普通对象，不是 Error 实例），故按 message 取。
    let rejected: unknown;
    try {
      await store.dispatch(boom()).unwrap();
    } catch (err) {
      rejected = err;
    }
    assert.ok(rejected, '.unwrap() 必须把 thunk 的错误抛出来，否则 RegisterForm 拦不住');
    const message = (rejected as { message?: string }).message ?? String(rejected);
    assert.match(message, /自动登录失败/, `抛出的错误信息不对：${message}`);
  });
});

describe('RegisterForm：自动登录必须看结果', () => {
  const source = read('src/components/auth/RegisterForm.tsx');

  it('signIn 的 dispatch 必须 .unwrap()，且 onSuccess 排在它之后', () => {
    assert.match(
      source,
      /await dispatch\(signIn\(\{ email, password \}\)\)\.unwrap\(\)/,
      'RegisterForm 的自动登录没 unwrap —— 失败会被当成成功（LoginForm 是 unwrap 的）'
    );
    assert.ok(
      source.indexOf('onSuccess()') > source.indexOf('dispatch(signIn'),
      'onSuccess 排在自动登录之前？那等于无论登录成败都关窗'
    );
  });

  it('失败时留住弹窗，并给出「账号已创建」的下一步', () => {
    assert.match(source, /setAutoLoginFailed\(true\)/, '失败分支没有把状态标出来');
    assert.match(source, /账号已创建，但自动登录失败/, '失败时没有告诉用户账号其实已经建好了');
    assert.match(source, /手动登录/, '失败时没有给出下一步（用户会去重试注册，撞上「已注册」）');
  });

  it('失败时不得再挂「注册失败」的标题（那是假话）', () => {
    assert.match(
      source,
      /\{error && !autoLoginFailed &&/,
      '「注册失败」提示没有排除自动登录失败的情况 —— 账号明明建好了却说注册失败'
    );
  });
});

describe('注册不等于登录（store 层）', () => {
  // 表单说「自动登录失败，请手动登录」时，顶栏不能同时显示「退出登录」——那会让
  // 同步按钮解锁、用户以为已经登进去了。
  const store = configureStore({ reducer: { auth: authReducer } });
  const user = { id: 'u-1', email: 'a@b.com', lastLogin: '2026-10-18T00:00:00.000Z' };

  it('signUp.fulfilled 不得把 isAuthenticated 置真', () => {
    store.dispatch(signUp.fulfilled(user, 'req-1', { email: user.email, password: 'x' }));
    const state = store.getState().auth;
    assert.equal(
      state.isAuthenticated,
      false,
      '注册成功被当成登录成功 —— 邮箱待确认时顶栏会显示「退出登录」，与注册表单的提示互相矛盾'
    );
  });

  it('signIn.fulfilled 才是建立登录态的那一步', () => {
    store.dispatch(signIn.fulfilled(user, 'req-2', { email: user.email, password: 'x' }));
    assert.equal(store.getState().auth.isAuthenticated, true, '登录成功后必须是已登录');
  });
});

describe('两个表单对同一个动作必须同口径', () => {
  it('LoginForm 也 unwrap（两边都得看结果）', () => {
    const login = read('src/components/auth/LoginForm.tsx');
    assert.match(login, /\.unwrap\(\)/, 'LoginForm 不再 unwrap 了');
  });
});
