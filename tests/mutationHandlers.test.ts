// 钉死 SW 端语义命令执行器的编排契约（无墓碑模型，2026-09-29）：
// 1) removeTab 物理移除 tab，写回 storage 且按删除优先级 1500ms 调度上传；
// 2) removeTab 拿空整组 → payload.group = null、组被物理移除、id 登记删除广播队列；
// 3) apply 层抛错被 handle 包装为 ok:false + error 文本；
// 4) 未知 op 返回 ok:false。
//
// 文件头部样板与 tests/mutationQueue.test.ts / tests/mutationProtocol.test.ts 一致：
// @/ 别名的模块只能在 register(loader) 之后【动态 import】（静态 import 会被
// 提升、先于 loader 注册而失败）。本文件的每个 it 内用 await import('@/...')。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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

const NOW = '2026-01-01T00:00:00.000Z';

function mkTab(id: string) {
  return { id, url: `https://${id}.com`, title: id, favicon: '', createdAt: NOW, lastAccessed: NOW, pinned: false };
}

function memStorage() {
  let groups: import('@/types/tab').TabGroup[] = [];
  const uploads: number[] = [];
  // journal + seq 极简 mock：seq 单调递增、journal 内存追加，stamp 来源于此。
  const entries: any[] = [];
  let seqN = 0;
  return {
    uploads,
    now: () => NOW,
    async getGroups(): Promise<import('@/types/tab').TabGroup[]> {
      return [...groups];
    },
    async setGroups(g: import('@/types/tab').TabGroup[]): Promise<void> {
      groups = [...g];
    },
    scheduleUpload(ms: number): void {
      uploads.push(ms);
    },
    journal: {
      async appendEntry(p: any) {
        seqN += 1;
        const e = { d: 'devTest', s: seqN, ts: NOW, ...p };
        entries.push(e);
        return e;
      },
      async read() { return entries; },
      async markConfirmedUpTo() { return 0; },
    },
    seq: {
      async nextSeq() { return ++seqN; },
      async getDeviceSeq() { return seqN; },
      async bumpSeqIfLower(c: number) { return c > seqN ? (seqN = c) : seqN; },
    },
    // 无墓碑模型：物理删除的组 id 登记删除广播队列（云端行由 upload 侧
    // markCloudGroupsAsDeleted 标记 is_deleted，对端合并时服从删除）。
    deletedIds: [] as string[],
    async noteGroupDeleted(ids: readonly string[]) { (this as any).deletedIds.push(...ids); },
  };
}

describe('mutationHandlers: 编排（读→apply→写→调度上传）', () => {
  it('removeTab：物理移除 tab 写回 storage，并按删除优先级 1500ms 调度上传', async () => {
    const { createMutationHandlers } = await import('@/background/mutationHandlers');
    const deps = memStorage();
    const handlers = createMutationHandlers(deps as any);
    const g = {
      id: 'g1',
      name: 'g',
      tabs: [mkTab('t1'), mkTab('t2')],
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
      isLocked: false,
    } as import('@/types/tab').TabGroup;
    await deps.setGroups([g]);
    const res = await handlers.handle({ op: 'removeTab', groupId: 'g1', tabId: 't1' });
    assert.equal(res.ok, true);
    assert.deepEqual(deps.uploads, [1500]);
    const stored = await deps.getGroups();
    assert.equal(stored[0].tabs.some(t => t.id === 't1'), false, '被删 tab 物理移除');
    assert.equal(stored[0].tabs.length, 1, '其余 tab 保留');
  });

  it('removeTab 拿空整组 → payload.group 为 null；组被物理移除并登记删除广播队列', async () => {
    const { createMutationHandlers } = await import('@/background/mutationHandlers');
    const deps = memStorage();
    const handlers = createMutationHandlers(deps as any);
    const g = {
      id: 'g1',
      name: 'g',
      tabs: [mkTab('t1')],
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
      isLocked: false,
    } as import('@/types/tab').TabGroup;
    await deps.setGroups([g]);
    const res = await handlers.handle({ op: 'removeTab', groupId: 'g1', tabId: 't1' });
    assert.equal((res.payload as any).group, null);
    const stored = await deps.getGroups();
    assert.equal(stored.length, 0, '空组被物理移除，本地不留任何删除痕迹');
    // 删除广播：云端行必须被标记 is_deleted（行保留），否则对端下次合并复活。
    // 本地物理删除后 mutation 层唯一职责 = 登记队列，广播由 upload 侧执行。
    assert.deepEqual((deps as any).deletedIds, ['g1'], '被删组 id 已登记删除广播队列');
  });

  it('deleteGroup：物理移除 + 登记广播队列 + 1500ms 调度', async () => {
    const { createMutationHandlers } = await import('@/background/mutationHandlers');
    const deps = memStorage();
    const handlers = createMutationHandlers(deps as any);
    await deps.setGroups([
      { id: 'a', name: 'a', tabs: [mkTab('a1')], createdAt: NOW, updatedAt: NOW, version: 1, isLocked: false },
      { id: 'b', name: 'b', tabs: [mkTab('b1')], createdAt: NOW, updatedAt: NOW, version: 1, isLocked: false },
    ] as import('@/types/tab').TabGroup[]);
    const res = await handlers.handle({ op: 'deleteGroup', groupId: 'a' });
    assert.equal(res.ok, true);
    const stored = await deps.getGroups();
    assert.deepEqual(stored.map(g => g.id), ['b']);
    assert.deepEqual((deps as any).deletedIds, ['a']);
    assert.deepEqual(deps.uploads, [1500]);
  });

  it('deleteAllGroups：全部物理移除，每个组 id 都登记广播队列', async () => {
    const { createMutationHandlers } = await import('@/background/mutationHandlers');
    const deps = memStorage();
    const handlers = createMutationHandlers(deps as any);
    await deps.setGroups([
      { id: 'a', name: 'a', tabs: [mkTab('a1')], createdAt: NOW, updatedAt: NOW, version: 1, isLocked: false },
      { id: 'b', name: 'b', tabs: [], createdAt: NOW, updatedAt: NOW, version: 1, isLocked: true },
    ] as import('@/types/tab').TabGroup[]);
    const res = await handlers.handle({ op: 'deleteAllGroups' });
    assert.equal(res.ok, true);
    assert.equal((res.payload as any).count, 2);
    const stored = await deps.getGroups();
    assert.equal(stored.length, 0);
    assert.deepEqual((deps as any).deletedIds.sort(), ['a', 'b']);
  });

  it('apply 层抛错 → ok:false + error 文本（未知命令）', async () => {
    const { createMutationHandlers } = await import('@/background/mutationHandlers');
    const deps = memStorage();
    const handlers = createMutationHandlers(deps as any);
    const res = await handlers.handle({ op: 'nope' } as any);
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /未知命令/);
  });
});
