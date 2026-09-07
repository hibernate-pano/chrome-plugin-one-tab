// 钉死 SW 单写者队列（规格 §3.3）的行为：FIFO 串行、job 抛错不断链、
// 队列深度可观测且执行完归零。后续所有 SW 侧写操作都经它串行化。
//
// 文件头部样板必须与 tests/tabTombstone.test.ts 的既有模式一致：
// @/ 别名的模块只能在 register(loader) 之后【动态 import】（静态 import 会被
// 提升、先于 loader 注册而失败）。本文件的每个 it 内用 await import('@/...')。
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

describe('mutationQueue: SW 单写者串行化', () => {
  it('按 FIFO 顺序串行执行，前一个完成才开始下一个', async () => {
    const { enqueue, resetQueue } = await import('@/background/mutationQueue');
    resetQueue();
    const order: string[] = [];
    const job = (name: string, ms: number) => async () => {
      order.push(`${name}:start`);
      await new Promise(r => setTimeout(r, ms));
      order.push(`${name}:end`);
      return name;
    };
    const [a, b, c] = await Promise.all([
      enqueue('a', job('a', 30)),
      enqueue('b', job('b', 5)),
      enqueue('c', job('c', 1)),
    ]);
    assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
    assert.equal([a, b, c].join(''), 'abc');
  });

  it('job 抛错时该调用 reject，但队列继续消化后续 job', async () => {
    const { enqueue, resetQueue } = await import('@/background/mutationQueue');
    resetQueue();
    const ran: string[] = [];
    await assert.rejects(
      enqueue('boom', async () => { throw new Error('boom'); }),
      /boom/
    );
    await enqueue('next', async () => { ran.push('next'); });
    assert.deepEqual(ran, ['next']);
  });

  it('getQueueDepth 反映排队深度，执行完归零', async () => {
    const { enqueue, getQueueDepth, resetQueue } = await import('@/background/mutationQueue');
    resetQueue();
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const p = enqueue('slow', () => gate);
    assert.equal(getQueueDepth(), 1);
    release();
    await p;
    assert.equal(getQueueDepth(), 0);
  });
});
