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

/**
 * 从源码里取出「登录态那个变量」。
 *
 * ── 为什么不逐字钉 `state.auth.isAuthenticated` ─────────────────────────
 * 第 50 轮把登录态从「一个布尔」改成「四档 + 还没核」，逐字断言会立刻变红
 * —— 但那不是回归，是**接口升级**。本仓纪律：守卫钉死字面量 ⇒ 改对了实现
 * 反而红（见记忆 stale-literal-guards-block-correct-fixes）。
 *
 * 真正要守的不变量是**数据流**：
 *   ① 登录态来自 Redux 的 auth 切片（不是页签自己另算一份）；
 *   ② 闸门用的**就是** selector 出来的**同一个变量**（不是重新读一次、
 *      也不是另取一个字段）；
 *   ③ 那个变量进了 useCallback 的依赖数组（它是**异步注入**的，
 *      不进依赖 ⇒ 闭包永远停在首帧的值上）。
 *
 * 所以这里**从源码里把变量名抠出来**，再拿它去钉 ②③ ——
 * 变量改名、字段名升级都不影响，语义一断立刻红。
 */
const extractAuthSelector = (
  src: string
): { ident: string; field: string } | null => {
  const m = /const\s+(\w+)\s*=\s*useAppSelector\(\s*state\s*=>\s*state\.auth\.(\w+)/.exec(src);
  return m ? { ident: m[1], field: m[2] } : null;
};

describe('options 页：登录态必须自己注入一次', () => {
  it('OptionsPage 挂载时 dispatch(getCurrentUser())', async () => {
    const src = await read('src/options/OptionsPage.tsx');
    // 断言的是「getCurrentUser 从 authSlice 被显式引入」这条**事实**，
    // 而不是「import 语句恰好长这样」。
    //
    // 2026-10-20：原来钉的是 `import { getCurrentUser } from '...'` 这一行**逐字**。
    // 本轮给设置页加了退出登录入口，于是这一行变成
    // `import { getCurrentUser, signOut } from '...'` —— 事实没变（两个都从
    // authSlice 来），但逐字断言红了。而逐字断言会把「多引一个同源的符号」
    // 变成红灯，这正是本仓文档守卫被审计批评过的毛病。
    //
    // 改钉不变量：**同一个 import 语句里必须同时出现 getCurrentUser**，
    // 且它来自 authSlice。别处再 import 也行（多一次引用不改变语义）。
    assert.match(
      src,
      /import\s*\{[^}]*\bgetCurrentUser\b[^}]*\}\s*from\s*'@\/store\/slices\/authSlice'/,
      '必须显式 import getCurrentUser（与它同行的其它符号不限）'
    );
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
    const sel = extractAuthSelector(src);
    assert.ok(sel, '登录态必须来自 Redux auth（不是页签自己另算一份）');
    assert.match(
      src,
      new RegExp(`canEnableAutoSync\\(\\s*\\w+\\s*,\\s*${sel.ident}\\s*\\)`),
      '自动同步闸门必须用 selector 出来的**同一个**变量，不许另算一份'
    );
  });

  it('popup 侧的 AuthProvider 仍在注入（两处同一动作）', async () => {
    const src = await read('src/components/app/AuthProvider.tsx');
    assert.match(src, /getCurrentUser/, 'AuthProvider 仍负责 popup 的登录态注入');
  });

  it('登录态是异步注入的，必须进开关回调的依赖数组（否则闭包在首帧的旧值上）', async () => {
    const src = await read('src/options/OptionsPage.tsx');
    const sel = extractAuthSelector(src);
    assert.ok(sel, '登录态必须来自 Redux auth');
    const start = src.indexOf('const handleToggleAutoSync = useCallback');
    const depsIdx = src.indexOf('}, [dispatch', start);
    assert.ok(start > 0 && depsIdx > start, '必须能定位到 handleToggleAutoSync 的依赖数组');
    const deps = src.slice(depsIdx, src.indexOf(']);', depsIdx));
    assert.match(
      deps,
      new RegExp(`\\b${sel.ident}\\b`),
      '依赖数组必须含登录态那个变量（它是异步注入的，不进依赖就永远是首帧的值）'
    );
    assert.match(deps, /settings\.syncEnabled/, '原有依赖不得丢');
  });
});

describe('getCurrentUser：未登录时安全（options 页可以无条件 dispatch）', () => {
  it('thunk 内部先查会话，无会话直接返回 null', async () => {
    const src = await read('src/store/slices/authSlice.ts');
    const start = src.indexOf('export const getCurrentUser');
    const thunk = src.slice(start, src.indexOf('export const', start + 10));
    // ⚠️ 钉的是**数据流**，不是某一句字面量（2026-10-23，第 51 轮）。
    //
    // 原来这里钉的是 `await supabaseAuth.getSession()` 这句**字面量**。
    // 但「读会话」这一步已经收敛到**唯一入口**
    // （`utils/supabase/sessionRead.ts` 的 `readSessionSafely`：先问云端在吗、
    //  再读、有 5 秒上限）⇒ 那句字面量**必然**变，而**性质没变**。
    //
    // ⇒ 断言改成钉**顺序**（先读会话、后取用户）+ **读会话这件事确实发生了**：
    // 这样「把读会话删了」会红，而「换个写法读会话」不会红。
    const sessionReadIdx = thunk.search(/readSessionSafely\(|\.getSession\(\)/);
    assert.ok(sessionReadIdx > 0, 'thunk 必须读会话 —— 否则未登录用户会吃一个错误');
    const userFetchIdx = thunk.search(/getCurrentUser\(\)|getUser\(\)/);
    assert.ok(userFetchIdx > 0, 'thunk 必须取用户信息');
    assert.ok(
      sessionReadIdx < userFetchIdx,
      '必须**先**读会话、后取用户（顺序反了 ⇒ 未登录用户会白吃一个错误）'
    );
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
