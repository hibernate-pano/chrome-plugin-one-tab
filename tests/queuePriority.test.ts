// 单写者队列的两条车道 + 消息协议超时（1.22.11）。
//
// 【为什么有这份文件】用户报控制台三连报错：
//   [AutoSync] 自动下载未成功 / 加载会话列表失败 / 清理重复标签失败
//   —— 全部是同一句 "A listener indicated an asynchronous response by returning
//   true, but the message channel closed before a response was received"。
// 三条**不同**操作同时以同一句报错失败，指向的不是某个消息的 bug，而是一条链：
//
//   1. 纯 FIFO 队列让「用户点删除」排在「后台整库上传」后面等（上传 = 网络 +
//      逐组 PBKDF2，几百会话秒级）。1.22.10 把延迟上传也收口进队列后更明显。
//   2. SW 侧没有一处超时（消息协议裸 await、队列无任务上限、supabase 客户端无
//      AbortSignal）→ popup 无限期转圈，没有任何「刚才没生效」的信号。
//   3. Chrome 的 popup 一失焦就销毁 → 用户点别处的那一刻，所有在途 sendMessage
//      的 Promise 一起 reject 成上面那句。实测：干净 profile 下不复现（SW 健康、
//      MUTATE 往返 1ms、零报错），只有「已登录 + 有数据 + 上传在途」才触发。
//
// 修法三件：队列分 high/normal 两条车道（用户操作插到未开始的同步任务之前）、
// 消息协议加有界超时、错误文案按 Chrome 真实串匹配。本文件钉前两件。
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

describe('单写者队列：两条车道（1.22.11）', () => {
  it('不变量：任何时刻只有一个 job 在执行（重排绝不能并发）', async () => {
    const { enqueue, resetQueue } = await import('@/background/mutationQueue');
    resetQueue();
    let active = 0;
    let maxActive = 0;
    const job = (ms: number) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, ms));
      active -= 1;
    };
    await Promise.all([
      enqueue('a', job(20)),
      enqueue('b', job(5), { priority: 'high' }),
      enqueue('c', job(5), { priority: 'high' }),
      enqueue('d', job(1)),
    ]);
    assert.equal(maxActive, 1, '两个 job 同时执行 = 单写者不变量破了 = 会丢用户数据');
  });

  it('high 插到未开始的 normal 之前；正在执行的那个不被打断', async () => {
    const { enqueue, resetQueue } = await import('@/background/mutationQueue');
    resetQueue();
    const order: string[] = [];
    let releaseFirst = () => {};
    const first = new Promise<void>(r => { releaseFirst = r; });

    // 先占住队列（模拟整库上传正在进行）
    const running = enqueue('sync:upload', async () => {
      order.push('upload:start');
      await first;
      order.push('upload:end');
    });
    // 上传排队期间用户点了两次删除
    const del1 = enqueue('deleteGroup', async () => { order.push('del1'); }, { priority: 'high' });
    const del2 = enqueue('cleanDuplicates', async () => { order.push('del2'); }, { priority: 'high' });
    // 以及一次还没轮到它的后台轮询
    const bg = enqueue('sync:download', async () => { order.push('bg'); });

    await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(order, ['upload:start'], '此刻只有正在执行的那个在跑');

    releaseFirst();
    await Promise.all([running, del1, del2, bg]);

    assert.deepEqual(
      order,
      ['upload:start', 'upload:end', 'del1', 'del2', 'bg'],
      '用户的两次点击必须先于后台轮询执行，且上传一旦开始就不被打断'
    );
  });

  it('同车道内仍是 FIFO', async () => {
    const { enqueue, resetQueue } = await import('@/background/mutationQueue');
    resetQueue();
    const order: string[] = [];
    let release = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const hold = enqueue('hold', () => gate);
    const mk = (n: string, p?: 'high' | 'normal') =>
      enqueue(n, async () => { order.push(n); }, p ? { priority: p } : undefined);
    const hs = [mk('h1', 'high'), mk('h2', 'high'), mk('n1'), mk('h3', 'high'), mk('n2')];
    await new Promise(r => setTimeout(r, 5));
    release();
    await Promise.all([hold, ...hs]);
    assert.deepEqual(order, ['h1', 'h2', 'h3', 'n1', 'n2'], 'high 车道内保持入队次序，normal 同理');
  });

  it('job 抛错：只 reject 自己，队列继续消化（两条车道都不能被一个失败卡死）', async () => {
    const { enqueue, resetQueue } = await import('@/background/mutationQueue');
    resetQueue();
    const ran: string[] = [];
    await assert.rejects(
      enqueue('boom', async () => { throw new Error('boom'); }, { priority: 'high' }),
      /boom/
    );
    await enqueue('next', async () => { ran.push('next'); });
    assert.deepEqual(ran, ['next'], '一个 high 任务失败后，后续任务照常执行');
  });

  it('getQueueDepth = 在跑 + 排队，执行完归零', async () => {
    const { enqueue, getQueueDepth, resetQueue } = await import('@/background/mutationQueue');
    resetQueue();
    let release = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const p1 = enqueue('slow', () => gate);
    const p2 = enqueue('queued', async () => undefined);
    assert.equal(getQueueDepth(), 2, '在跑的 1 个 + 排队的 1 个');
    release();
    await Promise.all([p1, p2]);
    assert.equal(getQueueDepth(), 0);
  });
});

describe('消息协议：必须有有界等待（1.22.11）', () => {
  it('sender 永不落地 → 超时后返回明确 reason，而不是无限挂起', async () => {
    const { sendMutation, TIMEOUT_REASON_PREFIX } = await import('@/core/mutationProtocol');
    const never = () => new Promise<never>(() => {});
    const t0 = Date.now();
    const res = await sendMutation({ op: 'cleanDuplicates' }, never, { timeoutMs: 60 });
    assert.equal(res.ok, false, '超时必须走失败分支，不能当成成功');
    assert.match(
      String(res.error),
      new RegExp(TIMEOUT_REASON_PREFIX),
      `reason 必须可归因，实际：${String(res.error)}`
    );
    assert.ok(Date.now() - t0 < 2000, '必须真的在上限内返回');
  });

  it('sendSyncCommand 同样有上限，且 reason 里带上是哪个操作', async () => {
    const { sendSyncCommand, TIMEOUT_REASON_PREFIX } = await import('@/core/mutationProtocol');
    const never = () => new Promise<never>(() => {});
    const res = await sendSyncCommand('download', {}, never, { timeoutMs: 60 });
    assert.equal(res.ok, false);
    assert.match(String(res.error), new RegExp(`${TIMEOUT_REASON_PREFIX}.*download`));
  });

  it('正常返回不受影响：结果原样透传', async () => {
    const { sendMutation } = await import('@/core/mutationProtocol');
    const res = await sendMutation({ op: 'deleteGroup', groupId: 'g1' }, async () => ({ ok: true }));
    assert.deepEqual(res, { ok: true });
  });

  it('sender 抛错时 reason 透传（超时不能吞掉真实错误）', async () => {
    const { sendMutation } = await import('@/core/mutationProtocol');
    const res = await sendMutation({ op: 'deleteGroup', groupId: 'g1' }, async () => {
      throw new Error('A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received');
    });
    assert.equal(res.ok, false);
    assert.match(String(res.error), /message channel closed/);
  });
});

describe('错误文案：必须按 Chrome 真实抛出的串匹配（1.22.11）', () => {
  it('popup 被关闭导致的断连 → 「连接已断开，点重新加载」，不是通用兜底', async () => {
    const { toListErrorCopy } = await import('@/components/tabs/listErrorCopy');
    const copy = toListErrorCopy(
      'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received'
    );
    assert.equal(
      copy.title,
      '与后台的连接已断开',
      '这条是扩展里最高频的瞬时错误，此前匹配不上任何规则、全部落进兜底'
    );
  });

  it('新引入的操作超时有独立文案，且说清「后台可能仍在继续」', async () => {
    const { toListErrorCopy } = await import('@/components/tabs/listErrorCopy');
    const { TIMEOUT_REASON_PREFIX } = await import('@/core/mutationProtocol');
    const copy = toListErrorCopy(`${TIMEOUT_REASON_PREFIX}（超过 30 秒无响应）：cleanDuplicates`);
    assert.equal(copy.title, '操作耗时过长');
    assert.match(copy.description, /可能仍在继续/);
  });

  it('未识别的异常仍落通用兜底，绝不回显原始串', async () => {
    const { toListErrorCopy } = await import('@/components/tabs/listErrorCopy');
    const copy = toListErrorCopy('some totally unknown failure xyz');
    assert.equal(copy.title, '会话列表暂时不可用');
    assert.ok(!copy.description.includes('xyz'), '原始异常串不得进 DOM');
  });
});
