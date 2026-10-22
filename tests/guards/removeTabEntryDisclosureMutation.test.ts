/**
 * 变异自证：DS-43-16 那条线的守卫必须看得见破口。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * `tests/guards/removeTabEntryDisclosure.test.ts` 钉的是「删掉最后一条时提示必须说清
 * 整个会话会消失」。听起来很扎实 —— 但一条从来没红过的守卫，可能一直是绿的
 * 而什么也没守住。唯一的验证办法是**把实现改坏，看守卫会不会红**。
 *
 * ── 变异清单（每一条都必须是「真的会坏」）─────────────────────────────────
 *   ① 文案层：两种后果塌成同一句（删最后一条不再提「整个会话」）
 *   ② 判据层：onlyActiveTabId 永远返回 null（提示永远只说「移除这条」）
 *   ③ 判据层：onlyActiveTabId 把墓碑算成内容
 *   ④ 接线层：TabGroup 把 removesWholeSession 写死成 false
 *   ⑤ 接线层：memo 比较漏掉 removesWholeSession（提示停留在旧值）
 *   ⑥ 接线层：DraggableTab 把 title 写死回旧的（说谎的）那句
 *   ⑦ 等价改写：局部变量改名 ⇒ 必须**仍然绿**（守卫不许钉死字面量）
 *
 * 用法：直接 `node --test tests/guards/removeTabEntryDisclosureMutation.test.ts`。
 * 变异只发生在沙箱副本里（`tests/_helpers/mutationSandbox.ts`），
 * 共享工作树一个字节都不动。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/removeTabEntryDisclosure.test.ts';
const COPY_MODULE = 'src/components/dnd/removeTabEntryCopy.ts';
const UTILS = 'src/core/tabGroupUtils.ts';
const DRAGGABLE_TAB = 'src/components/dnd/DraggableTab.tsx';
const TAB_GROUP = 'src/components/tabs/TabGroup.tsx';

/** 把源码里的一段文字换掉；找不到就抛（变异没生效 = 前提变了，必须让人知道）。 */
const replaceIn = (source: string, from: string, to: string): string => {
  if (!source.includes(from)) {
    throw new Error(`变异前提没成立：源码里找不到这段文字 ——\n${from}`);
  }
  const next = source.replace(from, to);
  if (next === source) throw new Error('变异没有生效（源码没变）');
  return next;
};

/** 把源码里的一段文字**全部**换掉（改名类变异要换干净，否则等于改了实现而不是改写法）。 */
const replaceAllIn = (source: string, from: string, to: string): string => {
  if (!source.includes(from)) {
    throw new Error(`变异前提没成立：源码里找不到这段文字 ——\n${from}`);
  }
  const next = source.split(from).join(to);
  if (next === source) throw new Error('变异没有生效（源码没变）');
  return next;
};

describe('变异自证：DS-43-16 的守卫必须看得见破口', () => {
  it('① 两种后果塌成同一句 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '删最后一条时不再提「整个会话」',
        testFile: GUARD,
        targets: [
          {
            path: COPY_MODULE,
            mutate: source =>
              replaceIn(
                source,
                "        title: '删掉这条会移除整个会话（无法恢复）',",
                "        title: '从会话中移除这条标签页（无法恢复）',"
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '提示必须说清整张会话卡会一起消失',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让两种后果用同一句话');
  });

  it('② onlyActiveTabId 永远返回 null ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '判据永远说「不会整组消失」',
        testFile: GUARD,
        targets: [
          {
            path: UTILS,
            mutate: source =>
              replaceIn(
                source,
                '  let only: string | null = null;',
                '  let only: string | null = null;\n  if (only === null) return null;'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: 'onlyActiveTabId 必须认出「唯一那条活跃标签」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让判据永远返回 null');
  });

  it('③ onlyActiveTabId 把墓碑算成内容 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '墓碑被当成可见内容',
        testFile: GUARD,
        targets: [
          {
            path: UTILS,
            mutate: source => replaceIn(source, '    if (tab.isDeleted) continue;', ''),
          },
        ],
        expectRed: true,
        expectedFailure: '墓碑是同步用的删除意图，不是用户可见内容',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把墓碑算成活跃内容');
  });

  it('④ TabGroup 把 removesWholeSession 写死成 false ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '接线写死成 false',
        testFile: GUARD,
        targets: [
          {
            path: TAB_GROUP,
            mutate: source =>
              replaceIn(
                source,
                'removesWholeSession={soleActiveTabId !== null && soleActiveTabId === tab.id}',
                'removesWholeSession={false}'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '写死 true/false 等于把判据废掉',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把接线写死成 false');
  });

  it('⑤ memo 比较漏掉 removesWholeSession ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'memo 漏掉新 prop',
        testFile: GUARD,
        targets: [
          {
            path: DRAGGABLE_TAB,
            mutate: source =>
              replaceIn(
                source,
                '    prevProps.locked === nextProps.locked &&\n    prevProps.removesWholeSession === nextProps.removesWholeSession;',
                '    prevProps.locked === nextProps.locked;'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: 'memo 比较漏了这个 prop',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让 memo 比较漏掉新 prop');
  });

  it('⑥ DraggableTab 把 title 写死回旧的（说谎的）那句 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'title 写死回旧文案',
        testFile: GUARD,
        targets: [
          {
            path: DRAGGABLE_TAB,
            mutate: source =>
              replaceIn(source, 'title={removeCopy.title}', 'title="从会话中移除这条记录（无法恢复）"'),
          },
        ],
        expectRed: true,
        expectedFailure: 'title 必须来自文案层',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把 title 写死回旧文案');
  });

  it('⑦ 等价改写（局部变量改名）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '局部变量改名',
        testFile: GUARD,
        targets: [
          {
            path: TAB_GROUP,
            mutate: source => replaceAllIn(source, 'soleActiveTabId', 'theOneActiveTabId'),
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把局部变量换个名字');
  });
});
