/**
 * DS-43-19：增量白名单的「登记」与「清理」竞争 ⇒ 改动留在本机不上云，
 * 界面却报「同步成功」。
 *
 * ── 缺陷本体（根因不是「少了几个 await」）─────────────────────────────────
 * 「还有没传完的东西」这个事实被记在**两个地方**：
 *   · `pending_upload`（布尔标志）—— 写方置位，上传轮次在对账通过后清位；
 *   · `pending_upload_group_ids`（增量白名单）—— 写方登记（并集），
 *     上传轮次在「对账通过」后**整表清**（kvRemove）。
 *
 * 这两处的写**没有互斥**，而上传轮次的「对账」用的是**轮次开始时的快照**：
 * 一轮上传要跑几秒，期间完全可能有新的改动登记进来 —— 那些 id 不在快照里 ⇒
 * 快照上的对账「对得上」⇒ 轮次判定「都传完了」⇒ 标志被清成 false、
 * 白名单被整表清（连坐抹掉刚登记进来的）⇒ **那次改动永远没人再传**，
 * 而界面报「同步成功」。
 *
 * ── 这条守卫钉的是哪些**不变量** ─────────────────────────────────────────
 * ① 判据层（纯函数，直接单测，不碰 IO）：
 *    · 消费的上界是「轮次开始时的快照」⇒ 晚到的登记绝不会被消费；
 *    · 「还要不要保留待传」由**消费后的残余**决定，不由快照决定；
 *    · 消费失败 ⇒ 按「还有东西没传完」处理（fail-closed）。
 * ② 接线层：上传轮次走「按确认逐条消费」，**不许**再整表清；
 *    待传标志按残余置位；「还有没传完」是**派生**值（标志 or 白名单非空）。
 * ③ 命令层：登记必须 **await**（否则 SW 在两条写之间被回收就丢登记），
 *    且必须落在**单写者队列内**（否则与上传轮次交错）。
 * ④ 诚实性：残余非空 ⇒ 结果必须带上「还没传完」这个事实（不许报成功）。
 *
 * ⚠️ 判据要钉**行为/接线**，不钉变量名与整句文案 ——
 * 换一种等价写法不许误报（见同目录的 registrySettleRaceMutation.test.ts：
 * 那里有「等价改写 ⇒ 必须仍然绿」的用例）。
 */
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
  resolve(dirname(fileURLToPath(import.meta.url)), '../_alias-loader.mjs')
).href;

const read = (rel: string) =>
  readFile(resolve(dirname(fileURLToPath(import.meta.url)), '../..', rel), 'utf8');

/**
 * 去掉注释，只留**代码**。
 *
 * 为什么必须有：守卫要回答的是「实现做了什么」，而注释里常常**提到**
 * 那个被禁止的写法（说明「原来是这样、现在不是」）。不剥注释的话，
 * 「代码里不许出现 X」这条断言会被注释里的 X 误判成违规。
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

before(async () => {
  register(LOADER_PATH);
});

// ════════════════════════════════════════════════════════════════════
// ① 判据层：纯函数
// ════════════════════════════════════════════════════════════════════

describe('DS-43-19 判据层：消费与「还有没传完」', () => {
  it('消费的上界是「轮次开始时的快照」—— 晚到的登记绝不会被消费掉', async () => {
    const { decideConsumableRegistryIds } = await import('@/core/uploadCoverage');
    // 轮次开始时快照里有 a；轮次期间又登记了 b（不在快照里）。
    const consumable = decideConsumableRegistryIds({
      snapshotIds: ['a'],
      settledIds: ['a', 'b'],
      submittedFullScope: false,
    });
    assert.deepEqual(
      consumable,
      ['a'],
      'b 是轮次期间才登记的 ⇒ 不在快照里 ⇒ 绝不能被这一轮消费掉'
    );
    assert.ok(
      !consumable.includes('b'),
      '消费结果必须永远是快照的子集（这条是整条修复的支点）'
    );
  });

  it('非全量时只消费「本轮真的结案」的那些', async () => {
    const { decideConsumableRegistryIds } = await import('@/core/uploadCoverage');
    assert.deepEqual(
      decideConsumableRegistryIds({
        snapshotIds: ['a', 'b', 'c'],
        settledIds: ['a', 'c'],
        submittedFullScope: false,
      }),
      ['a', 'c'],
      '没结案的那个必须留在队列里等下一轮'
    );
  });

  it('全量提交时整份快照都算结案（会话已被删的陈旧 id 不得永远卡住队列）', async () => {
    const { decideConsumableRegistryIds } = await import('@/core/uploadCoverage');
    assert.deepEqual(
      decideConsumableRegistryIds({
        snapshotIds: ['a', 'gone'],
        settledIds: ['a'],
        submittedFullScope: true,
      }),
      ['a', 'gone'],
      '本机每个活跃会话都上去了 ⇒ 快照里剩下的（会话已不存在）也没得再传'
    );
  });

  it('「还要不要保留待传」由消费后的**残余**决定，不由快照决定', async () => {
    const { decidePendingAfterRegistryConsume } = await import('@/core/uploadCoverage');
    assert.equal(
      decidePendingAfterRegistryConsume({ residualIds: ['late-1'] }).keepPending,
      true,
      '消费后还剩下东西 ⇒ 必须保留待传（下一轮接着传）'
    );
    assert.equal(
      decidePendingAfterRegistryConsume({ residualIds: [] }).keepPending,
      false,
      '消费后空了 ⇒ 可以清待传'
    );
    assert.equal(
      decidePendingAfterRegistryConsume({ residualIds: [], consumeFailed: true }).keepPending,
      true,
      '消费失败 ⇒ 不知道白名单什么样 ⇒ 按「还有东西没传完」处理（fail-closed）'
    );
  });
});

// ════════════════════════════════════════════════════════════════════
// ② 接线层
// ════════════════════════════════════════════════════════════════════

describe('DS-43-19 接线层：上传轮次怎么结案', () => {
  it('上传轮次走「按确认逐条消费」，不许再整表清白名单', async () => {
    const engine = stripComments(await read('src/services/syncEngine.ts'));
    assert.match(
      engine,
      /consumePendingUploadGroupIds\(/,
      '结案必须走「按确认逐条消费」'
    );
    assert.doesNotMatch(
      engine,
      /await storage\.clearPendingUploadGroupIds\(\)/,
      '引擎里不许整表清（会把本轮期间才登记进来的改动连坐抹掉）'
    );
  });

  it('待传标志由「消费后的残余」置位（不是无条件清）', async () => {
    const engine = stripComments(await read('src/services/syncEngine.ts'));
    // 判据是「残余非空 ⇒ 保留」。这里钉**接线**：清位必须发生在
    // 「消费 + 算残余」之后，且清位的结果来自那个判据。
    const consumeAt = engine.indexOf('consumePendingUploadGroupIds(');
    assert.ok(consumeAt > 0, '找不到消费调用');
    const after = engine.slice(consumeAt, consumeAt + 1200);
    assert.match(
      after,
      /setPendingUpload\(/,
      '消费之后必须按残余重新置位（不能在消费之前就无条件清掉）'
    );
    assert.ok(
      !/setPendingUpload\(false\)/.test(engine),
      '不许再出现「无条件清标志」——清位必须由残余判据给出'
    );
  });

  it('存储层的消费是「读-改-写」而不是「删键」', async () => {
    const storageSrc = stripComments(await read('src/utils/storage.ts'));
    const start = storageSrc.indexOf('async consumePendingUploadGroupIds');
    assert.ok(start > 0, '找不到按确认消费的存储方法');
    const rest = storageSrc.slice(start);
    const nextMethod = rest.indexOf('\n  async ', 1);
    const fn = nextMethod > 0 ? rest.slice(0, nextMethod) : rest;
    // 「只移除点名的那些」是**行为**（由同目录的运行时回归测：晚到的登记
    // 必须活下来），这里只钉**形状**：先读、再写回剩下的 ⇒ 读-改-写。
    // 盲删键（不读直接删）会让「读之后才登记进来的」被连坐抹掉。
    const getAt = fn.indexOf('kvGet');
    const setAt = fn.indexOf('kvSet');
    const removeAt = fn.indexOf('kvRemove');
    assert.ok(getAt > 0, '必须先读当前队列（读-改-写，不是盲删键）');
    assert.ok(setAt > getAt, '读完之后必须把「剩下的那批」写回去');
    assert.ok(removeAt > getAt, '删键（队列空了的那种情况）也必须在读之后');
  });

  it('「还有没传完的东西」是派生值（标志 or 白名单非空）', async () => {
    const storageSrc = await read('src/utils/storage.ts');
    const start = storageSrc.indexOf('async getPendingUpload()');
    assert.ok(start > 0, '找不到 getPendingUpload');
    const rest = storageSrc.slice(start);
    const nextMethod = rest.indexOf('\n  async ', 1);
    const fn = nextMethod > 0 ? rest.slice(0, nextMethod) : rest;
    assert.match(
      fn,
      /flagged[\s\S]{0,200}hasPendingUploadRegistryIds\(\)/,
      '读待传标志时必须一并看白名单（标志会被并发写覆盖，白名单才是真相源）'
    );
    // 白名单读失败必须抛（不许替用户猜「没有待传」）。
    const helperAt = storageSrc.indexOf('hasPendingUploadRegistryIds');
    assert.ok(helperAt > 0, '找不到白名单读法');
    const helper = storageSrc.slice(helperAt, helperAt + 900);
    assert.doesNotMatch(
      helper,
      /catch\s*\{[^}]*return false/,
      '读白名单失败不许静默当成「没有待传」'
    );
  });
});

// ════════════════════════════════════════════════════════════════════
// ③ 命令层：登记必须落盘，且必须落在单写者队列内
// ════════════════════════════════════════════════════════════════════

describe('DS-43-19 命令层：登记必须 await', () => {
  it('保存 / 重命名 / 加锁 / 导入四条分支都 await 了登记', async () => {
    const src = await read('src/background/mutationHandlers.ts');
    // 找每个分支里第一次出现的 scheduleUpload 调用，要求它被 await。
    const branches = ['saveGroup', 'renameGroup', 'toggleGroupLock', 'importGroups'];
    for (const branch of branches) {
      const at = src.indexOf(`case '${branch}'`);
      assert.ok(at > 0, `找不到分支 ${branch}`);
      const nextCase = src.indexOf('case ', at + 10);
      const block = src.slice(at, nextCase > 0 ? nextCase : at + 3000);
      const call = block.match(/scheduleUpload\(/);
      assert.ok(call, `分支 ${branch} 里没有 scheduleUpload 调用`);
      const callAt = block.indexOf('scheduleUpload(');
      const before = block.slice(Math.max(0, callAt - 40), callAt);
      assert.match(
        before,
        /await\s*$/,
        `分支 ${branch} 的登记必须 await（否则登记还在飞行中命令就返回了，` +
          '那一轮上传会既看不到它、又把它连坐清掉）'
      );
    }
  });

  it('SW 的两条保存路径把登记放进单写者队列内（与上传轮次不可能交错）', async () => {
    const src = await read('src/background/TabManager.ts');
    for (const job of ['saveAllTabs', 'saveCurrentTab']) {
      const at = src.indexOf(`enqueue('${job}'`);
      assert.ok(at > 0, `找不到队列任务 ${job}`);
      const end = src.indexOf('}, { priority:', at);
      assert.ok(end > at, `找不到 ${job} 的队列任务边界`);
      const block = src.slice(at, end);
      assert.match(
        block,
        /await syncEngine\.scheduleUpload\(/,
        `${job} 的登记必须在队列内 await（与上传轮次串行 ⇒ 不会交错）`
      );
    }
  });
});
