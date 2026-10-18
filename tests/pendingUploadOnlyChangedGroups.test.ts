// WebDAV「归属待决」期只上传本次操作改动过的会话（2026-10-18 round 30）。
//
// 背景：`webdav_first_sync_pending` 期间自动上传必须只传本次改动，而适配器降级后
// 用的判据是 `selectDirty(groups, 水位)` —— 远端还没有 manifest 时水位恒为 0，
// 全部历史会话都被判成脏 ⇒ 抑制前后上传内容逐字相同（死代码，2026-10-18 实测）。
// 判据改成写方一路记下来的 id：保存路径知道它刚写了哪个组，mutation 命令本身
// 也带着受影响的 id（core/mutationAffectedGroups）。
//
// 真机复现见 /tmp/one-tab-loop/verify-round30.mjs（dufs 独立 WebDAV + 全新远端）。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { TabGroup } from '@/types/tab';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

before(async () => {
  register(LOADER_PATH);
});

const read = (rel: string) =>
  readFile(resolve(dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8');

const g = (id: string) => ({ id, name: id, tabs: [], createdAt: '', updatedAt: '', version: 1, isLocked: false }) as unknown as TabGroup;

describe('affectedGroupIdsOf：命令 → 受影响的会话 id', () => {
  it('覆盖全部 9 种命令，且不靠 stamp / 水位去猜', async () => {
    const { affectedGroupIdsOf } = await import('@/core/mutationAffectedGroups');
    assert.deepEqual(affectedGroupIdsOf({ op: 'saveGroup', group: g('new') }), ['new']);
    assert.deepEqual(affectedGroupIdsOf({ op: 'removeTab', groupId: 'a', tabId: 't' }), ['a']);
    assert.deepEqual(affectedGroupIdsOf({ op: 'deleteGroup', groupId: 'a' }), ['a']);
    assert.deepEqual(affectedGroupIdsOf({ op: 'renameGroup', groupId: 'a', name: 'n' }), ['a']);
    assert.deepEqual(affectedGroupIdsOf({ op: 'toggleGroupLock', groupId: 'a' }), ['a']);
    assert.deepEqual(
      affectedGroupIdsOf({ op: 'importGroups', groups: [g('i1'), g('i2')] }),
      ['i1', 'i2']
    );
    assert.deepEqual(
      affectedGroupIdsOf({
        op: 'moveTab', sourceGroupId: 's', sourceIndex: 0, targetGroupId: 't', targetIndex: 0,
      }),
      ['s', 't'],
      '搬动的两端都算改动（源组少一条、目标组多一条）'
    );
  });

  it('deleteAllGroups / cleanDuplicates 返回空集（fail-closed，不会顺带把历史全传上去）', async () => {
    const { affectedGroupIdsOf } = await import('@/core/mutationAffectedGroups');
    assert.deepEqual(affectedGroupIdsOf({ op: 'deleteAllGroups' }), []);
    assert.deepEqual(affectedGroupIdsOf({ op: 'cleanDuplicates' }), []);
  });
});

describe('写方把 id 一路传下来（保存路径 + mutation）', () => {
  it('保存路径登记新会话 id（两处调用点都传）', async () => {
    const src = await read('src/background/TabManager.ts');
    const calls = src.match(/syncEngine\.scheduleUpload\(UPLOAD_DEBOUNCE_MS[^)]*\)/g) ?? [];
    assert.equal(calls.length, 2, '保存当前窗口 / 保存当前标签两条路径都要传');
    for (const c of calls) assert.match(c, /\[safeGroup\.id\]/, `必须传改动 id：${c}`);
  });

  it('mutationHandlers 一处提取、所有分支都走它（含 deps 包装转发）', async () => {
    const src = await read('src/background/mutationHandlers.ts');
    assert.match(src, /const changedIds = affectedGroupIdsOf\(cmd\)/, '必须一处提取');
    assert.match(src, /const scheduleUpload = \(\s*delayMs: number,\s*ids: readonly string\[\] = changedIds/,
      '分支必须走带默认值的局部包装');
    const bare = src.match(/(?<!\.)\bd\.scheduleUpload\(/g) ?? [];
    assert.equal(bare.length, 1, '只许局部包装那一处直连 d.scheduleUpload（分支绕过去会丢掉改动集）');
    assert.match(src, /d\.scheduleUpload\(delayMs, ids\)/, '那一处必须把 ids 转发下去');
    assert.match(src, /deps\.scheduleUpload\(ms, ids\)/, 'deps 包装必须转发 ids，不能吞掉');
  });

  it('cleanDuplicates 用计划里的 id 显式覆盖（命令里没有 id 可提取）', async () => {
    const src = await read('src/background/mutationHandlers.ts');
    assert.match(src, /removedTabsByGroup\.map\(e => e\.groupId\)/,
      '改动集必须取自删除计划');
  });

  it('mutationService 把 id 透传给 syncEngine', async () => {
    const src = await read('src/background/mutationService.ts');
    assert.match(src, /scheduleUpload: \(ms, changedGroupIds\) => syncEngine\.scheduleUpload\(ms, changedGroupIds\)/);
  });
});

describe('syncEngine：待决期按 id 过滤，且 fail-closed', () => {
  it('抑制生效时用记下来的 id 过滤，而不是交给适配器按水位猜', async () => {
    const src = await read('src/services/syncEngine.ts');
    assert.match(src, /const suppressFullUpload =\s*\n?\s*firstSyncPending && !explicitFirstSync && !overwriteCloud/);
    assert.match(src, /new Set\(await storage\.getPendingUploadGroupIds\(\)\)/);
    assert.match(src, /activeGroups\.filter\(g => changedGroupIds\.has\(g\.id\)\)/);
    assert.match(src, /uploadTabGroups\(\s*groupsForUpload,/, '上传的必须是过滤后的清单');
  });

  it('白名单与 pending_upload 一起落盘，且快路径等它写完再上传', async () => {
    const src = await read('src/services/syncEngine.ts');
    assert.match(src, /storage\.noteGroupsChanged\(changedGroupIds\)/);
    const fast = src.match(/void noted\s*\n?\s*\.then\(\(\) => enqueue\('sync:upload'/g) ?? [];
    assert.equal(fast.length, 2, '快路径与 fallback 都要等 noted（否则可能读到没写全的白名单）');
  });

  it('上传成功后清白名单；进入/离开待决态时也清（防陈旧 id 把历史会话带上去）', async () => {
    const engine = await read('src/services/syncEngine.ts');
    assert.match(engine, /await storage\.clearPendingUploadGroupIds\(\)/);
    const storageSrc = await read('src/utils/storage.ts');
    const fn = storageSrc.slice(storageSrc.indexOf('async setFirstSyncPending'));
    assert.match(
      fn.slice(0, 900),
      /await this\.clearPendingUploadGroupIds\(\);/,
      'setFirstSyncPending 两个方向都要清：进待决态时清掉此前攒下的「历史」id，' +
        '否则刚切到 WebDAV 的那次自动上传照样会把历史会话推上去（抑制再次成为死代码）'
    );
  });

  it('抑制只对自带存储生效（残留标志不许把云端上传也按白名单过滤）', async () => {
    const src = await read('src/services/syncEngine.ts');
    assert.match(src, /configuredBackendId === 'webdav'/, '必须显式判后端');
  });

  it('切到自带存储时，待决标志必须排在 resyncAlarm 之前落盘', async () => {
    const src = await read('src/components/sync/WebDavSettings.tsx');
    const flag = src.indexOf('await storage.setFirstSyncPending(true)');
    const resync = src.indexOf("await sendSyncCommand('resyncAlarm')");
    assert.ok(flag > 0 && resync > 0, '两处都要在');
    assert.ok(
      flag < resync,
      'resyncAlarm 会让 SW 立刻补一次上传；标志若还没落盘，那次上传就是无抑制的全量 ' +
        '⇒ 刚切到自带存储、历史会话已经上了云盘（round 30 真机抓到）'
    );
  });

  it('读不到白名单就返回空集（fail-closed：待决期宁可不传，也不多传）', async () => {
    const storageSrc = await read('src/utils/storage.ts');
    const fn = storageSrc.slice(
      storageSrc.indexOf('async getPendingUploadGroupIds'),
      storageSrc.indexOf('async noteGroupsChanged')
    );
    assert.match(fn, /catch \{[\s\S]{0,80}return \[\];/, '读失败必须返回空数组');
    assert.match(fn, /if \(!Array\.isArray\(raw\)\) return \[\];/, '非数组一律当空');
  });
});
