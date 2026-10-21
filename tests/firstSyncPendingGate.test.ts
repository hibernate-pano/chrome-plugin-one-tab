// 首次同步归属未决时，自动上传不得走全量（2026-10-18 P1#4）。
//
// ── 缺陷形状 ──────────────────────────────────────────────────────────────
// 切到自带存储后，本地通常已有会话，而「它们归谁」由设置页的三选一决定。
// 但 `TabManager.ts` 保存会话时会 `scheduleUpload` → 置 pending_upload，
// 而 WebDAV 适配器在「远端还没有 manifest」时走 `firstSync` = 上传**全部**
// 本地组（adapter.uploadGroups）。
//
// 于是：配好 WebDAV、没点「检查并推送」，随后保存一个标签页
//   ⇒ 全部旧会话被自动推上云 ⇒ 三选一归属决策被**完全绕过**。
// 用户从没被问过，决策替他做了。
//
// ── 修法 ──────────────────────────────────────────────────────────────────
// 持久化 `webdav_first_sync_pending`：为 true 时，非显式的上传必须
// 传 `suppressFirstSyncFullUpload: true`，让适配器把 firstSync 降级为增量。
//
// ── 判别力 ────────────────────────────────────────────────────────────────
// 关键不是「有这个参数」，而是**参数随标志变化**：
//   · 标志 true + 非显式 ⇒ 必须抑制
//   · 标志 true + 显式（设置页三选一）⇒ 必须**不**抑制（否则用户点了推送却推不上去）
//   · 标志 false ⇒ 必须不抑制（老用户恢复全量能力）
// 把实现改成恒抑制或恒不抑制，都必须红。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { installEngineStorageEnv } from './_helpers/engineStorageEnv.ts';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

if (!process.env.VERBOSE) {
  console.log = () => {};
}

describe('P1#4 首次同步标志：存储层语义', () => {
  before(() => {
    register(LOADER_PATH);
    // ⚠️ 必须搭出扩展运行时的存储环境（localStorage 桩）。
    // 缺了它 `pickBackend()` 拿不到任何 driver，`kvSet` 会**静默不写**
    // （storageAdapter:184 `if (!driver) return`），于是「set 成功但 get 恒 false」。
    // 我第一版漏了这一步，症状看起来像实现 bug，实际是测试没接上存储 ——
    // 那正是本仓库反复强调的「测试没接上会伪装成实现坏了」。
    installEngineStorageEnv();
  });

  it('默认（缺失）= 不待决：老用户升级后不被无端挡住', async () => {
    const { storage } = await import('@/utils/storage');
    // 缺失必须读成 false，而不是 true。
    // 方向错了的后果：所有存量用户切到 WebDAV 后自动上传被永久降级为增量，
    // 他们保存的新会话能传（增量含新增），但「首次全量」永远不发生 ——
    // 表现为「同步看着在跑，云端却只有最近几条」。
    assert.equal(
      await storage.getFirstSyncPending(),
      false,
      '键缺失时必须当作「已完成」，否则老用户会被无端降级'
    );
  });

  it('写入 true 后读回 true；写回 false 后读回 false', async () => {
    const { storage } = await import('@/utils/storage');
    await storage.setFirstSyncPending(true);
    assert.equal(await storage.getFirstSyncPending(), true, '置位必须可读回');
    await storage.setFirstSyncPending(false);
    assert.equal(await storage.getFirstSyncPending(), false, '清除必须可读回');
  });

  it('只接受严格 true：其他真值不得被当成待决', async () => {
    const { storage } = await import('@/utils/storage');
    const { kvSet } = await import('@/storage-kv/storageAdapter');
    const { STORAGE_KEYS } = await import('@/storage-kv/keys');
    // 防御历史脏数据 / 未来的值类型漂移：'yes'、1、{} 都不该阻断同步。
    for (const junk of ['yes', 1, {}, null] as unknown[]) {
      await kvSet(STORAGE_KEYS.FIRST_SYNC_PENDING, junk);
      assert.equal(
        await storage.getFirstSyncPending(),
        false,
        `非严格 true（${JSON.stringify(junk)}）不得被当成「归属待决」——否则脏数据会让同步永久降级`
      );
    }
  });
});

describe('P1#4 首次同步标志：接线（结构）', () => {
  const STRIP = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const readSrc = async (p: string): Promise<string> => {
    const { readFileSync } = await import('node:fs');
    return STRIP(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', p), 'utf8'));
  };

  it('syncEngine 按标志决定，并把决定交给 service 层（分层：engine → service → port）', async () => {
    const src = await readSrc('src/services/syncEngine.ts');
    assert.match(src, /getFirstSyncPending\(\)/, '必须读标志');
    assert.match(
      src,
      /const explicitFirstSync = firstSyncPending \? !!opts\?\.explicitFirstSync : true/,
      '决定式必须是「待决时看调用方是否显式声明，非待决时一律允许全量」—— ' +
        '反过来（待决时一律抑制）会让设置页点了推送也推不上去'
    );
    // 分层的落点：engine 传 explicitFirstSync，service 翻成端口的
    // suppressFirstSyncFullUpload。断言两头都在，否则中间断了没人发现。
    const service = await readSrc('src/services/tabGroupSyncService.ts');
    assert.match(
      service,
      /suppressFirstSyncFullUpload: !explicitFirstSync/,
      'service 层必须把 explicitFirstSync 翻成 suppress（这里是唯一转换点）'
    );
  });

  it('适配器确实按 suppress 参数降级 firstSync', async () => {
    const src = await readSrc('src/sync-backend/webdav/adapter.ts');
    // ⚠️ 这里钉的是**不变量**，不是某个字面量。
    //
    // 2026-10-20 修 P0「云端索引丢了被当成空库」时，firstSync 的判据从
    // 「manifest 读不到」（`loaded === null`）改成了「**远端确实一个分片都没有**」
    // （`index.kind === 'empty'`）—— 因为「索引读不到」有两种含义
    // （远端真是空的 / 索引丢了但分片还在），只有后者不能走全量。
    // 改判据不改变本条要守的东西：**suppress 时绝不能走 firstSync 全量**。
    //
    // 所以断言写成「suppress 出现在 firstSync 的判据里」，而不是钉住
    // 判据左边那个具体表达式 —— 后者会在每次重构判据时误报，
    // 逼着人把断言改成「照抄实现」，那正是结构化断言最坏的退化形态。
    const firstSyncLine = src
      .split('\n')
      .find(l => /const firstSync\s*=/.test(l));
    assert.ok(firstSyncLine, '必须能看出 firstSync 是怎么算出来的');
    assert.match(
      firstSyncLine,
      /!opts\?\.suppressFirstSyncFullUpload/,
      'firstSync 必须排除 suppress 情形 —— 这是「不替用户做决定」的落点'
    );
  });

  it('只有设置页的三选一会声明 explicitFirstSync', async () => {
    const settings = await readSrc('src/components/sync/WebDavSettings.tsx');
    assert.match(
      settings,
      /explicitFirstSync: true/,
      '三选一是唯一有资格声明「用户已确认归属」的上传'
    );
    // 反向：scheduleUpload / 后台 alarm 那条链不得传它。
    const tabManager = await readSrc('src/background/TabManager.ts');
    assert.ok(
      !/explicitFirstSync/.test(tabManager),
      '保存会话触发的自动上传绝不能声明「用户已确认归属」—— 那正是本缺陷'
    );
    const bg = await readSrc('src/background/backgroundSync.ts');
    assert.ok(
      !/explicitFirstSync/.test(bg),
      '后台轮询同样不得声明 —— 用户没在那里点过任何东西'
    );
  });
});
