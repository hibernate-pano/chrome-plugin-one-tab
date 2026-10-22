/**
 * 变异自证：**撤销退路的可达性**那条线的守卫必须看得见破口。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * `tests/guards/toastUndoReachability.test.ts` 钉的是「撤销退路够得着」：
 * 悬停/聚焦时倒计时暂停、页面看不见时不抢焦点、带动作的提示活得比普通提示久、
 * 暂停有上限……这些全是**行为**判据，看起来很扎实。
 *
 * 但一条从来没红过的守卫，可能一直是绿的而什么也没守住。
 * 唯一的验证办法是**把实现改坏，看守卫会不会红** —— 这就是变异测试。
 *
 * ── 与旧脚本的差别（为什么不再是 `scripts/verify-toast-mutation-proof.mjs`）──
 * 旧脚本**就地**改写 `src/components/common/toastPolicy.ts` 与 `Toast.tsx`
 * 再改回来。在共享工作树里这么做有两个问题：
 *   ① 别的 agent 正在跑测试 ⇒ 它会读到**变异后的**实现 ⇒ 假红，
 *      而且那个假红与本守卫要证明的事毫无关系；
 *   ② 脚本中途崩了 ⇒ 实现就停在变异状态（没有 finally 兜底也会漏）。
 * ⇒ 改用 `tests/_helpers/mutationSandbox.ts`：变异只发生在**沙箱副本**里，
 *   共享工作树一个字节都不动，而且这条测试本身**进 CI**（跑 `pnpm test` 就会跑）。
 *
 * 用法：直接 `node --test tests/guards/toastUndoReachabilityMutation.test.ts`。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/toastUndoReachability.test.ts';
const POLICY = 'src/components/common/toastPolicy.ts';
const TOAST = 'src/components/common/Toast.tsx';

/** 把源码里的一段文字换掉；找不到就抛（变异没生效 = 前提变了，必须让人知道）。 */
const replaceIn = (source: string, from: string, to: string): string => {
  if (!source.includes(from)) {
    throw new Error(`变异前提没成立：源码里找不到这段文字 ——\n${from}`);
  }
  const next = source.replace(from, to);
  if (next === source) throw new Error('变异没有生效（源码没变）');
  return next;
};

describe('变异自证：撤销退路的守卫必须看得见破口', () => {
  it('① 删掉暂停（悬停/看不见都不再暂停）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '暂停被删掉',
        testFile: GUARD,
        targets: [
          {
            path: TOAST,
            mutate: source => replaceIn(source, 'countdownRef.current?.pause();', '/* mutated */'),
          },
        ],
        expectRed: true,
        expectedFailure: '暂停后时间**不推进**',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把暂停调用删掉');
  });

  it('② 恢复后从头计时（不是从暂停处续走）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '恢复时从头计时',
        testFile: GUARD,
        targets: [
          {
            path: POLICY,
            mutate: source =>
              replaceIn(source, 'deadlineAt: now + state.remainingMs,', 'deadlineAt: now + state.durationMs,'),
          },
        ],
        expectRed: true,
        expectedFailure: '恢复后**从暂停处续走**',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让恢复后的倒计时从头开始');
  });

  it('③ 暂停上限不强制收起（提示永远赖着）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '暂停上限不再收起',
        testFile: GUARD,
        targets: [
          {
            path: POLICY,
            mutate: source =>
              replaceIn(
                source,
                '    capTimer = clock.setTimeout(() => {\n      capTimer = null;\n      fire();\n    }, budget);',
                '    capTimer = clock.setTimeout(() => {\n      capTimer = null;\n    }, budget);'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '暂停**有上限**',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让暂停没有上限');
  });

  it('④ 删掉「带动作 ⇒ 延长时长」的分支 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '带动作不再延长时长',
        testFile: GUARD,
        targets: [
          {
            path: POLICY,
            mutate: source =>
              replaceIn(
                source,
                '  if (hasAction) return Math.max(requested, TOAST_ACTION_DURATION_MS);',
                '  // mutated: hasAction 分支没了'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '带动作的提示活得比普通成功提示久',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '删掉带动作时的时长延长');
  });

  it('⑤ 删掉「正在打字时不抢焦点」的判据 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '打字时也抢焦点',
        testFile: GUARD,
        targets: [
          {
            path: POLICY,
            mutate: source =>
              replaceIn(source, '  if (inputs.userIsTyping) return false;', '  // mutated'),
          },
        ],
        expectRed: true,
        expectedFailure: '**正在打字** ⇒ 不抢',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '删掉打字时的焦点保护');
  });

  it('⑥ 删掉「用户看不见时暂停」这一支 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '看不见时不再暂停',
        testFile: GUARD,
        targets: [
          {
            path: POLICY,
            mutate: source =>
              replaceIn(
                source,
                'inputs.hovered || inputs.focused || (inputs.hasDecision && !inputs.pageSeen);',
                'inputs.hovered || inputs.focused;'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '用户看不见 + 有决定要做 ⇒ 暂停',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让「用户看不见」不再触发暂停');
  });

  it('⑦ 三个触发条件从「或」改成「与」⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '或改成与',
        testFile: GUARD,
        targets: [
          {
            path: POLICY,
            mutate: source =>
              replaceIn(
                source,
                'inputs.hovered || inputs.focused || (inputs.hasDecision && !inputs.pageSeen);',
                'inputs.hovered && inputs.focused && inputs.hasDecision && !inputs.pageSeen;'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '三个触发条件是**或**关系',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把暂停的三个触发条件从「或」改成「与」');
  });

  it('⑧ 删掉 window 的 blur 监听（切走标签时不再暂停）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'blur 监听被删',
        testFile: GUARD,
        targets: [
          {
            path: TOAST,
            mutate: source =>
              replaceIn(source, "    window.addEventListener('blur', update);", '    // mutated'),
          },
        ],
        expectRed: true,
        expectedFailure: '必须监听 window 的 blur',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '删掉 window 的 blur 监听');
  });

  it('⑨ 把撤销窗口改回 3 秒 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '撤销窗口缩回 3 秒',
        testFile: GUARD,
        targets: [
          {
            path: POLICY,
            mutate: source =>
              replaceIn(
                source,
                'export const TOAST_ACTION_DURATION_MS = 8000;',
                'export const TOAST_ACTION_DURATION_MS = 3000;'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '**撤销窗口不许被改回 3 秒**',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把撤销窗口缩回 3 秒');
  });

  it('⑩ 焦点接管不看「页面看不看得见」（看不见也抢焦点）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '抢焦点不看页面可见性',
        testFile: GUARD,
        targets: [
          {
            path: TOAST,
            mutate: source =>
              replaceIn(
                source,
                "      pageSeen: detectPageAttention() === 'visible',",
                '      pageSeen: true,'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '焦点接管的判据里必须有 pageSeen',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让焦点接管不看页面看不看得见');
  });
});
