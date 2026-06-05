# TabStack · AI 协作交接文档（活文档）

> **更新时间**：2026-06-05
> **维护者**：每次有结构性改动（尤其是同步层 / 存储层 / 状态层）后必须更新本文件
> **代码版本**：`package.json` / `manifest.json` 仍标 `1.11.8`，但工作区有一批未提交的 **v1.12.0** 改动（同步层重构 + Web Store 收尾），尚未 bump version

---

## 这份文档是什么 / 怎么用

项目里有两份认知文档，分工不同：

| 文档 | 定位 | 何时读 |
|---|---|---|
| `docs/PROJECT_OVERVIEW.md` | **完整基线**：8 维度全景（产品/架构/状态/功能/同步/UI/测试/历史），700+ 文件调研，生成于 2026-06-01 | 第一次接触项目、需要某个子系统的全貌时 |
| **`docs/AI_HANDOFF.md`（本文件）** | **当前快照 + 增量**：最近在干什么、哪些旧认知已失效、动手前的避坑指南 | **每次开工前先读这份**，再按需翻 OVERVIEW |

⚠️ **重要**：`PROJECT_OVERVIEW.md` 停在 v1.11.8，它对**同步架构**的描述（第 3.3、3.6、5.4 节）已被本文件第 4 节列出的改动**推翻**。两份冲突时，**以本文件为准**。

---

## 1. 30 秒速读

**TabStack** 是一款 Chrome MV3 扩展，把"几十个并行标签页"收进可命名、可搜索、可同步、可恢复的"工作会话"。

- **形态**：React 18 + TS + Redux Toolkit + Tailwind + Supabase。Popup 是 UI/状态中心，Service Worker 只管 chrome 事件（不再持有 store、不再做同步）。无 content script。
- **数据**：本地优先（IndexedDB），云端可选（Supabase，AES-GCM 客户端加密）。
- **当前阶段**：两条战线并行——(A) 修"刷新后偶发数据丢失"的根因，(B) 同步层 v1.12.0 大重构，(C) Chrome Web Store 上架收尾。**三者大部分改动尚未提交**（工作区 15 改 + 6 新文件）。

---

## 2. 最近在干什么（时间线）

最近一个月（5 月底起）项目从"能用"冲刺到"可上架 + 数据安全可信赖"。三条战线交织：

### 战线 A — 刷新后数据丢失修复（已提交 + 未提交两波）

**根因**（详见第 5 节）：popup 启动时把"瞬时空读"误固化成"已加载"，导致 `TabList` 永久不再重试，用户看到空界面但数据其实还在盘里。

| 日期 | Commit | 做了什么 | 状态 |
|---|---|---|---|
| 2026-06-02 | 66408db / 2786699 / b8e945a / f2e178a | `createStore(preloadedState)` 工厂化；导出 `initialTabState`/`initialSettingsState`；加 `lastLoadedAt`/`lastSyncStatus` 字段 | ✅ 已提交 |
| 2026-06-02 | 5fdd9c0 / 8088a16 / 2955d89 | 写下 spec + plan（见 `docs/superpowers/`） | ✅ 已提交 |
| 2026-06-03 | e6eaab6 | store proxy singleton + hydration 测试 | ✅ 已提交 |
| 2026-06-03 | 6e88ed6 | popup bootstrap 先 await 本地数据塞进 preloadedState 再 render | ✅ 已提交 |
| 2026-06-03 | 59350f9 | `TabList` 见 `lastLoadedAt` 非空就跳过 `loadGroups` | ✅ 已提交 |
| 2026-06-03 | adf8bd4 | **去掉 `setGroups` 的 500ms 防抖**——popup 关闭时会丢未落盘的数据 | ✅ 已提交 |
| 未提交 | — | 把 hydration 决策**提纯为纯函数** `utils/hydrationDecision.ts`（只有读到非空活跃组才固化 `lastLoadedAt`）；`storage.ts`/`indexedDbClient.ts` 改"空读不缓存、真错抛出" | 🚧 工作区 |

### 战线 B — 同步层 v1.12.0 重构（全部未提交）

把散落在 service-worker / smartSync / tabSyncWorkflow 三处、互相脱节的同步逻辑，**收敛到单一入口 `services/syncEngine.ts`**。详见第 4、6 节。

- 新增 `services/syncEngine.ts`：同步唯一入口（快照→下载→合并→验证→写入，失败回滚）
- `smartSyncService` / `syncService` / `autoSyncMiddleware` 全部改为**委托 syncEngine**
- `service-worker.ts` **删掉 129 行**：移除 30 分钟周期同步 / alarms / 重试逻辑（SW 不再碰同步）
- `supabase.ts` / `syncUtils.ts` 重构（合并与上传逻辑）
- 新增 `tests/syncMergeSafety.test.ts`：直接钉死 `mergeTabGroups` + `validateMergeResult` 两道纯函数防线

### 战线 C — Chrome Web Store 上架收尾（全部未提交）

| 改动 | 文件 | OVERVIEW 里的旧问题 |
|---|---|---|
| description 改**纯英文** | `manifest.json` | 原"中英混排"已修 |
| 打包脚本改**白名单模式**（显式声明哪些文件进 zip + 黑名单兜底剔除 `.htaccess`/源码目录） | `package-extension.js` | 原"dist 残留 .htaccess 与 src 源码目录"已修 |
| 开始准备商店截图 | `docs/store-screenshots/`（目前只有 1 张 `extensions-page.png`） | 原"截图缺失"——**仍未完成，还差至少 3 张** |

---

## 3. 当前工作区状态（动手前必看）

```
git status: 15 个文件 modified + 6 个未追踪
type-check: ✅ 通过（未提交的 v1.12.0 重构是健康的）
```

**未追踪新文件**：
- `src/services/syncEngine.ts` —— 同步新入口（战线 B 核心）
- `src/utils/hydrationDecision.ts` —— hydration 纯函数（战线 A）
- `tests/hydrationDecision.test.ts` / `tests/syncMergeSafety.test.ts` —— 对应测试
- `docs/store-screenshots/` —— 商店截图（战线 C）
- `.pnpm-store/` —— 包管理器缓存，**不该进 git**（建议加 `.gitignore`）

**判断**：这是一次**尚未收尾的大重构**。多文件互相依赖（syncEngine ← smartSync ← syncService ← autoSyncMiddleware），**应作为一个整体提交**，不要只 commit 其中几个文件，否则留下半截状态。

---

## 4. ⚠️ 已失效的旧认知（修正 PROJECT_OVERVIEW）

读 `PROJECT_OVERVIEW.md` 时，以下描述**已被 v1.12.0 推翻**，别照着改代码：

| OVERVIEW 说 | 实际现在 |
|---|---|
| 3.6 / 5.4：`chrome.alarms` 每 30 分钟周期同步，SW 内 `performPeriodicSync` 快照→合并→回滚 | ❌ **已全部删除**。service-worker 不再有任何同步逻辑/alarm。同步只在 popup 上下文发生 |
| 3.3：autoSyncMiddleware 有 5 档优先级（10/8/5/3/2），高 500ms / 低 2000ms 防抖 | 🔁 优先级表保留用于排序，但**实际只剩二档延迟**：priority≥8 → 1500ms，否则 3000ms；且调用的是 `syncEngine.scheduleUpload()` |
| 2.5 / 同步：`tabSyncWorkflow` 两段式 + `smartSyncService.uploadToCloud → uploadTabsToCloudFlow` | 🔁 真实路径改走 `syncEngine`。`tabSyncWorkflow` 仍存在但基本是死代码（见第 6 节死代码地图） |
| 7.5：manifest description 中英混排 | ✅ **已改纯英文** |
| 7.3 / 7.5：dist 残留 .htaccess 与 src 源码目录 | ✅ **已修**（package-extension.js 白名单模式） |
| README 第 70 行 / 同步模式：「定时同步：每 30 分钟后台自动同步一次」 | ❌ **该功能已移除**，README 这条已过时，需要改 |
| README 技术栈：拖拽用 `@dnd-kit` | ❌ 实际用 **react-dnd**（@dnd-kit 在 deps 里但未使用）。OVERVIEW 2.1 是对的，README 错 |

---

## 5. 刷新后数据丢失：根因与修复（战线 A 详解）

这是最近最重要的一次 bug 狩猎，**未来碰 popup 启动 / hydration / 存储读取时务必理解**。

### 链路

```
popup/index.tsx bootstrap()
  → await initStorage()
  → storage.getGroups()  ← 危险点：有多条"不抛异常但返回 []"的路径
  → 塞 preloadedState + 设 lastLoadedAt
createStore(preloadedState) → Provider mount
TabList useEffect:  if (lastLoadedAt) return  ← 见非空就永久跳过 loadGroups 重试
```

### 为什么会丢

`storage.getGroups()` 的"瞬时空读"会被当成"已加载"固化：
- `decryptLocalBlob` 解密失败 → 返回 null → getGroups 返回 `[]`
- IndexedDB 冷启动 `getItem` 出错 → 旧 driver 内部 catch 吞成 null → `[]`
- **放大器**：`cachedAsyncFn` 把这个 `[]` 缓存 30s，让重试也只拿到空

一旦 `lastLoadedAt` 被空读固化 → TabList 不再重试 → 用户看到 EmptyState，但 IndexedDB 里数据其实还在 → **表现为偶发、与刷新强相关**。

### 修复（4 处，分布在已提交 + 未提交）

1. **`utils/hydrationDecision.ts`（纯函数，新增）**：只有读到**非空活跃组**才 `treatAsLoaded=true` 并固化 `lastLoadedAt`/`lastSyncStatus='local'`；空读返回不固化，交给 TabList 走带 `isLoading` 状态的 `loadGroups`（能区分"加载中"与"真的空"，失败时显示可重试错误态）。
2. **`popup/index.tsx`**：bootstrap 接入决策纯函数；preloadedState 用 `{ ...initialTabState, ...tabsPreload }` **合并**（preloadedState 是整体替换 slice，不合并会把 `isLoading`/`error` 等变 `undefined`）。
3. **`storage.ts` getGroups**：解密失败改为**抛出**而非返回 `[]`，外层 catch 返回 `[]` 但**不写缓存** → 下次重试读盘；raw 为 null（真没数据）才缓存 `[]`。
4. **`indexedDbClient.ts` getItem**：去掉吞错的 try/catch，真实读失败抛出（键不存在仍正常返回 null——IndexedDB 语义区分二者）。

**回归保护**：`tests/hydrationDecision.test.ts`（纯函数，零依赖）。

---

## 6. 当前同步架构真相（战线 B 详解）

### 真实生产路径（v1.12.0）

```
                         ┌─────────────────────────────────────┐
  AuthProvider ──────────┤ smartSyncService.maybeAutoDownload() │
  (登录后自动下载)         └──────────────┬──────────────────────┘
                                         │
  SyncStatus/SyncButton                  ▼
  (手动) → syncService ──→ smartSyncService.{upload,download}FromCloud
                                         │
  autoSyncMiddleware                     ▼
  (data thunk fulfilled) ──────→  syncEngine.scheduleUpload(delayMs)
                                         │
                                         ▼
                         ┌───────────────────────────────────┐
                         │  services/syncEngine.ts （唯一入口）│
                         │  downloadAndMerge:                 │
                         │    快照→下载→mergeTabGroups→         │
                         │    validateMergeResult→写入         │
                         │    任一步失败 → restoreSnapshot 回滚 │
                         │  upload: 纯 upsert + 软删标记传播    │
                         └───────────────────────────────────┘
```

**数据安全建立在两道纯函数防线上**（`utils/syncUtils.ts`）：
- `mergeTabGroups(local, cloud, strategy)` —— **永不无故丢弃本地组**（即便 `remote` 策略也保留未删的本地组）
- `validateMergeResult(local, cloud, merged)` —— 本地非空却合并缩水/为空时判 `invalid` → 触发 `restoreSnapshot` 回滚

→ 这两个函数被 `tests/syncMergeSafety.test.ts` 钉死，**改同步前先跑这个测试**。

### 🪤 死代码地图（最容易踩的坑）

下面这一整条链**没有任何活跃入口在驱动**，但代码还在仓库里、还能编译、甚至最近还有人往里加保护逻辑：

```
syncHelpers.scheduleAutoSync()      ← grep 全仓：0 个外部调用者
  └→ dispatch(syncTabsToCloud / syncTabsFromCloud)   (tabSlice thunk)
       └→ uploadTabsToCloudFlow / downloadTabsFromCloudFlow   (tabSyncWorkflow.ts)
            └→ 里面精心写的"安全网 0/1/2"空数据保护 ← 全在没人走的路上
```

- `tabSlice.ts` 仍 import 并在 `syncTabsToCloud`/`syncTabsFromCloud` 里调 `tabSyncWorkflow` 的 flow 函数 → 看起来"活着"
- 但**唯一会 dispatch 这两个 thunk 的是 `syncHelpers.scheduleAutoSync`**，而 `scheduleAutoSync` **全仓库无人调用**（autoSyncMiddleware 早已改走 syncEngine）
- ⚠️ **当前未提交 diff 正在往 `downloadTabsFromCloudFlow` 加"安全网 0/1/2"**——这是在死路上写保护代码，白费功夫且误导后人

**结论**：
- 改同步逻辑 → **只改 `syncEngine.ts` + `syncUtils.ts`**，不要对着 `tabSyncWorkflow.ts` 改
- 强烈建议**删除整片死代码**（`syncHelpers.ts` + `tabSyncWorkflow.ts` + `tabSlice` 里的 `syncTabsToCloud`/`syncTabsFromCloud`/`syncLocalChangesToCloud` thunk），消除"两套并存"的认知负担。删之前确认 UI 没有任何按钮还在 dispatch 这些 thunk。

---

## 7. 给后续 AI 的避坑指南

1. **开工前先 `git status`**：工作区有一大批未提交改动，别在不知情的情况下覆盖。
2. **改同步 → 进 `syncEngine.ts`**，不是 `tabSyncWorkflow.ts`（死代码，见 §6）。
3. **改 popup 启动 / 存储读取 → 先读 §5**，理解"空读不能固化 lastLoadedAt"这条铁律，否则会复活"刷新丢数据"。
4. **`preloadedState` 必须 `{ ...initialState, ...partial }` 合并**，整体替换会把未覆盖字段变 undefined。
5. **测试基础设施有坑**：项目用 `node --test --experimental-strip-types` + 自定义 TS loader（`tests/_alias-loader.mjs`，用 shortCircuit）。**`mock.module` 与这个 loader 不兼容**——所以测试都写成"纯函数、零依赖"（hydrationDecision / syncMergeSafety / inputValidation 等）。别试图给带 IO 的模块写 module-mock 测试，会静默失败。
6. **`package.json` test 带 `--test-force-exit`**：因为某些测试 import `@/store` 会拉起带 timer 的模块导致进程不退出，这是已知基础设施问题，不是你的 bug。
7. **service-worker 不再做同步**：别在 SW 里加 alarm/周期同步，那套已被刻意删除。同步只在 popup 上下文。
8. **`store` 是 Proxy singleton**：`createStore(preloadedState)` 重建内部 `_store`，但必须在 React-Redux Provider mount **之前**调用，之后调会脱同步。

---

## 8. 下一步建议（决策导向）

### 先收尾，再开新功能

1. **把 v1.12.0 重构作为一个整体提交**（§3）：syncEngine + hydrationDecision + 两个 service + middleware + storage 修复 + 两个测试。type-check 已过，先 `pnpm validate` 跑全链再提。
2. **删除同步死代码**（§6）：syncHelpers + tabSyncWorkflow + tabSlice 三个死 thunk。这次重构正是删它的最佳时机——否则未提交 diff 里那些"白写的安全网"会永久误导后人。
3. **bump version → 1.12.0**：package.json + manifest.json + README 三处，`validate-extension.mjs` 会校验三处一致。

### Chrome Web Store 上架（战线 C 剩余）

4. **补齐商店截图**：目前只有 1 张，还差主弹窗 / Onboarding / 搜索 / 统计（1280×800 或 640×400）。
5. **修 README 过时内容**：删"30 分钟定时同步"、把"@dnd-kit"改成 react-dnd（§4）。
6. **品牌一致性**（OVERVIEW 9.1 仍未解决）：README/PRIVACY/design-system 目录/.env.example 仍叫 "TabVault Pro"，manifest 已是 TabStack。

### 中期质量债

7. **测试覆盖 < 5%**：syncEngine / smartSyncService 是数据安全核心，但只有纯函数层有测试。考虑给 syncEngine 的"验证失败→回滚"路径补集成测试（需解决 §7.5 的 mock 难题，或用依赖注入重构 syncEngine 让 storage/download 可替换）。
8. **无 CI/CD**：发布全靠本地 `pnpm package` 手动上传。加一个 `.github/workflows/ci.yml` 跑 `pnpm validate` 是高性价比投资。

---

## 附：关键文件速查

| 你想改… | 去这里 | 别碰 |
|---|---|---|
| 同步逻辑 | `services/syncEngine.ts` + `utils/syncUtils.ts` | `services/tabSyncWorkflow.ts`（死） |
| popup 启动/首屏 | `popup/index.tsx` + `utils/hydrationDecision.ts` | — |
| 本地存储读写 | `utils/storage.ts` → `storage/storageAdapter.ts` → `storage/indexedDbClient.ts` | — |
| 自动同步触发时机 | `store/middleware/autoSyncMiddleware.ts` | `utils/syncHelpers.ts`（死） |
| 加密 | `utils/encryptionUtils.ts`（云端）/ `utils/secureStorage.ts`（本地） | — |
| 状态 | `store/slices/{tab,settings,auth}Slice.ts` | tabSlice 里 3 个 sync thunk（死） |
| Supabase 读写 | `utils/supabase.ts` + `services/tabGroupSyncService.ts` | — |
| 浏览器事件/快捷键 | `service-worker.ts` + `background/TabManager.ts` | 别在这加同步 |

**完整全景** → `docs/PROJECT_OVERVIEW.md`（注意 §4 列出的已失效条目）
**本次修复的 spec/plan** → `docs/superpowers/specs/` + `docs/superpowers/plans/`
