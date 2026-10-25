/**
 * 变异自证：DS-43-15 的守卫（「删除所有会话」的数字必须取磁盘真值、删完必须说出来）
 * 必须**看得见破口**。
 *
 * 四个方向：
 *   ① 确认框的数字改回 Redux 快照（**旧行为**）⇒ 守卫必须变红；
 *   ② 读失败时**退回快照**继续删（fail-open，**旧行为**）⇒ 守卫必须变红；
 *   ③ 删完**不报实际条数**⇒ 守卫必须变红；
 *   ④ **等价的正确写法**（局部变量改名）⇒ 守卫必须**仍然绿**。
 *
 * 方向 ④ 是这条守卫能不能长期活着的关键：判据只钉**接口锚点**
 * （纯函数名、存储 API），不钉局部变量名 ⇒ 换个名字不该误报。
 *
 * 沙箱的做法见 `tests/_helpers/mutationSandbox.ts`。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/deleteAllDisclosure.test.ts';
const DROPDOWN = 'src/components/layout/HeaderDropdown.tsx';

describe('变异自证：DS-43-15 的守卫必须看得见破口', () => {
  it('变异一：确认框的数字改回 Redux 快照（旧行为）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '确认框数量改回 groups.length',
        testFile: GUARD,
        targets: [
          {
            path: DROPDOWN,
            mutate: source => {
              const old = 'groupCount: plan.groupCount,';
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到 groupCount 赋值');
              return source.replace(old, 'groupCount: groups.length,');
            },
          },
        ],
        expectRed: true,
        expectedFailure: '数量必须来自磁盘真值算出的那份 plan',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把确认框的数量改回 Redux 快照');
  });

  it('变异二：读失败时退回快照继续删（fail-open，旧行为）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '读失败退回 Redux 快照',
        testFile: GUARD,
        targets: [
          {
            path: DROPDOWN,
            mutate: source => {
              const old = [
                '    } catch (error) {',
                "      logError('[HeaderDropdown] 删除前读取真实会话失败，已取消删除:', error);",
                "      showToast(DELETE_ALL_READ_FAILED_MESSAGE, 'error');",
                '      return;',
                '    }',
              ].join('\n');
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到 fail-closed 的 catch 分支');
              return source.replace(
                old,
                [
                  '    } catch (error) {',
                  "      logError('[HeaderDropdown] 删除前读取真实会话失败，改用界面现值:', error);",
                  '      diskGroups = groups;',
                  '    }',
                ].join('\n')
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '读失败必须中止',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让读失败退回 Redux 快照继续删');
  });

  it('变异三：删完不报实际条数 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '成功提示不再用那份文案函数',
        testFile: GUARD,
        targets: [
          {
            path: DROPDOWN,
            mutate: source => {
              // ⚠️ 2026-10-25「安静的成功」：调用点改成了 `counts` 变量
              // （判据层要拿同一份 {deletedCount, confirmedCount} 判「一致吗」）。
              // ⇒ 这里必须**替换全部**出现处：只换第一处的话，第二处（提示本身）
              // 还留着 `deleteAllSuccessMessage(` ⇒ 守卫照样绿 ⇒ 变异前提失效。
              const old = 'deleteAllSuccessMessage(counts)';
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到成功提示的调用');
              return source.split(old).join("'已删除'");
            },
          },
        ],
        expectRed: true,
        expectedFailure: '成功提示必须由同一份文案函数产出',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把成功提示换成一句没有数字的话');
  });

  it('变异四：等价的正确写法（局部变量改名）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '局部变量改名',
        testFile: GUARD,
        targets: [
          {
            path: DROPDOWN,
            mutate: source => {
              // ⚠️ 只改**局部变量名**，不改任何行为：
              //   · `plan` → `deletePlan`（`planDeleteAll` 不受影响：\b 不匹配）
              //   · `diskCounts` → `snapshotCounts`（含 setter）
              const renamed = source
                .replace(/setDiskCounts/g, 'setSnapshotCounts')
                .replace(/\bdiskCounts\b/g, 'snapshotCounts')
                .replace(/\bplan\b/g, 'deletePlan');
              if (renamed === source) throw new Error('变异前提没成立：没改名到任何东西');
              return renamed;
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把局部变量 plan / diskCounts 改名成等价的名字');
  });
});
