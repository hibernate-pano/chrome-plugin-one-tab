// 「删除所有会话」的跨设备删除披露必须同源（2026-10-18 round 25）。
//
// 【要防的回归类别】删除意图会传到其他设备：本地物理移除后墓碑经上传队列广播到云端
// （Supabase `markCloudGroupsAsDeleted` / WebDAV `broadcastDeletes`），对端合并时服从墓碑。
// 但两处声明曾各写一份判据：
//   · 菜单行（HeaderDropdown 危险区）**无条件**写「（其他登录设备同步删除）」——
//     对没有同步后端的纯本地用户是假话；
//   · 确认框（真正按下「全部删除」的那一步）只看 `isAuthenticated`，
//     而自带存储（WebDAV）用户没有 TapStack 账号 ⇒ 一个字都不提跨设备删除。
// 于是最该看清的那一步反而最不诚实，用户以为「只删本机」，其他设备上的会话已经没了。
//
// 本守卫钉三件事：① 判据本身（登录 / 自带存储 / 纯本地三种边界）；
// ② 两处文案都由同一个纯函数产出（同一份声明只有一个版本）；
// ③ 仓里不再有各写一份的内联判据。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DELETE_ALL_NOTHING_MESSAGE,
  DELETE_ALL_READ_FAILED_MESSAGE,
  deleteAllConfirmMessage,
  deleteAllConfirmTitle,
  deleteAllMenuWarning,
  deleteAllSuccessMessage,
  deletedCountFromResult,
  planDeleteAll,
} from '@/components/layout/deleteAllMessages';
import { deleteReachesOtherDevices } from '@/components/sync/crossDeviceDeleteCopy';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
const DROPDOWN = 'src/components/layout/HeaderDropdown.tsx';

describe('deleteReachesOtherDevices：判据是「有没有可用的同步后端」，不是「有没有账号」', () => {
  it('TapStack 云端已登录 → true', () => {
    assert.equal(deleteReachesOtherDevices({ isAuthenticated: true, syncBackend: 'supabase' }), true);
  });

  it('自带存储（WebDAV）未登录 → true（墓碑广播不看账号）', () => {
    assert.equal(deleteReachesOtherDevices({ isAuthenticated: false, syncBackend: 'webdav' }), true);
  });

  it('纯本地（未登录 + 云端后端）→ false（此时不该承诺跨设备删除）', () => {
    assert.equal(deleteReachesOtherDevices({ isAuthenticated: false, syncBackend: 'supabase' }), false);
  });
});

describe('确认框文案：破坏性操作的最后一道说明', () => {
  it('自带存储用户也会被告知其他设备会同步删除（改前完全没提）', () => {
    const message = deleteAllConfirmMessage({
      groupCount: 3,
      lockedCount: 0,
      isAuthenticated: false,
      syncBackend: 'webdav',
    });
    // 【为什么改成「前缀匹配」而不是逐字相等】2026-10-23 追加了 DS-3 那一句
    // 「删除可能不生效」⇒ 逐字相等会把**正确的**改动判成红。
    // 这条守卫真正要守的是三件事：**谁**被告知（设备标签对不对）、
    // **有没有**被告知（那句在不在）、**结尾**的确认问句在不在。
    // ⇒ 钉这三件事，不钉整串字节。
    assert.match(
      message,
      /^将删除本地全部 3 个会话，删除后无法恢复，其他设备将同步删除/,
      `自带存储用户的确认框必须先说清「其他设备将同步删除」：${message}`
    );
    assert.match(message, /。确认继续吗？$/, `确认问句必须还在：${message}`);
    assert.ok(!message.includes('登录设备'), '自带存储用户没有账号，不该说「登录设备」');
  });

  it('已登录用户保持原文案（口径不变）', () => {
    const message = deleteAllConfirmMessage({
      groupCount: 7,
      lockedCount: 0,
      isAuthenticated: true,
      syncBackend: 'supabase',
    });
    assert.match(
      message,
      /^将删除本地全部 7 个会话，删除后无法恢复，其他登录设备将同步删除/,
      `已登录用户必须被告知「其他登录设备将同步删除」：${message}`
    );
    assert.match(message, /。确认继续吗？$/);
  });

  it('纯本地用户不出现跨设备那句（无后端可广播）', () => {
    const message = deleteAllConfirmMessage({
      groupCount: 2,
      lockedCount: 0,
      isAuthenticated: false,
      syncBackend: 'supabase',
    });
    assert.equal(message, '将删除本地全部 2 个会话，删除后无法恢复。确认继续吗？');
  });

  it('数量就是传入的会话数（不写死、不吞 0）', () => {
    assert.ok(
      deleteAllConfirmMessage({
        groupCount: 0,
        lockedCount: 0,
        isAuthenticated: true,
        syncBackend: 'supabase',
      }).includes('全部 0 个会话')
    );
  });
});

describe('菜单行文案：与确认框同一份判据', () => {
  it('自带存储用户 → 其他设备同步删除', () => {
    assert.match(
      deleteAllMenuWarning({ lockedCount: 0, isAuthenticated: false, syncBackend: 'webdav' }),
      /^将清空本地全部会话，删除后无法恢复（其他设备同步删除/,
      '自带存储用户的菜单行必须说「其他设备同步删除」'
    );
  });

  it('已登录用户 → 与改前逐字一致', () => {
    assert.match(
      deleteAllMenuWarning({ lockedCount: 0, isAuthenticated: true, syncBackend: 'supabase' }),
      /^将清空本地全部会话，删除后无法恢复（其他登录设备同步删除/,
      '已登录用户的菜单行必须说「其他登录设备同步删除」'
    );
  });

  it('纯本地用户 → 不再无条件承诺跨设备删除', () => {
    assert.equal(
      deleteAllMenuWarning({ lockedCount: 0, isAuthenticated: false, syncBackend: 'supabase' }),
      '将清空本地全部会话，删除后无法恢复。'
    );
  });
});

describe('两处入口都走同一个纯函数（同一份声明只有一个版本）', () => {
  const source = read(DROPDOWN);

  it('确认框正文由 deleteAllConfirmMessage 装配，且读的是真实后端', () => {
    const call = source.slice(source.indexOf('deleteAllConfirmMessage({'));
    assert.ok(call.length > 0, '确认框正文必须由 deleteAllConfirmMessage 产出');
    const args = call.slice(0, call.indexOf('})'));
    assert.ok(
      /groupCount:\s*[A-Za-z_$][\w$]*\.groupCount/.test(args),
      '数量必须来自磁盘真值算出的那份 plan'
    );
    assert.ok(
      /syncBackend: settings\.syncBackend/.test(args),
      '后端必须是设置里的真值 —— 写死 supabase 会让自带存储用户又看不到那句'
    );
  });

  it('菜单行用 deleteAllMenuWarning 装配副标题', () => {
    assert.ok(
      /deleteAllMenuWarning\(\{[\s\S]{0,120}?lockedCount:\s*[A-Za-z_$][\w$]*,[\s\S]{0,120}?isAuthenticated,[\s\S]{0,120}?syncBackend: settings\.syncBackend,?[\s\S]{0,40}?\}\)/.test(
        source
      ),
      '菜单行副标题必须由 deleteAllMenuWarning 产出，且必须带上锁定会话数'
    );
  });

  it('仓里不再有各写一份的跨设备内联判据', () => {
    assert.ok(
      !/isAuthenticated \? '，其他登录设备将同步删除'/.test(source),
      '确认框不该再自己内联判据'
    );
    assert.ok(
      !/将清空本地全部会话，删除后无法恢复（其他登录设备同步删除）。/.test(source),
      '菜单行不该再无条件写死「其他登录设备同步删除」'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-23 数据安全审计 DS-43-15：确认数字取自 Redux 快照、实际条数从不展示。
//
// 【要防的回归类别】破坏性动作的「承诺」与「执行」读了**两个不同的真值**：
//   · 确认框说 N（Redux 快照）⇒ SW 按**磁盘真值**删 ⇒ 两者可能不等；
//   · SW 回传的实际条数 `{count}` 从来没被展示过 ⇒ 删完**零成功提示**。
//
// 这条守卫钉三件事：
//   ① 确认前读的是**磁盘真值**，且读不到就**中止**（fail closed）；
//   ② 确认框的总数与锁定数出自**同一次读**；
//   ③ 删完必须把**实际条数**说出来。
//
// ⚠️ 判据写成「不钉局部变量名」的形式（只钉纯函数与存储 API 这些**接口锚点**），
//    否则改个等价写法就会误报 —— 那是「守卫钉死字面量」的陷阱。
//    改完之后由 `deleteAllCountTruthMutation.test.ts` 证明它**有检测力**。
// ─────────────────────────────────────────────────────────────────────────────
describe('DS-43-15：确认数字取磁盘真值，删完说出来', () => {
  const source = read(DROPDOWN);

  /** 取出 handleDeleteAllGroups 整个函数的源码（判据只在这个函数里）。 */
  const handlerSource = (): string => {
    const start = source.indexOf('const handleDeleteAllGroups');
    assert.ok(start > 0, '找不到 handleDeleteAllGroups');
    const rest = source.slice(start);
    const end = rest.indexOf('\n  const ', 10);
    return end > 0 ? rest.slice(0, end) : rest;
  };

  it('确认前读磁盘真值（不是 Redux 快照）', () => {
    const handler = handlerSource();
    assert.match(
      handler,
      /storage\.getGroupsForWrite\(\)/,
      '确认框的数字必须来自磁盘真值 —— Redux 快照可能落后于磁盘'
    );
    assert.match(
      handler,
      /planDeleteAll\(/,
      '总数与锁定数必须由同一个判据一次算出（planDeleteAll）'
    );
    assert.ok(
      !/groups\.length/.test(handler),
      '删除动作里不许再直接读 Redux 的 groups.length'
    );
  });

  it('读不到真值就**中止**（fail closed），不许退回快照继续删', () => {
    const handler = handlerSource();
    assert.match(
      handler,
      /catch \(error\) \{[\s\S]{0,600}?DELETE_ALL_READ_FAILED_MESSAGE[\s\S]{0,300}?return;/,
      '读失败必须中止：先报「读不到真实会话」，然后 return（不弹确认框、不执行删除）'
    );
  });

  it('磁盘上没有会话时不弹「删除 0 个」这种自相矛盾的确认框', () => {
    const handler = handlerSource();
    assert.match(handler, /nothingToDelete/, '必须先判「没有可删的」再决定弹不弹框');
    assert.match(handler, /DELETE_ALL_NOTHING_MESSAGE/, '没有可删的要说清楚，而不是弹一个空框');
  });

  it('删完必须把**实际条数**说出来（SW 回执 → 提示）', () => {
    const handler = handlerSource();
    assert.match(
      handler,
      /deletedCountFromResult\(/,
      '必须从 SW 回执里取实际删除条数（不是自己算的数）'
    );
    assert.match(handler, /deleteAllSuccessMessage\(/, '成功提示必须由同一份文案函数产出');
    assert.match(handler, /showToast\(/, '成功提示必须真的弹出来');
  });

  it('菜单行的数字也不再直接用 Redux 快照', () => {
    assert.ok(
      !/删除所有会话（\{groups\.length\}）/.test(source),
      '菜单行的数字必须走磁盘快照（读失败才退回界面现值），不能直接印 Redux 的 length'
    );
  });
});

describe('DS-43-15：判据本身（纯函数，可直接验证行为）', () => {
  it('planDeleteAll：总数与锁定数出自同一份输入', () => {
    const plan = planDeleteAll([{ isLocked: true }, { isLocked: false }, { isLocked: true }]);
    assert.equal(plan.groupCount, 3);
    assert.equal(plan.lockedCount, 2);
    assert.equal(plan.nothingToDelete, false);
  });

  it('planDeleteAll：空列表 ⇒ 没什么可删', () => {
    const plan = planDeleteAll([]);
    assert.equal(plan.groupCount, 0);
    assert.equal(plan.nothingToDelete, true);
  });

  it('deleteAllConfirmTitle：标题里的数与正文同源', () => {
    assert.equal(deleteAllConfirmTitle(5), '删除全部 5 个会话');
  });

  it('deleteAllSuccessMessage：删了几个就说几个', () => {
    assert.equal(
      deleteAllSuccessMessage({ deletedCount: 7, confirmedCount: 7 }),
      '已删除 7 个会话'
    );
  });

  it('deleteAllSuccessMessage：实际比确认的少 ⇒ 必须说明差在哪', () => {
    const message = deleteAllSuccessMessage({ deletedCount: 7, confirmedCount: 8 });
    assert.match(message, /^已删除 7 个会话（/, `必须点出确认时是 8 个：${message}`);
    assert.match(message, /8/, '必须带上确认时的数字');
  });

  it('deleteAllSuccessMessage：一个都没删 ⇒ 不得说「已删除 0 个」', () => {
    const message = deleteAllSuccessMessage({ deletedCount: 0, confirmedCount: 8 });
    assert.ok(
      !message.includes('已删除 0 个'),
      `没删成不能说成「已删除」：${message}`
    );
    assert.match(message, /没有会话被删除/, `必须说清没删成：${message}`);
  });

  it('deletedCountFromResult：回执缺 count 时按 0 处理（不猜）', () => {
    assert.equal(deletedCountFromResult({ value: { count: 3 } }), 3);
    assert.equal(deletedCountFromResult({ value: {} }), 0);
    assert.equal(deletedCountFromResult({}), 0);
    assert.equal(deletedCountFromResult(null), 0);
    assert.equal(deletedCountFromResult({ value: { count: 'x' } }), 0);
  });

  it('中止与「没什么可删」两句文案都存在且说清后果', () => {
    assert.match(DELETE_ALL_READ_FAILED_MESSAGE, /读不到/, '要说清是读不到');
    assert.match(DELETE_ALL_READ_FAILED_MESSAGE, /已取消/, '要说清已经取消了');
    assert.equal(DELETE_ALL_NOTHING_MESSAGE, '没有可删除的会话');
  });
});
