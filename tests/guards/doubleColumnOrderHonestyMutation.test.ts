/**
 * 变异自证：R-11 的守卫（双栏必须按用户选的排序摆）必须真的看得见破口。
 *
 * ── 变异一用的是**真实的旧实现** ──────────────────────────────────────────
 * 不是「随便改坏一下」，而是把 2026-10-23 之前那版「按标签数贪心均衡分栏」
 * 原样放回去（含配套的 `.session-grid-column` 样式）——
 * 这样「守卫抓到了当年那个真缺陷」这件事才是真的，
 * 而不是「守卫抓到了一个人为构造的怪东西」。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/doubleColumnOrderHonesty.test.ts';

/** 旧实现的双栏分支（2026-10-23 之前）。 */
const OLD_DOUBLE_BRANCH = `) : layoutMode === 'double' ? (
        <div className="session-grid">
          {(() => {
            // 按标签数均衡分栏：贪心把下一组放进当前标签总数更少的一栏。
            const columns: typeof filteredGroups[] = [[], []];
            const counts = [0, 0];
            for (const group of filteredGroups) {
              const target = counts[0] <= counts[1] ? 0 : 1;
              columns[target].push(group);
              counts[target] += group.tabs.length;
            }
            return columns.map((column, columnIndex) => (
              <div key={columnIndex} className="session-grid-column transition-all duration-300 ease-out">
                {column.map(group => (
                  <DraggableTabGroup key={group.id} group={group} />
                ))}
              </div>
            ));
          })()}
        </div>
      `;

/** 旧实现配套的列容器样式。 */
const OLD_COLUMN_CSS = `
.session-grid-column {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-width: 0;
}
`;

describe('变异自证：双栏顺序这条守卫必须看得见破口', () => {
  it('变异一：把旧的「按标签数贪心分栏」放回去 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '恢复旧的双栏分栏实现',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/tabs/TabList.tsx',
            mutate: source => {
              const start = source.indexOf(") : layoutMode === 'double' ? (");
              if (start < 0) throw new Error('变异前提没成立：找不到双栏分支');
              const end = source.indexOf(') : (', start + 10);
              if (end < 0) throw new Error('变异前提没成立：找不到双栏分支的结尾');
              return source.slice(0, start) + OLD_DOUBLE_BRANCH + source.slice(end);
            },
          },
          {
            path: 'src/styles/global.css',
            mutate: source => `${source}\n${OLD_COLUMN_CSS}`,
          },
        ],
        expectRed: true,
        expectedFailure: 'DOM 顺序必须等于排序后的顺序',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把旧的贪心分栏实现放回去');
  });

  it('等价改写：先复制一份数组再铺（渲染结果一模一样）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '铺之前先复制一份数组',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/tabs/TabList.tsx',
            // 第一次出现的是双栏分支 ⇒ 只改它。
            mutate: source =>
              source.replace(
                '{filteredGroups.map(group => (',
                '{[...filteredGroups].map(group => ('
              ),
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '铺之前先复制一份数组（渲染结果一模一样）');
  });
});
