// 钉死 OpStamp 全序比较（规格 §4.2）：
// - s 不同走数值；s 相同走 d 字典序；完全相等返回 0
// - 无 updatedAt/id 兜底：seq 单调递增保证唯一赢家
// - EMPTY_STAMP 全序最小值（迁移前数据 + 云端空列）
//
// 文件样板与 tests/mutationOps.test.ts 一致：@/ 别名需在 register(loader) 之后
// 动态 import；本模块不依赖 chrome/supabase，但保持样板统一。
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

describe('opStamp: 全序比较（§4.2）', () => {
  it('s 不同按数值', async () => {
    const { compareStamps } = await import('@/utils/opStamp');
    assert.equal(compareStamps({ d: 'a', s: 2 }, { d: 'a', s: 1 }), 1);
    assert.equal(compareStamps({ d: 'a', s: 1 }, { d: 'a', s: 2 }), -1);
  });
  it('s 相同按 d 字典序', async () => {
    const { compareStamps } = await import('@/utils/opStamp');
    assert.equal(compareStamps({ d: 'b', s: 5 }, { d: 'a', s: 5 }), 1);
    assert.equal(compareStamps({ d: 'a', s: 5 }, { d: 'b', s: 5 }), -1);
  });
  it('完全相等 → 0', async () => {
    const { compareStamps } = await import('@/utils/opStamp');
    assert.equal(compareStamps({ d: 'a', s: 5 }, { d: 'a', s: 5 }), 0);
  });
  it('字典序把 "device10" 视为小于 "device2"（与数值序相反，钉死避免被改成数值比较）', async () => {
    // 规格 §4.2 明确「字符串字典序」。"device10" 与 "device2" 在数值序下前者更大，
    // 在字典序下逐字符比到第 7 位是 '1' vs '2'，前者更小——必须保证实现不退化为数值。
    const { compareStamps } = await import('@/utils/opStamp');
    assert.equal(compareStamps({ d: 'device10', s: 1 }, { d: 'device2', s: 1 }), -1);
  });
  it('EMPTY_STAMP 是全序最小值', async () => {
    const { compareStamps, EMPTY_STAMP } = await import('@/utils/opStamp');
    assert.equal(compareStamps(EMPTY_STAMP, { d: 'a', s: 1 }), -1);
    assert.equal(compareStamps({ d: 'a', s: 1 }, EMPTY_STAMP), 1);
    assert.equal(compareStamps(EMPTY_STAMP, EMPTY_STAMP), 0);
  });
  it('isLater 是 compareStamps > 0 的薄包装', async () => {
    const { isLater } = await import('@/utils/opStamp');
    assert.equal(isLater({ d: 'b', s: 1 }, { d: 'a', s: 1 }), true);
    assert.equal(isLater({ d: 'a', s: 1 }, { d: 'a', s: 1 }), false);
  });
  it('makeStamp 工厂', async () => {
    const { makeStamp } = await import('@/utils/opStamp');
    assert.deepEqual(makeStamp('dev', 7), { d: 'dev', s: 7 });
  });
});