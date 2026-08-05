// formatLastSync（S2 F8 提取到 utils/sessionPresentation.ts 的纯函数）单元测试。
//
// 纯函数、无依赖：不需要 fake-indexeddb / chrome stub，
// 只需要注册 @/ 别名 loader 即可直接 import。

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

describe('formatLastSync', () => {
  it('无时间 / 非法时间 → "尚未同步"', async () => {
    const { formatLastSync } = await import('@/utils/sessionPresentation');
    assert.equal(formatLastSync(null), '尚未同步');
    assert.equal(formatLastSync(''), '尚未同步');
    assert.equal(formatLastSync('not-a-date'), '尚未同步');
  });

  it('相对时间：刚刚 / N分钟前 / N小时前 / N天前', async () => {
    const { formatLastSync } = await import('@/utils/sessionPresentation');
    const now = Date.now();
    assert.equal(formatLastSync(new Date(now - 30 * 1000).toISOString()), '刚刚');
    assert.equal(formatLastSync(new Date(now - 5 * 60 * 1000).toISOString()), '5分钟前');
    assert.equal(formatLastSync(new Date(now - 3 * 60 * 60 * 1000).toISOString()), '3小时前');
    assert.equal(formatLastSync(new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString()), '2天前');
  });
});
