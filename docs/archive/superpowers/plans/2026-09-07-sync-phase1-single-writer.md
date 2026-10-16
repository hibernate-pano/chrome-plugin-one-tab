# 同步层重构 阶段一：单写者 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一台设备内所有数据变更收敛到 Service Worker 单点串行执行，popup 改为"发语义命令 + 订阅 storage 变化"，消除双进程并发读-改-写导致的"刚保存被覆盖"（规格 §3，根因 R1/R2/R3/R6）。

**Architecture:** SW 内建 FIFO mutation 队列；popup 的 tabSlice thunk 变成"乐观更新 Redux + `sendMutation` 命令"；变更核心逻辑提取为 `src/utils/mutationOps.ts` 纯函数（node:test 可测）；同步操作（上传/下载合并/调度上传）同样入队并由 SW 独占；popup 通过 `chrome.storage.onChanged` 对账。

**Tech Stack:** TypeScript + React + Redux Toolkit（现有）、node:test（`pnpm test`，别名加载器 `tests/_alias-loader.mjs`）、chrome.runtime.sendMessage / chrome.storage.onChanged。

**规格：** `docs/superpowers/specs/2026-09-07-sync-single-writer-op-stamp-design.md`（本计划 = 阶段一）

## Global Constraints

- 本阶段**不改** `mergeTabGroups` / 墓碑 / version / `decideDownloadPrecheck` 的语义（阶段二内容）。
- thunk 签名与 fulfilled payload 保持不变，组件 reducer 不改（除显式列出的 updateGroup 删除）。
- 测试运行：`pnpm test`（= `node --test --experimental-strip-types tests/*.test.ts`）；新测试必须可在该命令下通过，禁止依赖 chrome API（依赖注入或纯函数）。
- MV3 约束：SW 随时被杀；`chrome.alarms` 最小间隔 0.5 分钟；持久化标志（pending_upload）语义不变。
- 所有持久化写仍走 `storage.setGroups`（其防抖/缓存行为不变）。
- 每个 Task 结束必须 `pnpm test` 全绿 + `pnpm type-check` 通过再 commit。
- 提交信息用中文，格式 `refactor(sync): ...` / `feat(sync): ...` / `test(sync): ...`。

---

### Task 1: mutationQueue —— SW 内 FIFO 串行队列

**Files:**
- Create: `src/background/mutationQueue.ts`
- Test: `tests/mutationQueue.test.ts`

**Interfaces:**
- Produces: `enqueue<T>(name: string, job: () => Promise<T>): Promise<T>`（FIFO 串行执行，job 抛错不影响后续）、`getQueueDepth(): number`（含在执行中的 1 个）。后续所有 SW 侧写操作经它串行化。

- [ ] **Step 1: 写失败测试**

```ts
// tests/mutationQueue.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enqueue, getQueueDepth, resetQueue } from '@/background/mutationQueue';

describe('mutationQueue: SW 单写者串行化', () => {
  it('按 FIFO 顺序串行执行，前一个完成才开始下一个', async () => {
    resetQueue();
    const order: string[] = [];
    const job = (name: string, ms: number) => async () => {
      order.push(`${name}:start`);
      await new Promise(r => setTimeout(r, ms));
      order.push(`${name}:end`);
      return name;
    };
    const [a, b, c] = await Promise.all([
      enqueue('a', job('a', 30)),
      enqueue('b', job('b', 5)),
      enqueue('c', job('c', 1)),
    ]);
    assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
    assert.equal([a, b, c].join(''), 'abc');
  });

  it('job 抛错时该调用 reject，但队列继续消化后续 job', async () => {
    resetQueue();
    const ran: string[] = [];
    await assert.rejects(
      enqueue('boom', async () => { throw new Error('boom'); }),
      /boom/
    );
    await enqueue('next', async () => { ran.push('next'); });
    assert.deepEqual(ran, ['next']);
  });

  it('getQueueDepth 反映排队深度，执行完归零', async () => {
    resetQueue();
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const p = enqueue('slow', () => gate);
    assert.equal(getQueueDepth(), 1);
    release();
    await p;
    assert.equal(getQueueDepth(), 0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test 2>&1 | grep -A2 mutationQueue`
Expected: FAIL（找不到 `@/background/mutationQueue`）

- [ ] **Step 3: 最小实现**

```ts
// src/background/mutationQueue.ts
/**
 * 单写者队列（规格 §3.3）：SW 内所有数据变更（语义命令、上传、下载合并）
 * 串行执行，保证任何"读-改-写"期间没有并发写。Promise 链实现，FIFO。
 */
type Job = { name: string; run: () => Promise<unknown> };

let tail: Promise<unknown> = Promise.resolve();
let depth = 0;

export function enqueue<T>(name: string, job: () => Promise<T>): Promise<T> {
  depth += 1;
  const result = tail.then(job, job) as Promise<T>;
  // tail 吞掉错误：单个 job 失败不阻断后续；错误由调用方的 result 承载
  tail = result.catch(() => undefined);
  void result.finally(() => { depth -= 1; });
  return result;
}

export function getQueueDepth(): number {
  return depth;
}

/** 仅测试用：重置队列状态（模块级 tail/depth 无法跨用例残留） */
export function resetQueue(): void {
  tail = Promise.resolve();
  depth = 0;
}
```

注意：`tail.then(job, job)` 保证前一个 job 无论成败都轮到下一个；错误沿 `result` 抛给调用方。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test 2>&1 | grep -A2 mutationQueue`
Expected: 3 个用例 PASS

- [ ] **Step 5: 提交**

```bash
git add src/background/mutationQueue.ts tests/mutationQueue.test.ts
git commit -m "feat(sync): 单写者 FIFO mutation 队列（阶段一·规格§3.3）"
```

---

### Task 2: mutationProtocol —— 命令类型 + popup 发送器

**Files:**
- Create: `src/shared/mutationProtocol.ts`
- Test: `tests/mutationProtocol.test.ts`

**Interfaces:**
- Produces:
  - `MutationOp`（判别联合，全部 12 个命令）
  - `MutationResult<P> = { ok: boolean; error?: string; payload?: P }`
  - `sendMutation<P>(cmd: MutationOp, sender?: MessageSender): Promise<MutationResult<P>>`，`MessageSender = (msg: unknown) => Promise<unknown>`；默认 sender 用 `chrome.runtime.sendMessage({ type: 'MUTATE', data: cmd })`。
  - `sendSyncCommand(op: 'upload' | 'download' | 'scheduleUpload', extra?: Record<string, unknown>): Promise<MutationResult>`（同通道，type: `'SYNC'`）。
- Consumes: 无（独立模块）。Task 6/8/10 依赖这些类型与函数。

- [ ] **Step 1: 写失败测试**

```ts
// tests/mutationProtocol.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sendMutation, sendSyncCommand, MessageSender } from '@/shared/mutationProtocol';

const fakeSender: MessageSender = async (msg: any) => ({
  ok: true,
  payload: { echoed: msg },
});

describe('mutationProtocol: 命令发送', () => {
  it('把 MutationOp 包进 {type:MUTATE, data} 并回传 payload', async () => {
    const res = await sendMutation<{ echoed: any }>(
      { op: 'removeTab', groupId: 'g1', tabId: 't1' },
      fakeSender
    );
    assert.equal(res.ok, true);
    assert.equal((res.payload as any).echoed.type, 'MUTATE');
    assert.deepEqual((res.payload as any).echoed.data, { op: 'removeTab', groupId: 'g1', tabId: 't1' });
  });

  it('SW 返回 ok:false 时透传 error 而不抛异常', async () => {
    const res = await sendMutation({ op: 'deleteGroup', groupId: 'g1' }, async () => ({ ok: false, error: 'x' }));
    assert.equal(res.ok, false);
    assert.equal(res.error, 'x');
  });

  it('sender 抛异常（SW 唤醒失败等）转为 ok:false', async () => {
    const res = await sendMutation({ op: 'saveGroup', group: {} as any }, async () => { throw new Error('no SW'); });
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /no SW/);
  });

  it('sendSyncCommand 走 SYNC 通道', async () => {
    const res = await sendSyncCommand('scheduleUpload', { delayMs: 1500 }, fakeSender as any);
    assert.equal(res.ok, true);
    const echoed = (res.payload as any).echoed;
    assert.equal(echoed.type, 'SYNC');
    assert.deepEqual(echoed.data, { op: 'scheduleUpload', delayMs: 1500 });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test 2>&1 | grep -A2 mutationProtocol`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

```ts
// src/shared/mutationProtocol.ts
/**
 * 语义命令协议（规格 §3.1/§3.2）：popup/Web 不再自己写 storage，
 * 通过 MUTATE/SYNC 消息把命令交给 SW 的 mutationService 执行。
 * sender 可注入，node:test 无 chrome 环境可测。
 */
import type { TabGroup } from '@/types/tab';

export type MutationOp =
  | { op: 'saveGroup'; group: TabGroup }
  | { op: 'removeTab'; groupId: string; tabId: string }          // 点开=移出、显式删除，同语义
  | { op: 'deleteGroup'; groupId: string }
  | { op: 'deleteAllGroups' }
  | { op: 'restoreGroup'; groupId: string }
  | { op: 'purgeGroup'; groupId: string }
  | { op: 'importGroups'; groups: TabGroup[] }
  | { op: 'renameGroup'; groupId: string; name: string }
  | { op: 'toggleGroupLock'; groupId: string }
  | { op: 'moveGroup'; dragIndex: number; hoverIndex: number }
  | { op: 'moveTab'; sourceGroupId: string; sourceIndex: number; targetGroupId: string; targetIndex: number; updateSourceInDrag?: boolean }
  | { op: 'cleanDuplicates' };

export interface MutationResult<P = unknown> {
  ok: boolean;
  error?: string;
  payload?: P;
}

export type MessageSender = (msg: unknown) => Promise<unknown>;

function defaultSender(msg: unknown): Promise<unknown> {
  return chrome.runtime.sendMessage(msg);
}

export async function sendMutation<P = unknown>(
  cmd: MutationOp,
  sender: MessageSender = defaultSender
): Promise<MutationResult<P>> {
  try {
    const res = (await sender({ type: 'MUTATE', data: cmd })) as MutationResult<P> | undefined;
    if (!res) return { ok: false, error: 'SW 无响应' };
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type SyncOp = 'upload' | 'download' | 'scheduleUpload';

export async function sendSyncCommand(
  op: SyncOp,
  extra: Record<string, unknown> = {},
  sender: MessageSender = defaultSender
): Promise<MutationResult> {
  try {
    const res = (await sender({ type: 'SYNC', data: { op, ...extra } })) as MutationResult | undefined;
    if (!res) return { ok: false, error: 'SW 无响应' };
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test 2>&1 | grep -A2 mutationProtocol`
Expected: 4 个用例 PASS

- [ ] **Step 5: 提交**

```bash
git add src/shared/mutationProtocol.ts tests/mutationProtocol.test.ts
git commit -m "feat(sync): 语义命令协议 MUTATE/SYNC（阶段一·规格§3.1）"
```

---

### Task 3: mutationOps（一）—— saveGroup / removeTab 纯函数

**Files:**
- Create: `src/utils/mutationOps.ts`
- Test: `tests/mutationOps.test.ts`

**Interfaces:**
- Consumes: `TabGroup`/`Tab` 类型（`@/types/tab`）、`shouldAutoDeleteAfterTabRemoval`（`@/utils/tabGroupUtils`，纯函数，现有）。
- Produces（后续 Task 4/5 同文件追加，Task 6 的 handler 依赖）:
  - `applySaveGroup(groups: TabGroup[], group: TabGroup, now: string): TabGroup[]`
  - `applyRemoveTab(groups: TabGroup[], groupId: string, tabId: string, now: string): { groups: TabGroup[]; group: TabGroup | null }`
- 语义铁律：与现有 deleteTabAndSync thunk（tabSlice.ts:1021-1078）**逐字段一致**——这是行为保持的验收基准。

- [ ] **Step 1: 写失败测试**

```ts
// tests/mutationOps.test.ts
// 文件头部样板——必须与 tests/tabTombstone.test.ts 的既有模式一致：
// @/ 别名的模块只能在 register(loader) 之后【动态 import】（静态 import 会被
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

// 共享构造器（纯数据，无 @/ 依赖，可安全静态定义）
const NOW = '2026-09-07T10:00:00.000Z';
const EARLIER = '2026-09-01T10:00:00.000Z';

function mkTab(id: string, over: Record<string, unknown> = {}) {
  return { id, url: `https://e.com/${id}`, title: id, favicon: '', createdAt: EARLIER, lastAccessed: EARLIER, pinned: false, ...over };
}
function mkGroup(id: string, tabs: unknown[], over: Record<string, unknown> = {}) {
  return { id, name: `g-${id}`, tabs, createdAt: EARLIER, updatedAt: EARLIER, version: 1, isDeleted: false, isLocked: false, ...over };
}
```

每个 `it` 内按需动态导入，例如：

```ts
  it('新组插入头部，按 createdAt 倒序', async () => {
    const { applySaveGroup } = await import('@/utils/mutationOps');
    const a = mkGroup('a', []);
    const fresh = mkGroup('fresh', [], { createdAt: NOW });
    const out = applySaveGroup([a], fresh, NOW);
    assert.deepEqual(out.map(g => g.id), ['fresh', 'a']);
  });

describe('mutationOps.applySaveGroup', () => {
  it('新组插入头部，按 createdAt 倒序', () => {
    const a = mkGroup('a', []);
    const fresh = mkGroup('fresh', [], { createdAt: NOW });
    const out = applySaveGroup([a], fresh, NOW);
    assert.deepEqual(out.map(g => g.id), ['fresh', 'a']);
  });
  it('不改变传入数组（不可变）', () => {
    const a = mkGroup('a', []);
    const fresh = mkGroup('fresh', [], { createdAt: NOW });
    applySaveGroup([a], fresh, NOW);
    assert.deepEqual(a.tabs, []);
  });
});

describe('mutationOps.applyRemoveTab（语义命令，替代 updateGroup diff——根因 R3）', () => {
  it('只墓碑化指定 tab：其余 tab 原样，组 version+1、updatedAt=now', () => {
    const g = mkGroup('g1', [mkTab('t1'), mkTab('t2')]);
    const { groups, group } = applyRemoveTab([g], 'g1', 't1', NOW);
    const out = groups.find(x => x.id === 'g1')!;
    assert.equal(group!.version, 2);
    assert.equal(out.tabs.find(t => t.id === 't1')!.isDeleted, true);
    assert.equal(out.tabs.find(t => t.id === 't2')!.isDeleted, false);
    assert.equal(out.updatedAt, NOW);
    assert.equal(out.tabs.find(t => t.id === 't2')!.lastAccessed, EARLIER); // 未动
  });
  it('已删除最后一个活跃 tab 且组未锁定 → 整组墓碑化（isDeleted, version+1），tab 数组原样', () => {
    const g = mkGroup('g1', [mkTab('t1')]);
    const { groups, group } = applyRemoveTab([g], 'g1', 't1', NOW);
    const out = groups.find(x => x.id === 'g1')!;
    assert.equal(group, null);
    assert.equal(out.isDeleted, true);
    assert.equal(out.version, 2);
    assert.equal(out.tabs.length, 1); // tab 不再重复墓碑
  });
  it('锁定组删到最后一个活跃 tab → 只墓碑 tab，组保留', () => {
    const g = mkGroup('g1', [mkTab('t1')], { isLocked: true });
    const { groups, group } = applyRemoveTab([g], 'g1', 't1', NOW);
    assert.equal(group!.isDeleted, false);
    assert.equal(groups.find(x => x.id === 'g1')!.tabs[0].isDeleted, true);
  });
  it('组内只剩墓碑时删最后一个活跃 tab → 触发整组墓碑（按活跃计数，与 autoDeleteEmptyGroup 口径一致）', () => {
    const g = mkGroup('g1', [mkTab('dead', { isDeleted: true }), mkTab('t1')]);
    const { groups } = applyRemoveTab([g], 'g1', 't1', NOW);
    assert.equal(groups.find(x => x.id === 'g1')!.isDeleted, true);
  });
  it('组不存在 → group 返回 null，数组原样', () => {
    const { groups, group } = applyRemoveTab([], 'nope', 't1', NOW);
    assert.equal(group, null);
    assert.equal(groups.length, 0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test 2>&1 | grep -A3 mutationOps`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

```ts
// src/utils/mutationOps.ts
/**
 * 语义命令的纯函数核心（规格 §3.2）：输入 groups 快照，输出新 groups。
 * 与 tabSlice 各 thunk 的存储写语义逐字段一致（阶段一行为保持）；
 * 纯函数无 IO，node:test 直测。阶段二在此统一加盖操作印记。
 */
import type { TabGroup, Tab } from '@/types/tab';
import { shouldAutoDeleteAfterTabRemoval } from '@/utils/tabGroupUtils';

/** saveGroup 语义（tabSlice.ts:58）：新组置顶，按 createdAt 倒序 */
export function applySaveGroup(groups: TabGroup[], group: TabGroup, _now: string): TabGroup[] {
  return [group, ...groups].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

/**
 * removeTab 语义（= 现有 deleteTabAndSync thunk，tabSlice.ts:1021）：
 * 删除 tabId 后若组内无活跃 tab 且未锁定 → 整组软删墓碑；否则只墓碑该 tab。
 * 幂等：已删除的 tab 不重复处理（version 不膨胀）。
 */
export function applyRemoveTab(
  groups: TabGroup[],
  groupId: string,
  tabId: string,
  now: string
): { groups: TabGroup[]; group: TabGroup | null } {
  const idx = groups.findIndex(g => g.id === groupId);
  if (idx === -1) return { groups, group: null };
  const current = groups[idx];

  if (shouldAutoDeleteAfterTabRemoval(current, tabId)) {
    const out = groups.map(g =>
      g.id === groupId && !g.isDeleted
        ? { ...g, isDeleted: true, version: (g.version || 1) + 1, updatedAt: now }
        : g
    );
    return { groups: out, group: null };
  }

  const updatedTabs = current.tabs.map(tab =>
    tab.id === tabId && !tab.isDeleted ? { ...tab, isDeleted: true, lastAccessed: now } : tab
  );
  const updatedGroup: TabGroup = {
    ...current,
    tabs: updatedTabs,
    updatedAt: now,
    version: (current.version || 1) + 1,
  };
  const out = [...groups];
  out[idx] = updatedGroup;
  return { groups: out, group: updatedGroup };
}
```

注意：`shouldAutoDeleteAfterTabRemoval(current, tabId)` 的现有签名以"删除该 tab 后是否剩活跃"为准，直接复用（其语义已有 autoDeleteEmptyGroup/tabTombstone 测试钉死）。若实现时发现该函数还依赖 UI 侧入参形态，以其现有测试为准对齐，不改变其行为。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test 2>&1 | grep -A3 mutationOps`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/utils/mutationOps.ts tests/mutationOps.test.ts
git commit -m "feat(sync): saveGroup/removeTab 语义纯函数（阶段一·规格§3.2）"
```

---

### Task 4: mutationOps（二）—— 组生命周期与字段命令

**Files:**
- Modify: `src/utils/mutationOps.ts`（追加）
- Test: `tests/mutationOps.test.ts`（追加 describe 块）

**Interfaces:**
- Consumes: `updateGroupWithVersion`（`@/utils/versionHelper`，现有纯函数）。
- Produces:
  - `applyDeleteGroup(groups, groupId, now): TabGroup[]`
  - `applyDeleteAllGroups(groups, now): { groups: TabGroup[]; count: number }`
  - `applyRestoreGroup(groups, groupId, now): { groups: TabGroup[]; restored: TabGroup | null }`（restored=null 表示未找到）
  - `applyPurgeGroup(groups, groupId): TabGroup[]`
  - `applyRenameGroup(groups, groupId, name, now): { groups: TabGroup[]; renamed: TabGroup | null }`
  - `applyToggleGroupLock(groups, groupId, now): { groups: TabGroup[]; isLocked: boolean | null }`
  - `applyImportGroups(groups, incoming, deps: { genId: () => string; sanitizeUrl: (url: string) => string | null }, now): { groups: TabGroup[]; imported: TabGroup[] }`

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 tests/mutationOps.test.ts 末尾（导入遵守 Task 3 样板：本组用例首个 it 内
// const { applyDeleteGroup, ... } = await import('@/utils/mutationOps')，后续 it 可复用文件级缓存变量）
import {
  applyDeleteGroup, applyDeleteAllGroups, applyRestoreGroup, applyPurgeGroup,
  applyRenameGroup, applyToggleGroupLock, applyImportGroups,
} from '@/utils/mutationOps';

describe('mutationOps 组生命周期', () => {
  it('applyDeleteGroup：软删 + version+1，其余组不动', () => {
    const out = applyDeleteGroup([mkGroup('a', []), mkGroup('b', [])], 'a', NOW);
    assert.equal(out.find(g => g.id === 'a')!.isDeleted, true);
    assert.equal(out.find(g => g.id === 'a')!.version, 2);
    assert.equal(out.find(g => g.id === 'b')!.isDeleted, false);
  });
  it('applyDeleteAllGroups：只墓碑活跃组；已墓碑的 version 不动（幂等）', () => {
    const tomb = mkGroup('dead', [], { isDeleted: true, version: 7 });
    const out = applyDeleteAllGroups([mkGroup('a', []), tomb], NOW);
    assert.equal(out.count, 2); // 与现 thunk 一致：count = groups.length
    assert.equal(out.groups.find(g => g.id === 'a')!.isDeleted, true);
    assert.equal(out.groups.find(g => g.id === 'dead')!.version, 7);
  });
  it('applyRestoreGroup：置回活跃 + version+1', () => {
    const g = mkGroup('a', [], { isDeleted: true });
    const out = applyRestoreGroup([g], 'a', NOW);
    assert.equal(out.restored!.isDeleted, false);
    assert.equal(out.restored!.version, 2);
  });
  it('applyRestoreGroup：未找到 → restored=null', () => {
    assert.equal(applyRestoreGroup([], 'x', NOW).restored, null);
  });
  it('applyPurgeGroup：物理移除', () => {
    const out = applyPurgeGroup([mkGroup('a', []), mkGroup('b', [])], 'a', );
    assert.deepEqual(out.map(g => g.id), ['b']);
  });
  it('applyRenameGroup：走 updateGroupWithVersion（version+1）', () => {
    const out = applyRenameGroup([mkGroup('a', [])], 'a', '新名字', NOW);
    assert.equal(out.renamed!.name, '新名字');
    assert.equal(out.renamed!.version, 2);
    assert.equal(out.renamed!.updatedAt, NOW);
  });
  it('applyToggleGroupLock：翻转锁定', () => {
    const out = applyToggleGroupLock([mkGroup('a', [], { isLocked: false })], 'a', NOW);
    assert.equal(out.isLocked, true);
  });
  it('applyImportGroups：生成新 id、丢弃危险 URL tab、置顶', () => {
    const src = mkGroup('old', [mkTab('x', { url: 'javascript:alert(1)' }), mkTab('y')]);
    const { groups, imported } = applyImportGroups(
      [mkGroup('existing', [])],
      [src],
      { genId: (() => { let i = 0; return () => `new${++i}`; })(), sanitizeUrl: (u) => u.startsWith('javascript:') ? null : u },
      NOW
    );
    assert.equal(imported.length, 1);
    assert.equal(imported[0].id, 'new1');
    assert.equal(imported[0].tabs.length, 1); // javascript: 被丢
    assert.equal(imported[0].tabs[0].id, 'new2');
    assert.equal(groups[0].id, 'new1'); // 置顶
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test 2>&1 | grep -B1 -A3 '组生命周期'`
Expected: FAIL

- [ ] **Step 3: 最小实现（追加到 mutationOps.ts）**

```ts
import { updateGroupWithVersion } from '@/utils/versionHelper';

/** deleteGroup 语义（tabSlice.ts:112） */
export function applyDeleteGroup(groups: TabGroup[], groupId: string, now: string): TabGroup[] {
  return groups.map(g =>
    g.id === groupId && !g.isDeleted
      ? { ...g, isDeleted: true, version: (g.version || 1) + 1, updatedAt: now }
      : g
  );
}

/** deleteAllGroups 语义（tabSlice.ts:140）：仅活跃组加墓碑，count=全部组数 */
export function applyDeleteAllGroups(
  groups: TabGroup[],
  now: string
): { groups: TabGroup[]; count: number } {
  return {
    groups: groups.map(g => (g.isDeleted ? g : { ...g, isDeleted: true, version: (g.version || 1) + 1, updatedAt: now })),
    count: groups.length,
  };
}

/** restoreGroup 语义（tabSlice.ts:172） */
export function applyRestoreGroup(
  groups: TabGroup[],
  groupId: string,
  now: string
): { groups: TabGroup[]; restored: TabGroup | null } {
  const target = groups.find(g => g.id === groupId);
  if (!target) return { groups, restored: null };
  return {
    groups: groups.map(g =>
      g.id === groupId ? { ...g, isDeleted: false, version: (g.version || 1) + 1, updatedAt: now } : g
    ),
    restored: { ...target, isDeleted: false, version: (target.version || 1) + 1, updatedAt: now },
  };
}

/** purgeGroup 语义（tabSlice.ts:203）：物理移除（仅回收站场景） */
export function applyPurgeGroup(groups: TabGroup[], groupId: string): TabGroup[] {
  return groups.filter(g => g.id !== groupId);
}

/** renameGroup 语义（updateGroupNameAndSync，tabSlice.ts:251） */
export function applyRenameGroup(
  groups: TabGroup[],
  groupId: string,
  name: string,
  now: string
): { groups: TabGroup[]; renamed: TabGroup | null } {
  let renamed: TabGroup | null = null;
  const out = groups.map(g => {
    if (g.id !== groupId) return g;
    renamed = updateGroupWithVersion(g, { name, updatedAt: now });
    return renamed;
  });
  return { groups: out, renamed };
}

/** toggleGroupLock 语义（toggleGroupLockAndSync，tabSlice.ts:282） */
export function applyToggleGroupLock(
  groups: TabGroup[],
  groupId: string,
  now: string
): { groups: TabGroup[]; isLocked: boolean | null } {
  const group = groups.find(g => g.id === groupId);
  if (!group) return { groups, isLocked: null };
  const updated = updateGroupWithVersion(group, { isLocked: !group.isLocked, updatedAt: now });
  return { groups: groups.map(g => (g.id === groupId ? updated : g)), isLocked: updated.isLocked };
}

/** importGroups 语义（tabSlice.ts:219）：新 id、URL 清洗、置顶。genId/sanitizeUrl 注入便于测试 */
export function applyImportGroups(
  groups: TabGroup[],
  incoming: TabGroup[],
  deps: { genId: () => string; sanitizeUrl: (url: string) => string | null },
  _now: string
): { groups: TabGroup[]; imported: TabGroup[] } {
  const processed = incoming.map(group => ({
    ...group,
    id: deps.genId(),
    tabs: group.tabs.reduce<Tab[]>((acc, tab) => {
      const url = deps.sanitizeUrl(tab.url);
      if (!url) return acc;
      acc.push({ ...tab, url, id: deps.genId() });
      return acc;
    }, []),
  }));
  return {
    groups: [...processed, ...groups].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    ),
    imported: processed,
  };
}
```

实现时注意：`updateGroupWithVersion` 的确切入参形态以其现有实现为准（`src/utils/versionHelper.ts`）；若它不接受 `updatedAt` 覆盖，则在其返回值上再展开覆盖 `{...updated, updatedAt: now}`，保持 thunk 现行为（thunk 只改目标字段 + version+1，updatedAt 由 thunk 内 now 写入）。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test 2>&1 | tail -5`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/utils/mutationOps.ts tests/mutationOps.test.ts
git commit -m "feat(sync): 组生命周期/字段命令纯函数（阶段一·规格§3.2）"
```

---

### Task 5: mutationOps（三）—— moveGroup / moveTab / cleanDuplicates

**Files:**
- Modify: `src/utils/mutationOps.ts`（追加）
- Test: `tests/mutationOps.test.ts`（追加）

**Interfaces:**
- Consumes: `updateDisplayOrder`（`@/utils/versionHelper`）、`shouldAutoDeleteAfterTabRemoval`。
- Produces:
  - `applyMoveGroup(groups, dragIndex, hoverIndex): TabGroup[] | null`（索引非法返回 null）
  - `applyMoveTab(groups, args: { sourceGroupId; sourceIndex; targetGroupId; targetIndex }, now): { groups: TabGroup[]; autoDeletedGroupId: string | null }`
  - `applyCleanDuplicates(groups, now): { groups: TabGroup[]; removedTabsCount: number; removedGroupsCount: number }`
- 已知既有缺陷（不在本阶段修，保持行为）：moveGroup/moveTab 的索引来自 UI 的活跃视图，storage 数组含墓碑时索引可能偏移。阶段二语义命令化后按 id 定位解决。

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 tests/mutationOps.test.ts 末尾（导入方式同 Task 4 注记：动态 import）
import { applyMoveGroup, applyMoveTab, applyCleanDuplicates } from '@/utils/mutationOps';

describe('mutationOps 移动与清理', () => {
  it('applyMoveGroup：交换位置并重排 displayOrder', () => {
    const a = mkGroup('a', []), b = mkGroup('b', []);
    const out = applyMoveGroup([a, b], 0, 1);
    assert.deepEqual(out!.map(g => g.id), ['b', 'a']);
    assert.ok(out!.every(g => typeof g.displayOrder === 'number'));
  });
  it('applyMoveGroup：索引越界 → null', () => {
    assert.equal(applyMoveGroup([mkGroup('a', [])], 0, 5), null);
    assert.equal(applyMoveGroup([mkGroup('a', [])], -1, 0), null);
  });
  it('applyMoveTab：跨组移动，两侧 version+1', () => {
    const g1 = mkGroup('g1', [mkTab('t1'), mkTab('t2')]);
    const g2 = mkGroup('g2', [mkTab('t3')]);
    const { groups } = applyMoveTab([g1, g2], { sourceGroupId: 'g1', sourceIndex: 0, targetGroupId: 'g2', targetIndex: 1 }, NOW);
    const out1 = groups.find(g => g.id === 'g1')!;
    const out2 = groups.find(g => g.id === 'g2')!;
    assert.deepEqual(out2.tabs.map(t => t.id), ['t3', 't1']);
    assert.deepEqual(out1.tabs.map(t => t.id), ['t2']);
    assert.equal(out1.version, 2);
    assert.equal(out2.version, 2);
  });
  it('applyMoveTab：同组移动只动一个组、version+1 一次', () => {
    const g1 = mkGroup('g1', [mkTab('t1'), mkTab('t2'), mkTab('t3')]);
    const { groups } = applyMoveTab([g1], { sourceGroupId: 'g1', sourceIndex: 0, targetGroupId: 'g1', targetIndex: 2 }, NOW);
    const out = groups.find(g => g.id === 'g1')!;
    assert.deepEqual(out.tabs.map(t => t.id), ['t2', 't3', 't1']);
    assert.equal(out.version, 2);
  });
  it('applyMoveTab：跨组移空源组且未锁定 → 源组墓碑化', () => {
    const g1 = mkGroup('g1', [mkTab('t1')]);
    const g2 = mkGroup('g2', []);
    const { groups, autoDeletedGroupId } = applyMoveTab([g1, g2], { sourceGroupId: 'g1', sourceIndex: 0, targetGroupId: 'g2', targetIndex: 0 }, NOW);
    assert.equal(autoDeletedGroupId, 'g1');
    assert.equal(groups.find(g => g.id === 'g1')!.isDeleted, true);
  });
  it('applyMoveTab：源组锁定 → 不墓碑', () => {
    const g1 = mkGroup('g1', [mkTab('t1')], { isLocked: true });
    const g2 = mkGroup('g2', []);
    const { autoDeletedGroupId } = applyMoveTab([g1, g2], { sourceGroupId: 'g1', sourceIndex: 0, targetGroupId: 'g2', targetIndex: 0 }, NOW);
    assert.equal(autoDeletedGroupId, null);
  });
  it('applyCleanDuplicates：同 URL 保留最新（lastAccessed），其余墓碑；清理后空且未锁定的组墓碑化', () => {
    const old = mkTab('old', { url: 'https://dup.com', lastAccessed: '2026-01-01T00:00:00.000Z' });
    const fresh = mkTab('fresh', { url: 'https://dup.com', lastAccessed: NOW });
    const g1 = mkGroup('g1', [old, fresh]);
    const g2 = mkGroup('g2', [mkTab('solo', { url: 'https://x.com' })]);
    // g2 唯一 tab 也被墓碑的场景：构造第二个 dup 到 g2
    const stale2 = mkTab('stale2', { url: 'https://x.com', lastAccessed: '2026-01-01T00:00:00.000Z' });
    g2.tabs.push(stale2);
    const { groups, removedTabsCount, removedGroupsCount } = applyCleanDuplicates([g1, g2], NOW);
    const out1 = groups.find(g => g.id === 'g1')!;
    assert.equal(removedTabsCount, 2);
    assert.equal(out1.tabs.find(t => t.id === 'old')!.isDeleted, true);
    assert.equal(out1.tabs.find(t => t.id === 'fresh')!.isDeleted, false);
    assert.equal(removedGroupsCount, 1); // g2 清空且未锁定
    assert.equal(groups.find(g => g.id === 'g2')!.isDeleted, true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test 2>&1 | grep -A3 '移动与清理'`
Expected: FAIL

- [ ] **Step 3: 最小实现（追加）**

```ts
import { updateDisplayOrder } from '@/utils/versionHelper';

/** moveGroup 语义（moveGroupAndSync，tabSlice.ts:316）：索引非法返回 null */
export function applyMoveGroup(
  groups: TabGroup[],
  dragIndex: number,
  hoverIndex: number
): TabGroup[] | null {
  if (dragIndex < 0 || dragIndex >= groups.length || hoverIndex < 0 || hoverIndex >= groups.length) {
    return null;
  }
  const newGroups = [...groups];
  const [dragGroup] = newGroups.splice(dragIndex, 1);
  newGroups.splice(hoverIndex, 0, dragGroup);
  return updateDisplayOrder(newGroups);
}

/** moveTab 语义（moveTabAndSync，tabSlice.ts:511）：跨组移空源组→墓碑（含空组自动删除判断） */
export function applyMoveTab(
  groups: TabGroup[],
  args: { sourceGroupId: string; sourceIndex: number; targetGroupId: string; targetIndex: number },
  now: string
): { groups: TabGroup[]; autoDeletedGroupId: string | null } {
  const source = groups.find(g => g.id === args.sourceGroupId);
  const target = groups.find(g => g.id === args.targetGroupId);
  if (!source || !target) return { groups, autoDeletedGroupId: null };
  const tab = source.tabs[args.sourceIndex];
  if (!tab) return { groups, autoDeletedGroupId: null };

  const newSourceTabs = [...source.tabs];
  const newTargetTabs = args.sourceGroupId === args.targetGroupId ? newSourceTabs : [...target.tabs];
  newSourceTabs.splice(args.sourceIndex, 1);
  const adjusted = Math.max(0, Math.min(args.targetIndex, newTargetTabs.length));
  newTargetTabs.splice(adjusted, 0, tab);

  const bump = (g: TabGroup, tabs: Tab[]): TabGroup => ({
    ...g, tabs, updatedAt: now, version: (g.version || 1) + 1,
  });

  let out = groups.map(g => {
    if (g.id === args.sourceGroupId) return bump(g, newSourceTabs);
    if (g.id === args.targetGroupId) return bump(g, newTargetTabs);
    return g;
  });

  let autoDeletedGroupId: string | null = null;
  const movedSource = out.find(g => g.id === args.sourceGroupId)!;
  if (args.sourceGroupId !== args.targetGroupId && movedSource.tabs.length === 0
      && shouldAutoDeleteAfterTabRemoval(movedSource, '')) {
    autoDeletedGroupId = args.sourceGroupId;
    out = out.map(g =>
      g.id === args.sourceGroupId && !g.isDeleted
        ? { ...g, isDeleted: true, version: (g.version || 1) + 1, updatedAt: now }
        : g
    );
  }
  return { groups: out, autoDeletedGroupId };
}

/** cleanDuplicateTabs 语义（tabSlice.ts:380）：同 URL 留最新，余者墓碑；清空未锁定组→墓碑 */
export function applyCleanDuplicates(
  groups: TabGroup[],
  now: string
): { groups: TabGroup[]; removedTabsCount: number; removedGroupsCount: number } {
  let removedTabsCount = 0;
  const urlMap = new Map<string, { tab: Tab; groupId: string }[]>();
  groups.forEach(group => {
    group.tabs.forEach(tab => {
      if (tab.isDeleted) return;
      if (!tab.url) return;
      const key = tab.url.startsWith('loading://') ? `${tab.url}|${tab.title}` : tab.url;
      if (!urlMap.has(key)) urlMap.set(key, []);
      urlMap.get(key)!.push({ tab, groupId: group.id });
    });
  });

  const tombstoned = new Map<string, Set<string>>(); // groupId -> 待墓碑 tabId 集
  urlMap.forEach(list => {
    if (list.length <= 1) return;
    const sorted = [...list].sort(
      (a, b) => new Date(b.tab.lastAccessed).getTime() - new Date(a.tab.lastAccessed).getTime()
    );
    for (let i = 1; i < sorted.length; i++) {
      const { groupId, tab } = sorted[i];
      if (!tombstoned.has(groupId)) tombstoned.set(groupId, new Set());
      tombstoned.get(groupId)!.add(tab.id);
      removedTabsCount++;
    }
  });

  let removedGroupsCount = 0;
  const withTombstones = groups.map(g => {
    const ids = tombstoned.get(g.id);
    if (!ids) return g;
    return {
      ...g,
      tabs: g.tabs.map(t => (ids.has(t.id) && !t.isDeleted ? { ...t, isDeleted: true, lastAccessed: now } : t)),
      updatedAt: now,
      version: (g.version || 1) + 1,
    };
  });

  const finalGroups = withTombstones.map(g => {
    const hasActive = g.tabs.some(t => !t.isDeleted);
    if (!hasActive && !g.isLocked && !g.isDeleted) {
      removedGroupsCount++;
      return { ...g, isDeleted: true, version: (g.version || 1) + 1, updatedAt: now };
    }
    return g;
  });

  return { groups: finalGroups, removedTabsCount, removedGroupsCount };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test 2>&1 | tail -5`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/utils/mutationOps.ts tests/mutationOps.test.ts
git commit -m "feat(sync): 移动/清理重复语义纯函数（阶段一·规格§3.2）"
```

---

### Task 6: mutationHandlers —— SW 端命令执行器

**Files:**
- Create: `src/background/mutationHandlers.ts`
- Test: `tests/mutationHandlers.test.ts`

**Interfaces:**
- Consumes: Task 1 `enqueue`、Task 2 `MutationOp`/`MutationResult`、Task 3-5 全部 `apply*`、`storage`（`@/utils/storage`）、`syncEngine`（`@/services/syncEngine`）、`sanitizeTabUrl`（`@/utils/inputValidation`）。
- Produces: `handleMutation(cmd: MutationOp): Promise<MutationResult>`（读写 storage、调 apply*、成功后按操作类型 `syncEngine.scheduleUpload(...)`）。Task 7 的消息层依赖。
- 调度延迟对齐现 autoSyncMiddleware：删除/新建类 1500ms（saveGroup、deleteGroup、deleteAllGroups、restoreGroup、importGroups、removeTab），其余 3000ms。

- [ ] **Step 1: 写失败测试**

handleMutation 依赖 chrome storage，直接单测用注入式写法不可行（storage 是单例）。可测部分：**分发正确性与错误包装**。做法——把"读→apply→写→schedule"的编排抽成可注入 deps 的工厂：

```ts
// tests/mutationHandlers.test.ts
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
const LOADER_PATH = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')).href;
before(() => { register('./_alias-loader.mjs', pathToFileURL('./').href); });

import { createMutationHandlers } from '@/background/mutationHandlers';
import type { TabGroup } from '@/types/tab';

function memStorage() {
  let groups: TabGroup[] = [];
  const uploads: number[] = [];
  return {
    uploads,
    now: () => NOW,
    async getGroups: async () => [...groups],
    async setGroups: async (g: TabGroup[]) => { groups = [...g]; },
    scheduleUpload: (ms: number) => { uploads.push(ms); },
  };
}

describe('mutationHandlers: 编排（读→apply→写→调度上传）', () => {
  it('removeTab：写入 storage 并按删除优先级 1500ms 调度上传', async () => {
    const deps = memStorage();
    const handlers = createMutationHandlers(deps as any);
    const g = { id: 'g1', name: 'g', tabs: [{ id: 't1', url: 'https://a.com', title: 'a', favicon: '', createdAt: '2026-01-01T00:00:00.000Z', lastAccessed: '2026-01-01T00:00:00.000Z', pinned: false }], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1, isDeleted: false } as TabGroup;
    await deps.setGroups([g]);
    const res = await handlers.handle({ op: 'removeTab', groupId: 'g1', tabId: 't1' });
    assert.equal(res.ok, true);
    assert.deepEqual(deps.uploads, [1500]);
    const stored = await deps.getGroups();
    assert.equal(stored[0].tabs[0].isDeleted, true);
  });

  it('removeTab 整组清空 → payload.group 为 null；组被墓碑化且也调度 1500', async () => {
    const deps = memStorage();
    const handlers = createMutationHandlers(deps as any);
    const g = { id: 'g1', name: 'g', tabs: [{ id: 't1', url: 'https://a.com', title: 'a', favicon: '', createdAt: '2026-01-01T00:00:00.000Z', lastAccessed: '2026-01-01T00:00:00.000Z', pinned: false }], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1, isDeleted: false } as TabGroup;
    await deps.setGroups([g]);
    const res = await handlers.handle({ op: 'removeTab', groupId: 'g1', tabId: 't1' });
    assert.equal((res.payload as any).group, null);
    const stored = await deps.getGroups();
    assert.equal(stored[0].isDeleted, true);
  });

  it('apply 层抛错 → ok:false + error 文本（如 restoreGroup 未找到）', async () => {
    const deps = memStorage();
    const handlers = createMutationHandlers(deps as any);
    const res = await handlers.handle({ op: 'restoreGroup', groupId: 'nope' });
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /未找到/);
  });

  it('未知 op → ok:false', async () => {
    const handlers = createMutationHandlers(memStorage() as any);
    const res = await handlers.handle({ op: 'nope' } as any);
    assert.equal(res.ok, false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test 2>&1 | grep -A3 mutationHandlers`
Expected: FAIL

- [ ] **Step 3: 最小实现**

```ts
// src/background/mutationHandlers.ts
/**
 * SW 端语义命令执行器（规格 §3.2/§3.3）。编排固定为：读 storage → apply* 纯函数
 * → 写 storage → scheduleUpload。由 mutationQueue 串行调用，天然无并发写。
 * deps 注入便于 node:test；生产在 createMutationHandlers 中绑定真实依赖。
 */
import type { TabGroup } from '@/types/tab';
import type { MutationOp, MutationResult } from '@/shared/mutationProtocol';
import { sanitizeTabUrl } from '@/utils/inputValidation';
import { nanoid } from '@reduxjs/toolkit';
import {
  applySaveGroup, applyRemoveTab, applyDeleteGroup, applyDeleteAllGroups,
  applyRestoreGroup, applyPurgeGroup, applyImportGroups, applyRenameGroup,
  applyToggleGroupLock, applyMoveGroup, applyMoveTab, applyCleanDuplicates,
} from '@/utils/mutationOps';

export interface MutationDeps {
  getGroups(): Promise<TabGroup[]>;
  setGroups(groups: TabGroup[]): Promise<void>;
  scheduleUpload(delayMs: number): void;
  now(): string;
}

const DELETE_PRIORITY_MS = 1500; // 删除/新建类（对齐原 autoSyncMiddleware 优先级 ≥8）
const NORMAL_MS = 3000;

export function createMutationHandlers(deps: MutationDeps) {
  async function run(cmd: MutationOp): Promise<MutationResult> {
    const now = deps.now();
    switch (cmd.op) {
      case 'saveGroup': {
        const groups = await deps.getGroups();
        await deps.setGroups(applySaveGroup(groups, cmd.group, now));
        deps.scheduleUpload(DELETE_PRIORITY_MS);
        return { ok: true, payload: cmd.group };
      }
      case 'removeTab': {
        const groups = await deps.getGroups();
        const r = applyRemoveTab(groups, cmd.groupId, cmd.tabId, now);
        await deps.setGroups(r.groups);
        deps.scheduleUpload(DELETE_PRIORITY_MS);
        return { ok: true, payload: { group: r.group } };
      }
      case 'deleteGroup': {
        const groups = await deps.getGroups();
        await deps.setGroups(applyDeleteGroup(groups, cmd.groupId, now));
        deps.scheduleUpload(DELETE_PRIORITY_MS);
        return { ok: true, payload: cmd.groupId };
      }
      case 'deleteAllGroups': {
        const groups = await deps.getGroups();
        const r = applyDeleteAllGroups(groups, now);
        await deps.setGroups(r.groups);
        deps.scheduleUpload(DELETE_PRIORITY_MS);
        return { ok: true, payload: { count: r.count } };
      }
      case 'restoreGroup': {
        const groups = await deps.getGroups();
        const r = applyRestoreGroup(groups, cmd.groupId, now);
        if (!r.restored) throw new Error('未找到该标签组');
        await deps.setGroups(r.groups);
        deps.scheduleUpload(DELETE_PRIORITY_MS);
        return { ok: true, payload: { groupId: cmd.groupId, restoredGroup: r.restored } };
      }
      case 'purgeGroup': {
        const groups = await deps.getGroups();
        await deps.setGroups(applyPurgeGroup(groups, cmd.groupId));
        deps.scheduleUpload(NORMAL_MS);
        return { ok: true, payload: cmd.groupId };
      }
      case 'importGroups': {
        const groups = await deps.getGroups();
        const r = applyImportGroups(groups, cmd.groups, { genId: () => nanoid(), sanitizeUrl: sanitizeTabUrl }, now);
        await deps.setGroups(r.groups);
        deps.scheduleUpload(DELETE_PRIORITY_MS);
        return { ok: true, payload: r.imported };
      }
      case 'renameGroup': {
        const groups = await deps.getGroups();
        const r = applyRenameGroup(groups, cmd.groupId, cmd.name, now);
        await deps.setGroups(r.groups);
        deps.scheduleUpload(NORMAL_MS);
        return { ok: true, payload: { groupId: cmd.groupId, name: cmd.name } };
      }
      case 'toggleGroupLock': {
        const groups = await deps.getGroups();
        const r = applyToggleGroupLock(groups, cmd.groupId, now);
        await deps.setGroups(r.groups);
        deps.scheduleUpload(NORMAL_MS);
        return { ok: true, payload: { groupId: cmd.groupId, isLocked: r.isLocked } };
      }
      case 'moveGroup': {
        const groups = await deps.getGroups();
        const next = applyMoveGroup(groups, cmd.dragIndex, cmd.hoverIndex);
        if (!next) return { ok: false, error: '无效的标签组索引' };
        await deps.setGroups(next);
        deps.scheduleUpload(NORMAL_MS);
        return { ok: true, payload: { dragIndex: cmd.dragIndex, hoverIndex: cmd.hoverIndex } };
      }
      case 'moveTab': {
        const groups = await deps.getGroups();
        const r = applyMoveTab(groups, cmd, now);
        await deps.setGroups(r.groups);
        if (r.autoDeletedGroupId) deps.scheduleUpload(DELETE_PRIORITY_MS);
        else deps.scheduleUpload(NORMAL_MS);
        return {
          ok: true,
          payload: { sourceGroupId: cmd.sourceGroupId, sourceIndex: cmd.sourceIndex, targetGroupId: cmd.targetGroupId, targetIndex: cmd.targetIndex, autoDeletedGroupId: r.autoDeletedGroupId },
        };
      }
      case 'cleanDuplicates': {
        const groups = await deps.getGroups();
        const r = applyCleanDuplicates(groups, now);
        await deps.setGroups(r.groups);
        deps.scheduleUpload(NORMAL_MS);
        return { ok: true, payload: { removedTabsCount: r.removedTabsCount, removedGroupsCount: r.removedGroupsCount, updatedGroups: r.groups } };
      }
      default:
        return { ok: false, error: `未知命令: ${(cmd as { op: string }).op}` };
    }
  }

  return {
    async handle(cmd: MutationOp): Promise<MutationResult> {
      try {
        return await run(cmd);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
```

生产绑定追加在同文件底部（依赖 `storage`/`syncEngine`，仅供 SW 引用；node:test 不 import 该实例即可——因文件顶层已 import chrome 依赖模块，测试通过 `createMutationHandlers` 注入，不触碰顶层。若 `@/utils/storage` 顶层 import 即触发 chrome 访问导致 node:test 崩溃，则把生产绑定拆到 `src/background/mutationService.ts`，handlers 文件保持纯净）：

```ts
// src/background/mutationService.ts（若需拆分则建此文件）
import { storage } from '@/utils/storage';
import { syncEngine } from '@/services/syncEngine';
import { createMutationHandlers } from './mutationHandlers';

export const mutationService = createMutationHandlers({
  getGroups: () => storage.getGroups(),
  setGroups: g => storage.setGroups(g),
  scheduleUpload: ms => syncEngine.scheduleUpload(ms),
  now: () => new Date().toISOString(),
});
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test 2>&1 | tail -5`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/background/mutationHandlers.ts src/background/mutationService.ts tests/mutationHandlers.test.ts
git commit -m "feat(sync): SW 端语义命令执行器（阶段一·规格§3.2）"
```

---

### Task 7: service-worker 接线 —— MUTATE/SYNC 消息 + saveAllTabs 入队

**Files:**
- Modify: `src/service-worker.ts:246-359`（消息监听器加 case）
- Modify: `src/background/TabManager.ts:115-121`（storage 写入走队列）
- Test: 无新增自动化（接线层）；以 Task 12 冒烟覆盖。`pnpm type-check` 必须过。

**Interfaces:**
- Consumes: Task 1 `enqueue`、Task 6 `mutationService`、`syncEngine`。
- Produces: 消息协议 `{type:'MUTATE', data: MutationOp}` / `{type:'SYNC', data:{op, ...}}` 的 SW 端实现。

- [ ] **Step 1: service-worker.ts 消息监听器加 case**

在 `switch (message.type)`（service-worker.ts:257）中追加（置于 `default` 之前）：

```ts
      case 'MUTATE': {
        const cmd = message.data;
        if (!cmd || typeof cmd.op !== 'string') {
          sendResponse({ ok: false, error: '无效命令' });
          return false;
        }
        enqueue(cmd.op, () => mutationService.handle(cmd))
          .then(res => sendResponse(res))
          .catch(err => sendResponse({ ok: false, error: err?.message || '命令执行失败' }));
        return true; // 异步响应
      }

      case 'SYNC': {
        const data = message.data || {};
        if (data.op === 'scheduleUpload') {
          syncEngine.scheduleUpload(typeof data.delayMs === 'number' ? data.delayMs : 3000);
          sendResponse({ ok: true });
          return false;
        }
        enqueue(`sync:${data.op}`, async () => {
          // 统一包装为 MutationResult：ok=业务成败，error=原因码（already_syncing 等），
          // payload=完整原始结果（MergeResult/UploadResult，popup 按需取字段）
          if (data.op === 'upload') {
            const r = await syncEngine.upload({ forcePending: true });
            return { ok: r.success, error: r.error, payload: r };
          }
          if (data.op === 'download') {
            const r = await syncEngine.downloadAndMerge({
              forceRemote: !!data.forceRemote, syncSettings: !!data.syncSettings,
            });
            return { ok: r.success, error: r.reason, payload: r };
          }
          return { ok: false, error: `未知同步操作: ${data.op}` };
        })
          .then(res => sendResponse(res))
          .catch(err => sendResponse({ ok: false, error: err?.message || '同步失败' }));
        return true;
      }
```

文件顶部 import 区追加：

```ts
import { enqueue } from '@/background/mutationQueue';
import { mutationService } from '@/background/mutationService';
```

（若 Task 6 未拆分 mutationService，则此处 import 自 mutationHandlers 的生产实例。）

- [ ] **Step 2: TabManager.saveAllTabs 走队列**

TabManager.ts:115-116 的读改写替换为：

```ts
      // 单写者：saveAllTabs 的存储写入也必须经 mutation 队列，与 popup 命令串行
      // （否则 SW 内部仍可能与其他 job 交错读写 groups）
      const finalGroups = await enqueue('saveAllTabs', async () => {
        const existingGroups = await storage.getGroups();
        return [safeGroup, ...existingGroups].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
      });
      await storage.setGroups(finalGroups);
```

并在 TabManager.ts 顶部 `import { enqueue } from './mutationQueue';`。

- [ ] **Step 3: 类型检查**

Run: `pnpm type-check`
Expected: 无错误

- [ ] **Step 4: 提交**

```bash
git add src/service-worker.ts src/background/TabManager.ts
git commit -m "feat(sync): SW 接线 MUTATE/SYNC 消息与队列（阶段一·规格§3.1）"
```

---

### Task 8: tabSlice 转换 —— thunk 变命令 + UI 语义化 + 删除 updateGroup

**Files:**
- Modify: `src/store/slices/tabSlice.ts`（全部变更 thunk）
- Modify: `src/components/tabs/TabGroup.tsx:194-270`（handleOpenTab / handleDeleteTab）
- Modify: `src/components/search/SearchResultList.tsx:134`（handleOpenTab）
- Modify: `src/components/tabs/ReorderView/index.tsx:76`（handleOpenTab）
- Modify: `src/store/index.ts`（若有 autoSyncMiddleware 挂载则移除，见 Task 9 说明）
- Test: 自动化由 Task 3-5 纯函数测试承载；本任务 `pnpm type-check` + Task 12 冒烟。

**Interfaces:**
- Consumes: Task 2 `sendMutation`、Task 6 命令 payload 形态。
- Produces: thunk 签名不变；`updateGroup` thunk **删除**（R3 修复的另一半——diff 通道退役）。UI 打开/删除标签统一走 `deleteTabAndSync`（其内部改为 removeTab 命令）。

- [ ] **Step 1: 转换变更类 thunk（示例先行，其余同构）**

`saveGroup`（tabSlice.ts:58-74）替换为：

```ts
export const saveGroup = createAsyncThunk('tabs/saveGroup', async (group: TabGroup) => {
  const res = await sendMutation<TabGroup>({ op: 'saveGroup', group });
  if (!res.ok) throw new Error(res.error ?? '保存失败');
  return res.payload!;
});
```

`deleteTabAndSync`（tabSlice.ts:1021-1078）替换为（存储体已迁至 mutationHandlers/mutationOps）：

```ts
export const deleteTabAndSync = createAsyncThunk<
  { group: TabGroup | null },
  { groupId: string; tabId: string },
  { state: any }
>('tabs/deleteTabAndSync', async ({ groupId, tabId }) => {
  const res = await sendMutation<{ group: TabGroup | null }>({ op: 'removeTab', groupId, tabId });
  if (!res.ok) throw new Error(res.error ?? '删除失败');
  return res.payload!;
});
```

其余逐一同构替换（保持各 thunk 的返回 payload 与现 fulfilled reducer 期望一致）：

| thunk | 命令 | payload |
|---|---|---|
| `deleteGroup(groupId)` | `{op:'deleteGroup', groupId}` | `groupId` |
| `deleteAllGroups()` | `{op:'deleteAllGroups'}` | `{count}` |
| `restoreGroup(groupId)` | `{op:'restoreGroup', groupId}` | `{groupId, restoredGroup}` |
| `purgeGroup(groupId)` | `{op:'purgeGroup', groupId}` | `groupId` |
| `importGroups(groups)` | `{op:'importGroups', groups}` | `TabGroup[]`（imported） |
| `updateGroupNameAndSync({groupId,name})` | `{op:'renameGroup', groupId, name}` | `{groupId, name}` |
| `toggleGroupLockAndSync(groupId)` | `{op:'toggleGroupLock', groupId}` | `{groupId, isLocked}` |
| `moveGroupAndSync({dragIndex,hoverIndex})` | `{op:'moveGroup', dragIndex, hoverIndex}` | `{dragIndex, hoverIndex}` |
| `moveTabAndSync({...})` | `{op:'moveTab', ...args}` | 同现 payload + `autoDeletedGroupId` |
| `cleanDuplicateTabs()` | `{op:'cleanDuplicates'}` | `{removedTabsCount, removedGroupsCount, updatedGroups}` |

注意三点：
1. `moveGroupAndSync` / `moveTabAndSync` 现体内的 `requestAnimationFrame` 包裹**删除**——Redux 乐观更新已由各自 thunk 开头的 `dispatch(moveGroup(...))` / `dispatch(moveTab(...))` 承担，存储写由队列异步完成，UI 即时性不受影响。
2. `moveTabAndSync` 体内原 `setTimeout(() => dispatch(deleteGroup(...)), 100)` 自动清理删除——handler 返回 `autoDeletedGroupId` 后，在 thunk 内当 `res.payload.autoDeletedGroupId` 非空时 `dispatch(deleteGroup(id))`（它自身也走命令，幂等）。
3. `updateGroupNameAndSync` / `toggleGroupLockAndSync` 体内原有的 `dispatch(updateGroupName(...))` / `dispatch(toggleGroupLock(...))` **同步 reducer 乐观更新保留**（UI 即时反馈），后接 sendMutation。

- [ ] **Step 2: 删除 updateGroup thunk 与其 extraReducers**

- 删除 `updateGroup`（tabSlice.ts:76-110）及 `extraReducers` 中 `.addCase('tabs/updateGroup/fulfilled' ...)`（或对应生成器写法）。
- 保留 `updateGroupName` / `toggleGroupLock` 同步 reducer（改名/锁定乐观更新仍用）。

- [ ] **Step 3: UI 调用点语义化**

`TabGroup.tsx` handleOpenTab（194-230）中 `shouldAutoDeleteAfterTabRemoval` 分支判断与 `updateGroup(filtered)` 替换为：

```tsx
  const handleOpenTab = useCallback((tab: Tab) => {
    if (!group.isLocked) {
      dispatch(deleteTabAndSync({ groupId: group.id, tabId: tab.id }))
        .unwrap()
        .then(payload => {
          if (payload.group === null) {
            showDeleteSuccess(`已恢复标签页并自动删除空会话 "${group.name}"`);
          }
        })
        .catch(error => {
          console.error('更新会话失败:', error);
          showRestoreError(`更新会话失败: ${error.message || '未知错误'}`);
        });
    }
    // 原有 chrome.runtime.sendMessage OPEN_TAB 打开逻辑保持不变
```

handleDeleteTab（241-266）同样替换为 `deleteTabAndSync`，成功 toast 用 `payload.group` 判断是否走了整组删除分支。`shouldAutoDeleteAfterTabRemoval` 的 UI 侧 import 若不再使用则移除。

`SearchResultList.tsx:134` handleOpenTab、`ReorderView/index.tsx:76` handleOpenTab 同样替换（它们与 TabGroup 同构：删除该 tab + 自动清组语义）。

- [ ] **Step 4: 全库 grep 兜底**

Run: `grep -rn "dispatch(updateGroup(" src/ | grep -v node_modules`
Expected: 无输出（有则逐个转为语义命令）

Run: `pnpm type-check && pnpm test`
Expected: 均通过

- [ ] **Step 5: 提交**

```bash
git add -A src/ tests/
git commit -m "refactor(sync): thunk 转语义命令，退役 updateGroup diff 通道（阶段一·根因R3）"
```

---

### Task 9: 上传调度迁移 —— autoSyncMiddleware 退役 + 双驱动防抖（R6）

**Files:**
- Modify: `src/store/middleware/autoSyncMiddleware.ts`（整体替换为薄壳或删除）
- Modify: `src/store/index.ts`（移除中间件挂载）
- Modify: `src/services/syncEngine.ts:124-143`（scheduleUpload 双驱动）
- Test: `pnpm type-check` + `pnpm test`；行为由 Task 12 冒烟。

**Interfaces:**
- Consumes: Task 2 `sendSyncCommand('scheduleUpload')`。
- Produces: `syncEngine.scheduleUpload` 同时挂 `setTimeout(delayMs)`（快路径，SW 存活期内 1.5~3s 真延迟）与 `chrome.alarms`（≥30s 兜底，SW 被杀后仍触发）；二者都清旧。

- [ ] **Step 1: autoSyncMiddleware 退役**

popup 里 middleware 调 `syncEngine.scheduleUpload`（R1 变体：popup 进程的 timer 不可靠）。handlers 已在 SW 端调度（Task 6），middleware 改为转发并保留文件（避免其他 import 断裂——先 grep）：

```ts
// src/store/middleware/autoSyncMiddleware.ts 整体替换
import type { Middleware } from '@reduxjs/toolkit';
import { sendSyncCommand } from '@/shared/mutationProtocol';

/**
 * @deprecated 阶段一：变更类 thunk 已转为 SW 语义命令，上传调度由
 * mutationHandlers 在 SW 端完成。此中间件仅为仍留在 popup 的同步侧
 * action（如设置保存）兜底转发，命令在 SW 执行。
 */
export const autoSyncMiddleware: Middleware = () => next => action => {
  const result = next(action);
  const a = action as { type?: string; error?: unknown };
  if (typeof a.type === 'string' && !a.error && a.type.startsWith('settings/')) {
    void sendSyncCommand('scheduleUpload', { delayMs: 3000 });
  }
  return result;
};
```

Run: `grep -rn "autoSyncMiddleware" src/ | grep -v node_modules` 确认仅 store/index.ts 挂载处引用，保持挂载不变。

- [ ] **Step 2: scheduleUpload 双驱动**

`syncEngine.scheduleUpload`（syncEngine.ts:124-143）替换为：

```ts
  scheduleUpload(delayMs: number = 3000): void {
    void storage.setPendingUpload(true);
    if (typeof chrome !== 'undefined' && chrome.alarms) {
      // 快路径：SW 存活期内 setTimeout 真延迟（1.5~3s），替代 alarms 的 30s 下限（R6）
      if (this.uploadTimer) clearTimeout(this.uploadTimer);
      this.uploadTimer = setTimeout(() => {
        this.uploadTimer = null;
        void this.upload().catch(err => console.error('[SyncEngine] 快路径上传失败:', err));
      }, delayMs);
      // 兜底：SW 被杀后快路径丢失，alarm 持久化驱动（幂等，上传可重复）
      void chrome.alarms.clear(SYNC_UPLOAD_ALARM).catch(() => {});
      const delayMinutes = Math.max(0.5, delayMs / 60000);
      chrome.alarms.create(SYNC_UPLOAD_ALARM, { delayInMinutes: delayMinutes });
      return;
    }
    // 非扩展运行时 fallback：单测走这里
    if (this.uploadTimer) clearTimeout(this.uploadTimer);
    this.uploadTimer = setTimeout(() => {
      this.uploadTimer = null;
      void this.upload().catch(err => console.error('[SyncEngine] 延迟上传失败:', err));
    }, delayMs);
  }
```

`upload()` 成功路径已 `setPendingUpload(false)` 并 `cancelPendingUpload()` 清双驱动（`cancelPendingUpload` 现有实现已同时清 timer 与 alarm，无需改）。

- [ ] **Step 3: 验证**

Run: `pnpm type-check && pnpm test`
Expected: 通过

- [ ] **Step 4: 提交**

```bash
git add src/store/middleware/autoSyncMiddleware.ts src/services/syncEngine.ts
git commit -m "feat(sync): 上传调度双驱动 setTimeout+alarm，middleware 薄壳化（阶段一·根因R6）"
```

---

### Task 10: 同步操作单点化 —— popup 不再直连 syncEngine（R1 收口）

**Files:**
- Modify: `src/components/app/AuthProvider.tsx:64-77`
- Modify: `src/components/sync/SyncButton.tsx:292,341`
- Modify: `src/components/layout/HeaderDropdown.tsx:68`
- Modify: `src/background/backgroundSync.ts:58-109`（performBackgroundSync 内 upload/download 入队）
- Test: `pnpm type-check` + 冒烟（Task 12）。

**Interfaces:**
- Consumes: Task 2 `sendSyncCommand`、Task 7 SYNC case。
- Produces: popup 无 syncEngine import（grep 验证）；SW 内后台同步与消息同步同队列串行。

- [ ] **Step 1: popup 调用点替换**

AuthProvider.tsx:64-77 的 `syncEngine.downloadAndMerge()` 替换为：

```tsx
                sendSyncCommand('download')
                  .then(res => {
                    if (res.ok) {
                      console.log('[AutoSync] 自动下载合并完成');
                      dispatch(loadGroups());
                    } else if (res.error && res.error !== 'already_syncing' && res.error !== 'recent_upload_guard' && res.error !== 'pending_upload_failed') {
                      console.warn('[AutoSync] 自动下载未成功:', res.error);
                    }
                  })
                  .catch(err => console.warn('[AutoSync] 自动下载异常:', err));
```

SyncButton.tsx:292/341 与 HeaderDropdown.tsx:68 的 `syncEngine.downloadAndMerge({...})` 同样替换为 `sendSyncCommand('download', { forceRemote, syncSettings })`，将原 result 判断改为 `res.ok`（SYNC case 返回的即 downloadAndMerge 的 MergeResult + ok 包装；判断字段 `success`/`reason` 用法不变：`(res.payload as any)?.success`）。若 SyncButton 依赖进度回调 `onProgress`，保留本地模拟进度（进度条照旧走原逻辑，仅真实结果经消息回传）。

- [ ] **Step 2: backgroundSync 入队**

backgroundSync.ts `performBackgroundSync` 的步骤 3/4 中 `syncEngine.upload({forcePending:true})` 与 `syncEngine.downloadAndMerge()` 包入队列：

```ts
  const upResult = await enqueue('sync:upload', () => syncEngine.upload({ forcePending: true }));
  // ...
  const result = await enqueue('sync:download', () => syncEngine.downloadAndMerge());
```

顶部 `import { enqueue } from './mutationQueue';`。alarm 驱动的 `runScheduledUpload`（syncEngine）同样入队：syncEngine.ts `runScheduledUpload` 改为 `await enqueue('sync:upload', () => this.upload())`（syncEngine 顶部 import enqueue；若形成 mutationQueue→syncEngine 循环依赖，则 runScheduledUpload 保持直调、由 backgroundSync 的 alarm 处理器入队——以实际依赖方向为准，二选一并在注释说明）。

- [ ] **Step 3: 验证单点化**

Run: `grep -rn "from '@/services/syncEngine'" src/components/ src/store/ | grep -v node_modules`
Expected: 无输出

Run: `pnpm type-check && pnpm test`
Expected: 通过

- [ ] **Step 4: 提交**

```bash
git add src/components/ src/background/backgroundSync.ts src/services/syncEngine.ts
git commit -m "refactor(sync): 同步操作收敛 SW 队列，popup 全面走消息（阶段一·根因R1/R2）"
```

---

### Task 11: onChanged 对账 —— popup 订阅 storage 变化

**Files:**
- Modify: `src/utils/storage.ts`（文件末尾追加）
- Modify: `src/components/tabs/TabList.tsx:28-57`
- Test: `pnpm type-check`；订阅行为冒烟（Task 12）。

**Interfaces:**
- Produces: `onGroupsChanged(cb: () => void): () => void`（过滤 GROUPS key + 自动失效缓存；返回退订函数）。

- [ ] **Step 1: storage.ts 追加**

```ts
/**
 * 订阅 groups 变化（规格 §3.1 步骤3）：跨进程可靠对账，替代 REFRESH_TAB_LIST 手动广播。
 * SW 侧任何写入都会触发；回调前自动失效本进程 groups 缓存。
 */
export function onGroupsChanged(cb: () => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local' || !changes[STORAGE_KEYS.GROUPS]) return;
    invalidateGroupsCache();
    cb();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
```

- [ ] **Step 2: TabList 订阅**

TabList.tsx useEffect（28-57）内在 REFRESH 监听之后追加（150ms 防抖合并突发写入）：

```tsx
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = onGroupsChanged(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        dispatch(loadGroups());
        dispatch(loadDeletedGroups());
      }, 150);
    });
    // cleanup 区一并执行：
    // if (debounceTimer) clearTimeout(debounceTimer);
    // unsubscribe();
```

（REFRESH_TAB_LIST 监听**保留**——过渡期双通道无害，阶段三清理。）

- [ ] **Step 3: 验证 + 提交**

Run: `pnpm type-check && pnpm test`

```bash
git add src/utils/storage.ts src/components/tabs/TabList.tsx
git commit -m "feat(sync): popup 经 storage.onChanged 对账（阶段一·规格§3.1）"
```

---

### Task 12: 全量验证 + 手动冒烟

**Files:** 无新增；全库回归。

- [ ] **Step 1: 自动化全绿**

Run: `pnpm test && pnpm type-check && pnpm lint && pnpm build`
Expected: 全部通过

- [ ] **Step 2: 手动冒烟（加载 dist/ 到 Chrome，双窗口 + 登录态）**

1. 打开 popup → 点"保存当前窗口"→ popup 关闭、标签收起；**立即重开 popup：新会话必须出现在列表首位**（核心验收：修复前此场景可能空白）。
2. 列表中点开某会话的一个标签 → 重开 popup：该标签消失、其余保留；DevTools 看 SW console 有 `[mutationHandlers]`/`[SyncEngine]` 上传日志。
3. 删除某会话 → 重开 popup 不复活；回收站视图能看到并恢复。
4. 拖拽会话排序 → 重开 popup 顺序保持。
5. 设置页手动"立即同步"→ SW console 无报错、云端行数符合预期。
6. 打开第二个窗口重复 1-3（popup 与 SW 高频交错场景）。
7. 会话内拖动标签跨组 → 源组清空时自动进回收站（拖拽自动清理回归）。

- [ ] **Step 3: 收尾提交**

```bash
git add -A && git commit -m "chore(sync): 阶段一（单写者）完成，全量验证通过" --allow-empty
```

---

## 自审记录（写计划后核对）

1. **规格覆盖**：§3.1（写收敛/发命令/订阅对账）→ Task 2/7/8/10/11；§3.2（语义命令清单）→ Task 3-6/8；§3.3（队列）→ Task 1/7/10；§3.4（签名不变）→ Task 8 约束；R6 → Task 9。§4 以后全部属阶段二，本计划不涉及（符合规格 §9 发布顺序）。
2. **占位符扫描**：无 TBD/TODO；Task 6/10 各有一处"二选一"（mutationService 是否拆文件、runScheduledUpload 是否入队），均已给出判定条件与两个分支的完整做法，非占位。
3. **类型一致性**：`MutationResult`/`MutationOp`/`sendMutation`/`sendSyncCommand`/`enqueue`/`createMutationHandlers(deps)`/`apply*` 在定义任务与使用任务的签名一致；payload 字段与现 tabSlice extraReducers 期望一一对应（Task 8 表格核对过每个 thunk）。
