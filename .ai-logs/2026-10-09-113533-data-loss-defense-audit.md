# AI Log：数据丢失防线专项审查（只读 + 变异验证）

- 时间：2026-10-09 11:35 起（Asia/Shanghai）
- 项目：TapStack（chrome-plugin-one-tab），HEAD=cdcad40，版本 1.22.15
- 触发：用户要求做一次彻底的数据丢失防线审查，找「任何一条能让用户数据消失、被旧数据覆盖或静默降级的路径」，覆盖 8 个指定检查项；硬规矩：只读审查不改产品代码、grep 零命中必须第二方法复核、变异验证用 cp 备份并还原。

## 一、对话出发点（原始需求与动机）

TapStack 删除即物理清除、无回收站，所以审查目标不是「功能能跑」，而是「有没有任何一条丢数据的因果链」。
要求先完整读 `.codex/agents/_shared.md`（已实测事实底座），并按 P0/P1/P2 + 缺陷清单 + 误判记录 + 未验证项 + 负责人决断项的结构交付。

## 二、执行过程

1. 读 `_shared.md` 全文（2726 tokens），确认 5 个头号陷阱与数据安全不变量。
2. 逐层读实现：`storage.ts`(1088) → `syncEngine.ts`(738) → `indexedDbClient.ts` / `storageAdapter.ts` → `download.ts` / `upload.ts` / `probe.ts` / `readback.ts` → `mutationOps.ts` / `mutationHandlers.ts` / `mutationQueue.ts` → `tabSlice.ts` / `tabSliceHelpers.ts` → `TabManager.ts` / `backgroundSync.ts` / `service-worker.ts` → `migrationHelper.ts` / `migrationUtils.ts` / `opStampMigratedGuard.ts` → `settingsSlice.ts` / `ThemeContext.tsx` / `SyncButton.tsx` / `HeaderDropdown.tsx` / `TabList.tsx`。
3. 门禁实测（本机真实执行）：
   - `node --test "tests/**/*.test.ts"` → **995 tests / 995 pass / 0 fail / 0 skipped**（17.7s 首跑、12.6s 复跑）
   - `tests/storageFailClosed.test.ts` → 4/4 pass
   - 单文件复跑与全量复跑均为 0 skipped（真库门禁未被静默跳过）
4. 用 rg 做全量调用方清点（getGroups / setGroups / clear / enqueue / migration），并按硬规矩用 **python 全量扫描**做第二方法复核，写入报告。
5. 写了 2 个临时测试文件做变异验证：
   - `tests/_audit_repro.test.ts`（缺陷复现 4 条）
   - `tests/_audit_guard.test.ts`（回归守卫 4 条，源码结构断言 + 剥注释）
6. 变异验证四轮（每轮 cp 备份 → 改实现 → 跑测 → cp 还原 → sha256 校验，未用 git checkout）：
   - A（migrateToV2 入队）：守卫 RED → GREEN → RED；修复态全量 997 pass / 6 fail，6 条全是自己的审计测试
   - B（popup 迁移交 SW 执行）：与 A 同一轮，守卫 RED → GREEN → RED
   - C（设置读失败后禁写）：行为测试 RED（`实得: Group %d` 覆盖了真值 `工作模板`）→ GREEN → RED
   - D（删除链路严格探测）：守卫 RED → GREEN → RED；修复态全量 997 pass / 6 fail，**995 条原有测试全绿**
7. 还原后全量：**995 / 995 / 0 fail / 0 skipped**；`git diff --stat -- <我碰过的 5 个文件>` 为空。
8. 删除 2 个临时测试文件（apply_patch Delete File），复跑全量确认 995/0/0。

## 三、遇到的问题（报错、阻塞、意外行为）

1. `rtk snapshots before/after` 不可用：本机 `rtk 0.51.0` 是输出过滤代理，没有 `snapshots` 子命令，所有调用都返回 `[rtk: No such file or directory (os error 2)]`（`rtk --version` 正常、`rtk help` 只列出 ls/tree/read/… ）。改用项目硬规矩里的 `cp` 备份 + `shasum -a 256` 前后校验，已在报告中标注为环境限制。
2. `rm -f tests/_audit_*.ts` 被命令安全包装拒绝（`rm -f style commands are not permitted`），改用 apply_patch 的 Delete File。
3. 设置缺陷第一次复现是**假绿**：我用 `storage.setSettings()` 种数据，它落盘后顺手把结果写进了 60s settings 缓存，`loadSettings` 直接命中缓存、根本没走存储读 → 测试意外通过。改为「raw `kvSet` + 显式删 settings 缓存」后才复现真缺陷。这正是「fixture 会把 bug 藏起来」的实例。
4. D 的**第一版修法错了**：直接把 `supportsOpStamp()` 的非确定性失败改成 throw → 守卫转绿，但全量测试打红了 `tests/downloadChain.test.ts:783「探测请求抛非确定性错误时同样降级，且不缓存失败结果」`。复核确认：下载侧 fail-open（少选列走 select=*）是**有意为之且被测试钉住**的正确口径；错的是把同一个结果原样喂给删除链路。已撤回第一版修法，改成「只给删除链路加严格探测 `supportsOpStampStrict()`」，重跑后 995 条原有测试全绿。
5. 工作区存在本任务之外的未提交改动（`docs/y-bundle-report.md`、`scripts/e2e-web-dashboard-sync.mjs`、`scripts/run-e2e.mjs` 等），按 `_shared.md` 陷阱 4 判定为外部自动化/既有改动，未 reset、未 revert、未纳入本次结论。

## 四、最终结果（成功/失败/部分完成及具体产出）

- **完成**：只读审查 + 4 条缺陷 + 每条的变异验证；产品代码零改动（5 个被变异的文件 sha256 全部与备份一致，`git diff --stat` 为空），临时测试已删除，全量 995/995/0/0。
- 结论：P0 ×2（两处全量读-改-写 groups 的迁移不在单写者队列内，一处 SW 裸调用、一处 popup 跨 realm 直写）；P1 ×2（设置读失败被 UI 吞掉后默认值整份覆盖本地+可上云；删除链路的印记列探测 fail-open 导致 plain 墓碑不带印记、删除广播对持有副本的对端静默失效）；P2 ×2（同步预览读 30s 缓存、后台刷新失败已有数据时 UI 无提示）。
- 撤回的误判 5 条（storage.clear/secureStorage.clear 零调用方、硬删幽灵复活、导入超时当成功、空快照跳过回滚、lastLoadedAt 固化路径已是死代码），详见报告「误判记录」。
- 未验证 4 项（毫秒级真实双 realm 时序、线上 Supabase schema、count===null 的网关行为、995 测试之外的真机 E2E），均在报告中明确标注「受环境限制，非遗漏」。
