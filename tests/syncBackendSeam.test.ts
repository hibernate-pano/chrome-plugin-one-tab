// 同步后端接缝的真实性守卫（2026-10-13，WebDAV 自带存储 · 阶段 0）。
//
// ── 这个文件存在的理由（不是给现状拍照）─────────────────────────────────
// 改造前仓库里已经有一条看起来很像「可替换后端」的接缝：
//   `tabGroupSyncService.setSyncPort()` / `resetSyncPort()`
// 但 **它们全仓零调用**（2026-10-13 `rg setSyncPort . --hidden -g '!node_modules'`
// 复核：命中只有定义本身与文档提及）。也就是说：那条接缝写了、注释里也写着
// 「为未来多实现预留」，而实际上没有任何东西走过它 —— 它是装饰性的。
//
// 一个装饰性接缝比没有接缝更危险：读代码的人会以为「换后端只要 setSyncPort」，
// 直到真的去换才发现处处是硬编码。所以本文件把「接缝真的通电」钉住：
//
//   1. 注入替身后，**调用方走的是替身**（不是默认实现）；
//   2. 不注入时，默认仍解析为 Supabase（零行为变化）；
//   3. 接缝两侧的**形状映射**正确 —— 特别是 version 与 etag 不得互相冒充。
//
// 变异验证口径（改坏实现它必须变红）：
//   · 把 `getActiveSyncBackend()` 改成恒 `new SupabaseBackendAdapter()`
//     ⇒ 「注入替身后走替身」那条红；
//   · 把 `toDigestLike` 的 `version: f.version` 改回 `Number(f.etag)`
//     ⇒ 「etag 不得冒充 version」那条红（NaN ≠ 7）；
//   · 把 `uploadTabGroups` 的 `result.writtenIds` 改成立即返回 `[]`
//     ⇒ 「writtenTombstoneIds 透传」那条红。
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

if (!process.env.VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

import type { SyncBackendPort } from '@/sync-backend/ports';
import type { TabGroup, UserSettings } from '@/types/tab';
import {
  getActiveSyncBackend,
  setActiveSyncBackend,
  resetActiveSyncBackend,
} from '@/sync-backend';
import {
  downloadTabGroups,
  downloadTabGroupsDigest,
  uploadTabGroups,
  markCloudGroupsAsDeleted,
  purgeExpiredCloudTombstones,
} from '@/services/tabGroupSyncService';
import { uploadSettings, downloadSettings } from '@/services/settingsSyncService';

/** 记录调用的替身后端。每个方法都留下可断言的痕迹。 */
function makeFakeBackend() {
  const calls: string[] = [];
  const fake: SyncBackendPort = {
    id: 'webdav',
    label: '测试替身',
    async fetchFingerprints() {
      calls.push('fetchFingerprints');
      return [
        {
          id: 'g-1',
          updatedAt: '2026-10-13T00:00:00.000Z',
          // 故意给一个**非数字** ETag：真实 WebDAV 的 ETag 就长这样。
          // 任何把 etag 硬转成 version 的实现都会在这里变成 NaN。
          etag: '"a1b2c3"',
          version: 7,
          isDeleted: false,
          lastOp: { d: 'dev-1', s: 42 },
        },
      ];
    },
    async downloadGroups() {
      calls.push('downloadGroups');
      return [{ id: 'g-1', name: '来自替身', tabs: [], createdAt: '', updatedAt: '', isLocked: false }];
    },
    async uploadGroups(groups, opts) {
      calls.push(`uploadGroups:${groups.length}:${opts?.overwriteRemote === true}`);
      return { writtenIds: ['tomb-a', 'tomb-b'], overwroteRemote: opts?.overwriteRemote === true };
    },
    async broadcastDeletes(ids) {
      calls.push(`broadcastDeletes:${ids.join(',')}`);
    },
    async purgeExpiredDeletes(maxAgeDays) {
      calls.push(`purgeExpiredDeletes:${maxAgeDays}`);
      return 3;
    },
    async uploadSettings(settings) {
      calls.push(`uploadSettings:${settings.themeMode}`);
    },
    async downloadSettings() {
      calls.push('downloadSettings');
      return { themeMode: '来自替身' };
    },
  };
  return { fake, calls };
}

// 2026-10-20 审计 A-9：`groupNameTemplate` 已随其它死设置一起退役，
// 拿它当样本会让本文件跟着编译不过。换成**还活着**的 `themeMode`
// （非设备级 ⇒ 会原样穿过 toCloudSettings，替身收到的就是它自己）。
const SETTINGS = { themeMode: 'dark' } as unknown as UserSettings;
const GROUP = {
  id: 'g-1',
  name: 'n',
  tabs: [],
  createdAt: '',
  updatedAt: '',
  isLocked: false,
} as TabGroup;

describe('同步后端接缝：注入替身后真的走替身', () => {
  beforeEach(() => resetActiveSyncBackend());
  afterEach(() => resetActiveSyncBackend());

  it('downloadGroups 走替身', async () => {
    const { fake, calls } = makeFakeBackend();
    setActiveSyncBackend(fake);
    const groups = await downloadTabGroups();
    assert.equal(groups[0]?.name, '来自替身');
    assert.deepEqual(calls, ['downloadGroups']);
  });

  it('uploadGroups 走替身，且 overwrite 参数被如实传递（true 与 false 都要测）', async () => {
    const { fake, calls } = makeFakeBackend();
    setActiveSyncBackend(fake);

    await uploadTabGroups([GROUP], false);
    await uploadTabGroups([GROUP], true);

    // 两个方向都断言：只测 true 的话，把参数写死成 true 的实现也能过。
    assert.deepEqual(calls, ['uploadGroups:1:false', 'uploadGroups:1:true']);
  });

  it('writtenIds 透传成 writtenTombstoneIds（改名不能改名丢语义）', async () => {
    const { fake } = makeFakeBackend();
    setActiveSyncBackend(fake);
    const up = await uploadTabGroups([GROUP], true);
    // 这个字段是 syncEngine 避免「同一 id 被二次写墓碑」的依据。
    // 返回空数组会让那段防护失效并触发重复 UPDATE（见 syncEngine.upload 注释）。
    assert.deepEqual(up.writtenTombstoneIds, ['tomb-a', 'tomb-b']);
  });

  it('broadcastDeletes / purgeExpiredDeletes / settings 都走替身', async () => {
    const { fake, calls } = makeFakeBackend();
    setActiveSyncBackend(fake);

    await markCloudGroupsAsDeleted(['x', 'y']);
    const purged = await purgeExpiredCloudTombstones();
    await uploadSettings(SETTINGS);
    const s = await downloadSettings();

    assert.equal(purged, 3);
    assert.equal(s?.themeMode, '来自替身');
    assert.deepEqual(calls, [
      'broadcastDeletes:x,y',
      // 不传参时必须落到默认 30 天（不是 undefined、不是 0）
      'purgeExpiredDeletes:30',
      'uploadSettings:dark',
      'downloadSettings',
    ]);
  });
});

describe('同步后端接缝：形状映射不得失真', () => {
  beforeEach(() => resetActiveSyncBackend());
  afterEach(() => resetActiveSyncBackend());

  it('etag 不得冒充 version（WebDAV 的 ETag 是非数字字符串）', async () => {
    const { fake } = makeFakeBackend();
    setActiveSyncBackend(fake);
    const digest = await downloadTabGroupsDigest();
    const row = digest[0];

    // version 必须是后端给的 7，而不是 Number('"a1b2c3"') = NaN。
    // 消费方 hasRemoteChanges 用 `(row.version ?? 1) !== (local.version ?? 1)`
    // 做判定：NaN 会让它恒判「有变更」，探活短路永久失效。
    assert.equal(row?.version, 7);
    assert.ok(!Number.isNaN(row?.version), 'version 不得是 NaN');
  });

  it('updatedAt 原样保留（探活的时间戳信号依赖它）', async () => {
    const { fake } = makeFakeBackend();
    setActiveSyncBackend(fake);
    const digest = await downloadTabGroupsDigest();
    assert.equal(digest[0]?.updated_at, '2026-10-13T00:00:00.000Z');
  });

  it('lastOp 与 isDeleted 逐字段映射（不是只映射 id）', async () => {
    const { fake } = makeFakeBackend();
    setActiveSyncBackend(fake);
    const digest = await downloadTabGroupsDigest();
    const row = digest[0];
    assert.equal(row?.last_op_device, 'dev-1');
    assert.equal(row?.last_op_seq, 42);
    assert.equal(row?.is_deleted, false);
  });
});

describe('同步后端接缝：默认解析仍是 Supabase（阶段 0 零行为变化）', () => {
  beforeEach(() => resetActiveSyncBackend());
  afterEach(() => resetActiveSyncBackend());

  it('不注入时解析为 supabase，而不是别的什么', () => {
    assert.equal(getActiveSyncBackend().id, 'supabase');
  });

  it('reset 之后回到 supabase（测试之间不串味）', () => {
    const { fake } = makeFakeBackend();
    setActiveSyncBackend(fake);
    assert.equal(getActiveSyncBackend().id, 'webdav');
    resetActiveSyncBackend();
    assert.equal(getActiveSyncBackend().id, 'supabase');
  });
});

