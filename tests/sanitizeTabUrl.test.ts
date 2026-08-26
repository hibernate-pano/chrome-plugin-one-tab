// sanitizeTabUrl 单元测试——钉死 URL 注入链的协议白名单/黑名单行为。
//
// 适用范围：oneTabFormatParser / importGroups / TabManager.saveAllTabs /
// syncEngine.downloadTabGroups / service-worker OPEN_TAB 全部依赖此函数。
// 任何宽松化协议允许列表的 PR 都会先在这里爆红。

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

describe('sanitizeTabUrl: 协议白名单/黑名单', () => {
  it('https/http/ftp 合法 URL → 原样返回', async () => {
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');
    assert.strictEqual(sanitizeTabUrl('https://example.com/path?q=1'), 'https://example.com/path?q=1');
    assert.strictEqual(sanitizeTabUrl('http://example.com'), 'http://example.com');
    assert.strictEqual(sanitizeTabUrl('ftp://files.example.com/a.zip'), 'ftp://files.example.com/a.zip');
  });

  it('javascript: 协议拒绝 → 返回 null', async () => {
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');
    assert.strictEqual(sanitizeTabUrl('javascript:alert(1)'), null);
    assert.strictEqual(sanitizeTabUrl('JAVASCRIPT:alert(1)'), null);
    assert.strictEqual(sanitizeTabUrl('  javascript:alert(1)  '), null); // trim 后仍是 javascript:
  });

  it('data: 协议拒绝 → 返回 null（防 data:text/html XSS）', async () => {
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');
    assert.strictEqual(sanitizeTabUrl('data:text/html,<script>alert(1)</script>'), null);
    assert.strictEqual(sanitizeTabUrl('data:image/png;base64,iVBORw0KGgo='), null);
  });

  it('vbscript: / file: / blob: 协议拒绝', async () => {
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');
    assert.strictEqual(sanitizeTabUrl('vbscript:msgbox(1)'), null);
    assert.strictEqual(sanitizeTabUrl('file:///etc/passwd'), null);
    assert.strictEqual(sanitizeTabUrl('blob:https://example.com/abc'), null);
  });

  it('loading:// 占位符保留', async () => {
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');
    assert.strictEqual(
      sanitizeTabUrl('loading://abc-123'),
      'loading://abc-123'
    );
  });

  it('about: 接受', async () => {
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');
    assert.strictEqual(sanitizeTabUrl('about:blank'), 'about:blank');
  });

  it('空字符串/纯空格/null/undefined/非字符串 → null', async () => {
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');
    assert.strictEqual(sanitizeTabUrl(''), null);
    assert.strictEqual(sanitizeTabUrl('   '), null);
    assert.strictEqual(sanitizeTabUrl(null), null);
    assert.strictEqual(sanitizeTabUrl(undefined), null);
    assert.strictEqual(sanitizeTabUrl(123), null);
    assert.strictEqual(sanitizeTabUrl({ url: 'x' }), null);
  });

  it('无效 URL 字符串（new URL 抛错）→ null', async () => {
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');
    assert.strictEqual(sanitizeTabUrl('not a url'), null);
    assert.strictEqual(sanitizeTabUrl('http://'), null);
  });

  it('首尾空白被 trim，但内容不变', async () => {
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');
    assert.strictEqual(
      sanitizeTabUrl('  https://example.com  '),
      'https://example.com'
    );
  });

  // ponytail: v1.17.0 hotfix — 白名单真正生效（之前是死代码，三分支全 return trimmed）
  it('白名单严格生效：chrome-extension://、intent://、view-source: 等非白名单协议拒绝', async () => {
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');
    assert.strictEqual(sanitizeTabUrl('chrome-extension://abcd/popup.html'), null);
    assert.strictEqual(sanitizeTabUrl('intent://example.com#Intent;scheme=https'), null);
    assert.strictEqual(sanitizeTabUrl('view-source:https://example.com'), null);
    assert.strictEqual(sanitizeTabUrl('ms-appx-web://example.com'), null);
    assert.strictEqual(sanitizeTabUrl('chrome://settings'), null);
  });
});