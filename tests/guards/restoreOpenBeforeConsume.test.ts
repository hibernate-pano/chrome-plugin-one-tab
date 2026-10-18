// 恢复会话必须「先开后删」（2026-10-18）。
//
// 【本文件要防的回归类别】整组恢复曾是「先 dispatch(deleteGroup) 再发 OPEN_TABS」：
// 建窗失败 / SW 拒开（全部不可打开）/ 页面已关闭导致无回包时，标签没打开，而原会话
// 已经被物理删除（v1.22.0 起无回收站）—— 一次点击就丢掉整个工作现场。
// 单标签路径在 1.24.1 已经改成「SW 回 success:true 才删」，整组与搜索页两条路径
// 当时没跟着改。本文件按源码结构钉死这三处的顺序语义。
//
// 为什么用源码结构断言：三个入口都是 React 组件内的闭包，直接跑需要 DOM 与
// chrome.runtime mock；本仓已有同惯例（noSilentFalseSuccess / p0DataSafetyGuards）。
// 断言只依赖「删除只出现在成功后调用的消费者函数里」与「失败分支不含删除」这两条
// 不变式，不绑定具体文案或实现细节。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function code(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 从 `startAnchor` 起截到下一个顶层 `  };`（组件内 useCallback/函数的收尾）。 */
function bodyFrom(src: string, startAnchor: string): string {
  const start = src.indexOf(startAnchor);
  assert.ok(start !== -1, `应能找到 ${startAnchor}`);
  const end = src.indexOf('\n  };', start);
  return src.slice(start, end === -1 ? src.length : end);
}

/**
 * 断言某函数的「消费者」只在 success:true 之后被调用，且调用之前出现了
 * `r.success !== true` 的显式判断。`consumer` 是该函数的调用表达式，如 `consumeSession()`。
 */
function assertConsumerGatedBySuccess(body: string, consumer: string, deleteCall: string): void {
  const cbStart = body.indexOf('(res: unknown) =>');
  assert.ok(cbStart !== -1, '必须处理 SW 回包');

  const callAt = body.indexOf(consumer, cbStart);
  assert.ok(callAt !== -1, `回包里必须调用 ${consumer}（成功后消费原会话）`);

  const guardAt = body.indexOf('r.success !== true', cbStart);
  assert.ok(guardAt !== -1, '回包必须显式判断 success !== true');
  assert.ok(
    guardAt < callAt,
    `${consumer} 必须排在 success:true 判断之后 —— 先删后开时开窗失败会丢失整个会话`
  );

  const beforeCall = body.slice(cbStart, callAt);
  assert.ok(
    !beforeCall.includes(deleteCall),
    `失败分支不得删除记录（回包里的 ${deleteCall} 必须只在成功后发生）`
  );
  assert.ok(
    beforeCall.includes('保留在列表中'),
    '失败时必须告诉用户记录还在，否则「没打开」与「已删除」不可区分'
  );
}

describe('整组恢复：TabGroup.openAllTabs 先开后删', () => {
  const src = code('src/components/tabs/TabGroup.tsx');
  const body = bodyFrom(src, 'const openAllTabs = useCallback(');

  it('删除只发生在成功后调用的消费者函数里', () => {
    const consumerStart = body.indexOf('const consumeSession = () =>');
    assert.ok(consumerStart !== -1, '应把删除收敛到 consumeSession');
    const sendAt = body.indexOf("type: 'OPEN_TABS'");
    const deleteAt = body.indexOf('dispatch(deleteGroup(');
    assert.ok(sendAt !== -1 && deleteAt !== -1);
    assert.ok(
      deleteAt > consumerStart,
      '删除只允许出现在 consumeSession 内 —— 顶层直接 dispatch 等于先删后开'
    );
    assert.ok(sendAt < body.indexOf('consumeSession()'), 'OPEN_TABS 必须先发出');
  });

  it('回包没有 success:true 时保留会话并提示', () => {
    assertConsumerGatedBySuccess(body, 'consumeSession()', 'dispatch(deleteGroup(');
  });
});

describe('搜索结果单会话恢复：SearchResultList.restoreSession 先开后删', () => {
  const src = code('src/components/search/SearchResultList.tsx');
  const body = bodyFrom(src, 'const restoreSession = (group: TabGroup) =>');

  it('删除收敛到 consumeSession，且 OPEN_TABS 先发', () => {
    const consumerStart = body.indexOf('const consumeSession = () =>');
    assert.ok(consumerStart !== -1);
    const deleteAt = body.indexOf('dispatch(deleteGroup(');
    assert.ok(deleteAt > consumerStart, '搜索页单会话恢复也必须先开后删');
  });

  it('回包没有 success:true 时保留会话并提示', () => {
    assertConsumerGatedBySuccess(body, 'consumeSession()', 'dispatch(deleteGroup(');
  });
});

describe('搜索结果批量恢复：先开后删（一条记录都不提前删）', () => {
  const src = code('src/components/search/SearchResultList.tsx');
  const body = bodyFrom(src, 'const runRestoreAllSearchResults = () =>');

  it('删除循环只在回包成功后才执行', () => {
    const consumerStart = body.indexOf('const consumeMatchedTabs = () =>');
    assert.ok(consumerStart !== -1, '应把批量删除收敛到 consumeMatchedTabs');
    const deleteAt = body.indexOf('dispatch(deleteTabAndSync(');
    assert.ok(deleteAt > consumerStart, '批量删除只允许出现在消费者函数内');
    assertConsumerGatedBySuccess(body, 'consumeMatchedTabs()', 'dispatch(deleteTabAndSync(');
  });
});
