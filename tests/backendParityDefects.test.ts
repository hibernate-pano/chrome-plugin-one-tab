// 「WebDAV 后端比 Supabase 后端松一档」的回归防线（2026-10-20）。
//
// 三条缺陷共享同一个根因：**WebDAV 侧少了一道 Supabase 侧有的防线**。
// 本文件用**不变量**钉住修复后的行为，每一条都注明「改坏哪一个点会变红」。
//
//   D-3 上传「本轮一个组都没传上去」时仍然清 pending_upload 与增量白名单
//   D-4 WebDAV 的裁决读的是索引而不是分片内容
//   D-5 WebDAV 的删除广播没有读回校验
//
// 变异验证口径见提交信息（每个缺陷至少一个变异点）。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFile(resolve(ROOT, rel), 'utf8');

/** 剥掉注释：注释里提到旧写法不算「代码还这么做」。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ════════════════════════════════════════════════════════════════════
// D-3：待决期的白名单是「不存在的 id」⇒ 必须保留 pending_upload
// ════════════════════════════════════════════════════════════════════

describe('D-3：白名单里的 id 全部不存在时，不得清 pending_upload', () => {
  it('对账判据：登记 ⊄ 上行 ⇒ canClearPending=false，并如实报出未同步数量', async () => {
    const { reconcileUploadCoverage } = await import('@/core/uploadCoverage');

    // 复现现场：导入 20 个会话 → 白名单登记的是**备份文件里的 id**（落盘时
    // id 被 genId() 重新生成，所以这些 id 在本机根本不存在）⇒ 上行集合为空。
    const registered = Array.from({ length: 20 }, (_, i) => `file-id-${i}`);
    const coverage = reconcileUploadCoverage({
      registeredIds: registered,
      submittedIds: [],
      uploadPerformed: false,
    });

    assert.equal(coverage.canClearPending, false, '一个都没传上去 ⇒ 绝不能清 pending_upload');
    assert.equal(coverage.unsyncedCount, 20, '必须如实报出「20 个会话尚未同步」');
    assert.equal(coverage.unsyncedIds.length, 20);
  });

  it('对账判据：登记 ⊆ 上行 ⇒ 可以清（正常路径不许被误伤）', async () => {
    const { reconcileUploadCoverage } = await import('@/core/uploadCoverage');
    const coverage = reconcileUploadCoverage({
      registeredIds: ['a', 'b'],
      submittedIds: ['a', 'b', 'c'],
      uploadPerformed: true,
    });
    assert.equal(coverage.canClearPending, true);
    assert.equal(coverage.unsyncedCount, 0);
  });

  it('对账判据：登记不可信（白名单写失败过）⇒ 不得宣称「全部已同步」', async () => {
    const { reconcileUploadCoverage } = await import('@/core/uploadCoverage');
    // 集合看起来对得上，但登记本身失败过 ⇒ 「对得上」只说明「登记到的都传了」，
    // 没说明「没登记的也没漏」⇒ 仍然不能清。
    const coverage = reconcileUploadCoverage({
      registeredIds: ['a'],
      submittedIds: ['a'],
      uploadPerformed: true,
      registryUnreliable: true,
    });
    assert.equal(coverage.canClearPending, false, '登记失败过就不能清 pending_upload');
    assert.equal(coverage.registryUnreliable, true);
  });

  it('对账判据：以删除结案的会话不算「未同步」（它们不该被上行）', async () => {
    const { reconcileUploadCoverage } = await import('@/core/uploadCoverage');
    const coverage = reconcileUploadCoverage({
      registeredIds: ['a', 'deleted-1'],
      submittedIds: ['a'],
      uploadPerformed: true,
      deletedIds: ['deleted-1'],
    });
    assert.equal(coverage.canClearPending, true, '删除结案不构成「没传上去」');
    assert.equal(coverage.unsyncedCount, 0);
  });

  it('syncEngine：清 pending_upload 必须以对账结果为前提（不许无条件清）', async () => {
    const src = stripComments(await read('src/services/syncEngine.ts'));
    assert.match(
      src,
      /reconcileUploadCoverage\(\{/,
      '必须用共享的对账判据（两个后端同一份判据，不许在引擎里另写一份）'
    );
    assert.match(
      src,
      /if\s*\(coverage\.canClearPending\)\s*\{[\s\S]{0,400}setPendingUpload\(false\)/,
      'setPendingUpload(false) 必须在 canClearPending 守卫之内'
    );
    // 判据之外不许有第二条「无条件清 pending_upload」的路径。
    const clears = src.match(/setPendingUpload\(false\)/g) ?? [];
    assert.equal(clears.length, 1, `setPendingUpload(false) 只许出现在对账守卫里（实际 ${clears.length} 处）`);
  });

  it('syncEngine：结果必须如实带上「N 个会话尚未同步」', async () => {
    const src = stripComments(await read('src/services/syncEngine.ts'));
    assert.match(src, /skippedGroups:\s*coverage\.unsyncedCount/, '必须把未同步数量报出去');
    assert.match(src, /个会话尚未同步/, '必须有人话文案（UI 直接展示它）');
  });

  it('导入登记的必须是**落盘后的真实 id**（applyImportGroups 的返回值）', async () => {
    const src = stripComments(await read('src/background/mutationHandlers.ts'));
    // 落盘时 id 被 genId() 重新生成 ⇒ 备份文件里的 id 一律不存在。
    // 登记文件里的 id ⇒ 白名单恒为空 ⇒ 待决期一个会话都传不上去。
    assert.match(
      src,
      /scheduleUpload\([^)]*r\.imported\.map\(g\s*=>\s*g\.id\)/,
      'importGroups 分支必须用 applyImportGroups 返回的真实 id 登记'
    );
    assert.doesNotMatch(
      src.slice(src.indexOf("case 'importGroups'"), src.indexOf("case 'renameGroup'")),
      /scheduleUpload\([^)]*changedIds/,
      'importGroups 分支不许再用命令载荷里的 id（那些 id 落盘时已被替换）'
    );
  });

  it('applyImportGroups 确实会换 id（登记必须用返回值而不是载荷）', async () => {
    const src = stripComments(await read('src/core/mutationOps.ts'));
    assert.match(
      src,
      /id:\s*deps\.genId\(\)/,
      '导入的组 id 是新生成的 ⇒ 命令载荷里的 id 不再存在'
    );
    assert.match(src, /imported:\s*processed/, 'applyImportGroups 必须返回真实 id 集合');
  });

  it('noteGroupsChanged 写失败必须留下「登记不可信」的持久标记', async () => {
    const engine = stripComments(await read('src/services/syncEngine.ts'));
    // 判据盯语义：noteGroupsChanged 的失败处理里必须出现「置不可信标记」这一步。
    // 不用脆弱的单行正则（catch 体内的括号会让 `[^)]*` 提前截断）。
    const at = engine.indexOf('noteGroupsChanged(');
    assert.ok(at > 0, '必须能找到 noteGroupsChanged 调用');
    const branch = engine.slice(at, at + 1200);
    assert.match(
      branch,
      /setPendingUploadRegistryUnreliable\(true\)/,
      '登记失败必须置「登记不可信」标记（只记日志是不够的）'
    );
    const storageSrc = stripComments(await read('src/utils/storage.ts'));
    assert.match(storageSrc, /async getPendingUploadRegistryUnreliable\(/);
    assert.match(storageSrc, /async setPendingUploadRegistryUnreliable\(/);
    // 标记必须是**持久化**的：写入失败可能发生在上一轮，进程重启不该把它抹掉。
    const keys = await read('src/storage-kv/keys.ts');
    assert.match(keys, /PENDING_UPLOAD_REGISTRY_UNRELIABLE:/);
  });

  it('SW 那一层必须把「没全传上去」如实报给用户（ok=false + 原因）', async () => {
    const sw = stripComments(await read('src/service-worker.ts'));
    // 引擎的 success = 「这一轮没有硬失败」，不是「全部同步了」。
    // 面向用户的那一层（SW 的 SYNC 回包）必须把两者分开，否则 popup 弹
    // 「上传成功」而那 20 个会话一个都没上云。
    assert.match(
      sw,
      /skippedGroups/,
      'SW 必须读引擎的 skippedGroups 字段'
    );
    assert.match(
      sw,
      /ok:\s*r\.success\s*&&\s*!partial/,
      '有会话没传上去 ⇒ 回包必须 ok=false（让 popup 弹错误而不是「上传成功」）'
    );
  });

  it('文案必须含中文（UI 的 resolveSyncFailureCopy 对含中文的句子原样透出）', async () => {
    const engine = stripComments(await read('src/services/syncEngine.ts'));
    assert.match(
      engine,
      /个会话尚未同步到云端/,
      '文案必须是中文句子 —— 机器码会被 UI 当成枚举丢掉，用户什么也看不到'
    );
  });
});

// ════════════════════════════════════════════════════════════════════
// D-4：裁决必须读分片内容，不是索引
// ════════════════════════════════════════════════════════════════════

describe('D-4：远端裁决的依据是分片自身，不是索引', () => {
  it('共享判据：内容优先于索引（内容读不到才退回索引）', async () => {
    const { resolveRemoteState, shouldConcedeToRemote } = await import('@/core/remoteAdjudication');

    // 索引旧（s=50）、分片新（s=100）—— 修复前只读索引 ⇒ 判「远端不更新」⇒
    // 用旧内容盖掉新内容。现在读内容 ⇒ 判「远端更新」⇒ 本地认输。
    const state = resolveRemoteState({
      content: { lastOp: { d: 'dev-A', s: 100 } },
      index: { lastOp: { d: 'dev-A', s: 50 } },
    });
    assert.equal(state.fromContent, true, '内容必须在索引之上');
    assert.equal(state.lastOp?.s, 100);
    assert.equal(
      shouldConcedeToRemote({ d: 'dev-B', s: 200 }, state),
      false,
      '本地 s=200 比远端 s=100 新 ⇒ 不认输'
    );
    assert.equal(
      shouldConcedeToRemote({ d: 'dev-B', s: 60 }, state),
      true,
      '本地 s=60 比远端 s=100 旧 ⇒ 认输'
    );
  });

  it('共享判据：内容读不到时退回索引，并如实标出 fromContent=false', async () => {
    const { resolveRemoteState } = await import('@/core/remoteAdjudication');
    const state = resolveRemoteState({
      content: null,
      index: { lastOp: { d: 'dev-A', s: 50 } },
    });
    assert.equal(state.fromContent, false);
    assert.equal(state.lastOp?.s, 50);
  });

  it('共享判据：两个后端对同一组输入必须给出同一结论（不许漂移）', async () => {
    const { shouldConcedeToRemote, resolveRemoteState } = await import('@/core/remoteAdjudication');
    // Supabase 侧的判据（utils/supabase/upload.ts 的 shouldConcedeGroup）：
    // 「云端 stamp 严格更大 ⇒ 认输；本地严格更新 ⇒ 绝不认输」。
    // 两边对同一组 (本地印记, 远端印记) 必须一致 —— 这就是「判据来自同一处」的
    // 可检验形式。
    const cases: Array<[ { d: string; s: number } | undefined, { d: string; s: number } | undefined ]> = [
      [{ d: 'A', s: 10 }, { d: 'B', s: 20 }],
      [{ d: 'A', s: 20 }, { d: 'B', s: 10 }],
      [{ d: 'A', s: 10 }, { d: 'A', s: 10 }],
      [undefined, { d: 'B', s: 20 }],
      [{ d: 'A', s: 10 }, undefined],
      [undefined, undefined],
    ];
    for (const [local, remote] of cases) {
      const remoteState = resolveRemoteState({ content: remote ? { lastOp: remote } : null });
      const shared = shouldConcedeToRemote(local, remoteState);
      // Supabase 口径的等价判定（严格更大 ⇒ 认输）：
      // 用 compareStampsLoose 的同一全序，MISSING 视为最小。
      const MISSING = { d: '', s: -Infinity };
      const sa = local ?? MISSING;
      const sb = remote ?? MISSING;
      const expected = sb.s !== sa.s ? sb.s > sa.s : sb.d > sa.d;
      assert.equal(shared, expected, `印记(${local?.s} vs ${remote?.s}) 的结论必须一致`);
    }
  });

  it('分片必须带上明文头部（裁决不必先解密）', async () => {
    const layout = await read('src/sync-backend/webdav/layout.ts');
    assert.match(layout, /export interface ShardHeader/, '分片头部类型必须存在');
    assert.match(layout, /hdr\?:\s*ShardHeader/, '外壳必须允许带头部');
    assert.match(layout, /export function shardHeaderFromPayload\(/, '必须有从载荷生成头部的函数');
    // 头部在**密文之外**：外壳本来就是明文 JSON，密文只在 enc.data 里。
    const adapter = stripComments(await read('src/sync-backend/webdav/adapter.ts'));
    assert.match(
      adapter,
      /makeEncryptedEnvelope\(await vault\.encrypt\(payload\),\s*header\)/,
      '加密分片也必须带明文头部'
    );
  });

  it('老分片（没有头部）仍然可读 —— 头部是可选增强不是新格式硬要求', async () => {
    const { parseEnvelope, makePlainEnvelope } = await import('@/sync-backend/webdav/layout');
    // 老分片：只有 plain，没有 hdr。
    const legacy = parseEnvelope(JSON.stringify({ v: 1, plain: { id: 'g1' } }));
    assert.ok(legacy, '老分片必须仍能解析');
    assert.equal(legacy.kind, 'plain');
    assert.equal('hdr' in legacy, false, '老分片没有头部');
    // 新分片：带 hdr。
    const modern = parseEnvelope(JSON.stringify({ v: 1, plain: { id: 'g1' }, hdr: { id: 'g1', lastOp: { d: 'A', s: 1 } } }));
    assert.ok(modern && modern.kind === 'plain');
    assert.equal(modern.hdr?.lastOp?.s, 1);
    // 制造头部的入口：明文与加密两种形态都要能带。
    const plain = makePlainEnvelope({ id: 'g1' }, { id: 'g1', lastOp: { d: 'A', s: 1 } });
    assert.equal(plain.hdr?.lastOp?.s, 1);
  });

  it('条件写能力必须参与裁决策略（探针 false ⇒ 不发 If-Match）', async () => {
    const adapter = stripComments(await read('src/sync-backend/webdav/adapter.ts'));
    assert.match(
      adapter,
      /private async conditionalWriteCapability\(\)/,
      '条件写能力必须是显式状态（探测一次、缓存住）'
    );
    assert.match(
      adapter,
      /const conditional = await this\.conditionalWriteCapability\(\);/,
      '写分片前必须先问「服务端支持条件写吗」'
    );
    // 支持 ⇒ 带 If-Match；不支持 ⇒ 不带（发了只是「看起来有锁」）。
    assert.match(adapter, /ifMatch = conditional \? remote\.etag/);
    assert.match(adapter, /ifNoneMatch = conditional \?/);
  });

  it('上传后必须自检「索引条目 ↔ 分片自身印记」，不一致即中止本轮', async () => {
    const adapter = stripComments(await read('src/sync-backend/webdav/adapter.ts'));
    assert.match(
      adapter,
      /verifyIndexMatchesShardHeaders/,
      '必须有「索引 ↔ 分片印记」的自检'
    );
    assert.match(
      adapter,
      /private async verifyIndexMatchesShardHeaders\([\s\S]*?throw new Error\(/,
      '自检不通过必须抛错（fail-closed），不能只记日志'
    );
  });
});

// ════════════════════════════════════════════════════════════════════
// D-5：删除广播必须有读回校验
// ════════════════════════════════════════════════════════════════════

describe('D-5：删除广播必须读回确认，否则不消费删除队列', () => {
  it('共享判据：读回不是墓碑 ⇒ 校验不通过', async () => {
    const { compareTombstoneReadback } = await import('@/core/remoteAdjudication');
    const expected = { id: 'g1', lastOp: { d: 'dev-A', s: 42 } };
    assert.equal(compareTombstoneReadback(expected, { id: 'g1', isDeleted: false }).ok, false);
    assert.equal(
      compareTombstoneReadback(expected, { id: 'g1', isDeleted: true, lastOp: { d: 'dev-A', s: 42 } }).ok,
      true
    );
    // 印记对不上 ⇒ 也不通过（写上去的不是我要的那一条）。
    assert.equal(
      compareTombstoneReadback(expected, { id: 'g1', isDeleted: true, lastOp: { d: 'dev-A', s: 41 } }).ok,
      false
    );
  });

  it('广播路径必须读回校验，且不一致就抛错', async () => {
    const adapter = stripComments(await read('src/sync-backend/webdav/adapter.ts'));
    assert.match(
      adapter,
      /await this\.verifyTombstoneReadback\(/,
      '写完墓碑必须读回确认'
    );
    assert.match(
      adapter,
      /private async verifyTombstoneReadback\([\s\S]*?throw new Error\(/,
      '读回不一致必须抛错（抛错 ⇒ 上层不清删除队列）'
    );
  });

  it('端口契约：「广播成功」的定义必须写清楚是「读回确认」', async () => {
    const ports = await read('src/sync-backend/ports.ts');
    const start = ports.indexOf('broadcastDeletes');
    assert.ok(start > 0, 'ports.ts 必须声明 broadcastDeletes');
    const section = ports.slice(start, start + 1200);
    assert.match(
      section,
      /读回|read-back|readback/i,
      '契约必须写明「广播成功 = 读回确认」'
    );
  });

  it('syncEngine：广播失败时不得清删除队列（清队在成功之后）', async () => {
    const src = stripComments(await read('src/services/syncEngine.ts'));
    const broadcast = src.indexOf('markCloudGroupsAsDeleted(');
    const clear = src.indexOf('clearPendingDeleteIds(');
    assert.ok(broadcast > 0 && clear > broadcast, '清队必须排在广播之后');
    // 广播抛错 ⇒ 上浮到外层 catch ⇒ 清队那行根本不会执行。
    assert.match(
      src,
      /await markCloudGroupsAsDeleted\(cloudDeleteIds\);[\s\S]{0,200}await storage\.clearPendingDeleteIds\(cloudDeleteIds\);/,
      '清队必须在广播成功之后（靠抛错跳过）'
    );
  });
});
