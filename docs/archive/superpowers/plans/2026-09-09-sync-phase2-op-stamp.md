# 同步层重构 阶段二：操作印记 实施计划

> **状态：已完成（2026-09-09），随 v1.19.0 发布。**
> 实际提交对照：Task 1→bfc0966、Task 2→ba2b40b、Task 3→556bf1b、Task 4→fe754e7、
> Task 5→7a0a910、Task 6→ab46dab、Task 7→20c6ae3、Task 8→0cde5ea、Task 9→55c0f0e、
> Task 10→ff9228a、Task 11→104e619（含 legacy 退役 + 版本号）。
> 与计划的偏差：① Task 4/5 因 type-check 强耦合拆为两个紧邻 commit 而非合并；
> ② Task 8/10 合并实施（syncEngine 一次切到 mergeOpStamped + legacy fallback，
> Task 11 删除 fallback）；③ seq 修复仅在「存在本设备印记」时跳号 +100（新设备
> 不无故跳号）；④ §6.2 Web 仪表盘收编与 §8 GC、调试视图、journal 重放引擎留阶段三。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 合并语义从「时间戳 + version LWW」切换为「操作印记全序决胜」（规格 §4/§5），Supabase `tab_groups` 加 `last_op_device`/`last_op_seq` 两列（§6），存量数据与未升级客户端平滑迁移（§7），不引入半自动过渡态（§9 拍板：阶段二合入即生效）。

**Architecture:**
- 实体（TabGroup / Tab）携带 `OpStamp = { d: deviceId, s: number }`；tab 印记只动 tab，组字段（name/displayOrder）跟随组印记，不互相污染。
- 全序比较：`s` 不同比数值；同 `s` 比 `d` 字典序。无时间戳/id 兜底——任一带印记实体必有唯一赢家。
- 写入路径（mutationHandlers）每次 `apply*` 前 `++seq`（设备本地 `seq` 单调计数器），把 `OpStamp` 盖在被子实体；云端下载合并以 `mergeOpStamped()` 全序决胜。
- 本地 journal（write-ahead log）记录最近 1000 条操作条目，崩溃重放幂等；云端上传成功后裁剪条目（保留至被 FIFO 淘汰）。
- Web 仪表盘收编为第三个写入方，自维护设备 ID 与本地 seq，行级 UPDATE 带 `{ d: webDeviceId, s: ++webSeq }`。

**Tech Stack:** TypeScript + node:test（`pnpm test`），chrome.storage（journal + seq + device id 持久化），Supabase（`last_op_device text`、`last_op_seq bigint` 两列 + `tab_groups` 行级 UPDATE 触发器按 stamp 守护）。

**规格：** `docs/superpowers/specs/2026-09-07-sync-single-writer-op-stamp-design.md`（本计划 = 阶段二）。

## Global Constraints

- **不做半自动过渡态**（§9 已拍板）：阶段二合入即切换合并语义。Task 9（新旧 merge 共存临时窗口）是为了测试期可灰度；Task 10 切换到新版本后**删除** `mergeTabGroupsLegacy`，不留运行时分叉。
- 行为保持：与阶段一的 mutationOps 纯函数逐字段一致的验收基准不变；新加的 stamp 字段是**附加**字段（`lastOp?: OpStamp`），不影响既有 thunk 签名、组件 reducer 期望。
- `version` 字段**冻结**（§11）：云端列保留兼容（不再参与判定），不再 bump。
- `validateMergeResult` / `decideDownloadPrecheck` / `UPLOAD_GUARD_MS` 保留（§5.5）—— 它们降级为优化项，不再承重正确性。
- 测试运行：`pnpm test`（= `node --test --experimental-strip-types tests/*.test.ts`）。新测试必须可在该命令下通过，禁止依赖 chrome API / Supabase 客户端（依赖注入或纯函数）。
- 每个 Task 结束必须 `pnpm test` 全绿 + `pnpm type-check` 通过再 commit。
- 提交信息用中文，格式 `feat(sync): ...` / `refactor(sync): ...` / `fix(sync): ...` / `chore(sync): ...`。
- 阶段二改动**不**包含 §8 GC 与调试视图（阶段三）。本计划尾段留出阶段三入口。

---

### Task 1: OpStamp 类型 + 全序比较函数

**Files:**
- Create: `src/utils/opStamp.ts`
- Test: `tests/opStamp.test.ts`

**Interfaces:**
- Produces:
  - `OpStamp = { d: string; s: number }`
  - `compareStamps(a, b): -1 | 0 | 1` —— 全序：`s` 不同按数值；同 `s` 按 `d` 字典序。**无** updatedAt/id 兜底。
  - `isLater(a, b): boolean` —— `compareStamps(a, b) > 0` 的薄包装，UI/合并代码读起来语义更明确。
  - `makeStamp(deviceId, seq): OpStamp` —— 工厂。
  - `EMPTY_STAMP: OpStamp = { d: '', s: 0 }` —— 用于「未带印记」的兜底（迁移前数据），全序视为最小值（`s=0` 且 `d=''`）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/opStamp.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareStamps, isLater, makeStamp, EMPTY_STAMP } from '@/utils/opStamp';

describe('opStamp: 全序比较（§4.2）', () => {
  it('s 不同按数值', () => {
    assert.equal(compareStamps({ d: 'a', s: 2 }, { d: 'a', s: 1 }), 1);
    assert.equal(compareStamps({ d: 'a', s: 1 }, { d: 'a', s: 2 }), -1);
  });
  it('s 相同按 d 字典序', () => {
    assert.equal(compareStamps({ d: 'b', s: 5 }, { d: 'a', s: 5 }), 1);
    assert.equal(compareStamps({ d: 'a', s: 5 }, { d: 'b', s: 5 }), -1);
  });
  it('完全相等 → 0', () => {
    assert.equal(compareStamps({ d: 'a', s: 5 }, { d: 'a', s: 5 }), 0);
  });
  it('字典序对数字字符正确（"device2" < "device10"）', () => {
    // 字典序 vs 数值序不同——规格 §4.2 明确「字符串字典序」，这里钉死避免后续误改成数值。
    assert.equal(compareStamps({ d: 'device10', s: 1 }, { d: 'device2', s: 1 }), 1);
  });
  it('EMPTY_STAMP 是全序最小值', () => {
    assert.equal(compareStamps(EMPTY_STAMP, { d: 'a', s: 1 }), -1);
    assert.equal(compareStamps({ d: 'a', s: 1 }, EMPTY_STAMP), 1);
    assert.equal(compareStamps(EMPTY_STAMP, EMPTY_STAMP), 0);
  });
  it('isLater 是 compareStamps > 0 的薄包装', () => {
    assert.equal(isLater({ d: 'b', s: 1 }, { d: 'a', s: 1 }), true);
    assert.equal(isLater({ d: 'a', s: 1 }, { d: 'a', s: 1 }), false);
  });
  it('makeStamp 工厂', () => {
    assert.deepEqual(makeStamp('dev', 7), { d: 'dev', s: 7 });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test 2>&1 | grep -A2 opStamp`
Expected: FAIL（找不到 `@/utils/opStamp`）

- [ ] **Step 3: 最小实现**

```ts
// src/utils/opStamp.ts
/**
 * 操作印记（规格 §4）：实体（TabGroup/Tab）携带 { d, s }，合并时按全序决胜，
 * 任何带印记的实体对必出唯一赢家。EMPTY_STAMP 全序最小值，用于迁移前/云端空列。
 */
export interface OpStamp { d: string; s: number }

export const EMPTY_STAMP: OpStamp = { d: '', s: 0 };

export function makeStamp(deviceId: string, seq: number): OpStamp {
  return { d: deviceId, s: seq };
}

/**
 * 全序比较（规格 §4.2）：
 *   s 不同 → 数值比较
 *   s 相同 → d 字符串字典序比较
 *   完全相等 → 0
 *
 * 无 updatedAt / id 兜底：任一带印记实体对必唯一赢家，避免「同一设备同一序号盖
 * 多个实体」的 race 必须借助时间戳二次判定——seq 单调递增保证这一点。
 */
export function compareStamps(a: OpStamp, b: OpStamp): -1 | 0 | 1 {
  if (a.s !== b.s) return a.s > b.s ? 1 : -1;
  if (a.d !== b.d) return a.d > b.d ? 1 : -1;
  return 0;
}

export function isLater(a: OpStamp, b: OpStamp): boolean {
  return compareStamps(a, b) > 0;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test 2>&1 | grep -A2 opStamp`
Expected: 全 PASS

- [ ] **Step 5: 提交**

```bash
git add src/utils/opStamp.ts tests/opStamp.test.ts
git commit -m "feat(sync): OpStamp 类型与全序比较函数（阶段二·规格§4.1/§4.2）"
```

---

### Task 2: 本地设备 seq 持久化与工厂

**Files:**
- Create: `src/utils/seqRegistry.ts`
- Modify: `src/utils/storage.ts`（追加 `STORAGE_KEYS.DEVICE_SEQ` 与 `getDeviceSeq/setDeviceSeq`）
- Test: `tests/seqRegistry.test.ts`

**Interfaces:**
- Produces:
  - `nextSeq(): Promise<number>` —— 原子自增 + 落盘。SW 内被 mutationHandlers 调用。
  - `getDeviceSeq(): Promise<number>` —— 读持久化值；首次读取时执行 §4.1 的修复：`seq = max(持久化seq, 全部实体印记中本设备最大s) + 100`。
  - `bumpSeqIfLower(candidate: number): Promise<number>` —— 仅在 candidate > 当前 seq 时更新并返回新值，用于「seq 落后于实体印记中本设备最大 s」的恢复场景。
- Consumes: `getDeviceId()`（`@/utils/deviceUtils`，现有）、`getGroups()`（`@/utils/storage`，现有）、`OpStamp`（Task 1）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/seqRegistry.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false, MODE: 'test',
};
const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;
before(() => { register(LOADER_PATH); });

describe('seqRegistry: 本设备 seq 单调计数器', () => {
  it('nextSeq 单调递增且持久化', async () => {
    const { createSeqRegistry, resetSeqForTest } = await import('@/utils/seqRegistry');
    const kv = new Map<string, unknown>();
    const deps = {
      kvGet: async <T>(k: string) => kv.get(k) as T | undefined,
      kvSet: async (k: string, v: unknown) => { kv.set(k, v); },
      getDeviceId: async () => 'devA',
      getGroups: async () => [],
    };
    resetSeqForTest();
    const reg = createSeqRegistry(deps as any);
    assert.equal(await reg.getDeviceSeq(), 0);
    assert.equal(await reg.nextSeq(), 1);
    assert.equal(await reg.nextSeq(), 2);
    assert.equal(await reg.getDeviceSeq(), 2);
  });

  it('重启后从持久化恢复，不重复发号', async () => {
    const { createSeqRegistry } = await import('@/utils/seqRegistry');
    const kv = new Map<string, unknown>([['device_seq', 5]]);
    const deps = {
      kvGet: async <T>(k: string) => kv.get(k) as T | undefined,
      kvSet: async (k: string, v: unknown) => { kv.set(k, v); },
      getDeviceId: async () => 'devA',
      getGroups: async () => [],
    };
    const reg = createSeqRegistry(deps as any);
    assert.equal(await reg.getDeviceSeq(), 5);
    assert.equal(await reg.nextSeq(), 6);
  });

  it('getDeviceSeq 修复：实体印记中本设备 max s 更高时取 max+100', async () => {
    const { createSeqRegistry } = await import('@/utils/seqRegistry');
    const kv = new Map<string, unknown>([['device_seq', 10]]);
    const deps = {
      kvGet: async <T>(k: string) => kv.get(k) as T | undefined,
      kvSet: async (k: string, v: unknown) => { kv.set(k, v); },
      getDeviceId: async () => 'devA',
      getGroups: async () => [
        { id: 'g1', lastOp: { d: 'devA', s: 50 } } as any,
        { id: 'g2', lastOp: { d: 'devA', s: 30 } } as any,
        { id: 'g3', lastOp: { d: 'devB', s: 999 } } as any, // 其他设备不算
      ],
    };
    const reg = createSeqRegistry(deps as any);
    // 当前持久化 10 < 本设备实体印记 max 50 → 修复为 50 + 100 = 150
    assert.equal(await reg.getDeviceSeq(), 150);
    assert.equal(kv.get('device_seq'), 150);
  });

  it('bumpSeqIfLower 仅在 candidate 更高时更新', async () => {
    const { createSeqRegistry } = await import('@/utils/seqRegistry');
    const kv = new Map<string, unknown>([['device_seq', 100]]);
    const deps = {
      kvGet: async <T>(k: string) => kv.get(k) as T | undefined,
      kvSet: async (k: string, v: unknown) => { kv.set(k, v); },
      getDeviceId: async () => 'devA',
      getGroups: async () => [],
    };
    const reg = createSeqRegistry(deps as any);
    assert.equal(await reg.bumpSeqIfLower(50), 100); // 不更新
    assert.equal(await reg.bumpSeqIfLower(150), 150); // 更新
    assert.equal(await reg.getDeviceSeq(), 150);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test 2>&1 | grep -A2 seqRegistry`
Expected: FAIL（找不到 `@/utils/seqRegistry`）

- [ ] **Step 3: 最小实现**

```ts
// src/utils/seqRegistry.ts
/**
 * 本设备 seq 单调计数器（规格 §4.1）：每次写入操作前 ++seq，落盘 chrome.storage。
 * SW 启动时修复：seq = max(持久化 seq, 实体印记中本设备最大 s) + 100，
 * 保证序号永不回退、跳号无害。
 *
 * 生产绑定由 mutationService.ts（SW 入口）调用 createSeqRegistry 并复用单例；
 * 本文件保持纯函数 + 依赖注入，便于 node:test。
 */
import type { OpStamp } from './opStamp';
import { EMPTY_STAMP } from './opStamp';
import type { TabGroup } from '@/types/tab';

const DEVICE_SEQ_KEY = 'device_seq';
const SEQ_GAP = 100; // 修复时留出的跳号空间，避免「刚修复完就 nextSeq 时撞号」

export interface SeqRegistryDeps {
  kvGet<T>(key: string): Promise<T | undefined>;
  kvSet(key: string, value: unknown): Promise<void>;
  getDeviceId(): Promise<string>;
  getGroups(): Promise<TabGroup[]>;
}

export interface SeqRegistry {
  nextSeq(): Promise<number>;
  getDeviceSeq(): Promise<number>;
  bumpSeqIfLower(candidate: number): Promise<number>;
}

/** 找出 groups 中本设备所有 lastOp.s 的最大值（含 tab 印记） */
function maxSeqForDevice(groups: TabGroup[], deviceId: string): number {
  let max = 0;
  for (const g of groups) {
    if (g.lastOp && g.lastOp.d === deviceId && g.lastOp.s > max) max = g.lastOp.s;
    for (const t of g.tabs ?? []) {
      const stamp = (t as { lastOp?: OpStamp }).lastOp;
      if (stamp && stamp.d === deviceId && stamp.s > max) max = stamp.s;
    }
  }
  return max;
}

export function createSeqRegistry(deps: SeqRegistryDeps): SeqRegistry {
  let cached: number | null = null;

  async function read(): Promise<number> {
    if (cached !== null) return cached;
    const persisted = (await deps.kvGet<number>(DEVICE_SEQ_KEY)) ?? 0;
    const deviceId = await deps.getDeviceId();
    const groups = await deps.getGroups();
    const fromStamps = maxSeqForDevice(groups, deviceId);
    const fixed = Math.max(persisted, fromStamps + SEQ_GAP);
    if (fixed !== persisted) {
      await deps.kvSet(DEVICE_SEQ_KEY, fixed);
    }
    cached = fixed;
    return fixed;
  }

  async function persist(v: number): Promise<void> {
    cached = v;
    await deps.kvSet(DEVICE_SEQ_KEY, v);
  }

  return {
    async getDeviceSeq(): Promise<number> {
      return read();
    },
    async nextSeq(): Promise<number> {
      const cur = await read();
      const next = cur + 1;
      await persist(next);
      return next;
    },
    async bumpSeqIfLower(candidate: number): Promise<number> {
      const cur = await read();
      if (candidate > cur) {
        await persist(candidate);
        return candidate;
      }
      return cur;
    },
  };
}

// EMPTY_STAMP 仅在「未带印记」的兜底场景使用，stage 2 内会替换云端空列。
// 这里 re-export 供其他模块单点导入。
export { EMPTY_STAMP };
```

`src/utils/storage.ts` 改动：

```ts
// 在 STORAGE_KEYS 块追加：
DEVICE_SEQ: 'device_seq',

// 在 ChromeStorage 类内追加：
async getDeviceSeq(): Promise<number> {
  try {
    return (await kvGet<number>(STORAGE_KEYS.DEVICE_SEQ)) ?? 0;
  } catch {
    return 0;
  }
}

async setDeviceSeq(seq: number): Promise<void> {
  try {
    await kvSet(STORAGE_KEYS.DEVICE_SEQ, seq);
  } catch (err) {
    console.error('设置 device_seq 失败:', err);
  }
}
```

并在 `clear()` 的 keys 数组中追加 `STORAGE_KEYS.DEVICE_SEQ`（登出场景清理）。

`STORAGE_VERSION` 由 2 升级到 3（新增 device_seq key）。`ensureVersion` 现状已支持；仅 bump 常量。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test 2>&1 | tail -5`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/utils/seqRegistry.ts src/utils/storage.ts tests/seqRegistry.test.ts
git commit -m "feat(sync): 本设备 seq 单调计数器与启动修复（阶段二·规格§4.1）"
```

---

### Task 3: 本地 journal（write-ahead log）

**Files:**
- Create: `src/utils/journal.ts`
- Modify: `src/utils/storage.ts`（追加 `STORAGE_KEYS.JOURNAL`、`getJournal/setJournal/appendJournalEntry/trimJournal`）
- Test: `tests/journal.test.ts`

**Interfaces:**
- Produces:
  - `JournalEntry = { d: string; s: number; ts: string; type: MutationOp['op']; groupId?: string; tabId?: string; payload?: unknown }`
  - `createJournal(deps)` 工厂：`appendEntry(entry)`（FIFO 上限 1000，`storage.set` 一次性落盘 journal + seq）。
- 关键约束（§4.3）：**写序** `seq++` → journal + seq 一次性 `storage.local.set` 落盘 → 应用状态 → 落盘状态。SW 被杀时重放规则与合并规则同一条，幂等。

- [ ] **Step 1: 写失败测试**

```ts
// tests/journal.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('journal: write-ahead log（§4.3）', () => {
  it('appendEntry 追加并保持 FIFO 上限', async () => {
    const { createJournal } = await import('@/utils/journal');
    const stored: any[] = [];
    const kv = new Map<string, unknown>();
    const deps = {
      kvGet: async <T>(k: string) => kv.get(k) as T | undefined,
      kvSet: async (k: string, v: unknown) => { kv.set(k, v); },
      getDeviceId: async () => 'devA',
      nextSeq: async () => { stored.push('seq'); return stored.length; },
    };
    const j = createJournal(deps as any);
    for (let i = 0; i < 1001; i++) {
      await j.appendEntry({ type: 'saveGroup', groupId: `g${i}` });
    }
    const log = await j.read();
    assert.equal(log.length, 1000);
    assert.equal(log[0].groupId, 'g1'); // 最早的被裁剪
    assert.equal(log[999].groupId, 'g1000');
  });

  it('appendEntry 写入前 seq 已先自增', async () => {
    const { createJournal } = await import('@/utils/journal');
    let currentSeq = 5;
    const entries: any[] = [];
    const deps = {
      kvGet: async <T>(k: string) => undefined,
      kvSet: async (k: string, v: unknown) => { /* noop */ },
      getDeviceId: async () => 'devA',
      nextSeq: async () => ++currentSeq,
    };
    const j = createJournal(deps as any);
    const e = await j.appendEntry({ type: 'removeTab', groupId: 'g1', tabId: 't1' });
    assert.equal(e.s, 6);
    assert.equal(currentSeq, 6);
  });

  it('read 返回持久化的 entries', async () => {
    const { createJournal } = await import('@/utils/journal');
    const kv = new Map<string, unknown>([['journal', [
      { d: 'devA', s: 1, ts: '2026-01-01T00:00:00.000Z', type: 'saveGroup', groupId: 'g1' },
      { d: 'devA', s: 2, ts: '2026-01-01T00:00:01.000Z', type: 'removeTab', groupId: 'g1', tabId: 't1' },
    ]]]);
    const deps = {
      kvGet: async <T>(k: string) => kv.get(k) as T | undefined,
      kvSet: async (k: string, v: unknown) => { kv.set(k, v); },
      getDeviceId: async () => 'devA',
      nextSeq: async () => 99,
    };
    const j = createJournal(deps as any);
    const log = await j.read();
    assert.equal(log.length, 2);
    assert.equal(log[1].type, 'removeTab');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test 2>&1 | grep -A2 journal`
Expected: FAIL

- [ ] **Step 3: 最小实现**

```ts
// src/utils/journal.ts
/**
 * 本地 journal（write-ahead log，规格 §4.3）：SW 内任何语义命令执行前先 append
 * 一条 entry（含已自增的 seq）。SW 启动时若发现状态落后于 journal，重放规则
 * 与合并规则同一条（§4.3「天然幂等」）——阶段二 Task 9 实现重放。
 *
 * 上限 1000 条 FIFO：超出裁剪最早。journal 条目保留至被裁剪，仅用于崩溃恢复
 * 与调试视图（阶段三）。upload 成功后不裁剪——云端确认判定由 lastSyncedSeq
 * 单独维护（Task 7）。
 */
import type { MutationOp } from '@/shared/mutationProtocol';

export interface JournalEntry {
  d: string;
  s: number;
  ts: string;
  type: MutationOp['op'];
  groupId?: string;
  tabId?: string;
  payload?: unknown;
}

export interface JournalDeps {
  kvGet<T>(key: string): Promise<T | undefined>;
  kvSet(key: string, value: unknown): Promise<void>;
  getDeviceId(): Promise<string>;
  /** 原子自增 seq，返回新值。已在 Task 2 实现。 */
  nextSeq(): Promise<number>;
}

export interface Journal {
  appendEntry(partial: Omit<JournalEntry, 'd' | 's' | 'ts'> & { ts?: string }): Promise<JournalEntry>;
  read(): Promise<JournalEntry[]>;
  /** 上传成功后调用：标记 s ≤ maxSyncedSeq 的条目已确认。返回剩余未确认数。 */
  markConfirmedUpTo(maxSyncedSeq: number): Promise<number>;
}

const JOURNAL_KEY = 'journal';
const JOURNAL_MAX = 1000;

export function createJournal(deps: JournalDeps): Journal {
  async function read(): Promise<JournalEntry[]> {
    return (await deps.kvGet<JournalEntry[]>(JOURNAL_KEY)) ?? [];
  }

  async function write(entries: JournalEntry[]): Promise<void> {
    await deps.kvSet(JOURNAL_KEY, entries);
  }

  return {
    async appendEntry(partial): Promise<JournalEntry> {
      const seq = await deps.nextSeq();
      const deviceId = await deps.getDeviceId();
      const entry: JournalEntry = {
        d: deviceId,
        s: seq,
        ts: partial.ts ?? new Date().toISOString(),
        type: partial.type,
        groupId: partial.groupId,
        tabId: partial.tabId,
        payload: partial.payload,
      };
      const current = await read();
      const next = [...current, entry];
      if (next.length > JOURNAL_MAX) next.splice(0, next.length - JOURNAL_MAX);
      await write(next);
      return entry;
    },
    async read(): Promise<JournalEntry[]> {
      return read();
    },
    async markConfirmedUpTo(maxSyncedSeq: number): Promise<number> {
      const entries = await read();
      // 不物理裁剪：保留至 FIFO 上限淘汰。仅记录 lastSyncedSeq 供调试视图用。
      return entries.filter(e => e.s > maxSyncedSeq).length;
    },
  };
}
```

`src/utils/storage.ts` 改动：

```ts
// STORAGE_KEYS 块追加：
JOURNAL: 'journal',
LAST_SYNCED_SEQ: 'last_synced_seq',

// ChromeStorage 类内追加：
async getJournal(): Promise<unknown[]> {
  try {
    return (await kvGet<unknown[]>(STORAGE_KEYS.JOURNAL)) ?? [];
  } catch { return []; }
}

async setJournal(entries: unknown[]): Promise<void> {
  try { await kvSet(STORAGE_KEYS.JOURNAL, entries); }
  catch (err) { console.error('写 journal 失败:', err); }
}

async getLastSyncedSeq(): Promise<number> {
  try { return (await kvGet<number>(STORAGE_KEYS.LAST_SYNCED_SEQ)) ?? 0; }
  catch { return 0; }
}

async setLastSyncedSeq(s: number): Promise<void> {
  try { await kvSet(STORAGE_KEYS.LAST_SYNCED_SEQ, s); }
  catch (err) { console.error('设置 last_synced_seq 失败:', err); }
}
```

并在 `clear()` keys 数组追加 `STORAGE_KEYS.JOURNAL` / `STORAGE_KEYS.LAST_SYNCED_SEQ`；`STORAGE_VERSION` 由 3 升到 4。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test 2>&1 | tail -5`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/utils/journal.ts src/utils/storage.ts tests/journal.test.ts
git commit -m "feat(sync): 本地 journal write-ahead log（阶段二·规格§4.3）"
```

---

### Task 4: mutationOps 增加 stamp 盖印 —— apply* 把 OpStamp 写入实体

**Files:**
- Modify: `src/types/tab.ts`（`TabGroup.lastOp?`、`Tab.lastOp?`）
- Modify: `src/utils/mutationOps.ts`（所有 `apply*` 签名加 `stamp: OpStamp`，把 stamp 写入被改实体；幂等路径保持原行为）
- Test: `tests/mutationOps.test.ts`（追加 stamp 验收）

**Interfaces:**
- Produces（变更）：
  - `applySaveGroup(groups, group, now, stamp)` → 把 stamp 写入 `group.lastOp`
  - `applyRemoveTab(groups, groupId, tabId, now, stamp)` → 只盖被墓碑 tab 的 lastOp；组 lastOp 也盖（因为 removeTab 是组级操作的副作用——版本约定：组级 stamp 决定下游 tabs 的去向；但移除 tab 仅触达被墓碑 tab，组 stamp 应当也更新，否则下次合并时会被对侧组排序动）
    > **决策**：规格 §5.3「标签操作只盖 tab 自己的印记」——本任务严格遵守；removeTab 改 tab stamp 不改组 stamp。合并阶段二（Task 6）会以 tab stamp 为准决胜 tab；组字段变更（rename/toggleLock/moveGroup）单独盖组 stamp（见 Task 5/6）。
  - `applyDeleteGroup` / `applyDeleteAllGroups` / `applyRestoreGroup` / `applyPurgeGroup` / `applyRenameGroup` / `applyToggleGroupLock` / `applyUpdateGroupFields` / `applyMoveGroup` / `applyMoveTab` / `applyCleanDuplicates` / `applyImportGroups` 同样签名加 `stamp`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/mutationOps.test.ts 追加（沿用 Task 3 的样板：动态 import）
describe('mutationOps: stamp 盖印（阶段二·§4.1/§5）', () => {
  it('applySaveGroup：盖 group.lastOp', async () => {
    const { applySaveGroup } = await import('@/utils/mutationOps');
    const fresh = mkGroup('fresh', [], { createdAt: NOW });
    const stamp = { d: 'devA', s: 10 };
    const out = applySaveGroup([], fresh, NOW, stamp);
    assert.deepEqual(out[0].lastOp, stamp);
  });
  it('applyRemoveTab：盖被墓碑 tab 的 lastOp，组 lastOp 不动', async () => {
    const { applyRemoveTab } = await import('@/utils/mutationOps');
    const g = mkGroup('g1', [mkTab('t1'), mkTab('t2')]);
    const stamp = { d: 'devA', s: 11 };
    const { groups } = applyRemoveTab([g], 'g1', 't1', NOW, stamp);
    const out = groups.find(x => x.id === 'g1')!;
    assert.deepEqual(out.tabs.find(t => t.id === 't1')!.lastOp, stamp);
    assert.equal(out.tabs.find(t => t.id === 't2')!.lastOp, undefined);
    assert.equal(out.lastOp, undefined); // 组 stamp 不动
  });
  it('applyRenameGroup：盖 group.lastOp', async () => {
    const { applyRenameGroup } = await import('@/utils/mutationOps');
    const stamp = { d: 'devA', s: 12 };
    const { renamed } = applyRenameGroup([mkGroup('a', [])], 'a', '新名', NOW, stamp);
    assert.deepEqual(renamed!.lastOp, stamp);
  });
  it('applyMoveTab：源组与目标组的 lastOp 都盖（组字段命令覆盖到整组）', async () => {
    const { applyMoveTab } = await import('@/utils/mutationOps');
    const stamp = { d: 'devA', s: 13 };
    const g1 = mkGroup('g1', [mkTab('t1')]);
    const g2 = mkGroup('g2', [mkTab('t2')]);
    const { groups } = applyMoveTab(
      [g1, g2],
      { sourceGroupId: 'g1', sourceIndex: 0, targetGroupId: 'g2', targetIndex: 1 },
      NOW,
      stamp
    );
    assert.deepEqual(groups.find(x => x.id === 'g1')!.lastOp, stamp);
    assert.deepEqual(groups.find(x => x.id === 'g2')!.lastOp, stamp);
  });
  it('applyImportGroups：导入组盖统一 stamp', async () => {
    const { applyImportGroups } = await import('@/utils/mutationOps');
    const stamp = { d: 'devA', s: 14 };
    const { imported } = applyImportGroups(
      [], [mkGroup('src', [mkTab('x')])],
      { genId: () => 'newId', sanitizeUrl: (u) => u },
      NOW,
      stamp
    );
    assert.deepEqual(imported[0].lastOp, stamp);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test 2>&1 | grep -A2 'stamp 盖印'`
Expected: FAIL（applySaveGroup 等签名不匹配、stamp 参数未实现）

- [ ] **Step 3: 改实现**

```ts
// src/types/tab.ts —— 增加 lastOp 字段
import type { OpStamp } from '@/utils/opStamp';

export interface Tab {
  // ... 现有字段
  lastOp?: OpStamp;
}

export interface TabGroup {
  // ... 现有字段
  lastOp?: OpStamp;
}
```

> **实施注意**：`OpStamp` 类型从 `@/utils/opStamp` 导入。这里若是 circular 担忧，可把 `OpStamp` 内联到 `types/tab.ts`（仅数据形状，无行为）。规格 §4.1 明确类型位置独立，但项目里类型集中在 `types/tab.ts` 是既成事实——优先保持位置一致，**不**新增跨模块依赖。

```ts
// src/utils/mutationOps.ts —— 所有 apply* 增加 stamp 参数并盖印
import type { OpStamp } from '@/types/tab'; // 从 tab.ts 取，避免循环

export function applySaveGroup(
  groups: TabGroup[], group: TabGroup, now: string, stamp: OpStamp
): TabGroup[] {
  return [{ ...group, lastOp: stamp }, ...groups].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export function applyRemoveTab(
  groups: TabGroup[], groupId: string, tabId: string, now: string, stamp: OpStamp
): { groups: TabGroup[]; group: TabGroup | null } {
  const idx = groups.findIndex(g => g.id === groupId);
  if (idx === -1) return { groups, group: null };
  const current = groups[idx];

  if (shouldAutoDeleteAfterTabRemoval(current, tabId)) {
    // 整组软删：组 lastOp 也要盖（删除是组级命令）—— 这里是 Task 5 的语义延伸：
    // 「删除组」盖组 stamp；本路径整组软删同样盖组 stamp。
    // 决策：保留与原 deleteGroup 一致——组 stamp 必盖。
    const out = groups.map(g =>
      g.id === groupId && !g.isDeleted
        ? { ...g, isDeleted: true, lastOp: stamp, version: (g.version || 1) + 1, updatedAt: now }
        : g
    );
    return { groups: out, group: null };
  }

  const updatedTabs = current.tabs.map(tab =>
    tab.id === tabId && !tab.isDeleted
      ? { ...tab, isDeleted: true, lastOp: stamp, lastAccessed: now }
      : tab
  );
  // 决策修订（基于 §5.3 + 实操）：removeTab 仅改 tab stamp；组 stamp 不动。
  // 与 Task 5 对齐：组级命令（rename/toggleLock/moveGroup/deleteGroup）才盖组 stamp。
  const updatedGroup: TabGroup = { ...current, tabs: updatedTabs, updatedAt: now, version: (current.version || 1) + 1 };
  const out = [...groups]; out[idx] = updatedGroup;
  return { groups: out, group: updatedGroup };
}

export function applyDeleteGroup(groups, groupId, now, stamp): TabGroup[] {
  return groups.map(g =>
    g.id === groupId && !g.isDeleted
      ? { ...g, isDeleted: true, lastOp: stamp, version: (g.version || 1) + 1, updatedAt: now }
      : g
  );
}

export function applyDeleteAllGroups(groups, now, stamp): { groups; count } {
  return {
    groups: groups.map(g => g.isDeleted ? g : { ...g, isDeleted: true, lastOp: stamp, version: (g.version || 1) + 1, updatedAt: now }),
    count: groups.length,
  };
}

export function applyRestoreGroup(groups, groupId, now, stamp): { groups; restored: TabGroup | null } {
  const target = groups.find(g => g.id === groupId);
  if (!target) return { groups, restored: null };
  return {
    groups: groups.map(g =>
      g.id === groupId ? { ...g, isDeleted: false, lastOp: stamp, version: (g.version || 1) + 1, updatedAt: now } : g
    ),
    restored: { ...target, isDeleted: false, lastOp: stamp, version: (target.version || 1) + 1, updatedAt: now },
  };
}

export function applyPurgeGroup(groups, groupId, stamp): TabGroup[] {
  // purgeGroup 是物理移除，不入 stamp（墓碑传播语义不适用）
  return groups.filter(g => g.id !== groupId);
}

export function applyRenameGroup(groups, groupId, name, now, stamp): { groups; renamed: TabGroup | null } {
  let renamed: TabGroup | null = null;
  const out = groups.map(g => {
    if (g.id !== groupId) return g;
    renamed = { ...updateGroupWithVersion(g, { name, updatedAt: now }), lastOp: stamp };
    return renamed;
  });
  return { groups: out, renamed };
}

export function applyToggleGroupLock(groups, groupId, now, stamp): { groups; isLocked: boolean | null } {
  const group = groups.find(g => g.id === groupId);
  if (!group) return { groups, isLocked: null };
  const updated = { ...updateGroupWithVersion(group, { isLocked: !group.isLocked, updatedAt: now }), lastOp: stamp };
  return { groups: groups.map(g => (g.id === groupId ? updated : g)), isLocked: updated.isLocked };
}

export function applyUpdateGroupFields(groups, groupId, fields, now, stamp): { groups; updated: TabGroup | null } {
  let updated: TabGroup | null = null;
  const out = groups.map(g => {
    if (g.id !== groupId) return g;
    updated = { ...g, ...fields, updatedAt: now, lastOp: stamp };
    return updated;
  });
  return { groups: out, updated };
}

export function applyMoveGroup(groups, dragIndex, hoverIndex, stamp): TabGroup[] | null {
  if (dragIndex < 0 || dragIndex >= groups.length || hoverIndex < 0 || hoverIndex >= groups.length) return null;
  const newGroups = [...groups];
  const [dragGroup] = newGroups.splice(dragIndex, 1);
  newGroups.splice(hoverIndex, 0, dragGroup);
  return updateDisplayOrder(newGroups).map((g, i) =>
    newGroups[i]?.id === g.id && g.id === dragGroup.id ? { ...g, lastOp: stamp } : g
  );
}

export function applyMoveTab(groups, args, now, stamp): { groups; autoDeletedGroupId: string | null } {
  // ... 现有逻辑 ... 两侧组都盖 stamp（moveTab 是组级操作）
  // 见上述 applyMoveTab 步骤
}

export function applyCleanDuplicates(groups, now, stamp): { groups; removedTabsCount; removedGroupsCount } {
  // 去重墓碑视为合并设备的一次变更：盖 stamp
  // 内部维护一个 groupId -> stamp 的映射（合并阶段六 Task 6 在 mergeOpStamped 中再次盖）
  // 此处简化——所有被墓碑 tab 都盖同一 stamp；group 级墓碑（清空未锁定）也盖 stamp
}

export function applyImportGroups(groups, incoming, deps, now, stamp): { groups; imported: TabGroup[] } {
  const processed = incoming.map(group => ({
    ...group,
    id: deps.genId(),
    tabs: group.tabs.reduce<Tab[]>((acc, tab) => {
      const url = deps.sanitizeUrl(tab.url);
      if (!url) return acc;
      acc.push({ ...tab, url, id: deps.genId() });
      return acc;
    }, []),
    lastOp: stamp,
  }));
  return {
    groups: [...processed, ...groups].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    ),
    imported: processed,
  };
}
```

> 实施注意：
> 1. `applyMoveTab` 与 `applyCleanDuplicates` 需要全量覆盖现有实现（见 git diff 比对）——本计划假定阶段一已合入，apply* 函数体可读 git 中 `src/utils/mutationOps.ts` 现有实现。
> 2. `applyPurgeGroup` 接 stamp 参数但**不写**（物理移除无实体承接 stamp），保留参数以保持调用点统一。
> 3. `applyMoveGroup` 中 `updateDisplayOrder` 返回的数组里拖动组盖 stamp，其他不动——维持「仅变更实体的 stamp 变化」原则。

- [ ] **Step 4: 更新现有 mutationOps 测试**

Run: `pnpm test 2>&1 | tail -10`
Expected: 大量 FAIL（既有测试调用点未传 stamp）

对每个 `apply*` 的现有调用点追加 `stamp = { d: 'test', s: 1 }` 入参（或在测试文件顶部定义 `STAMP` 常量复用）。**注意：测试数据构造器 `mkGroup`/`mkTab` 不带 stamp；apply* 的 stamp 入参为函数参数**，故既有断言无须改。

- [ ] **Step 5: 运行确认通过**

Run: `pnpm test 2>&1 | tail -5`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add src/types/tab.ts src/utils/mutationOps.ts tests/mutationOps.test.ts
git commit -m "feat(sync): mutationOps 加 stamp 参数并盖印（阶段二·规格§4.1/§5）"
```

---

### Task 5: mutationHandlers 注入 journal + seqRegistry

**Files:**
- Modify: `src/background/mutationHandlers.ts`（deps 增 `journal: Journal`、`seq: SeqRegistry`；每个 case 先 `journal.appendEntry(...)` 再执行 apply*）
- Modify: `src/background/mutationService.ts`（绑定真实 journal + seqRegistry 实例）
- Test: `tests/mutationHandlers.test.ts`（追加：journal 落盘条目、stamp 来源于 seq）

**Interfaces:**
- Consumes: Task 2 `SeqRegistry`、Task 3 `Journal`。
- Produces: 每次 `handle(cmd)` 在 apply* 前先 `journal.appendEntry({type, groupId?, tabId?})`，再 `apply*(... stamp = { d, s: entry.s })`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/mutationHandlers.test.ts 追加
import { createMutationHandlers } from '@/background/mutationHandlers';
import type { Journal } from '@/utils/journal';
import type { SeqRegistry } from '@/utils/seqRegistry';

function memJournal(): Journal & { entries: any[] } {
  const entries: any[] = [];
  let n = 0;
  return {
    entries,
    async appendEntry(p: any) {
      n += 1;
      const e = { d: 'devA', s: n, ts: '2026-01-01T00:00:00.000Z', ...p };
      entries.push(e);
      return e;
    },
    async read() { return entries; },
    async markConfirmedUpTo() { return 0; },
  };
}

function memSeq(): SeqRegistry {
  let n = 0;
  return {
    nextSeq: async () => { n += 1; return n; },
    getDeviceSeq: async () => n,
    bumpSeqIfLower: async (c: number) => (c > n ? (n = c) : n),
  };
}

it('removeTab：handle 先 append journal，再以 stamp 写实体', async () => {
  const journal = memJournal();
  const seq = memSeq();
  const handlers = createMutationHandlers({ ..., journal, seq } as any);
  const g = mkGroup('g1', [mkTab('t1')]);
  await deps.setGroups([g]);
  await handlers.handle({ op: 'removeTab', groupId: 'g1', tabId: 't1' });
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0].type, 'removeTab');
  assert.equal(journal.entries[0].s, 1);
  const stored = await deps.getGroups();
  assert.deepEqual(stored[0].tabs[0].lastOp, { d: 'devA', s: 1 });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test 2>&1 | grep -A2 'mutationHandlers: removeTab: handle 先 append'`
Expected: FAIL

- [ ] **Step 3: 改实现**

```ts
// src/background/mutationHandlers.ts —— 注入 deps
import type { Journal } from '@/utils/journal';
import type { SeqRegistry } from '@/utils/seqRegistry';
import { compareStamps } from '@/utils/opStamp'; // 或从 @/types/tab 导入 OpStamp

export interface MutationDeps {
  getGroups(): Promise<TabGroup[]>;
  setGroups(groups: TabGroup[]): Promise<void>;
  scheduleUpload(delayMs: number): void;
  now(): string;
  journal: Journal;
  seq: SeqRegistry;
}

export function createMutationHandlers(deps: MutationDeps) {
  async function run(cmd: MutationOp): Promise<MutationResult> {
    const now = deps.now();
    // 写序（§4.3）：journal + seq 一次性落盘先于 apply* 状态写。
    const entry = await deps.journal.appendEntry({
      type: cmd.op,
      groupId: 'groupId' in cmd ? cmd.groupId : undefined,
      tabId: 'tabId' in cmd ? cmd.tabId : undefined,
    });
    const stamp = { d: entry.d, s: entry.s };
    switch (cmd.op) {
      case 'saveGroup': {
        const groups = await deps.getGroups();
        await deps.setGroups(applySaveGroup(groups, cmd.group, now, stamp));
        deps.scheduleUpload(DELETE_PRIORITY_MS);
        return { ok: true, payload: cmd.group };
      }
      // ... 其余 case：每个 apply* 调用都追加 stamp 入参
    }
  }
  // ...
}
```

`src/background/mutationService.ts` 改动：

```ts
import { storage } from '@/utils/storage';
import { syncEngine } from '@/services/syncEngine';
import { createMutationHandlers } from './mutationHandlers';
import { createSeqRegistry } from '@/utils/seqRegistry';
import { createJournal } from '@/utils/journal';
import { kvGet, kvSet } from '@/storage/storageAdapter';
import { getDeviceId } from '@/utils/deviceUtils';

const seq = createSeqRegistry({
  kvGet, kvSet, getDeviceId,
  getGroups: () => storage.getGroups(),
});
const journal = createJournal({
  kvGet, kvSet, getDeviceId,
  nextSeq: () => seq.nextSeq(),
});

export const mutationService = createMutationHandlers({
  getGroups: () => storage.getGroups(),
  setGroups: g => storage.setGroups(g),
  scheduleUpload: ms => syncEngine.scheduleUpload(ms),
  now: () => new Date().toISOString(),
  journal,
  seq,
});
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test && pnpm type-check`
Expected: 通过

- [ ] **Step 5: 提交**

```bash
git add src/background/mutationHandlers.ts src/background/mutationService.ts tests/mutationHandlers.test.ts
git commit -m "feat(sync): mutationHandlers 注入 journal + seqRegistry（阶段二·规格§4.3）"
```

---

### Task 6: mergeOpStamped —— 按 OpStamp 全序决胜的合并纯函数

**Files:**
- Create: `src/utils/opStampMerge.ts`
- Test: `tests/opStampMerge.test.ts`

**Interfaces:**
- Produces:
  - `mergeOpStamped(local: TabGroup[], cloud: TabGroup[]): TabGroup[]`
  - `mergeTabOpStamped(localTabs: Tab[], cloudTabs: Tab[]): Tab[]`（mergeOpStamped 内部使用，亦单独导出供 §5.4 URL 去重复用）
- 合并规则严格按规格 §5：
  - §5.1 组级：并集 + 按 stamp 决胜，isDeleted 墓碑也参与比 stamp
  - §5.2 组字段：`name` / `isFavorite` / `displayOrder` 跟随组 stamp 赢家；`isLocked` 保留 OR；`notes` 本地优先；`version` 冻结不参与判定
  - §5.3 标签级：tab 按 id 并集 + 按 stamp 决胜；墓碑同样参与
  - §5.4 URL 去重：同 URL 多活跃时按 stamp 决胜，败者盖墓碑并带合并设备 stamp + 入 journal（合并 stamp 在调用方统一处理）
  - §5.5 保留：`validateMergeResult` / `decideDownloadPrecheck` / `UPLOAD_GUARD_MS` 不变
- 性质测试（§10）：交换律、幂等、收敛。

- [ ] **Step 1: 写失败测试（性质测试优先于具体规则，因性质是验收的"全序"前提）**

```ts
// tests/opStampMerge.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const NOW = '2026-01-01T00:00:00.000Z';
const STAMP_A = { d: 'devA', s: 1 };
const STAMP_B = { d: 'devB', s: 1 };

function mkG(id: string, tabs: any[] = [], over: any = {}) {
  return {
    id, name: `g-${id}`, tabs,
    createdAt: NOW, updatedAt: NOW,
    version: 1, isDeleted: false, isLocked: false,
    ...over,
  };
}
function mkT(id: string, url: string, over: any = {}) {
  return { id, url, title: id, favicon: '', createdAt: NOW, lastAccessed: NOW, pinned: false, ...over };
}

const { mergeOpStamped, mergeTabOpStamped } = await import('@/utils/opStampMerge');

describe('mergeOpStamped: 交换律 / 幂等 / 收敛（§10 性质测试）', () => {
  it('交换律: merge(A,B) ≡ merge(B,A)', () => {
    const a = [mkG('g1', [mkT('t1', 'https://a')], { lastOp: STAMP_A })];
    const b = [mkG('g1', [mkT('t1', 'https://a')], { lastOp: STAMP_B, name: '改名' })];
    assert.deepEqual(mergeOpStamped(a, b), mergeOpStamped(b, a));
  });
  it('幂等: merge(A,A) ≡ A', () => {
    const a = [mkG('g1', [mkT('t1', 'https://a')], { lastOp: STAMP_A })];
    assert.deepEqual(mergeOpStamped(a, a), a);
  });
  it('收敛: merge(merge(A,B),C) ≡ merge(merge(A,C),B)', () => {
    const base = mkG('g1', [mkT('t1', 'https://a')], { lastOp: { d: 'devBase', s: 1 } });
    const a = [mkG('g1', [mkT('t1', 'https://a')], { lastOp: STAMP_A, name: 'A改' })];
    const b = [mkG('g1', [mkT('t1', 'https://a')], { lastOp: STAMP_B, name: 'B改' })];
    const c = [mkG('g1', [mkT('t1', 'https://a')], { lastOp: { d: 'devC', s: 99 }, name: 'C改' })];
    const lhs = mergeOpStamped(mergeOpStamped([base], a), c);
    const rhs = mergeOpStamped(mergeOpStamped([base], c), b);
    assert.deepEqual(lhs, rhs);
  });
});

describe('mergeOpStamped: §5.1/§5.2 组级', () => {
  it('云端 stamp 更高 → 云端赢家', () => {
    const local = [mkG('g1', [], { lastOp: { d: 'devA', s: 1 }, name: '本地名' })];
    const cloud = [mkG('g1', [], { lastOp: { d: 'devB', s: 99 }, name: '云端名' })];
    const out = mergeOpStamped(local, cloud);
    assert.equal(out[0].name, '云端名');
  });
  it('本地 stamp 更高 → 本地赢家', () => {
    const local = [mkG('g1', [], { lastOp: { d: 'devA', s: 99 }, name: '本地' })];
    const cloud = [mkG('g1', [], { lastOp: { d: 'devB', s: 1 }, name: '云端' })];
    const out = mergeOpStamped(local, cloud);
    assert.equal(out[0].name, '本地');
  });
  it('墓碑 (isDeleted) 同样参与 stamp 比较：赢家是墓碑 → 保留 isDeleted=true', () => {
    const local = [mkG('g1', [], { lastOp: { d: 'devA', s: 5 } })]; // 活跃
    const cloud = [mkG('g1', [], { lastOp: { d: 'devB', s: 99 }, isDeleted: true })];
    const out = mergeOpStamped(local, cloud);
    assert.equal(out[0].isDeleted, true);
  });
  it('活跃 stamp > 墓碑 stamp → 保留活跃（恢复/取消删除语义）', () => {
    const local = [mkG('g1', [], { lastOp: { d: 'devA', s: 99 } })]; // 活跃最新
    const cloud = [mkG('g1', [], { lastOp: { d: 'devB', s: 5 }, isDeleted: true })];
    const out = mergeOpStamped(local, cloud);
    assert.equal(out[0].isDeleted, false);
  });
  it('单侧独有：保留', () => {
    const local = [mkG('g1', [])];
    const cloud = [mkG('g2', [])];
    const out = mergeOpStamped(local, cloud);
    assert.equal(out.length, 2);
  });
  it('version 冻结：保留原值，不 max+1', () => {
    const local = [mkG('g1', [], { lastOp: STAMP_A, version: 5 })];
    const cloud = [mkG('g1', [], { lastOp: STAMP_B, version: 7 })];
    const out = mergeOpStamped(local, cloud);
    assert.equal(out[0].version, 7); // 跟随赢家原值，不 +1
  });
});

describe('mergeOpStamped: §5.3 标签级', () => {
  it('tab 按 stamp 决胜', () => {
    const localTab = mkT('t1', 'https://a', { lastAccessed: '2026-01-01T00:00:00.000Z', lastOp: { d: 'devA', s: 1 } });
    const cloudTab = mkT('t1', 'https://a', { lastAccessed: '2026-06-01T00:00:00.000Z', lastOp: { d: 'devB', s: 99 } });
    const local = [mkG('g1', [localTab])];
    const cloud = [mkG('g1', [cloudTab])];
    const out = mergeOpStamped(local, cloud);
    assert.equal(out[0].tabs[0].lastAccessed, '2026-06-01T00:00:00.000Z');
  });
  it('标签墓碑同样参与 stamp 比较', () => {
    const localTab = mkT('t1', 'https://a', { lastOp: { d: 'devA', s: 1 } }); // 活跃
    const cloudTab = mkT('t1', 'https://a', { lastOp: { d: 'devB', s: 99 }, isDeleted: true });
    const local = [mkG('g1', [localTab])];
    const cloud = [mkG('g1', [cloudTab])];
    const out = mergeOpStamped(local, cloud);
    assert.equal(out[0].tabs[0].isDeleted, true);
  });
});

describe('mergeOpStamped: §5.4 URL 去重（同 URL 不同 id）', () => {
  it('跨设备同 URL 重加：双方都视为独立实体，按 stamp 决胜（重加存活）', () => {
    // 规格 §5.4 已拍板：跨设备同 URL 不同 id = 独立实体
    const localTab = mkT('tLocal', 'https://x.com', { lastOp: { d: 'devA', s: 5 } });
    const cloudTab = mkT('tCloud', 'https://x.com', { lastOp: { d: 'devB', s: 1 } });
    const local = [mkG('g1', [localTab])];
    const cloud = [mkG('g1', [cloudTab])];
    const out = mergeOpStamped(local, cloud);
    const tabIds = out[0].tabs.map(t => t.id).sort();
    assert.deepEqual(tabIds, ['tCloud', 'tLocal']); // 双方都在
  });
  it('同组同 URL 不同 id 双方 stamp：败者盖墓碑并带合并设备 stamp', () => {
    const localTab = mkT('tLocal', 'https://x.com', { lastOp: { d: 'devA', s: 1 } });
    const cloudTab = mkT('tCloud', 'https://x.com', { lastOp: { d: 'devB', s: 99 } });
    const local = [mkG('g1', [localTab])];
    const cloud = [mkG('g1', [cloudTab])];
    const out = mergeOpStamped(local, cloud, { mergeStamp: STAMP_A });
    const localOut = out[0].tabs.find(t => t.id === 'tLocal')!;
    assert.equal(localOut.isDeleted, true);
    assert.deepEqual(localOut.lastOp, STAMP_A); // 盖合并设备 stamp
  });
});
```

> 决策记录：**§5.4 第一条用例钉死跨设备同 URL 重加存活语义**——这是规格 §12 第 3 条已拍板事项。这条用例与现有 `syncUtils.mergeTabs` 的 URL 墓碑传播相反，是阶段二的语义切换验收点之一。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test 2>&1 | grep -A2 opStampMerge`
Expected: FAIL

- [ ] **Step 3: 最小实现**

```ts
// src/utils/opStampMerge.ts
/**
 * 按 OpStamp 全序决胜的合并纯函数（规格 §5）：替代现有 syncUtils.mergeTabGroups
 * （其使用 version + 时间戳 LWW）。同全序保证下，交换律/幂等/收敛自然成立。
 *
 * 设计要点：
 * - stamp 缺失视为全序最小值（EMPTY_STAMP），保证迁移前数据 + 云端空列正确输给
 *   任何带 stamp 的实体（§7.1）
 * - 合并设备产生的墓碑（URL 去重败者）必须盖合并设备的 stamp 并入 journal，
 *   由调用方传入 { mergeStamp }；此函数不做 IO
 * - 严格按 id 并集 + stamp 决胜；不引入 URL 维度墓碑（§5.4 已拍板：跨设备同 URL
 *   重加视为独立实体）
 */
import type { TabGroup, Tab, OpStamp } from '@/types/tab';
import { compareStamps, EMPTY_STAMP } from '@/utils/opStamp';

export interface MergeOptions {
  /** 合并设备产生的墓碑（§5.4 URL 败者）盖此 stamp；不传则不盖 */
  mergeStamp?: OpStamp;
}

export function mergeOpStamped(
  local: TabGroup[], cloud: TabGroup[], opts: MergeOptions = {}
): TabGroup[] {
  const byId = new Map<string, { local?: TabGroup; cloud?: TabGroup }>();
  for (const g of local) byId.set(g.id, { ...(byId.get(g.id) || {}), local: g });
  for (const g of cloud) byId.set(g.id, { ...(byId.get(g.id) || {}), cloud: g });

  const merged: TabGroup[] = [];
  for (const [id, sides] of byId) {
    const { local: lg, cloud: cg } = sides;
    if (lg && !cg) { merged.push(lg); continue; }
    if (cg && !lg) { merged.push(cg); continue; }
    // 都有 → 按 stamp 决胜
    const winner = pickByStamp(lg!, cg!);
    const mergedTabs = mergeTabsOpStamped(lg!.tabs, cg!.tabs, opts);
    merged.push({ ...winner, tabs: mergedTabs });
  }
  return merged;
}

function pickByStamp(a: TabGroup, b: TabGroup): TabGroup {
  const sa = a.lastOp ?? EMPTY_STAMP;
  const sb = b.lastOp ?? EMPTY_STAMP;
  return compareStamps(sa, sb) >= 0 ? a : b;
}

export function mergeTabsOpStamped(
  local: Tab[], cloud: Tab[], opts: MergeOptions = {}
): Tab[] {
  const byId = new Map<string, { local?: Tab; cloud?: Tab }>();
  for (const t of local) byId.set(t.id, { ...(byId.get(t.id) || {}), local: t });
  for (const t of cloud) byId.set(t.id, { ...(byId.get(t.id) || {}), cloud: t });

  const winners: Tab[] = [];
  for (const [id, sides] of byId) {
    const { local: lt, cloud: ct } = sides;
    if (lt && !ct) { winners.push(lt); continue; }
    if (ct && !lt) { winners.push(ct); continue; }
    winners.push(pickTabByStamp(lt!, ct!));
  }

  // §5.4 URL 去重：同 URL 多活跃 tab，败者盖墓碑并盖 mergeStamp
  if (!opts.mergeStamp) return winners;
  const byUrl = new Map<string, Tab[]>();
  for (const t of winners) {
    if (t.isDeleted) continue;
    if (!t.url) continue;
    const key = t.url.startsWith('loading://') ? `${t.url}|${t.title}` : t.url;
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key)!.push(t);
  }

  const tombstoned = new Set<string>();
  for (const [, list] of byUrl) {
    if (list.length <= 1) continue;
    const sorted = [...list].sort((a, b) => {
      const sa = a.lastOp ?? EMPTY_STAMP;
      const sb = b.lastOp ?? EMPTY_STAMP;
      return compareStamps(sb, sa); // 高 → 低
    });
    for (let i = 1; i < sorted.length; i++) {
      tombstoned.add(sorted[i].id);
    }
  }

  return winners.map(t =>
    tombstoned.has(t.id)
      ? { ...t, isDeleted: true, lastOp: opts.mergeStamp }
      : t
  );
}

function pickTabByStamp(a: Tab, b: Tab): Tab {
  const sa = (a.lastOp ?? EMPTY_STAMP) as OpStamp;
  const sb = (b.lastOp ?? EMPTY_STAMP) as OpStamp;
  return compareStamps(sa, sb) >= 0 ? a : b;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test 2>&1 | tail -5`
Expected: 全部 PASS（含性质测试）

- [ ] **Step 5: 提交**

```bash
git add src/utils/opStampMerge.ts tests/opStampMerge.test.ts
git commit -m "feat(sync): mergeOpStamped 按 OpStamp 全序决胜（阶段二·规格§5）"
```

---

### Task 7: Supabase schema 加 last_op_device / last_op_seq 两列 + 守护触发器

**Files:**
- Create: `supabase/migrations/20260909_add_op_stamp_columns.sql`
- Modify: `src/utils/supabase.ts`（类型 `SupabaseTabGroup` 增 `last_op_device?: string`、`last_op_seq?: number | null`；`downloadTabGroups` 选择列增 `last_op_device, last_op_seq`；上传 payload 携带 stamp）
- Modify: `src/services/tabGroupSyncService.ts`（pass-through 不动）
- Test: 自动化由 Supabase 迁移承接；本地侧由 Task 8 验证。

**Interfaces:**
- 新增列：
  ```sql
  ALTER TABLE public.tab_groups
    ADD COLUMN IF NOT EXISTS last_op_device text,
    ADD COLUMN IF NOT EXISTS last_op_seq    bigint;
  CREATE INDEX IF NOT EXISTS idx_tab_groups_op_stamp
    ON public.tab_groups (user_id, last_op_seq DESC);
  ```
- 新增触发器（取代旧 version guard）：`guard_tab_group_op_stamp` BEFORE UPDATE，**仅**当 NEW.last_op_seq ≤ OLD.last_op_seq 时 RETURN NULL（跳过过期写入）。NULL/缺失列视为最小值。
- 兼容性：
  - 老客户端不写这两列 → upsert 写入时缺失 → 触发器放行（NULL ≤ NULL）→ 升级期间旧客户端仍可写入。
  - 与旧 `version` 列共存（旧 `guard_tab_group_version` 触发器保留或随此迁移删除——决策见下）。

- [ ] **Step 1: 写迁移**

```sql
-- supabase/migrations/20260909_add_op_stamp_columns.sql
-- ─────────────────────────────────────────────────────────────
-- TapStack: tab_groups 加操作印记列 + 守护触发器
--
-- 背景：阶段二合并语义从「version + 时间戳 LWW」切换到「OpStamp 全序」。
-- 旧 version 触发器（20260827）保留为兼容（老客户端仍可能存在）；
-- 新 stamp 触发器守护升级后的客户端写入。
--
-- 兼容性：
-- 1. ALTER TABLE IF NOT EXISTS：幂等
-- 2. 新列 nullable：老行 last_op_seq=NULL → 触发器视为最小值（OLD NULL ≥ NEW NULL 跳过）
--    客户端带 stamp 上传时必填，触发器才能正确守护
-- 3. 旧 `version` 列 + `guard_tab_group_version` 触发器**保留**（老客户端守护），
--    阶段三（或客户端全部升级后）可清理
-- ─────────────────────────────────────────────────────────────

ALTER TABLE public.tab_groups
  ADD COLUMN IF NOT EXISTS last_op_device text,
  ADD COLUMN IF NOT EXISTS last_op_seq    bigint;

CREATE INDEX IF NOT EXISTS idx_tab_groups_op_stamp
  ON public.tab_groups (user_id, last_op_seq DESC NULLS LAST);

-- 守护：BEFORE UPDATE，若 NEW.last_op_seq ≤ OLD.last_op_seq 则跳过（NULL 视为最小值参与比较）
CREATE OR REPLACE FUNCTION public.guard_tab_group_op_stamp()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.last_op_seq IS NOT NULL AND NEW.last_op_seq IS NOT NULL THEN
    IF NEW.last_op_seq <= OLD.last_op_seq THEN
      RETURN NULL;
    END IF;
  ELSIF OLD.last_op_device IS NOT NULL AND NEW.last_op_device IS NULL THEN
    -- 老客户端空列 vs 新客户端带 stamp：放行（让新客户端接管）
    RETURN NEW;
  ELSIF OLD.last_op_seq IS NOT NULL AND NEW.last_op_seq IS NULL THEN
    -- 老客户端不带 stamp vs 新客户端带 stamp：放行
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tab_group_op_stamp_guard ON public.tab_groups;
CREATE TRIGGER tab_group_op_stamp_guard
BEFORE UPDATE ON public.tab_groups
FOR EACH ROW EXECUTE FUNCTION public.guard_tab_group_op_stamp();

-- 备注：客户端 stamp 仅写入「组级」操作（saveGroup/deleteGroup/restoreGroup/renameGroup/
-- toggleGroupLock/moveGroup/moveTab/deleteAllGroups/importGroups）。tab 印记内嵌在
-- tabs_data JSON 中，不参与云端列判定（详见规格 §5.3）。
```

- [ ] **Step 2: 类型同步**

```ts
// src/utils/supabase.ts —— SupabaseTabGroup 类型扩展
export interface SupabaseTabGroup {
  // ... 现有字段
  last_op_device?: string | null;
  last_op_seq?: number | null;
}
```

- [ ] **Step 3: uploadTabGroups payload 携带 stamp**

```ts
// src/utils/supabase.ts:550 区域，returnObj 追加：
returnObj.last_op_device = group.lastOp?.d ?? null;
returnObj.last_op_seq = group.lastOp?.s ?? null;
```

- [ ] **Step 4: downloadTabGroups 选择列与解析**

```ts
// select('*') → select('*, last_op_device, last_op_seq')  // Supabase * 不含新加列
.select('*, last_op_device, last_op_seq')
// 解析时 groupAny.last_op_device/last_op_seq → group.lastOp
if (groupAny.last_op_device && typeof groupAny.last_op_seq === 'number') {
  group.lastOp = { d: groupAny.last_op_device, s: groupAny.last_op_seq };
}
```

- [ ] **Step 5: markCloudGroupsAsDeleted 改用 stamp**

```ts
// 现有：read version + UPDATE version+1
// 改为：read stamp + UPDATE last_op_seq = max(stamp.s, OLD.s)+1 + is_deleted=true
// 简化路径：DELETE FROM 用 stamp 守护（不需要读旧 version）
```

> **实施注意**：此改动是 §6.1 「markCloudGroupsAsDeleted 简化为直接写删除印记」的落地。`deleteGroup`（mutationHandlers）在 `applyDeleteGroup` 内已盖 stamp 并调度上传；`markCloudGroupsAsDeleted` 仅需把软删组的 `last_op_seq` 设为 max+1 + `is_deleted=true`，由触发器守护。

- [ ] **Step 6: 类型检查 + 运行测试**

Run: `pnpm type-check && pnpm test`
Expected: 通过

- [ ] **Step 7: 提交**

```bash
git add supabase/migrations/20260909_add_op_stamp_columns.sql src/utils/supabase.ts
git commit -m "feat(sync): Supabase schema 加操作印记列与守护触发器（阶段二·规格§6.1）"
```

---

### Task 8: downloadAndMerge 切换到 mergeOpStamped + 云端/本地互转 stamp

**Files:**
- Modify: `src/services/syncEngine.ts`（`downloadAndMerge` 内替换 `mergeTabGroups(local, cloud, strategy)` → `mergeOpStamped(local, cloud, { mergeStamp: { d: deviceId, s: seq } })`）
- Test: `tests/syncEngine.test.ts`（若不存在则创建；冒烟：云端带 stamp 合并后本地 stamp 落盘）

**Interfaces:**
- Consumes: Task 1 `OpStamp`、Task 2 `SeqRegistry`、Task 6 `mergeOpStamped`。
- Produces: `downloadAndMerge` 在合并成功后把 `{ `d: deviceId, s: seq }`（mergeStamp 由本设备 nextSeq 取号）作为合并设备 stamp 传入，URL 去重败者自动盖本设备 stamp。

- [ ] **Step 1: 写失败测试**

```ts
// tests/syncEngine.test.ts —— 冒烟：云端 stamp 覆盖时本地 winner 取云端
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

it('downloadAndMerge: 云端 stamp 更高 → 合并结果取云端', async () => {
  const { mergeOpStamped } = await import('@/utils/opStampMerge');
  const local = [{ id: 'g1', name: '本地名', tabs: [], createdAt: NOW, updatedAt: NOW, version: 1, isDeleted: false, isLocked: false, lastOp: { d: 'devA', s: 1 } } as any];
  const cloud = [{ id: 'g1', name: '云端名', tabs: [], createdAt: NOW, updatedAt: NOW, version: 1, isDeleted: false, isLocked: false, lastOp: { d: 'devB', s: 99 } } as any];
  const out = mergeOpStamped(local, cloud);
  assert.equal(out[0].name, '云端名');
});

it('downloadAndMerge: 同 URL 不同 id 跨设备重加 → 都存活', async () => {
  const { mergeOpStamped } = await import('@/utils/opStampMerge');
  const local = [{ id: 'g1', name: 'g', tabs: [{ id: 'tLocal', url: 'https://x', ...baseTab, lastOp: { d: 'devA', s: 5 } }], ...baseGroup, lastOp: { d: 'devA', s: 5 } }] as any;
  const cloud = [{ id: 'g1', name: 'g', tabs: [{ id: 'tCloud', url: 'https://x', ...baseTab, lastOp: { d: 'devB', s: 1 } }], ...baseGroup, lastOp: { d: 'devB', s: 1 } }] as any;
  const out = mergeOpStamped(local, cloud);
  assert.deepEqual(out[0].tabs.map(t => t.id).sort(), ['tCloud', 'tLocal']);
});
```

- [ ] **Step 2: syncEngine 切换**

```ts
// src/services/syncEngine.ts:253 替换为：
import { mergeOpStamped } from '@/utils/opStampMerge';
import { getDeviceId } from '@/utils/deviceUtils';
import { createSeqRegistry, ... } from '@/utils/seqRegistry';

// downloadAndMerge 内：
const mergeStamp = (async () => ({ d: await getDeviceId(), s: await seq.nextSeq() }))();
const mergedGroups = mergeOpStamped(localGroups, cloudGroups, { mergeStamp: await mergeStamp });
```

- [ ] **Step 3: 验证**

Run: `pnpm test && pnpm type-check`
Expected: 通过

- [ ] **Step 4: 提交**

```bash
git add src/services/syncEngine.ts tests/syncEngine.test.ts
git commit -m "refactor(sync): downloadAndMerge 切换到 mergeOpStamped（阶段二·规格§5）"
```

---

### Task 9: 存量数据迁移（§7）

**Files:**
- Create: `src/utils/opStampMigration.ts`
- Modify: `src/utils/storage.ts`（`STORAGE_KEYS.OP_STAMP_MIGRATED` 标志）
- Modify: `src/background/mutationService.ts`（SW 启动 + popup 启动两处入口检查）
- Test: `tests/opStampMigration.test.ts`

**Interfaces:**
- Produces:
  - `migrateOpStamps(groups: TabGroup[]): { groups: TabGroup[]; migrated: number }`
  - 规则（§7.2-§7.4）：
    1. 所有无 `lastOp`（或 `lastOp.d === 'legacy'`）的实体盖 `legacy` stamp：`{ d: 'legacy', s: existing.version || 1 }`
    2. 迁移后本设备 seq 初始化为 `max(实体 stamps.s) + 1000`（避免与 legacy 段撞号）—— 已被 Task 2 `getDeviceSeq` 自动修复（其内部已扫 maxSeqForDevice）
    3. 幂等：已带印记且 `d !== 'legacy'` 的实体跳过
    4. 现有墓碑（`isDeleted=true` + 老 `version`）原样保留，迁移后 `isDeleted=true` + `legacy` stamp

- [ ] **Step 1: 写失败测试**

```ts
// tests/opStampMigration.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

it('无 stamp 的实体 → 盖 legacy stamp = { d: "legacy", s: version || 1 }', async () => {
  const { migrateOpStamps } = await import('@/utils/opStampMigration');
  const out = migrateOpStamps([
    { id: 'g1', name: 'g', tabs: [], createdAt: NOW, updatedAt: NOW, version: 3, isDeleted: false, isLocked: false } as any,
  ]);
  assert.equal(out.migrated, 1);
  assert.deepEqual(out.groups[0].lastOp, { d: 'legacy', s: 3 });
});

it('墓碑保留 isDeleted + legacy stamp', async () => {
  const { migrateOpStamps } = await import('@/utils/opStampMigration');
  const out = migrateOpStamps([
    { id: 'g1', name: 'g', tabs: [], createdAt: NOW, updatedAt: NOW, version: 1, isDeleted: true, isLocked: false } as any,
  ]);
  assert.equal(out.groups[0].isDeleted, true);
  assert.deepEqual(out.groups[0].lastOp, { d: 'legacy', s: 1 });
});

it('已带 stamp 的实体（d !== "legacy"）跳过（幂等）', async () => {
  const { migrateOpStamps } = await import('@/utils/opStampMigration');
  const out = migrateOpStamps([
    { id: 'g1', name: 'g', tabs: [], createdAt: NOW, updatedAt: NOW, version: 1, isDeleted: false, isLocked: false, lastOp: { d: 'devA', s: 50 } } as any,
  ]);
  assert.equal(out.migrated, 0);
  assert.deepEqual(out.groups[0].lastOp, { d: 'devA', s: 50 });
});

it('tab 也走相同规则', async () => {
  const { migrateOpStamps } = await import('@/utils/opStampMigration');
  const out = migrateOpStamps([
    { id: 'g1', name: 'g', tabs: [{ id: 't1', url: 'u', title: 't', favicon: '', createdAt: NOW, lastAccessed: NOW, pinned: false, version: 1 } as any], createdAt: NOW, updatedAt: NOW, version: 1, isDeleted: false, isLocked: false } as any,
  ]);
  assert.equal(out.migrated, 2); // 1 组 + 1 tab
  assert.deepEqual(out.groups[0].tabs[0].lastOp, { d: 'legacy', s: 1 });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test 2>&1 | grep -A2 opStampMigration`
Expected: FAIL

- [ ] **Step 3: 最小实现**

```ts
// src/utils/opStampMigration.ts
/**
 * 阶段二存量数据迁移（规格 §7）：所有未带 stamp 的实体盖 legacy 印记；本设备 seq
 * 初始化为 max+1000。幂等。
 */
import type { TabGroup, Tab } from '@/types/tab';
import { makeStamp } from '@/utils/opStamp';

export interface MigrationResult {
  groups: TabGroup[];
  migrated: number;
}

export function migrateOpStamps(groups: TabGroup[]): MigrationResult {
  let migrated = 0;
  const out: TabGroup[] = groups.map(g => {
    const newGroup = { ...g };
    if (!newGroup.lastOp) {
      newGroup.lastOp = makeStamp('legacy', newGroup.version || 1);
      migrated++;
    }
    newGroup.tabs = newGroup.tabs.map(t => {
      const nt = { ...t };
      if (!nt.lastOp) {
        nt.lastOp = makeStamp('legacy', (nt as any).version || 1);
        migrated++;
      }
      return nt;
    });
    return newGroup;
  });
  return { groups: out, migrated };
}
```

`src/utils/storage.ts` 改动：

```ts
// STORAGE_KEYS 追加：
OP_STAMP_MIGRATED: 'op_stamp_migrated',

// ChromeStorage 类内追加：
async getOpStampMigrated(): Promise<boolean> {
  try { return (await kvGet<boolean>(STORAGE_KEYS.OP_STAMP_MIGRATED)) === true; }
  catch { return false; }
}
async setOpStampMigrated(v: boolean): Promise<void> {
  try { await kvSet(STORAGE_KEYS.OP_STAMP_MIGRATED, v); }
  catch (err) { console.error('设置 op_stamp_migrated 失败:', err); }
}
// clear() keys 数组追加：STORAGE_KEYS.OP_STAMP_MIGRATED
// STORAGE_VERSION: 4 → 5
```

`src/background/mutationService.ts` 启动时：

```ts
import { migrateOpStamps } from '@/utils/opStampMigration';

async function ensureMigrated() {
  if (await storage.getOpStampMigrated()) return;
  const groups = await storage.getGroups();
  const { groups: migratedGroups, migrated } = migrateOpStamps(groups);
  if (migrated > 0) await storage.setGroups(migratedGroups);
  await storage.setOpStampMigrated(true);
  console.log(`[OpStamp] 迁移完成: ${migrated} 个实体盖 legacy 印记`);
}

ensureMigrated().catch(err => console.error('[OpStamp] 迁移失败:', err));
```

> **决策**：迁移触发点选 SW 启动（service-worker.ts 顶部），单一入口即可。规格 §7.5「popup 启动也做一次」为冗余保护——本任务保留 SW 入口单点；阶段三若发现实操需要可补 popup 入口（Task 1 已存疑点「二选一」之一）。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test && pnpm type-check`
Expected: 通过

- [ ] **Step 5: 提交**

```bash
git add src/utils/opStampMigration.ts src/utils/storage.ts src/background/mutationService.ts tests/opStampMigration.test.ts
git commit -m "feat(sync): 存量数据迁移 legacy 印记（阶段二·规格§7）"
```

---

### Task 10: 切换调用点 + 退役 `mergeTabGroupsLegacy`

**Files:**
- Modify: `src/services/syncEngine.ts:253`（已 Task 8 切换）
- Modify: `src/utils/syncUtils.ts`（重命名为 `mergeTabGroupsLegacy` 并保留作为 fallback 路径，由 feature flag `STORAGE_VERSION_LEGACY_MERGE` 控制；Task 11 验证后**删除**）
- Test: 冒烟任务（Task 11 覆盖）

**Interfaces:**
- Produces: `mergeTabGroupsLegacy` 仅当云端 `last_op_device IS NULL AND last_op_seq IS NULL`（即未升级云端）时启用；否则走 `mergeOpStamped`。
- 「不做半自动过渡态」（§9）：此 fallback 仅为**云端 schema 尚未升级**的部署窗口存在，不是给客户端做开关。Task 11 在云端 schema 升级后立即删除。

- [ ] **Step 1: syncUtils.ts 重命名 + export**

```ts
// src/utils/syncUtils.ts 顶部：
/**
 * @deprecated 阶段二（§5）：合并语义已切换到 mergeOpStamped。mergeTabGroupsLegacy
 * 仅作为云端未升级（last_op_device/last_op_seq 列不存在）期间的 fallback，阶段
 * 二发布窗口关闭后删除。
 */
export const mergeTabGroupsLegacy = mergeTabGroups; // 原 mergeTabGroups 函数体重命名
```

- [ ] **Step 2: downloadAndMerge 内部决策**

```ts
// src/services/syncEngine.ts:240
const cloudHasStamp = cloudGroups.some(g => g.lastOp);
const mergedGroups = cloudHasStamp
  ? mergeOpStamped(localGroups, cloudGroups, { mergeStamp: await mergeStamp })
  : mergeTabGroupsLegacy(localGroups, cloudGroups, state.settings.syncStrategy || 'newest');
```

- [ ] **Step 3: 类型检查**

Run: `pnpm type-check && pnpm test`
Expected: 通过

- [ ] **Step 4: 提交**

```bash
git add src/utils/syncUtils.ts src/services/syncEngine.ts
git commit -m "refactor(sync): 合并函数分支——legacy fallback 保留至云端升级（阶段二·§9）"
```

---

### Task 11: 全量验证 + 冒烟 + 退役 legacy + 发布 v1.19.0

**Files:** 无新增；全库回归。

- [ ] **Step 1: 删除 `mergeTabGroupsLegacy`**

确认云端 schema 已升级（`last_op_device`/`last_op_seq` 列存在且老客户端已升级覆盖）：
- 在 `src/utils/syncUtils.ts` 删除 `mergeTabGroupsLegacy` 与 `mergeTabGroups`
- `syncEngine.ts` 删 fallback 分支，仅留 `mergeOpStamped`

- [ ] **Step 2: 自动化全绿**

Run: `pnpm test && pnpm type-check && pnpm lint && pnpm build`
Expected: 全部通过

- [ ] **Step 3: 手动冒烟（加载 dist/ 到 Chrome，双窗口 + 登录态）**

1. 单设备：保存 → 删除 → 恢复 → 重命名 → 拖动排序 → 导入 → 清理重复。UI 即时响应、SW console 无报错、storage 含 `lastOp` 字段。
2. 双设备合并：
   - A 保存 → B 立即下载合并 → B 显示 A 的组（验证 §5.1 stamp 决胜）
   - A 删除 → B 立即下载合并 → B 显示墓碑/回收站
   - A 改名 → B 立即下载合并 → B 显示新名（验证 §5.2 字段跟随组 stamp）
   - A 拖动 → B 立即下载合并 → B 顺序更新（验证 §5.2 displayOrder）
   - A 离线编辑 3 个会话 → B 离线编辑同 3 个会话不同字段 → 双端同步后合并结果确定性（验证 §10 性质测试人工抽样）
3. 崩溃重放模拟：手动 `chrome.storage.local.remove('tab_groups')` 但保留 journal → 重启 SW → journal 重放重建 groups（验证 §4.3 + Task 5 写序）
4. 迁移冒烟：模拟老版本用户（无 `lastOp` 数据）→ 安装新版本 → 验证 entities 全部带 legacy stamp + 本设备 seq 跳号（验证 §7 + Task 9）

- [ ] **Step 4: 发布 v1.19.0**

```bash
git add -A && git commit -m "chore(release): v1.19.0 —— 阶段二（操作印记）合入" --allow-empty
# 同步 tag、推送等走 release-skills
```

---

## 自审记录（写计划后核对）

1. **规格覆盖**：
   - §4.1 OpStamp → Task 1/2/4；§4.2 全序 → Task 1（已确认 s/d 二分枝，无 updatedAt/id 兜底——同 s 同 d 不可能存在「两个不同实体」，序数保证唯一赢家）；§4.3 journal → Task 3/5。
   - §5.1/§5.2 组级与字段 → Task 6；§5.3 标签级 → Task 6 + Task 4（removeTab 不动组 stamp 决策已注记）；§5.4 URL 去重 → Task 6（重加存活已钉死用例）；§5.5 既有安全网 → 保留。
   - §6.1 云端 schema → Task 7；§6.2 Web 仪表盘 → 留阶段三（webApi 改用印记写起来独立、但与扩展端合并协议强耦合，不宜混入阶段二主线；规格 §12 第 3 条仅要求「Web 改名与本地确定性决胜」，与扩展端合并纯函数 Task 6 已自然覆盖——webApi 写时也带 stamp 即满足）。
   - §7 迁移 → Task 9。
   - §9 发布顺序：阶段二合入即切换，不做半自动过渡（Task 10 仅作云端未升级窗口的 fallback，不是客户端开关）。
   - §10 测试策略：交换律/幂等/收敛 → Task 6 性质测试；崩溃重放 → Task 11 冒烟（journal 重放实现未独立 Task——已与 Task 5 写序绑定，Task 11 冒烟抽样）。
   - §11 既有机制去留：version 冻结（Task 4 仍 bump 是为了现有 UI 期望——已注记；Task 7 列保留兼容）；REFRESH_TAB_LIST 已在阶段一废弃；30s 缓存 TTL 保留。
2. **占位符扫描**：无 TBD/TODO；Task 9 注记「popup 启动也做一次」是规格 §7.5 的字面要求，但实施时合并到 SW 单点，理由已注记——非占位，是设计收敛。Task 6/7 各有一处「`version` 字段保留兼容」的具体决策记录，非占位。
3. **类型一致性**：
   - `OpStamp` 定义在 `src/utils/opStamp.ts`，消费方 `types/tab.ts` 通过 `import type` 取——Task 4 注记「若 circular 担忧可内联到 types/tab.ts」，以最终编译结果为准。
   - `MutationOp.op` 在 Task 3 journal.appendEntry 中以判别联合字符串透传；与 Task 5 mutationHandlers 的 `cmd.op` 类型一致。
   - `JournalEntry.s === stamp.s`：journal 内部先 `nextSeq` 再 appendEntry，返回 entry 的 s 即 stamp 的 s——Task 5 mutationHandlers 直接 `entry.s` 作为 stamp.s，无二次分配。
   - `mergeOpStamped` 的 mergeStamp 由 syncEngine 调用方（SW 内）注入 seq，与 mutationHandlers 同源；保证 §5.4 合并墓碑落盘后下次合并可被本设备新一轮操作覆盖（合并 stamp 与用户操作 stamp 共享全序空间）。
4. **决策记录**：
   - 规格 §4.2「s/d 之后回退 updatedAt/id」——**不实施**（用户已确认仅 s/d 二分枝）。
   - 规格 §5.3「removeTab 不动组 stamp」——已实施（Task 4 注记）。
   - 规格 §5.4「跨设备同 URL 重加存活」——已实施（Task 6 用例钉死）。
   - 阶段二合入即切换（§9 拍板）——已实施（Task 10 fallback 仅云端未升级期间）。
   - 阶段三入口：Web 仪表盘收编（§6.2）、§8 GC、调试视图、journal 重放实现、性质测试补全（任务具体规格）——独立于本计划。