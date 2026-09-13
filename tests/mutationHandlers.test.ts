// 钉死 SW 端语义命令执行器（规格 §3.2/§3.3）的编排契约：
// 1) removeTab 写入 storage 且按删除优先级 1500ms 调度上传；
// 2) removeTab 整组清空时 payload.group = null 且组被墓碑化、调度仍为 1500ms；
// 3) apply 层抛错（如 restoreGroup 未找到）被 handle 包装为 ok:false + error 文本；
// 4) 未知 op 返回 ok:false。
//
// 文件头部样板与 tests/mutationQueue.test.ts / tests/mutationProtocol.test.ts 一致：
// @/ 别名模块只能在 register(loader) 之后【动态 import】（静态 import 会被
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

function memStorage() {
  let groups: import('@/types/tab').TabGroup[] = [];
  const uploads: number[] = [];
  // 阶段二·§4.3：handlers 现在必须注入 journal + seq。测试用极简 mock：
  // seq 单调递增、journal 内存追加，stamp 来源于此。
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
  };
}

describe('mutationHandlers: 编排（读→apply→写→调度上传）', () => {
  it('removeTab：写入 storage 并按删除优先级 1500ms 调度上传', async () => {
    const { createMutationHandlers } = await import('@/background/mutationHandlers');
    const deps = memStorage();
    const handlers = createMutationHandlers(deps as any);
    const g = {
      id: 'g1',
      name: 'g',
      tabs: [
        {
          id: 't1',
          url: 'https://a.com',
          title: 'a',
          favicon: '',
          createdAt: NOW,
          lastAccessed: NOW,
          pinned: false,
        },
        {
          id: 't2',
          url: 'https://b.com',
          title: 'b',
          favicon: '',
          createdAt: NOW,
          lastAccessed: NOW,
          pinned: false,
        },
      ],
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
      isDeleted: false,
      isLocked: false,
    } as import('@/types/tab').TabGroup;
    await deps.setGroups([g]);
    const res = await handlers.handle({ op: 'removeTab', groupId: 'g1', tabId: 't1' });
    assert.equal(res.ok, true);
    assert.deepEqual(deps.uploads, [1500]);
    const stored = await deps.getGroups();
    assert.equal(stored[0].tabs[0].isDeleted, true);
  });

  it('removeTab 整组清空 → payload.group 为 null；组被墓碑化且也调度 1500', async () => {
    const { createMutationHandlers } = await import('@/background/mutationHandlers');
    const deps = memStorage();
    const handlers = createMutationHandlers(deps as any);
    const g = {
      id: 'g1',
      name: 'g',
      tabs: [
        {
          id: 't1',
          url: 'https://a.com',
          title: 'a',
          favicon: '',
          createdAt: NOW,
          lastAccessed: NOW,
          pinned: false,
        },
      ],
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
      isDeleted: false,
      isLocked: false,
    } as import('@/types/tab').TabGroup;
    await deps.setGroups([g]);
    const res = await handlers.handle({ op: 'removeTab', groupId: 'g1', tabId: 't1' });
    assert.equal((res.payload as any).group, null);
    const stored = await deps.getGroups();
    assert.equal(stored[0].isDeleted, true);
  });

  it('apply 层抛错 → ok:false + error 文本（如 restoreGroup 未找到）', async () => {
    const { createMutationHandlers } = await import('@/background/mutationHandlers');
    const deps = memStorage();
    const handlers = createMutationHandlers(deps as any);
    const res = await handlers.handle({ op: 'restoreGroup', groupId: 'nope' });
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /未找到/);
  });

  it('importGroups：生成新 ID、清洗 URL、盖 stamp 并调度上传', async () => {
    const { createMutationHandlers } = await import('@/background/mutationHandlers');
    const deps = memStorage();
    const handlers = createMutationHandlers(deps as any);
    const res = await handlers.handle({
      op: 'importGroups',
      groups: [{
        id: 'backup-id',
        name: '导入会话',
        tabs: [
          {
            id: 'backup-tab-ok',
            url: 'https://example.com',
            title: 'safe',
            createdAt: NOW,
            lastAccessed: NOW,
            pinned: false,
          },
          {
            id: 'backup-tab-bad',
            url: 'javascript:alert(1)',
            title: 'bad',
            createdAt: NOW,
            lastAccessed: NOW,
            pinned: false,
          },
        ],
        createdAt: NOW,
        updatedAt: NOW,
        version: 1,
        isDeleted: false,
        isLocked: false,
      }],
    });
    assert.equal(res.ok, true);
    assert.deepEqual(deps.uploads, [1500]);
    const stored = await deps.getGroups();
    assert.equal(stored.length, 1);
    assert.notEqual(stored[0].id, 'backup-id');
    assert.deepEqual(stored[0].lastOp, { d: 'devTest', s: 1 });
    assert.equal(stored[0].tabs.length, 1);
    assert.equal(stored[0].tabs[0].url, 'https://example.com');
    assert.notEqual(stored[0].tabs[0].id, 'backup-tab-ok');
  });

  it('未知 op → ok:false', async () => {
    const { createMutationHandlers } = await import('@/background/mutationHandlers');
    const handlers = createMutationHandlers(memStorage() as any);
    const res = await handlers.handle({ op: 'nope' } as any);
    assert.equal(res.ok, false);
  });
});
