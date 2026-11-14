// 冲突提示总线的行为锁：写方 notify ⇒ 同进程订阅者被唤醒；跨上下文广播能唤醒
// 订阅者且不再转发（防消息风暴）；广播失败/reject 不影响任何东西。
//
// 范式照抄 tests/groupsChangedEventSource.test.ts 的 chrome 桩。

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const TESTS_DIR = new URL('.', import.meta.url).pathname;
register(new URL('./_alias-loader.mjs', `file://${TESTS_DIR}`).href);

const sentMessages: Array<{ type?: string }> = [];
const runtimeMessageListeners: Array<(msg: { type?: string }) => void> = [];

(globalThis as Record<string, unknown>).chrome = {
  runtime: {
    id: 'test-extension',
    sendMessage: (msg: { type?: string }) => {
      sentMessages.push(msg);
      // 模拟「没有接收方」的常见形态：reject（popup 没开）
      return Promise.reject(new Error('Receiving end does not exist'));
    },
    onMessage: {
      addListener: (fn: (msg: { type?: string }) => void) => {
        runtimeMessageListeners.push(fn);
      },
      removeListener: () => undefined,
    },
  },
};

const {
  notifyConflictNoticeChanged,
  subscribeConflictNoticeChanged,
  __resetConflictNoticeBusForTests,
} = await import('@/storage-kv/conflictNoticeBus');

describe('conflictNoticeBus：冲突提示落盘后的唤醒通道', () => {
  beforeEach(() => {
    sentMessages.length = 0;
    runtimeMessageListeners.length = 0;
    __resetConflictNoticeBusForTests();
  });

  it('notify 唤醒同进程订阅者；返回的退订函数生效', () => {
    let calls = 0;
    const unsub = subscribeConflictNoticeChanged(() => { calls += 1; });
    notifyConflictNoticeChanged();
    assert.equal(calls, 1);
    unsub();
    notifyConflictNoticeChanged();
    assert.equal(calls, 1, '退订后不得再收到通知');
  });

  it('notify 发出 runtime 广播；广播 reject 被吞（不抛未处理 rejection）', async () => {
    subscribeConflictNoticeChanged(() => undefined);
    notifyConflictNoticeChanged();
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].type, 'TABSTACK_CONFLICT_NOTICE_CHANGED');
    // 给 microtask 一轮：若 reject 未被吞，node --test 会报未处理 rejection
    await new Promise(r => setTimeout(r, 0));
  });

  it('收到广播只 emit 不转发（防 realm 间消息风暴）', () => {
    let calls = 0;
    subscribeConflictNoticeChanged(() => { calls += 1; });
    assert.ok(runtimeMessageListeners.length >= 1, '订阅时应懒注册 runtime 监听');
    // 模拟其它 realm 发来的广播
    for (const fn of runtimeMessageListeners) {
      fn({ type: 'TABSTACK_CONFLICT_NOTICE_CHANGED' });
    }
    assert.equal(calls, 1, '广播应唤醒订阅者');
    assert.equal(sentMessages.length, 0, '收到广播不得再广播出去');
  });

  it('无关消息类型不唤醒订阅者', () => {
    let calls = 0;
    subscribeConflictNoticeChanged(() => { calls += 1; });
    for (const fn of runtimeMessageListeners) fn({ type: 'TABSTACK_GROUPS_CHANGED' });
    assert.equal(calls, 0);
  });

  it('单个订阅者抛错不影响其余订阅者', () => {
    let okCalls = 0;
    subscribeConflictNoticeChanged(() => { throw new Error('boom'); });
    subscribeConflictNoticeChanged(() => { okCalls += 1; });
    assert.doesNotThrow(() => notifyConflictNoticeChanged());
    assert.equal(okCalls, 1, '抛错订阅者之后的订阅者仍应被调用');
  });
});

// ── 结构守卫：写路径必须发通知 ────────────────────────────────────────────
// 行为测试锁的是总线自己；这里锁的是**接线上**：backgroundSync 是唯一写方，
// 落盘成功后必须广播 —— 否则 popup 开着时的新提示要等下次打开才看到，
// bug 会无声回归（总线还在，只是没人调用它）。

describe('conflictNoticeBus：接线守卫', () => {
  it('backgroundSync 在 setPendingConflictNotice 成功后必须 notifyConflictNoticeChanged()', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const root = resolve(new URL('.', import.meta.url).pathname, '..');
    const src = readFileSync(resolve(root, 'src/background/backgroundSync.ts'), 'utf8');
    const start = src.indexOf('setPendingConflictNotice(');
    assert.ok(start > 0, 'backgroundSync 必须落 pending_conflict_notice（守卫⑤语义的一部分）');
    // 落盘调用点所在的 try 块内（成功路径）必须有广播
    const window = src.slice(start, src.indexOf('} catch', start));
    assert.match(
      window,
      /notifyConflictNoticeChanged\(\)/,
      '提示落盘成功后没有广播 ⇒ popup 开着时看不到本轮新提示。' +
        '新写路径若漏发通知，这里立刻红。'
    );
  });
});
