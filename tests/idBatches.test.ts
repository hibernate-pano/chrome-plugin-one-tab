// chunkIds：PostgREST 过滤条件走 URL，Supabase 网关对长度有硬上限，长删除队列
// 必须分批。纯函数，直接 import（无用别名）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chunkIds, ID_BATCH_SIZE } from '../src/utils/supabase/idBatches.ts';

describe('chunkIds：把长 id 列表切成不超一批的若干段', () => {
  it('空数组 → 空结果', () => {
    assert.deepEqual(chunkIds([]), []);
  });

  it('不足一批 → 单段', () => {
    assert.deepEqual(chunkIds([1, 2, 3], 2), [[1, 2], [3]]);
  });

  it('整除 → 均分；不整除 → 末段为余数', () => {
    assert.deepEqual(chunkIds([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
    assert.deepEqual(chunkIds([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  });

  it('默认批大小下：N 个元素 → ceil(N/size) 段，且每段不超 size', () => {
    const n = ID_BATCH_SIZE * 2 + 1;
    const ids = Array.from({ length: n }, (_, i) => `id-${i}`);
    const batches = chunkIds(ids);
    assert.equal(batches.length, 3);
    for (const b of batches) assert.ok(b.length <= ID_BATCH_SIZE);
    assert.deepEqual(batches.flat(), ids, '切分不得丢元素或改顺序');
  });
});
