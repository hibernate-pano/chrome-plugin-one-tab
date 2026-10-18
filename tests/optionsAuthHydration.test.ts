// 设置页必须拿到真实登录态（2026-10-18 round 28）。
//
// 背景：`state.auth.isAuthenticated` 只由 `getCurrentUser` / `signIn` 建立，而 Redux store 是
// **每个执行上下文各一份**。popup 由 AuthProvider 注入这一步，options 页刻意不挂 AuthProvider
// （它登录后会顺手发一次整库自动下载）。于是 options 页读到的登录态恒为 false ——
// 而它是「自动同步」开关的唯一判据（canEnableAutoSync 对云端后端要求 isAuthenticated）
// ⇒ 云端用户（默认后端）永远开不了自动同步，还被告知「尚未登录 TapStack 云端」。
//
// 真机复现见 /tmp/one-tab-loop/verify-round28.mjs（改前 6/9）。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

before(async () => {
  register(LOADER_PATH);
});

const read = (rel: string) =>
  readFile(resolve(dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8');

describe('options 页：登录态必须自己注入一次', () => {
  it('OptionsPage 挂载时 dispatch(getCurrentUser())', async () => {
    const src = await read('src/options/OptionsPage.tsx');
    assert.match(src, /import \{ getCurrentUser \} from '@\/store\/slices\/authSlice'/,
      '必须显式 import getCurrentUser');
    // 必须是「挂载即跑」的一次性注入，而不是只在某个点击分支里
    assert.match(src, /useEffect\(\(\) => \{\s*void dispatch\(getCurrentUser\(\)\);\s*\}, \[dispatch\]\);/,
      '必须有 useEffect(() => { void dispatch(getCurrentUser()); }, [dispatch])');
  });

  it('注入的是登录态，不是自动下载（AuthProvider 的整库下载不得被搬进来）', async () => {
    const src = await read('src/options/OptionsPage.tsx');
    assert.doesNotMatch(src, /sendSyncCommand\('download'/,
      '设置页不许发自动下载 —— 这正是它不挂 AuthProvider 的原因');
  });

  it('闸门读的就是这份 Redux 登录态（判据与注入值同一处）', async () => {
    const src = await read('src/options/OptionsPage.tsx');
    assert.match(src, /useAppSelector\(state => state\.auth\.isAuthenticated\)/,
      '登录态必须来自 Redux auth');
    assert.match(src, /canEnableAutoSync\(fresh, isAuthenticated\)/,
      '自动同步闸门必须用同一个值，不许另算一份');
  });

  it('popup 侧的 AuthProvider 仍在注入（两处同一动作）', async () => {
    const src = await read('src/components/app/AuthProvider.tsx');
    assert.match(src, /getCurrentUser/, 'AuthProvider 仍负责 popup 的登录态注入');
  });

  it('登录态是异步注入的，必须进开关回调的依赖数组（否则闭包在首帧的 false 上）', async () => {
    const src = await read('src/options/OptionsPage.tsx');
    const start = src.indexOf('const handleToggleAutoSync = useCallback');
    const depsIdx = src.indexOf('}, [dispatch', start);
    assert.ok(start > 0 && depsIdx > start, '必须能定位到 handleToggleAutoSync 的依赖数组');
    const deps = src.slice(depsIdx, src.indexOf(']);', depsIdx));
    assert.match(deps, /isAuthenticated/, '依赖数组必须含 isAuthenticated');
    assert.match(deps, /settings\.syncEnabled/, '原有依赖不得丢');
  });
});

describe('getCurrentUser：未登录时安全（options 页可以无条件 dispatch）', () => {
  it('thunk 内部先查会话，无会话直接返回 null', async () => {
    const src = await read('src/store/slices/authSlice.ts');
    const start = src.indexOf('export const getCurrentUser');
    const thunk = src.slice(start, src.indexOf('export const', start + 10));
    assert.match(thunk, /await supabaseAuth\.getSession\(\)/,
      '必须先查会话 —— 否则未登录用户会吃一个错误');
    assert.match(thunk, /if \(!sessionData \|\| !sessionData\.session\)[\s\S]{0,120}return null;/,
      '无会话必须直接返回 null（不抛错）');
  });

  it('fulfilled 把 isAuthenticated 置真（闸门读的就是它）', async () => {
    const { configureStore } = await import('@reduxjs/toolkit');
    const { default: authReducer, getCurrentUser } = await import('@/store/slices/authSlice');
    const store = configureStore({ reducer: { auth: authReducer } });
    assert.equal(store.getState().auth.isAuthenticated, false, '初始必须是未登录');

    store.dispatch(
      getCurrentUser.fulfilled(
        { id: 'u1', email: 'a@b.c', lastLogin: '2026-10-18T00:00:00.000Z' },
        'req-1',
        undefined
      )
    );
    assert.equal(store.getState().auth.isAuthenticated, true);
  });
});
