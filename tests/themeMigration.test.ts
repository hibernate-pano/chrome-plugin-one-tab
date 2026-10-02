// 主题收敛（2026-09-28：8 → 4）迁移映射测试。
// 被砍主题（classic/mint/pink/cyberpunk）的存量 user_settings 在读取校验层
// 迁移到气质最近的保留主题，而不是一律回落 legacy；未知值仍回落 legacy。

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

describe('validateThemeStyle：主题收敛迁移映射', () => {
  it('保留主题原样通过', async () => {
    const { validateThemeStyle } = await import('@/utils/storage');
    assert.equal(validateThemeStyle('legacy'), 'legacy');
    assert.equal(validateThemeStyle('aurora'), 'aurora');
    assert.equal(validateThemeStyle('creamy'), 'creamy');
    assert.equal(validateThemeStyle('prism'), 'prism');
    assert.equal(validateThemeStyle('apple'), 'apple');
    assert.equal(validateThemeStyle('chrome'), 'chrome');
    assert.equal(validateThemeStyle('claude'), 'claude');
  });

  it('被砍主题按气质最近归宿迁移', async () => {
    const { validateThemeStyle } = await import('@/utils/storage');
    assert.equal(validateThemeStyle('classic'), 'legacy', '蓝系生产力 → legacy');
    assert.equal(validateThemeStyle('mint'), 'aurora', '冷调清新 → aurora');
    assert.equal(validateThemeStyle('pink'), 'creamy', '暖调柔和 → creamy');
    assert.equal(validateThemeStyle('cyberpunk'), 'prism', '个性渐变 → prism');
  });

  it('未知值与非字符串回落 legacy', async () => {
    const { validateThemeStyle } = await import('@/utils/storage');
    assert.equal(validateThemeStyle('nonexistent'), 'legacy');
    assert.equal(validateThemeStyle(42), 'legacy');
    assert.equal(validateThemeStyle(undefined), 'legacy');
    assert.equal(validateThemeStyle(null), 'legacy');
  });
});
