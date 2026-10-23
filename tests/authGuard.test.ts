// 登录态守卫（纯函数）：SW 各入口（upload/download）共用的「store 未认证 →
// 从持久化 session 恢复一次」语义。冷 SW 场景见 syncEngine：popup 发起的
// download 曾因缺恢复路径而一律 not_authenticated（2026-09-12 审计发现）。
//
// ── 2026-10-23（第 50 轮）：返回值从 `boolean` 改成**四档判定** ────────────
// 判据层（core/authStatus.ts）早就规定「核不到 ⇒ 不许说没登录」，
// 而闸门层一直返回 boolean ⇒ 「核不到」（断网 / 402）被读成「没登录」。
// 本文件因此从「断言 true/false」改成「断言**那一档**」。
//
// ⚠️ 断言的是**性质**（「核不到 ⇒ 绝不落到 not_authenticated」），
// 不是某一档的字面量 —— 将来多一档「核不到的原因」，判据仍然成立。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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

describe('ensureAuthenticated: SW 登录态恢复守卫', () => {
  it('store 已认证 → 直接放行，不触发恢复（不碰 supabase 网络）', async () => {
    const { ensureAuthenticated } = await import('@/core/authGuard');
    let restoreCalled = 0;
    const verdict = await ensureAuthenticated({
      isAuthenticated: () => true,
      restoreAuth: async () => { restoreCalled++; return true; },
    });
    assert.equal(verdict.allowed, true);
    assert.equal(restoreCalled, 0, '已认证时不应调用恢复');
  });

  it('store 未认证 + 恢复成功 → 放行', async () => {
    const { ensureAuthenticated } = await import('@/core/authGuard');
    const verdict = await ensureAuthenticated({
      isAuthenticated: () => false,
      restoreAuth: async () => true,
    });
    assert.equal(verdict.allowed, true);
  });

  it('store 未认证 + 恢复失败（无持久化 session）→ 拒绝，且是「核到没登录」那一档', async () => {
    const { ensureAuthenticated } = await import('@/core/authGuard');
    const verdict = await ensureAuthenticated({
      isAuthenticated: () => false,
      restoreAuth: async () => false,
    });
    assert.equal(verdict.allowed, false);
    assert.equal(
      verdict.allowed === false ? verdict.kind : null,
      'not_authenticated',
      '恢复**返回 false** = 明确核到没有会话 ⇒ 这一档必须是 not_authenticated'
    );
  });

  it('恢复抛异常 → 拒绝而不抛出（入口不能因为恢复失败而崩溃）', async () => {
    const { ensureAuthenticated } = await import('@/core/authGuard');
    const verdict = await ensureAuthenticated({
      isAuthenticated: () => false,
      restoreAuth: async () => { throw new Error('network down'); },
    });
    assert.equal(verdict.allowed, false);
  });

  // ── 2026-10-23（第 50 轮）：核不到 ⇒ **绝不**落到「没登录」那一档 ──────
  //
  // 这是本轮最重的一个性质：修复前 `catch { return false; }` 把**所有**
  // 失败都读成「没登录」⇒ 用户明明登录着（只是断网）却看到「用户未登录」，
  // 于是去重新输密码 —— 而重新登录在断网时**必然失败**。
  it('恢复抛「网络断了」类异常 ⇒ 那一档必须是 unknown，不得是 not_authenticated', async () => {
    const { ensureAuthenticated } = await import('@/core/authGuard');
    const verdict = await ensureAuthenticated({
      isAuthenticated: () => false,
      restoreAuth: async () => { throw new Error('网络连接失败，请检查网络后重试'); },
    });
    assert.equal(verdict.allowed, false);
    assert.equal(
      verdict.allowed === false ? verdict.kind : null,
      'unknown',
      '「核不到」绝不能被读成「没登录」—— 那是更重的一句谎'
    );
  });

  it('恢复抛「服务端不可用」⇒ 那一档必须是 backend_unavailable（不是 not_authenticated）', async () => {
    const { ensureAuthenticated } = await import('@/core/authGuard');
    const { BackendUnavailableError } = await import('@/core/backendUnavailable');
    const verdict = await ensureAuthenticated({
      isAuthenticated: () => false,
      restoreAuth: async () => {
        throw new BackendUnavailableError('云端项目被限制', 402);
      },
    });
    assert.equal(verdict.allowed, false);
    assert.equal(
      verdict.allowed === false ? verdict.kind : null,
      'backend_unavailable',
      '「等我们恢复」与「请重新登录」是两句不同的话，下一步完全不同'
    );
  });
});

describe('自带存储后端：门禁不查 Supabase 账号（2026-10-14 真机 E2E 挖出）', () => {
  // 背景：WebDAV 用户没有 Supabase 账号。门禁继续问「你有没有 Supabase 账号」，
  // 结果 WebDAV 用户点同步一律得到「用户未登录」，且**永远走不到**锁定后端
  // 抛的「去重新解锁」。旧实现下这两条断言都会失败。
  it('backendId=webdav 且 store 未认证 → 放行（不查账号、不恢复 session）', async () => {
    const { ensureAuthenticated } = await import('@/core/authGuard');
    let isAuthChecked = 0;
    let restoreCalled = 0;
    const verdict = await ensureAuthenticated({
      isAuthenticated: () => { isAuthChecked++; return false; },
      restoreAuth: async () => { restoreCalled++; return false; },
      backendId: 'webdav',
    });
    assert.equal(verdict.allowed, true, '自带存储没有账号概念，必须放行到后端层判定');
    assert.equal(restoreCalled, 0, '不应尝试恢复 Supabase session');
    assert.equal(isAuthChecked, 0, '连「有没有登录」都不该问——问了就是 Supabase 假设');
  });

  it('backendId=webdav 时即使 restoreAuth 会抛错也不受影响（前置条件不在这层）', async () => {
    const { ensureAuthenticated } = await import('@/core/authGuard');
    const verdict = await ensureAuthenticated({
      isAuthenticated: () => false,
      restoreAuth: async () => { throw new Error('network down'); },
      backendId: 'webdav',
    });
    assert.equal(verdict.allowed, true, '后端不可用该由后端自己说，不该在这里变成「未登录」');
  });

  it('backendId=supabase → 语义逐字不变（漏传时也回落 supabase）', async () => {
    const { ensureAuthenticated } = await import('@/core/authGuard');
    const explicit = await ensureAuthenticated({
      isAuthenticated: () => false,
      restoreAuth: async () => false,
      backendId: 'supabase',
    });
    assert.equal(explicit.allowed, false, 'Supabase 用户没登录就是不能同步');
    assert.equal(
      explicit.allowed === false ? explicit.kind : null,
      'not_authenticated',
      '这一档必须是「核到没登录」'
    );
    const missing = await ensureAuthenticated({
      isAuthenticated: () => false,
      restoreAuth: async () => false,
      // 刻意不传 backendId：模拟新增调用点忘了传
    });
    assert.equal(missing.allowed, false, '漏传时必须回到既有语义（查账号），而不是变成放行');
  });
});
