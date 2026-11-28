/**
 * 批量恢复成功播报的**追加半句**（v1.33）：`想反复使用？恢复前先锁定。`
 *
 * ── 为什么只在这一轮**真的移除了记录**时追加 ─────────────────────────────
 *
 * 批量恢复会消费命中的标签（未锁定会话里的从会话中移除）。一条都没移除时
 * （全部锁定 / 全部失败），会话还原样留在列表里 ⇒ 说「想反复使用？恢复前
 * 先锁定」就是无的放矢：它**已经可以**反复使用了。
 *
 * ── 形状要求 ──────────────────────────────────────────────────────────────
 *
 * 纯文本、**不换行**、**不加按钮**：这是**同一句话的补充**，不是第二个动作。
 * 单个会话恢复 / 打开单个标签仍然完全静默；确认框也**不带**这句
 * （确认框说的是「将要发生什么」，不是成功之后的建议）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  restoreAllSearchConfirmMessage,
  restoreAllSearchSuccessMessage,
} from '../src/components/tabs/restoreFeedbackCopy.ts';

const LOCK_HINT = '想反复使用？恢复前先锁定。';

describe('批量恢复成功播报 · removed > 0 时追加锁定提示', () => {
  it('逐字：紧跟在最后一个「。」之后，不换行、不加空格', () => {
    const message = restoreAllSearchSuccessMessage({
      matched: 8,
      opened: 8,
      removed: 8,
      keptLocked: 0,
      failedToRemove: 0,
    });

    assert.equal(
      message,
      '已恢复 8 个标签页；已从所属会话移除 8 个标签页（会话内其余标签页保留）。' + LOCK_HINT
    );
    assert.equal(message.includes('\n'), false, '提示不许换行（它是同一句话的补充）');
    assert.equal(message.endsWith(`。${LOCK_HINT}`), true, '必须紧跟最后一个「。」');
  });

  it('部分锁定（removed > 0 且 keptLocked > 0）⇒ 账目照旧，后面仍追加', () => {
    const message = restoreAllSearchSuccessMessage({
      matched: 5,
      opened: 5,
      removed: 3,
      keptLocked: 2,
      failedToRemove: 0,
    });
    assert.match(message, /已从所属会话移除 3 个标签页/);
    assert.match(message, /另有 2 个在已锁定的会话里/);
    assert.equal(message.endsWith(`。${LOCK_HINT}`), true);
    // 追加句只出现一次
    assert.equal(message.split(LOCK_HINT).length - 1, 1);
  });

  it('有删除失败（removed > 0、failedToRemove > 0）⇒ 失败账目照说，后面仍追加', () => {
    const message = restoreAllSearchSuccessMessage({
      matched: 4,
      opened: 4,
      removed: 2,
      keptLocked: 0,
      failedToRemove: 2,
    });
    assert.match(message, /另有 2 条未能从会话中移除/);
    assert.equal(message.endsWith(`。${LOCK_HINT}`), true);
  });
});

describe('批量恢复成功播报 · removed === 0 时不追加', () => {
  it('全部锁定（removed = 0）⇒ 不出现锁定提示', () => {
    const message = restoreAllSearchSuccessMessage({
      matched: 3,
      opened: 3,
      removed: 0,
      keptLocked: 3,
      failedToRemove: 0,
    });
    assert.equal(message.includes(LOCK_HINT), false);
    assert.equal(message.endsWith('。'), true, '不追加时仍以句号收尾');
  });

  it('全部失败（removed = 0、failedToRemove > 0）⇒ 不出现锁定提示', () => {
    const message = restoreAllSearchSuccessMessage({
      matched: 2,
      opened: 2,
      removed: 0,
      keptLocked: 0,
      failedToRemove: 2,
    });
    assert.equal(message.includes(LOCK_HINT), false);
  });
});

describe('确认框不带这句', () => {
  it('restoreAllSearchConfirmMessage 永不出现锁定提示', () => {
    const confirmations = [
      restoreAllSearchConfirmMessage(
        { matched: 5, opened: 5, removed: 3, keptLocked: 2, failedToRemove: 0 },
        2
      ),
      restoreAllSearchConfirmMessage(
        { matched: 3, opened: 3, removed: 3, keptLocked: 0, failedToRemove: 0 },
        1
      ),
    ];
    for (const text of confirmations) {
      assert.equal(
        text.includes(LOCK_HINT),
        false,
        '确认框说的是「将要发生什么」；成功之后的建议不该出现在点确认之前'
      );
    }
  });
});
