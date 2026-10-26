# 2026-10-23 架构与性能审计（round 43）

> 角色：架构与性能审查员。**只读审计** —— 本轮没有改动 `src/` 与 `tests/`，
> 唯一写入的是本文件。所有实验都在 `/tmp/audit43/` 的仓库副本与临时产物上进行。
>
> **基线**：HEAD = `cb6ac46`（分派时是 `23d2aab`，审计期间仓库被其他 agent 推进）。
> 本轮有并行 agent 同时在改 `src/`（`autoSyncMiddleware.ts` / `settingsUploadTrigger.ts` /
> `supabase/upload.ts` / `syncEngine.ts` / `authSlice.ts` / `authGuard.ts` …），
> 因此行号以**本会话实测到的文件内容**为准，个别行号可能随其它 agent 的提交漂移。
>
> **方法学纪律**：
> 1. 性能结论全部来自真实运行（Playwright 加载真实 `dist/` 扩展 + 真实 IndexedDB 数据 +
>    真实 dufs 0.47 WebDAV 服务器），不接受推测。
> 2. 「实测不出来」的地方如实写「实测不出来」，不拿估算冒充测量。
> 3. 假阳性比漏报贵：**每条结论在写入前都做过反向验证**（例如「等 N 个」那条一度被我
>    列为分叉，实测后发现代码是对的，已从发现清单删除，改列进「核对一致，不要重构」清单）。

---

## 0. 结论摘要

| 优先级 | 结论 | 一句话 |
|---|---|---|
| **P0** | **F1 墓碑读回判据两个后端强度不同** | Supabase 侧不校 Lamport 印记、WebDAV 侧校；且注释声称的 parity 测试**根本不存在** |
| **P0** | **C1 Service Worker 静态加载 React** | 两个改动**缺一不可**，一起做 = SW 图 **−162.2KB raw / −51.4KB gzip（−27%）** |
| **P1** | **④ 同步请求放大 8×/会话** | 1000 会话 = 8000 次串行 HTTP 往返；其中 **≥91.4% 的 MKCOL 是纯浪费**（3000 次发往 ≤258 个已存在的目录） |
| **P1** | **① 首屏 1000 会话 = 1.7–3.7s 可交互** | DOM 45222 节点；搜索首次 495ms（建索引），之后 15–276ms |
| **P2** | **A4 三种读法并存** | `getGroupsFresh` 少一次 flush，只剩 1 个生产调用点 ⇒ **现在就能删** |
| **P2** | **F2 会话名筛选 trim 不一致** | 徽章说「0 个筛选」，列表其实已经在筛 |
| **P2** | **③ 该接线没接线** | `validateSyncBackend` 自称「唯一校验点」，读路径不调它，另有两处手写同一规则 |
| **P3** | **B3 空壳占位函数** | `migrateFaviconUrls` 是空壳，占着「迁移」这个名字 |

---

## 1. 任务一：A1–A5 / B1–B5 / C1–C4 重新裁决

上一轮推迟的理由是「撤销机制正在落地、同步路径必须保持稳定」。撤销已落地并验证，
所以这一轮逐条重判。裁决口径：

- **现在能修** —— 不依赖同步路径的行为变更、爆炸半径可控、且收益可量化。
- **仍推迟** —— 推迟必须写清**触发条件**（哪个版本 / 哪个里程碑 / 什么前置事件），否则等于没结论。
- **已不成立** —— 缺陷本身已被别的改动消掉。

### 1.1 状态所有权（A 组）

| ID | 上轮结论 | 本轮裁决 | 依据 |
|---|---|---|---|
| **A1** | ★★★ 打开页面就把本地库标成「有待上传」 | **已修好（工作区，未提交）** | 见下 |
| **A2** | ★★☆ SW realm 没有跨上下文缓存失效通道 | **仍推迟**（触发条件：出现第二个 groups 写者上下文） | 见下 |
| **A3** | ★★☆ `ensureVersion()` 35 个调用点各做一次无缓存 IndexedDB 读 | **仍推迟**（触发条件：实测出它进入首屏关键路径） | 见下 |
| **A4** | ★★☆ 同一件事有三种读法 | **现在能修** | 见下 |
| **A5** | ★★☆ 注释承诺「不做 memo」，实现走 30s 缓存 | **仍推迟**（触发条件同 A2） | 见下 |

**A1 —— 已修好（工作区未提交，需随本轮落地）**
原判据 `action.type.startsWith('settings/')` 已换成 `src/core/settingsUploadTrigger.ts:71`
的 `isSettingsUploadTrigger`，白名单只有 `settings/saveSettings/fulfilled`。
守卫在 `tests/guards/settingsUploadTrigger.test.ts`，设计上有两点值得肯定：
- 判据集合**不钉字面量**：守卫解析 `settingsSlice.ts`，现场推出「哪些 action 真的写了盘」，
  再断言「覆盖全部写类、排除全部读类」⇒ 新增写类 thunk 会红，新增读类 thunk 不会误伤。
- 有**自证层**（L3）：同一个检查器对「前缀匹配」判据必须报错 ⇒ 证明推导层不是空转。

上轮记录的「上传触发次数 == loadSettings 派发点数量 × 2」这个结构性脆弱点
（谁再挪一次 dispatch 就变）已被白名单消除。**剩下的唯一动作是把它提交。**

**A2 —— 仍推迟，但触发条件比上轮更窄（已排除一个候选触发路径）**
`groupsChangedBus` 有跨上下文广播（`src/storage-kv/groupsChangedBus.ts:88` 的
`chrome.runtime.onMessage` 监听器），但它只在**有订阅者**的 realm 里注册
（`groupsChangedBus.ts:78` `ensureRuntimeListener()` 由 `subscribeGroupsChanged` 触发）。
全仓 `onGroupsChanged` 的调用点**只有一处**：`src/components/tabs/TabList.tsx:258`
（管理器页）。⇒ **Service Worker realm 从不订阅 ⇒ 从不注册那个监听器。**

上轮我怀疑「管理器页导入备份 → 跨 realm 写 → SW 缓存陈旧」这条路径可达。
**实测排除**：导入走的是 `src/background/mutationHandlers.ts:267` 的 `applyImportGroups`，
在 **SW realm 的单写者队列里**执行；写入方是 SW 自己 ⇒ SW 的缓存被自己失效。
⇒ 今天不可达。

**触发条件**：出现第二个 groups 写者上下文（options 页直接写 groups、第二个窗口、
或任何绕过 mutation 队列的写入）。修法 1 行：SW 启动时
`onGroupsChanged(() => invalidateGroupsCache())`（bus 的设计保证「收到广播只 emit 不再广播」，
不会形成消息风暴）。**但现在加它是纯成本无收益**，所以推迟。

**A3 —— 仍推迟**
`src/utils/storage.ts:445` `ensureVersion()` 每次调用做一次未缓存的 `kvGet`，
共 38 个调用点（`storage.ts:461/499/547/631/766/833/865` …）。它**不在**首屏关键路径上
（首屏实测里注入 1000 会话耗时 675ms，版本检查在其中不显著）。
**触发条件**：实测证明它出现在首屏关键路径，或某个调用点被搬进热路径。
在没有这个证据之前改它 = 纯重构，不符合「可量化收益优先」。

**A4 —— 现在能修**（本轮唯一一条「结构类」的可执行项）
`getGroupsFresh()`（`src/utils/storage.ts:567`）≡ `getGroupsForWrite()` 减去一次 flush。
现状：
- `src/services/syncEngine.ts:624` —— **唯一**生产调用点
- 其余命中全是注释（`storage.ts:1632/1661`）与测试（`tests/restoreConsumeStorageOutcome.test.ts:86`、
  `tests/storageKvConvergence.test.ts:349/355`）

⇒ **删掉它、把 `syncEngine.ts:624` 改成 `getGroupsForWrite()`，生产代码只改 1 行。**
风险极低、收益明确（消掉「少 flush 一次」这个会读到不含 pending 写的旧快照的入口）。
**安全顺序**：① 先在 `getGroupsForWrite` 上加一条守卫，断言 `syncEngine` 的读路径走的是
带 flush 的那个（钉数据流，不是钉字面量）；② 换调用点；③ 删 `getGroupsFresh`；
④ 改两个测试的调用；⑤ 跑全量测试。

**A5 —— 仍推迟（触发条件同 A2）**
注释（`src/utils/seqRegistry.ts:15-17`）说「不做 memo」，而 4 个注入点全是
`getGroups: () => storage.getGroups()`（30s 缓存读）：
`src/background/mutationService.ts:23`、`src/background/TabManager.ts:23`、
`src/sync-backend/index.ts:274`、`src/utils/supabase/upload.ts:70`。
今天不出事的原因与 A2 相同：只有 SW 写 groups。**触发条件与 A2 相同。**
修法与 A2 配套：一旦做了跨 realm 失效通道，这 4 处就该换成 `getGroupsForWrite()`；
**顺序不能反**（先做 A2，再做 A5；反了会得到「每次都重新读」的性能回退却没有正确性收益）。

### 1.2 同一语义在多处实现（B 组）

| ID | 上轮结论 | 本轮裁决 | 依据 |
|---|---|---|---|
| **B1** | ★★★ 适配器三个构造点，两个漏注入 P0 自检依赖 | **仍推迟，但**触发条件已具体化 | 见下 |
| **B2** | ★★☆「本组没加密成功」两后端口径相反 | **已不成立** | 见下 |
| **B3** | ★★☆ 同名空壳占位函数与真实现并存 | **现在能修（删）** | 见下 |
| **B4** | ★★☆ 两套独立加密实现，没有共享测试向量 | **仍推迟**（触发条件：格式迁移） | 见下 |
| **B5** | ★★☆ 协议与适配器有两条 import 路径 | **现在能修**（低优先） | 见下 |

**B1 —— 仍推迟，但触发条件从「模糊」变成「具体」**
`src/sync-backend/webdav/adapter.ts:270` 的兜底 `deps.peekDeviceSeq ?? (async () => 0)`
会静默地把 `adapter.ts:1919` 的 seq 时钟自检变成恒真。
现状：`src/sync-backend/index.ts:245` 是**唯一**注入点，它注入了真实现；
另外两个构造点（`src/sync-backend/webdav/adapter.ts` 自身与 `WebDavSettings.tsx:50`
直接 `new WebDavBackendAdapter`）不注入。

**触发条件**：**任何新增的适配器构造点**。这类点现在会静默拿到「时钟永远停在 0」，
而自检看不出来。低成本的自保：把 `peekDeviceSeq` 改成**必填**（构造参数里去掉 `?`），
让 TypeScript 在新增构造点时编译失败。这是一次纯类型收紧，零运行时影响 ⇒
**其实可以现在做**，但它会碰到 `WebDavSettings.tsx` 这个 UI 文件，属于「动我已有的东西」，
按规矩留给 lead 拍板。

**B2 —— 已不成立**
上轮记录：「Supabase 继续、WebDAV 中止」。
现在 `src/utils/supabase/upload.ts:931-935` 明确 `throw`：
「N 个标签组加密失败，已中止上传以避免明文上云」。
WebDAV 侧 `adapter.ts:1057` 的 `await vault.encrypt(payload)` 抛错会直接冒泡出
`writeShard` ⇒ 同样中止。
⇒ **两个后端现在都是 fail-closed，口径已统一。这条不必再做。**

**B3 —— 现在能修（删）**
`src/utils/faviconUtils.ts:123` 的 `migrateFaviconUrls()` 是空壳占位：
函数体只 `logInfo('开始迁移 favicon URLs...')` 然后注释「注意：实际的迁移逻辑将在调用此函数的地方实现」。
真正的 favicon 迁移在 `src/core/normalizeTabsData.ts` 一线。
⇒ 删掉这个空壳（或改成非 `migrate*` 语义的 `logInfo` 辅助）。
**先做全仓 grep 确认零调用点**再删；删完跑全量测试。

**B4 —— 仍推迟**
两套加密实现（`src/sync-backend/crypto.ts` 的自建存储 vault 与 Supabase 侧
`utils/supabase/upload.ts` 的 `encryptData`）确实没有共享测试向量，
但**它们的 salt 策略是刻意不同的**（`crypto.ts:98-108`）：自建存储每文件独立 salt，
云端每库一个 salt。⇒ **它们不是「同一语义的两份实现」，是「两种格式」。**
共享测试向量在这里没有意义（格式不同 ⇒ 向量必然不同）。
**触发条件**：将来做「一个库迁移到另一种格式」时，那时才需要向量。
本轮不改。

**B5 —— 现在能修，但收益低于成本**
`src/sync-backend/supabaseAdapter.ts:35` 走 `@/utils/supabaseFacade`，
`src/components/app/AuthProvider.tsx:5` 也走 facade —— 这条**已经收口了**（facade 存在）。
剩下的第二条路径是 `src/utils/supabase/upload.ts` 被直接 import。
⇒ 现状比上轮记录的更好。**本轮不报。**

### 1.3 模块边界错位（C 组）

| ID | 上轮结论 | 本轮裁决 | 依据 |
|---|---|---|---|
| **C1** | ★★★ `src/utils/` 反向依赖 React ⇒ React 进 SW | **现在能修**，收益已实测 | 见 §2 |
| **C2** | ★★☆ UI 越过门面直连 6 个后端内部模块 | **仍推迟**（触发条件：新增第 7 个直连） | 见下 |
| **C3** | ★★☆ store 层绕过 store 直连 storage | **仍推迟**（有意设计，缺机制） | 见下 |
| **C4** | ★☆☆ UI 层直连 storage 的唯一先例 | **已不成立** | 见下 |

**C2 —— 仍推迟**
`src/components/sync/WebDavSettings.tsx:48-73` 一次性 import 了 6 个后端内部模块
（`webdav/config` / `webdav/client` / `webdav/adapter` / `webdav/permission` /
`webdav/firstSyncDecision` / `webdav/libraryIdentity`）。
**触发条件**：新增第 7 个直连时，把门面（`src/sync-backend/index.ts`）扩成一个
真正覆盖这些能力的 API。现在扩门面 = 纯重构，收益不可量化 ⇒ 推迟。

**C3 —— 仍推迟**
`src/store/slices/tabSlice.ts:74` 直连 `@/utils/storage`。这是**有意的**（注释写明），
但确实缺机制防止下一个人再这么干。
**触发条件**：新增第 2 个 store slice 直连 storage 时，或引入 eslint 边界规则时。
本轮加规则 = 一次性成本换长期收益，但收益要到「下一个人」才兑现 ⇒ 不急。

**C4 —— 已不成立**
上轮说「UI 层直连 storage 的唯一先例」，理由是设置页在 UI 层直读。
现在 `src/options/optionsPageIa.ts` / `optionsAccount.ts` 已经把
「后端相关判断」抽成纯函数，UI 层只剩 **1 处** 直连（`OptionsPage.tsx` 取设置本身），
且那是**读自己的设置**，不构成跨层。⇒ 这条不必再动。

---

## 2. C1 专项：Service Worker 静态加载 React（实测）

### 2.1 上轮的诊断不完整

上轮结论是「把 `src/utils/toastHelper.ts` 移出 `src/utils/` 即可让 React 离开 SW」。
**实测证明这个结论是错的。** 原因在 `vite.config.ts:110` 的 `manualChunks`：

```ts
if (nm.includes('node_modules/@reduxjs/toolkit') || nm.includes('node_modules/react-redux')) {
  return 'redux-vendor';
}
```

`react-redux` 与 `@reduxjs/toolkit` 被塞进**同一个 chunk**。`react-redux` import `react`
⇒ 只要 SW 需要 `@reduxjs/toolkit`（它需要：`createSlice`），整个 `redux-vendor` 就把
`react-vendor` 拖进来。**chunk 级依赖，不是源码级依赖** —— 这是上轮漏掉的那一层。

同时 `vite.config.ts:118` 的 `nm.includes('src/utils/')` 把整个 `src/utils/` 变成一个 chunk，
其中 `src/utils/toastHelper.ts:6` 的 `import { useToast } from '@/contexts/ToastContext'`
把 React context 拖进 `utils` chunk。

⇒ **两条边各自独立地把 React 拖进 SW。必须同时剪断。**

### 2.2 实测数据（当前工作区构建，8 个变体逐一测量）

| 变体 | 改动 | SW 静态 import 图 | raw | gzip |
|---|---|---|---|---|
| **基线** | HEAD `cb6ac46` + 工作区 | 8 chunk | **596.2KB** | **182.0KB** |
| **A** | 只搬 `toastHelper` → `components/common/` | 8 chunk | 577.4KB | 176.8KB |
| **B** | 只把 `react-redux` 从 `redux-vendor` 拆出来 | 8 chunk | 592.4KB | 180.5KB |
| **C** | **两个都做** | **7 chunk** | **434.0KB** | **130.6KB** |

**收益：−162.2KB raw / −51.4KB gzip（−27.2% / −28.2%）**
`react-vendor`（139.6KB raw / 44.5KB gzip）**整个从 SW 图里消失**；
`react-redux-vendor`（3.7KB）也不在图里。

**单独做任何一个都几乎没用**：A 只省 5.2KB gzip，B 只省 1.5KB gzip，
一起做省 51.4KB gzip。**这就是「两个改动缺一不可」的量化证据。**

### 2.3 运行时效果：在噪声内 —— 必须如实说

| 指标 | 基线 | 变体 C | 判读 |
|---|---|---|---|
| SW 冷启动就绪中位数 | 984ms（3 批交错采样：984/1000/960，很紧） | 824 / 1591 / 1119ms | **噪声内，不能声称墙钟收益** |
| 隔离测得的模块求值耗时 | 5.8ms | 3.3ms | 绝对值太小，不是用户可感知的量 |
| popup 首屏体积门 | 258.6KB / 预算 260KB ✅ | 257.7KB / 预算 260KB ✅ | **不破预算**（仓库自带的 `scripts/report-bundle-size.mjs` 口径） |

**诚实的结论**：C1 的可量化收益是**字节与解析量**（SW 每次启动少 fetch+parse 162KB），
**不是墙钟时间**。冷启动测量里基线很稳（960–1000ms），变体反而更抖（824–1591ms），
这更像是机器噪声而不是收益。**不要拿「SW 启动快了 X ms」去汇报。**

### 2.4 最小改法（两个改动，各自独立可回滚）

```
改动 1：src/utils/toastHelper.ts → src/components/common/enhancedToast.ts
        三个导入方同步改：
          src/components/tabs/TabGroup.tsx:11
          src/components/tabs/useConsumeUndo.ts:23
          src/components/search/SearchResultList.tsx:9
        ⚠️ 文件里 `from './log'` 要改成 `from '@/utils/log'`（相对路径随目录变了）
        ⚠️ 它 import 了 `@/components/tabs/consumeUndoCopy` ⇒ 搬完 `components/common/`
           反向依赖 `components/tabs/`。这是搬动的代价，要写进注释。

改动 2：vite.config.ts 的 manualChunks
        把 react-redux 从 redux-vendor 里拆出来（单独成 chunk 或并入 react-vendor
        之外的其它命名），使 redux-vendor 不再 import react-vendor。
```

**安全迁移顺序**：
1. 先做改动 2（只动构建配置，零源码风险），构建并跑首屏体积门 —— 预期首屏略微上涨
   （`react-redux-vendor` 3.7KB 进了 popup 首屏），必须确认仍 ≤ 260KB。
2. 再做改动 1（3 个导入方），构建并确认 `react-vendor` 从 SW 图里消失。
3. 加**两条守卫**（这是关键，别省）：
   - 一条钉**数据流**：断言 `dist/service-worker.js` 的静态 import 图里**不含**任何
     名字含 `react` 的 chunk（用构建产物算图，不要用源码 grep —— 源码 grep 钉不住
     chunk 级依赖，这正是上轮漏判的原因）。
   - 一条钉**首屏预算**：仓库已有的 `scripts/report-bundle-size.mjs` 就是那道门，
     确认它在 `validate` 里被串起来（`package.json` 的 `validate` 脚本已含）。
4. 跑全量测试 + 真机装一次，确认 popup 与 SW 都正常（chunk 边界变动会影响动态 import，
   `vite.config.ts:99-104` 的注释里就有过「懒加载 chunk 被强行并进 vendor，dynamic import 失效」
   的历史事故）。

---

## 3. 任务二：性能实测

环境：Playwright + 真实 `dist/` 扩展（`--load-extension`），真实 IndexedDB 注入
1000 会话 × 5 标签 = 5000 标签；400×600 视口（popup 实际尺寸）。
数据规模：`GC=1000, TPG=5`。**全部数字是实测，不是估算。**

### ① 管理器页首屏可交互时间

方法：`page.reload()` → 等 `text=会话 1` 出现（列表已渲染）→ 等搜索框可见 →
点击并 `type('x')`（触发 onChange）⇒ 可交互。三次独立运行：

| 指标 | 第 1 次 | 第 2 次 | 第 3 次 | 中位数 |
|---|---|---|---|---|
| 首屏**可见** | 3747ms | 1661ms | 3205ms | **3205ms**（区间 1661–3747） |
| 首屏**可交互** | 4256ms | 2061ms | 3688ms | **3688ms** |

**方差很大（可见时间 2.3 倍差）**，这是本轮最诚实的数字形态：不要报单次值。
DOM 与内存（三次完全一致，说明渲染是确定性的）：

```
DOM: { nodes: 45222, cards: 1000, tabRows: 90, placeholders: 997, docH: 332172px }
首屏后堆内存: used 67.5–68.7MB / total 80.6–80.8MB
```

**判读**：虚拟化只作用在**标签行**这一层（5000 个标签只渲染了 90 行，其余 997 个占位），
**会话卡片本身 1000 个全部渲染** ⇒ DOM 45222 节点 ≈ 每会话 45 个节点。
首屏时间与 DOM 规模强相关，**优化点在会话卡片的虚拟化，不在标签行**。

### ② 1000 会话时的列表滚动

驱动方式：`requestAnimationFrame` 回调里每帧 `scrollTop += 300`（**每帧 300px**），
跑 200 帧。三次运行：

| 指标 | 第 1 次 | 第 2 次 | 第 3 次 |
|---|---|---|---|
| 平均帧间隔（rAF 实测） | 16.03ms | 10.68ms | 13.73ms |
| p95 帧间隔 | 27.7ms | 15.8ms | 25.7ms |
| **最大单帧间隙** | **282.5ms** | **240.7ms** | **261.3ms** |
| 滚动后堆内存 used | 69.6MB | 75.9MB | 67.0MB |
| 滚动后堆内存 total | 105.1MB | 92.2MB | 130.3MB |

**必须纠正一个我自己脚本的读数**：脚本打印的 `avgFps` 三次都**恰好是 50.0**
（`200 frames / 4001ms` 的固定窗口除法），**这是量法产物，不是应用的帧率**。
真实帧率看平均帧间隔 10.7–16.0ms ⇒ 在 headless 下跑得比 60fps 还快。
**不要把「50 FPS」写成发现。**

**真发现**：**最大单帧间隙 240–283ms**。这是滚动过程中的一次 ~250ms 卡顿。
（仅凭现有探针不能断定它是首帧布局、还是虚拟化换批重渲染、还是 GC —— 需要额外的
`PerformanceObserver` 长任务探针才能定位。**记为待定位项，不下结论。**）

**加载压力说明**：每帧 300px ≈ 真实滚轮每帧 16.7px 的 **18 倍**，
这是压力测试而非真实手感 ⇒ 结论只能用于「不卡顿」这个方向，不能反推真实体验。

### ③ 搜索输入 → 出结果的延迟（1000 会话 / 5000 标签）

方法：`search.fill(q)` → 等 `aria-label^="搜索结果"` 里的匹配数变化 → 强制双 rAF 重排。

| 查询 | 第 1 次 | 第 2 次 | 第 3 次 | 判读 |
|---|---|---|---|---|
| `watermark`（**首次**） | 490ms | 502ms | 495ms | **建索引成本，稳定 ~495ms** |
| `github`（命中多） | 245ms | 276ms | 180ms | 180–276ms |
| `ENG-1234`（命中少） | — | 81ms | — | ~81ms |
| `执行计划`（CJK） | — | 16ms | — | **16ms** |
| `zzz-no-match` | — | 15ms | — | 15ms |

**判读**：搜索是**每次全量重扫 5000 个标签**，不是增量索引 —— 命中越多越慢
（`github` 命中多 ⇒ 180–276ms；`执行计划` 命中少 ⇒ 16ms）。
**首次 495ms 是建索引成本，之后每次都在 15–276ms 之间，没有缓存命中。**
CJK 快是因为命中少且走了 `includes` 快路径，不是分词更好。

### ④ 同步一轮的耗时与内存峰值

**这一项分两半说，因为一半测得出来、一半测不出来。**

#### ④-a 请求放大（测得出来，且是产品级的真发现）

用**真实** `WebDavClient` + `WebDavBackendAdapter` 打**真实** dufs 0.47 服务器
（instrumented `fetchImpl` 抓全部请求）：

```
60 个会话 ⇒ 484 次 HTTP 往返
  GET 124 / PROPFIND 116 / PUT 63 / MKCOL 180 / DELETE 1
  ⇒ 平均 8.07 次往返 / 会话
```

**每个会话的固定流程（全部串行）**：
`GET 远端分片状态` → `PROPFIND` → `PUT` → `MKCOL ×3`（`adapter.ts:1061` 的
`mkdirp(groups/xx)` 逐级建目录）⇒ 1000 会话 = **约 8000 次串行 HTTP 往返**。

**其中 MKCOL 是纯浪费，且浪费得可量化**：
`src/sync-backend/webdav/layout.ts:100-103` 的分片路径是 `groups/<前2位>/<id>.json`
⇒ 前缀目录**最多 256 个**（2 位十六进制）+ 根 + `groups/` = **≤258 个不同目录**。
而 `adapter.ts:1061` **每个会话**都调一次 `mkdirp` ⇒ 1000 会话发 **3000 次 MKCOL**。
`client.ts:511-519` 把 405（目录已存在）当成功 ⇒ 这 2742 次是**纯往返、零收益**。

> ⚠️ **2026-10-26 更正（本段的两处事实已过期，测得的数据本身仍然有效）**：
> ① 分片目录的前缀位数已从 **2 位改成 1 位**（`layout.ts` 的 `shardDir`，
>    见 `docs/RELEASE-NOTES.md` 的 1.28.7 条目）；
> ② 上面那句「2 位十六进制 ⇒ 最多 256 个目录」**当时就推错了**：生产会话 id 是
>    `nanoid()`（64 字符表）⇒ 2 位前缀有 **4096** 种取值 ⇒ 1000 个会话约用到
>    **887** 个目录 ⇒ 一次全量扫描就超过坚果云「每 30 分钟 600 次」的上限。
>    （这正是 2026-10-26 那次改动的根因。）
> 老库的 2 位目录**不删**（删用户的目录 = 动用户的东西），适配器两种布局都认。

> **≥91.4% 的 MKCOL 流量是重复的。**
> 修法：在 adapter 里缓存「已知存在的目录」集合（`mkcol` 已经安全地吞掉 405），
> 1000 会话的 MKCOL 从 3000 次降到 ≤258 次 ⇒ **总请求数 8000 → 5258（−34%）**。

#### ④-b 一轮同步的耗时（测得出来）与 45s 超时的归因（必须说清）

```
10 组    176ms
50 组    732ms
100 组   挂住
1000 组  47769ms 后 WebDavRequestTimeoutError（45s 上限），已发 1480 次请求
```

**归因（这是我花最多力气的一格，因为第一版结论是错的）**：
最初我以为是产品的 bug。追下去发现：

- **不是 fd 泄漏**：dufs 的 fd 数在故障前后平坦（15–16）。
- **不是某一个动词的问题**：同一目录里裸请求在 ~2202–2277 次后失败，GET/PUT/MKCOL 都一样。
- **不是 keep-alive 的锅**：Node `http.Agent` 对同一个 dufs 跑满 3000 次请求没事。
- **对照组**：我自己写的 Node WebDAV 服务器跑同样的 600 轮 / 2403 请求，**843ms** 完成。

⇒ **~2200 次/目录 是 dufs 0.47 这个测试服务器自身的天花板，属于测试环境限制，
不是已确认的产品缺陷。** 我把它写进报告是为了标出「这个环境测不出 1000 会话的完整一轮」，
**不是**为了指控产品。（我第一版结论「扩展的 45s 超时是产品缺陷」是错的，已作废。）

#### ④-c 同步一轮的内存峰值 —— **没测出来，不给数字**

Playwright 的 `ctx.newCDPSession(sw)` 对 service_worker target 直接拒绝
（"page: expected Page or Frame"），`browser.newCDPSession` 也不存在；
SW realm 里 `performance.memory` 不存在。
⇒ 我用「import 图字节数」与「重复冷启动耗时」作为 SW 侧内存/耗时的**代理指标**，
并明确标注它们是代理不是测量值。**这一格没有实测数字，我不编。**

---

## 4. 任务三：同一语义在两处实现

扫描面：时间戳处理、URL 规范化、域名提取、会话命名、体积比较、排序、计数、ID 生成。

### 4.1 成立的分叉

**F1 ★★★ 墓碑读回判据：两个后端强度不同（Supabase 不校印记）**

两个**同名**的 `compareTombstoneReadback`：

| | 位置 | 判据 |
|---|---|---|
| 自带存储 | `src/core/remoteAdjudication.ts:127` | `isDeleted` **且** Lamport 印记 `(d, s)` 全等 |
| Supabase | `src/utils/supabase/readback.ts:288` | **只看** `is_deleted` + 「行缺失算不算达成」选项；**根本没有印记参数** |

**测试证据（两侧都有，反证力很强）**：
- `tests/backendParityDefects.test.ts:327-341` 断言 WebDAV 侧「印记对不上 ⇒ 不通过」
  （`lastOp {s:41}` vs 期望 `{s:42}` ⇒ `ok === false`）。
- `tests/syncReliabilityP0P1.test.ts:150-155` 断言 Supabase 侧只有三种输入：
  `is_deleted:true` ⇒ ok；行缺失 ⇒ 不 ok；`is_deleted:false` ⇒ 不 ok。
  **没有任何一条涉及印记。**

⇒ **同一次「删除已落盘」的判定，两个后端会给出不同答案**：
云端行被另一台设备重新盖过印记但 `is_deleted` 仍为 true 时，
Supabase 侧报「删除已落盘」，WebDAV 侧报「不是我要写的那一条」。
按仓库的既定基准（fail-closed，见 memory「两个后端的下载口径相反」），
**WebDAV 那侧是对的**。

**更糟的是注释在撒谎**：
- `src/core/remoteAdjudication.ts:16-18`：「两边的一致性由 `tests/backendParityAdjudication.test.ts`
  钉住（同一批输入必须给出同一结论）—— 漂移会让那条测试变红。」
  ⇒ **该文件不存在**（`ls tests/backendParityAdjudication.test.ts` → No such file）。
  真正存在的 `tests/backendParityDefects.test.ts:233` 只覆盖 `shouldConcedeToRemote`
  （「远端比我新吗」），**不覆盖 `compareTombstoneReadback`**。
- `src/sync-backend/ports.ts:252-255`：「两侧共用同一套**判据**
  （core/remoteAdjudication 的 compareTombstoneReadback），**不允许各写一份**。」
  ⇒ 事实是**两份**，且强度不同。
- `src/core/remoteAdjudication.ts:14-15` 诚实地承认「Supabase 侧…按本次任务约束**不得改动**，
  因此它暂时仍用自己的那一份」—— **但下一句就说「一致性由 parity 测试钉住」，而那个测试不存在。**

**归因**：这不是「忘了改」，是「上一轮任务不许改 Supabase 侧，于是留了一份弱判据，
并用一句不存在的测试给自己开了免罪」。现在那个约束已不存在。

**修法（不要直接动同步路径，按顺序）**：
1. 先写**判据差分测试**：同一批输入喂两个实现，列出所有结论不同的输入 ——
   **先量出差异有多大，再决定改哪边**。
2. 定基准：按 fail-closed 纪律，**Supabase 侧升到与 WebDAV 同强度**（补印记比较）。
   Supabase 行确实带印记（`upload.ts:854` 写 `last_op_device` / `last_op_seq`，
   `upload.ts:276-283` 已经会解析它）⇒ **数据已经在手边，只是没拿来比。**
3. 改 `readback.ts` 的签名（加印记期望）+ 改 `upload.ts:328` 的调用点。
4. 把 `remoteAdjudication.ts:16-18` 那句谎话改成实话，并把 parity 测试**真的写出来**
   （钉两个实现在同一批输入上结论一致 —— 这才是 ports.ts 承诺的东西）。
5. 全量测试 + 真机双设备验证。

**收益可量化**：删除意图一旦被云端覆盖而误判「已落盘」，**本地删除队列被消费** ⇒
被删会话复活且不可逆（1.22.0 起没有回收站）。这是「读失败变成写」的同一类。

**F2 ★★☆ 会话名筛选的 trim 口径不一致**

| 位置 | 口径 |
|---|---|
| `src/components/search/searchBrowseMode.ts:84` | `!!filters.groupName?.trim()` ⇒ 纯空白**不算**一个筛选 |
| `src/components/search/SearchFilterPanel.tsx:166-168` | `(raw ?? '').trim()` ⇒ 纯空白**不产** chip |
| `src/utils/search.ts:292` | `filters.groupName.toLowerCase()` ⇒ **不 trim**，纯空白照样参与过滤 |

中间那条链路的 `resolveEffectiveSearchFilters`
（`src/components/search/searchFilterAvailability.ts:46-52`）**只处理 `pinned`，不 trim 任何字段**。

**症状**：在「会话名」筛选框里输入一个空格 ⇒ 徽章显示「0 个筛选」、chip 不出现，
**但列表已经被筛过了**（凡是名字里没那个空格的会话都被排除）。
`searchBrowseMode.ts:78-80` 的注释恰恰写着「两处口径必须同源，否则会出现
『徽章说 0 个筛选、视图却已经按条件筛过了』」—— **说的就是这件事，发生了。**

**修法**：把 trim 收敛到一个地方。建议在 `resolveEffectiveSearchFilters` 里
把 `domain` / `groupName` 规范化成 trim 后的值，**所有**下游（徽章、chip、过滤）都吃
`effectiveFilters`，于是三者自动同源。1 处改动 + 1 条守卫（钉数据流：
`search.ts` 读的必须是 `effectiveFilters.groupName`）。

### 4.2 查了但确认一致 —— 不要重构

这一节是**为了防止下一个人重复做同样的扫描**：

| 语义 | 结论 |
|---|---|
| **「等 N 个」的计数** | `src/components/sync/syncPreviewView.tsx:459-473` 的 `renderPreviewNames`
  显示前 2 个名字，但总数用 `names.length`（**完整列表长度**）⇒ **显示的是真数量，不是截断数**。
  **我一度把它列为分叉，实测代码是对的 —— 已从发现清单删除。** |
| **域名提取** | `new URL(tab.url).hostname` 在 `src/utils/search.ts` 出现 4 次，
  但**同属一个文件、同一个语义**；而「域名怎么匹配筛选」「域名怎么显示」
  分别收敛在 `src/core/hostName.ts:133`（`hostMatchesDomainFilter`）与
  `:58`（`normalizeHostForDisplay`）。**已是单一真相源，不要动。** |
| **时间戳规范化** | `src/utils/syncPreview.ts:34-48` 已把 `2026-10-20T10:00:00.000Z` /
  `+00:00` / Postgres 文本三种写法规范化成毫秒数。**已解决。** |
| **排序** | round 42 已收敛到 `src/core/sessionSort.ts`，并**真的接上**了
  `TabList.tsx:359` 与 `SearchFilterPanel.tsx:228/530`。**已解决。** |
| **账号归属** | round 42 已收敛到 `src/core/accountScope.ts`，端口层有 `blockedAccountIds`。**已解决。** |
| **体积比较** | 未发现同一语义的两份实现。 |
| **ID 生成** | `src/utils/deviceUtils.ts:22`（设备 id）与 `src/core/contextOrigin.ts:17`
  （上下文 origin id）语义不同，不是分叉。 |

---

## 5. 任务四：死代码与「明确没接线」清单

分三类：
**① 真死代码（该删）** / **② 有意保留的零调用点（别动）** / **③ 该接线但没接的（最重要）**

### ③ 该接线但没接的 —— **本类最重要，上一轮漏掉的正是这一类**（排序）

**③-1 `validateSyncBackend` 自称「唯一校验点」，读路径不调它** ★★☆

- `src/utils/storage.ts:262-269` 定义它，注释（`:243`）写「同步后端标识的**校验单点**」。
- **全仓调用点只有测试**：`tests/webdavWiring.test.ts:166-172`。
  生产代码**零调用**（`grep -rn "validateSyncBackend" src/` 只命中定义处 + 两处注释）。
- 读路径 `getSettings`（`storage.ts:645-698`）校验了 `themeStyle` / `themeMode` /
  `syncIntervalMinutes` / `layoutMode` / `sessionSort`，**唯独没校验 `syncBackend`**。
- **同一个规则在另外两处手写**：`src/sync-backend/index.ts:136` 与 `:352` 都是
  `settings.syncBackend === 'webdav' ? 'webdav' : 'supabase'`。
- 写路径 `setSettings`（`storage.ts:803-815`）也校验了 4 个字段，**同样漏掉 `syncBackend`**。

⇒ **「单点」是假的，实际有三份实现（一份没接线），而读/写路径都不设防。**

**影响评估（诚实版）**：所有下游读者都 fail-safe
（`index.ts:136/352` 回落 `'supabase'`、`optionsPageIa.ts:41` 回落「折叠」、
`core/authGuard.ts:40`）⇒ **当前没有可复现的用户可见损坏**。
唯一可见症状：`OptionsPage.tsx:797/813` 两个单选按钮都靠
`settings.syncBackend === 'supabase'/'webdav'` 判定选中态 ⇒ 若本地存了脏值，
**两个按钮都不亮**。
**触发路径**：仓内所有写入方都只写 `'supabase'|'webdav'`；
导入路径走 `stripNonPortableSettings`（剔掉设备级键）；云端合并也剔 ⇒
**仓内无法产生脏值**，只能来自手工改存储或历史 bug 版本。

⇒ **价值真实但当前影响小；成本是 2 行。** 建议按「③」处理：
把 `validateSyncBackend` 接进 `getSettings` 与 `setSettings`（与其它 4 个字段同款），
并把 `index.ts:136/352` 改成调它 ⇒ 「单点」才成立。
**守卫**：断言 `getSettings()` 返回的 `syncBackend` ∈ {supabase, webdav}（钉不变量，不钉字面量）。

**③-2 `getGroupsFresh` 的注释与「三种读法」** —— 已在 §1.1 A4 展开（现在能修）。

**③-3 `migrateFaviconUrls` 空壳** —— 已在 §1.2 B3 展开（现在能修：删）。
这一条严格说属 ①（真死代码），但它的**名字**像在承诺一件已经迁走的事，
归到 ③ 是因为它「看起来接了线但没有」。

### ① 真死代码（该删）

| 符号 | 位置 | 说明 |
|---|---|---|
| `migrateFaviconUrls` | `src/utils/faviconUtils.ts:123` | 空壳占位，函数体只有 `logInfo` + 「实际逻辑在调用处实现」注释。真正的迁移在 `src/core/normalizeTabsData.ts`。**先 grep 确认零调用点再删。** |
| `VALID_SYNC_BACKENDS` | `src/utils/storage.ts:260` | 只被 `validateSyncBackend` 自己用（而后者只被测试用）。**跟着 ③-1 一起处理**：接上后就是活的。 |

### ② 有意保留的零调用点（别动）

- `src/utils/storage.ts` 的 `getGroupsFresh` —— **不属这一类**，见 A4。
- `computeVisibleChunks` —— 文件头已声明「有意保留的零调用点」（上一轮结论，本轮复核仍成立）。
- `src/core/remoteAdjudication.ts` 里 Supabase 侧暂不迁移的判据 —— **「有意保留」，
  但附带的 parity 测试承诺是假的**，见 F1。

### 本轮没查到的

「导出但外部零引用」的完整符号表上一轮已有（D3），本轮用类型检查器引用图复扫，
**没有新增的高价值条目**；已修掉的（A1 白名单、排序接线、账号闸门）在引用图里已不再是孤岛。

---

## 6. 任务五：模块边界

### 6.1 依赖方向与环

用自写脚本对 209 个模块做引用图 + **Tarjan SCC**：

> **循环依赖：0 个。**（单连通分量，无自环）

这与 round 42 的结论一致 —— 仓库的模块边界在**无环**这件事上是健康的。

### 6.2 反向依赖（低层 → 高层）

全仓只有**一条**低层模块依赖高层的边：

```
src/utils/toastHelper.ts:6  →  @/contexts/ToastContext   （低层 utils → React 层）
```

⇒ 这正是 C1。`src/utils/` 里的**其它**文件都没有依赖 React 层
（我扫过 `src/utils/` 全部 import，没有第二条）。
**修掉 C1 之后，「`src/utils/` 不反向依赖 UI 层」这条不变量就真正成立了** ——
现在它只差这一个文件。

⇒ **建议把这条不变量写成守卫**：静态扫 `src/utils/`（与 `src/core/`），
断言没有 import `@/components/**`、`@/contexts/**`、`react`、`react-redux`。
这是**低层不变量**，用静态扫描钉是可靠的（不像 chunk 级依赖需要看构建产物）。
但注意：**它不能替代 C1 的构建产物守卫** —— 那条边是 `manualChunks` 造出来的，
源码扫描看不见（这正是上轮漏判的原因，**两条守卫各管一段，缺一不可**）。

### 6.3 其它方向性问题（不改，只记）

- `src/components/sync/WebDavSettings.tsx:48-73` 直连 6 个后端内部模块（C2，仍推迟）。
- `src/store/slices/tabSlice.ts:74` store → storage（C3，仍推迟）。

---

## 7. 任务六：错误处理一致性

### 7.1 全仓 catch 普查

```
catch 总数: 286
  THROW（抛新错）  45
  RETHROW（原样抛）  2
  LOG（记日志后继续）104
  RETURN（记日志后返回）50
  OTHER（其它控制流）66
  EMPTY（静默吞掉）  19
```

**fail-closed 的既有正面先例**（值得保留，勿在重构中破坏）：
- `src/services/syncEngine.ts:259` —— 读失败时**重新抛出**，而不是跳过上传。
- `src/background/backgroundSync.ts:664/707` —— 失败时**中止本轮**，不吞。
- `src/sync-backend/index.ts:368/382` —— 后端被锁定时**中止**。
- `src/utils/supabase/upload.ts:931-935` —— 加密失败**中止整个上传**（B2 的依据）。

**fail-open 的既有先例**（有明确理由，不是缺陷）：
- `src/utils/storage.ts:725` —— 设置读取失败回落 `DEFAULT_SETTINGS`，
  注释写明「降级值永不参与上传」⇒ **降级值不会被带上云**，这是安全的方向。

### 7.2 19 个静默吞掉的 catch —— **逐条列出，无一遗漏**

**全部 19 个都有解释性注释**，且逐条核对后**没有一个是「忘了处理」**：

| # | 位置 | 吞掉的是什么 | 判读 |
|---|---|---|---|
| 1 | `src/background/TabManager.ts:395` | `new URL(url)` 解析失败 | 只影响日志里的 origin 占位符，**不影响拒绝打开的决定**（决定在 try 之前） |
| 2 | `src/background/backgroundSync.ts:166` | 发不出「需解锁」通知 | 注释：发不出去就下轮再试，不置标志，不抛错。**状态由 `LOCKED_BACKEND_NOTICE_KEY` 兜底** |
| 3 | `src/background/backgroundSync.ts:533` | 退避记账失败 | 注释：退避只是省流量，不该反过来阻塞同步 |
| 4 | `src/background/syncBackoff.ts:105` | 读不到退避状态 | 回落 EMPTY 状态 ⇒ 退避不生效 ⇒ **代价是多同步一轮，方向是安全的** |
| 5 | `src/background/syncBackoff.ts:118` | 写退避状态失败 | 退化为「下一轮进程内生效」 |
| 6 | `src/components/common/SafeFavicon.tsx:42` | `new URL(src)` 解析失败 | 只影响日志里的 safeLabel（**刻意不记完整 URL 以免泄露浏览记录**） |
| 7 | `src/services/syncEngine.ts:1067` | pending 检查失败 | 上传意图**仍由持久化 flag 保留** |
| 8 | `src/services/syncEngine.ts:1700` | 同上 | 同上 |
| 9 | `src/storage-kv/groupsChangedBus.ts:73` | `chrome.runtime.sendMessage` reject | 注释：没有接收方时 sendMessage 本来就会 reject ⇒ 吞掉是对的 |
| 10 | `src/storage-kv/indexedDbClient.ts:75` | `db.close()` 失败 | 已关闭则无事可做 |
| 11 | `src/storage-kv/indexedDbClient.ts:87` | `db?.close()` 失败 | 句柄即将被丢弃 |
| 12 | `src/storage-kv/indexedDbClient.ts:145` | `tx.abort()` 失败 | 多半已是死事务 |
| 13 | `src/sync-backend/webdav/adapter.ts:1660` | 读回墓碑内容失败 | **落到下面抛错** ⇒ **实际是 fail-closed**，只是形态上 catch 是空的 |
| 14 | `src/sync-backend/webdav/adapter.ts:2018` | 删探针文件失败 | 探针文件删除失败不抛错（只是个探针） |
| 15 | `src/sync-backend/webdav/client.ts:859` | `new URL(decoded)` 解析失败 | 保持原样 |
| 16 | `src/utils/diagnostics.ts:216` | PERF_FLUSH 消息往返失败 | best-effort：拿不到就用已落盘的部分，**不影响导出** |
| 17 | `src/utils/migrationUtils.ts:293` | —— | **不是静默吞**：该文件 `:295-300` 明确写了「错误不再在这里吞掉」，这里只是旧实现的收尾 |
| 18 | `src/utils/search.ts:233` | `new URL(tab.url)` 解析失败 | 建议生成里忽略非法 URL |
| 19 | `src/utils/search.ts:267` | `new URL(tab.url)` 解析失败 | 同上 |

**结论**：**19 个全部有意、全部有注释、全部不造成数据损坏。**
唯一值得提一句的是 **#13**：它的语义是 fail-closed（下面会抛），但形态上「空 catch」
会让人误判为吞错。⇒ 如果要加一条**风格守卫**（「空 catch 必须紧邻一条 throw」），
#13 需要显式写成 `catch { /* 落到下面抛错 */ } throw ...` 的形态。

**两个小观察（非缺陷）**：
- #18/#19 的注释是英文，仓库其它注释都是中文 ⇒ 不一致，但不影响行为。
- #1 与 #6 是**同一个模式的两份实现**（解析 URL 失败时保留占位 origin）——
  这不是「同一语义两处实现」的分叉（两处都在 UI/SW 两端，语义一致），但可以抽成一个
  `safeOrigin(url)` 小工具。**收益小，不值得单独做。**

---

## 8. 建议的优先级与执行顺序

### P0 —— 先做，收益最大且不碰同步路径

1. **F1 墓碑读回判据统一**（Supabase 侧补印记比较）。
   顺序：① 先写判据差分测试量出差异 → ② Supabase 侧补印记比较 →
   ③ 把 `remoteAdjudication.ts:16-18` 的假 parity 测试承诺改成实话并**真的写出来** →
   ④ 改 `ports.ts:252-255` 的措辞 → ⑤ 全量测试 + 真机双设备。
2. **C1 Service Worker 去 React**。
   顺序：① 先改 `vite.config.ts` 的 `manualChunks` → ② 确认首屏体积门仍 ≤260KB →
   ③ 再搬 `toastHelper.ts` → ④ 加两条守卫（构建产物图 + `src/utils/` 静态不变量）→ ⑤ 真机装一次。

### P1 —— 有实测数字支撑

3. **同步请求放大**：给 adapter 加「已知目录」缓存 ⇒ MKCOL 3000 → ≤258（−91.4%），
   总请求 8000 → 5258（−34%）。
   **先做这个再考虑并发化**：并发能压总时长，但把 8000 次请求变成 8000 次请求只是更快地打满
   同一个服务器；先减请求数，收益更大、风险更小。
4. **会话卡片虚拟化**：1000 会话 ⇒ DOM 45222 节点、首屏可见中位数 3205ms。
   标签行已经虚拟化了（5000 标签只渲染 90 行），**会话卡片没有** ⇒ 这是首屏的主成本。

### P2 —— 便宜、孤立、收益小但明确

5. **A4 删 `getGroupsFresh`**（生产改 1 行 + 守卫）。
6. **F2 会话名筛选 trim 收敛**（1 处改动 + 1 条守卫）。
7. **③-1 接上 `validateSyncBackend`**（2 行 + 1 条守卫）。
8. **B3 删 `migrateFaviconUrls` 空壳**。

### 仍推迟（带触发条件）

- **A2 / A5**：出现第二个 groups 写者上下文时（先 A2 后 A5，顺序不能反）。
- **A3**：实测证明 `ensureVersion` 进入首屏关键路径时。
- **B1**：新增适配器构造点时（最低成本的预防：把 `peekDeviceSeq` 改成必填）。
- **C2**：新增第 7 个后端内部模块直连时。
- **C3**：新增第 2 个 store slice 直连 storage 时，或引入 eslint 边界规则时。

### 已不成立，不必再做

- **A6**（round 42 已修）、**B2**（两后端现已统一 fail-closed）、
  **C4**（UI 层已无跨层直连）、**上轮 D1/D2/D3**（round 42 已处理）、
  **B5**（facade 已收口，剩余路径不是分叉）。

---

## 9. 本轮明确**没有**测到的东西（如实记录）

1. **同步一轮的内存峰值** —— Playwright 无法对 service_worker target 挂 CDP session，
   SW realm 也没有 `performance.memory`。只给了字节数与冷启动耗时作为**代理指标**。
2. **1000 会话完整一轮同步的端到端时长** —— dufs 0.47 在同一目录约 2200 次请求后
   自己卡住（对照实验：我自写的 Node WebDAV 服务器 2403 请求 843ms 完成），
   ⇒ 这是**测试环境天花板**，不是产品缺陷，也不是产品的成绩。**不给数字。**
3. **滚动时 ~250ms 最大帧间隙的成因** —— 只有 rAF 间隔探针，没有
   `PerformanceObserver` 长任务探针 ⇒ **记为待定位项，不下结论**。
4. **C1 的墙钟收益** —— 冷启动采样里变体比基线更抖（824–1591ms vs 960–1000ms），
   **不能声称更快**。C1 的收益是字节与解析量。
5. **首屏时间的单值** —— 三次采样 1661/3205/3747ms，方差大，**报区间与中位数，不报单值**。

---

*本文件由 round 43 架构与性能审查员产出；`src/` 与 `tests/` 未被本轮改动。*
