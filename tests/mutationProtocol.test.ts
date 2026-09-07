// 钉死 popup → SW 的语义命令协议（规格 §3.1/§3.2）：
// 1) sendMutation 包成 {type:'MUTATE', data: cmd} 投递；
// 2) SW 返回 ok:false/error 时透传，不抛异常；
// 3) sender 自身抛错（SW 唤醒失败、消息通道断裂）转为 ok:false + 错误信息；
// 4) sendSyncCommand 走 SYNC 通道、附带 extra 字段。
//
// 文件头部样板必须与 tests/mutationQueue.test.ts 一致：
// @/ 别名模块只能在 register(loader) 之后【动态 import】（静态 import 会被
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

describe('mutationProtocol: 命令发送', () => {
  it('把 MutationOp 包进 {type:MUTATE, data} 并回传 payload', async () => {
    const { sendMutation } = await import('@/shared/mutationProtocol');
    const fakeSender: import('@/shared/mutationProtocol').MessageSender = async (msg: any) => ({
      ok: true,
      payload: { echoed: msg },
    });
    const res = await sendMutation<{ echoed: any }>(
      { op: 'removeTab', groupId: 'g1', tabId: 't1' },
      fakeSender
    );
    assert.equal(res.ok, true);
    assert.equal((res.payload as any).echoed.type, 'MUTATE');
    assert.deepEqual((res.payload as any).echoed.data, { op: 'removeTab', groupId: 'g1', tabId: 't1' });
  });

  it('SW 返回 ok:false 时透传 error 而不抛异常', async () => {
    const { sendMutation } = await import('@/shared/mutationProtocol');
    const res = await sendMutation({ op: 'deleteGroup', groupId: 'g1' }, async () => ({ ok: false, error: 'x' }));
    assert.equal(res.ok, false);
    assert.equal(res.error, 'x');
  });

  it('sender 抛异常（SW 唤醒失败等）转为 ok:false', async () => {
    const { sendMutation } = await import('@/shared/mutationProtocol');
    const res = await sendMutation({ op: 'saveGroup', group: {} as any }, async () => { throw new Error('no SW'); });
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /no SW/);
  });

  it('sendSyncCommand 走 SYNC 通道', async () => {
    const { sendSyncCommand } = await import('@/shared/mutationProtocol');
    const fakeSender: import('@/shared/mutationProtocol').MessageSender = async (msg: any) => ({
      ok: true,
      payload: { echoed: msg },
    });
    const res = await sendSyncCommand('scheduleUpload', { delayMs: 1500 }, fakeSender as any);
    assert.equal(res.ok, true);
    const echoed = (res.payload as any).echoed;
    assert.equal(echoed.type, 'SYNC');
    assert.deepEqual(echoed.data, { op: 'scheduleUpload', delayMs: 1500 });
  });
});
