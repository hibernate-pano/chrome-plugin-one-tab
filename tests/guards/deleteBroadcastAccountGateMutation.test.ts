/**
 * 变异自证：删除广播的账号闸门守卫（tests/guards/deleteBroadcastAccountGate.test.ts）
 * 必须**看得见破口**。
 *
 * 沙箱的做法见 `tests/_helpers/mutationSandbox.ts`（复制一份仓库 → 在副本上变异
 * → 跑守卫本身 ⇒ 「守卫变红」由守卫自己给出，不需要第二份实现）。
 *
 * ── 这几条分别证明什么 ────────────────────────────────────────────────────
 *
 *   M1 **判据层恒放行**（core/accountScope 的 partitionDeleteIdsByAccount）
 *      ⇒ 守卫必须变红：证明「属于别的账号的 id 不进上行集合」这条判据有检测力。
 *
 *   M2 **写入层绕过闸门**（utils/supabase/upload 的 markCloudGroupsAsDeleted
 *      不再过 partitionDeleteIdsByAccount，直接把整批当成本账号的）
 *      ⇒ 守卫必须变红：证明「被挡下的那条必须回报给调用方」与
 *      「云端没有这一行 ≠ 意图已达成」这两条**有检测力**。
 *      ⚠️ 注意此时云端**一个字节都不会被写坏**（每个写操作都带
 *      `.eq('user_id', userId)`）⇒ 唯一能抓得住它的是「broadcastIds 里有没有那条」。
 *
 *   M3 **消费层整队清队**（syncEngine 改成 `clearPendingDeleteIds(整批)`）
 *      ⇒ 守卫必须变红：证明「被挡下的意图留在队列里」这条不变量有检测力。
 *      这是整条缺陷链的**最后一环**：意图被清掉 ⇒ 会话在原账号下复活。
 *
 *   M4 **归属不可知时 fail-open**（scope 读不出来/没有主人 ⇒ 放行）
 *      ⇒ 守卫必须变红：证明 fail-closed 这条性质有检测力。
 *
 *   M5 **等价改写**（if/else push 改成三元 push）⇒ 守卫必须**仍然绿**。
 *      这一条决定守卫能不能长期活着：判据钉的是**行为**（两个集合的内容），
 *      不是「源码长什么样」⇒ 等价写法不该误报。
 *
 * ── 为什么要补这一份 ──────────────────────────────────────────────────────
 * 守卫文件里原有的「自证检测力」段落是**模拟**（在测试里手写一个破口函数，
 * 断言它确实坏）—— 它证明的是「破口的形状对」，不是「守卫真的看得见这个破口」。
 * 真·检测力只能靠**改坏实现、让守卫自己变红**来证明。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/deleteBroadcastAccountGate.test.ts';
const SCOPE = 'src/core/accountScope.ts';
const UPLOAD = 'src/utils/supabase/upload.ts';
const ENGINE = 'src/services/syncEngine.ts';

describe('变异自证：删除广播的账号闸门守卫必须看得见破口', () => {
  it('破口一：判据层恒放行（属于别的账号也放进上行集合）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'partitionDeleteIdsByAccount 恒放行',
        testFile: GUARD,
        targets: [
          {
            path: SCOPE,
            mutate: source => {
              const old = '    else blockedIds.push(id);';
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到判据层的 else 分支');
              return source.replace(old, '    else broadcastIds.push(id);');
            },
          },
        ],
        expectRed: true,
        expectedFailure: '只有属于当前账号的会话才能写进当前账号的云端',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把判据层改成恒放行（闸门形同虚设）');
  });

  it('破口二：写入层绕过账号闸门 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'markCloudGroupsAsDeleted 不再过归属闸门',
        testFile: GUARD,
        targets: [
          {
            path: UPLOAD,
            mutate: source => {
              const old =
                '    const partitioned = partitionDeleteIdsByAccount(deletedIds, accountScope, userId);';
              if (!source.includes(old)) {
                throw new Error('变异前提没成立：找不到写入层的归属闸门调用');
              }
              return source.replace(
                old,
                '    const partitioned = { broadcastIds: [...deletedIds], blockedIds: [] as string[] };',
              );
            },
          },
        ],
        expectRed: true,
        // 这条期望同时覆盖 plain 降级分支那条用例（item 4 的不变量）：
        // 「云端没有这一行」不得被当成「意图已达成」。
        expectedFailure: '云端没有这一行 ≠ 意图已达成',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让写入层不再过归属闸门');
  });

  it('破口三：消费层整队清队（按点名的消费改成整批清空）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'syncEngine 按整批清删除队列',
        testFile: GUARD,
        targets: [
          {
            path: ENGINE,
            mutate: source => {
              const old = 'await storage.clearPendingDeleteIds(broadcastDeleteIds);';
              if (!source.includes(old)) {
                throw new Error('变异前提没成立：找不到按点名清队的那一行');
              }
              return source.replace(
                old,
                'await storage.clearPendingDeleteIds(cloudDeleteIds);',
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '留在队列里',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把清队从「按点名」改成「整批清空」');
  });

  it('破口四：归属不可知时 fail-open（放行）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '归属不可知时改成放行',
        testFile: GUARD,
        targets: [
          {
            path: SCOPE,
            mutate: source => {
              const old = '    return { broadcastIds: [], blockedIds: ids };';
              if (!source.includes(old)) {
                throw new Error('变异前提没成立：找不到 fail-closed 的那一支');
              }
              return source.replace(
                old,
                '    return { broadcastIds: [...ids], blockedIds: [] };',
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '归属记录读不出来 ⇒ 一律挡住',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把归属不可知时的 fail-closed 改成 fail-open');
  });

  it('等价改写：if/else push 改成三元 push（语义不变）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '判据层的 if/else 改成三元',
        testFile: GUARD,
        targets: [
          {
            path: SCOPE,
            mutate: source => {
              const old = [
                '    if (owner === currentUserId) broadcastIds.push(id);',
                '    else blockedIds.push(id);',
              ].join('\n');
              if (!source.includes(old)) {
                throw new Error('变异前提没成立：找不到判据层的 if/else');
              }
              return source.replace(
                old,
                '    (owner === currentUserId ? broadcastIds : blockedIds).push(id);',
              );
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把判据层的 if/else 改写成等价的三元表达式');
  });
});
