// 覆盖下载的删除熔断守卫（DS-2：一次覆盖能物理清空本机任意多会话）。
//
// ── 这个文件在防什么回归 ────────────────────────────────────────────────
//
// 「从云端下载（覆盖）」的语义是「云端完全镜像本机」：本机会话被云端那份替换。
// v1.22.0 起删除即物理清除、无回收站、无撤销 ⇒ 一次覆盖能清掉任意多会话。
//
// 缺陷本体（**结构性的**，不是某个写错了的数）：
//   1. 覆盖路径在合并**之前**就把 localGroups 过滤成「只留下云端读不出来的那几组」
//      ⇒ 被云端替换掉的本机会话**压根没进合并结果**；
//   2. 删除熔断的实参取的是「合并时空壳剔除了几个」（mergeDropped）
//      ⇒ 覆盖场景下那个数**恒为 0**；
//   3. 熔断拿到 deleteCount=0 ⇒ `deleteCount <= 0` 直接放行。
// ⇒ 「本机 50 条、云端只读到 1 条」时，一次覆盖就物理清空 49 条：
//   无提示、无撤销、无回收站，界面还报「覆盖成功」。
//
// ── 为什么钉「不变量」而不是钉字面量 ─────────────────────────────────────
//
// 这条修法的正确形态有多种（实参叫什么名字、判据放在闸门还是放在熔断），
// 钉死某一种写法会让守卫变成负担，而**改坏**（回到「熔断看不见这次覆盖」）
// 一定会红。所以：
//   · 纯函数层：钉「覆盖会清掉多少个会话」这个数本身；
//   · 结构层：钉「熔断的实参来源」这个接线关系（不钉变量名）；
//   · 行为层：真引擎 + 假云端跑完整流程，钉**用户的数据会怎样**。
//
// 行为层是真正有检测力的那一层：把实现改回缺陷写法（熔断实参换回
// mergeDropped.length），下面「本机 50 条、云端 1 条 ⇒ 必须被拒绝」立刻变红。
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  installFakeSyncBackend,
  resetFakeSyncBackend,
  type FakeSyncBackendHandle,
} from '../_helpers/fakeSyncBackend.ts';
import { installEngineStorageEnv, mkGroup } from '../_helpers/engineStorageEnv.ts';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOADER_PATH = pathToFileURL(resolve(ROOT, 'tests/_alias-loader.mjs')).href;

const env = installEngineStorageEnv();

if (!process.env.VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const { planOverwriteDeletion } = await import('@/core/overwriteGuard');
const { checkDeleteFailsafe } = await import('@/sync-backend/failsafe');
const { decideForceRemoteOverwrite } = await import('@/core/syncDecision');

/** n 个 id（local-0 … local-(n-1)）。 */
const ids = (n: number, prefix = 'g') => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

// ══════════════════════════════════════════════════════════════════════════
// 一、纯函数层：覆盖会清掉本机多少个会话
// ══════════════════════════════════════════════════════════════════════════

describe('覆盖删除计划：这次覆盖会清掉本机多少个会话', () => {
  it('本机 50 条、云端只有 1 条 ⇒ 清掉 49 条（缺陷形态下这里是 0，熔断因此看不见）', () => {
    const plan = planOverwriteDeletion({
      localActiveIds: ids(50),
      survivingActiveIds: ['g-0'],
      cloudTombstoneIds: [],
    });
    assert.equal(plan.beforeActive, 50);
    assert.equal(plan.wouldDelete, 49, '被云端替换掉的本机会话就是这次覆盖的删除量');
    assert.equal(plan.deletedIds.length, 49);
  });

  it('覆盖前后是同一批会话 ⇒ 清掉 0 条（正常覆盖不能被拦死）', () => {
    const plan = planOverwriteDeletion({
      localActiveIds: ids(50),
      survivingActiveIds: ids(50),
      cloudTombstoneIds: [],
    });
    assert.equal(plan.wouldDelete, 0, '同一批会话只是内容换成了云端那份，不是删除');
    assert.equal(plan.survivedActive, 50);
  });

  it('云端只带新会话过来（30 本机 + 20 云端新增）⇒ 仍要清掉 20 条', () => {
    // ⚠️ 这一条守的是「**集合差**而不是计数差」：
    //   计数差 = 50 − 50 = 0 ⇒ 熔断放行 ⇒ 而本机那 30 条之外的 20 条
    //   （L31…L50）其实**会被清掉**。计数差把「云端带来的新会话」当成对冲，
    //   会少报 ⇒ 熔断形同虚设。
    const plan = planOverwriteDeletion({
      localActiveIds: ids(50),
      survivingActiveIds: [...ids(30), ...ids(20, 'new')],
      cloudTombstoneIds: [],
    });
    assert.equal(plan.wouldDelete, 20, '云端带来的新会话不能对冲掉本机被清掉的会话');
  });

  it('删除数永不为负（云端比本机多时是 0，不是负数）', () => {
    const plan = planOverwriteDeletion({
      localActiveIds: ids(3),
      survivingActiveIds: ids(10),
      cloudTombstoneIds: [],
    });
    assert.equal(plan.wouldDelete, 0);
    assert.ok(plan.wouldDelete >= 0, '负的删除数会让下游判据读不懂（也因此不得改成 beforeActive − afterActive 的裸差）');
  });

  it('删除数不会超过覆盖前的会话数', () => {
    const plan = planOverwriteDeletion({
      localActiveIds: ids(7),
      survivingActiveIds: [],
      cloudTombstoneIds: [],
    });
    assert.equal(plan.wouldDelete, 7);
    assert.ok(plan.wouldDelete <= plan.beforeActive);
  });

  it('云端墓碑（别的设备显式删掉的）不计入删除量 —— 合法清空必须能传播', () => {
    // ⚠️ 这一条是**承重**的：云端只有墓碑行 = 另一台设备把会话都删了，
    //   本机必须收敛到空。若把墓碑造成的消失也算进删除数，删 10 个会话
    //   （100% > 20% 阈值）就会被熔断拦下 ⇒ 用户在 A 设备删掉的会话
    //   永远传不到 B 设备 ⇒ 「删不掉」。
    const plan = planOverwriteDeletion({
      localActiveIds: ids(10),
      survivingActiveIds: [],
      cloudTombstoneIds: ids(10),
    });
    assert.equal(plan.wouldDelete, 0, '墓碑是显式删除的证据，不是「云端没读到」');
  });

  it('重复 id 只算一次（事实清单可能重复）', () => {
    const plan = planOverwriteDeletion({
      localActiveIds: ['a', 'a', 'b'],
      survivingActiveIds: ['a'],
      cloudTombstoneIds: [],
    });
    assert.equal(plan.beforeActive, 2);
    assert.equal(plan.wouldDelete, 1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 二、纯函数层：把删除量喂给熔断（阈值沿用 failsafe.ts，不另发明）
// ══════════════════════════════════════════════════════════════════════════

describe('熔断裁决：覆盖的删除量必须真的进得了熔断', () => {
  const verdictFor = (localCount: number, surviving: string[], tombstones: string[] = []) => {
    const plan = planOverwriteDeletion({
      localActiveIds: ids(localCount),
      survivingActiveIds: surviving,
      cloudTombstoneIds: tombstones,
    });
    return { plan, verdict: checkDeleteFailsafe(plan.beforeActive, plan.wouldDelete) };
  };

  it('本机 50 条、云端 1 条 ⇒ 熔断必须拒绝', () => {
    const { verdict } = verdictFor(50, ['g-0']);
    assert.equal(verdict.allowed, false, '49/50 = 98% 远超 20% 阈值，必须拦下');
    assert.ok(verdict.reason && verdict.reason.length > 0, '必须给出可读原因（给用户看）');
    assert.match(verdict.reason!, /49/, '原因里要点明会删多少个会话');
  });

  it('覆盖前后条数相同（同一批会话）⇒ 熔断放行（不能把正常覆盖也拦死）', () => {
    const { verdict } = verdictFor(50, ids(50));
    assert.equal(verdict.allowed, true, '没删任何东西就不该熔断');
  });

  it('云端合法清空（全是墓碑行）⇒ 熔断放行，删除照常传播', () => {
    const { verdict } = verdictFor(10, [], ids(10));
    assert.equal(verdict.allowed, true, '显式删除不是「误删」，熔断不能拦它（否则用户删不掉）');
  });

  it('云端真的为空 ⇒ 按现有口径处理（空云端闸门拒绝，不靠熔断兜底）', () => {
    const gate = decideForceRemoteOverwrite({ localActiveCount: 50, cloudTotalCount: 0 });
    assert.equal(gate.action, 'refuse', '云端一个字节都没有 ⇒ 既有口径就是拒绝覆盖');
    assert.equal(gate.action === 'refuse' ? gate.code : '', 'empty_cloud');
  });

  it('云端只有墓碑行（合法清空）⇒ 空云端闸门放行', () => {
    // 判据是「云端总行数（含墓碑）」而不是「云端活跃行数」——
    // 否则删除永远传不过来，对端留一份永不收敛的僵尸副本。
    const gate = decideForceRemoteOverwrite({ localActiveCount: 10, cloudTotalCount: 10 });
    assert.equal(gate.action, 'proceed', '云端有行（只是都是墓碑）⇒ 不是「云端为空」');
  });

  it('闸门拿到「这次覆盖会清掉多少个会话」后也能拦住「云端只读到一部分」（DS-2 的第二道门）', () => {
    const plan = planOverwriteDeletion({
      localActiveIds: ids(50),
      survivingActiveIds: ['g-0'],
      cloudTombstoneIds: [],
    });
    const gate = decideForceRemoteOverwrite({
      localActiveCount: plan.beforeActive,
      cloudTotalCount: 1, // 云端不是空的（只读到 1 条）⇒ 空云端闸门放行
      overwriteDeletion: { beforeActive: plan.beforeActive, wouldDelete: plan.wouldDelete },
    });
    assert.equal(gate.action, 'refuse', '云端只读到一部分 ⇒ 覆盖必须被拦下');
    assert.equal(gate.action === 'refuse' ? gate.code : '', 'delete_too_many');
  });

  it('闸门的删除量判据用的是 failsafe.ts 的那一份阈值（不是另写一套比例）', () => {
    // 两处各写一遍比例判据 = 同判据两处漂移的起点（这个仓库反复踩过）。
    // 这里钉的是「闸门用的就是 failsafe 那个函数」：把阈值改成别的口径必红。
    const gateVerdict = decideForceRemoteOverwrite({
      localActiveCount: 10,
      cloudTotalCount: 3,
      overwriteDeletion: { beforeActive: 10, wouldDelete: 3 },
    });
    // 3/10 = 30% > 20%（且总数 > 5）⇒ 按 failsafe.ts 的口径必须拒绝。
    assert.equal(gateVerdict.action, 'refuse');
    assert.equal(gateVerdict.action === 'refuse' ? gateVerdict.code : '', 'delete_too_many');
  });

  it('比例判据在覆盖路径上同样生效（不只对大库才拦）', () => {
    // 6 条本机、云端 1 条 ⇒ 5/6 = 83% > 20%（且总数 6 > minTotal 5）⇒ 拒绝。
    // 破了会怎样：覆盖路径若绕过比例判据，只有「绝对量大」那一条还在
    //   ⇒ 小库的一次覆盖就能清空本机，而用户毫无提示。
    const plan = planOverwriteDeletion({
      localActiveIds: ids(6),
      survivingActiveIds: ['g-0'],
      cloudTombstoneIds: [],
    });
    const gate = decideForceRemoteOverwrite({
      localActiveCount: plan.beforeActive,
      cloudTotalCount: 1,
      overwriteDeletion: { beforeActive: plan.beforeActive, wouldDelete: plan.wouldDelete },
    });
    assert.equal(gate.action, 'refuse', '6 条本机被清掉 5 条 = 83%，必须拦下');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 三、结构层：熔断的实参来源
// ══════════════════════════════════════════════════════════════════════════

/** 取某个调用点的实参文本（按括号配平，不靠正则猜）。 */
function callArgs(src: string, at: number): string {
  const open = src.indexOf('(', at);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return '';
}

describe('结构层：两道闸门的删除数实参来源', () => {
  const SRC = readFileSync(resolve(ROOT, 'src/services/syncEngine.ts'), 'utf8');
  const DECISION_SRC = readFileSync(resolve(ROOT, 'src/core/syncDecision.ts'), 'utf8');

  /**
   * 找出「覆盖路径上喂给熔断的删除数」这个值在源码里的写法（每一处）。
   *
   * 两种落法都算：
   *   形态 A：引擎把覆盖删除计划的结果交给闸门（`wouldDelete: plan.wouldDelete`）；
   *   形态 B：闸门自己从引擎传来的覆盖删除计划里取
   *           （`input.overwriteDeletion.wouldDelete`）。
   * 两处都必须**取自计划的 wouldDelete**，不能是字面量、不能是 mergeDropped.length。
   */
  const overwriteDeletionArgs = (): string[] => {
    const out: string[] = [];
    for (const m of SRC.matchAll(/wouldDelete:\s*([^,\n}]+)/g)) out.push(m[1].trim());
    for (const _m of DECISION_SRC.matchAll(/overwriteDeletion\.wouldDelete/g)) {
      out.push('overwriteDeletion.wouldDelete');
    }
    return out;
  };

  it('至少两个熔断调用点：合并剔除一道、覆盖清空一道', () => {
    // 缺陷形态只有**一个**调用点，而它的实参是 mergeDropped.length ——
    // 覆盖路径下那个数恒为 0 ⇒ 熔断看不见这次覆盖。
    // 破了会怎样：改回单一调用点 = 覆盖路径重新变成「熔断看不见」。
    const callSites = [...SRC.matchAll(/checkDeleteFailsafe\(/g)];
    assert.ok(
      callSites.length >= 2,
      `覆盖路径必须有一道自己的熔断（当前只有 ${callSites.length} 个调用点）—— ` +
        '合并剔除量在覆盖路径下恒为 0，它看不见这次覆盖',
    );
  });

  it('有一道熔断的删除数实参与 mergeDropped 无关（即覆盖路径那道）', () => {
    // 钉的是**来源关系**而不是变量名：变量改名不该让守卫变红，
    // 而「实参换回 mergeDropped.length」必须变红。
    // 缺陷形态下只有一个调用点、且它的实参就是 mergeDropped.length ⇒ 这里必红。
    const callSites = [...SRC.matchAll(/checkDeleteFailsafe\(/g)].map(m => ({
      at: m.index!,
      args: callArgs(SRC, m.index!),
    }));
    const overwriteCall = callSites.find(c => !/mergeDropped/.test(c.args));
    assert.ok(
      overwriteCall,
      '必须有一道熔断，其删除数实参不是 mergeDropped —— ' +
        `那是「合并剔除量」，覆盖路径下恒为 0；现有实参：` +
        callSites.map(c => c.args.replace(/\s+/g, ' ')).join(' | '),
    );
    assert.ok(
      SRC.includes('planOverwriteDeletion'),
      '覆盖路径的删除数必须由覆盖删除计划算出来（core/overwriteGuard.ts）',
    );
  });

  it('覆盖路径的熔断总数实参不是合并结果的活跃组数', () => {
    // 分母不同 = 百分比也不同：合并剔除量的分母是「合并结果里的活跃组数」，
    // 覆盖清空量的分母必须是「覆盖前本机活跃会话数」——
    // 否则「删了多少 / 什么」这句话会说假话（用户看到的百分比是错的）。
    const callSites = [...SRC.matchAll(/checkDeleteFailsafe\(/g)].map(m => ({
      at: m.index!,
      args: callArgs(SRC, m.index!),
    }));
    const overwriteCall = callSites.find(c => !/mergeDropped/.test(c.args));
    assert.ok(overwriteCall);
    assert.ok(
      !/mergedGroups/.test(overwriteCall!.args),
      '覆盖路径的总数实参不得是合并结果的活跃组数（那是合并剔除量的分母）',
    );
  });

  it('熔断仍然发生在写入之前（中止 = 本机一个字节都没动）', () => {
    const failsafeAt = SRC.indexOf('checkDeleteFailsafe(');
    const writeAt = SRC.indexOf('await storage.setGroupsImmediate(finalGroups)');
    assert.ok(failsafeAt > 0 && writeAt > 0);
    assert.ok(failsafeAt < writeAt, '熔断必须在写入之前');
  });

  it('**每一处**覆盖删除数都来自覆盖删除计划（不是写死的数）', () => {
    // ⚠️ 变异实测（这条是补上去的）：
    //   把其中一处 wouldDelete 换成字面量 0（等于那一道不设防）时，
    //   只靠「实参不是 mergeDropped」是抓不住的 —— 0 也「不是 mergeDropped」。
    //   而「两处都来自计划对象」这条会抓得住。
    // 破了会怎样：那一道形同不存在 ⇒ 用户点一次覆盖就能清空本机任意多会话，
    //   而另一道还挡着（用户会以为自己被保护了，其实是运气好）。
    //
    // 钉的是「`<某个对象>.wouldDelete`」这种形状（不钉变量名）：
    // 变量改名不该让守卫变红，换成字面量或 mergeDropped.length 必须变红。
    const args = overwriteDeletionArgs();
    assert.ok(
      args.length >= 2,
      `闸门与熔断两处的删除数都必须来自覆盖删除计划（planOverwriteDeletion 的 wouldDelete），` +
        `当前只有 ${args.length} 处：${args.join(' | ')}`,
    );
    for (const arg of args) {
      assert.ok(
        /\.wouldDelete$/.test(arg),
        `覆盖删除数必须取自覆盖删除计划的 wouldDelete，实得：${arg}`,
      );
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 四、行为层：真引擎 + 假云端跑完整流程
// ══════════════════════════════════════════════════════════════════════════

let backend: FakeSyncBackendHandle;

before(async () => {
  register(LOADER_PATH);
  backend = await installFakeSyncBackend();
  const { storage } = await import('@/utils/storage');
  await storage.setOpStampMigrated(true);
});

after(async () => {
  await resetFakeSyncBackend();
});

beforeEach(async () => {
  env.failReadKeys.clear();
  const { storage, invalidateGroupsCache, DEFAULT_SETTINGS } = await import('@/utils/storage');
  // ⚠️ 必须显式种 syncBackend:'webdav'：读不到设置时引擎会在任何闸门之前
  // 返回 backend_unknown ⇒ 用例变成永远为绿的假通过
  // （同样的坑见 forceRemoteEmptyCloudGate.test.ts）。
  await storage.setSettings({ ...DEFAULT_SETTINGS, syncBackend: 'webdav' });
  invalidateGroupsCache();
  backend.groups = [];
  backend.calls.broadcastDeletes.length = 0;
});

/** 读本地磁盘真值（绕开 30s 缓存）。 */
async function localGroups(): Promise<Array<{ id: string }>> {
  const { storage, invalidateGroupsCache } = await import('@/utils/storage');
  invalidateGroupsCache();
  return storage.getGroups() as never;
}

async function seedLocal(count: number, prefix = 'local') {
  const { storage, invalidateGroupsCache } = await import('@/utils/storage');
  await storage.setGroupsImmediate(
    Array.from({ length: count }, (_, i) => mkGroup(`${prefix}-${i}`)) as never
  );
  invalidateGroupsCache();
}

describe('端到端：覆盖下载真的会拒绝「云端只读到一部分」', () => {
  it('本机 50 条、云端 1 条 ⇒ 覆盖被拒绝，且本机 50 条一个都没少', async () => {
    await seedLocal(50);
    backend.groups = [mkGroup('local-0')] as never;

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.downloadAndMerge({ forceRemote: true });

    assert.equal(result.success, false, '这一轮必须失败（一次覆盖会物理清空 49 条会话）');
    assert.equal(result.reason, 'failsafe_triggered', '必须用「丢弃过多会话」这个原因码');
    assert.ok(
      result.error && /会话/.test(result.error),
      `必须给出用户能看懂的理由（不是一句技术错误码），实得：${result.error ?? '无'}`,
    );
    const after = await localGroups();
    assert.equal(after.length, 50, '拒绝时本地一个字节都不许动（无回收站、不可逆）');
  });

  it('覆盖前后是同一批会话 ⇒ 覆盖正常成功（不能把正常覆盖也拦死）', async () => {
    await seedLocal(50);
    backend.groups = Array.from({ length: 50 }, (_, i) => mkGroup(`local-${i}`)) as never;

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.downloadAndMerge({ forceRemote: true });

    assert.equal(result.success, true, `前提：正常覆盖必须成功（实得：${result.reason ?? '无'}）`);
    const after = await localGroups();
    assert.equal(after.length, 50);
  });

  it('云端合法清空（全是墓碑行）⇒ 覆盖放行，删除照常传播（不能「删不掉」）', async () => {
    await seedLocal(10);
    backend.groups = Array.from({ length: 10 }, (_, i) =>
      mkGroup(`local-${i}`, { isDeleted: true, tabs: [] })
    ) as never;

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.downloadAndMerge({ forceRemote: true });

    assert.equal(
      result.success,
      true,
      `前提：跨设备删除必须能传播（实得：${result.reason ?? '无'}）—— ` +
        '熔断拦下它就等于「用户在 A 设备删掉的会话永远传不到 B 设备」',
    );
    const after = await localGroups();
    assert.equal(after.length, 0, '云端说删了 ⇒ 本机必须收敛到空');
  });

  it('合并模式不受影响：云端 1 条、本机 50 条 ⇒ 合并成功且本机 50 条全在', async () => {
    // 熔断管的是「覆盖」造成的删除。合并模式不拿云端替换本机 ⇒ 不该被拦。
    await seedLocal(50);
    backend.groups = [mkGroup('cloud-only')] as never;

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.downloadAndMerge();

    assert.equal(result.success, true, `前提：合并必须成功（实得：${result.reason ?? '无'}）`);
    const after = await localGroups();
    assert.equal(after.length, 51, '合并模式保留本机全部会话 + 收下云端那一条');
  });
});
