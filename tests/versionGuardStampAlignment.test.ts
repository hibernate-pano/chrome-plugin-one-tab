// 客户端侧的三条判据：读回（被取代 vs 被吞写）、上传水位、认输预检。
//
// ── 背景（2026-10-20 P0）────────────────────────────────────────────────────
// 云端同时存在两套裁决规则（version 与印记全序），更晚保存的一方会被
// version 守卫静默吞写。客户端这边有**三处**配套判据，旧版本全都按
// version 判，于是把「被吞写」误判成「被更新一侧合法取代」：
//
//   ① readback.isSupersededByCloud —— 旧判据 `row.version > expect.version`
//   ② upload.nextSyncWatermark —— 水位取自 uploadRows（**包含**被取代的组）
//   ③ upload 的认输预检 —— 唯一认输理由是「云端是更新的墓碑」（不看 version ✓）
//
// 后果链：吞写 → 读回误判「被取代」→ 上传报成功 → pending_upload 被清 →
// 水位抬过那一组 → **那一组的上行通道被永久关闭**，那次编辑在两台设备上
// 都永久丢失。修法：**印记是唯一裁决源**，version 退化成「无印记时的兜底」。
//
// 本文件是纯函数用例（不需要真库）；真库行为在
// tests/versionGuardOpStamp.pg.test.ts。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSupersededByCloud,
  isSwallowedByOlderCloudStamp,
  compareUploadReadback,
} from '../src/utils/supabase/readback.ts';
import { nextSyncWatermark, shouldConcedeGroup } from '../src/utils/supabase/upload.ts';
import type { TabGroup } from '../src/types/tab.ts';

const NOW = '2026-10-20T08:00:00.000Z';

/** 本地这一份：B 离线期间改了 1 次，印记更大 = 更晚保存。 */
const LOCAL_STAMP = { d: 'devB', s: 5001 };
/** 云端那一行：A 改了 3 次，version 更高但印记更旧。 */
const CLOUD_STAMP = { d: 'devA', s: 5000 };

const localGroup = (over: Partial<TabGroup> = {}): TabGroup =>
  ({
    id: 'g1',
    name: 'g1',
    tabs: [],
    lastOp: LOCAL_STAMP,
    version: 2,
    ...over,
  }) as TabGroup;

describe('读回判据：印记是唯一裁决源（version 只在无印记时兜底）', () => {
  it('云端 version 更大但印记更小 ⇒ 不算「被取代」（那是吞写，必须报错）', () => {
    const expect = { id: 'g1', updatedAt: NOW, version: 2, lastOp: LOCAL_STAMP };
    const row = {
      id: 'g1',
      updated_at: NOW,
      version: 4,
      last_op_device: CLOUD_STAMP.d,
      last_op_seq: CLOUD_STAMP.s,
    };
    assert.equal(
      isSupersededByCloud(expect, row),
      false,
      '❌ 回归：云端 version 更大就把「本该赢的那次写入」判成被取代 → 上传报成功 → 静默丢数据'
    );
    assert.equal(
      isSwallowedByOlderCloudStamp(expect, row),
      true,
      '云端印记更旧 ⇒ 本次写入本该赢却没赢上 = 被静默吞写'
    );
  });

  it('云端印记严格更新 ⇒ 算「被取代」（按设计输，不是故障）', () => {
    const expect = { id: 'g1', updatedAt: NOW, version: 2, lastOp: LOCAL_STAMP };
    const row = {
      id: 'g1',
      updated_at: NOW,
      // 云端 version 反而更小 —— 旧判据会因此判「没被取代」→ 读回失败 →
      // 整台设备的上传永久卡死（连带下载被跳过）。新判据只看印记。
      version: 1,
      last_op_device: 'devC',
      last_op_seq: 6000,
    };
    assert.equal(isSupersededByCloud(expect, row), true, '云端印记更新 ⇒ 本次写入按合并语义输掉');
    assert.equal(isSwallowedByOlderCloudStamp(expect, row), false);
  });

  it('两侧印记相同 ⇒ 不算被取代（写已落盘）', () => {
    const expect = { id: 'g1', updatedAt: NOW, version: 2, lastOp: LOCAL_STAMP };
    const row = {
      id: 'g1',
      updated_at: NOW,
      version: 9,
      last_op_device: LOCAL_STAMP.d,
      last_op_seq: LOCAL_STAMP.s,
    };
    assert.equal(isSupersededByCloud(expect, row), false);
    assert.equal(isSwallowedByOlderCloudStamp(expect, row), false);
  });

  it('一侧无印记 ⇒ 退回 version 单判据（老客户端 / 未迁移 schema）', () => {
    // 本地无印记：服务端此时本来就只按 version 裁决
    assert.equal(
      isSupersededByCloud({ id: 'g1', version: 3 }, { id: 'g1', updated_at: NOW, version: 4 }),
      true
    );
    // 云端无印记：同理退回 version
    assert.equal(
      isSupersededByCloud(
        { id: 'g1', version: 3, lastOp: LOCAL_STAMP },
        { id: 'g1', updated_at: NOW, version: 4 }
      ),
      true
    );
    // 两侧都无 version ⇒ 一律不判
    assert.equal(
      isSupersededByCloud({ id: 'g1', version: null }, { id: 'g1', updated_at: NOW, version: 9 }),
      false
    );
  });

  it('compareUploadReadback：被吞写必须判失败（绝不许报成功）', () => {
    const r = compareUploadReadback(
      [{ id: 'g1', updatedAt: NOW, version: 2, lastOp: LOCAL_STAMP }],
      [
        {
          id: 'g1',
          updated_at: NOW,
          version: 4,
          last_op_device: CLOUD_STAMP.d,
          last_op_seq: CLOUD_STAMP.s,
          is_deleted: false,
        },
      ],
      { checkStamp: true, checkTombstone: true }
    );
    assert.equal(r.ok, false, '❌ 回归：吞写被判成功 → pending_upload 被清 → 那次编辑永久丢失');
    assert.match(String(r.reason), /吞写/, `失败原因必须点明「被吞写」，实际: ${r.reason}`);
    assert.deepEqual(r.superseded, undefined, '被吞写的组不得进「被取代」名单');
  });

  it('compareUploadReadback：云端印记更新 ⇒ 判为被取代、整体 ok（不把设备卡死）', () => {
    const r = compareUploadReadback(
      [{ id: 'g1', updatedAt: NOW, version: 2, lastOp: LOCAL_STAMP }],
      [
        {
          id: 'g1',
          updated_at: NOW,
          version: 1,
          last_op_device: 'devC',
          last_op_seq: 6000,
          is_deleted: false,
        },
      ],
      { checkStamp: true, checkTombstone: true }
    );
    assert.equal(r.ok, true, '云端更新时本次写入输掉竞争属预期，不算失败');
    assert.deepEqual(r.superseded, ['g1']);
  });
});

describe('上传水位：本次没写上云的组不得计入（否则上行通道被永久关闭）', () => {
  const rows = [
    { id: 'a', lastOp: { d: 'dev', s: 10 } },
    { id: 'b', lastOp: { d: 'dev', s: 5001 } },
    { id: 'c', lastOp: { d: 'dev', s: 7 } },
  ] as unknown as TabGroup[];

  it('被吞写/被取代的组不抬水位', () => {
    const wm = nextSyncWatermark(rows, 5, new Set(['b']));
    assert.equal(
      wm,
      10,
      '❌ 回归：把「本次没写上云」的组算进水位 = 宣布「它已同步」= 那一组从此再不上行'
    );
  });

  it('两参调用保持原语义（向后兼容：没传排除集时取上行集合的 max）', () => {
    assert.equal(nextSyncWatermark(rows, 5), 5001);
  });

  it('水位只降不升：排除后必须仍不低于上一个水位', () => {
    assert.equal(nextSyncWatermark(rows, 9000, new Set(['b'])), 9000);
  });
});

describe('认输预检：version 不参与裁决（活跃 vs 活跃由印记说话）', () => {
  it('本地印记更大时，即使云端 version 更大也不认输', () => {
    const cloud = {
      id: 'g1',
      updated_at: NOW,
      is_deleted: false,
      last_op_device: CLOUD_STAMP.d,
      last_op_seq: CLOUD_STAMP.s,
      version: 4,
    };
    assert.equal(
      shouldConcedeGroup(localGroup(), cloud),
      false,
      '❌ 回归：本地印记更新（更晚保存）却因为云端 version 更大而认输 = 让更晚保存的一方输'
    );
  });

  it('云端是更新的墓碑 ⇒ 认输（合并语义：本地组服从删除）', () => {
    const cloud = {
      id: 'g1',
      updated_at: NOW,
      is_deleted: true,
      last_op_device: 'devC',
      last_op_seq: 6000,
      version: 1,
    };
    assert.equal(shouldConcedeGroup(localGroup(), cloud), true);
  });

  it('云端是活跃行且印记更新 ⇒ 不在预检阶段认输（交给读回判「被取代」）', () => {
    const cloud = {
      id: 'g1',
      updated_at: NOW,
      is_deleted: false,
      last_op_device: 'devC',
      last_op_seq: 6000,
      version: 9,
    };
    assert.equal(shouldConcedeGroup(localGroup(), cloud), false);
  });
});

// ── DS-3（2026-10-24 审计）：云端墓碑**无条件**压过本地活跃副本 ─────────────
//
// 旧语义是「本地印记严格更新 ⇒ 绝不认输」，那让删除可以被另一台设备的离线
// 编辑撤销（两台设备的计数器互相独立，比大小等于掷硬币）。
// 现在：墓碑优先。version 在这个方向上**更加**不参与（version 是每设备本地
// 计数器，跨设备不可比）。
describe('认输预检：云端墓碑一律压过本地活跃副本（DS-3）', () => {
  it('本地印记比云端墓碑更新 ⇒ 仍然认输（删除优先）', () => {
    const cloud = {
      id: 'g1',
      updated_at: NOW,
      is_deleted: true,
      last_op_device: 'devA',
      last_op_seq: 100,
      version: 99,
    };
    assert.equal(
      shouldConcedeGroup(localGroup({ lastOp: { d: 'devB', s: 5001 } }), cloud),
      true,
      '❌ 回归：本地印记更大就把云端墓碑顶掉 = 删除被静默撤销（DS-3）'
    );
  });

  it('本地印记比云端墓碑旧 ⇒ 认输', () => {
    const cloud = {
      id: 'g1',
      updated_at: NOW,
      is_deleted: true,
      last_op_device: 'devA',
      last_op_seq: 5000,
      version: 1,
    };
    assert.equal(shouldConcedeGroup(localGroup({ lastOp: { d: 'devB', s: 4999 } }), cloud), true);
  });

  it('云端墓碑**没有印记**时也认输（守卫会放行写入 ⇒ 不认输就等于把墓碑覆盖掉）', () => {
    const cloud = {
      id: 'g1',
      updated_at: NOW,
      is_deleted: true,
      last_op_device: null,
      last_op_seq: null,
      version: 1,
    };
    assert.equal(
      shouldConcedeGroup(localGroup(), cloud),
      true,
      '❌ 回归：云端墓碑无印记时服务端 guard_tab_group_op_stamp 判「无从裁决」会放行写入 ⇒ 不认输就等于把墓碑覆盖掉'
    );
  });
});
