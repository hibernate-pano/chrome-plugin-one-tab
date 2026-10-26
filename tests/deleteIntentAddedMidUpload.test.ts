// 上传期间**新增**的删除意图，这一轮就必须广播出去 —— 行为级回归。
//
// ── 这个文件在防什么 ──────────────────────────────────────────────────────
//
// 一轮上传开始之后，用户又删掉了一个会话。那条删除意图**不能压到下一轮**：
// 在下一轮之前，云端行还是**活跃行** ⇒ 别的设备上那条会话还在（而本机已经没了）
// ⇒ 两台设备分叉，且用户在另一台设备上看到的还是「它还在」。
//
// ⇒ 写墓碑前必须**重读**队列（syncEngine 在 markCloudGroupsAsDeleted 之前那次
// storage.getPendingDeleteIds()），而不是用本轮开头读到的那份清单。
//
// ── 2026-10-26：判据的方向变了 ───────────────────────────────────────────
//
// 这个文件原先守的是**相反**的方向：「上传途中被**撤回**的删除意图不许写成墓碑」。
// 那条撤回路径是「恢复即消费」的**撤销按钮**提供的 —— 撤销机制已下线
// ⇒ 生产里**不再存在**撤回路径（storage.retractPendingDeleteIds 一并删除）。
//
// ⇒ 改守**可达**的那条性质：队列在上传期间**变长**。
//   （「重读队列」这个实现仍然必须留着 —— 它现在扛的就是这件事。）
//
// 判据钉的是**终点**（这一轮广播出去的删除 id 里**有**它），不是「队列里还有没有它」
// —— 后者跟「上传刚读完队列」这个时序打架，钉不住真正的性质。
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { installEngineStorageEnv, mkGroup } from './_helpers/engineStorageEnv.ts';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOADER_PATH = pathToFileURL(resolve(ROOT, 'tests/_alias-loader.mjs')).href;

// 装上假的 chrome.storage（安装动作本身就是要紧的，返回值这里用不上）。
installEngineStorageEnv();

if (!process.env.VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

// ══════════════════════════════════════════════════════════════════════════
// 可编程的后端替身：uploadGroups 就是「上传进行到一半」的那个时间点
// ══════════════════════════════════════════════════════════════════════════

function makeBackend(opts?: { onUpload?: () => Promise<void> | void }) {
  const calls = {
    uploadGroups: [] as string[][],
    broadcastDeletes: [] as string[][],
  };

  const backend: Record<string, unknown> = {
    id: 'webdav',
    label: '测试替身',
    async fetchFingerprints() {
      return [];
    },
    async downloadGroups() {
      return [];
    },
    async uploadGroups(groups: Array<{ id: string }>) {
      calls.uploadGroups.push(groups.map(g => g.id));
      // ← 这里就是「上传进行中」：用户此刻又删掉了一个会话。
      if (opts?.onUpload) await opts.onUpload();
      return { writtenIds: groups.map(g => g.id) };
    },
    async broadcastDeletes(ids: string[]) {
      calls.broadcastDeletes.push([...ids]);
      // 端口契约（2026-10-23 R-1）：必须回报「哪些真的广播了、哪些被账号闸门挡下」。
      // 自带存储（WebDAV）不按账号分行 ⇒ 全部放行。
      return { broadcastIds: [...ids], blockedIds: [] };
    },
    async purgeExpiredDeletes() {
      return 0;
    },
    async uploadSettings() {
      /* 测试不需要写设置 */
    },
    async downloadSettings() {
      return null;
    },
  };

  return { backend, calls };
}

let current: ReturnType<typeof makeBackend>;

before(async () => {
  register(LOADER_PATH);
  const { storage } = await import('@/utils/storage');
  await storage.setOpStampMigrated(true);
});

after(async () => {
  const { resetActiveSyncBackend } = await import('@/sync-backend/index.ts');
  resetActiveSyncBackend();
});

beforeEach(async () => {
  const { storage, invalidateGroupsCache, DEFAULT_SETTINGS } = await import('@/utils/storage');
  await storage.setSettings({ ...DEFAULT_SETTINGS, syncBackend: 'webdav' });
  await storage.setLastUploadTime(new Date(Date.now() - 120_000).toISOString());
  await storage.setPendingUpload(false);
  invalidateGroupsCache();
  // 队列排空：上一个用例留下的删除意图会连累下一个用例的前提。
  // ⚠️ 这里用「按确认逐条消费」的清队口（clearPendingDeleteIds），不是已删除的
  //    retractPendingDeleteIds（那是撤销按钮专用路径，生产里已不存在）。
  const left = await storage.getPendingDeleteIds();
  if (left.length > 0) await storage.clearPendingDeleteIds(left);
  current = makeBackend();
  const { setActiveSyncBackend } = await import('@/sync-backend/index.ts');
  setActiveSyncBackend(current.backend as never);
});

/** 本机有的会话 + 一条等着广播的删除意图。 */
async function seedLocalWithDeleteIntent(): Promise<void> {
  const { storage, invalidateGroupsCache } = await import('@/utils/storage');
  await storage.setGroupsImmediate([mkGroup('g1'), mkGroup('alive')] as never);
  invalidateGroupsCache();
  await storage.addPendingDeleteIds(['g1']);
}

describe('删除意图在上传期间新增 ⇒ 那一轮就得把它广播出去', () => {
  it('上传途中新增的那条意图，这一轮广播出去的删除 id 里**有**它', async () => {
    await seedLocalWithDeleteIntent();

    const { storage } = await import('@/utils/storage');
    current = makeBackend({
      onUpload: async () => {
        // 用户在上传进行中又删掉了一个会话 ⇒ 它的删除意图此刻才进队列。
        await storage.addPendingDeleteIds(['g2']);
      },
    });
    const { setActiveSyncBackend } = await import('@/sync-backend/index.ts');
    setActiveSyncBackend(current.backend as never);

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.upload();

    assert.equal(result.success, true, `前提：这一轮上传必须成功（实得：${result.error ?? '无'}）`);
    assert.ok(
      current.calls.uploadGroups.length > 0,
      '前提：这一轮真的走了 upsert（否则「上传途中新增」这个时间点根本不存在）'
    );

    const broadcasted = current.calls.broadcastDeletes.flat();
    assert.ok(
      broadcasted.includes('g2'),
      '上传期间新增的删除意图**必须**在这一轮广播出去 —— ' +
        '压到下一轮的话，云端行在这一轮还是活跃行 ⇒ 别的设备上那条会话还在，' +
        '而本机已经删了 ⇒ 两台设备分叉，且用户在另一台设备上看到的还是「它还在」。' +
        `（这一轮实际广播了：${JSON.stringify(broadcasted)}）`
    );
  });

  it('正控：上传开始前就登记的那条意图**照旧**广播（否则上一条是假通过）', async () => {
    await seedLocalWithDeleteIntent();

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.upload();
    assert.equal(result.success, true, `前提：这一轮上传必须成功（实得：${result.error ?? '无'}）`);

    const broadcasted = current.calls.broadcastDeletes.flat();
    assert.ok(
      broadcasted.includes('g1'),
      '正控：上传前就登记的删除意图必须真的广播到云端 —— ' +
        '否则「上传途中新增的也广播」这条断言是空转的（它对「根本没广播」同样为真）'
    );
  });
});
