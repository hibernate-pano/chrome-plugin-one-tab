// 撤回删除广播意图（2026-10-22 审计 P0-4「撤销」的后台那半边）—— 行为级回归。
//
// ── 这个文件在防什么 ──────────────────────────────────────────────────────
//
// 「恢复即消费」被撤销时要同时回滚两件事，少一件就是**假的撤销**：
//   ① 本地记录写回（core/consumeUndo.ts + background/mutationHandlers.ts 守）；
//   ② 那条删除广播意图从队列里摘掉（本文件守）。
//
// 只做 ① 不做 ② 的后果：本地卡片回来了，而下一次上传照旧把云端那一行标成
// 墓碑 ⇒ **别的设备上那条会话消失** ⇒ 两台设备分叉，且用户全程看不见任何提示
// （撤销按钮弹的是「已撤销」）。这是最坏的一种骗人：界面说成功，跨设备的事实
// 相反，且不可逆（1.22.0 起无回收站）。
//
// 队列的读-改-写必须 fail-closed：撤不掉时**说谎**（假装撤回了）等于把删除
// 意图凭空销毁 ⇒ 别的设备上的会话复活（同样看不见）。
//
// 断言钉的是**行为**（队列里还有没有它），不是源码字面量。
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { installEngineStorageEnv } from './_helpers/engineStorageEnv.ts';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOADER_PATH = pathToFileURL(resolve(ROOT, 'tests/_alias-loader.mjs')).href;

// 必须在任何 `await import('@/...')` 之前装（storage-kv 首次 import 时选驱动）。
const env = installEngineStorageEnv();

const PENDING_DELETE_IDS = 'pending_delete_ids';

before(async () => {
  register(LOADER_PATH);
  const { storage } = await import('@/utils/storage');
  await storage.setOpStampMigrated(true);
});

/** 读一次队列（抛错就抛错，测试不掩盖）。 */
async function queue(): Promise<string[]> {
  const { storage } = await import('@/utils/storage');
  return storage.getPendingDeleteIds();
}

describe('撤回删除广播意图', () => {
  beforeEach(async () => {
    env.failReadKeys.clear();
    env.failWriteKeys.clear();
    // 队列是**模块级**状态（KV + 进程内存兜底），上一个用例留下的条目会让下一个
    // 用例的前提失真（addPendingDeleteIds 见到「已经在队列里」就直接返回，
    // 压根不写 ⇒ 注入的写失败不发作 ⇒ 用例假通过）。所以每个用例先把队列排空。
    const { storage } = await import('@/utils/storage');
    const left = await storage.getPendingDeleteIds();
    if (left.length > 0) await storage.retractPendingDeleteIds(left);
    assert.deepEqual(await storage.getPendingDeleteIds(), [], '前提：队列必须是空的');
  });

  it('撤回之后，队列里就没有它了（不撤回 ⇒ 下次上传照旧把它标墓碑）', async () => {
    const { storage } = await import('@/utils/storage');
    await storage.addPendingDeleteIds(['g1', 'g2']);
    assert.ok((await queue()).includes('g1'), '前提：g1 已经在队列里');

    await storage.retractPendingDeleteIds(['g1']);

    const after = await queue();
    assert.equal(after.includes('g1'), false, '撤回后队列里不能再有它');
    assert.ok(after.includes('g2'), '正控：别的删除意图不受牵连');
  });

  it('撤回不点名的一条 ⇒ 队列原样（不能连坐）', async () => {
    const { storage } = await import('@/utils/storage');
    await storage.addPendingDeleteIds(['g1', 'g2']);
    await storage.retractPendingDeleteIds(['g-not-there']);
    const after = await queue();
    assert.ok(after.includes('g1') && after.includes('g2'), '点名之外的意图必须原样留着');
  });

  it('读失败 ⇒ **抛错**（fail-closed），不许当成「队列是空的」', async () => {
    const { storage } = await import('@/utils/storage');
    await storage.addPendingDeleteIds(['g1']);
    env.failReadKeys.add(PENDING_DELETE_IDS);

    await assert.rejects(
      () => storage.retractPendingDeleteIds(['g1']),
      /simulated read failure/,
      '读不到队列就不能撤回 —— 假装撤回了 = 删除意图被凭空销毁'
    );

    env.failReadKeys.clear();
    assert.ok((await queue()).includes('g1'), '失败后意图必须原样留在队列里');
  });

  it('写失败 ⇒ **抛错**，且那条意图仍然留在队列里（不许谎报撤回了）', async () => {
    const { storage } = await import('@/utils/storage');
    // 先把意图写进 KV（写成功）⇒ 撤回时需要一次真实的 KV 写。
    await storage.addPendingDeleteIds(['g1']);

    env.failWriteKeys.add(PENDING_DELETE_IDS);
    await assert.rejects(
      () => storage.retractPendingDeleteIds(['g1']),
      /simulated write failure/,
      '撤不掉就必须说「撤不掉」，不能谎报成功'
    );
    env.failWriteKeys.clear();

    assert.ok(
      (await queue()).includes('g1'),
      '撤不掉 ⇒ 意图必须原样留在队列里（下次上传照旧广播它）—— ' +
        '谎报「撤掉了」等于把删除意图凭空销毁（别的设备上的会话会复活）'
    );
  });

  it('写恢复正常后，撤回能把**内存兜底里的**那条也摘掉', async () => {
    const { storage } = await import('@/utils/storage');
    env.failWriteKeys.add(PENDING_DELETE_IDS);
    await assert.rejects(() => storage.addPendingDeleteIds(['g1']));
    env.failWriteKeys.clear();
    assert.ok((await queue()).includes('g1'), '前提：意图在内存兜底里');

    await storage.retractPendingDeleteIds(['g1']);

    assert.equal(
      (await queue()).includes('g1'),
      false,
      '撤回必须把内存兜底里的那条也摘掉 —— 只摘 KV 的话这条意图还在（下次上传照旧标墓碑）'
    );
  });
});
