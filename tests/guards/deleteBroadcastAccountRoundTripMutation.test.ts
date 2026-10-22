/**
 * 变异自证：DS-43-1 的**往返**守卫（tests/guards/deleteBroadcastAccountRoundTrip.test.ts）
 * 必须看得见破口。
 *
 * 沙箱的做法见 `tests/_helpers/mutationSandbox.ts`（复制一份仓库 → 在副本上变异
 * → 跑守卫本身 ⇒ 「守卫变红」由守卫自己给出，不需要第二份实现）。
 *
 * ── 这几条分别证明什么 ────────────────────────────────────────────────────
 *
 *   M1 **判据层 fail-closed 改成 fail-open**（core/accountScope 的
 *      partitionDeleteIdsByAccount：归属不可知时放行）
 *      ⇒ 守卫必须变红。
 *
 *   M2 **写入层绕过账号闸门**（utils/supabase/upload 的 markCloudGroupsAsDeleted
 *      不再过 partitionDeleteIdsByAccount，直接把整批当成本账号的）
 *      ⇒ 守卫必须变红。
 *      ⚠️ 注意此时云端**一个字节都不会被写坏**（每个写操作都带
 *      `.eq('user_id', userId)`）⇒ 唯一能抓得住它的是「这条意图有没有被清出队列」。
 *
 *   M3 **归属账本丢掉队列里的 id**（core/accountScope 的 decideAccountBind
 *      不把 pendingDeleteIds 算进归属账本）
 *      ⇒ 守卫必须变红：一条「已经删掉、不在本机清单里」的会话会在换账号时丢掉归属
 *      ⇒ 它的删除意图被发给新账号 ⇒ 主人的云端拿不到墓碑 ⇒ 会话复活。
 *
 *   M4 **消费层整队清队**（syncEngine 改成 `clearPendingDeleteIds(整批)`）
 *      ⇒ 守卫必须变红：被挡下的那条被连坐清掉 ⇒ 意图永久丢失 ⇒ 会话复活。
 *
 *   M5 **等价改写**（if/else push 改成三元 push）⇒ 守卫必须**仍然绿**。
 *      这一条决定守卫能不能长期活着：判据钉的是**行为**，不是「源码长什么样」。
 *
 * ── 为什么必须自己再证一遍（而不是复用别人的变异文件）────────────────────
 * `tests/guards/deleteBroadcastAccountGateMutation.test.ts` 证的是**分层**守卫
 * （判据层 / 写入层 / 消费层各自有检测力）。本文件证的是**往返**守卫：
 * 「被挡下的意图一直等到主人登录回来，并真的落到主人的云端」。
 * 两条守卫钉的是不同的东西 ⇒ 变异也必须分别验过，否则其中一条可能是空的。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/deleteBroadcastAccountRoundTrip.test.ts';
const SCOPE = 'src/core/accountScope.ts';
const UPLOAD = 'src/utils/supabase/upload.ts';
const ENGINE = 'src/services/syncEngine.ts';

describe('变异自证：删除广播账号闸门的往返守卫必须看得见破口', () => {
  it('破口一：判据层归属不可知时改成放行（fail-open）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'partitionDeleteIdsByAccount 的 fail-closed 改成 fail-open',
        testFile: GUARD,
        targets: [
          {
            path: SCOPE,
            mutate: source => {
              const old = '    return { broadcastIds: [], blockedIds: ids };';
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到判据层的 fail-closed 那一支');
              return source.replace(
                old,
                '    return { broadcastIds: [...ids], blockedIds: [] };',
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '归属不可知时，这条删除意图必须留在队列里',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把归属不可知时的 fail-closed 改成 fail-open');
  });

  it('破口一之二：判据层恒放行（别的账号也放进上行集合）⇒ 守卫必须变红', () => {
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
        expectedFailure: '这条删除意图必须**留在队列里**',
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
        expectedFailure: '这条删除意图必须**留在队列里**',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让写入层不再过归属闸门');
  });

  it('破口三：归属账本不把「队列里的删除意图」算进去 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'decideAccountBind 的归属账本丢掉 pendingDeleteIds',
        testFile: GUARD,
        targets: [
          {
            path: SCOPE,
            mutate: source => {
              const old = '  const ownedIds = [...new Set([...localIds, ...pendingDeleteIds])];';
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到归属账本那一行');
              return source.replace(old, '  const ownedIds = [...new Set([...localIds])];');
            },
          },
        ],
        expectRed: true,
        expectedFailure: '归属必须仍然按「上一个账号」记着',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让归属账本丢掉「队列里的删除意图」');
  });

  it('破口四：消费层整队清队（按点名的消费改成整批清空）⇒ 守卫必须变红', () => {
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
        expectedFailure: '这条删除意图必须**留在队列里**',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把清队从「按点名」改成「整批清空」');
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
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到判据层的 if/else');
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
