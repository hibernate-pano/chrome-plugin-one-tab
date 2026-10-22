/**
 * 变异自证：DS-43-17 那条线的守卫必须看得见破口。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * `tests/guards/deleteEntryAriaLabel.test.ts` 钉的是「删除入口的可访问名
 * 必须带后果」。一条从来没红过的守卫，可能一直是绿的而什么也没守住 ——
 * 唯一的验证办法是**把实现改坏，看守卫会不会红**。
 *
 * ── 变异清单 ─────────────────────────────────────────────────────────────
 *   ① 文案层：可访问名里不写「删除后无法恢复」（回到缺陷本体）
 *   ② 文案层：可访问名不再包含可见文字（WCAG 2.5.3 破了）
 *   ③ 接线层：宽屏按钮回退成裸的可见文字当 aria-label
 *   ④ 接线层：窄屏菜单项的 aria-label 整个删掉
 *   ⑤ 接线层：tooltip 的内容与 aria-label 分家（各写一份）
 *   ⑥ 等价改写：局部变量/导入别名改名 ⇒ 必须**仍然绿**（守卫不许钉死字面量）
 *
 * 变异只发生在沙箱副本里（`tests/_helpers/mutationSandbox.ts`），
 * 共享工作树一个字节都不动。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/deleteEntryAriaLabel.test.ts';
const COPY_MODULE = 'src/components/tabs/lockedDeleteCopy.ts';
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

/**
 * 按**词边界**改名。
 *
 * ⚠️ 这里的改名是「改 import 别名」，不是改导出名 ——
 * `deleteGroupEntryAriaLabel` 与 `deleteGroupEntryLabel` 互为前缀关系，
 * 一刀切下去会连另一个导出名一起改掉（那就不是等价改写了）。
 * ⇒ 用 `as` 别名 + 只替换调用点，避开这个坑。
 */

describe('变异自证：DS-43-17 的守卫必须看得见破口', () => {
  it('① 可访问名里不写「删除后无法恢复」⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '不写后果',
        testFile: GUARD,
        targets: [
          {
            path: COPY_MODULE,
            mutate: source =>
              replaceIn(
                source,
                "export const deleteGroupEntryAriaLabel = (isLocked: boolean): string =>\n  `${deleteGroupEntryLabel(isLocked)}（删除后无法恢复）`;",
                "export const deleteGroupEntryAriaLabel = (isLocked: boolean): string =>\n  deleteGroupEntryLabel(isLocked);"
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '读屏用户听不到 tooltip',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把「删除后无法恢复」从可访问名里删掉');
  });

  it('② 可访问名不再包含可见文字 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '不含可见文字',
        testFile: GUARD,
        targets: [
          {
            path: COPY_MODULE,
            mutate: source =>
              replaceIn(
                source,
                "export const deleteGroupEntryAriaLabel = (isLocked: boolean): string =>\n  `${deleteGroupEntryLabel(isLocked)}（删除后无法恢复）`;",
                "export const deleteGroupEntryAriaLabel = (isLocked: boolean): string =>\n  '删除（删除后无法恢复）';"
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '必须包含可见文字',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让可访问名不再包含可见文字');
  });

  it('③ 宽屏按钮回退成裸的可见文字当 aria-label ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '宽屏回退',
        testFile: GUARD,
        targets: [
          {
            path: TAB_GROUP,
            mutate: source =>
              replaceIn(
                source,
                '              aria-label={deleteGroupEntryAriaLabel(group.isLocked)}\n            >\n              <DeleteIcon />',
                '              aria-label={deleteGroupEntryLabel(group.isLocked)}\n            >\n              <DeleteIcon />'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: 'aria-label 又变回只有「删除会话」了',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把宽屏删除按钮的 aria-label 回退成裸的可见文字');
  });

  it('④ 窄屏菜单项的 aria-label 整个删掉 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '窄屏删掉 aria-label',
        testFile: GUARD,
        targets: [
          {
            path: TAB_GROUP,
            mutate: source =>
              replaceIn(
                source,
                '              aria-label={deleteGroupEntryAriaLabel(group.isLocked)}\n            >\n              {deleteGroupEntryLabel(group.isLocked)}',
                '            >\n              {deleteGroupEntryLabel(group.isLocked)}'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '后果必须在 aria-label 上',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把窄屏删除项的 aria-label 整个删掉');
  });

  it('⑤ tooltip 与 aria-label 分家（各写一份）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'tooltip 分家',
        testFile: GUARD,
        targets: [
          {
            path: TAB_GROUP,
            mutate: source =>
              replaceIn(
                source,
                '            content={deleteGroupEntryAriaLabel(group.isLocked)}',
                "            content={`${deleteGroupEntryLabel(group.isLocked)}（删除后无法恢复）`}"
              ),
          },
        ],
        expectRed: true,
        expectedFailure: 'tooltip 与 aria-label 必须同源',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让 tooltip 的内容与 aria-label 分家');
  });

  it('⑥ 等价改写（导入别名改名）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '别名改名',
        testFile: GUARD,
        targets: [
          {
            path: TAB_GROUP,
            mutate: source =>
              replaceIn(
                source,
                '  deleteGroupEntryAriaLabel,',
                '  deleteGroupEntryAriaLabel as deleteEntryAriaLabel,'
              ).replace(/deleteGroupEntryAriaLabel\(group\.isLocked\)/g, 'deleteEntryAriaLabel(group.isLocked)'),
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把共享文案的导入别名改个名字');
  });
});
