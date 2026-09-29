// 回归：删除广播队列的「内存兜底」不得被一次无关的成功清队抹掉。
//
// 【缺陷本体】pendingDeleteIds 是组删除唯一的跨设备广播载体（1.22.0 起无墓碑、
// 无回收站，删除即物理移除）。队列有两个来源：KV 持久化队列 + unsyncedDeleteIds
// 进程内兜底（KV 写失败时先内存兜住再抛错，getPendingDeleteIds 把两者合并返回）。
// 而 clearPendingDeleteIds 原实现是「删 KV 键 + 无条件清空整个内存集合」。
//
// 【为什么这是永久丢失事故】一轮上传的周期里队列还在继续长：
//   t0 上传读走队列（内容 = A）
//   t1 用户删了 B，B 的 KV 写失败 → 只进了内存兜底（本地组已物理删除）
//   t2 本轮只有 A 广播成功（读回确认）→ clearPendingDeleteIds 把 B 一起清掉
//   结果：B 的删除意图彻底蒸发，云端那行仍是活跃行 → 任何设备下次合并
//         （mergeOpStamped 的 cg && !lg）把整组加回来，而用户已经删过一次、
//         没有回收站、无人值守复活，全程零提示。
//
// 【修法】清队从「清空」改成「按确认消费」：调用方点名本轮真正广播成功的 id，
// 没点名的（没读到 / 没广播成功 / 读队列之后才登记的）一律留在队列里等下一轮。
//
// 环境桩沿用 tests/storageWriteFreshness.test.ts 的骨架：无 indexedDB 时
// storageAdapter 回退到 localStorage 驱动，这里给该驱动的 setItem/removeItem
// 加按键注入故障，用来复现「KV 写失败」这条唯一会触发内存兜底的路径。

import { describe, it, before, beforeEach } from 'node:test';
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

// ── 环境桩：localStorage（无 indexedDB → KV 走 localStorage 驱动）──────────
// 故障注入只针对显式登记的键（'pending_delete_ids'）；isLocalStorageAvailable()
// 的探针键 '__tv_test__' 不受影响。
const KV_DELETE = 'pending_delete_ids';
const failKeys = new Set<string>();
const lsData = new Map<string, string>();

const localStorageStub = {
  get length() { return lsData.size; },
  key: (i: number) => [...lsData.keys()][i] ?? null,
  getItem: (k: string) => (lsData.has(k) ? (lsData.get(k) as string) : null),
  setItem: (k: string, v: string) => {
    if (failKeys.has(k)) throw new Error(`simulated write failure: ${k}`);
    lsData.set(k, String(v));
  },
  removeItem: (k: string) => {
    if (failKeys.has(k)) throw new Error(`simulated write failure: ${k}`);
    lsData.delete(k);
  },
  clear: () => lsData.clear(),
};
(globalThis as Record<string, unknown>).window = { localStorage: localStorageStub };
(globalThis as Record<string, unknown>).localStorage = localStorageStub;
(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    },
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
};

let storage: typeof import('../src/utils/storage.ts').storage;
let kvGet: typeof import('../src/storage/storageAdapter.ts').kvGet;

/** 断言队列内容（集合语义，不钉顺序与重复次数）。 */
function assertSameIds(actual: readonly string[], expected: string[], msg: string): void {
  assert.deepEqual(
    [...new Set(actual)].sort(),
    [...new Set(expected)].sort(),
    `${msg}（实际读到 ${JSON.stringify(actual)}）`,
  );
}

/** 让 addPendingDeleteId 因 KV 写失败而抛错，并把 id 推进内存兜底。 */
async function registerDeleteIntentWithKvFailure(id: string): Promise<void> {
  failKeys.add(KV_DELETE);
  let rejected = false;
  try {
    await storage.addPendingDeleteId(id);
  } catch {
    rejected = true;
  } finally {
    failKeys.delete(KV_DELETE);
  }
  assert.equal(rejected, true, `id=${id} 的 KV 写应当失败并抛错（登记不上 = 删除被静默撤销）`);
}

/** 清空 KV 队列与模块级内存兜底，保证用例之间互不污染（故障注入下不可用）。 */
async function resetQueue(): Promise<void> {
  const current = await storage.getPendingDeleteIds();
  await storage.clearPendingDeleteIds(current);
  assert.deepEqual(await storage.getPendingDeleteIds(), [], '用例前置：队列已清空');
}

before(async () => {
  register(LOADER_PATH, import.meta.url);
  ({ storage } = await import('../src/utils/storage.ts'));
  // 只解构 kvGet：写路径一律走 storage.addPendingDeleteId（那才是被测对象），
  // 直接调 kvSet 反而会绕过被测代码。原先这里也解构了 kvSet，但从没被读过。
  ({ kvGet } = await import('../src/storage/storageAdapter.ts'));
  // 预热版本号写入，之后的故障注入窗口里只剩删除队列这一处写操作
  await storage.getPendingDeleteIds();
});

beforeEach(async () => {
  await resetQueue();
});

describe('删除广播队列 · 内存兜底的持久性', () => {
  it('A：KV 写失败时 id 进内存兜底，getPendingDeleteIds 仍能读到它', async () => {
    await registerDeleteIntentWithKvFailure('group-b');

    assert.deepEqual(
      await kvGet(KV_DELETE),
      null,
      '前置确认：这条意图确实没落盘（只在内存兜底里）',
    );
    assertSameIds(
      await storage.getPendingDeleteIds(),
      ['group-b'],
      '内存兜底必须让下一次上传仍能取到这条删除意图',
    );
  });

  it('B（回归钉子）：只广播成功 A 时清队，没广播成功的 B 必须留在队列里', async () => {
    // t0：A 已落盘（本轮上传会读到它）
    await storage.addPendingDeleteId('group-a');
    // t1：用户又删了 B，KV 写失败 → 只进内存兜底，本地组已物理删除
    await registerDeleteIntentWithKvFailure('group-b');

    // t2：上传周期读到队列（含兜底）
    const batch = await storage.getPendingDeleteIds();
    assertSameIds(batch, ['group-a', 'group-b'], '前置确认：本轮读到的队列含 A 与 B');

    // 本轮只有 A 读回确认广播成功
    await storage.clearPendingDeleteIds(['group-a']);

    assertSameIds(
      await storage.getPendingDeleteIds(),
      ['group-b'],
      '没广播成功的删除意图必须留在队列里等下一轮；被连坐清掉 = 该组下次合并整组复活且无回收站可找回',
    );
  });

  it('C：广播成功的 A 被清掉，不会被重复广播', async () => {
    await storage.addPendingDeleteId('group-a');
    await storage.addPendingDeleteId('group-b');
    const batch = await storage.getPendingDeleteIds();
    assertSameIds(batch, ['group-a', 'group-b'], '前置确认：两条意图都在队列里');

    await storage.clearPendingDeleteIds(batch);

    assert.deepEqual(
      await kvGet(KV_DELETE),
      null,
      '整批确认成功时持久化队列必须真正落定（键消失，而不是留一个空数组）',
    );
    assert.deepEqual(
      await storage.getPendingDeleteIds(),
      [],
      '已确认广播的意图不得残留导致重复广播（重复 UPDATE 同一行会与严格 LT 守卫打架）',
    );
  });

  it('C2：确认清单只覆盖持久化部分时，内存兜底里被点名的 id 一并消失', async () => {
    await storage.addPendingDeleteId('group-a');
    await registerDeleteIntentWithKvFailure('group-b');
    assertSameIds(
      await storage.getPendingDeleteIds(),
      ['group-a', 'group-b'],
      '前置确认：A 落盘、B 在内存',
    );

    await storage.clearPendingDeleteIds(['group-a', 'group-b']);

    assert.deepEqual(
      await storage.getPendingDeleteIds(),
      [],
      '被点名的 id 不论来自 KV 还是内存兜底都必须真正出队',
    );
  });

  it('D：清队时 KV 写失败必须抛错，且 KV 队列与内存兜底都原样保留', async () => {
    await storage.addPendingDeleteId('group-a');
    await registerDeleteIntentWithKvFailure('group-b');

    failKeys.add(KV_DELETE);
    let rejected = false;
    try {
      await storage.clearPendingDeleteIds(['group-a', 'group-b']);
    } catch {
      rejected = true;
    } finally {
      failKeys.delete(KV_DELETE);
    }

    assert.equal(rejected, true, '清队列失败必须抛错（清不掉也当清掉了 = 删除被下一次上传静默吞掉）');
    assert.deepEqual(
      await kvGet(KV_DELETE),
      ['group-a'],
      '清队列失败必须保留 KV 内容供下轮重试',
    );
    assertSameIds(
      await storage.getPendingDeleteIds(),
      ['group-a', 'group-b'],
      '清队列失败时内存兜底也不能被动（否则这轮白广播，意图还丢了）',
    );
  });

  it('E：读队列之后才登记的条目（哪怕已落 KV）不被连坐删除', async () => {
    await storage.addPendingDeleteId('group-a');
    // 模拟「读走队列之后、广播之前」发生的新登记：这一轮根本没广播过它
    const batch = await storage.getPendingDeleteIds();
    await storage.addPendingDeleteId('group-late');

    await storage.clearPendingDeleteIds(batch);

    assert.deepEqual(
      await kvGet(KV_DELETE),
      ['group-late'],
      '清队必须按确认清单消费，而不是删掉整个键（后者会把本轮没广播的条目一起吃掉）',
    );
    assertSameIds(
      await storage.getPendingDeleteIds(),
      ['group-late'],
      '未确认的条目必须继续可读，直到某一轮真的广播成功',
    );
  });

  it('F：确认清单里的非字符串条目被忽略（不污染兜底集合，也不误删）', async () => {
    await storage.addPendingDeleteId('group-a');

    await storage.clearPendingDeleteIds([undefined as unknown as string, 'group-a']);

    assert.deepEqual(
      await storage.getPendingDeleteIds(),
      [],
      '合法 id 照常出队；非法条目被忽略而不是让整次清队崩掉',
    );
  });
});
