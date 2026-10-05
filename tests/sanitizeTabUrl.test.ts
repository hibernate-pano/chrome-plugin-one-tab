// sanitizeTabUrl 单元测试——钉死 URL 注入链的协议白名单/黑名单行为。
//
// 适用范围：oneTabFormatParser / importGroups / TabManager.saveAllTabs /
// syncEngine.downloadTabGroups / service-worker OPEN_TAB 全部依赖此函数。
// 任何宽松化协议允许列表的 PR 都会先在这里爆红。
//
// ── 2026-10-05 语义收窄 ────────────────────────────────────────────────
// sanitizeTabUrl 现在只答「**能不能存**」，不再答「能不能打开」
// （打开判定是 isOpenableTabUrl）。因此 file: / blob: / view-source: /
// intent: 等从「拒」变成「放行」——它们是用户保存时**确实打得开**的真实地址，
// 修复前丢掉它们造成了「存得下、回不来」的会话（详见
// tests/storableUnopenableUrls.test.ts 的完整背景）。
// 危险 schema（javascript: / data: / vbscript:）仍然是拒的——那三条不变。

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

describe('sanitizeTabUrl: 协议白名单/黑名单（语义 = 能不能存）', () => {
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

  it('vbscript: 拒绝', async () => {
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');
    assert.strictEqual(sanitizeTabUrl('vbscript:msgbox(1)'), null);
  });

  it('file: / blob: 放行（存得下）—— 修复前这里返回 null，正是 bug 根源', async () => {
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');
    assert.strictEqual(
      sanitizeTabUrl('file:///Users/me/papers/thesis.pdf'),
      'file:///Users/me/papers/thesis.pdf',
      '本地 PDF 是用户保存时确实打得开的地址，必须存得下'
    );
    assert.strictEqual(sanitizeTabUrl('blob:https://example.com/abc'), 'blob:https://example.com/abc');
  });

  it('打不开 ≠ 该丢：isOpenableTabUrl 对 file:/blob: 拒，但数据已保住', async () => {
    const { isOpenableTabUrl, sanitizeTabUrl } = await import('@/utils/inputValidation');
    for (const u of ['file:///a.pdf', 'blob:https://example.com/x', 'devtools://dev']) {
      assert.notEqual(sanitizeTabUrl(u), null, `${u} 应存得下`);
      assert.equal(isOpenableTabUrl(u), false, `${u} 本设备打不开 → 由 unopenable 标记降级显示`);
    }
  });

  it('loading:// 占位符保留', async () => {
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');
    assert.strictEqual(
      sanitizeTabUrl('loading://abc-123'),
      'loading://abc-123'
    );
  });

  it('about: 接受（存储门放行；是否保存另由 isInternalUrl 判）', async () => {
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

  // 白名单仍然严格生效：浏览器内部页与不认识的 scheme 一律拒
  it('chrome-extension://、chrome:// 等浏览器内部页与非白名单协议拒绝', async () => {
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');
    assert.strictEqual(sanitizeTabUrl('chrome-extension://abcd/popup.html'), null);
    assert.strictEqual(sanitizeTabUrl('ms-appx-web://example.com'), null);
    assert.strictEqual(sanitizeTabUrl('chrome://settings'), null);
  });

  it('view-source: 放行（可保存，打不开时降级显示）', async () => {
    const { sanitizeTabUrl, isOpenableTabUrl } = await import('@/utils/inputValidation');
    assert.strictEqual(sanitizeTabUrl('view-source:https://example.com'), 'view-source:https://example.com');
    assert.equal(isOpenableTabUrl('view-source:https://example.com'), false);
  });

  it('intent:（Android scheme，本项目不认）仍然拒绝 —— 不为它放宽存储门', async () => {
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');
    assert.strictEqual(sanitizeTabUrl('intent://example.com#Intent;scheme=https'), null);
  });
});