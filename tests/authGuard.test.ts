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
    const { ensureAuthenticated } = await import('@/utils/authGuard');
    let restoreCalled = 0;
    const ok = await ensureAuthenticated({
      isAuthenticated: () => true,
      restoreAuth: async () => { restoreCalled++; return true; },
    });
    assert.equal(ok, true);
    assert.equal(restoreCalled, 0, '已认证时不应调用恢复');
  });

  it('store 未认证 + 恢复成功 → 放行', async () => {
    const { ensureAuthenticated } = await import('@/utils/authGuard');
    const ok = await ensureAuthenticated({
      isAuthenticated: () => false,
      restoreAuth: async () => true,
    });
    assert.equal(ok, true);
  });

  it('store 未认证 + 恢复失败（无持久化 session）→ 拒绝', async () => {
    const { ensureAuthenticated } = await import('@/utils/authGuard');
    const ok = await ensureAuthenticated({
      isAuthenticated: () => false,
      restoreAuth: async () => false,
    });
    assert.equal(ok, false);
  });

  it('恢复抛异常 → 拒绝而不抛出（入口不能因为恢复失败而崩溃）', async () => {
    const { ensureAuthenticated } = await import('@/utils/authGuard');
    const ok = await ensureAuthenticated({
      isAuthenticated: () => false,
      restoreAuth: async () => { throw new Error('network down'); },
    });
    assert.equal(ok, false);
  });
});
