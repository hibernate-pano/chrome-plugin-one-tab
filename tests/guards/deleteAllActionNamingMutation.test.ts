/**
 * 变异自证：「同一个动作只能有一个叫法」这条守卫必须真的看得见破口。
 *
 * 沙箱的做法见 `tests/_helpers/mutationSandbox.ts`。
 *
 * ── 这几条分别证明什么 ────────────────────────────────────────────────────
 *
 *   M1 README 漂回旧叫法「删除全部会话」⇒ 「不得出现另一个叫法」那条真的会红
 *   M2 商店页漂回旧叫法 ⇒ 「商店页不许再有旧叫法」那条真的会红
 *   M3 **界面**改了叫法 ⇒ 「界面与文档之间没有第二个叫法」那条真的会红
 *      （这条证明判据是「现场从界面读基准」，不是把某句中文钉死）
 *   M4 等价改写（叫法不变，只改周围措辞）⇒ 守卫**仍然绿**
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/deleteAllActionNaming.test.ts';

describe('变异自证：WC-8 叫法一致性守卫必须看得见破口', () => {
  it('变异一：README 漂回旧叫法 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'README 里又出现「删除全部会话」',
        testFile: GUARD,
        targets: [
          {
            path: 'README.md',
            // 必须**全部**替换：只改第一处的话，其余处还在 ⇒ 守卫仍绿 ⇒ 假绿。
            mutate: source => source.split('「删除所有会话」').join('「删除全部会话」'),
          },
        ],
        expectRed: true,
        expectedFailure: '还在用「删除全部会话」，而界面上叫「删除所有会话」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把 README 里的叫法换回「删除全部会话」');
  });

  it('变异二：商店页漂回旧叫法 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '商店页里又出现「删除全部会话」',
        testFile: GUARD,
        targets: [
          {
            path: 'CHROMEWEBSTORE.md',
            mutate: source => source.split('「删除所有会话」').join('「删除全部会话」'),
          },
        ],
        expectRed: true,
        expectedFailure: '商店页正文里还有「删除全部会话」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把商店页里的叫法换回「删除全部会话」');
  });

  it('变异三：界面自己改了叫法 ⇒ 守卫必须变红（基准是现场读出来的）', () => {
    const [outcome] = runMutationCases([
      {
        name: '菜单那一行改了叫法',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/layout/HeaderDropdown.tsx',
            mutate: source =>
              source.replace(
                '删除所有会话（{groups.length}）',
                '删除全部会话（{groups.length}）',
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '界面上现在叫「删除全部会话」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把菜单里那一行的叫法改掉');
  });

  it('变异四：只让「Review Notes」那一处漂回旧叫法 ⇒ 棘轮（= 0）必须变红', () => {
    // 这一条专门验**主控收紧后的棘轮**：正文（Store Listing 段）还是对的，
    // 只有 Known Issues 那一处漂了 ⇒ 「商店页里不许再有旧叫法」那条必须抓住。
    // （若那条断言被放松成「≤ 1」，这个变异就会悄悄溜过去。）
    const [outcome] = runMutationCases([
      {
        name: 'Known Issues 那一处漂回旧叫法',
        testFile: GUARD,
        targets: [
          {
            path: 'CHROMEWEBSTORE.md',
            mutate: source =>
              source.replace(
                '因此删除**整个会话**前会弹出确认框（可在设置里关闭；「删除所有会话」始终确认）',
                '因此删除**整个会话**前会弹出确认框（可在设置里关闭；「删除全部会话」始终确认）',
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '商店页里有 1 处「删除全部会话」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让商店页的 Known Issues 那一处漂回旧叫法');
  });

  it('等价改写：叫法不变、只改周围的措辞 ⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '等价改写：「始终确认并显示数量」→「始终确认、显示数量」',
        testFile: GUARD,
        targets: [
          {
            path: 'README.md',
            mutate: source =>
              source.split('「删除所有会话」始终确认并显示数量').join('「删除所有会话」始终确认、显示数量'),
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '只改 README 里那句话的措辞（叫法不变）');
  });
});
