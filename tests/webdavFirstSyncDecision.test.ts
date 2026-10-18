/**
 * 首次配置 WebDAV 的数据归属决策测试（2026-10-15）。
 *
 * 这张表决定了「用户配完 WebDAV 之后，本地数据会不会被推上云」，
 * 而在无回收站的模型下，选错就是不可逆的数据丢失，所以必须钉死。
 *
 * 变异验证口径（改坏实现必须变红）：
 *   · 把 unreachable 改成 upload-all ⇒ 「探测失败绝不默认上传」红
 *   · 把 has-data 也改成 upload-all ⇒ 「远端有数据必须问用户」红
 *   · 把 previewOutcome 的 merge 换成 local-wins ⇒ 「合并预览数字」红
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  countActive,
  classifyRemoteShape,
  decideFirstSync,
  isFirstPushBusy,
  previewOutcome,
} from '@/sync-backend/webdav/firstSyncDecision';
import type { TabGroup } from '@/types/tab';

const NOW = '2026-10-15T10:00:00.000Z';
const mk = (id: string, name: string, over: Partial<TabGroup> = {}): TabGroup => ({
  id,
  name,
  createdAt: NOW,
  updatedAt: NOW,
  isLocked: false,
  lastOp: { d: 'dev-A', s: 5 },
  tabs: [
    { id: `${id}-t`, url: `https://example.com/${id}`, title: name, createdAt: NOW, lastAccessed: NOW, pinned: false },
  ],
  ...over,
});

describe('首次配置：远端状态 → 该做什么', () => {
  it('远端为空 ⇒ 直接全量上传（不打扰用户）', () => {
    const d = decideFirstSync({ localGroups: [mk('a', 'A'), mk('b', 'B')], remoteGroups: [] });
    assert.deepEqual(d, { action: 'upload-all' });
  });

  it('远端只有墓碑 ⇒ **不得**当空（2026-10-18 P1#3 反转）', () => {
    // 旧断言是「视为空 ⇒ upload-all」。它是**错的**，而且方向错得很严重：
    // 墓碑是「另一台设备删除了这些会话」的意图。当成空 → upload-all →
    // 本地那些已被删除的旧会话被重新上传 → **跨设备删除被撤销、会话复活**。
    //
    // 更要命的是它与 B3 直接矛盾：B3 刚在 syncEngine 定下「只有墓碑 ≠ 云端为空」
    // （空云端闸门正是为此而生），B7 却用 countActive 把它合了回去。
    // 同一件事在两个模块里得到相反结论 —— 现在按 B3 的口径统一。
    const tombstone = mk('x', '', { isDeleted: true, tabs: [] });
    const d = decideFirstSync({ localGroups: [mk('a', 'A')], remoteGroups: [tombstone] });
    assert.equal(
      d.action,
      'tombstones-only',
      '远端只有墓碑时必须停下来问用户，不能替他决定上传'
    );
    if (d.action !== 'tombstones-only') throw new Error('unreachable');
    assert.equal(d.tombstoneCount, 1, '必须告诉用户有几条删除记录');
    assert.equal(d.localCount, 1);
  });

  it('三态互斥：no-rows / only-tombstones / has-active', () => {
    const t = mk('x', '', { isDeleted: true, tabs: [] });
    const a = mk('a', 'A');

    // 前置：确认 classifyRemoteShape 真的在区分三者（否则下面的断言会因
    // 「全都返回同一个值」而恒真）。
    assert.equal(classifyRemoteShape([]), 'no-rows');
    assert.equal(classifyRemoteShape([t]), 'only-tombstones');
    assert.equal(classifyRemoteShape([t, a]), 'has-active');

    assert.equal(decideFirstSync({ localGroups: [a], remoteGroups: [] }).action, 'upload-all');
    assert.equal(decideFirstSync({ localGroups: [a], remoteGroups: [t] }).action, 'tombstones-only');
    assert.equal(decideFirstSync({ localGroups: [a], remoteGroups: [t, a] }).action, 'ask-user');
  });

  it('本地为空时优先级不变（没有东西要归属）', () => {
    // 本机 0 个会话时无论远端是什么形态都无事可做 ——
    // 墓碑那一态是「你要不要撤销删除」，前提是你手上确实有那些会话。
    const t = mk('x', '', { isDeleted: true, tabs: [] });
    assert.deepEqual(decideFirstSync({ localGroups: [], remoteGroups: [t] }), {
      action: 'nothing-to-do',
    });
  });

  it('远端有数据 ⇒ 必须让用户显式选择，不得自动上传', () => {
    const d = decideFirstSync({ localGroups: [mk('a', 'A')], remoteGroups: [mk('x', 'X')] });
    assert.equal(d.action, 'ask-user');
    if (d.action !== 'ask-user') throw new Error('unreachable');
    assert.equal(d.localCount, 1);
    assert.equal(d.remoteCount, 1);
  });

  it('本地也没有数据 ⇒ 无事可做（且不能谎报成功）', () => {
    const d = decideFirstSync({ localGroups: [], remoteGroups: [] });
    assert.deepEqual(d, { action: 'nothing-to-do' });
  });

  it('⚠️ 探测失败 ⇒ 必须 blocked，绝不默认上传', () => {
    // 这是最危险的一条：探测失败时默认上传，等于在「用户配了个有数据的云盘、
    // 但这次网络不通」的情况下直接覆盖掉那些数据。
    const d = decideFirstSync({ localGroups: [mk('a', 'A'), mk('b', 'B')], remoteGroups: null });
    assert.equal(d.action, 'blocked');
    if (d.action !== 'blocked') throw new Error('unreachable');
    assert.match(d.reason, /覆盖/);
  });

  it('墓碑不计入活跃数', () => {
    assert.equal(countActive([mk('a', 'A'), mk('b', '', { isDeleted: true, tabs: [] })]), 1);
  });
});

describe('三种归属方式的后果预览', () => {
  const local = [mk('loc-1', 'A'), mk('loc-2', 'B'), mk('loc-3', 'C')];
  const remote = [mk('cl-1', 'X'), mk('cl-2', 'Y')];

  it('合并 ⇒ 两边都在（不同 id 一个不丢）', () => {
    const p = previewOutcome(local, remote, 'merge');
    assert.equal(p.localCount, 5);
    assert.equal(p.cloudCount, 5);
    assert.equal(p.warning, undefined, '合并不该有破坏性警告');
  });

  it('以本地为准 ⇒ 云端被替换，必须带不可恢复警告', () => {
    const p = previewOutcome(local, remote, 'local-wins');
    assert.equal(p.cloudCount, 3);
    assert.match(p.warning!, /无法恢复/);
    assert.match(p.warning!, /2/); // 明确说出会丢几个
  });

  it('以云端为准 ⇒ 本地被替换，必须带不可恢复警告', () => {
    const p = previewOutcome(local, remote, 'cloud-wins');
    assert.equal(p.localCount, 2);
    assert.match(p.warning!, /无法恢复/);
    assert.match(p.warning!, /3/);
  });

  it('⚠️ 三个选项的数字必须互不相同（否则用户无法判断差别）', () => {
    const m = previewOutcome(local, remote, 'merge');
    const l = previewOutcome(local, remote, 'local-wins');
    const c = previewOutcome(local, remote, 'cloud-wins');
    assert.notEqual(m.cloudCount, l.cloudCount);
    assert.notEqual(l.cloudCount, c.cloudCount);
    assert.notEqual(m.localCount, c.localCount);
  });
});

// ── 2026-10-16 审查 L5：入口按钮忙态判据 ──────────────────────────────

describe('isFirstPushBusy：入口按钮禁用判据', () => {
  it('探测 / 推送 / 下载中 ⇒ 忙（入口按钮必须禁用，防重入）', () => {
    assert.equal(isFirstPushBusy('probing'), true);
    assert.equal(isFirstPushBusy('pushing'), true);
    assert.equal(isFirstPushBusy('pulling'), true);
  });

  it('⚠️ choose 不算忙：它停在「等用户选归属」，选之前没有在途任务', () => {
    // 把 choose 也判成忙会让三个选择按钮永远点不动 —— 那是比连点更严重的
    // 功能阻断（用户被锁死在选择面板里，没有任何出路）。
    assert.equal(isFirstPushBusy('choose'), false);
  });

  it('其余稳态（idle/done/nothing-local/blocked）都不忙', () => {
    assert.equal(isFirstPushBusy('idle'), false);
    assert.equal(isFirstPushBusy('done'), false);
    assert.equal(isFirstPushBusy('nothing-local'), false);
    assert.equal(isFirstPushBusy('blocked'), false);
  });
});
