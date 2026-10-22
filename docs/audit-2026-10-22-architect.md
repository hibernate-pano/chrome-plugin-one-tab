# 架构审计（2026-10-22）—— 模块边界 / 死代码 / 语义分叉 / 状态所有权

**审计范围**：`src` **199** 个源文件 / **46,630** 行（写入本文时复核；审计开始时为 195 / 46,154 ——
差异来自并行 lane 新增文件，见文末第 9 节）。
**性质**：只读审计。审计期间**未修改任何源码**。
**行号口径**：全部行号在写入时对照**当前工作区**复核过一遍（审计期间有并行 lane 在改
`src/components/**`，见文末「审计期间的仓库变动」）。

**收录标准**（严）：
- 每条都必须能回答「**改了会出 bug**」或「**改起来会漏**」；
- 不收「重构更优雅」「命名不好」「应该分层」这类无后果的偏好项；
- 每条带 `文件:行号`；
- 每条给出**最小改法**或**明确的危险动作清单**。

---

## 0. 门禁实测（本机真实执行，非引用文档）

| 命令 | 结果 |
|---|---|
| `pnpm build` | exit 0 |
| `pnpm check:bundle` | 251.2KB gzip / 预算 260KB，通过 |
| `pnpm test`（`env -u NODE_OPTIONS`） | **2939 pass / 0 fail / 0 skipped**，750 suites，28.9s |
| `pnpm lint` | 0 error（`eslint src -f json` 报 195 文件，全在 `src/` 下，无 `dist/`） |
| `pnpm lint:tests` | 0 error |
| `node scripts/prod-stress.mjs` | 3 场景跑通 |
| 依赖图扫描（自建，Tarjan SCC） | 审计开始时 195 模块，**循环依赖 0 个** |

---

## 1. 状态所有权混乱

### A1 ★★★ 打开页面就无条件把本地库标成「有待上传」

**位置**
- `src/store/middleware/autoSyncMiddleware.ts:12`
  ```js
  if (typeof a.type === 'string' && !a.error && a.type.startsWith('settings/')) {
      void sendSyncCommand('scheduleUpload', { delayMs: 3000 });
  }
  ```
- 两个 `loadSettings` 派发点：`src/components/app/MainApp.tsx:27`、`src/contexts/ThemeContext.tsx:57`

**为什么是 bug 而不是偏好**
判据 `startsWith('settings/')` 把**读**设置的 `settings/loadSettings/pending` 与
`settings/loadSettings/fulfilled` 也算成「设置变了」。两个派发点 × 2 个 action = 4 条
`SYNC{op:'scheduleUpload'}` 消息。

**实测**（Playwright，干净 profile，用户零操作，只打开一次管理页）：
```
【打开 popup 后】 {"pending_upload":true,"last_upload_time":null}
```
`pending_upload` 被置真、`last_upload_time` 仍是 `null`（从没同步过）。
`src/services/syncEngine.ts:332` 的 `scheduleUpload` **无条件** `setPendingUpload(true)`。

**「改起来会漏」的地方**
上传触发次数**等于 `loadSettings` 派发点数量 × 2**。谁把 `MainApp` 的
`dispatch(loadSettings())` 挪到别处、或给 `ThemeContext` 再加一次派发，触发次数就变，
**但没有任何测试断言这个次数**。修的时候必须**同时**把判据改成白名单
（`settings/saveSettings/fulfilled` 之类），只改派发点会把「4 次上传」变成「2 次」——
问题从「每次开页都上传」退化成「仍然每次开页都上传」，看起来像修好了。

**最小改法**：`autoSyncMiddleware.ts:12` 的判据换成**写盘类** settings action 的白名单。

---

### A2 ★★☆ SW realm 没有跨上下文的缓存失效通道（今天不可达，但是个哑雷）

**位置**
- `src/storage-kv/groupsChangedBus.ts:83` — `ensureRuntimeListener()` **只在**
  `subscribeGroupsChanged()` 时才注册 `chrome.runtime.onMessage` 监听
- `src/utils/storage.ts:101` — `onGroupsChanged()` 是唯一的订阅入口
- `src/components/tabs/TabList.tsx:242` — **全仓唯一的订阅者**（在 popup realm）

⇒ **Service Worker realm 从不注册 `TABSTACK_GROUPS_CHANGED` 监听**
⇒ SW 自己的 30s `groups` 缓存没有任何跨上下文失效路径。

**今天为什么没出事**
生产上 groups 的唯一写者是 SW（`src/utils/storage.ts:511` 的 `setGroupsImmediate`），
SW 写完会 `cache.set('groups', …)` 刷新自己的缓存；popup realm 已不再整表写 groups。

**「改起来会漏」的地方**
这正是 `src/utils/storage.ts:551-554` 那段注释描述过的历史事故（「popup 与 SW 各持一份
30s 缓存」）。现在只剩 SW 一侧有缓存、却只有 popup 一侧有失效通道。**任何新增的
groups 写入上下文**（options 页导入、第二个 SW 实例、web 版）都会让 SW 拿着 30s 旧快照
去做上传，而**改写入路径的人不会收到任何提示**——上传代码看起来完全正常。

**最小改法**：`src/service-worker.ts` 顶层加一行 `onGroupsChanged(() => {})`
（订阅即失效缓存，语义由 `src/utils/storage.ts:102-107` 自动提供）。

---

### A3 ★★☆ `ensureVersion()` 在 35 个调用点各做一次无缓存的 IndexedDB 读

**位置**：`src/utils/storage.ts:413`

```ts
private async ensureVersion() {
  const version = await kvGet<number>(STORAGE_KEYS.VERSION);
  if (version === STORAGE_VERSION) return;
  await kvSet(STORAGE_KEYS.VERSION, STORAGE_VERSION);
}
```
`this.ensureVersion()` 在 `src/utils/storage.ts` 内被调用 **35 次**（:429, :467, :515, :599,
:728, :791, :823, :834, :886, :918, :957, :968, :988, :1002, :1043, :1054, :1094, :1115,
:1122, :1166, :1196, :1221, :1254, :1402, :1408, …），每次都是一次真读。

**实测**：一次打开管理页 = **31 次 IndexedDB `get()`**（popup realm 16 + SW realm 15），
其中 `storage_version` 被读 **14 次**。

**「改起来会漏」的地方**：`ensureVersion` 写在**每个** storage 读方法的第一行，
所以**任何人在 `storage.ts` 里新增一个读方法，就自动多一次 IDB 读**。
这不是某个人的疏忽，是结构决定的。

**最小改法**：给 `ensureVersion` 加一个模块级 `versionEnsured` 布尔
（`STORAGE_VERSION` 是编译期常量，进程内只需保证写过一次）。**一行，砍掉 14 次读。**

---

### A4 ★★☆ 同一件事有三种读法、且「哪个是对的」取决于你抄了哪一行

**位置**：`src/utils/storage.ts:427`（`getGroups`）/ `:535`（`getGroupsFresh`）/ `:573`（`getGroupsForWrite`）

- `getGroups()` = 30s 进程内缓存读
- `getGroupsFresh()` = `invalidateGroupsCache()` + `getGroups()`
- `getGroupsForWrite()` = `flush()` + `invalidateGroupsCache()` + `getGroups()`

⇒ **`getGroupsFresh()` ≡ `getGroupsForWrite()` 减去一次 flush。**

**流通中的三种拼法**（同一仓库，同一语义）：
| 调用点 | 拼法 |
|---|---|
| `src/services/syncEngine.ts:618` | `storage.getGroupsFresh()` |
| `src/services/syncEngine.ts:1087-1088` | `invalidateGroupsCache(); storage.getGroups()` |
| `src/components/sync/WebDavSettings.tsx:826` | `storage.getGroupsForWrite()` |

**「改起来会漏」的地方**
`src/utils/storage.ts:541-571` 的注释花了 30 行论证「读-改-写**必须**用
`getGroupsForWrite()`」，而同一文件里还留着语义几乎相同的 `getGroupsFresh()`。
新人抄注释会选对，抄调用点会抄到三个里的任意一个 —— **其中 `getGroupsFresh` 少一次 flush，
在「本进程有 pending 防抖写」的场景下会读到不含 pending 写的旧快照**。

**最小改法**：删掉 `getGroupsFresh()`，全部改用 `getGroupsForWrite()`。
它只有 1 个生产调用点（`syncEngine.ts:618`），迁移风险极低。

---

### A5 ★★☆ 注释承诺「不做 memo」，实现却走了 30s 内存缓存

**位置**
- `src/utils/seqRegistry.ts:15-17`
  > 不做 memo：下载合并在 SW 存活期间会把云端（可能远大于本设备）的印记写进 storage，
  > 缓存住的旧基线会让本设备继续发小号 → 上传被吞、本地被覆盖。
  > **deps.getGroups 走 storage 内存缓存，成本可忽略。**

- 实际注入：`src/background/mutationService.ts:23`、`src/background/TabManager.ts:23`、
  `src/sync-backend/index.ts:274`、`src/utils/supabase/upload.ts:66`
  —— 全部是 `getGroups: () => storage.getGroups()`（**30s 缓存读**）

**为什么危险**
注释的整段论证建立在「每次都真读」这个前提上（"下载合并会把云端印记写进 storage"
⇒ 必须重新读才能看到），而实现**恰恰不会重新读**。这是一处**注释与实现相反**，
不是措辞问题。

**今天为什么没出事**
同 A2：生产只有 SW 写 groups，SW 自己的写会刷新自己的缓存。

**「改起来会漏」的地方**
任何相信「每次都真读」的人去改 seq / 水位逻辑，会得到一个**只在单写者拓扑下成立**的
正确性论证。一旦出现第二个写者上下文，**症状是「本地编辑被云端旧数据覆盖」**——
离改动点非常远。

**最小改法**：把 `seqRegistry` 的 `deps.getGroups` 改成 `storage.getGroupsForWrite()`
（4 处注入点），或把注释改成「本 realm 缓存 30s，跨 realm 失效靠 X」并把 X 真的做出来
（同 A2）。

---

### A6 ★☆☆ `lastLoadedAt` 是只写状态，但它的注释还挂着「hydration 判断」

**位置**
- 写：`src/store/slices/tabSlice.ts:597` — `state.lastLoadedAt = new Date().toISOString();`
- 声明：`src/types/tab.ts:189` — `lastLoadedAt: string | null; // 本地数据最近一次成功加载时间（hydration 判断）`
- **全仓无任何读取点**（`grep -rn "lastLoadedAt" src/` 只命中这两处 + `initialTabState`）

**为什么留着危险**
它就是历史 P0「瞬时空读被固化」的现场。`tests/storeHydration.test.ts:98-102` 专门钉死了
「TabList 不得用 `if (lastLoadedAt) return`」。

**「改起来会漏」的地方**
`src/types/tab.ts:189` 的注释「hydration 判断」会让新人以为**存在**一个基于
`lastLoadedAt` 的跳过机制，从而去「优化」它 —— 而任何基于它的跳过逻辑都会复活那个 P0。

**最小改法**：删掉 `lastLoadedAt` 字段（3 处：`types/tab.ts:189`、`tabSlice.ts:93`、
`tabSlice.ts:597`）。**注意** `tests/autoDeleteEmptyGroup.test.ts:50` 引用了它，
删字段要同步改那个 fixture。

---

## 2. 同一语义在多处实现不一致

### B1 ★★★ WebDAV 适配器三个构造点，两个漏注入了 P0 自检所需的依赖

**位置**
| 构造点 | 是否注入 `peekDeviceSeq` / `nextDeviceSeq` / `bumpDeviceSeqIfLower` |
|---|---|
| `src/sync-backend/index.ts:200`（`defaultFactory`，生产路径） | ✅ `:245` `peekDeviceSeq: () => webDavSeqRegistry.peekDeviceSeq()` |
| `src/components/sync/WebDavSettings.tsx:536`（测试连接） | ❌ |
| `src/components/sync/WebDavSettings.tsx:829`（首次同步探测） | ❌ |

漏注入 ⇒ 走 `src/sync-backend/webdav/adapter.ts:270` 的兜底
`this.peekDeviceSeq = deps.peekDeviceSeq ?? (async () => 0);`
⇒ `src/sync-backend/webdav/adapter.ts:1919` 的**「seq 时钟回退自检」**
（`if (Number.isFinite(deviceSeq) && current < deviceSeq) return 0;`）**恒为假**
⇒ 这道 P0 防线在 UI 路径上**静默失效**。

**证据不是推断，是仓库自己的注释**：
- `src/sync-backend/index.ts:229-232`：
  > 为什么必须在这里注入：适配器的 `peekDeviceSeq ?? (() => 0)` 兜底会让
  > 「水位线的 seq 时钟回退自检」永远拿到 0，`current < deviceSeq` 恒假
- `src/sync-backend/webdav/adapter.ts:286-288`：
  > 兜底号位与写作路径的计数器**不共享**…所以**生产路径必须注入**
  > —— 见 src/sync-backend/index.ts 的绑定

**为什么危险**
「生产路径必须注入」这句话在**字面上把 UI 路径排除在外**，但 UI 路径做的
`downloadGroups()`（`WebDavSettings.tsx:841`）会走到 `loadWatermark()`（`adapter.ts:1919`），
读的是同一条水位。今天 UI 侧只读（实测 `adapter.` 调用只有 `:548` checkConnection 与
`:841` downloadGroups）所以不写坏数据 —— 但**失效是静默的**：UI 探测显示的数字
（"云端有 N 组"）与执行侧（SW 的 defaultFactory）用的不是同一套判据。

**「改起来会漏」的地方**
`new WebDavBackendAdapter(...)` 有 3 个调用点、每个手工拼一份 `config` 对象。
**新增第 4 个调用点的人不会知道 `peekDeviceSeq` 要注入**（没有类型层面的必填约束 ——
`src/sync-backend/webdav/adapter.ts:120` 把它声明成 `peekDeviceSeq?:` 可选）。

**最小改法**：抽 `src/sync-backend/webdav/factory.ts` 的 `createWebDavAdapter(cfg, secrets)`，
三处都走它；把 `peekDeviceSeq` / `nextDeviceSeq` / `bumpDeviceSeqIfLower` 从**可选**
改成**必填**（先在工厂里给默认实现，adapter 里删掉 `?? (async () => 0)` 兜底）。

---

### B2 ★★☆ 「本组没加密成功」：Supabase 继续、WebDAV 中止，两个后端口径相反

**位置**
- Supabase：`src/utils/supabase/upload.ts:836-848` —— 逐组 `try/catch`，失败 push 进
  `encryptionFailedIds` 并**继续上传其余组**
- WebDAV：`src/sync-backend/webdav/adapter.ts` —— 「选了加密但没口令 ⇒ 适配器**报错中止**」
  （见 `src/sync-backend/index.ts:222-224` 的说明）

**为什么危险**
这是记忆里点名的「同一判据在两个调用方不同口径」的高发区，**且现在还在**。
本条的诚实界定：**不构成数据丢失**（`tests/backendParityDefects.test.ts` 的 D-3 覆盖了
「一个组都没传上去仍清 pending_upload」那个曾经的缺陷；`findConcededGroupIds` /
`verifyUploadReadback` 会在对账里把漏掉的组报出来）。

**「改起来会漏」的地方**
`UploadResult.skippedGroups`（`src/services/syncEngine.ts:128`）已经是引擎在用的
「本轮没传上去」口径。**只改 WebDAV 侧**（让它也部分成功）或**只改 Supabase 侧**
（让它整轮中止），另一边的 UI 文案就会撒谎 —— 因为 UI 只有一个 `skippedGroups` 字段。

**最小改法**：把 Supabase 侧「加密失败的组」并入 `UploadResult.skippedGroups`
（引擎已有这个字段与对应的 UI 文案），让「部分成功」在两个后端上是同一句话。

---

### B3 ★★☆ 一个**同名空壳占位函数**与真实现并存

**位置**
- `src/utils/faviconUtils.ts:123` — `export async function migrateFaviconUrls()`
  函数体第 `:129` 行注释：
  > 注意：实际的迁移逻辑将在调用此函数的地方实现 / **这里只是一个占位符函数**
- `src/utils/migrationUtils.ts:36` — 真正的 `migrateFaviconUrls()`（有完整实现）

**为什么危险**
**同名**。任何人 `grep migrateFaviconUrls` 都会**先命中占位函数**
（`faviconUtils.ts` 在 `utils/` 目录里，路径更短、更像一个「工具函数」）。
占位函数的 doc 写着「应该在应用启动时调用一次」—— 一个**照着注释做**的人会去调它，
然后什么都不会发生（它只打一行日志）。

**「改起来会漏」的地方**
真实现 `src/utils/migrationUtils.ts:36` 与占位 `src/utils/faviconUtils.ts:123` 的
**参数与返回类型完全一致**（都是 `Promise<void>`），TypeScript **不会**报任何错。

**最小改法**：删掉 `src/utils/faviconUtils.ts:123-134` 整个函数（它是纯噪声，
零生产调用点）；同时删掉 `src/utils/faviconUtils.ts:115` 的 `sanitizeFaviconUrls`
（只被 `tests/base64AndUrlPolicy.test.ts` 引用）。

---

### B4 ★★☆ 两套独立加密实现，没有共享测试向量

**位置**
| | Supabase 侧 | WebDAV 侧 |
|---|---|---|
| 文件 | `src/utils/encryptionUtils.ts` | `src/sync-backend/crypto.ts` |
| 密钥来源 | `userId` 派生 | 用户口令派生 |
| PBKDF2 轮数 | `100_000`（`:9`） | `250_000`（`:43`） |
| base64/拼接 | `src/utils/base64.ts` | `src/utils/base64.ts`（共享） |

**这是刻意的**（`src/sync-backend/crypto.ts:14-16` 明写「取舍一致，只是密钥来源不同」），
**不是缺陷**。但它有一个具体后果：**两套实现各自有各自的测试，没有共享的测试向量**。

**「改起来会漏」的地方**
改 `src/utils/encryptionUtils.ts` 的 AES-GCM 参数（IV 长度、AAD、密文布局）时，
`src/sync-backend/crypto.ts` 的测试**不会变红** —— 它们是两套独立的实现。
新人容易以为「加密只有一套」。

**最小改法**：在 `src/utils/encryptionUtils.ts` 与 `src/sync-backend/crypto.ts` 之间
放一组**共享的测试向量**（同一明文 + 固定 salt/IV → 期望密文），或者在两边文件头互相
写明「这是两套独立实现，改一边不影响另一边」。

---

### B5 ★★☆ 协议与适配器有**两条 import 路径**，改一半不会报错

**位置**
- 真身：`src/core/mutationProtocol.ts`（148 行）
- 门面：`src/shared/mutationProtocol.ts`（5 行，`export * from '@/core/mutationProtocol'`）
- 生产 import 分布：`@/shared/mutationProtocol` **14 处**、
  `@/core/mutationProtocol` **2 处**（`src/store/slices/tabSlice.ts:76`）、
  `'./mutationProtocol'` **1 处**（`src/core/mutationAffectedGroups.ts:20`）
- 同构：`src/storage/storageAdapter.ts`（5 行 re-export）→ `src/storage-kv/storageAdapter.ts`
- **例外**：`src/utils/supabaseFacade.ts` **不能删** —— 它的文件头 `:5-18` 记录了一个
  真实隐患：门面与 `src/utils/supabase/` 目录同名，解析顺序不同会把 import 悄悄指到别处。
  它已经改名过一次，**不要动**。

**为什么危险**
`export *` 门面意味着**两个路径拿到的是同一个模块**（运行时无差异），但：
- 改协议时只改 `src/core/mutationProtocol.ts` 是安全的（门面会转发）——
  真正的风险在**反向**：有人为了「清理门面」去改 import 路径，改了一半 ⇒
  **tsc 报错**（这个还好）；更坏的是有人**在门面上加逻辑** ⇒ 那份逻辑只对走门面的
  14 处生效，走真身的 3 处拿不到 ⇒ **同一协议两套行为**。

**「改起来会漏」的地方**
`src/shared/mutationProtocol.ts` 的文件头写着「实现已搬迁…本文件仅作 re-export 转发」，
读起来像「历史遗留、随时可删」—— 但删它需要**一次改完 14 处 import**，
半途而废会留下编译错误。

**最小改法**：一次改完全部 import 路径后删掉 `src/shared/mutationProtocol.ts` 与
`src/storage/storageAdapter.ts`。**`src/utils/supabaseFacade.ts` 保留。**

---

## 3. 模块边界错位

### C1 ★★★ `src/utils/`（纯工具层）反向依赖 React 层 ⇒ React 被拖进 MV3 Service Worker

**位置**：`src/utils/toastHelper.ts:6`
```ts
import { useToast } from '@/contexts/ToastContext';
```

**实测后果（不是推演）**
- `dist/service-worker.js` 第一行就有 `import"./react-vendor-Cw5MEmhu.js";`
  —— **139KB raw / 44.7KB gzip**
- 依赖图扫描：从 `src/service-worker.ts` 可达的 84 个模块里，
  **0 个** import 了 `react` / `react-dom`
- SW 只需要 react-vendor 的 3 个符号（`a` / `b` / `j`），正是 ToastContext 的
  `createContext` / `useContext` / `useCallback`

**根因**：`vite.config.ts:120-123` 的 `manualChunks` 把**整个 `src/utils/` 打成一个 chunk**
（`if (nm.includes('src/utils/')) return 'utils';`）。`toastHelper.ts` 恰好在 `src/utils/`
里且 import 了一个 React context ⇒ 整个 `utils` chunk 依赖 React ⇒ SW 静态 import React。

**为什么危险**
- **改了会出 bug**：把 `toastHelper.ts` 挪到 `src/components/common/` 时，如果顺手改了
  `manualChunks` 的匹配串（`src/utils/` → `src/utils/!(toastHelper)`），会**同时**影响
  popup 首屏的分块 ⇒ `scripts/report-bundle-size.mjs` 的 260KB 门会红，但**原因与改动
  看起来无关**，极难定位。
- **改起来会漏**：`src/utils/` 目录下的**任何**文件 import 任何 React 组件/hook，
  都会再次把 React 拖进 SW。**没有任何门禁检查这件事**。

**最小改法**：把 `useEnhancedToast` / `toastHelper.ts` 挪出 `src/utils/`
（例如 `src/components/common/enhancedToast.ts`），断掉 utils→contexts 的反向依赖。
**改动量**：1 个文件搬家 + 3~4 处 import 更新（`src/components/tabs/TabGroup.tsx:8`、
`src/components/search/SearchResultList.tsx:9` 等）。

---

### C2 ★★☆ UI 越过门面直连 6 个后端内部模块

**位置**：`src/components/sync/WebDavSettings.tsx:48-73`
```
→ src/sync-backend/webdav/config.ts
→ src/sync-backend/webdav/client.ts
→ src/sync-backend/webdav/adapter.ts
→ src/sync-backend/webdav/permission.ts
→ src/sync-backend/webdav/firstSyncDecision.ts
→ src/sync-backend/webdav/libraryIdentity.ts
```
而 `src/sync-backend/index.ts`（10 个入度）本该是唯一门面。

**为什么危险**
门面的价值就是「所有调用方拿到的实例都带齐了 `defaultFactory`（`src/sync-backend/index.ts:200-245`）
注入的东西」—— 权限预检、seq 计数器、后端解析缓存。
**UI 直连内部模块就绕过了这些注入**（见 B1：`peekDeviceSeq` 就是这么漏的）。

**「改起来会漏」的地方**
新人看 UI 的写法（「我就 import 具体模块用一下」），会在新地方直连
`webdav/adapter.ts` / `webdav/client.ts` ⇒ 拿到的实例**没有** `peekDeviceSeq`、
**没有**权限预检 —— 而这两样在 `adapter.ts:270` / `client.ts` 的构造参数里都是
**可选的**（`peekDeviceSeq?:`），**类型层面不会提醒你**。

**最小改法**：把 UI 需要的 4~5 个能力（读配置、读权限、首次同步裁决、库身份）提成
`src/sync-backend/webdav/queries.ts` 这样的**只读查询面**，UI 只依赖它；
`adapter.ts` / `client.ts` 的**构造**权收回 `index.ts` / 工厂。

---

### C3 ★★☆ store 层绕过 store 自己直连 storage —— 有意的，但没有机制防止下一个

**位置**：`src/store/slices/tabSlice.ts:74`（import）、`:115`（`storage.getGroups()`）

**这是有意的**，`src/store/slices/tabSlice.ts:1-6` 的文件头写明：
> 唯一写者是 SW 侧 mutationHandlers，唯一同步入口是 syncEngine。
> 读路径（loadGroups 经 storage.getGroups 读真值）不在写收口范围内。

**为什么仍然要列出来**
**「写收口」这个概念本身是有价值的**（所有写路径必须走 SW 的单写者队列）。
但读路径的豁免**没有任何机制强制**：`src/store/slices/tabSlice.ts` 之外，
任何一个 slice 都可以 `import { storage } from '@/utils/storage'` 直接读写，
**不会有任何守卫拦下**。

**「改起来会漏」的地方**
新人加一个 `settingsSlice` 动作时，很可能顺手 `storage.setSettings(...)` ——
那会**同时**写到 popup realm 的缓存与磁盘，**绕过** SW 的 `resyncAlarm`
（`src/service-worker.ts:784`）⇒ SW 侧的 alarm / 后端解析缓存不会跟着更新 ⇒
「设置改了没生效」这类极难查的症状。

**最小改法**：在 `tests/deadSettingsAndEntryPoints.test.ts`（或新守卫）里加一条：
`src/store/slices/**` 不得 import `@/utils/storage` 的**写**方法
（`setGroups` / `setSettings` / `setGroupsImmediate`）—— 读方法白名单放行。

---

### C4 ★☆☆ UI 层直连 storage 的**唯一**先例，以及它为什么合理

**位置**：`src/components/app/AppContainer.tsx` → `src/storage/storageAdapter.ts`
（`initStorage()` 预热 + 打后端日志）

**列出来是为了划边界**：全仓 UI → storage 的直连**只有这一处**，
且它有正当理由（启动预热）。新人要加第二个直连时，应该先问「为什么 AppContainer 可以」。

---

## 4. 死代码

### D1 ★★★ 搜索的「分片渲染」第二道防线**在生产代码里不存在**，但注释与单测都声称它存在

**位置**
- 承诺：`src/components/search/SearchResultList.tsx:179`
  > 2. **分片渲染**：结果条数没超上限、但会话分组多时，按片渲染。
- 实际：`src/components/search/SearchResultList.tsx:181` 只用了 `buildResultWindow`
- 未接线：`src/components/search/searchWindowing.ts:58`（`SEARCH_CHUNK_SIZE`）、
  `:69`（`computeVisibleChunks`）、`:88`（`chunkResults`）
  —— **生产调用点 0 个**（逐符号扫全仓确认）
- 但 `tests/searchWindowing.test.ts` 有 **8 个用例**在测这三个函数

**为什么危险**
「搜索是本产品最高频的『找回』路径」（`src/components/search/searchWindowing.ts:35-42`
自己写的），而分片是它明说的第二道防线。
**只读 `SearchResultList.tsx` 的新人会以为分片已实现** —— 他看到注释、看到
`searchWindowing.test.ts` 全绿、看到 `buildResultWindow` 的 200 条截断，
会认为「搜索路径已经做了渲染上限」。

**而 200 条截断只管住了「标签条数」，没管住「卡头数」**
（`src/components/search/SearchResultList.tsx:183-195` 的 `visibleSessionResults`
按**整组**保留，400 组各命中 1 个标签时，200 组全部渲染、每组一个卡头）。

**「改起来会漏」的地方**
如果要「修复」这件事，**只改 `SearchResultList.tsx` 不够**：
`computeVisibleChunks` 需要一个视口感知的 activeChunkIndex，
而 `src/hooks/useNearViewport.ts` 现有的实现是**按元素**判定的（`callbacks` Map +
共享 IntersectionObserver），**没有**「当前第几片」的接口 ⇒ 得先给这个 hook 加一个
按序号查询的能力，或者另写一个。

**最小改法（两条路，二选一）**：
1. 接上：在 `SearchResultList` 里引入分片 + 视口感知（工作量：改 1 个组件 + 给
   `useNearViewport` 加序号接口）；
2. **或者**把 `src/components/search/SearchResultList.tsx:179` 那行注释删掉，
   并把 `searchWindowing.ts:58/69/88` 三个导出与 `tests/searchWindowing.test.ts` 里
   对应的 8 个用例一起删掉 —— **别让注释和单测给一个不存在的机制背书**。

---

### D2 ★★☆ 命中区判据被单测钉死，生产代码完全不用它

**位置**：`src/components/layout/hitTarget.ts`（79 行）
- 唯一的**代码**引用：`tests/guards/headerGeometry.test.ts:42`（import）
- 生产代码里只有**两处注释**提到它：
  - `src/styles/global.css:520` — `/* 命中区下限：36×36（口径见 src/components/layout/hitTarget.ts）。`
  - `src/components/sync/SyncButton.tsx:496` —
    > `.btn-icon` 相同的尺寸下限。选 36px 的理由见 hitTarget.ts

**为什么危险**
`hitTarget.ts` 的文件头把「36×36」论证得很完整（WCAG 2.2 SC 2.5.8 的 AA 下限 24px、
AAA 的 44px、400px 顶栏的空间账），看起来像是**生产在用的规范**。
实际上**没有任何生产代码用 `meetsHitTarget()` 校验自己的类名** ——
SyncButton 用的是自己的 `px-2 py-1.5`（这正是该文件存在的原因：「同步按钮此前只是
**没被这条规则覆盖**」）。

**「改起来会漏」的地方**
新人想「统一命中区尺寸」时，会以为只要改 `MIN_HIT_TARGET_PX` 一个常量就能生效 ——
**改了不会有任何生产变化**，而 `tests/guards/headerGeometry.test.ts` 仍然全绿
（它测的是纯函数，不是组件）。

**最小改法**：二选一 —— (a) 让 `SyncButton`（及顶栏其它小按钮）真的用
`meetsHitTarget(className)` 断言自己的类名；或 (b) 把该文件挪到
`tests/_helpers/` 降级为测试辅助，并在文件头写明「**生产未使用**」。

---

### D3 ★★☆ 一批「导出但外部零引用」的符号

**实测**（逐符号 grep 全仓，**只在自己定义文件里出现**）：

| 符号 | 位置 | 备注 |
|---|---|---|
| `throttle` | `src/utils/performance.ts:13` | 零引用 |
| `SimpleCache` | `src/utils/performance.ts:130` | 仅内部使用 |
| `CacheManager` | `src/utils/performance.ts:231` | 仅内部使用 |
| `DebouncedAsyncFn` | `src/utils/performance.ts:35` | 仅类型 |
| `SCORE_WEIGHTS` | `src/utils/search.ts:4` | 仅内部 |
| `SearchOptions` | `src/utils/search.ts:14` | 仅内部 |
| `MatchDetail` | `src/utils/search.ts:27` | 仅内部 |
| `KNOWN_SERVICE_WORKER_REASONS` | `src/utils/serviceWorkerErrorCopy.ts:58` | 仅内部 |
| `getRuntimeManifest` | `src/utils/runtimeInfo.ts` | 仅内部 |
| `encryptLocalBlob` | `src/utils/secureStorage.ts:339` | 仅测试引用 |
| `decryptLocalBlob` | `src/utils/secureStorage.ts:351` | 仅测试引用 |
| `PERF_SPAN_MAX` | `src/utils/perfTrace.ts:141` | 仅测试引用 |
| `clearOnboardingTrigger` | `src/utils/onboardingStorage.ts:76` | 仅文件内使用 |

**为什么危险**
这些是**导出**，所以：
- 新人 `grep` 到它们会以为「这是公共 API」；
- `tsc` **不会**报未使用导出（`noUnusedLocals` 管不到 export），
  仓库也没有「导出必须被 import」的通用守卫。

**最小改法**：去掉 `export`（保留内部使用）。**注意** `encryptLocalBlob` /
`decryptLocalBlob` / `PERF_SPAN_MAX` 被测试引用 ⇒ 要么保留 export 并在守卫里
标注「仅测试使用」，要么把测试改成走公开入口。

---

### D4 ★★☆ 开发期基准工具进了 Service Worker 的启动图

**位置**
- `src/popup/index.tsx:7` — `import { benchmarkStorageRoundtrip, seedLargeDataset } from '@/utils/performanceTest';`
  （执行被 `import.meta.env.DEV` 挡住，**但 import 是静态的**）
- `src/utils/performanceTest.ts` → 落在 `utils` chunk ⇒ 被 `dist/service-worker.js` 静态 import

**为什么危险**
`src/utils/performanceTest.ts` 里有 `seedLargeDataset`（**往 IndexedDB 写 400 组假数据**）
和 `benchmarkStorageRoundtrip`。它现在跑不到，但：
- 它把 `utils` chunk 撑大 ⇒ C1 说的 React 问题更严重；
- 一旦有人把 `import.meta.env.DEV` 判断去掉（或者换成 `process.env.NODE_ENV`），
  **生产环境会往用户库里写假数据**。

**「改起来会漏」的地方**
`import.meta.env.DEV` 是**编译期常量**替换，所以死代码消除器**不会**删掉这个 import
（它不知道 `DEV` 是 false）。要真正移除，得改成 `await import()` 动态导入。

**最小改法**：改成动态 import
`const { seedLargeDataset } = await import('@/utils/performanceTest');`（在 DEV 分支内）。

---

## 5. 新人接手会踩的坑（注释与实现相反 / 自相矛盾）

### E1 ★★☆ 同一段注释里，前后两句话描述的是**修复前**和**修复后**两个世界

**位置**：`src/utils/storage.ts:551-554` vs `src/utils/storage.ts:541-543`
相隔 **3 行**：

- `:541-543`：「【2026-10-09 修订：popup 已不再自行写 groups】…三件迁移全部搬进
  SW 的单写者队列执行…**popup realm 不再直接整表写 GROUPS key**」
- `:551-554`：「**popup 的 runMigrations（migrateFaviconUrls）会在 TabList 挂载时调
  setGroups()，SW 侧没有 onGroupsChanged，感知不到这次写入**」—— 那正是**修复前**的世界

**为什么危险**
新人在 `getGroupsForWrite` 的说明里读到 `:551-554`，会以为
**「popup 还会写 groups，SW 感知不到」是当前事实** ⇒ 由此推出「需要给 SW 加
onGroupsChanged 订阅」之类的结论（而 A2 恰恰说明 **SW 侧根本没订阅**，
两边拼起来才构成一个自洽的、但**不完整**的图景）。

**最小改法**：把 `:551-554` 那段历史描述整体删除，或加「（修复前的世界：…）」前缀
并把它挪到 `:541-543` 之后紧邻着放。

---

### E2 ★★☆ `getGroups()` 的注释说「fail-closed：不返回 []」，但函数里**确实会返回 []**

**位置**：`src/utils/storage.ts:419-459`
- `:422-425`：「fail-closed：读失败**抛错**，不返回 []」
- `:446-448`：
  ```ts
  if (groups === undefined || null) { return []; }
  ```
  —— 键不存在时**返回空数组**

**为什么这不是 bug，但仍是坑**
语义上确实区分了三种情况（键不存在 → `[]`；形状不对 → 抛错；读失败 → 抛错），
**代码是对的**。但注释与代码的**字面**不一致，且这个函数是**全仓最热的读入口**。

**「改起来会漏」的地方**
新人为了「统一语义」把 `:446-448` 也改成抛错 ⇒ **首次使用的用户会看到错误页而不是空态**
（这是产品级回归）；反过来，为了「简化」把它改回一行三元
`Array.isArray(groups) ? groups : []` ⇒ 形状损坏被归一成空数组 ⇒
**下一次写入把整组用户会话截断**（这正是 `:431-441` 的注释在防的 P0）。

**最小改法**：把 `:419-425` 的注释改成准确的三分口径
（键不存在 → `[]`；形状异常 → 抛错；读失败 → 抛错），**不要动代码**。

---

### E3 ★★☆ 同一份「下载结果」靠**模块级变量**在两次调用之间传递

**位置**
- `src/utils/supabase/download.ts:174` — `let lastDownloadSkipped: DownloadSkippedGroup[] | null = null;`
- `src/utils/supabase/download.ts:382-389` — 本轮的 `skipped` 清单
- `src/utils/supabase/download.ts:189-193` — `downloadSkippedGroups()` 读这个全局变量
- `src/utils/supabase/download.ts:167` — 轮次序号防护（**事后**检测）
- `src/services/downloadWithSkippedGroups.ts` — 把「读结果 + 问清单」收进一个函数（**结构上**避免）

**为什么危险**
`src/utils/supabase/download.ts:159-168` 的注释自己写明了风险：
> 「读到的」与「读不出来的」必须来自**同一轮**下载。分两次调用…中间有 await 间隙，
> 同一 realm 里理论上可能读到别的轮次的清单。

轮次序号（`:167`）只能**检测**错轮并降级，**不能从结构上避免**。
而且 `src/utils/supabase/download.ts:152-155` 还专门写了「不要并发跑
`downloadTabGroups()`」的告诫 —— 这是**靠注释维持的约束**，不是靠类型或结构。

**「改起来会漏」的地方**
任何新增的「调一次 `downloadTabGroups()`」的地方（预览？诊断导出？后台 digest 比对？）
都会**污染这个全局变量**，让下一次 `downloadSkippedGroups()` 拿到错轮的清单 ——
症状是「覆盖下载时把本机几份会话当云端已删除而物理清除」
（`src/services/syncEngine.ts:660-671` 整段注释在防这个）。

**最小改法**：把 `downloadTabGroups()` 的返回值改成 `{ groups, skipped }`
（一次性返回），把 `lastDownloadSkipped` 这个模块级变量删掉。
**风险**：需要改 `src/sync-backend/supabaseAdapter.ts:64-85` 与
`src/services/downloadWithSkippedGroups.ts` 两个调用点，**必须一起改**。

---

### E4 ★☆☆ 还原率阈值 `MIN_RESTORABLE_TAB_RATIO` 被两处注释引用，容易被误认为有两份定义

**位置**
- **唯一定义**：`src/utils/supabase/download.ts:54` — `export const MIN_RESTORABLE_TAB_RATIO = 0.5;`
- 引用（**只是注释**）：`src/types/tab.ts:137`、`src/core/tabDataCodec.ts:11-12`、
  `src/utils/inputValidation.ts:216`

**为什么列出来**
我最初把它当成「三处同名、双源」的问题，**复核后确认是误判**（见第 6 节）。
但这个误判本身值得记一笔：三个文件里的注释都写「MIN_RESTORABLE_TAB_RATIO」而**不写
它在哪个文件**，新人顺着注释找会找不到第二份、也会误以为有第二份。

**最小改法**：在这三处注释里补上定义位置
（`@/utils/supabase/download.ts`），或把常量上移到 `src/core/tabDataCodec.ts`
（语义上更接近它的家）。

---

## 6. 我撤回的判断（审查过程中自己否掉的）

1. **「`src/core/mutationProtocol.ts` vs `src/shared/mutationProtocol.ts` 是重复实现、已经漂移」**
   —— 撤回。`src/shared/mutationProtocol.ts` 只有 5 行，是纯 `export *` 转发，
   **没有第二份逻辑**。降级为 B5「两条 import 路径」。

2. **「`src/storage/storageAdapter.ts` 与 `src/storage-kv/storageAdapter.ts` 是两套实现」**
   —— 撤回。前者只有 5 行、纯转发。

3. **「`src/sync-backend/webdav/layout.ts` 只被测试 import，生产不可达」**
   —— 撤回。我的孤儿模块脚本对多行 import 语句的正则失效；
   实际 `src/sync-backend/webdav/adapter.ts:67` 正常 import 它。（脚本缺陷已修，结论已复核。）

4. **「`getOnboardingTrigger` / `getOnboardingState` / `clearOnboardingTrigger` 是死导出，
   引导触发机制是死的」**
   —— 撤回。三个符号在 `src/utils/onboardingStorage.ts` **文件内**被调用
   （:96、:116、:142、:145、:185、:191），写侧（`recordOnboardingTrigger`）+
   读侧（`shouldShowOnboarding`）+ 双闸门是完整闭环。

5. **「`src/utils/errorHandler.ts` 整个是死模块」**
   —— 撤回。`errorHandler` 单例被 `src/contexts/ToastContext.tsx:96` 与
   `src/services/syncEngine.ts:1477` 使用。只有部分**导出**无外部引用（并入 D3）。

6. **「`MIN_RESTORABLE_TAB_RATIO` 有三份定义（双源风险）」**
   —— 撤回。复核后确认**唯一定义**在 `src/utils/supabase/download.ts:54`，
   其余全是注释引用。降级为 E4（补定义位置）。

7. **「三处 `PBKDF2_ITERATIONS` 是重复实现」**
   —— 撤回。`src/sync-backend/crypto.ts:43`（250k，WebDAV 口令派生）与
   `src/utils/encryptionUtils.ts:9` / `src/utils/secureStorage.ts:6`（100k，
   分别是 userId 派生与本地存储密钥）是**三个不同的密钥域**，
   `src/sync-backend/crypto.ts:14-16` 已写明取舍理由。降级为 B4（无共享测试向量）。

8. **「`src/sync-backend/crypto.ts` 是死模块」**
   —— 撤回。它被 `src/sync-backend/webdav/adapter.ts:68` import（相对路径 `'../crypto'`，
   我第一次 grep 用的模式没覆盖）。

9. **「`pnpm lint` 会 lint 到 `dist/` 产物」**
   —— 撤回。`eslint src -f json` 精确核对：**195 个文件全在 `src/` 下，0 error 0 warning**。
   先前那段含 `dist/*.js` 的输出是命令输出压缩层的串扰，不是真实结果。

10. **「搜索结果路径完全没有虚拟化」**
    —— 撤回（部分）。`buildResultWindow` 的 200 条截断**是真的且有效**（实测宽泛查询下
    搜索态 DOM 2393 节点）。真实发现收窄为 D1：**分片那一半**不存在。

---

## 7. 未能验证项（受环境限制，非遗漏）

1. **MV3 Service Worker 被 30s 空闲回收的端到端行为**：本机 Playwright 无法精确制造
   「SW 被回收到任务中途」的时序。A2 / A5 的结论来自**代码拓扑**（谁写、谁订阅、谁读缓存），
   不是来自复现。
2. **并行 lane 对 `src/components/**` 的改动可能影响本文的部分行号**：
   见文末说明。本文所有行号在写入时已复核，但**若并行 lane 继续改动，行号会漂**。
3. **真实 Supabase / WebDAV 端到端上传耗时**：需要真实后端与凭据，未做。
4. **CI 是否真的不跑 `scripts/prod-stress.mjs`**：只读了 `.github/workflows/verify.yml`
   确认未调用，**没有实际跑一次 CI**。
5. **生产库真实状态**：按仓库纪律，本文所有结论只证明**代码侧**，不推断生产库状态。

---

## 8. 总表（按建议动手顺序排）

| # | 级别 | 一句话标题 | 位置 | 最小改法 |
|---|---|---|---|---|
| A3 | P1 | `ensureVersion()` 无缓存，被 35 个读方法各读一次 IDB（每次开页 14 次多余读） | `src/utils/storage.ts:413` | 加模块级 `versionEnsured` 布尔（`STORAGE_VERSION` 是编译期常量） |
| A1 | P1 | 判据 `startsWith('settings/')` 把「读设置」当「设置变了」⇒ 打开页面即置 `pending_upload` 并调度 4 次上传 | `src/store/middleware/autoSyncMiddleware.ts:12` | 判据换成**写盘类** settings action 白名单（**必须**同时看 `MainApp.tsx:27` 与 `ThemeContext.tsx:57` 两个派发点） |
| C1 | P1 | `src/utils/toastHelper.ts` 反向依赖 React context ⇒ SW 静态加载 44.7KB gzip 用不到的 React | `src/utils/toastHelper.ts:6` + `vite.config.ts:120-123` | 把 toast helper 挪出 `src/utils/`（如 `src/components/common/`） |
| D1 | P1 | 搜索的「分片渲染」第二道防线在生产代码里不存在，但注释与 8 个单测都声称它存在 | `src/components/search/SearchResultList.tsx:179` / `searchWindowing.ts:58,69,88` | 二选一：接上分片（先给 `useNearViewport` 加序号接口）／或删注释+删函数+删 8 个用例 |
| B1 | P1 | `new WebDavBackendAdapter` 三处，UI 两处漏注入 `peekDeviceSeq` ⇒ P0 时钟回退自检恒假 | `src/components/sync/WebDavSettings.tsx:536,829` / `adapter.ts:270,1919` | 抽 `createWebDavAdapter` 工厂；把 `peekDeviceSeq` 改成**必填**，删掉 `?? (async () => 0)` 兜底 |
| A2 | P2 | SW realm 从不订阅 `onGroupsChanged` ⇒ SW 的 30s groups 缓存没有跨上下文失效通道 | `src/storage-kv/groupsChangedBus.ts:83` / `src/utils/storage.ts:101` | `src/service-worker.ts` 顶层加 `onGroupsChanged(() => {})` |
| A5 | P2 | `seqRegistry` 注释承诺「不做 memo」，实现却走 30s 缓存读（前提与实现相反） | `src/utils/seqRegistry.ts:15-17` | 4 处注入改 `storage.getGroupsForWrite()`；或把注释改成事实 |
| A4 | P2 | 同一件事三种读法，`getGroupsFresh` ≡ `getGroupsForWrite` 减一次 flush | `src/utils/storage.ts:427,535,573` | 删 `getGroupsFresh`，1 个生产调用点（`syncEngine.ts:618`）改用 `getGroupsForWrite` |
| B3 | P2 | 一个**同名空壳占位函数**与真实现并存，签名完全一致 ⇒ tsc 不报错 | `src/utils/faviconUtils.ts:123` vs `src/utils/migrationUtils.ts:36` | 删 `faviconUtils.ts:123-134`（零生产调用点） |
| B5 | P2 | 协议/适配器有两条 import 路径（14 / 2 / 1），在门面上加逻辑只对一半调用方生效 | `src/shared/mutationProtocol.ts` / `src/core/mutationProtocol.ts` | 一次改完全部 import 后删门面（**`src/utils/supabaseFacade.ts` 必须保留**） |
| D2 | P2 | 命中区判据被单测钉死，生产代码只用注释引用它 | `src/components/layout/hitTarget.ts` | 要么让按钮真的调 `meetsHitTarget()`，要么降级为测试辅助 |
| D3 | P2 | 13 个「导出但外部零引用」的符号（tsc 不管 export） | `src/utils/performance.ts:13,35,130,231` 等 | 去 `export`；测试专用的 3 个要保留 export 并在守卫里标注 |
| C2 | P2 | UI 越过门面直连 6 个后端内部模块，绕过 `defaultFactory` 的注入 | `src/components/sync/WebDavSettings.tsx:48-73` | 提成 `src/sync-backend/webdav/queries.ts` 只读查询面 |
| C3 | P2 | store 层直连 storage 是**有意的**，但没有任何守卫阻止下一个动作越界 | `src/store/slices/tabSlice.ts:74,115` | 加守卫：`src/store/slices/**` 不得 import storage 的**写**方法 |
| B2 | P2 | 「本组没加密成功」Supabase 继续、WebDAV 中止，两个后端口径相反 | `src/utils/supabase/upload.ts:836-848` | 把加密失败的组并入 `UploadResult.skippedGroups`（引擎已有该字段与 UI 文案） |
| E3 | P2 | 下载结果靠**模块级变量**跨两次 await 传递，轮次序号只能事后检测 | `src/utils/supabase/download.ts:174` | `downloadTabGroups()` 返回 `{ groups, skipped }`，删掉全局变量（两处调用点必须一起改） |
| A6 | P3 | `lastLoadedAt` 只写不读，注释却写着「hydration 判断」 | `src/types/tab.ts:189` / `src/store/slices/tabSlice.ts:597` | 删字段（3 处），同步改 `tests/autoDeleteEmptyGroup.test.ts:50` |
| B4 | P3 | 两套独立加密实现无共享测试向量，改一边不会让另一边变红 | `src/utils/encryptionUtils.ts` / `src/sync-backend/crypto.ts` | 加共享测试向量，或在两处文件头互相写明「独立实现」 |
| D4 | P3 | 开发期基准工具（含 `seedLargeDataset`）静态 import 进 SW 启动图 | `src/popup/index.tsx:7` | 改成 `await import()` 动态导入（DEV 分支内） |
| E1 | P3 | 同一段注释里前后两句话描述的是修复前和修复后两个世界，相隔 3 行 | `src/utils/storage.ts:541-543` vs `:551-554` | 删掉历史描述或加「（修复前的世界）」前缀 |
| E2 | P3 | `getGroups()` 注释说「不返回 []」，代码里键不存在确实返回 `[]` | `src/utils/storage.ts:419-459` | 改注释成三分口径（**不要动代码**） |
| E4 | P3 | `MIN_RESTORABLE_TAB_RATIO` 被 3 处注释引用却不写定义位置，易被误认为有多份定义 | `src/utils/supabase/download.ts:54` | 注释里补定义位置，或把常量上移到 `src/core/tabDataCodec.ts` |
| C4 | P3 | UI 层直连 storage 的**唯一**先例（合理），但新人不知道边界在哪 | `src/components/app/AppContainer.tsx` | 无需改码；作为边界说明保留在本表 |

**分级口径**：P1 = 今天就会产生错误行为或已埋雷；P2 = 改错方向/新增调用点时才会爆，但爆点离改动点很远；P3 = 认知陷阱与低概率风险。

---

## 9. 审计期间的仓库变动（影响可复核性）

审计期间**有并行 lane 在改同一批文件**，本文所有行号在**写入时**已对当前工作区复核：

```
 M src/components/app/MainApp.tsx
 M src/components/layout/Header.tsx
 M src/components/layout/HeaderDropdown.tsx
 M src/components/search/SearchResultList.tsx
 M src/components/tabs/TabGroup.tsx
 M src/components/tabs/TabList.tsx
 M src/options/OptionsPage.tsx
 M src/styles/global.css
 M tests/…（若干）
```

`src/components/tabs/TabList.tsx` 在审计期间从 408 行变为 534 行。
本文引用的这些行号**已按变动后的工作区重新核对**（例如 `onGroupsChanged` 订阅点
从 `:157` 变为 `:242`）。**但若并行 lane 继续改动，本文行号会再次漂移。**

未受影响、因而本文结论完全稳定的文件：
`src/store/middleware/autoSyncMiddleware.ts`、`src/utils/storage.ts`、
`src/utils/toastHelper.ts`、`src/utils/faviconUtils.ts`、`src/utils/migrationUtils.ts`、
`src/utils/seqRegistry.ts`、`src/utils/encryptionUtils.ts`、`src/utils/secureStorage.ts`、
`src/utils/performance.ts`、`src/utils/search.ts`、`src/utils/serviceWorkerErrorCopy.ts`、
`src/utils/runtimeInfo.ts`、`src/utils/perfTrace.ts`、`src/utils/onboardingStorage.ts`、
`src/utils/supabase/download.ts`、`src/utils/supabase/upload.ts`、
`src/sync-backend/index.ts`、`src/sync-backend/crypto.ts`、
`src/sync-backend/webdav/adapter.ts`、`src/sync-backend/webdav/layout.ts`、
`src/components/search/searchWindowing.ts`、`src/components/sync/WebDavSettings.tsx`、
`src/core/mutationProtocol.ts`、`src/shared/mutationProtocol.ts`、
`src/storage/storageAdapter.ts`、`src/storage-kv/groupsChangedBus.ts`。
