// 破坏性动作的「预览必须是真的、前提不满足必须拒绝」——2026-10-19 三处真实缺陷的行为级回归。
//
// 每条用例都直接调用**已发布的判定/文案函数**，并拿真实的计划函数
// （planCleanDuplicates / mergeOpStamped / decideFirstSync）产出输入，
// 而不是把期望值抄进断言里。这样实现被改坏时用例会变红，而不是跟着一起错。
//
// 三个缺陷的来源（都是实际读代码/执行后确认，不是推测）：
//   1. 清理重复标签是五个破坏性动作里唯一「确认时不报波及范围」的：
//      确认框只说「此操作无法撤销」，而 1.22.0 起删除即物理清除、无回收站。
//   2. 「删除全部」确认框写着「其他设备将同步删除」，但随后那次云同步的判据
//      是裸 `isAuthenticated` —— 自带存储用户恒 false ⇒ 承诺与行为分裂。
//   3. 首次推送遇到「远端只有墓碑」时，面板抬头警告「会撤销那些删除」，
//      下面三个选项的 hint 却在说「云端独有的 0 个会话」，而 merge 没有
//      warning ⇒ 连二次确认都不弹（UI 只对有 warning 的弹）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { cleanDuplicatesConfirmMessage, cleanDuplicatesResultMessage } from '../src/components/layout/cleanDuplicatesMessage.ts';
import { planCleanDuplicates } from '../src/core/mutationOps.ts';
import {
  deleteAllConfirmMessage,
  deleteAllMenuWarning,
  deleteAllShouldPushOverwrite,
} from '../src/components/layout/deleteAllMessages.ts';
import { deleteReachesOtherDevices } from '../src/components/sync/crossDeviceDeleteCopy.ts';
import { previewOutcome, decideFirstSync } from '../src/sync-backend/webdav/firstSyncDecision.ts';
import type { TabGroup, Tab } from '../src/types/tab.ts';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const NOW = '2026-10-19T10:00:00.000Z';

function tab(id: string, url: string, lastAccessed = NOW): Tab {
  return { id, url, title: id, createdAt: NOW, lastAccessed, pinned: false };
}

function group(id: string, tabs: Tab[], over: Partial<TabGroup> = {}): TabGroup {
  return {
    id,
    name: id,
    tabs,
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 1. 清理重复标签：确认前必须报出真实波及范围
// ─────────────────────────────────────────────────────────────────────────

describe('清理重复标签：确认文案报的是真实计划数字', () => {
  it('两个计数都来自 planCleanDuplicates，而不是另算一份', () => {
    const groups = [
      group('a', [
        tab('a1', 'https://x.dev/1', '2026-10-19T09:00:00.000Z'),
        tab('a2', 'https://x.dev/1', '2026-10-19T08:00:00.000Z'), // 较旧 → 被删
        tab('a3', 'https://x.dev/2'),
      ]),
      group('empty', []),
    ];
    const plan = planCleanDuplicates(groups);

    // 前提：这份种子真的会产生删除，否则下面的断言是恒真的
    assert.equal(plan.removedTabsCount, 1, '前提：3 个标签里有 1 个重复');
    assert.equal(plan.removedGroupsCount, 1, '前提：1 个空会话会被整组移除');

    const msg = cleanDuplicatesConfirmMessage(plan.removedTabsCount, plan.removedGroupsCount);
    assert.match(msg, /1 个重复标签页/, '确认文案必须报出会删几个重复标签');
    assert.match(msg, /1 个空会话/, '确认文案必须报出会删几个空会话');
    assert.match(msg, /无法撤销/, '破坏性动作必须声明不可撤销');
  });

  it('锁定会话不进计划，确认文案也就不该把它算进删除数', () => {
    const groups = [
      group('locked', [
        tab('l1', 'https://x.dev/same'),
        tab('l2', 'https://x.dev/same'),
      ], { isLocked: true }),
      group('free', [tab('f1', 'https://x.dev/same')]),
    ];
    const plan = planCleanDuplicates(groups);
    assert.equal(plan.removedTabsCount, 0, '锁定会话整组跳过，URL 相同的标签不算重复');
    assert.equal(plan.removedGroupsCount, 0);

    // 没有可删的东西时不得摆出破坏性确认框的架势
    const msg = cleanDuplicatesConfirmMessage(0, 0);
    assert.match(msg, /没有发现|无需/, '没有波及范围时必须直接说无事可做');
    assert.doesNotMatch(msg, /无法撤销/, '无事可做时不该提「无法撤销」——那会让用户以为要删东西');
  });

  it('确认文案与结果文案用同一套数字说法（同一件事两个出口）', () => {
    // 确认时说「将清除 N 个重复标签页」，完成后说「已清除 N 个重复标签页」。
    // 两处若用不同的量词，用户会以为第二次报了别的东西。
    const before = cleanDuplicatesConfirmMessage(12, 3);
    const after = cleanDuplicatesResultMessage(12, 3);
    assert.match(before, /12 个重复标签页/);
    assert.match(after, /12 个重复标签页/);
    assert.match(before, /3 个空会话/);
    assert.match(after, /3 个空会话/);
  });

  it('Header 的确认框把计划数字传进去（不是写死文案）', () => {
    const header = read('src/components/layout/Header.tsx');
    assert.match(
      header,
      /planCleanDuplicates\(localGroups\)/,
      '确认前必须真的算一次计划（否则文案里的数字无处而来）',
    );
    assert.match(
      header,
      /cleanDuplicatesConfirmMessage\(\s*plan\.removedTabsCount,\s*plan\.removedGroupsCount,?\s*\)/,
      '确认文案必须由计划的真实计数生成',
    );
    // 计划必须来自存储真值（Redux 可能落后于磁盘，而报错数字比不报更糟）
    assert.match(
      header,
      /localGroups\s*=\s*await storage\.getGroupsForWrite\(\)/,
      '清理范围必须基于存储真值计算',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 删除全部：确认框的承诺必须与随后真正执行的云同步同源
// ─────────────────────────────────────────────────────────────────────────

describe('删除全部：承诺 == 行为（按「有没有可用后端」而不是「有没有账号」）', () => {
  // 三种用户状态 × 两种判据。关键是 self-consistency：
  // confirmText 说会同步删除 ⇒ shouldPush 必须为真，反之亦然。
  const cases = [
    { label: '云端已登录', isAuthenticated: true, syncBackend: 'supabase' as const, expect: true },
    { label: '云端未登录', isAuthenticated: false, syncBackend: 'supabase' as const, expect: false },
    { label: '自带存储（无账号）', isAuthenticated: false, syncBackend: 'webdav' as const, expect: true },
  ];

  for (const c of cases) {
    it(`${c.label}：说会同步 ⇔ 真的会发覆盖上传`, () => {
      const disclosure = { isAuthenticated: c.isAuthenticated, syncBackend: c.syncBackend };
      const reaches = deleteReachesOtherDevices(disclosure);
      const pushes = deleteAllShouldPushOverwrite(disclosure);

      assert.equal(reaches, c.expect, `${c.label}：跨设备披露判据`);
      assert.equal(pushes, c.expect, `${c.label}：执行判据`);
      // 核心不变量：两句话不能一真一假
      assert.equal(
        pushes,
        reaches,
        `${c.label}：确认框承诺（${reaches}）与执行（${pushes}）必须一致 —— ` +
          '一真一假就是「承诺了却没做」或「没承诺却做了」',
      );

      const msg = deleteAllConfirmMessage({ ...disclosure, groupCount: 5, lockedCount: 0 });
      const saidCrossDevice = /其他设备|其他登录设备/.test(msg);
      assert.equal(
        saidCrossDevice,
        reaches,
        `${c.label}：确认框文案与判据不一致：${msg}`,
      );
    });
  }

  it('自带存储用户此前正是被误判的那一格（回归锚点）', () => {
    // 修复前的实现：confirm 用 deleteReachesOtherDevices（webdav=true），
    // 执行用裸 isAuthenticated（webdav 用户恒 false）。这一格必须为 true，
    // 否则回到「承诺了却不做」。
    assert.equal(
      deleteAllShouldPushOverwrite({ isAuthenticated: false, syncBackend: 'webdav' }),
      true,
      '自带存储用户没有账号，但删除必须照样同步到云盘',
    );
  });

  it('纯本地用户（云端未登录）不该被告知「其他设备会删除」，也不该白发一次同步', () => {
    const disclosure = {
      isAuthenticated: false,
      syncBackend: 'supabase' as const,
      groupCount: 3,
      lockedCount: 0,
    };
    const msg = deleteAllConfirmMessage(disclosure);
    assert.doesNotMatch(msg, /其他设备|其他登录设备/, '没有同步后端的用户，删除只在本机生效');
    assert.equal(deleteAllShouldPushOverwrite(disclosure), false);
  });

  it('HeaderDropdown 的执行分支用的是同一个判据（不是裸 isAuthenticated）', () => {
    const src = read('src/components/layout/HeaderDropdown.tsx');
    const callAt = src.indexOf('deleteReachesOtherDevices') !== -1
      ? src.indexOf('deleteReachesOtherDevices')
      : -1;
    // 必须有这个判据的引用（import 或调用）
    assert.ok(
      src.includes('deleteAllShouldPushOverwrite'),
      'HeaderDropdown 必须引用 deleteAllShouldPushOverwrite',
    );
    // 执行分支不得再出现裸 `if (isAuthenticated) {`——那正是缺陷原形
    assert.doesNotMatch(
      src,
      /if \(isAuthenticated\)\s*\{\s*\n\s*sendSyncCommand\('upload'/,
      '删除全部后的云同步不得再用裸 isAuthenticated 判据（自带存储用户会被跳过）',
    );
    assert.ok(callAt >= 0 || src.includes('deleteAllShouldPushOverwrite({ isAuthenticated'));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 首次推送：墓碑态下每个选项的后果说明都必须**与真实后果一致**
// ─────────────────────────────────────────────────────────────────────────

const stamp = (d: string, s: number) => ({ d, s });

describe('首次推送：远端只有墓碑时，三个选项的后果说明都必须与真实后果一致', () => {
  const local = [
    group('g1', [tab('t1', 'https://x.dev/1')], { lastOp: stamp('devA', 5) }),
    group('g2', [tab('t2', 'https://x.dev/2')], { lastOp: stamp('devA', 6) }),
  ];
  // 远端两条墓碑：g1 与本地同 id（**墓碑一律赢** ⇒ 本机那份不会上传，
  // 下次同步时被移除），g3 本地没有（非覆盖路径下什么也不会动它）。
  const tombstones = [
    group('g1', [], { isDeleted: true, lastOp: stamp('devB', 2) }),
    group('g3', [], { isDeleted: true, lastOp: stamp('devB', 3) }),
  ];

  it('前提：决策层确实把「只有墓碑」判成要停下来的状态', () => {
    const decision = decideFirstSync({ localGroups: local, remoteGroups: tombstones });
    assert.equal(decision.action, 'tombstones-only', '只有墓碑 ≠ 云端为空');
    if (decision.action === 'tombstones-only') {
      assert.equal(decision.tombstoneCount, 2);
      assert.equal(decision.localCount, 2);
    }
  });

  for (const choice of ['merge', 'local-wins', 'cloud-wins'] as const) {
    it(`${choice}：hint 必须提到云端已删除的记录，且带 warning 触发确认`, () => {
      const out = previewOutcome(local, tombstones, choice);
      assert.match(
        out.hint,
        /已删除/,
        `${choice} 的 hint 必须提到云端已删除的记录（修复前写的是「云端独有的 0 个会话」）`,
      );
      assert.ok(
        out.warning && out.warning.length > 0,
        `${choice} 在墓碑态必须有 warning —— UI 只对有 warning 的选项弹二次确认，` +
          '缺了它用户就是零确认地丢掉一批会话',
      );
    });
  }

  // ── 2026-10-24 审计 DS-3：后果的方向变了，说明必须跟着变 ────────────────
  //
  // 旧说明说「N 条已删除的会话记录会因本次推送重新出现（撤销了那些删除）」，
  // 那在 DS-3 之前是对的。DS-3 把判据改成「**云端墓碑一律赢**」之后：
  //   · 非覆盖（合并 / 以云端为准）：云端的删除**保住**了 ⇒ 说明不得再说
  //     「会复活 / 撤销那些删除」（那是朝着相反的方向说假话）；
  //     真实的损失在**本机**：那份同 id 副本没被上传 ⇒ 会被移除。
  //   · 覆盖（以本机为准）：云端被清空重写 ⇒ 删除记录被抹掉 ⇒ 删除**确实**
  //     被撤销 ⇒ 说明必须说这一层。
  it('merge：不得再说「删除会被撤销」（云端墓碑一律赢 ⇒ 删除保住）', () => {
    const out = previewOutcome(local, tombstones, 'merge');
    assert.doesNotMatch(
      out.hint,
      /重新出现/,
      `❌ 回归：合并路径下云端的删除**不会**被撤销（墓碑一律赢）—— ` +
        `说「会重新出现」是把已经修好的缺陷当成还存在的：${out.hint}`,
    );
    assert.match(
      out.hint,
      /保持删除/,
      `必须说清云端那边的删除会保住：${out.hint}`,
    );
    assert.match(
      out.hint,
      /副本/,
      `真实的损失在本机那份同 id 副本（没上传 ⇒ 会被移除），必须说出来：${out.hint}`,
    );
  });

  it('cloud-wins：同样不得说「删除会被撤销」', () => {
    const out = previewOutcome(local, tombstones, 'cloud-wins');
    assert.doesNotMatch(out.hint, /重新出现/);
    assert.match(out.hint, /保持删除/);
    assert.match(out.hint, /副本/);
  });

  it('local-wins：覆盖确实会抹掉云端的删除记录 ⇒ 必须说「删除被撤销」', () => {
    const out = previewOutcome(local, tombstones, 'local-wins');
    assert.match(
      out.hint,
      /删除被撤销/,
      `覆盖会把云端清空重写 ⇒ 那些删除记录真的没了，必须说出来：${out.hint}`,
    );
  });

  it('merge 的 warning 必须点名本机那份副本会被移除（不可逆）', () => {
    const out = previewOutcome(local, tombstones, 'merge');
    assert.match(out.warning!, /副本/);
    assert.match(out.warning!, /无法撤销/);
  });

  it('merge 在墓碑态不再携带「云端独有的 0 个」这种抹平事实的说法', () => {
    const out = previewOutcome(local, tombstones, 'merge');
    assert.doesNotMatch(
      out.hint,
      /云端独有的 0 个会话保留在云端，本机暂不会收到$/,
      'merge 的 hint 不得以「0 个」收尾而隐藏墓碑',
    );
  });

  it('没有墓碑时 merge 不带 warning（不该为正常路径加确认噪音）', () => {
    const remote = [group('r1', [tab('rt1', 'https://y.dev/1')], { lastOp: stamp('devB', 9) })];
    const out = previewOutcome(local, remote, 'merge');
    assert.equal(out.warning, undefined, '正常合并没有不可逆后果，不该要求二次确认');
    assert.doesNotMatch(out.hint, /已删除/, '没有墓碑时不该提删除记录');
  });

  it('UI 的确认判据是「有 warning 就确认」，不再把 merge 排除在外', () => {
    const src = read('src/components/sync/WebDavSettings.tsx');
    assert.doesNotMatch(
      src,
      /choice !== 'merge' && d\.warning/,
      "「merge 永不确认」正是让推荐选项零确认撤销删除的原因，必须去掉",
    );
    assert.match(src, /if \(d\.warning\)/, '确认判据应为「这一步有不可恢复后果就确认」');
  });
});

/**
 * 「删除会传到其他设备」这句话**必须说清真实后果**（数据安全审计 DS-3）。
 *
 * ── 口径在 2026-10-24 变过一次 ────────────────────────────────────────────
 * 旧口径：删除意图会广播，但**胜负由操作印记决定** ⇒ 另一台设备若在离线期间
 * 改过这个会话，删除**可能被撤销** ⇒ 确认框必须说清「可能不生效」。
 *
 * 新口径（DS-3 已修）：**云端墓碑一律压过本地活跃副本**（`core/opStampMerge.ts`
 * / `core/remoteAdjudication.ts` / `utils/supabase/upload.ts` 三处同口径）⇒
 * 对方离线期间改过**也一样会被删除** ⇒ 「可能不生效」已经不成立，
 * 继续留着就是**对着让用户低估后果的方向说假话**。
 *
 * ⇒ 现在这句必须说出**真实后果**：删除会同步过去，**对方那份离线编辑也一起没**。
 * 守卫钉的是「承诺与实现一致」这个不变量，不钉某一句话的字面量。
 */
describe('删除的跨设备承诺必须与实现一致（DS-3 修完后：删除一定生效）', () => {
  it('确认框承诺跨设备删除时，不得还说「删除可能不生效」（那句已经不成立）', () => {
    const msg = deleteAllConfirmMessage({
      isAuthenticated: true,
      syncBackend: 'supabase',
      groupCount: 5,
      lockedCount: 0,
    });
    assert.match(msg, /其他登录设备将同步删除/, '前提：这句话本身必须还在');
    assert.doesNotMatch(
      msg,
      /删除可能不生效/,
      '❌ 回归：云端墓碑已经一律赢了（DS-3），删除**一定**生效 —— ' +
        '继续说「可能不生效」是把已经修好的缺陷当成还存在的，说的是假话'
    );
  });

  it('确认框必须说清真实后果：对方离线期间改过的那份也一起被删', () => {
    const msg = deleteAllConfirmMessage({
      isAuthenticated: true,
      syncBackend: 'supabase',
      groupCount: 5,
      lockedCount: 0,
    });
    assert.match(
      msg,
      /离线期间改过.*会被删除/,
      '删除会同步过去且对方那份离线编辑也没了 —— 这一层后果必须说在按确认键之前'
    );
  });

  it('菜单行那句（用户点开菜单就能看到的）必须同样说清', () => {
    const msg = deleteAllMenuWarning({
      isAuthenticated: true,
      syncBackend: 'supabase',
      lockedCount: 0,
    });
    assert.match(msg, /同步删除/, '前提：这句话本身必须还在');
    assert.doesNotMatch(
      msg,
      /删除可能不生效/,
      '菜单行与确认框必须同口径 —— 而真相只有一个：删除一定生效'
    );
    assert.match(
      msg,
      /离线期间改过.*会被删除/,
      '菜单行与确认框必须同口径 —— 两处各说一半，读者看到的就是两件不同的事'
    );
  });

  it('纯本地用户（没有同步后端）不该看到这句承诺，也不该看到那句限定', () => {
    const msg = deleteAllConfirmMessage({
      isAuthenticated: false,
      syncBackend: 'supabase',
      groupCount: 3,
      lockedCount: 0,
    });
    assert.doesNotMatch(msg, /其他设备|其他登录设备|也会被删除/);
  });
});
