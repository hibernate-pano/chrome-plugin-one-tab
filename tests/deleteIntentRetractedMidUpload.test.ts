// 上传途中被撤回的删除意图**不许**被写成墓碑（2026-10-22 审计 P0-4）—— 行为级回归。
//
// ── 这个文件在防什么 ──────────────────────────────────────────────────────
//
// 「恢复即消费」被撤销时，那条删除广播意图会从队列里被摘掉
// （storage.retractPendingDeleteIds）。撤销按钮弹的是「已撤销」——
// 也就是说，**用户已经知道它撤回了**。
//
// 如果上传这一轮用的是**开始时**读到的那份队列清单，就会给一条**已经撤回**
// 的意图写墓碑。而墓碑的印记是**写墓碑那一刻**才取的 ⇒ 必然比撤销写下的
// 记录更新 ⇒ 跨设备合并时墓碑赢 ⇒ 别的设备上那条会话**还是消失了**，
// 而用户看到的是「撤销成功了」。
//
// 这是最坏的一种骗人：界面说成功，跨设备的事实相反，且不可逆（无回收站）。
//
// 判据钉的是**终点**（这一轮广播出去的删除 id 里没有它），不是「队列里还有
// 没有它」—— 后者跟「上传刚读完队列」这个时序打架，钉不住真正的性质。
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
      // ← 这里就是「上传进行中」：用户此刻点了撤销。
      if (opts?.onUpload) await opts.onUpload();
      return { writtenIds: groups.map(g => g.id) };
    },
    async broadcastDeletes(ids: string[]) {
      calls.broadcastDeletes.push([...ids]);
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
  const left = await storage.getPendingDeleteIds();
  if (left.length > 0) await storage.retractPendingDeleteIds(left);
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

describe('删除意图在上传途中被撤回 ⇒ 那一轮不许把它写成墓碑', () => {
  it('撤回之后，这一轮广播出去的删除 id 里**不含**它', async () => {
    await seedLocalWithDeleteIntent();

    const { storage } = await import('@/utils/storage');
    current = makeBackend({
      onUpload: async () => {
        // 用户在上传进行中点了「撤销」⇒ 意图被摘掉。
        await storage.retractPendingDeleteIds(['g1']);
      },
    });
    const { setActiveSyncBackend } = await import('@/sync-backend/index.ts');
    setActiveSyncBackend(current.backend as never);

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.upload();

    assert.equal(result.success, true, `前提：这一轮上传必须成功（实得：${result.error ?? '无'}）`);
    assert.ok(
      current.calls.uploadGroups.length > 0,
      '前提：这一轮真的走了 upsert（否则「上传途中撤回」这个时间点根本不存在）'
    );

    const broadcasted = current.calls.broadcastDeletes.flat();
    assert.equal(
      broadcasted.includes('g1'),
      false,
      '已经被撤回的删除意图**不许**再被写成墓碑 —— ' +
        '墓碑的印记取自写墓碑那一刻（必然比撤销的新）⇒ 别的设备上那条会话还是消失，' +
        '而用户看到的是「撤销成功了」'
    );
  });

  it('正控：没撤回的那条意图**照旧**广播（否则上一条是假通过）', async () => {
    await seedLocalWithDeleteIntent();

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.upload();
    assert.equal(result.success, true, `前提：这一轮上传必须成功（实得：${result.error ?? '无'}）`);

    const broadcasted = current.calls.broadcastDeletes.flat();
    assert.ok(
      broadcasted.includes('g1'),
      '正控：没被撤回的删除意图必须真的广播到云端 —— ' +
        '否则「撤回后不广播」这条断言是空转的（它对「根本没广播」同样为真）'
    );
  });
});
