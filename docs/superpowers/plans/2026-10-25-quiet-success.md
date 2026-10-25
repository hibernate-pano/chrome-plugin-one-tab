# 安静的成功（TapStack 提示体系收口）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「成功是状态、失败是事件」成为可编译、有守卫的产品事实 —— 删掉 toast 的 `success` 类型，逐条裁决 19 处成功播报，把界面表达不了的事实降级为中性提示。

**Architecture:** 新增纯函数判据层 `src/core/feedbackPolicy.ts`（`decideFeedback`），把「这件事该不该出声」从组件里抽出来；toast 类型层删掉 `'success'`，让 `showToast(x, 'success')` 变成编译错误；每个出声点都经判据层裁决，判据结果与「界面状态载体」互为验证。

**Tech Stack:** Chrome MV3 扩展、React 19 + TypeScript + Redux Toolkit、Node 内置 `node:test`（无 DOM 测试环境）、pnpm。

**Spec:** `docs/superpowers/specs/2026-10-25-quiet-success-design.md` —— 实施前必读，判据与逐条裁决都在里面。

---

## Global Constraints

- **只在独立 worktree 里干活。** 当前主工作树有别人在飞的 v1.28.6 改动（`src/components/common/Toast.tsx`、`src/contexts/ToastContext.tsx`、`src/components/tabs/TabGroup.tsx`、`src/types/tab.ts`、`README.md`、`CHROMEWEBSTORE.md` 等 36 个文件未提交）。执行第一步：
  ```bash
  git worktree add /private/tmp/tapstack-quiet -b feat/quiet-success HEAD
  cd /private/tmp/tapstack-quiet
  pnpm install --prefer-offline   # 新建的 worktree 没有 node_modules ⇒ 不装就什么都跑不了
  ```
  绝对不要 `git add`/`git commit` 主工作树里的任何东西。
- **行号不是承重信息，锚点才是。** 本计划里的行号以 worktree HEAD（`e9f9594`）为准（例：锁定的 toast 在 HEAD 是 `TabGroup.tsx:447`）。所有定位一律用「函数名 + 周边唯一字符串」，**不许死钉行号**。
- **每个提交必须在自己的 worktree 里单独跑绿。** 并行 agent 共用工作树会把别人的半成品一起提交。
- **全量套件 20–30 分钟**，必须后台跑；**别把 `runMutationCases` 放进守卫文件**（每个变异沙箱各拷一份仓）。
- **命名空间纪律：** `'success'` 字面量在 8 个互不相干的命名空间里同时存在。本次**只动 toast 那一层**（`ToastType` / `ToastKind` / `ToastContext` 的默认值 / `useConsumeUndo.opts.type` / `LoginRestoreTone` / `toastHelper` 的 `type`）。**不动**：浏览器通知 `kind`（`src/background/TabManager.ts:801`）、就地反馈 `kind`（`Header.tsx:370,404,615,623,632`、`SearchResultList.tsx:177`、`TabList.tsx:136`）、`InlineNoticeTone`（`src/components/common/InlineNotice.tsx`）、`AlertDialog` 的 `type`（`src/components/common/AlertDialog.tsx:9`）、`TabGroup.syncStatus`（`src/types/tab.ts:293`）。
- **不许 blanket grep `'success'` 写守卫** —— 上面那 5 个命名空间是合法的。
- **四条同时成立的不变量，任何任务都不许破坏：**
  1. `error` 型 toast 默认**常驻**（`resolveToastDuration` 的既有行为）。
  2. `error` 型与带动作的 toast **不会被后来的提示静默挤掉**（`toastQueuePolicy.isEvictable`）。
  3. 「失败提示不受开关影响，始终会通知」写在 `src/legal/privacy.html:71`、`src/options/OptionsPage.tsx:1101`、`CHROMEWEBSTORE.md:261` 三处 —— **本次不动这三处**。
  4. 撤销退路：8 秒窗口、键盘焦点接管、`autoFocus: true`（`src/components/tabs/useConsumeUndo.ts:90`）。
- **本轮范围外**（产品负责人 2026-10-25 决定）：22 个 `showAlert` 错误模态；`chrome.notifications`；任何数据语义、同步逻辑、存储格式。

### 常用命令

```bash
# 单个测试文件
node --test --import ./tests/_register-loader.mjs --experimental-strip-types tests/guards/quietSuccess.test.ts

# 全量（20–30 分钟，后台跑）
pnpm test

# 类型 + lint + 构建
pnpm type-check && pnpm type-check:tests && pnpm lint && pnpm lint:tests && pnpm build
```

---

## Review Focus

这五类输入/情形，规格只暗示、没有任何任务的测试覆盖 —— 每一条都要落成某个任务里的一个测试。

1. **不可逆操作丢了退路** —— 恢复即消费（无回收站）时撤销按钮必须在、必须点得着。→ Task 3。
2. **界面变化被误当成「什么也没发生」** —— 点开一个标签：页面开了、记录没了，用户分不清「已打开」与「被删了」；锁定的会话点开则**不该**有任何提示（记录还在、页面开了，两件事都看得见）。→ Task 3。
3. **实际条数与承诺条数对不上** —— 删全部时用户确认了 8 个、实际只删了 3 个（另 5 个被别处移除）必须说出来；清理重复标签清掉几个也要说。→ Task 2。
4. **导入/导出后用户核不上数量** —— 导入 12 个、其中 2 个读不出来；导出 7 个会话。→ Task 2。
5. **失败被静默** —— SW 拒开（`success !== true`）、3 秒冷却期、批量恢复里打不开的那几条，都必须出声。→ Task 3（成功门不得随播报一起删）。

---

## 文件结构

**新增**

| 文件 | 职责 |
|---|---|
| `src/core/feedbackPolicy.ts` | 判据层：「这件事该不该出声」的纯函数。**不含任何文案**。 |
| `tests/feedbackPolicy.test.ts` | 判据层的单测（纯函数，不需要 DOM）。 |
| `tests/guards/quietSuccess.test.ts` | 守卫：钉住 19 处裁决的结果 + 撤销退路 + 成功门 + 失败不减少。 |
| `tests/guards/quietSuccessMutation.test.ts` | 变异自证：证明上面那条守卫真的有牙齿。 |

**修改**

| 文件 | 改什么 |
|---|---|
| `src/components/common/toastPolicy.ts` | `ToastKind` 去掉 `'success'`。 |
| `src/components/common/Toast.tsx` | `ToastType` 去掉 `'success'`；`TYPE_LABEL` 去掉 `success: '完成'`；`getTypeStyles()` 去掉 success 分支（**default 分支当前返回 success 样式，必须改成 info 样式**）；`getIcon()` 去掉对勾；默认 `type = 'success'` → `'info'`。 |
| `src/contexts/ToastContext.tsx` | `showToast` 默认 `type = 'success'` → `'info'`。 |
| `src/utils/toastHelper.ts` | 删 7 个死 helper + 6 个随之失效的配置项；`restore-success` 的 `type` → `'info'`；`default:` 分支的 `type` → `'info'`；`NotificationConfig.type` 的联合类型去掉 `'success'`。 |
| `src/components/tabs/useConsumeUndo.ts` | `opts.type` 的联合类型 `'success' \| 'error'` → `'info' \| 'error'`。 |
| `src/components/auth/restoreFeedbackCopy.ts` | `LoginRestoreTone` 的 `'success'` → `'info'`。 |
| `src/components/layout/Header.tsx` | `:210` 清理重复标签结果 → fact。 |
| `src/components/layout/HeaderDropdown.tsx` | 8 处 success 逐条裁决（`:355` 删、`:570` 条件 fact、`:638` 条件 fact、`:812`/`:848`/`:904`/`:1377`/`:1502` fact）。 |
| `src/components/sync/WebDavSettings.tsx` | 6 处 success 逐条裁决（`:807` fact、`:1082`/`:1184`/`:1265`/`:1342`/`:1400` 删）。 |
| `src/options/OptionsPage.tsx` | 3 处 success 逐条裁决（`:494`/`:712` 删、`:588` 删 + 备注搬进 hint）。 |
| `src/components/tabs/TabGroup.tsx` | `:448` 锁定 toast → 卡片常驻行；`:567`/`:629` 锁定分支删播报（**保留成功门**）；`:672`/`:710` 中性化。 |
| `src/components/search/SearchResultList.tsx` | `:583`/`:637` 锁定分支删播报（**保留成功门**）；`:669`/`:880` 中性化。 |
| `src/components/tabs/restoreFeedbackCopy.ts` | 删 `openSingleTabSuccessMessage` / `restoreGroupSuccessMessage` 的 locked 死分支。 |
| `src/components/tabs/lockFeedbackCopy.ts` | `lockToggleMessage` 换成 `lockDisclosureText(isLocked): string \| null`（常驻行文案）。 |
| `src/components/layout/deleteAllMessages.ts` | 新增 `deleteAllCountMatches(input): boolean`。 |
| `tests/guards/toastUndoReachability.test.ts` | 6 处 `resolveToastDuration('success', …)` → `'info'`。 |
| `tests/guards/loginRestoreFeedback.test.ts` | `:62` 的 `.tone === 'success'` → `'info'`。 |
| `tests/restoreFeedbackHonesty.test.ts` | 接线断言收窄 + 删掉 4 条 locked 文案断言（`:66-84`）。 |
| `tests/guards/moveEmptiesSessionFeedbackMutation.test.ts` | 硬编码源码片段要跟着 `TabGroup.tsx` 的新写法同步（见 Task 3）。 |
| `tests/guards/deleteAllCountTruthMutation.test.ts` | 硬编码调用点字符串要同步（见 Task 2）。 |
| `README.md` / `CHROMEWEBSTORE.md` | 对外文案同步（Task 5）。 |

---

### Task 1: 判据层 `src/core/feedbackPolicy.ts`

**Files:**
- Create: `src/core/feedbackPolicy.ts`
- Test: `tests/feedbackPolicy.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  ```ts
  export type FeedbackLevel = 'silent' | 'fact' | 'error';
  export type ResultVisibility = 'self-evident' | 'hidden';
  export interface FeedbackInput {
    /** 结果是否完全能从界面状态看出来。 */
    visibility: ResultVisibility;
    /** 界面看不见、但用户必须知道的事实（**文案由调用方保留**，判据只看有没有）。 */
    hiddenFact?: string;
    /** 这次操作不可逆（消费 / 删除 / 清空）。 */
    irreversible?: boolean;
    /** 有没有退路（撤销按钮）。 */
    hasEscape?: boolean;
  }
  export interface FeedbackDecision {
    level: FeedbackLevel;
    /** 判据给出的理由（供守卫与调试，不进界面）。 */
    reason: string;
  }
  export const decideFeedback: (input: FeedbackInput) => FeedbackDecision;
  ```

  ⚠️ `FeedbackDecision` **不带 `message`** —— 事实文案留在调用方（它本来就在那儿），判据只判「该不该出声」。

- [ ] **Step 1: 写失败的测试**

`tests/feedbackPolicy.test.ts`，用 `node:test` 的 `describe` / `it` + `node:assert/strict`（与 `tests/sessionName.test.ts` 同风格）。断言这些用例（**判据的语义来自规格 §4.3，逐条对应**）：

| 输入 | 期望 `level` |
|---|---|
| `{ visibility: 'self-evident' }` | `'silent'` |
| `{ visibility: 'self-evident', hiddenFact: '有 2 个读不出来' }` | `'fact'` |
| `{ visibility: 'hidden' }` | `'fact'` |
| `{ visibility: 'hidden', irreversible: true, hasEscape: true }` | `'fact'` |
| `{ visibility: 'hidden', irreversible: true }` | `'error'` |
| `{ visibility: 'hidden', irreversible: true, hasEscape: false }` | `'error'` |
| `{ visibility: 'self-evident', irreversible: true }` | `'silent'` |

另加两条：
- `decideFeedback` 对同一输入**幂等**（两次调用结果全等）。
- 每个返回值的 `reason` 是**非空字符串**（守卫与调试要靠它，不许是空串）。

⇒ 一共 **9 条 `it`**（表格 7 行各一条 + 幂等一条 + `reason` 非空一条）。

- [ ] **Step 2: 跑测试确认它失败**

Run: `node --test --import ./tests/_register-loader.mjs --experimental-strip-types tests/feedbackPolicy.test.ts`
Expected: FAIL —— 报 `Cannot find module '../src/core/feedbackPolicy.ts'`。

- [ ] **Step 3: 实现 `src/core/feedbackPolicy.ts`**

签名见上。判据按这个顺序短路（每条都要在 `reason` 里说明命中的是哪条）：

1. `visibility === 'hidden' && irreversible && !hasEscape` ⇒ `'error'`
   —— 不可逆 + 界面表达不了 + 没有退路 = 最坏情况，不许静默。
2. `hiddenFact` 非空 ⇒ `'fact'`
   —— 有一件界面看不见的事必须说。
3. `visibility === 'hidden'` ⇒ `'fact'`
   —— 结果本身界面表达不了（分不清「打开了」还是「被删了」）。
4. 其余 ⇒ `'silent'`
   —— 结果完全在界面自明。

文件头注释必须写明：**「界面状态 = stdout，提示 = stderr。成功是状态，不是事件。」** 以及「判据层只管『该不该出声』，不管『在哪说』——载体是 toast 还是常驻位置由调用方决定；判据层不含任何文案。」

- [ ] **Step 4: 跑测试确认它通过**

Run: `node --test --import ./tests/_register-loader.mjs --experimental-strip-types tests/feedbackPolicy.test.ts`
Expected: PASS（9 条 `it` 全绿）。

- [ ] **Step 5: 跑类型检查**

先确认依赖装了（新建的 worktree 没有 `node_modules`）：

```bash
pnpm install --prefer-offline
```

Run: `pnpm type-check && pnpm type-check:tests`
Expected: 无输出（成功）。

- [ ] **Step 6: 提交**

规格与本计划**已经在 worktree 里**（建 worktree 时复制进来的）⇒ 直接提交：

```bash
git add docs/superpowers src/core/feedbackPolicy.ts tests/feedbackPolicy.test.ts
git commit -m "feat(feedback): 判据层 decideFeedback —— 成功是状态，失败是事件"
```

---

### Task 2: 类型层删掉 `success` + 19 处逐条裁决

编译器强制这一步是原子的：`success` 类型一删，所有 `showToast(..., 'success')` 立刻编译不过，必须在同一批里改完。

**Files:**
- Modify: `src/components/common/toastPolicy.ts`、`src/components/common/Toast.tsx`、`src/contexts/ToastContext.tsx`、`src/utils/toastHelper.ts`、`src/components/auth/restoreFeedbackCopy.ts`、`src/components/layout/Header.tsx`、`src/components/layout/HeaderDropdown.tsx`、`src/components/sync/WebDavSettings.tsx`、`src/options/OptionsPage.tsx`、`src/components/layout/deleteAllMessages.ts`
- Modify: `tests/guards/toastUndoReachability.test.ts`、`tests/guards/loginRestoreFeedback.test.ts`
- Test: `tests/guards/quietSuccess.test.ts`（**本任务创建该文件**，只落类型层与 19 处裁决的断言；接线、退路、成功门的断言留给 Task 3/4）

**Interfaces:**
- Consumes: `decideFeedback`（Task 1）
- Produces: `deleteAllCountMatches(input: { deletedCount: number; confirmedCount: number }): boolean`（本任务新增，后续任务与守卫引用）

- [ ] **Step 1: 先写「类型层不许再有 success」的守卫**

在 `tests/guards/quietSuccess.test.ts` 里先落两条断言（此时应当红）：

- 读 `src/components/common/toastPolicy.ts`，断言 `ToastKind` 的联合类型成员**不含** `'success'`。
- 读 `src/components/common/Toast.tsx`，断言 `ToastType` 的联合类型成员**不含** `'success'`，且 `TYPE_LABEL` 里**没有** `success` 键。

⚠️ 断言必须**解析联合类型的成员**，不许写成「文件里不含 `'success'` 三个字符」—— 那会误伤 `Toast.tsx` 里合法的 `case 'success'`（删掉之后就没有了，但同理 `AlertDialog` 之类会被误伤）。用正则取 `export type ToastType = ...;` 与 `export type ToastKind = ...;` 的成员列表再断言。

- [ ] **Step 2: 跑它确认红**

Run: `node --test --import ./tests/_register-loader.mjs --experimental-strip-types tests/guards/quietSuccess.test.ts`
Expected: FAIL —— 报 `ToastKind` 里仍有 `'success'`。

- [ ] **Step 3: 改类型层**

| 文件 | 改动 |
|---|---|
| `src/components/common/toastPolicy.ts:71` | `export type ToastKind = 'error' \| 'info' \| 'warning';` |
| `src/components/common/Toast.tsx:15` | `export type ToastType = 'error' \| 'info' \| 'warning';` |
| `src/components/common/Toast.tsx:25` | `TYPE_LABEL` 去掉 `success: '完成'` |
| `src/components/common/Toast.tsx:449` `getTypeStyles()` | 删掉 `case 'success'` 分支；**`default:` 分支当前返回 success 的样式（`:478`），改成 info 的样式**（`accent: 'bg-[var(--color-accent)]'` + `iconWrap: 'bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300'`） |
| `src/components/common/Toast.tsx:484` `getIcon()` | 删掉 `case 'success'`（那个对勾 svg）；`default:` 分支改成 info 的图标 |
| `src/components/common/Toast.tsx:107` | 默认参数 `type = 'success'` → `type = 'info'` |
| `src/contexts/ToastContext.tsx:96` | `showToast` 默认 `type = 'success'` → `type = 'info'` |

- [ ] **Step 4: 改 `toastHelper.ts`：删死代码、`restore-success` 降级**

- `NotificationConfig.type`（`:40`）的联合类型：去掉 `'success'`。
- `getNotificationConfig` 里**删除**这 6 个 case（它们只被死 helper 用）：`'save-success'`、`'save-error'`、`'delete-success'`、`'sync-success'`、`'sync-error'`、`'pinned-info'`。
- **保留** `'restore-success'`（活路径：`showRestoreSuccessMessage` 走的就是它），把它的 `type` 从 `'success'` 改成 `'info'`。
- **保留** `'restore-error'`、`'delete-error'`。
- `getNotificationConfig` 的 `default:` 分支（`:129`）的 `type` 从 `'success'` 改成 `'info'`。
- **删除 7 个死 helper**：`showSaveSuccess`、`showSaveError`、`showRestoreSuccess`、`showDeleteSuccess`、`showSyncSuccess`、`showSyncError`、`showPinnedInfo`。
- 保留 `showRestoreSuccessMessage`（4 个调用点）、`showRestoreError`（15 个）、`showDeleteError`（28 个）。
- ⚠️ **名字不要改**：`showRestoreSuccessMessage` 里的 "success" 指「恢复这件事已经发生」，不是「庆祝成功」。在它的注释里写明这一点，避免后人误以为漏改。

- [ ] **Step 5: 改 `LoginRestoreTone`**

`src/components/auth/restoreFeedbackCopy.ts:32`：`LoginRestoreTone` 的 `'success'` 改成 `'info'`。`loginRestoreFeedback` 里 `kind:'pulled'` 那一支的 `tone` 从 `'success'` 改成 `'info'`；另外两支（云端为空 / 拉回失败）不变。

同步改 `tests/guards/loginRestoreFeedback.test.ts:62` 的 `.tone === 'success'` → `.tone === 'info'`。

- [ ] **Step 6: 改 `toastUndoReachability.test.ts` 的 6 处**

把 `resolveToastDuration('success', …)` 改成 `resolveToastDuration('info', …)`。**断言的性质不变**（带动作 ⇒ ≥8000ms；不带动作 ⇒ 3000ms；duration 0 ⇒ 0）—— 它钉的是性质不是字面量。

- [ ] **Step 7: 逐条裁决 19 处（用 `decideFeedback` 裁决，不要凭感觉）**

每一处都要有 `decideFeedback` 的调用，**不许直接 `showToast`**。判据的形状统一是：

```ts
const fb = decideFeedback({ visibility: 'self-evident', hiddenFact: msg });
if (fb.level !== 'silent') showToast(msg, 'info', 4000);
```

| 位置 | 改法 |
|---|---|
| `Header.tsx:210` 清理重复标签结果 | **fact**。`decideFeedback({ visibility: 'self-evident', hiddenFact: cleanDuplicatesResultMessage(...) })` ⇒ 报 `'info'`。文案 `cleanDuplicatesResultMessage(...)` 不变 |
| `HeaderDropdown.tsx:355` 云端已是最新 | **删掉整个 `showToast` 调用**。留一行注释说明「探活命中也写 `lastSyncTime`（`src/services/syncEngine.ts:776`）⇒ 菜单那行会前进成「刚刚」，这就是回执」 |
| `HeaderDropdown.tsx:570` 已退出登录 | **条件 fact**——本机 N>0 时 `hiddenFact: 「本机 N 个会话仍保留，不会上传到其它账号。」`（**那句文案逐字不变**）；N=0 时**静默**（没有盲区：账号区变了就是回执）⇒ 与 #16 同口径 |
| `HeaderDropdown.tsx:638` 已删除 N 个会话 | **条件 fact**（见下） |
| `HeaderDropdown.tsx:812` 导出备份 | **fact**（`hiddenFact: <那句文案>`） |
| `HeaderDropdown.tsx:848` 导出 OneTab | **fact** |
| `HeaderDropdown.tsx:904` 诊断摘要已复制 | **fact** |
| `HeaderDropdown.tsx:1377` 导入 JSON | **fact** |
| `HeaderDropdown.tsx:1502` 导入 OneTab | **fact** |
| `WebDavSettings.tsx:807` 已保存并切到新云盘 | **条件 fact**——「换云盘」「切回自带存储」两支**含用户要做的下一步** ⇒ 出声；**「已保存」那一支静默**（纯结果播报） |
| `WebDavSettings.tsx:1082` 推送完成 | **删掉**（`firstPush` 状态机已就地渲染 `kind:'done'`，`WebDavSettings.tsx:1716`） |
| `WebDavSettings.tsx:1184` 已从云端下载到本机 | **删掉**（同上） |
| `WebDavSettings.tsx:1265` 已切回 TapStack 云端 | **删掉**（后端选择器变了 ⇒ 自明） |
| `WebDavSettings.tsx:1342` 已清除云服务信息 | **删掉**（表单被清空 ⇒ 自明） |
| `WebDavSettings.tsx:1400` 已锁定 | **删掉**（口令输入框被清空 ⇒ 自明） |
| `OptionsPage.tsx:494` 已退出登录 | **删掉**（账号区状态变了 ⇒ 自明） |
| `OptionsPage.tsx:588` 已开启自动同步 | **删掉**；**把「关闭浏览器后需重新输入应用密码才会继续」搬进该设置项的 hint**（设置项旁边的常驻说明文字，不是 toast） |
| `OptionsPage.tsx:712` 已切回 TapStack 云端 | **删掉**（选择器状态变了 ⇒ 自明） |
| `TabGroup.tsx:448` 锁定说明 | 本任务**先不动**（Task 3 处理：改成卡片常驻行 + 解锁静默） |

**`HeaderDropdown.tsx:638`（条件 fact）的具体做法**

1. 在 `src/components/layout/deleteAllMessages.ts` 新增：
   ```ts
   /** 实际删的数与用户确认的数一致吗？一致 ⇒ 列表空了就是回执，不必再说。 */
   export const deleteAllCountMatches = (input: {
     deletedCount: number;
     confirmedCount: number;
   }): boolean => input.deletedCount === input.confirmedCount;
   ```
   `deleteAllSuccessMessage` 本身**一个字都不改**（它有既有守卫 `tests/guards/deleteAllDisclosure.test.ts` 在钉）。
2. 调用点改成：
   ```ts
   const deletedCount = deletedCountFromResult(payload);
   const counts = { deletedCount, confirmedCount: plan.groupCount };
   const fb = decideFeedback({
     visibility: 'self-evident',
     hiddenFact: deleteAllCountMatches(counts) ? undefined : deleteAllSuccessMessage(counts),
   });
   if (fb.level !== 'silent') {
     showToast(deleteAllSuccessMessage(counts), 'info', 4000);
   }
   ```
   ⚠️ **实参形状必须保持 `deleteAllSuccessMessage({ deletedCount, confirmedCount: plan.groupCount })` 那个字面量形状**（变量名 `counts` 也行，但**键名与顺序不能变**），否则 `tests/guards/deleteAllCountTruthMutation.test.ts:93` 硬编码的片段匹配不上、变异沙箱会报「变异前提没成立」。若确需改动，**同一步里同步更新那个变异文件**。

- [ ] **Step 8: 跑类型检查，确认编译期闸门生效**

Run: `pnpm type-check`
Expected: 报出**所有**还没改完的 `'success'` 用法（这就是编译器替我们找出来的清单）。按清单改完后再跑一次，期望无输出。

⚠️ 若发现编译错误落在 §Global Constraints「命名空间纪律」列出的**不该动**的命名空间里（`AlertDialog.type` / `InlineNoticeTone` / `TabGroup.syncStatus` / 浏览器通知 `kind` / 就地反馈 `kind`），说明误改了 —— 那些地方本该是 `'success'` 合法存在。

- [ ] **Step 9: 跑受影响的既有守卫**

Run:
```bash
node --test --import ./tests/_register-loader.mjs --experimental-strip-types \
  tests/guards/toastUndoReachability.test.ts \
  tests/guards/loginRestoreFeedback.test.ts \
  tests/guards/deleteAllDisclosure.test.ts \
  tests/guards/deleteAllCountTruthMutation.test.ts \
  tests/guards/failureNotificationsAlwaysSend.test.ts \
  tests/guards/quietSuccess.test.ts
```
Expected: 全绿。

⚠️ `failureNotificationsAlwaysSend.test.ts` 里的 `kind: 'success'` 是**浏览器通知**的 kind，本次**不该变**。如果它红了，说明你误改了 `TabManager.ts` 的通知 kind。

- [ ] **Step 10: 提交**

```bash
git add -A src tests
git commit -m "feat(ui): toast 去掉 success 类型 —— 成功是状态不是事件（19 处逐条裁决）"
```

---

### Task 3: 恢复类播报 + 锁定说明常驻化 + 解锁静默

**Files:**
- Modify: `src/components/tabs/TabGroup.tsx`、`src/components/search/SearchResultList.tsx`、`src/components/tabs/restoreFeedbackCopy.ts`、`src/components/tabs/lockFeedbackCopy.ts`、`src/components/tabs/useConsumeUndo.ts`
- Modify: `tests/restoreFeedbackHonesty.test.ts`、`tests/guards/moveEmptiesSessionFeedbackMutation.test.ts`
- Modify: `tests/guards/quietSuccess.test.ts`（本任务补接线、退路、成功门断言）

**Interfaces:**
- Consumes: `decideFeedback`（Task 1）
- Produces:
  ```ts
  // src/components/tabs/lockFeedbackCopy.ts
  /** 锁定状态下常驻在卡片上的说明。解锁 ⇒ null（那行消失就是反馈）。 */
  export const lockDisclosureText: (isLocked: boolean) => string | null;
  ```

- [ ] **Step 1: 写「锁定分支可以静默，但成功门不许消失」的守卫**

在 `tests/guards/quietSuccess.test.ts` 里加（此时应当红）：

- **点开单标签的锁定分支静默**：对 `src/components/tabs/TabGroup.tsx` 与 `src/components/search/SearchResultList.tsx`，用括号配平抽出 `handleOpenTab` 里 `if (group.isLocked) { … }` 分支（**照抄 `tests/restoreFeedbackHonesty.test.ts:36` 的 `extractLockedBranch` 实现**），断言该分支里**没有** `showToast` / `showRestoreSuccessMessage` / `showConsumeToast` 调用。
  ⚠️ 这条**只适用于点开单标签**。整组恢复的锁定情形**不在** `if (group.isLocked)` 分支里（它靠 `group.isLocked ? undefined : { group }` 三元区分），见下一条。
- **整组恢复：成功路径对锁定组静默，但「部分成功」路径必须仍出声**：
  - 断言 `openAllTabs` 里那次**成功**的 `showConsumeToast`（参数里含 `restoreGroupSuccessMessage` 的那一次）**被一个 `!group.isLocked` 的条件包着**；
  - 断言那次**部分成功**的 `showConsumeToast`（文案里含 `skippedUnopenable` 相关的「在当前设备无法打开」、且 `type` 是 `'error'` 的那一次）**仍然存在且没有被条件包住**。
  ⚠️ 「有 N 个打不开」这件事界面表达不了 ⇒ 锁定组也必须说。**这条是硬要求，删了就是产品开始撒谎。**
- **成功门仍在**：同一分支里，`success !== true` / `success === false` 的判定**存在**，且**失败路径调用了 `showRestoreError`**。
- **锁定 ⇒ 卡片还在**：断言 `TabGroup.tsx` 的 `consumeSession` 实现里 `if (group.isLocked)` 早退（不 dispatch 删除）—— 这是「锁定组恢复后卡片还在、所以不必说」的**根据**。**只断言「没有提示」是零检测力**，必须同时钉住这条根据。
- **锁定分支不删行**：断言锁定分支里**没有** `deleteTabAndSync`。
- **解锁静默**：断言 `TabGroup.tsx` 里锁定/解锁的切换处**没有** `showToast`。
- **锁定说明常驻**：断言 `TabGroup.tsx` 渲染了 `lockDisclosureText(group.isLocked)` 的结果。
- **未锁定必须有退路**：断言未锁定的整组恢复与点开单标签两处都调用了 `showConsumeToast` 且**带**撤销 payload（非 `undefined`）。

- [ ] **Step 2: 跑它确认红**

Run: `node --test --import ./tests/_register-loader.mjs --experimental-strip-types tests/guards/quietSuccess.test.ts`
Expected: FAIL —— 锁定分支仍有成功播报。

- [ ] **Step 3: 改 `lockFeedbackCopy.ts`**

- **删除** `lockToggleMessage`（两个分支都不再需要：锁定走常驻行，解锁完全静默）。
- 新增：
  ```ts
  export const lockDisclosureText = (isLocked: boolean): string | null =>
    isLocked
      ? '已锁定 · 恢复后保留在列表 · 不参与「清理重复标签」与拖到别的会话'
      : null;
  ```
  ⚠️ 文案必须含三个要素：**① 已锁定 ② 恢复后保留在列表 ③ 不参与「清理重复标签」与拖到别的会话**。守卫按关键词断言这三个要素（仓库既有惯例是 `assert.match(msg, /已打开该标签页/)` 这种关键词匹配，不钉整句字面量）。
  ③ 里为什么含「拖到别的会话」：README:43 承诺锁定后「不可把标签拖到别的会话」，而这一条界面不告诉你 ⇒ 属于必须写出来的。其余后果（不可重命名、不可逐条删除）在界面上是**按钮消失/禁用**，界面自明 ⇒ 不必写。

- [ ] **Step 4: 改 `TabGroup.tsx`**

- `:448` 的 `showToast(lockToggleMessage(!group.isLocked), 'success', 4000)` **整个删掉**（锁定与解锁两条路径都不出声）。
- 卡片上**常驻一行**渲染 `lockDisclosureText(group.isLocked)`：非 `null` 时显示，`null` 时不渲染。位置选在**卡片头下方 / 标签行上方**（实现者自定，但必须跟着主题走、不违反密度定案）。
- `:567`（整组恢复）：**成功**那次 `showConsumeToast` 用 `if (!group.isLocked) { … }` 包起来（锁定组静默）；**部分成功**那次（`:543`，文案含「在当前设备无法打开」、`type: 'error'`）**必须留在条件之外，照旧出声**。**成功门**（`r.success !== true` 的判定与失败路径的 `showRestoreError`）一个字都不许动。
- `:629`（点开单标签的锁定分支）：删掉 `showRestoreSuccessMessage(openSingleTabSuccessMessage(true))`，**保留成功门**（`r.success !== true` 的判定与失败路径的 `showRestoreError`）。
- `:672`（未锁定点开单标签）与 `:710`（拖走最后一条标签）：改成经 `decideFeedback` 的 **fact**（`'info'`），文案保留「记录被移除了」这个事实，去掉指代当前动作的铺陈。
- `:543`（部分成功，`type: 'error'`）：**一个字都不动**。
- `useConsumeUndo.ts` 的 `opts.type` 联合类型 `'success' | 'error'` → `'info' | 'error'`；`showConsumeToast` 的非错误分支走的 `showRestoreSuccessMessage` 现在发的是 `info` ⇒ 撤销提示自动变中性。**8 秒窗口、`autoFocus`、焦点接管判据一个字都不许动。**

- [ ] **Step 5: 改 `SearchResultList.tsx`**

- `:583`（整组恢复）：**成功**那次 `showConsumeToast` 用 `if (!group.isLocked) { … }` 包起来；**部分成功**那次（`:558`）**必须留在条件之外，照旧出声**。**成功门**不动。
- `:637`（点开单标签的锁定分支）：删掉成功播报，**保留成功门**。
- `:669`（未锁定点开单标签）与 `:880`（批量恢复四笔账）：改成 fact（`'info'`），**四笔账的数字与措辞一个字都不许改**。
- `:558`（部分成功，`type: 'error'`）：**一个字都不动**。

- [ ] **Step 6: 改 `restoreFeedbackCopy.ts`**

- `openSingleTabSuccessMessage(isLocked)` 的 **locked 分支**（`'已打开该标签页。该会话已锁定，记录仍保留在会话中。'`）成为死分支 ⇒ 删掉，函数简化为只描述消费语义。
- `restoreGroupSuccessMessage(count, isLocked, inCurrentWindow)` 的 **locked 分支**成为死分支 ⇒ 删掉。
  ⚠️ **新签名**（按此收窄，实现者照抄）：
  - `openSingleTabSuccessMessage(): string`（去掉 `isLocked` 参数）
  - `restoreGroupSuccessMessage(tabCount: number, inCurrentWindow = false): string`（去掉 `isLocked` 参数）
  - **`restoreOutcomePhrase(isLocked)` / `restoreOutcomeSentence(isLocked)` 保留 `isLocked` 参数** —— 恢复按钮的 tooltip 与 aria-label 依赖它们，这两条**一个字都不许改**。
  ⚠️ **`inCurrentWindow` 参数必须保留**（2026-10-25 定案「在当前窗口打开」是主操作，那句文案不许说成新窗口）。
  - 既有守卫 `tests/restoreFeedbackHonesty.test.ts` 里 `restoreGroupSuccessMessage(5, false)` / `openSingleTabSuccessMessage(false)` 等调用点**一并改成新签名**（`restoreGroupSuccessMessage(5)` / `openSingleTabSuccessMessage()`）。
- 同步改 `tests/restoreFeedbackHonesty.test.ts`：
  - **删掉** 4 条 locked 文案断言（`:66-84` 区间里 `restoreGroupSuccessMessage(3, true)` / `openSingleTabSuccessMessage(true)` 那几条）。
  - **改窄**接线断言：列表页与搜索页的 `countSuccessToasts` 计数里，锁定分支不再要求播报；改成断言「未锁定路径有播报且带撤销」+「锁定路径无播报但有成功门」（与 Step 1 的新断言一致，不要重复写两套）。
  - 保留「成功门必须先于播报」那条断言的**未锁定**部分。

- [ ] **Step 7: 同步 `moveEmptiesSessionFeedbackMutation.test.ts` 的硬编码片段**

`tests/guards/moveEmptiesSessionFeedbackMutation.test.ts:120-137` 用**硬编码的多行源码片段**替换 `TabGroup.tsx` 里 `showRestoreSuccessMessage(\n  moveEmptiesSessionMessage({…})\n)` 那一段。Step 4 改了那一行的写法 ⇒ **必须同步更新这个硬编码片段**，否则变异会报「变异前提没成立」。

更新后的片段要与 `TabGroup.tsx` 里的**实际文本逐字一致**（含缩进）。

- [ ] **Step 8: 跑受影响的既有守卫**

Run:
```bash
node --test --import ./tests/_register-loader.mjs --experimental-strip-types \
  tests/restoreFeedbackHonesty.test.ts \
  tests/guards/toastUndoReachability.test.ts \
  tests/guards/toastUndoReachabilityMutation.test.ts \
  tests/guards/moveEmptiesSessionFeedback.test.ts \
  tests/guards/moveEmptiesSessionFeedbackMutation.test.ts \
  tests/guards/consumeUndoWiring.test.ts \
  tests/guards/quietSuccess.test.ts
```
Expected: 全绿。

- [ ] **Step 9: 真机验证（不能只靠单测）**

用 `scripts/lead-inspect-localhost.mjs` 或手动加载扩展，逐条确认：

1. 锁定一个会话 → 恢复 → **没有任何 toast**、卡片还在、窗口开了、卡片上有那行常驻说明。
2. 锁定一个会话 → 点开其中一个标签 → **没有任何 toast**、那行还在、页面开了。
3. 未锁定会话 → 恢复 → **只有一条中性提示**（info 外观、无绿色「完成」药丸、无对勾）、有撤销按钮、8 秒内点得到、撤销后记录回到**原来的位置**。
4. 未锁定会话 → 点开单个标签 → 同上。
5. 搜索页批量恢复 → 一条提示、**四笔账的数字都在**。
6. 打开一个 `file://` 地址 → **有错误提示**「已保留在会话中」。
   ⚠️ 这条走的是 **popup 侧的前置拦截**（`src/utils/inputValidation.ts:281` 的 `isOpenableTabUrl`）⇒ **到不了 SW 的成功门**。SW 成功门由守卫 + 变异自证覆盖，**不要**在真机里假装能构造出来。
7. 锁定 → 解锁 → **没有任何 toast**，卡片上那行常驻说明消失。

- [ ] **Step 10: 提交**

```bash
git add -A src tests
git commit -m "feat(ui): 锁定组恢复静默 + 锁定说明常驻化 + 撤销提示中性化"
```

---

### Task 4: 守卫与变异自证（钉住最终形态）

**Files:**
- Modify: `tests/guards/quietSuccess.test.ts`（补全 19 处裁决登记表、失败不减少、命名空间不误伤三条断言）
- Create: `tests/guards/quietSuccessMutation.test.ts`
- Test: 同上

**Interfaces:**
- Consumes: `decideFeedback`（Task 1）、`lockDisclosureText`（Task 3）、`deleteAllCountMatches`（Task 2）
- Produces: 无（这是收口任务）

- [ ] **Step 1: 写「19 处裁决的登记表」守卫**

在 `tests/guards/quietSuccess.test.ts` 里加一张**显式登记表**（每个条目：文件、行号锚点、裁决档、判据调用是否在位）。这张表是防止裁决漂移的主力。

登记表必须包含 §Global Constraints 里那 19 个 `success` 位置（**行号以 Task 2 改完后的实际为准，用函数名 + 周边唯一字符串定位，不要死钉行号** —— 行号会随别的改动漂移）。

**19 行都要有**，下面 6 行是**必须逐字照抄的格式样板**（锚点 + 裁决 + 断言写法），其余 13 行按同一形状、用 Task 2 Step 7 那张表的锚点与裁决补齐（silent 的断言是「那句文案在源码里**不存在**」；fact 的断言是「`decideFeedback(` 与 `showToast(..., 'info')` 都出现在这一段里」）：

| 锚点（唯一字符串） | 裁决 | 断言 |
|---|---|---|
| `'云端已是最新'` | silent | 该字符串在 `HeaderDropdown.tsx` 里**不存在**（整条提示被删） |
| `deleteAllSuccessMessage(` | 条件 fact | 该函数在 `HeaderDropdown.tsx` 的调用处**被 `if (fb.level !== 'silent')` 包着**；且该处出现 `deleteAllCountMatches(` |
| `cleanDuplicatesResultMessage(` | fact | 同文件里出现 `decideFeedback(` 且该提示的 type 是 `'info'` |
| `lockToggleMessage` | 替换 | 在 `lockFeedbackCopy.ts` 里**不存在**；`lockDisclosureText` 存在且被 `TabGroup.tsx` 引用 |
| `openSingleTabSuccessMessage(` | 只剩未锁定 | `restoreFeedbackCopy.ts` 里该函数**不含**「仍保留在会话中」那句；`TabGroup.tsx` 的锁定分支**不含**它 |
| `restoreGroupSuccessMessage(` | 只剩未锁定 | 同上；且 `inCurrentWindow` 参数**仍在** |

**三处「条件 fact」的形状（登记表的断言按这张表写）：**

| 锚点 | 什么时候出声 | 断言 |
|---|---|---|
| `retainedFact`（`HeaderDropdown.tsx` 退出登录） | `localCount > 0` | 断言 `localCount > 0 ? …不会上传到其它账号` 与 `hiddenFact: retainedFact` 都在；**并**断言 N=0 那一支的空 fact 会落进 `fb.level === 'silent'`（一个字都不说） |
| `deleteAllSuccessMessage(` | `deleteAllCountMatches` 为**假**（数量对不上） | 断言该调用处**被 `if (fb.level !== 'silent')` 包着**；且该处出现 `deleteAllCountMatches(` |
| `saveFact`（`WebDavSettings.tsx` 保存） | 只有「换云盘」「切回自带存储」两支 | 断言 `saveFact` 的三个分支里，**纯「已保存」那一支的 fact 为空**（空 fact ⇒ 判据层判 silent ⇒ 不出声） |

⚠️ **接线守卫必须真的调用那条路径** —— 断言要落在「`decideFeedback(` 出现在这段代码里」+「这段代码的 `showToast` 的 type 是 `'info'`」上，**不许**只断言「文件里出现过 `decideFeedback`」（那是零检测力）。

- [ ] **Step 2: 写「失败不得被静默」的守卫**

- 断言全仓 `showToast` 的 `error` 型调用点数 **≥ 35**（Task 2 之前的基线；用与 Task 2 同一个解析器数，避免口径漂移）。
- 断言 `resolveToastDuration('error', 3000, false) === 0`（错误常驻，不许被改回自动消失）。
- 断言 `toastQueuePolicy.isEvictable` 对 error 与带动作的提示都返回 `false`。

- [ ] **Step 3: 写「命名空间不许误伤」的守卫**

断言 `src/components/common/AlertDialog.tsx` 里 `type?: 'success' | …` **仍然存在**、`src/types/tab.ts` 的 `TabGroup.syncStatus` 里**仍然有** `'success'`。目的是证明闸门是命名空间限定的，不是 blanket。

- [ ] **Step 4: 跑它确认绿**

Run: `node --test --import ./tests/_register-loader.mjs --experimental-strip-types tests/guards/quietSuccess.test.ts`
Expected: PASS。

- [ ] **Step 5: 写变异自证 `tests/guards/quietSuccessMutation.test.ts`**

用 `tests/_helpers/mutationSandbox.ts` 的 `runMutationCases` / `assertMutationOutcome`，照 `tests/guards/moveEmptiesSessionFeedbackMutation.test.ts` 的写法。**每个变异都要断言「红在目标断言上」**（`expectedFailure`），不許只断言「红了」。

必做的变异（`expectRed: true`）：

| 变异 | 目标 | 期望红在 |
|---|---|---|
| ① 把未锁定整组恢复的 `showConsumeToast` 删掉 | `src/components/tabs/TabGroup.tsx` | 「未锁定必须有退路」 |
| ② 把锁定分支的 `r.success !== true` 判定删掉 | `src/components/tabs/TabGroup.tsx` | 「成功门仍在」 |
| ③ 把锁定分支的 `showRestoreError` 失败路径删掉 | `src/components/tabs/TabGroup.tsx` | 「成功门仍在」 |
| ④ 把 `deleteAllCountMatches` 改成恒返回 `true` | `src/components/layout/deleteAllMessages.ts` | 「删除数量不一致必须说」 |
| ⑤ 把 `decideFeedback` 的 `hiddenFact` 分支删掉 | `src/core/feedbackPolicy.ts` | 「fact 档判据」 |
| ⑥ 把 `lockDisclosureText` 改成恒返回 `null` | `src/components/tabs/lockFeedbackCopy.ts` | 「锁定说明常驻」 |
| ⑦ 把 `ToastKind` 的 `'success'` 加回去 | `src/components/common/toastPolicy.ts` | 「类型层不许再有 success」 |

⚠️ 变异 ④⑥ 改的是**纯函数**，变异写法要用「替换函数体」而不是「替换调用点」；变异 ⑦ 改的是类型字面量 ⇒ 目标断言是类型层那条。
⚠️ 变异 ②③ 定位的代码（`r.success !== true` 那一段）在 Task 3 之后文本可能位移 ⇒ 变异必须用「先定位再替换」并且**断言变异真的应用了**（沙箱的 `replaceIn` 找不到就抛「变异前提没成立」）。

再补一个**反向**变异（`expectRed: false` —— 守卫不许钉死字面量）：

| 变异 | 目标 | 期望 |
|---|---|---|
| ⑧ 把 `restoreGroupSuccessMessage` 的 `inCurrentWindow` 参数改名 | `src/components/tabs/restoreFeedbackCopy.ts` | **仍然绿**（守卫钉的是性质不是字面量） |

⚠️ 变异沙箱会拷一份仓 ⇒ 8 个变异要跑一会儿。**别把这个文件放进 `pnpm test` 的常跑路径之外又期待它快** —— 它本来就慢，仓库既有的变异文件也是这样。

- [ ] **Step 6: 跑变异自证**

Run: `node --test --import ./tests/_register-loader.mjs --experimental-strip-types tests/guards/quietSuccessMutation.test.ts`
Expected: PASS（8 个 `it` 全绿，每个都断言「变异必须真的跑起来」）。

- [ ] **Step 7: 提交**

```bash
git add tests/guards/quietSuccess.test.ts tests/guards/quietSuccessMutation.test.ts
git commit -m "test(feedback): 安静成功守卫 + 变异自证（钉住 19 处裁决）"
```

---

### Task 5: 对外文案同步 + 全量验收

**Files:**
- Modify: `README.md`、`CHROMEWEBSTORE.md`
- Test: `tests/guards/outwardCopyTruthfulness.test.ts`、`tests/docsAlignment.test.ts`

**Interfaces:**
- Consumes: 全部前置任务
- Produces: 无

- [ ] **Step 1: 逐条核对外文案的每一句「弹什么」**

只改**描述界面上会弹什么**的句子。以下**一个字都不许动**：

- `README.md:45`、`README.md:139-140`（撤销退路的承诺）—— 撤销提示**保留**，所以这两句**仍然成立**，只需确认措辞与实现一致（提示仍是「屏幕上会出现一条带「撤销」按钮的提示」；若要提外观，加「中性」二字）。
- `CHROMEWEBSTORE.md:160`（同上）。
- `CHROMEWEBSTORE.md:261`、`src/legal/privacy.html:71`、`src/options/OptionsPage.tsx:1101`（浏览器通知的三处承诺）—— **浏览器通知不受本次改造影响，不许改**。

⚠️ **特别容易误改的一类**：README 与商店页里大量「成功/失败」提法是在讲**同步与数据安全的历史缺陷**
（例如「以前界面报『同步成功』但其实没同步」）—— 那是**记述**，不是对当前 toast 行为的承诺 ⇒ **不许改**。
判据：这句在描述**过去**还是**现在**？描述过去的 ⇒ 不动。

要改的只有描述**当前**界面行为的句子。若核下来没有需要改的 ⇒ **不改，并在提交信息里说明「对外文案逐条核对后无需改动」**。

- [ ] **Step 2: 跑文案守卫**

Run:
```bash
node --test --import ./tests/_register-loader.mjs --experimental-strip-types \
  tests/guards/outwardCopyTruthfulness.test.ts \
  tests/guards/outwardCopyTruthfulnessMutation.test.ts \
  tests/docsAlignment.test.ts \
  tests/guards/storeListingTruthfulness.test.ts
```
Expected: 全绿。

- [ ] **Step 3: 全量套件（后台跑）**

```bash
pnpm test > /tmp/quiet-success-full-test.log 2>&1
```
**20–30 分钟。** 必须后台跑（`run_in_background: true`），跑完读日志尾部确认 `fail 0`。

⚠️ 跑之前先确认 `git status` 干净 —— 主工作树里别人的 v1.28.6 改动**不在**这个 worktree 里，不要混进来。

- [ ] **Step 4: 类型 + lint + 构建**

```bash
pnpm type-check && pnpm type-check:tests && pnpm lint && pnpm lint:tests && pnpm build
```
Expected: 全部无输出（成功）。

- [ ] **Step 5: 编译期闸门自证（一次性，手工验证）**

在 worktree 里临时写一行 `showToast('x', 'success')` 到任一 `src/` 文件 ⇒ 跑 `pnpm type-check` ⇒ **必须报类型错误**。验证完**删掉那行**。
再临时在 `src/components/common/AlertDialog.tsx` 的 `type` 里加 `'success'`（那里本来就有）⇒ `pnpm type-check` 仍**必须成功** —— 证明闸门没误伤别的命名空间。

- [ ] **Step 6: 提交**

**只在确实改了 README.md 或 CHROMEWEBSTORE.md 时才提交**（Step 1 若核下来无需改动 ⇒ 不制造空提交，在任务报告里写明「逐条核对后无需改动」）。

```bash
git add README.md CHROMEWEBSTORE.md
git commit -m "docs: 同步对外文案（撤销退路与浏览器通知的承诺保持不变）"
```

- [ ] **Step 7: 交付说明**

在提交信息或 PR 描述里写清：
- 19 处裁决的清单（silent 9 / 条件 fact 3（#3 退出登录 N>0 才说、#4 删除全部数量一致时静默、#10 保存三支里「已保存」那支静默）/ fact 6 / 常驻 1（锁定说明））。
- 撤销机制、错误通道、浏览器通知**均未改动**。
- 与主工作树的 v1.28.6 改动在 `src/components/common/Toast.tsx`、`src/contexts/ToastContext.tsx`、`src/components/tabs/TabGroup.tsx` 三处会有**小规模合并冲突**（改的是文件里不同的区域：`getTypeStyles`/`TYPE_LABEL`/`getIcon` vs `stackOffset`/`onHeightChange`）⇒ 合并时人工确认两边的意图都保住。

---

## 自查

**规格覆盖** —— 规格 §4 判据 → Task 1；§5.1 的 19 条 → Task 2；§5.2 的 11 处恢复类 → Task 3；§5.3 锁定/解锁 → Task 3；§5.4 撤销 → Task 3；§6.1 类型层 → Task 2；§6.2 守卫 8 条 → Task 2/3/4；§6.3 变异自证 → Task 4；§6.4 现有守卫收窄 → Task 2/3；§6.5 对外文案 → Task 5；§6.6 预览文案 → Task 5 Step 1（核到不改就不改）；§7 分批 → Task 1–5；§8 验证 → Task 3 Step 9（真机）+ Task 5 Step 3–5（全量/类型/闸门自证）。

**Review Focus 覆盖** —— ① 退路 → Task 3 Step 1 + Task 4 变异①；② 界面变化 → Task 3 Step 1；③ 数量对不上 → Task 2 Step 7 + Task 4 变异④；④ 导入导出计数 → Task 2 Step 7；⑤ 失败被静默 → Task 3 Step 1 + Task 4 变异②③ + Task 4 Step 2。

**类型一致性** —— `decideFeedback`（Task 1 定义，Task 2/3/4 使用，签名一致）；`deleteAllCountMatches`（Task 2 定义，Task 2/4 使用）；`lockDisclosureText`（Task 3 定义，Task 3/4 使用）；`FeedbackLevel` / `ResultVisibility` / `FeedbackInput` / `FeedbackDecision` 四个类型名全文一致。

**比例** —— 规格 400 行、计划 560 行；计划里没有函数体，只有签名、测试名、断言与命令。
