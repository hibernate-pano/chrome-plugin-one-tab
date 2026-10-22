/**
 * 变异自证：SC-6 的守卫（登录后拉回：三种结果 ⇒ 三种反馈）必须看得见破口。
 *
 * 三个方向：
 *   ① 拉回失败时**不出声**（把话吞掉）⇒ 守卫必须变红；
 *   ② 把「失败」与「云端为空」混成一种（旧行为：都回 0）⇒ 守卫必须变红；
 *   ③ **等价的正确写法** ⇒ 守卫必须**仍然绿**。
 *
 * 沙箱的做法见 `tests/_helpers/mutationSandbox.ts`。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/loginRestoreFeedback.test.ts';

describe('变异自证：SC-6 的守卫必须看得见破口', () => {
  it('变异一：失败时不出声 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '失败回执变成空话',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/auth/restoreFeedbackCopy.ts',
            mutate: source => {
              const old = `        text:
          \`登录成功，但没能把云端的会话拉回来：\${reason}。\` +
          '可以在右上角菜单里点「从云端刷新数据」再试一次。',`;
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到失败回执');
              return source.replace(old, "        text: '',");
            },
          },
        ],
        expectRed: true,
        expectedFailure: '失败必须有一句能看的话',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让拉回失败时一句话都不说');
  });

  it('变异二：失败与「云端为空」混成一种（旧行为）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '失败被报成云端为空',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/auth/restoreAfterLogin.ts',
            mutate: source => {
              const old = `      return {
        kind: 'failed',
        reason: res.error ?? null,
        backendUnavailable: res.backendUnavailable === true,
      };`;
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到失败分支');
              return source.replace(old, "      return { kind: 'empty' };");
            },
          },
        ],
        expectRed: true,
        expectedFailure: '如实报 failed',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把「拉回失败」与「云端为空」混成一种');
  });

  it('变异三：等价改写（两段字符串拼成一段模板串）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '失败回执改成单段模板串',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/auth/restoreFeedbackCopy.ts',
            mutate: source => {
              const old = `        text:
          \`登录成功，但没能把云端的会话拉回来：\${reason}。\` +
          '可以在右上角菜单里点「从云端刷新数据」再试一次。',`;
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到失败回执');
              return source.replace(
                old,
                "        text: `登录成功，但没能把云端的会话拉回来：${reason}。可以在右上角菜单里点「从云端刷新数据」再试一次。`,"
              );
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把失败回执改成等价的单段模板串');
  });
});
