/**
 * 变异自证：DS-43-11 那条线的守卫必须看得见破口。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * `tests/guards/moveEmptiesSessionFeedback.test.ts` 钉的是「搬空会话时必须出声」。
 * 一条从来没红过的守卫，可能一直是绿的而什么也没守住 ——
 * 唯一的验证办法是**把实现改坏，看守卫会不会红**。
 *
 * ── 变异清单 ─────────────────────────────────────────────────────────────
 *   ① 文案层：不说「从列表消失」了（用户会以为卡还在）
 *   ② 文案层：不点名被搬空的会话
 *   ③ 接线层：改成无条件弹（每次换位都弹一句 = 没人看）
 *   ④ 接线层：压根不弹（回到缺陷本体）
 *   ⑤ 数据层：源会话的名字不带了（说这句话的组件没有源名字）
 *   ⑥ 等价改写：局部变量改名 ⇒ 必须**仍然绿**（守卫不许钉死字面量）
 *
 * 变异只发生在沙箱副本里（`tests/_helpers/mutationSandbox.ts`），
 * 共享工作树一个字节都不动。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/moveEmptiesSessionFeedback.test.ts';
const COPY_MODULE = 'src/components/tabs/moveFeedbackCopy.ts';
const TAB_GROUP = 'src/components/tabs/TabGroup.tsx';
const TAB_SLICE = 'src/store/slices/tabSlice.ts';

/** 把源码里的一段文字换掉；找不到就抛（变异没生效 = 前提变了，必须让人知道）。 */
const replaceIn = (source: string, from: string, to: string): string => {
  if (!source.includes(from)) {
    throw new Error(`变异前提没成立：源码里找不到这段文字 ——\n${from}`);
  }
  const next = source.replace(from, to);
  if (next === source) throw new Error('变异没有生效（源码没变）');
  return next;
};

/**
 * 按**词边界**改名。
 *
 * 为什么不能直接 split/join：`moved` 是 `removedGroupId` 的子串！
 * ⇒ 一刀切下去会把判据里的 `removedGroupId` 也改了，
 * 那就不是「等价改写」而是「改坏了」，守卫当然会红 —— 红的还是另一条断言。
 */
const renameWord = (source: string, from: string, to: string): string => {
  const re = new RegExp(`\\b${from}\\b`, 'g');
  if (!re.test(source)) {
    throw new Error(`变异前提没成立：源码里找不到 ${from} ——`);
  }
  const next = source.replace(re, to);
  if (next === source) throw new Error('变异没有生效（源码没变）');
  return next;
};

describe('变异自证：DS-43-11 的守卫必须看得见破口', () => {
  it('① 不说「从列表消失」⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '少说半句',
        testFile: GUARD,
        targets: [
          {
            path: COPY_MODULE,
            mutate: source =>
              replaceIn(source, '，该会话已从列表移除', ''),
          },
        ],
        expectRed: true,
        expectedFailure: '用户真正的疑问是「那张卡去哪了」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把「从列表消失」那半句删掉');
  });

  it('② 不点名被搬空的会话 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '不点名源会话',
        testFile: GUARD,
        targets: [
          {
            path: COPY_MODULE,
            mutate: source =>
              replaceIn(source, 'const subject = source ? `「${source}」` : \'原会话\';', 'const subject = \'原会话\';'),
          },
        ],
        expectRed: true,
        expectedFailure: '必须点名是哪个会话没了',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让文案不再点名源会话');
  });

  it('③ 改成无条件弹（每次换位都弹一句）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '去掉「搬空」这个条件',
        testFile: GUARD,
        targets: [
          {
            path: TAB_GROUP,
            mutate: source =>
              replaceIn(source, 'if (moved?.removedGroupId) {', 'if (moved) {'),
          },
        ],
        expectRed: true,
        expectedFailure: '分支的判据必须是「源组被搬空」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把「搬空」这个条件去掉');
  });

  it('④ 压根不弹（回到缺陷本体）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '不弹提示',
        testFile: GUARD,
        targets: [
          {
            path: TAB_GROUP,
            mutate: source =>
              replaceIn(
                source,
                '          showRestoreSuccessMessage(\n            moveEmptiesSessionMessage({\n              sourceName: moved.sourceGroupName,\n              targetName: group.name,\n            })\n          );',
                '          void moved;'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '必须用共享文案层产出这句话',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把提示整个删掉');
  });

  it('⑤ 源会话的名字不带了 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '名字不从快照取',
        testFile: GUARD,
        targets: [
          {
            path: TAB_SLICE,
            mutate: source =>
              replaceIn(
                source,
                '    const sourceGroupName =\n      snapshot.find(g => g.id === sourceGroupId)?.name ?? null;',
                '    const sourceGroupName = null;'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '写入前抓的快照',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让源会话的名字不再从快照取');
  });

  it('⑥ 等价改写（局部变量改名）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '局部变量改名',
        testFile: GUARD,
        targets: [
          {
            path: TAB_GROUP,
            mutate: source => renameWord(source, 'moved', 'moveOutcome'),
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把局部变量换个名字');
  });
});
