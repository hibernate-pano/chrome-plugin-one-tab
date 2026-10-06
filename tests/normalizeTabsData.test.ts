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
    const { normalizeTabsData } = await import('@/core/normalizeTabsData');
    const arr = [
      { id: '1', url: 'https://a.com', title: 'A', created_at: '2024-01-01', last_accessed: '2024-01-01' },
      { id: '2', url: 'https://b.com', title: 'B', created_at: '2024-01-02', last_accessed: '2024-01-02' },
    ];
    const result = normalizeTabsData(arr, 'group-1');
    assert.strictEqual(result, arr);
    assert.strictEqual(result.length, 2);
  });

  it('空数组也直通，不告警降级', async () => {
    const { normalizeTabsData } = await import('@/core/normalizeTabsData');
    const arr: unknown[] = [];
    assert.strictEqual(normalizeTabsData(arr), arr);
  });

  it('wrapper 恢复：{ tabs: [...] } 返回内层数组', async () => {
    const { normalizeTabsData } = await import('@/core/normalizeTabsData');
    const inner = [{ id: '1', url: 'https://a.com', title: 'A', created_at: '', last_accessed: '' }];
    const result = normalizeTabsData({ tabs: inner, name: '坏行' }, 'group-2');
    assert.strictEqual(result, inner);
  });

  it('wrapper 恢复：{ tabs_data: [...] } / { groups: [...] } / { tabsData: [...] } 均可恢复', async () => {
    const { normalizeTabsData } = await import('@/core/normalizeTabsData');
    const a = [{ id: '1', url: 'u', title: 't', created_at: '', last_accessed: '' }];
    const b = [{ id: '2', url: 'u', title: 't', created_at: '', last_accessed: '' }];
    const c = [{ id: '3', url: 'u', title: 't', created_at: '', last_accessed: '' }];
    assert.strictEqual(normalizeTabsData({ tabs_data: a }), a);
    assert.strictEqual(normalizeTabsData({ groups: b }), b);
    assert.strictEqual(normalizeTabsData({ tabsData: c }), c);
  });

  it('wrapper 无数组字段：降级为空数组', async () => {
    const { normalizeTabsData } = await import('@/core/normalizeTabsData');
    assert.deepStrictEqual(normalizeTabsData({ foo: 'bar' }, 'group-3'), []);
    assert.deepStrictEqual(normalizeTabsData({ tabs: 'not-an-array' }, 'group-3'), []);
  });

  it('非数组降级：对象/null/字符串/数字/undefined → 空数组', async () => {
    const { normalizeTabsData } = await import('@/core/normalizeTabsData');
    assert.deepStrictEqual(normalizeTabsData(null, 'group-4'), []);
    assert.deepStrictEqual(normalizeTabsData('random string', 'group-4'), []);
    assert.deepStrictEqual(normalizeTabsData(42, 'group-4'), []);
    assert.deepStrictEqual(normalizeTabsData(undefined, 'group-4'), []);
    assert.deepStrictEqual(normalizeTabsData(true, 'group-4'), []);
  });

  it('contextId 缺省时不抛错', async () => {
    const { normalizeTabsData } = await import('@/core/normalizeTabsData');
    assert.deepStrictEqual(normalizeTabsData('bad'), []);
  });
});

// 2026-10-06 降噪定性（docs/health-check-2026-10-05-v1.22.11.md §7.1）：
// wrapper 恢复是**预期中的兼容路径在工作**，不是故障 —— 每 60s 一轮的全量下载
// 反复打 warn 只会让真异常淹没在噪声里（线上日志 3 组 × 2 轮刷屏的正是它）。
// 钉死：恢复成功不进 console.warn（生产静默）；「无法恢复」仍必须出声。
describe('normalizeTabsData: 告警级别（降噪契约）', () => {
  /** 捕获 console.warn：logWarn 唯一出口就是它。 */
  async function captureWarns(run: () => void | Promise<unknown>): Promise<unknown[][]> {
    const warns: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args); };
    try {
      await run();
    } finally {
      console.warn = original;
    }
    return warns;
  }

  it('wrapper 恢复成功：返回内层数组且不打 console.warn', async () => {
    const { normalizeTabsData } = await import('@/core/normalizeTabsData');
    const inner = [{ id: '1', url: 'https://a.com', title: 'A', created_at: '', last_accessed: '' }];
    let result: unknown;
    const warns = await captureWarns(() => {
      result = normalizeTabsData({ tabs: inner }, 'group-warn-1');
    });
    assert.strictEqual(result, inner, '恢复结果本身不受降级影响');
    assert.equal(warns.length, 0, '恢复成功是预期行为，生产控制台不应出现 warn');
  });

  it('无法恢复（形状彻底读不出）：仍必须打 console.warn', async () => {
    const { normalizeTabsData } = await import('@/core/normalizeTabsData');
    let result: unknown;
    const warns = await captureWarns(() => {
      result = normalizeTabsData({ foo: 'bar' }, 'group-warn-2');
    });
    assert.deepStrictEqual(result, [], '读不出来降级空数组的语义不变');
    assert.equal(warns.length, 1, '真异常必须出声 —— 降噪只降成功路径');
    assert.match(String(warns[0][0]), /无法恢复/);
  });

  it('标量/空形状降级：同样必须打 console.warn', async () => {
    const { normalizeTabsData } = await import('@/core/normalizeTabsData');
    const warns = await captureWarns(() => {
      normalizeTabsData('not-json-shape', 'group-warn-3');
    });
    assert.equal(warns.length, 1);
  });
});
