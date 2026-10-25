// 判据层 `decideFeedback`：该不该出声（2026-10-25「安静的成功」）。
//
// ── 这条判据解决什么问题 ──────────────────────────────────────────────────
// 以前「说不说成功」散在 119 处调用点里，每个点自己拍脑袋 ⇒ 界面**已经自明**
// 的结果被重复念了一遍（窗口开了、卡片还在、图标翻了，用户看得见却又被告知）。
//
// Unix 的映射：界面状态 = stdout（结果本身）；提示 = stderr（出错 + 界面表达不了的事实）。
// ⇒ **成功是状态，不是事件**。
//
// 本文件守的是判据**本身**：纯函数、零依赖、node:test 里直测。
// 「调用点真的经过了这个函数」不在这里守 —— 那是接线守卫的事
// （接线守卫必须真的调用那条路径，否则零检测力）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decideFeedback, type FeedbackInput } from '../src/core/feedbackPolicy.ts';

describe('decideFeedback：该不该出声', () => {
  it('结果完全在界面自明 ⇒ 沉默', () => {
    // 「保存成功」这一类：列表变了、图标翻了 —— 界面说得出来 ⇒ 不许再念一遍。
    assert.equal(decideFeedback({ visibility: 'self-evident' }).level, 'silent');
  });

  it('结果自明，但有一件界面看不见的事实 ⇒ 说那件事实', () => {
    // 列表会变是自明的，但「有 2 个读不出来」界面永远表达不了 ⇒ 必须说。
    assert.equal(
      decideFeedback({ visibility: 'self-evident', hiddenFact: '有 2 个读不出来' }).level,
      'fact'
    );
  });

  it('结果界面表达不了 ⇒ 说事实（说事实，不是说「成功了」）', () => {
    // 分不清「打开了」还是「被删了」⇒ 界面表达不了 ⇒ 至少出声。
    assert.equal(decideFeedback({ visibility: 'hidden' }).level, 'fact');
  });

  it('不可逆 + 界面表达不了 + 有退路 ⇒ 说事实，不升级成错误', () => {
    // 有撤销按钮 ⇒ 用户能自己回来 ⇒ 说清楚就够了，不必当成事故。
    assert.equal(
      decideFeedback({ visibility: 'hidden', irreversible: true, hasEscape: true }).level,
      'fact'
    );
  });

  it('不可逆 + 界面表达不了 + 没有退路 ⇒ 错误（不许静默地吃掉一次不可逆操作）', () => {
    // 没写 hasEscape = 没有退路（undefined 不是「有退路」）。
    assert.equal(decideFeedback({ visibility: 'hidden', irreversible: true }).level, 'error');
  });

  it('不可逆 + 界面表达不了 + 明确没有退路 ⇒ 错误（与「没写」同档）', () => {
    // hasEscape: false 与「没写」必须同档 —— 否则「明确没退路」会被判得比
    // 「没说清」更轻，那是拿语义做文章。
    assert.equal(
      decideFeedback({ visibility: 'hidden', irreversible: true, hasEscape: false }).level,
      'error'
    );
  });

  it('结果自明时，不可逆不改变裁决 ⇒ 仍然沉默', () => {
    // 不可逆本身不是出声的理由：**界面自明**就已经静默了。
    // 不可逆只有在「界面也表达不了」时才升级成错误。
    assert.equal(decideFeedback({ visibility: 'self-evident', irreversible: true }).level, 'silent');
  });

  it('同一输入两次调用结果全等（幂等：判据不许藏状态）', () => {
    const input: FeedbackInput = {
      visibility: 'hidden',
      hiddenFact: '有 2 个读不出来',
      irreversible: true,
      hasEscape: false,
    };
    assert.deepEqual(decideFeedback(input), decideFeedback(input));
  });

  it('每个返回值都带非空 reason（守卫与调试靠它）', () => {
    // reason 是判据**命中了哪一条**的自述：空串 = 守卫拿它做断言时零信息。
    const inputs: FeedbackInput[] = [
      { visibility: 'self-evident' },
      { visibility: 'self-evident', hiddenFact: '有 2 个读不出来' },
      { visibility: 'hidden' },
      { visibility: 'hidden', irreversible: true, hasEscape: true },
      { visibility: 'hidden', irreversible: true },
      { visibility: 'hidden', irreversible: true, hasEscape: false },
      { visibility: 'self-evident', irreversible: true },
    ];
    for (const input of inputs) {
      const { reason } = decideFeedback(input);
      assert.equal(typeof reason, 'string', `reason 不是字符串：${JSON.stringify(input)}`);
      assert.ok(reason.trim().length > 0, `reason 是空串：${JSON.stringify(input)}`);
    }
  });
});
