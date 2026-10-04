// mapWithConcurrency 的语义回归。
//
// 这个工具的唯一存在理由是「把逐组 PBKDF2 加解密并发化」，而它的两个调用方
// 都依赖两条非显然的性质：
//   1) **保序**：upload.ts 按下标把密文写回 groupsWithUser[i].tabs_data，
//      乱序等于把 A 组的密文写到 B 组的云端行上 —— 那是静默的数据损坏，
//      类型检查和现有测试都发现不了（都是字符串）。
//   2) **不 fail-fast**：调用方需要全部结果（加密失败的组 id 要一次报全）。
//      Promise.all 的语义正好相反，所以不能直接换用它。
// 并发度上界则决定它会不会把 SW 的 CPU 吃满、让用户点击变钝。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapWithConcurrency, CRYPTO_CONCURRENCY } from '@/utils/concurrency';

/** 记录并发峰值：同时 in-flight 的最大数量。 */
async function trackPeak(items: number[], limit: number, delayMs = 5) {
  let inFlight = 0;
  let peak = 0;
  const out = await mapWithConcurrency(items, limit, async n => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, delayMs));
    inFlight -= 1;
    return n;
  });
  return { out, peak };
}

describe('mapWithConcurrency: 保序（调用方按下标回写）', () => {
  it('结果顺序与输入一致（异步完成顺序被打乱也不影响）', async () => {
    const items = [30, 10, 25, 5, 20, 15];
    const out = await mapWithConcurrency(items, 4, async ms => {
      await new Promise(r => setTimeout(r, ms));
      return ms * 2;
    });
    assert.deepEqual(out, [60, 20, 50, 10, 40, 30], '先完成的不许排到前面');
  });

  it('fn 收到的是输入下标（供原位回写）', async () => {
    const seen: number[] = [];
    await mapWithConcurrency(['a', 'b', 'c'], 2, async (_v, i) => { seen.push(i); });
    assert.deepEqual([...seen].sort(), [0, 1, 2]);
  });

  it('空输入直接返回空数组（不建 worker）', async () => {
    assert.deepEqual(await mapWithConcurrency([], 4, () => 1), []);
  });

  it('同步 fn 也支持（返回非 Promise）', async () => {
    const out = await mapWithConcurrency([1, 2, 3], 2, n => n + 1);
    assert.deepEqual(out, [2, 3, 4]);
  });
});

describe('mapWithConcurrency: 并发度上界', () => {
  it('实际并发不超过 limit', async () => {
    const { peak } = await trackPeak([1, 2, 3, 4, 5, 6, 7, 8], 3);
    assert.ok(peak <= 3, `并发峰值 ${peak} 不得超过 limit 3`);
    assert.ok(peak >= 2, `并发峰值 ${peak} 应真的并发（不是退化成串行）`);
  });

  it('limit 大于条目数时不建多余 worker，且全部跑完', async () => {
    const { out, peak } = await trackPeak([1, 2], 10);
    assert.deepEqual(out, [1, 2]);
    assert.equal(peak, 2);
  });

  it('limit 非法（0 / 负数 / NaN / 小数）退化为串行而不是抛错', async () => {
    // 传错参数不该让一次同步整体失败
    for (const bad of [0, -1, Number.NaN, 1.7]) {
      const { peak } = await trackPeak([1, 2, 3], bad, 2);
      assert.equal(peak, 1, `limit=${bad} 应退化为串行`);
    }
  });

  it('CRYPTO_CONCURRENCY 是有界的小常数（不吃满 SW 的 CPU）', () => {
    assert.ok(Number.isInteger(CRYPTO_CONCURRENCY));
    assert.ok(CRYPTO_CONCURRENCY >= 2, '至少要能并发');
    assert.ok(CRYPTO_CONCURRENCY <= 16, '上界必须收敛，否则大会话库下内存/调度失控');
  });
});

describe('mapWithConcurrency: 错误处理', () => {
  it('fn 抛错 → 整体 reject，错误原样向上抛（不包装、不吞）', async () => {
    await assert.rejects(
      mapWithConcurrency([1, 2, 3], 2, async n => {
        if (n === 2) throw new Error('boom-2');
        return n;
      }),
      /boom-2/
    );
  });

  it('不 fail-fast：其余条目仍被消费完（调用方要么拿全量结果、要么拿到一个明确失败）', async () => {
    const processed: number[] = [];
    await assert.rejects(
      mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async n => {
        processed.push(n);
        await new Promise(r => setTimeout(r, 2));
        if (n === 2) throw new Error('boom');
        return n;
      })
    );
    assert.deepEqual(
      [...processed].sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6],
      '所有条目都必须被消费（Promise.all 的 fail-fast 会留下半成品状态）'
    );
  });

  it('多处抛错时上报第一个（错误信息稳定可复现）', async () => {
    await assert.rejects(
      mapWithConcurrency([1, 2, 3], 1, async n => {
        await new Promise(r => setTimeout(r, n));
        throw new Error(`fail-${n}`);
      }),
      /fail-1/
    );
  });

  it('fn 内部自行 try/catch 累积错误时不受影响（upload.ts 的用法）', async () => {
    const failed: string[] = [];
    const out = await mapWithConcurrency(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      2,
      async g => {
        try {
          if (g.id === 'b') throw new Error('encrypt failed');
          return `enc-${g.id}`;
        } catch {
          failed.push(g.id);
          return null;
        }
      }
    );
    assert.deepEqual(out, ['enc-a', null, 'enc-c'], '失败的槽位是 null，但顺序保持');
    assert.deepEqual(failed, ['b']);
  });
});
