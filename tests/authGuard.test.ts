// 登录态守卫（纯函数）：SW 各入口（upload/download）共用的「store 未认证 →
// 从持久化 session 恢复一次」语义。冷 SW 场景见 syncEngine：popup 发起的
// download 曾因缺恢复路径而一律 not_authenticated（2026-09-12 审计发现）。

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
    const ok = await ensureAuthenticated({
      isAuthenticated: () => true,
      restoreAuth: async () => { restoreCalled++; return true; },
    });
    assert.equal(ok, true);
    assert.equal(restoreCalled, 0, '已认证时不应调用恢复');
  });

  it('store 未认证 + 恢复成功 → 放行', async () => {
    const { ensureAuthenticated } = await import('@/core/authGuard');
    const ok = await ensureAuthenticated({
      isAuthenticated: () => false,
      restoreAuth: async () => true,
    });
    assert.equal(ok, true);
  });

  it('store 未认证 + 恢复失败（无持久化 session）→ 拒绝', async () => {
    const { ensureAuthenticated } = await import('@/core/authGuard');
    const ok = await ensureAuthenticated({
      isAuthenticated: () => false,
      restoreAuth: async () => false,
    });
    assert.equal(ok, false);
  });

  it('恢复抛异常 → 拒绝而不抛出（入口不能因为恢复失败而崩溃）', async () => {
    const { ensureAuthenticated } = await import('@/core/authGuard');
    const ok = await ensureAuthenticated({
      isAuthenticated: () => false,
      restoreAuth: async () => { throw new Error('network down'); },
    });
    assert.equal(ok, false);
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
    const ok = await ensureAuthenticated({
      isAuthenticated: () => { isAuthChecked++; return false; },
      restoreAuth: async () => { restoreCalled++; return false; },
      backendId: 'webdav',
    });
    assert.equal(ok, true, '自带存储没有账号概念，必须放行到后端层判定');
    assert.equal(restoreCalled, 0, '不应尝试恢复 Supabase session');
    assert.equal(isAuthChecked, 0, '连「有没有登录」都不该问——问了就是 Supabase 假设');
  });

  it('backendId=webdav 时即使 restoreAuth 会抛错也不受影响（前置条件不在这层）', async () => {
    const { ensureAuthenticated } = await import('@/core/authGuard');
    const ok = await ensureAuthenticated({
      isAuthenticated: () => false,
      restoreAuth: async () => { throw new Error('network down'); },
      backendId: 'webdav',
    });
    assert.equal(ok, true, '后端不可用该由后端自己说，不该在这里变成「未登录」');
  });

  it('backendId=supabase → 语义逐字不变（漏传时也回落 supabase）', async () => {
    const { ensureAuthenticated } = await import('@/core/authGuard');
    assert.equal(
      await ensureAuthenticated({
        isAuthenticated: () => false,
        restoreAuth: async () => false,
        backendId: 'supabase',
      }),
      false,
      'Supabase 用户没登录就是不能同步'
    );
    assert.equal(
      await ensureAuthenticated({
        isAuthenticated: () => false,
        restoreAuth: async () => false,
        // 刻意不传 backendId：模拟新增调用点忘了传
      }),
      false,
      '漏传时必须回到既有语义（查账号），而不是变成放行'
    );
  });
});
