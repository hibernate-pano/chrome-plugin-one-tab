// normalizeTabsData 单元测试——钉死 tabs_data 形状归一化行为。
//
// 背景：云端 tab_groups.tabs_data 存在历史坏行（解密/JSON.parse 后非数组），
// 直接 .map 会抛出 "c.map is not a function"（生产压缩代码），
// 导致整次下载/合并失败。任何放宽形状校验的 PR 都会先在这里爆红。

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

describe('normalizeTabsData: 形状归一化', () => {
  it('数组直通：合法 TabData[] 原样返回（同一引用）', async () => {
    const { normalizeTabsData } = await import('@/utils/normalizeTabsData');
    const arr = [
      { id: '1', url: 'https://a.com', title: 'A', created_at: '2024-01-01', last_accessed: '2024-01-01' },
      { id: '2', url: 'https://b.com', title: 'B', created_at: '2024-01-02', last_accessed: '2024-01-02' },
    ];
    const result = normalizeTabsData(arr, 'group-1');
    assert.strictEqual(result, arr);
    assert.strictEqual(result.length, 2);
  });

  it('空数组也直通，不告警降级', async () => {
    const { normalizeTabsData } = await import('@/utils/normalizeTabsData');
    const arr: unknown[] = [];
    assert.strictEqual(normalizeTabsData(arr), arr);
  });

  it('wrapper 恢复：{ tabs: [...] } 返回内层数组', async () => {
    const { normalizeTabsData } = await import('@/utils/normalizeTabsData');
    const inner = [{ id: '1', url: 'https://a.com', title: 'A', created_at: '', last_accessed: '' }];
    const result = normalizeTabsData({ tabs: inner, name: '坏行' }, 'group-2');
    assert.strictEqual(result, inner);
  });

  it('wrapper 恢复：{ tabs_data: [...] } / { groups: [...] } / { tabsData: [...] } 均可恢复', async () => {
    const { normalizeTabsData } = await import('@/utils/normalizeTabsData');
    const a = [{ id: '1', url: 'u', title: 't', created_at: '', last_accessed: '' }];
    const b = [{ id: '2', url: 'u', title: 't', created_at: '', last_accessed: '' }];
    const c = [{ id: '3', url: 'u', title: 't', created_at: '', last_accessed: '' }];
    assert.strictEqual(normalizeTabsData({ tabs_data: a }), a);
    assert.strictEqual(normalizeTabsData({ groups: b }), b);
    assert.strictEqual(normalizeTabsData({ tabsData: c }), c);
  });

  it('wrapper 无数组字段：降级为空数组', async () => {
    const { normalizeTabsData } = await import('@/utils/normalizeTabsData');
    assert.deepStrictEqual(normalizeTabsData({ foo: 'bar' }, 'group-3'), []);
    assert.deepStrictEqual(normalizeTabsData({ tabs: 'not-an-array' }, 'group-3'), []);
  });

  it('非数组降级：对象/null/字符串/数字/undefined → 空数组', async () => {
    const { normalizeTabsData } = await import('@/utils/normalizeTabsData');
    assert.deepStrictEqual(normalizeTabsData(null, 'group-4'), []);
    assert.deepStrictEqual(normalizeTabsData('random string', 'group-4'), []);
    assert.deepStrictEqual(normalizeTabsData(42, 'group-4'), []);
    assert.deepStrictEqual(normalizeTabsData(undefined, 'group-4'), []);
    assert.deepStrictEqual(normalizeTabsData(true, 'group-4'), []);
  });

  it('contextId 缺省时不抛错', async () => {
    const { normalizeTabsData } = await import('@/utils/normalizeTabsData');
    assert.deepStrictEqual(normalizeTabsData('bad'), []);
  });
});
