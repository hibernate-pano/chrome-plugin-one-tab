# 分支差异深度分析：`slim/webdav-primary`（工作区）vs `main`

- 分析时间：2026-10-16
- 仓库：`/Users/panbo/Code/Demos/chrome-plugin-one-tab`
- 对比对象：**当前分支工作区**（staged + unstaged + untracked）vs `main` @ `a31cb5f`（tag `v1.24.1`）

---

## 0. 结论速览

1. **两分支不存在「提交级分叉」**：`main`、`origin/main`、当前分支 HEAD 全部指向同一提交 `a31cb5f`，双向独有提交均为 0。全部差异是**未提交的工作区改动**：236 个已暂存文件（+6 782 / −22 792）、13 个已暂存又再修改的文件（+332 / −44）、3 个未跟踪文件。
2. 改动是一次**「云端下线、WebDAV 转正」的整体重构**：删除 Supabase 客户端、账户体系、pg 依赖与 28 个迁移，同步引擎全面转向 WebDAV-only，并顺带完成多项 P0/P1 修复与「状态诚实化」改造。
3. **本机全部门禁实测通过**（详见 §5）：类型检查 ×2、lint ×2、单元测试 1 133 例 0 失败 0 跳过、构建、首屏体积门（147.3KB/240KB）、锁文件一致性、元数据校验。
4. **处理建议：不存在需要仲裁的分叉，实际决策是「是否将这批改动提交并合入 main」**。建议**提交到当前分支后 fast-forward `main`**（或等价地在 main 上提交），**不建议 `git merge`/`rebase` 语义操作**（两边同点，无对象可合）；**不建议选择性 cherry-pick 部分改动**（各改动点高度耦合，拆开后中间态不可编译）。提交时注意三件事：①两个未跟踪测试文件必须一并提交（源码注释引用了它们，见 §4.3）；②`outputs/realtime-whiteboard.html` 与本项目无关，应排除；③建议按 §4.2 拆成原子提交，别打成一坨 236 文件的提交。
5. 主要残余风险：真机 e2e（需 GUI）尚未跑；老用户托管在 Supabase 的历史数据在新构建上不可读（已如实文档化，属发布决策而非代码缺陷）。

---

## 1. 分支与差异构成

### 1.1 提交面

| 项 | 值 |
|---|---|
| `main` | `a31cb5f`（tag v1.24.1，= origin/main） |
| `slim/webdav-primary`（HEAD） | `a31cb5f`，同一提交 |
| main 独有提交 | 0 |
| 当前分支独有提交 | 0 |

两边最近 30+ 个提交都是共享的（v1.23.1 → … → v1.24.1 的 WebDAV 阶段 0–3 落地、真机实测修复、发版等）。

### 1.2 工作区改动构成（vs HEAD）

| 类别 | 数量 | 说明 |
|---|---|---|
| 已暂存（A/M/R/D） | 236 文件，+6 782 / −22 792 | 主体改动 |
| 已暂存再修改（unstaged） | 13 文件，+332 / −44 | 对暂存版的二审修订（如 `src/background/backgroundSync.ts`、`src/components/sync/WebDavSettings.tsx`） |
| 未跟踪 | 3 文件 | `tests/syncNoResurrectConvergence.test.ts`、`tests/timeoutUpperBoundInvariant.test.ts`（**源码注释引用，必须入库**）、`outputs/realtime-whiteboard.html`（**无关原型，应排除**） |

按目录：

- `src/`：删 29 个文件（`utils/supabase/*` 12、`authSlice/authGuard/AuthProvider/AuthModal/LoginForm/RegisterForm/authCache` 等账户线 8、`diagnostics/perfTrace/performanceTest/productEvents/encryptionUtils/exportStamp/stringStore/supabaseAdapter` 等 9），改约 45 个，新增 3 个（`sync-backend/lockedBackendError.ts`、`components/layout/backendStatus.ts`、`sync-backend/webdav/firstSyncDecision.ts`）。
- `supabase/`：整目录删除（28 个迁移 + `manual/migration_drift_check.sql`）。
- `scripts/`：删 8 个（supabase-migrate/smoke-test、anon-rls-probe、4 个 supabase e2e），`webdav-capability-matrix.mjs` 移入 `scripts/archive/`，e2e 基架改造成 dufs+WebDAV。
- `tests/`：删 24 个（supabase/pg 相关），新增 12 个（含 3 个未跟踪），重写约 20 个（supabase 替身 → `fakeSyncBackend`）。
- 文档：`docs/` 22 份历史文档移入 `docs/archive/` 并加归档说明；`RELEASE-NOTES.md` 新增「WebDAV-only 仓库变更」大节；README / CHROMEWEBSTORE / privacy.html 全面改写；`.ai-logs/` 5 份新入库。
- 配置：`manifest.json`（host_permissions 清空）、`package.json`/`pnpm-lock.yaml`（去 @supabase/supabase-js、pg、@types/pg）、`.env.example`、`.gitignore`、`vite.config.ts`（去 supabase-vendor chunk）、`verify.yml`（去 Postgres 段）。

---

## 2. 改动点逐条分析

> 五维简写：功能 / 质量 / 性能 / 风险 / 兼容。每条末尾给「处置」结论。

### A. Supabase 后端整体删除

- **内容**：删 `src/utils/supabase/*`（auth/client/download/idBatches/ports/probe/readback/session/sync/syncWatermark/upload）、`src/utils/supabaseFacade.ts`、`src/sync-backend/supabaseAdapter.ts`、`supabase/`（28 迁移 + manual）、`scripts/supabase-migrate.mjs`、`scripts/supabase-smoke-test.mjs`、`scripts/anon-rls-probe.mjs`、依赖 `@supabase/supabase-js`/`pg`/`@types/pg` 与 pnpm override `@supabase/auth-js`（`package.json`、`pnpm-lock.yaml` −234 行，冻结锁文件校验通过）；CI 删除 Postgres 安装与二进制校验段（`verify.yml`）。
- **功能**：云端同步从「功能」变为「不存在」。附带收益：安装权限面干净化（见 I）。**老用户托管数据在新构建不可读**（RELEASE-NOTES 如实记录，商店 1.24.1 仍是账户版可回退导出）。
- **质量**：极高（−22.8k 行的主要构成），且 `tests/deadCodeGuards.test.ts` 用文件系统断言钉住「不得复活」。
- **性能**：首屏体积预算 147.3KB/240KB，比 HEAD 更宽裕（supabase-vendor chunk 消失）。
- **风险**：删除面大，但 tsc/lint/1 133 测试兜底；`supabase/.temp/` 从 .gitignore 移除（本地若再跑 supabase CLI 会出现未跟踪文件，小点）。
- **兼容**：`UserSettings.syncBackend` 老值 `'supabase'` 由 `validateSyncBackend`（`src/utils/storage.ts:184`）回落 `'webdav'` 并出声、落盘归一（:488），不会把老用户锁死。
- **处置**：**合入**。这是分支立项目的。

### B. 账户体系删除

- **内容**：删 `authSlice.ts`（252 行）、`core/authGuard.ts`、`AuthProvider.tsx`、`auth/AuthModal.tsx`、`LoginForm.tsx`、`RegisterForm.tsx`、`utils/authCache.ts`、`InlineNotice.tsx`、`types/tab.ts` 的 User/AuthState/RootState、`syncEngine.ts` 的 `ensureAuthenticated` 门禁与 `restoreAuth`、`backgroundSync.ts` 的 `getCurrentUser/setFromCache` 恢复段。
- **功能**：扩展变为纯本地 + 自备云盘，无登录入口。UI 契约随动：`runBackgroundSyncOnce` 的布尔语义从「让路 true / 未登录 false」改为「让路 true / 真故障 false」，`BackgroundSyncOutcomeKind` 删除 `not_logged_in` 成员（零生产者分支不留）。
- **质量**：高。删得很干净——`src/` 已无 supabase 代码引用（仅剩留痕注释）。
- **风险**：所有「登录后才同步」的产品假设被移除；popup 自动下载入口随账户弹窗消失（`backgroundSync.ts` 注释如实说明）。
- **兼容**：升级用户本机数据不动，只是登录入口消失。
- **处置**：**合入**。与 A 同批，不可拆（拆出中间态大量 import 悬空）。

### C. 后端解析收窄为 WebDAV 单后端

- **内容**：`SyncBackendId` 收窄为 `'webdav'`（`src/sync-backend/ports.ts`）；`resolveBackendOutcome()` 重写（`src/sync-backend/index.ts`），5 个「回落 Supabase」分支全部消失；删除 `readConfiguredBackendId()`；`getActiveSyncBackend()` 未预解析时返回锁定占位（fail-closed）而非 Supabase（fail-safe）；`primeSyncBackend()` 的 catch 补 `lockedReason/lockedKind`。
- **功能**：fail-closed 语义彻底化——「没配/没解锁/读不到」都中止本轮并给可行动文案，绝不静默去别的后端。
- **质量**：高。每个失败分支按起因分级出声（logError/logWarn），注释把「为什么不能机械替换回落分支」写透了。
- **风险**：锁定占位是**唯一**失败终态后，`fallbackReason` 字段恒 undefined（保留仅为不改读取方，轻微死字段）。
- **兼容**：`service-worker.ts` 里「回落出声」分支随之删除（静态不可达），`tabGroupSyncService.ts` 接缝不动。
- **处置**：**合入**。

### D. 锁定态机器分类 + 后台让路 + UI 诚实化（Wave 2A/2B）

- **内容**：新 `src/sync-backend/lockedBackendError.ts`（`LockedBackendError` + `isLockedBackendError`）；`ResolutionOutcome.lockedKind: 'unconfigured'|'locked'|'error'`；`syncEngine.ts` 的 `MergeResult/UploadResult` 新增 `locked` 机器标记（与人话 `reason` 分开，注释论证充分）；`backgroundSync.ts`：锁定时 `{ok:true, kind:'yielded', locked:true}`——**不进退避、不清 alarm、按用户档位重排**，新增 `notifyLockedBackendOnce()` 一次性通知（先发后置标志，create 失败不置位）；新 `src/components/layout/backendStatus.ts`（`classifyBackendResolution` 机器字段优先、文案正则兜底、未知一律 error）；`HeaderDropdown` 每次打开菜单强制重解析展示真实状态；`OptionsPage` 自动同步开关开启前真实解析，未就绪**拒绝开启**并给分类原因（`AUTO_SYNC_BLOCKED_TOAST`）。
- **功能**：把「每 10 分钟后台同步一次」的虚假承诺变成真实可执行状态；未解锁用户被可见提醒触达一次而非每 10 分钟一条。
- **质量**：很高。文案与机器码分离、按 severity 分级、连点竞态用 ref 关（`WebDavSettings` 的 `pushInFlightRef`）、通知 API 不可用不置标志——这些都是「上次修复留痕」的纪律延续。
- **性能**：无负面（每次解析只读本地存储，不碰网络；适配器构造缓存，不重跑 PBKDF2）。
- **风险**：布尔返回值不再能区分「在途让路」与「未配置让路」（注释已声明，判别力转移到 `tests/syncBusyGate.test.ts` 结构断言 + 新 `tests/backgroundSyncLockedBackendOutcome.test.ts`）。
- **兼容**：依赖 manifest `notifications` 权限（**已存在**）。
- **处置**：**合入**。本批质量最高的改动之一。

### E. WebDAV 传输层加固

- **内容**：`WebDavClient` 新增 `AbortController` 请求级超时 `DEFAULT_REQUEST_TIMEOUT_MS=45_000` 与 `WebDavRequestTimeoutError`（`src/sync-backend/webdav/client.ts`），timer 在 finally 清理；`get()`/`propfind` 把 **409 与 404 同归 notFound**（`NotFoundReason` 区分来源，仅限 `get()` 调用点，MKCOL/PUT 的 409 语义不变）；修 `fetch` receiver 未摘导致 `Illegal invocation` 的真机 P0（`const doFetch = this.fetchImpl`）；`adapter.ensureRootDir()` 读前 `mkdirp` 预建根目录。未暂存修订另加 `isTimeout` 与构造参数 `opts.timeoutMs`。
- **功能**：挂死服务器不再钉死单写者队列；首次配置不再因 409 全链挂死（测试连接 + 首同步）。
- **质量**：高，且「为什么 45s」「为什么不读写分档」「测试注入毫秒级」都有论证。
- **风险**：45s 上界与 popup 30s 上界的不变量改由未跟踪的 `tests/timeoutUpperBoundInvariant.test.ts` 钉住——**该文件必须入库**（`mutationProtocol.ts:66` 注释引用它）。
- **兼容**：`init.timeoutMs` 旋钮保留；旧调用点零改动。
- **处置**：**合入**（连带入库未跟踪测试，见 §4.3）。

### F. 合并 / 覆盖安全语义调整

- **内容**：`src/core/syncDecision.ts` 删除 `validateMergeResult` 的「规则 2」（本地活跃>0 且合并后为空 ⇒ 判异常）——论证：whole-group LWW 下该规则只命中「对端全删、本机应收敛」这一合法场景，把合法删除传播当故障拦，造成永不收敛的僵尸副本；替代防线是新增 `decideForceRemoteOverwrite()` 空云端闸门（本地活跃>0 且云端一行都没有 ⇒ refuse，`reason: 'overwrite_empty_cloud_refused'`），在 `syncEngine.downloadAndMerge` 中「本地置空之前」执行；`SyncButton` 新增该机器码的用户文案映射。
- **功能**：修掉「本地仅存会话永远收不到对端删除」与「覆盖下载用空云端清空本机」两类问题。
- **质量**：罕见地高——删除一条规则时把推导、实测后果（`tests/syncNoResurrectConvergence.test.ts` 探针先红后绿）、「为什么不能凭直觉加回来」全部留档。
- **风险**：这是**安全面**改动：防线的净数量没减（规则 2 的位置由两处新防线分别覆盖），但评审者必须自己复核这段推导再放行。
- **兼容**：`reason` 机器码新增一个枚举值，UI/测试读取点已同步。
- **处置**：**合入，但列为合并评审必审项**。

### G. 首次推送归属决策（远端已有数据三选一）

- **内容**：新 `src/sync-backend/webdav/firstSyncDecision.ts`（纯函数决策 + `OwnershipPreview` 后果预览 + `projectedCloudCount`）；`WebDavSettings.tsx` 的首次推送流程（probe → upload-all / ask-user / nothing-to-do / blocked，探测失败一律 blocked 绝不默认上传）；文案与真实执行对齐（upsert 而非替换、「以云端为准」是先上传再下载）；未暂存修订加 `pushInFlightRef` 防连点双发与 `isFirstPushBusy()`。
- **功能**：填上「配完 WebDAV 数据永远出不了本机」的坑（原实现被「保存动作碰巧触发上传」掩盖）。
- **质量**：高——决策表单测化、后果计数用 `mergeOpStamped` 单一算法、`compareStampsLoose` 与适配器认输预检同口径。
- **风险**：三选一的不可逆部分（同 id 旧版本被覆盖）如实写入 `warning`；提示依赖 UI 渲染，无 DOM 测试环境覆盖渲染层（仓库现状，非本改动引入）。
- **处置**：**合入**。

### H. 测试面重构

- **内容**：删 24 个 supabase/pg 测试（含 `opStampGuard.pg.test.ts`、`migrationReplay.pg.test.ts` 等真库集成测试，同步删 CI Postgres 段）；新增 12 个：`backendFailureLogSeverity`、`backgroundSyncLockedBackendOutcome`、`forceRemoteEmptyCloudGate`、`storageSyncBackendReadPath`、`syncStatusHonesty`、`syncUploadDeleteBroadcast`、`webdavFirstSyncDecision` + 未跟踪的 `syncNoResurrectConvergence`、`timeoutUpperBoundInvariant` + 助手 `fakeSyncBackend.ts`/`engineStorageEnv.ts`；约 20 个重写（supabase 替身 → fake backend）；`tests/deadCodeGuards.test.ts` 扩展「零生产调用方模块登记制」（concurrency/lockedBackendError 等保留均有据）；e2e：4 支 supabase 往返脚本删除、4 支改 `seedWebDav()`（本机 dufs）、`prepareDavDist()` 提升回环 host 权限（仅测试构建）、登记表门禁 `findDeadLoginImports` 防「写了跑不了」。
- **功能**：测试全部离线可跑，**0 skip**（旧 suite 里 pg 用例会静默 skip，曾是「假防线」事故源）。
- **质量**：1133 例全绿；新增用例几乎全部针对本批修复（先红后绿）。
- **风险**：删掉的测试中不少钉的是「跨设备语义」而非 supabase 本身（如 `syncNoResurrectInvariants`/`syncUploadDownloadSafety`），其不变式是否被新用例完全接住，需评审确认——实际上新 `syncUploadDeleteBroadcast`/`syncNoResurrectConvergence` 等正是接棒者，且 `docs/archive` 保留了迁移矩阵说明。
- **兼容**：`tsconfig.test.json` 无需改（tsc tests 0 错误）。
- **处置**：**合入，连带 §4.3 的两个未跟踪文件**。

### I. 权限 / 清单 / CSP

- **内容**：`manifest.json` host_permissions 清空（WebDAV 走 optional_host_permissions 运行时申请）；CSP `connect-src` 删去 `https://*.supabase.co`——但原 CSP 本就含 `https://*`，**净效果为零**；`.env.example` 清理 Supabase 段；`.gitignore` 去 `dist-web/`、`supabase/.temp/`；`vite.config.ts` 去 supabase-vendor chunk；CHROMEWEBSTORE.md 数据使用表改写（鉴权信息「不收集」）。
- **功能**：安装时零网站访问权——对商店审核与用户信任都是实质改善。
- **风险**：`connect-src https://*` 仍在（运行时申请本就无法预先枚举主机，属既有设计）；评审时应意识到 CSP 并未因这次删除而收紧。
- **处置**：**合入**。

### J. 文档与发布口径

- **内容**：22 份历史文档移 `docs/archive/` + 归档 README（「请勿按本目录文档实现功能」）；`RELEASE-NOTES.md` 新增「WebDAV-only 仓库变更」大节（事实基线、回退导出三步走、关停日期后需同步的 3 处、上架 checklist）；README 重写「当前同步模式」+「先导出再升级」警告；`privacy.html` §2/§3/§4 拆分历史托管数据口径；`docsAlignment.test.ts` 已适配归档路径；`.ai-logs/` 5 份修复过程记录入库（新约定）；promo-site / outputs/tapstack-promo 文案微调。
- **质量**：很高——「三处同文 find-and-replace」「关停日期未定」这类跨文档一致性都显式管理了。
- **风险**：`.ai-logs/` 入库是新的仓库约定，提交前应确认团队接受（它会让每次 AI 辅助修复的过程记录进版本史）。
- **处置**：**合入**（`.ai-logs` 若团队有顾虑可单独一提交，便于日后按目录治理）。

### K. 观测/埋点代码顺手清理

- **内容**：删 `diagnostics.ts`（770 行）、`perfTrace.ts`、`performanceTest.ts`、`productEvents.ts`、`searchAnalytics.ts`、`exportStamp.ts`、`encryptionUtils.ts`、`stringStore.ts`；`mutationQueue`/`mutationHandlers` 去 perfTrace 计时包装；`PERF_FLUSH` 消息分支删除。
- **质量**：清理彻底（含测试：`diagnostics.test.ts`、`perfTrace.test.ts`、`perfDiagnostics.test.ts` 同删）。
- **风险**：诊断导出 / 产品埋点能力从产品中消失——对 v1 收敛是合理取舍（下线排查 React 级别性能归因），但属于**能力损失**，应在发布说明中让人知道。
- **处置**：**合入**（如团队想保留诊断能力，这是唯一值得单独的「挑出来讨论」的点，但重新引入成本高，建议接受删除）。

---

## 3. 各改动点冲突预判

当前 main 无分叉，**当下零冲突**。若合入前 main 出现新提交（例如线上 hotfix），冲突将集中在：

| 高冲突文件 | 原因 |
|---|---|
| `src/services/syncEngine.ts`、`src/background/backgroundSync.ts`、`src/sync-backend/index.ts` | 同步主线双方都最可能改 |
| `manifest.json`、`package.json`、`pnpm-lock.yaml` | 权限/依赖面 |
| `README.md`、`docs/RELEASE-NOTES.md`、`CHROMEWEBSTORE.md` | 发布口径 |
| `tests/*`（约 20 个重写文件） | 替身基座更换，文本冲突多但机械 |

策略：冲突高发于这些文件，但因为本改动是「整体转换」而非「平行修改」，解冲突时应**以本分支为准**，勿把 hotfix 的老逻辑并回（例如 hotfix 若动了 upload 的登录门禁，已无意义）。

---

## 4. 处理建议

### 4.1 总体：不使用 merge/rebase，直接提交并 fast-forward

- 两边同点，`git merge` 是 no-op、`rebase` 无对象——真正决策是「把这 236+13+3 个文件的改动作为一个/一组提交落到 main」。
- **不建议 cherry-pick 部分改动**：A–G 互相咬合（账户删除牵动 29 文件、锁定期分类牵动引擎/后台/UI/测试），任何子集都会留下不可编译或语义半吊的中间态。
- **不建议「保留某一分支」**：main 落后于工作区一个完整迭代，保留 main 现状 = 这批修复不上线。

### 4.2 提交拆分建议（可 review 性的关键）

按主题拆 6–8 个原子提交，每个独立可构建：

1. `refactor(sync)`：删除 Supabase 后端与 pg 依赖（A）+ manifest/CI/构建配置（I）
2. `refactor(auth)`：删除账户体系（B）+ settings.syncBackend 收窄与老值回落（C）
3. `feat(sync)`：锁定态机器分类与 fail-closed（C 余项 + D）
4. `fix(webdav)`：传输层加固（E，含未跟踪的 timeoutUpperBoundInvariant 测试）
5. `fix(sync)`：合并/覆盖安全语义（F，含未跟踪的 noResurrectConvergence 测试）
6. `feat(sync)`：首次推送归属决策（G）
7. `test`：测试面重构（H）
8. `docs`：归档 + 发布口径（J）+ `.ai-logs`（可单独提交）

### 4.3 提交前必须处理的三件事

1. **入库两个未跟踪测试文件**：`tests/syncNoResurrectConvergence.test.ts`、`tests/timeoutUpperBoundInvariant.test.ts`——`src/core/syncDecision.ts:264`、`src/core/mutationProtocol.ts:66`、`tests/syncMergeSafety.test.ts:75` 的注释已引用它们；不提交 = 注释悬空 + 两条不变量无测试（正是本仓库纪律定义的「假防线」）。
2. **排除 `outputs/realtime-whiteboard.html`**：FlowBoard 实时白板原型，与 TapStack 无关，别混进本次提交。
3. **确认 `.ai-logs/` 入库是团队共识**（新目录约定）。

### 4.4 合并后验证步骤

已在本机实测通过（2026-10-16）：
- `node scripts/validate-extension.mjs` ✅（元数据 1.24.1 三处对齐）
- `tsc --noEmit` ✅ / `tsc -p tsconfig.test.json --noEmit` ✅
- `eslint src` ✅（0 warnings）/ `eslint tests` ✅
- `node --test`：**1 133 例 0 失败 0 跳过** ✅
- `vite build` ✅ / `report-bundle-size.mjs`：147.3KB ≤ 240KB ✅
- `pnpm install --frozen-lockfile` ✅（锁文件与 package.json 一致）

提交后仍需（本机跑不了的）：
1. **真机 e2e**：`pnpm build && pnpm e2e`（需 GUI；含 WebDAV 三支 dufs 真机脚本；`prepareDavDist` 只改测试构建的权限声明，不影响业务代码）。
2. **坚果云真机端到端**：配置 → 测试连接 → 首次推送三选一 → 双设备删除不复活（真机 P0 修复链）。
3. **升级路径**：老版本本地数据 + 新构建首启（确认 migration 与设置回落 `validateSyncBackend` 行为）。
4. **上架前 checklist**（RELEASE-NOTES 已列）：定版本号 → `pnpm package` → 提审 → 商店 changelog 带「回退导出」段；关停日期拍板后按「3 处同文」替换。
5. CI：`verify.yml` 已删 Postgres 段，注意 CI 时长与 pg 相关的守卫测试已随文件删除，不要再按旧 CI 预期排查。

---

## 5. 风险登记（按优先级）

| # | 风险 | 严重度 | 缓解 |
|---|---|---|---|
| 1 | 老用户托管在 Supabase 的历史数据新构建不可读；关停日期未定 | 高（产品/法律） | RELEASE-NOTES/README/privacy 三处同文 + 回退导出说明；属发布决策，已显式管理 |
| 2 | 真机 e2e 与坚果云实测未跑（需 GUI/凭据） | 高 | §4.4 验证清单；单测 1133 绿 + 0 skip 兜底 |
| 3 | 删除 −22.8k 行中少数被删测试的不变式接棒不完全 | 中 | H 条列出的接棒映射；评审时逐条核对 |
| 4 | `validateMergeResult` 规则 2 删除属安全面改动 | 中 | 论证留档 + 新测试钉住；列为必审项 |
| 5 | `.ai-logs/` 入库新约定、诊断/埋点能力损失（K） | 低 | 单独提交便于治理；发布说明如实告知 |
| 6 | `fallbackReason` 恒 undefined 残留字段、`.gitignore` 去 supabase/.temp | 低 | 轻微，可后续清理 |
