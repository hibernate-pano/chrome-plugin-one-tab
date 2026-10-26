/**
 * 变异自证：WC-1 的守卫必须真的看得见破口（2026-10-23）。
 *
 * ── 为什么要有它 ──────────────────────────────────────────────────────────
 *
 * 本仓的硬要求：**每条新守卫都要证明它有检测力** ——
 *   · 把实现改回旧行为 ⇒ 守卫必须变红；
 *   · 把实现改成一个**等价的正确写法** ⇒ 守卫必须**仍然绿**。
 *
 * 一条从来没红过的守卫，可能一直是绿的而什么也没守住。
 *
 * ── 变异一用的是**真实的旧行为** ──────────────────────────────────────────
 *
 * 不是「随便改坏一下」，而是把修复前那句「恢复后该会话会从列表中移除」
 * 原样放回去（**不看 isLocked**）—— 这样「守卫抓到了当年那个真缺陷」
 * 这件事才是真的。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/restoreOutcomeHonesty.test.ts';

/** 修复前那句提示语（2026-10-23 之前，两个按钮都套它，不看 isLocked）。 */
const OLD_OUTCOME_SENTENCE = '恢复后该会话会从列表中移除';

describe('变异自证：恢复后果这条守卫必须看得见破口', () => {
  it('变异一：把后果措辞改回「不看 isLocked」的旧行为 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '后果措辞不看 isLocked',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/tabs/restoreFeedbackCopy.ts',
            mutate: source => {
              const start = source.indexOf('export const restoreOutcomeSentence');
              if (start < 0) throw new Error('变异前提没成立：找不到 restoreOutcomeSentence');
              const end = source.indexOf(';', start);
              if (end < 0) throw new Error('变异前提没成立：找不到它的结尾');
              return (
                source.slice(0, start) +
                'export const restoreOutcomeSentence = (isLocked: boolean): string =>\n' +
                `  \`${OLD_OUTCOME_SENTENCE}\`;` +
                source.slice(end + 1)
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: 'WC-1：锁定会话恢复后必须说',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把后果措辞改回「不看 isLocked」的旧行为');
  });

  it('变异二：两个按钮不再按锁定态分流（把 group.isLocked 写死成 false）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '按钮不再按锁定态分流',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/tabs/TabGroup.tsx',
            mutate: source => {
              if (!source.includes('restoreOutcomeSentence(group.isLocked)')) {
                throw new Error('变异前提没成立：找不到按锁定态取后果的调用');
              }
              return source
                .split('restoreOutcomeSentence(group.isLocked)')
                .join('restoreOutcomeSentence(false)');
            },
          },
        ],
        expectRed: true,
        expectedFailure: 'WC-1：两个恢复按钮的 tooltip 与 aria-label 都必须按锁定态分流',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '两个按钮不再按锁定态分流');
  });

  it('变异三：顺手把「锁定会话不被消费」的行为也改了 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '锁定会话恢复后也被消费',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/tabs/TabGroup.tsx',
            mutate: source => {
              const anchor = 'const consumeSession = () => {';
              const at = source.indexOf(anchor);
              if (at < 0) throw new Error('变异前提没成立：找不到 consumeSession');
              const guardAt = source.indexOf('if (group.isLocked) {', at);
              if (guardAt < 0) throw new Error('变异前提没成立：找不到锁定早退');
              return source.slice(0, guardAt) + 'if (false) {' + source.slice(guardAt + 'if (group.isLocked) {'.length);
            },
          },
        ],
        expectRed: true,
        expectedFailure: 'WC-1：锁定会话**真的**不被消费',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把「锁定会话不被消费」的行为也改了');
  });

  it('等价改写：同一句话改用字符串拼接（输出一模一样）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '后果整句改用字符串拼接',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/tabs/restoreFeedbackCopy.ts',
            mutate: source => {
              const start = source.indexOf('export const restoreOutcomeSentence');
              if (start < 0) throw new Error('变异前提没成立：找不到 restoreOutcomeSentence');
              const end = source.indexOf(';', start);
              if (end < 0) throw new Error('变异前提没成立：找不到它的结尾');
              // ⚠️ 拼接出来的句子必须与**当前实现逐字相同** ——
              //   2026-10-26 撤销下线后，未锁定那半句是「，不可恢复」
              //   （原文写的是「，可撤销」—— 那已经不是等价改写，而是**假话**：
              //   守卫会正确地把它判红 ⇒ 「等价改写」这条用例就失去了意义）。
              return (
                source.slice(0, start) +
                'export const restoreOutcomeSentence = (isLocked: boolean): string =>\n' +
                '  isLocked\n' +
                "    ? '恢复后该会话' + restoreOutcomePhrase(true)\n" +
                "    : '恢复后该会话会' + restoreOutcomePhrase(false) + '，不可恢复';" +
                source.slice(end + 1)
              );
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '后果整句改用字符串拼接（输出一模一样）');
  });
});
