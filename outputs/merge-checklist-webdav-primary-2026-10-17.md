# 分支合并清单：`slim/webdav-primary` → `main`

- 分析日期：2026-10-17
- 基准：`main` @ `a31cb5f`（tag `v1.24.1` = `origin/main` = `origin/HEAD`）
- 候选：`slim/webdav-primary` @ `c25dc96`（本地 = `origin/slim/webdav-primary`）
- 本次**未修改任何代码**，仅做只读分析与隔离验证

---

## 0. 结论速览

1. **全仓库只有 1 个其他分支**（`git ls-remote` 全量确认）：`slim/webdav-primary`。历史分支 `feature/webdav-selfhost-sync` 早已 fast-forward 并入 main，不存在待挖掘的遗留分支。stash / worktree 均无隐藏工作。
2. **该分支是 `main` 的直接后继**：merge-base 就是 main 的 HEAD `a31cb5f`，双向独有提交为 `0 / 1`。**"合并"实际是一次 fast-forward，零冲突**（已用 `git merge-tree` 验证）。因此不存在"挑拣部分特性"的常规空间——只有"整体接受"或"整体拒绝"两种选择。
3. **分支质量已实测通过全部门禁**（我在隔离 worktree 中独立跑过，非引用提交说明）：tsc ×2 ✅、eslint ×2 ✅、**单测 1133 例 0 失败 0 跳过** ✅、vite build ✅、首屏体积 147.3KB ≤ 240KB ✅、元数据校验 ✅。
4. **建议：整体接受，以本分支为准快进 main。** 它不是"可选特性集合"，而是一次 BREAKING 级架构收敛（云端下线），各改动点高度咬合，无法拆分挑选。留在 main 等于这批已验证的 P0 修复永不落地。
5. **但合并前有 3 个必须由你拍板的前置决策**（见 §4），其中版本号未 bump 是硬伤。

---

## 1. 分支关系事实

| 项 | 值 |
|---|---|
| merge-base | `a31cb5f`（= main HEAD，即 main 未前进） |
| main 独有提交 | 0 |
| 分支独有提交 | 1（`c25dc96`） |
| 提交性质 | 单个巨型提交，238 文件，+7339 / −22805 |
| 冲突预判 | **零**（fast-forward） |
| 变更构成 | 修改 108、新增 20、删除 89、重命名 21（R100×20 + R098×1） |
| 分支是否已推送 | 是，`origin/slim/webdav-primary` = `c25dc96` |

> ⚠️ 这与 `outputs/` 下 2026-10-16 那份旧分析的前提已不同：当时改动还停留在**未提交的工作区**，故旧文档结论是"提交并 fast-forward"。如今已提交为 `c25dc96`，仅剩"是否快进 main"这一步。

---

## 2. 可获取的功能特性清单

按"是否值得单独拿出来看"排序。**所有项共享同一前提：Supabase 云端整体下线**。

### 2.1 架构类（不可拆分，是其余特性的地基）

| # | 特性 | 主要改动 | 可行性 | 风险 |
|---|---|---|---|---|
| A1 | **Supabase 后端整体下线** | 删 `src/utils/supabase/*`(11 文件约 147KB)、`supabaseFacade.ts`、`supabaseAdapter.ts`、`supabase/`(28 迁移)；去依赖 `@supabase/supabase-js`/`pg`/`@types/pg`（lockfile −234 行）；CI 删 Postgres 安装段 | ✅ 已验证 | **老用户托管在云端的历史数据在新构建不可读**（需回退导出，属发布决策） |
| A2 | **账户体系删除** | 删 `authSlice`(252行)、`AuthProvider`、`AuthModal/LoginForm/RegisterForm`、`authGuard`、`authCache`；`SyncBackendId` 收窄为 `'webdav'` 单成员；老值 `'supabase'` 由 `validateSyncBackend` 回落并出声 | ✅ 已验证 | 用户失去"登录即用"，须自备 WebDAV + 每次解锁 |
| A3 | **后端解析 fail-closed 收窄** | `resolveBackendOutcome` 重写，5 处"回落 Supabase"分支全消；未预解析时返回锁定占位后端而非云端 | ✅ 已验证 | `fallbackReason` 恒 `undefined`（保留字段，轻微死代码） |

### 2.2 缺陷修复类（★ 本分支最高价值的部分，可独立理解）

| # | 特性 | 修的是什么 | 主要改动 | 可行性 | 风险 |
|---|---|---|---|---|---|
| B1 | **锁定态不再被误判为故障** | 未配置/未解锁曾被计入失败退避阶梯，**连续 8 次后自动同步被静默停掉**，而设置页仍宣称"每 N 分钟同步一次" | 新增 `src/sync-backend/lockedBackendError.ts`（`LockedBackendError` + `code: 'backend_locked'`，双判据 `instanceof`/`code` 以跨 realm 生效）；`ResolutionOutcome` 新增 `lockedKind: unconfigured/locked/error`；`backgroundSync` 锁定时 `{ok:true, kind:'yielded', locked:true}` —— **不进退避、不清 alarm、按用户档位重排** + 一次性可见通知 | ✅ 已验证 | 布尔返回值不再区分"在途让路"与"未配置让路"，判别力转移到测试 |
| B2 | **删除方向错误的校验规则** | `validateMergeResult` 规则 2 把"对端全删、本机应收敛"这一**合法场景**当故障拦 → 本地仅存的会话永远收不到跨设备删除，形成永不收敛的僵尸副本 | 删 `src/core/syncDecision.ts` 规则 2，并留档完整推导与"防止凭直觉加回来"的警告；实测探针先红后绿 | ✅ 已验证，**但属安全面改动，建议列为合并评审必审项** | 防线方向变更，评审须独立复核推导 |
| B3 | **覆盖下载空云端闸门** | 用空云端执行"以云端为准"会**清空本机全部会话且不可恢复**（v1.22.0 起无回收站）；原校验因 `local=0` 恒看不见 | 新增 `decideForceRemoteOverwrite()`：本地活跃>0 且云端**连墓碑都没有** ⇒ refuse（`overwrite_empty_cloud_refused`），在 `syncEngine.downloadAndMerge` 置空本地**之前**执行；判据刻意不含"仅有墓碑"的合法状态 | ✅ 已验证 | 无 |
| B4 | **WebDAV fetch receiver P0** | `this.fetchImpl(...)` 把 receiver 设为实例 → Chrome 抛 `Illegal invocation`，请求根本没发出去，**"测试连接"无论填什么都失败**；Node 单测抓不到（stub 不校验 receiver） | `const doFetch = this.fetchImpl` 后再调用（`client.ts:299`） | ✅ 已验证 | 无 |
| B5 | **WebDAV 请求级超时上界** | WebDAV 从未有过超时（Supabase 路径曾有 45s，迁移时漏搬）；挂死服务器会把单写者队列钉死 | `AbortController` + `DEFAULT_REQUEST_TIMEOUT_MS=45_000` + `WebDavRequestTimeoutError`；timer 在 `finally` 清理；`isTimeout` 区分于网络失败 | ✅ 已验证 | 无 |
| B6 | **409 归入 notFound** | 坚果云/Nextcloud 对"父目录不存在"返回 409，首次配置整链挂死 | 新增 `NotFoundReason = 'no-such-resource'/'missing-parent'`；仅 `get()` 生效，`put/mkcol` 的 409 语义**一字未改**；`ensureRootDir()` 读前幂等预建 | ✅ 已验证 | 无 |
| B7 | **首次推送归属决策** | 配完 WebDAV 后本地数据**永远出不了本机**（原实现既不提示也不上传；早期因"保存动作碰巧触发上传"被掩盖） | 新增 `firstSyncDecision.ts` 纯函数决策 + 后果预览；`WebDavSettings` 三选一（merge/local-wins/cloud-wins）；**探测失败一律 blocked，绝不默认上传**（"不知道"≠"空"） | ✅ 已验证 | 三选一的不可逆部分已写入 `warning` |
| B8 | **UI 状态诚实化** | 菜单状态行是**写死的绿点 + "已登录"**；`lastSyncTime` 读的是从无 reducer 写过、永不渲染的字段；自动同步开关可在从未配置时打开 | 新增 `backendStatus.ts`（四态真实判据、机器字段优先于文案匹配、**先判"读失败"再判"未配置"**）；`HeaderDropdown` 每次打开强制重解析；`OptionsPage` 未就绪拒绝开启 | ✅ 已验证 | 无 |

### 2.3 工程与合规类

| # | 特性 | 主要改动 | 可行性 | 风险 |
|---|---|---|---|---|
| C1 | **安装时零网站访问权** | `manifest.json` `host_permissions` 清空（`https://*.supabase.co/*` → `[]`） | ✅ 已验证 | CSP 本就含 `connect-src https://*`，**净收紧效果有限**（运行时申请本就无法预先枚举） |
| C2 | **测试面重构** | 删 25 个 Supabase/pg 测试（−11423 行），新增 11 个（`fakeSyncBackend`、`syncNoResurrectConvergence`、`backgroundSyncLockedBackendOutcome`、`forceRemoteEmptyCloudGate`、`timeoutUpperBoundInvariant` 等），新增依赖 0 | ✅ 1133 例 0 skip | pg 用例曾**静默 skip**（"假防线"事故源），现在真实可跑 |
| C3 | **死代码防复活守卫** | `deadCodeGuards.test.ts` 从"断言 Supabase 门面存在"**反转为"断言它不回来"**，新增 2 条深路径 import 扫描 + `KEPT_ORPHANS` 双向孤儿登记 | ✅ 已验证 | 无 |
| C4 | **e2e 转 dufs + WebDAV** | 删 5 支 Supabase e2e，改造 5 支；新增 `startDufs/seedWebDav/prepareDavDist`；凭据需求归零（`REQUIRED_ENV = []`）；`findDeadLoginImports` 门禁防止"登记表说能跑、实际跑不了" | ⚠️ 仍需 GUI + 本机 `dufs` 二进制，**不进 CI** | 未在本机实跑（需 headed Chromium） |
| C5 | **文档与发布口径** | 22 份历史文档移入 `docs/archive/` + 归档说明；README/RELEASE-NOTES/CHROMEWEBSTORE/privacy 全面改写为 WebDAV-only | ✅ 已验证 | `.ai-logs/` 入库是新仓库约定 |
| C6 | **诊断与埋点能力下线** | 删 `diagnostics.ts`(770行)、`perfTrace.ts`(353)、`productEvents.ts`、`searchAnalytics.ts`、`performanceTest.ts` | ✅ 已验证 | **用户可感知损失**：诊断信息导出、问题反馈（自动附诊断摘要）两项入口消失；性能归因能力丧失 |

---

## 3. 兼容性评估

### 3.1 技术兼容性：优秀

- **零冲突**：fast-forward，`git merge-tree` 验证通过。
- **老用户本地数据不受影响**：`settings.syncBackend` 老值 `'supabase'` 由 `validateSyncBackend` 回落为 `'webdav'` 并出声、落盘归一，不会把老用户锁死。
- **依赖面收窄**：删 5 个依赖（含 `pg` 与 `@supabase/auth-js` override），新增 0；lockfile 与 package.json 一致性可验。
- **验证充分**：1133 单测 + tsc×2 + eslint×2 + 构建 + 体积门，全绿，且 **0 跳过**。

### 3.2 产品兼容性：这是唯一需要你拍板的实质问题

| 影响面 | 具体变化 |
|---|---|
| **数据可读性** | 云端托管的历史数据在新构建上不可读 —— 唯一不可逆的损失，需按 RELEASE-NOTES 的"先导出再升级"流程处理 |
| **使用门槛上升** | 登录即用 → 自备 WebDAV + 每次会话解锁 |
| **能力回退** | 诊断导出、问题反馈、性能归因、产品埋点全部下线 |
| **正面** | 安装零网站权限；状态显示真实；自动同步不再静默停摆；三类 P0 修复落地 |

---

## 4. 合并前必须处理的 3 件事

| # | 事项 | 严重度 | 说明 |
|---|---|---|---|
| 1 | **版本号未 bump** | 🔴 硬伤 | 两分支 `package.json` 与 `manifest.json` 均为 `1.24.1`，与 main 相同。这是一次 BREAKING 后端切换（`refactor(sync)!`），必须 bump（如 `1.25.0`）并在商店 changelog 写明"回退导出"段，否则商店无法识别为新版本 |
| 2 | **云端关停日期未定** | 🔴 产品/法律 | 历史数据不可读的窗口是开放的，需拍板关停日期并按 RELEASE-NOTES"3 处同文"替换（README / privacy.html / 商店文案） |
| 3 | **真机 e2e 与真实 WebDAV 端到端未跑** | 🟡 高 | 需 headed Chromium + 本机 `dufs`（`brew install dufs`）+ 真实坚果云凭据。建议至少验证：配置 → 测试连接 → 首次推送三选一 → 双设备删除不复活（B4/B5/B6 的真机 P0 修复链） |

---

## 5. 风险登记

| # | 风险 | 严重度 | 缓解 |
|---|---|---|---|
| 1 | 云端历史数据不可读 | 高 | 回退导出说明 + 关停日期拍板；属发布决策，已显式管理 |
| 2 | 真机 e2e / 真实 WebDAV 未实测 | 高 | §4 第 3 条；1133 单测 0 skip 兜底 |
| 3 | B2 校验规则删除属安全面改动 | 中 | 推导已留档、探针实测先红后绿；列为评审必审项 |
| 4 | 版本号未 bump 导致无法发版 | 中 | §4 第 1 条，合并前修 |
| 5 | 诊断/反馈能力下线是用户可感知损失 | 低 | 商店 changelog 如实告知；重新引入成本高，建议接受 |
| 6 | 能力损失若日后反悔需重建 | 低 | 能力已整体删除，回补需重写；若团队看重诊断能力，这是唯一值得单独讨论的点 |
| 7 | 单个 238 文件巨型提交难回溯 | 低 | 已成事实无法改；如需可 review 粒度，只能后续在 main 上追加修复提交 |

### 已排除的疑点（曾被怀疑，现已验证不成立）

- ❌ "广播期间新登记的删除意图被连坐清队"无覆盖 → **不成立**：`tests/pendingDeleteIntentDurability.test.ts`（用例 E 明确覆盖）在两分支均存在且**未改动**。
- ❌ "下载时全部标签 URL 被过滤的组会变成零标签空壳"无覆盖 → **不成立**：`tests/storableUnopenableUrls.test.ts:156` 有专门回归组，并写明该防线随 PostgREST 分页体系一同消失、改由"逐行判"承担。
- ❌ "`verify.yml` 残留过时 Supabase 注释" → **不成立**：全文件零 Supabase 命中。
- ❌ "认输预检列缺失降级守卫丢失" → 部分成立但可接受：`concededPrecheckDegrade.test.ts`(646行) 删除后由 `syncMergeSafety.ts:225` 的 `decideCloudTombstoneWrite` + `digestTombstoneProbe` 部分承接；"不能 select 不存在的列"这条结构守卫确实减弱，属 WebDAV 分片架构下的语义变化，非疏漏。
- ⚠️ "多分片往返完整性"缺直接单测 → 大体成立但风险低：`webdavAdapter.test.ts:637`（并发写不丢对端条目）与 `:733`（PUT 不返 ETag 时读回）覆盖了关键面；原 260 组规模走查无等量替代，属**测试广度下降而非正确性缺陷**。

---

## 6. 建议

**以 `slim/webdav-primary` 为准，快进 main。**

理由：
1. 它是 main 的直接后继，技术上零冲突、零成本。
2. 它不是"功能集合"而是**架构收敛**，改动点互相咬合（删云端牵动账户/UI/测试/权限/文档共 238 文件），**拆分挑选会产生不可编译的中间态**。
3. B1/B3/B4 修的是三类真实数据与可用性缺陷（自动同步静默停摆、空云端覆盖清空本机、测试连接必然失败），留在 main 等于这些修复永不落地。
4. 已实测全部门禁通过，质量可信。

执行方式：`git checkout main && git merge --ff-only slim/webdav-primary && git push origin main`。
**在此之前**先完成 §4 的三项，尤其是版本号 bump。

不建议的替代方案：
- ❌ 维持现状只用 main —— 白白丢弃已验证的 P0 修复。
- ❌ cherry-pick 部分文件 —— 会留下大量悬空 import，中间态不可编译。
- ❌ 重新引入云端 —— 与该分支的收敛方向相反，如需双后端应另起分支从 main 重新设计。
