// S1 §2.1: TabStackError 错误分层 — 类型 + 工厂 + retryable + toUserMessage。
//
// errors.ts 是零依赖纯模块，测试不引入任何 polyfill。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

before(async () => {
  register(LOADER_PATH);
});

describe('TabStackError: 工厂产生正确的 kind', () => {
  it('syncError → kind=sync', async () => {
    const { syncError } = await import('@/utils/errors');
    const e = syncError('上传失败');
    assert.equal(e.kind, 'sync');
  });

  it('storageError → kind=storage', async () => {
    const { storageError } = await import('@/utils/errors');
    assert.equal(storageError('IO 失败').kind, 'storage');
  });

  it('decryptError → kind=decrypt', async () => {
    const { decryptError } = await import('@/utils/errors');
    assert.equal(decryptError('key 漂移').kind, 'decrypt');
  });

  it('migrationError → kind=migration', async () => {
    const { migrationError } = await import('@/utils/errors');
    assert.equal(migrationError('迁移失败').kind, 'migration');
  });

  it('networkError → kind=network', async () => {
    const { networkError } = await import('@/utils/errors');
    assert.equal(networkError('断网').kind, 'network');
  });
});

describe('TabStackError: retryable 默认值', () => {
  it('sync/storage/network 默认 retryable=true', async () => {
    const { syncError, storageError, networkError } = await import('@/utils/errors');
    assert.equal(syncError('x').retryable, true);
    assert.equal(storageError('x').retryable, true);
    assert.equal(networkError('x').retryable, true);
  });

  it('decrypt/migration 默认 retryable=false，可显式覆盖', async () => {
    const { decryptError, migrationError } = await import('@/utils/errors');
    assert.equal(decryptError('x').retryable, false);
    assert.equal(migrationError('x').retryable, false);
    assert.equal(decryptError('x', { retryable: true }).retryable, true, '显式覆盖生效');
  });
});

describe('TabStackError: userMessage', () => {
  it('缺省 userMessage 按 kind 给出中文文案', async () => {
    const { syncError, storageError, decryptError, migrationError, networkError } = await import('@/utils/errors');
    assert.equal(syncError('x').userMessage, '同步失败，请稍后重试');
    assert.equal(storageError('x').userMessage, '存储操作失败，请稍后重试');
    assert.equal(decryptError('x').userMessage, '数据解密失败，数据可能已损坏或密钥不匹配');
    assert.equal(migrationError('x').userMessage, '升级失败，旧数据已保留');
    assert.equal(networkError('x').userMessage, '网络连接失败，请检查网络设置');
  });

  it('显式 userMessage 覆盖默认', async () => {
    const { syncError } = await import('@/utils/errors');
    const e = syncError('x', { userMessage: '同步挂了，去设置里看看' });
    assert.equal(e.userMessage, '同步挂了，去设置里看看');
  });
});

describe('TabStackError: 结构与 cause', () => {
  it('保留 message，name=TabStackError，仍是 Error 实例', async () => {
    const { syncError } = await import('@/utils/errors');
    const e = syncError('具体原因');
    assert.equal(e.message, '具体原因');
    assert.equal(e.name, 'TabStackError');
    assert.ok(e instanceof Error);
    assert.ok(e instanceof (await import('@/utils/errors')).TabStackError);
  });

  it('cause 透传原始错误', async () => {
    const { networkError } = await import('@/utils/errors');
    const cause = new TypeError('fetch failed');
    const e = networkError('请求失败', { cause });
    assert.equal(e.cause, cause);
  });
});

describe('isTabStackError', () => {
  it('TabStackError 实例 → true', async () => {
    const { syncError, isTabStackError } = await import('@/utils/errors');
    assert.equal(isTabStackError(syncError('x')), true);
  });

  it('普通 Error / string / undefined / null / 对象 → false', async () => {
    const { isTabStackError } = await import('@/utils/errors');
    assert.equal(isTabStackError(new Error('x')), false);
    assert.equal(isTabStackError('oops'), false);
    assert.equal(isTabStackError(undefined), false);
    assert.equal(isTabStackError(null), false);
    assert.equal(isTabStackError({ kind: 'sync' }), false);
  });
});

describe('toUserMessage', () => {
  it('TabStackError → 返回其 userMessage', async () => {
    const { syncError, toUserMessage } = await import('@/utils/errors');
    assert.equal(toUserMessage(syncError('x')), '同步失败，请稍后重试');
    assert.equal(toUserMessage(syncError('x', { userMessage: '自定义文案' })), '自定义文案');
  });

  it('普通 Error → 通用中文文案', async () => {
    const { toUserMessage } = await import('@/utils/errors');
    assert.equal(toUserMessage(new Error('boom')), '操作失败，请稍后重试');
  });

  it('string / undefined → 通用中文文案', async () => {
    const { toUserMessage } = await import('@/utils/errors');
    assert.equal(toUserMessage('boom'), '操作失败，请稍后重试');
    assert.equal(toUserMessage(undefined), '操作失败，请稍后重试');
    assert.equal(toUserMessage(null), '操作失败，请稍后重试');
  });
});
