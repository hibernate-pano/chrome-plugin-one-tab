# 清理旧会话 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 菜单里加一个「清理旧会话」子菜单（一个月/三个月/六个月/一年/全部两档），按保存时间批量删除旧会话，锁定会话默认保留，确认框列出将删的名字。

**Architecture:** 判据层是纯函数（`src/core/cleanupPlan.ts`）：一次磁盘读 → 六个档位各自算出「要删哪些 id、多少标签页、多少未知时间、多少被锁定跳过」。执行层新增一条语义命令 `deleteGroups(groupIds)`，载荷是**具体 id 列表**。UI 只负责把档位渲染成子菜单行、把算出来的计划渲染成确认框。

**Tech Stack:** React 19 + TypeScript + Redux Toolkit + node:test（`node --test --import ./tests/_register-loader.mjs --experimental-strip-types`）。

**Spec:** `docs/superpowers/specs/2026-10-26-cleanup-old-sessions-design.md`

## Global Constraints

- **不引入「删除全部」这个第二叫法**：统一叫「删除所有会话」（`deleteAllActionNaming` 守卫在防这件事）。
- **`src/core/feedbackPolicy.ts` 一行都不许改**（「安静的成功」的判据层，已冻结）。
- **`deleteAllGroups` 那条既有路径（含覆盖上传）一个字节都不许改**。
- **不许用 `stripComments` + `parseTsx` 解析 `src/background/TabManager.ts`**（会把模板串里的 `//` 当注释，整棵 AST 报废）。
- 破坏性路径上的每次磁盘读都必须 **fail closed**：读不到就中止，绝不退回 Redux 快照继续删。
- 所有用户可见文案用中文，且必须与真实行为一致（本仓最重的一条纪律）。
- 提交信息用中文，动词前缀照现有惯例（`feat(ui):` / `feat(core):` / `fix(test):`）。

## Review Focus

- **空档位**：某档算出来 0 条时，点下去会弹「清理 0 个会话」吗？必须不弹，直接说明无事可做。
- **全锁定**：所有会话都锁定时，「保留锁定」档与四个时间档都应是 0 ⇒ 只留「含锁定」那一行。
- **月末截断**：3 月 31 日的「一个月前」必须落在 2 月 28/29 日，不能溢出成 3 月 3 日（会让截止点变晚、多删）。
- **未知时间**：OneTab 导入件的 `importedAt` 参与年龄计算；确认框必须说清「按导入时间算」。
- **并发锁定**：确认后、执行前另一台设备把某条锁上 ⇒ 必须跳过，且回执不许说「其余已被移除」。

---

### Task 1: 判据层 `cleanupPlan.ts`

**Files:**
- Create: `src/core/cleanupPlan.ts`
- Test: `tests/cleanupPlan.test.ts`

**Interfaces:**
- Consumes: `hasUnknownSaveTime`（`@/core/sessionSaveTime`）、`TabGroup`（`@/types/tab`）
- Produces:
  - `type CleanupTier = '1m' | '3m' | '6m' | '12m' | 'all-keep-locked' | 'all'`
  - `monthsBefore(now: Date, months: number): Date`
  - `interface CleanupPlan { tier: CleanupTier; ids: string[]; groupCount: number; tabCount: number; unknownTimeCount: number; lockedSkippedCount: number; names: string[] }`
  - `planCleanup(groups: TabGroup[], tier: CleanupTier, now: Date): CleanupPlan`
  - `CLEANUP_TIER_LABELS: Record<CleanupTier, (n: number) => string>`（菜单行文字）

- [ ] **Step 1: 写失败的测试**

```ts
// tests/cleanupPlan.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { monthsBefore, planCleanup } from '@/core/cleanupPlan';

const g = (over: Record<string, unknown>) => ({
  id: 'x', name: '会话', tabs: [], createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z', isLocked: false, ...over,
}) as any;

describe('monthsBefore：日历月钳制', () => {
  it('3 月 31 日的一个月前是 2 月 28 日（不是 3 月 3 日）', () => {
    assert.equal(
      monthsBefore(new Date('2026-03-31T12:00:00'), 1).toISOString().slice(0, 10),
      '2026-02-28',
    );
  });
  it('闰年 3 月 31 日的一个月前是 2 月 29 日', () => {
    assert.equal(
      monthsBefore(new Date('2024-03-31T12:00:00'), 1).toISOString().slice(0, 10),
      '2024-02-29',
    );
  });
  it('跨年：1 月 15 日的三个月前是上一年的 10 月 15 日', () => {
    assert.equal(
      monthsBefore(new Date('2026-01-15T12:00:00'), 3).toISOString().slice(0, 10),
      '2025-10-15',
    );
  });
});

describe('planCleanup：时间档', () => {
  const now = new Date('2026-10-26T00:00:00.000Z');
  it('按 createdAt 选旧的，新的不选', () => {
    const plan = planCleanup([
      g({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
      g({ id: 'new', createdAt: '2026-10-01T00:00:00.000Z' }),
    ], '3m', now);
    assert.deepEqual(plan.ids, ['old']);
  });
  it('保存时间未知的按 importedAt 计入', () => {
    const plan = planCleanup([
      g({ id: 'imp', createdAt: '2026-10-20T00:00:00.000Z', importedAt: '2025-01-01T00:00:00.000Z' }),
    ], '3m', now);
    assert.deepEqual(plan.ids, ['imp']);
    assert.equal(plan.unknownTimeCount, 1);
  });
  it('导入得晚、createdAt 旧的未知时间件不算（不能只看 createdAt）', () => {
    const plan = planCleanup([
      g({ id: 'imp2', createdAt: '2020-01-01T00:00:00.000Z', importedAt: '2026-10-25T00:00:00.000Z' }),
    ], '3m', now);
    assert.deepEqual(plan.ids, []);
  });
  it('锁定的跳过并计数，不进 ids', () => {
    const plan = planCleanup([
      g({ id: 'lock', createdAt: '2026-01-01T00:00:00.000Z', isLocked: true }),
      g({ id: 'free', createdAt: '2026-01-01T00:00:00.000Z' }),
    ], '3m', now);
    assert.deepEqual(plan.ids, ['free']);
    assert.equal(plan.lockedSkippedCount, 1);
  });
  it('tabCount 是标签页总数，names 按最新在前', () => {
    const plan = planCleanup([
      g({ id: 'a', name: 'A', createdAt: '2026-01-01T00:00:00.000Z', tabs: [{}, {}] }),
      g({ id: 'b', name: 'B', createdAt: '2026-03-01T00:00:00.000Z', tabs: [{}] }),
    ], '3m', now);
    assert.equal(plan.tabCount, 3);
    assert.deepEqual(plan.names, ['B', 'A']);
  });
});

describe('planCleanup：全部两档', () => {
  const now = new Date('2026-10-26T00:00:00.000Z');
  const groups = [
    g({ id: 'lock', createdAt: '2026-10-01T00:00:00.000Z', isLocked: true }),
    g({ id: 'free', createdAt: '2026-10-01T00:00:00.000Z' }),
  ];
  it('保留锁定：只选未锁定', () => {
    assert.deepEqual(planCleanup(groups, 'all-keep-locked', now).ids, ['free']);
  });
  it('含锁定：全选', () => {
    assert.deepEqual(planCleanup(groups, 'all', now).ids, ['lock', 'free']);
  });
  it('全部两档不看时间', () => {
    const fresh = [g({ id: 'today', createdAt: '2026-10-25T00:00:00.000Z' })];
    assert.deepEqual(planCleanup(fresh, 'all-keep-locked', now).ids, ['today']);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test --import ./tests/_register-loader.mjs --experimental-strip-types tests/cleanupPlan.test.ts`
Expected: FAIL（`Cannot find module '@/core/cleanupPlan'`）

- [ ] **Step 3: 实现 `src/core/cleanupPlan.ts`**

要点（文件头必须写清这几条判据，本仓惯例）：
- `monthsBefore` 用 setMonth 后**把日钳到目标月的最大日**（`Math.min(day, daysInMonth)`），
  并在文件头写清「为什么不能让它溢出成 3 月 3 日」。
- 年龄判据：`const ref = hasUnknownSaveTime(g) ? g.importedAt : g.createdAt`，
  `Date.parse(ref) < cutoff.getTime()`。
- `'all'` 与 `'all-keep-locked'` 不看时间、不看 `unknownTimeCount`（保持 0）。
- 锁定的处理：时间档与 `all-keep-locked` 都跳过并计入 `lockedSkippedCount`；
  `'all'` 不跳过、`lockedSkippedCount` 恒 0。
- `names` 按参考时间**倒序**（最新的在前），只取前若干条由调用方截断。
- `CLEANUP_TIER_LABELS` 给四个时间档中文标签（`一个月前` 等）与两档全部
  （`删除所有会话（保留 N 个锁定）` / `删除所有会话（含 N 个锁定）`）。

- [ ] **Step 4: 跑测试，确认通过**

Run: 同 Step 2。Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/cleanupPlan.ts tests/cleanupPlan.test.ts
git commit -m "feat(core): 清理旧会话的判据层（日历月钳制 + 六档计划）"
```

---

### Task 2: 语义命令 `deleteGroups`

**Files:**
- Modify: `src/core/mutationProtocol.ts`（`MutationOp` 加一条）
- Modify: `src/core/mutationOps.ts`（新增 `applyDeleteGroups`）
- Modify: `src/background/mutationHandlers.ts`（新增 case）
- Modify: `src/store/slices/tabSlice.ts`（新增 thunk）
- Test: `tests/cleanupDeleteGroups.test.ts`

**Interfaces:**
- Consumes: `noteDeletedGroups`（`mutationHandlers.ts:104`，已收数组）
- Produces:
  - `{ op: 'deleteGroups'; groupIds: string[] }`
  - `applyDeleteGroups(groups, groupIds, now, stamp): { groups: TabGroup[]; removedGroupIds: string[]; skippedLocked: string[] }`
  - `deleteGroupsThunk(groupIds: string[])` → 回执 `{ count: number; skippedLocked: number }`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/cleanupDeleteGroups.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyDeleteGroups } from '@/core/mutationOps';

const g = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: id, tabs: [], createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z', isLocked: false, ...over,
}) as any;

describe('applyDeleteGroups', () => {
  const stamp = { s: 1, c: 'test' } as any;
  it('只删列表里还在的，别的原样留着', () => {
    const r = applyDeleteGroups([g('a'), g('b'), g('c')], ['a', 'zzz'], 'now', stamp);
    assert.deepEqual(r.groups.map(x => x.id), ['b', 'c']);
    assert.deepEqual(r.removedGroupIds, ['a']);
  });
  it('此刻已锁定的跳过并单列，不进 removedGroupIds', () => {
    const r = applyDeleteGroups([g('a'), g('b', { isLocked: true })], ['a', 'b'], 'now', stamp);
    assert.deepEqual(r.removedGroupIds, ['a']);
    assert.deepEqual(r.skippedLocked, ['b']);
    assert.deepEqual(r.groups.map(x => x.id), ['b']);
  });
  it('空列表原样返回', () => {
    const r = applyDeleteGroups([g('a')], [], 'now', stamp);
    assert.deepEqual(r.groups.map(x => x.id), ['a']);
    assert.deepEqual(r.removedGroupIds, []);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test --import ./tests/_register-loader.mjs --experimental-strip-types tests/cleanupDeleteGroups.test.ts`
Expected: FAIL（`applyDeleteGroups is not a function`）

- [ ] **Step 3: 实现**

- `mutationProtocol.ts`：在 `MutationOp` 里加
  `| { op: 'deleteGroups'; groupIds: string[] }`，附注释说明「载荷是具体 id，
  不是规则——确认框里列的名字就是承诺」。
- `mutationOps.ts`：`applyDeleteGroups` 按 Step 1 的语义实现。
- `mutationHandlers.ts`：照 `case 'deleteGroup'` 的形状加分支——
  一次 `d.getGroups()` → `applyDeleteGroups` → `persist` →
  `noteDeletedGroups(d, r.removedGroupIds)` → `scheduleUpload(DELETE_PRIORITY_MS)`
  → `return { ok: true, payload: { count: r.removedGroupIds.length, skippedLocked: r.skippedLocked.length }, broadcastWarn: delWarn ?? undefined }`。
  **不许**调 `sendSyncCommand('upload', { overwriteCloud: true })`（部分删除不能覆盖上传）。
- `tabSlice.ts`：新增 `deleteGroupsThunk`，照 `deleteAllGroups` 的 shape
  （乐观移除由 fulfilled reducer 承担，`rejected` 要有回滚——照抄 `deleteTabAndSync`
  的 `deletedGroupBackups` 写法）。

- [ ] **Step 4: 跑测试，确认通过**

Run: 同 Step 2。Expected: PASS

- [ ] **Step 5: 类型检查**

Run: `pnpm type-check && pnpm type-check:tests`
Expected: 无输出

- [ ] **Step 6: 提交**

```bash
git add src/core/mutationProtocol.ts src/core/mutationOps.ts src/background/mutationHandlers.ts src/store/slices/tabSlice.ts tests/cleanupDeleteGroups.test.ts
git commit -m "feat(sync): 新增 deleteGroups 语义命令（按 id 批量删、跳过锁定）"
```

---

### Task 3: 菜单子菜单

**Files:**
- Modify: `src/components/layout/HeaderDropdown.tsx`
- Test: `tests/guards/cleanupMenu.test.ts`

**Interfaces:**
- Consumes: `planCleanup` / `CLEANUP_TIER_LABELS`（Task 1）、`deleteGroupsThunk`（Task 2）
- Produces: 菜单行 `清理旧会话`；`openSubmenu` 的类型扩成 `'export' | 'import' | 'cleanup' | null`

- [ ] **Step 1: 写失败的测试（钉结构与行为，不钉字面长相）**

```ts
// tests/guards/cleanupMenu.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = readFileSync(resolve(ROOT, 'src/components/layout/HeaderDropdown.tsx'), 'utf8');
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('清理旧会话菜单', () => {
  it('存在 cleanup 子菜单，且用同一套 disclosure 机制', () => {
    assert.ok(code.includes("'cleanup'"), 'openSubmenu 必须支持 cleanup');
    assert.ok(code.includes('aria-expanded={openSubmenu ==='), '父行必须有 aria-expanded');
  });
  it('六档都渲染，且条数为 0 的档不显示（比较表达式在）', () => {
    for (const tier of ['1m', '3m', '6m', '12m']) {
      assert.ok(code.includes(`'${tier}'`), `缺档位 ${tier}`);
    }
    assert.ok(code.includes('all-keep-locked') && code.includes("'all'"), '缺全部两档');
    assert.match(code, /filter\([^)]*groupCount > 0|groupCount > 0/, '必须过滤掉 0 条的档');
  });
  it('确认前读磁盘真值，且读失败中止（fail closed）', () => {
    assert.ok(code.includes('getGroupsForWrite'), '必须读磁盘真值');
    assert.match(code, /catch[\s\S]{0,200}(return|showToast)/, '读失败必须中止');
  });
  it('0 条时不弹确认框', () => {
    assert.match(code, /ids\.length === 0|groupCount === 0/, '必须有不弹确认框的短路');
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test --import ./tests/_register-loader.mjs --experimental-strip-types tests/guards/cleanupMenu.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

- 危险区那块整体换成：父行「清理旧会话」+ 子菜单面板（沿用 `ref={submenuRef}` /
  `aria-expanded` / `scrollIntoView` 的既有模式）。
- 菜单挂载时**一次** `storage.getGroupsForWrite()`，用 `planCleanup` 算出六档，
  过滤掉 `groupCount === 0`，渲染成行。
- 每行点击 → 读一次磁盘（fail closed）→ 重算该档 → 0 条就 `showToast('没有可清理的会话', 'info')`
  并 return → 否则 `showConfirm`（文案见 Task 4）→ 确认后
  `dispatch(deleteGroupsThunk(plan.ids))`（「含锁定」档走
  `deleteAllGroups` 的既有路径，包括覆盖上传，一个字都别改）。
- **删除父行原来那个「删除所有会话（N）」按钮**，但保留它在「含锁定」档里的
  `deleteAllMenuWarning` 小字。

- [ ] **Step 4: 跑测试，确认通过**

Run: 同 Step 2。Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/layout/HeaderDropdown.tsx tests/guards/cleanupMenu.test.ts
git commit -m "feat(ui): 菜单加「清理旧会话」子菜单（六档 + 条数）"
```

---

### Task 4: 确认框文案与回执

**Files:**
- Modify: `src/components/layout/deleteAllMessages.ts`（新增 `cleanupConfirmTitle` / `cleanupConfirmMessage` / `cleanupSuccessMessage` / `deleteAllKeepLockedMenuWarning`）
- Modify: `src/components/layout/HeaderDropdown.tsx`（接线）
- Test: `tests/cleanupMessages.test.ts`

**Interfaces:**
- Produces（全部纯函数，文案可单测）：
  - `cleanupConfirmTitle(plan): string`
  - `cleanupConfirmMessage(plan, disclosure): string`
  - `cleanupSuccessMessage({ deletedCount, confirmedCount, skippedLocked }): string`
  - `deleteAllKeepLockedMenuWarning(disclosure): string`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/cleanupMessages.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanupConfirmTitle, cleanupConfirmMessage, cleanupSuccessMessage,
} from '@/components/layout/deleteAllMessages';

const plan = (over: Record<string, unknown> = {}) => ({
  tier: '3m' as const, ids: ['a', 'b'], groupCount: 2, tabCount: 17,
  unknownTimeCount: 0, lockedSkippedCount: 0, names: ['A', 'B'], ...over,
});
const disc = { isAuthenticated: false, syncBackend: 'webdav' as const };

describe('确认框', () => {
  it('标题带数量', () => {
    assert.equal(cleanupConfirmTitle(plan()), '清理 2 个会话');
  });
  it('正文报数量、标签页数、名字', () => {
    const m = cleanupConfirmMessage(plan(), disc);
    assert.match(m, /2 个会话/);
    assert.match(m, /17 个标签页/);
    assert.match(m, /「A」/);
  });
  it('名字超过 6 个只说等 N 个', () => {
    const m = cleanupConfirmMessage(
      plan({ names: ['A','B','C','D','E','F','G','H'], groupCount: 8, ids: [] }), disc);
    assert.match(m, /等 8 个/);
    assert.ok(!m.includes('「G」'), '第 7 个及以后不放正文');
  });
  it('有未知时间时说明按导入时间算', () => {
    const m = cleanupConfirmMessage(plan({ unknownTimeCount: 1 }), disc);
    assert.match(m, /保存时间未知/);
    assert.match(m, /按导入时间/);
  });
  it('没有未知时间就不说这句', () => {
    assert.ok(!cleanupConfirmMessage(plan(), disc).includes('保存时间未知'));
  });
  it('有锁定跳过时说明不会被清理', () => {
    const m = cleanupConfirmMessage(plan({ lockedSkippedCount: 2 }), disc);
    assert.match(m, /2 个已锁定的会话不会被清理/);
  });
  it('永远声明不可撤销', () => {
    assert.match(cleanupConfirmMessage(plan(), disc), /没有回收站|无法撤销/);
  });
  it('有同步后端时声明跨设备删除', () => {
    assert.match(cleanupConfirmMessage(plan(), { isAuthenticated: true, syncBackend: 'supabase' }),
      /同步删除/);
  });
});

describe('回执', () => {
  it('数量一致 ⇒ 空串（界面自明，不出声）', () => {
    assert.equal(cleanupSuccessMessage({ deletedCount: 2, confirmedCount: 2, skippedLocked: 0 }), '');
  });
  it('被锁定跳过 ⇒ 说出真实原因，不许说「其余已被移除」', () => {
    const m = cleanupSuccessMessage({ deletedCount: 1, confirmedCount: 3, skippedLocked: 2 });
    assert.match(m, /2 个.*被锁定.*已跳过/);
    assert.ok(!m.includes('已被移除'), '对锁定情形说「已被移除」是假话');
  });
  it('少删但不是锁定 ⇒ 沿用既有说法', () => {
    assert.match(cleanupSuccessMessage({ deletedCount: 1, confirmedCount: 3, skippedLocked: 0 }),
      /已被移除/);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test --import ./tests/_register-loader.mjs --experimental-strip-types tests/cleanupMessages.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现纯函数**

- 日期用 `@/utils/sessionPresentation` 的既有格式化函数，不新写。
- 跨设备那句复用 `crossDeviceDeleteCaveat` / `otherDevicesLabel` / `deleteReachesOtherDevices`。
- `cleanupSuccessMessage` 的四种情形要写进文件头注释（本仓惯例：同源判据要有说明）。
- 「含锁定」档**不**调用这三个新函数，继续走 `deleteAllConfirmTitle` / `deleteAllConfirmMessage` /
  `deleteAllSuccessMessage`。

- [ ] **Step 4: 接线到 HeaderDropdown**

- 时间档与「保留锁定」档用 `cleanupConfirmTitle` / `cleanupConfirmMessage`。
- 回执：`cleanupSuccessMessage(...)` 返回空串就**不弹**（延续「安静的成功」）。
- 失败路径照现有 `showToast(..., 'error')`。

- [ ] **Step 5: 跑测试，确认通过**

Run: `node --test --import ./tests/_register-loader.mjs --experimental-strip-types tests/cleanupMessages.test.ts tests/guards/cleanupMenu.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/components/layout/deleteAllMessages.ts src/components/layout/HeaderDropdown.tsx tests/cleanupMessages.test.ts
git commit -m "feat(ui): 清理旧会话的确认文案与回执（锁定跳过要说出真因）"
```

---

### Task 5: 连带修改（文案与守卫同批）

**Files:**
- Modify: `tests/guards/deleteAllActionNaming.test.ts`
- Modify: `src/components/onboarding/OnboardingSteps.tsx` 里的 `LOCK_DELETE_BOUNDARY`
- Modify: `tests/guards/onboardingDeleteBoundaryHonesty.test.ts`
- Modify: `README.md:43`
- Modify: `CHROMEWEBSTORE.md:192/195`
- Modify: `tests/guards/dropdownSubmenuReachable.test.ts`

- [ ] **Step 1: 先跑一遍，看哪几条真的红了**

Run:
```bash
node --test --import ./tests/_register-loader.mjs --experimental-strip-types \
  tests/guards/deleteAllActionNaming.test.ts tests/guards/onboardingDeleteBoundaryHonesty.test.ts \
  tests/guards/dropdownSubmenuReachable.test.ts tests/guards/deleteAllDisclosure.test.ts \
  tests/lockedDelete.test.ts
```
Expected: 至少 naming 与 submenu 两条红（子菜单从 2 个变 3 个）。

- [ ] **Step 2: 改 `deleteAllActionNaming.test.ts` 的取法**

把「从菜单行正则读 `删除…会话（{N}）`」改成从**子菜单里那一行**读。
**不许**改成钉字面量（守卫存在的意义就是叫法从界面现场读）。
若叫法确实要变，必须同批改 README / 隐私政策 / 引导 / 商店页。

- [ ] **Step 3: 改 `LOCK_DELETE_BOUNDARY` 与它的守卫**

新文案必须同时说清两条路径行为相反，例如：
「『删除所有会话』里选『保留锁定』会留下它们，选『含锁定』会连它们一起删」
——具体措辞由实现者定，但守卫要继续断言**两件事都说到了**。

- [ ] **Step 4: 同步 README:43 与 CHROMEWEBSTORE:192/195**

商店页那句「『删除所有会话』始终确认并显示数量，其中锁定会话的数量也会一并写明」
现在只对「含锁定」档成立 ⇒ 必须改写。**中英两版都要改**（`docsAlignment` 会校验）。

- [ ] **Step 5: `dropdownSubmenuReachable.test.ts` 的 2 → 3**

`ref={submenuRef}` 与 `aria-expanded={openSubmenu ===` 的数量都从 2 改成 3。
把断言里的数字换成「每个父行一个」的语义表述，别再钉裸数字。

- [ ] **Step 6: 跑文案与守卫**

```bash
node --test --import ./tests/_register-loader.mjs --experimental-strip-types \
  tests/guards/deleteAllActionNaming.test.ts tests/guards/deleteAllActionNamingMutation.test.ts \
  tests/guards/onboardingDeleteBoundaryHonesty.test.ts tests/guards/dropdownSubmenuReachable.test.ts \
  tests/guards/deleteAllDisclosure.test.ts tests/lockedDelete.test.ts tests/docsAlignment.test.ts
```
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "docs: 清理功能上线后，锁定披露与删除叫法在三处文案同批对齐"
```

---

### Task 6: 变异自证 + 全量验收

**Files:**
- Create: `tests/guards/cleanupMutation.test.ts`（用 `runMutationCases`）

- [ ] **Step 1: 写 4 条变异**

| # | 变异点 | 应该打红哪条守卫 |
|---|---|---|
| ① | `planCleanup` 时间档不再跳过锁定 | `cleanupPlan.test.ts` 的「锁定的跳过并计数」 |
| ② | `applyDeleteGroups` 不再跳过已锁定的 | `cleanupDeleteGroups.test.ts` 的「此刻已锁定的跳过」 |
| ③ | `monthsBefore` 去掉日钳制（溢出的那个 bug 回来） | `cleanupPlan.test.ts` 的「3 月 31 日」 |
| ④ | `cleanupSuccessMessage` 在 `skippedLocked > 0` 时改说「已被移除」 | `cleanupMessages.test.ts` 的「不许说其余已被移除」 |

`expectedFailure` 必须填 `assert.*` 第三个参数的**原文**（不是 `it` 标题）——
TAP 会打印通过的子测试标题，拿标题当 needle 恒真。

- [ ] **Step 2: 跑变异，确认全都打红**

Run: `node --test --import ./tests/_register-loader.mjs --experimental-strip-types tests/guards/cleanupMutation.test.ts`
Expected: PASS（每条都红在预期的那句话上）

- [ ] **Step 3: 全量套件（后台跑，只跑一次）**

```bash
pnpm test > /tmp/cleanup-full-suite.log 2>&1
```
判据：`# fail 0`（已知的联网用例在无网环境会 skip，那是正常的）。

- [ ] **Step 4: 类型 + lint + 构建**

```bash
pnpm type-check && pnpm type-check:tests && pnpm lint && pnpm lint:tests && pnpm build
```

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "test(cleanup): 四条变异自证 + 全量验收"
```

---

## 自查

**规格覆盖** —— §1 意图 → Task 3；§2 非目标（撤销/自动清理/标签级时间戳都不做）→ 全篇无相关任务 ✓；
§3 判据核心 → Task 1 Step 3；§4.1 菜单 → Task 3；§4.2 确认框 → Task 4；§5.1 `deleteGroups` → Task 2；
§5.2 全部两档 → Task 3 Step 3（含锁定走既有路径）；§6 回执 → Task 4；
§7 连带修改 → Task 5；§7.5 R1–R4 → Task 4 / Task 1 / Task 2；§8 → Task 1 Step 3（钳制）与 Task 3（真机高度）。

**Review Focus 覆盖** —— 空档位 → Task 3 Step 3 + Step 1 的「0 条不弹框」；
全锁定 → Task 1「lockedSkippedCount」+ Task 3 过滤 0 条；月末截断 → Task 1 Step 1 三条用例；
未知时间 → Task 1 两条用例 + Task 4 文案；并发锁定 → Task 2 + Task 4 回执 + Task 6 变异②④。

**类型一致性** —— `CleanupPlan` 在 Task 1 定义、Task 3/4 使用；`deleteGroupsThunk` 在 Task 2 定义、
Task 3 使用；`cleanupSuccessMessage` 的 `{deletedCount, confirmedCount, skippedLocked}` 三字段
在 Task 2 回执与 Task 4 文案之间一致。

**比例** —— 规格 250 行、计划 480 行；计划里只有签名、测试名、断言与命令，没有函数体全文。
