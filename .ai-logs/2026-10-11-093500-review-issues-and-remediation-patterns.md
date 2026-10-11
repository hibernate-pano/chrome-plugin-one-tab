# 2026-10-11 09:35 — 本次审查的问题清单与整改方案（学习用）

> 配套记录：`.ai-logs/2026-10-11-092500-review-and-fix-drag-sync-watermark.md`（本次会话的过程流水）。
> 本文件是**问题导向的提炼**：每个问题按「现象 → 根因链 → 证据 → 整改（含为什么不那样改）
> → 守卫（含变异验证）→ 可迁移教训」记录。目标是半年后遇到同类形状能直接对上号。

## 背景一句话

审查对象是 Jasper 那一轮 +1506 行改动（拖拽转正 / 同步修复 / 质量门禁）。
基线：单测 1081 全绿、双 type-check 全绿、双 lint 全绿；既有关键守卫先做变异验证确认是真红。
本轮共发现 4 个代码问题 + 1 个自己引入的 bug + 1 个环境问题。

---

## Issue 1 [P0] 增量上传水位会永久漏传 —— 新数据静默丢失

### 现象（用户视角）

用户点「清除本地数据」后新建会话，该会话**永远不上云**；下一次下载合并时云端旧行
seq 更大（LWW 云端赢），**新建的会话被静默覆盖消失**。全程 UI 报「同步成功」。
v1.22.0 起无回收站、无撤销 ⇒ 这就是静默数据丢失。

### 根因链（5 步，每一步都已在代码中定位）

1. F2 增量上传把水位存成**裸整数**，键 `supabase_sync_watermark_seq` 全局唯一
   （`src/utils/supabase/syncWatermark.ts`，修复前全文 21 行就是一个常量导出）。
2. `storage.clear()`（`src/utils/storage.ts:1188`）按 `Object.values(STORAGE_KEYS)` 删键：
   `DEVICE_SEQ` **在**表里 → 被清零；水位**不在**表里 → **存活**。
3. 用户新建会话 → `seqRegistry.current()`（`src/utils/seqRegistry.ts:64`）
   = max(DEVICE_SEQ=0, 观察到的印记=空) → `nextSeq()` 从 **1** 重启 → 新组 `lastOp.s = 1`。
4. `selectDirtyGroupsForUpload(groups, 5000)`（`src/utils/supabase/upload.ts:309`）
   判 `1 > 5000` 为假 → **跳过**。
5. 新组永远不上云；下次合并云端赢 → 本地新组被覆盖。永不自愈（水位只增不减，
   seq 计数器只增不减，但这里计数器被清零重启了 —— **单调性假设被外部破坏**）。

### 证据（探针实证，不是读代码猜的）

探针 1（`/tmp/otprobe/probe_watermark.mjs`，已归档结论进本文件）：

```
── 用户点「清除本地数据」──
  DEVICE_SEQ    → 0        （在 STORAGE_KEYS 里，被 clear() 删除）
  watermark     → 5000     （不在 STORAGE_KEYS 里，存活！）
── 用户新建一个会话 ──
  新组 lastOp.s = 1 （从 1 重启）
  selectDirtyGroupsForUpload → 0 个组
  ❌ 新组被永久跳过 —— 永远不上传
```

### 关键判断：为什么「只按账号寻址」堵不住它

探针 2（`/tmp/otprobe/probe_wm2.mjs`）专门验证了这个直觉上最省事的修法：

```
按账号寻址后，同账号清数据场景：上行 0 组 → ❌ 仍漏传
```

按账号寻址堵的是「换账号带旧水位」（账号 A 水位 5000 遮蔽账号 B 的新组），
但清数据路径是**同一账号**内的事：水位照样是 5000，seq 照样从 1 重启。
**修法必须两处、缺一不可** —— 这是本 issue 最值得记住的判断。

### 整改（文件：行号为修后位置）

`src/utils/supabase/syncWatermark.ts`（全文重写，21 行 → 约 90 行，注释占大半）：

- A. **键名按 userId 寻址**：`syncWatermarkKey(userId)`（:63），旧裸键保留为
  `LEGACY_SYNC_WATERMARK_KEY`（:67）仅供迁移说明。旧值因键名不带账号后缀而根本读不到
  → 读作未设置 → 全量一次 → 以新格式写入（自动迁移，无需清理动作）。
- B. **水位值绑定 deviceSeq 基线**：`SyncWatermark { seq, deviceSeq }`（:76）。
  读取时若当前计数器 < 存下的基线 = **seq 时钟回退** → 弃用水位当 0（全量）。
  方向论证写在文件头：写入时两者来自同一次推进，正常必 `deviceSeq ≥ seq`；
  只有计数器回退（清数据/丢键/手改）才触发作废 —— 而那正是必须作废的时刻。

`src/utils/supabase/upload.ts`：

- `loadSyncWatermark(userId, currentDeviceSeq)`（:54）：形状不符 → 0；时钟回退 → 告警 + 0；
  读失败 → 0（沿用「不能抛，抛会让上传整体失败」的纪律）。
- `saveSyncWatermark(userId, seq, deviceSeq)`（:83）：写失败照旧抛错
  （保守方向 = 下轮全量重传，绝不谎报已同步）。
- 读取点（:508-509）：`deviceSeq` 取自与墓碑**同一个** `tombstoneSeq` registry
  （同 key、同推导规则，注释已说明为什么必须同源）；
  写入点（:932-933）：取**写入这一刻**的计数器，不能复用读取时的旧快照
  （本次上行本身可能推进了计数器）。

**为什么不把水位塞进 STORAGE_KEYS 让 clear() 顺带清掉**：那张表的语义是用户数据，
水位是按账号寻址的推导量；且 storage 层拿不到 userId，要清就得引入 KV 层未承诺的
「按前缀枚举删除」。而风险已由时钟回退校验消除 —— 为已不存在的风险加复杂度是错的。
这个「为什么不」写在了 `storage.clear()` 的注释里（`src/utils/storage.ts:1196-1208`），
免得后人当成遗漏补一刀。

### 守卫（`tests/syncWatermarkClockRegression.test.ts`，10 条）

- 键名按账号寻址（两条：键名不同 + A 的水位不遮蔽 B 的新组）；
- 时钟回退 ⇒ 水位归 0 ⇒ seq=1 的新组照样上行（核心回归）；
- 反向防线：时钟未回退时水位照常生效（防「恒返回 0 把 F2 还原成全量」的实现作弊）；
- `nextSyncWatermark` 取 max；
- 结构层：upload.ts 必须传 userId、必须带 deviceSeq、必须用 `peekDeviceSeq`（见 Issue 5）、
  日志必须遍历 `candidateGroups`（见 Issue 4）。

变异验证（3 处，全部确认变红）：回退校验改 `if (false)` → 红；键名改回全局常量 → 红 2 条；
日志改回 `groups.forEach` → 红。

### 可迁移教训

1. **任何「比较基准」型的持久化值，必须同时存它的基准有效性**。裸整数水位假设了
   「seq 计数器永不回退」，而这个假设可以被 `clear()`、`换账号`、KV 迁移从外部打破。
   下次看到「存一个数、下次拿它做闸门」的设计，第一问就是：**这个数的坐标系会不会变？**
   坐标系会变 → 值必须自带坐标系校验（这里是 deviceSeq 基线）。
2. **fail-closed 必须只往「多传/多做」的方向失败**。水位丢失 → 全量（多传）是对的；
   若当初写成「读不到水位就当没有未同步的东西」，Issue 1 会提前以更惨的方式发生。
   每个闸门都要问：它失效时偏向哪边？偏向「少做」的一边就是数据丢失。
3. **修法要先证「最省事的方案为什么不够」**。本 issue 若只做 A（按账号寻址），
   清数据路径原样保留 —— 而 A 恰好是第一眼最想做的。探针 2 的价值就是把这条否决
   写成可复现的证据，而不是一句「我觉得不够」。

---

## Issue 2 [P1] moveTab 回滚会让在途删除的 tab 复活

### 现象

这轮改动已经防住了**组级**交叉（`liveIds` 过滤，注释写得很清楚），但只挡了组这一层。
组内 tab 的在途删除不在过滤范围内。探针复现（`tests/__probe_cross.test.ts`，临时文件，
验证后已删除，断言已并入正式用例）：

```
after-delete g2 = ["b","f"]        ← 用户删掉了 e
after-rollback g2 = ["e","f"]      ← moveTab 写失败整体换回，e 复活了
```

### 根因

`moveTabAndSync.rejected`（`src/store/slices/tabSlice.ts:902`）按快照**整体**换回 `groups`。
快照是写入前那一刻的完整真值，天然包含「之后被在途删除拿掉的 tab」。
组级用 `liveIds` 挡了，但 tab 级没有对应的剥离 —— **交叉要按粒度穷举，防了组级 ≠ 防了 tab 级**。

### 整改

换回后再走一遍已有的 `stripInFlightDeletions`
（`src/store/slices/tabSlice.ts:930-935`，helper 在 `src/store/slices/tabSliceHelpers.ts:32`）：

```ts
const restored = snapshot.filter(g => liveIds.has(g.id));
const inFlightTabBackups = Object.values(state.optimisticBackups ?? {});
const inFlightGroupIds = Object.values(state.deletedGroupBackups ?? {}).map(b => b.group.id);
state.groups = stripInFlightDeletions(restored, inFlightTabBackups, inFlightGroupIds);
```

**为什么复用而不是另写一份 tab 级过滤**：那个 helper 本来就是为「快照/回环里不得让
在途删除项复活」写的，且同时覆盖 tab 级（`optimisticBackups`）与组级两层。
本 reducer 只负责「换回本次写入前的顺序」，在途意图交给那个单点判据 ——
两处各写一份过滤，半年后就是一次「同判据两处漂移」（mutationOps 里已有过一次同类事故，
注释里记着）。

### 守卫（`tests/moveTabRollback.test.ts`，新增 2 条，共 7 条）

- `P1：在途被删除的 tab 不得被回滚复活` —— 上面探针的正式版；
- `P1：回滚不得误删「锁定的空组」` —— 反向防线：locked + 0 tabs 是合法状态
  （`applyRemoveTab` 走锁定豁免留下的），`stripInFlightDeletions` 的「剥空后整组丢弃」
  分支（`tabs.length === 0 && g.tabs.length > 0` 才丢）不应命中它。

变异验证：去掉 `stripInFlightDeletions` 调用 → 核心用例变红。

### 可迁移教训

1. **整体快照回滚 = 把过去完整搬回来，必须先剥离「过去之后发生的事」**。
   公式：`回滚结果 = 快照 − 快照之后已生效的在途意图`。只做前半句就是复活 bug。
2. **交叉场景按「操作 × 粒度」矩阵穷举**：moveTab 回滚 × {组删除，tab 删除，改名，锁定}。
   本轮只验了组删除。另外两个（改名/锁定在途时回滚）目前无复活风险（回滚只碰顺序，
   不碰名字/锁定位），但矩阵本身要留在心里。
3. **反向用例和正向用例同等重要**：没有「锁定空组不得误删」那条，
   「恒剥离」的实现（见什么都删）也能通过正向用例。

---

## Issue 3 [P1] HoverProbe 的 sourceGroupId/sourceIndex 是死字段

### 现象

不是 bug，是**bug 的形状**。`resolveHover`（`src/components/dnd/dragSession.ts:144`）
从头到尾只读 `session.anchor`，从不读探针上的 `sourceGroupId/sourceIndex`
（探针确认：`resolveHover 读 probe.sourceGroupId ? false`）。
但调用方**必须**为死字段编值，而 `DraggableTab.tsx:194` 实测编的是**落点行**的下标 ——
正是 P1「拖 b 搬走 a」那个 bug 的取值。

危险链：将来谁「顺手」让 resolveHover 改读这两个字段 → 20+ 条测试**照样全绿**
（它们喂的值看起来都对）→ P1 以「拖 b 搬走 a」的形态复活 → 经 applyMoveTab 正常落盘
并上传云端，无回收站、无撤销。

### 整改

**删字段，不是加注释**（`src/components/dnd/dragSession.ts:119`，`HoverProbe` 只剩
`rect + clientY`；`targetIndex` 一并删除，它与 `target.index` 重复，同属「两个真值」
的结构性风险）。调用方同步删除传参（`DraggableTab.tsx:194`）。

为什么删比注释可靠：注释是提醒，类型是约束。删掉之后，想读源下标只有
`session.anchor` 一条路 —— P1 在类型层面无处可藏。注释会过期，类型不会。

### 守卫（`tests/dragSession.test.ts` 新增 1 条结构用例，共 15 条）

三层断言，对应「死字段复活」的三条路径：

1. 形状层：`HoverProbe` 接口文本里不得出现三个字段，必须保留 `rect/clientY`；
2. 实现层：`resolveHover` 函数体不得读 `probe.source*`/`probe.targetIndex`，
   必须读 `session.anchor.*`；
3. 调用方层：`DraggableTab` 构造探针的调用点不得再传这三个字段。

变异验证：把 `sourceIndex` 塞回接口 → 结构用例变红。

### 可迁移教训

1. **死字段比缺字段危险**：缺字段编译就挂；死字段编译通过、测试全绿，
   却在类型系统里留了一个「看起来该用」的坑。下次 code review 看到「传了但没人读」
   的参数，默认动作应该是删，不是留。
2. **P0/P1 级的根因要用结构断言钉住，而不仅是行为断言**。行为测试只能证明
   「现在是对的」，结构断言才能证明「错的那条路不存在」。本仓已有先例
   （P0 的 `getData` 不得出现断言），这次是把同一手法用在 P1 上。
3. **「两个真值」是结构性风险**：`targetIndex` vs `target.index`、
   `probe.sourceIndex` vs `session.anchor.index` —— 凡是同一语义有两个来源，
   它们迟早分叉。收敛到一个。

---

## Issue 4 [P2] 上传日志遍历全量 groups，口径与行为分叉

### 现象

`uploadTabGroups` 里增量闸门算出 `candidateGroups`（真正上行的集合），
但紧接着的逐组日志 `groups.forEach` + `${groups.length}` 分母用的还是全量。
控制台出现「要上传 N 个组」而 N 是全量数 —— **排障依据与实际行为分叉**，
会据此误判「增量判据没生效」。

### 整改（`src/utils/supabase/upload.ts`）

- 逐组日志改遍历 `candidateGroups`（分母同步）；
- 头部「要上传的数据：N 个标签组」改成「本地共有 N 个标签组（实际上行数由下方增量闸门决定）」
  —— 它出现在闸门计算**之前**，诚实写法是说明它是全量数；
- 顺手修掉 diff 里一行尾随空格（`489:` 那行）。

### 守卫

`tests/syncWatermarkClockRegression.test.ts` 结构层用例：
`candidateGroups.forEach` + `candidateGroups.length` 必须出现。
变异验证：改回 `groups.forEach` → 变红。

### 可迁移教训

**日志的遍历对象必须与行为的入参同源**。日志不是注释，不 Bordelais ——
它是排障时会被当成事实读的东西。分叉的日志比没有日志更糟（没有日志只是多花时间，
分叉的日志直接指向错误结论）。Review 时看到日志循环，问一句：它遍历的是
「实际发生的集合」还是「进来时的全量」？

---

## Issue 5 [复盘] 我自己引入的 bug：getDeviceSeq 的写副作用

### 现象

修完 Issue 1 跑全量，1 个失败：
`overwriteTombstoneDoubleWrite` 的见证用例 seq 从 6 变 7。

### 根因

我为水位自洽性校验调了 `tombstoneSeq.getDeviceSeq()`。
它走 `current()`（`src/utils/seqRegistry.ts:64`），而 `current()` 在
「观察到的全网最大印记 > 持久化值」时会 `kvSet` **把下限写回**。
于是「只是看一眼计数器」的纯读意图，在磁盘上留下持久化副作用 ——
提前把 `device_seq` 钉到观察最大值，紧随其后的墓碑取号多跳一级。

语义上不算错（Lamport 只要求单调），但**观测不该变成变更**：
只需要读数的调用方没有资格改计数器。

### 整改

给 `SeqRegistry` 加真正无副作用的 `peekDeviceSeq()`（`src/utils/seqRegistry.ts:96`），
upload.ts 两处调用点改用它（:508、:932）。`getDeviceSeq` 保留原有「修复并写回」语义
（对照用例钉住它没被改掉）。

### 守卫（`tests/seqRegistry.test.ts` 新增 3 条，共 12 条）

- 持久化值落后时 peek 返回修复读数但**不写回**（核心）；
- 无印记时读持久化值且不写；
- 键不存在时返回 0 且**不凭空创建**。

变异验证：让 peek 走 `current()` → 核心用例变红。

### 可迁移教训

1. **任何名为 get/read/peek 的函数，先看它调不调用 kvSet**。本仓 `current()` 的写回
   是有意设计（防回退的地板），但它藏在一个读名字后面 —— 调用方不读实现就会中招。
   命名上 `getDeviceSeq` vs `peekDeviceSeq` 现在把「读并修复」和「只读」区分开了，
   后人选错的概率小一半。
2. **全量测试是最后防线，而且它真的接住了**。如果我只跑了改动相关的几个测试文件，
   这个副作用会悄悄上线（seq 多跳一级，单调性仍成立，行为测试全绿）。
   跨文件的副作用只能靠全量跑出来 —— 这就是 `pnpm test` 必须整仓跑的理由。
3. **修 P0 时引入 P2 级副作用是常态**：动的是同一条 seq 链。修完必须全量跑，
   不能只跑「我改的那几个文件」。

---

## Issue 6 [环境] E2E 11/14 失败 —— Supabase 配额耗尽，与本次改动无关

### 现象

`pnpm e2e` 3/14 通过。第一反应是「我的改动把 E2E 打红了」。

### 定因过程（没有猜）

1. 看失败模式：大量 `page.waitForSelector ... 手动上传本地会话到云端 ... Timeout`，
   往上翻看到 `AuthApiError: ... exceed_egress_quota ... must upgrade their plan`。
2. 交叉验证：3 个 PASS 的**恰好**是标注「不登录、不连云端」的纯本地脚本
   （`e2e-tab-reorder`、`e2e-layout-column-split`、`e2e-clean-dup-import-fix`）。
3. 干净基线对照：`git stash` 掉全部改动，在干净 HEAD 上重跑 `e2e-sync-test.mjs`，
   **失败一模一样**（同样的 `exceed_egress_quota` + 同样的 selector 超时）。
4. 结论：环境问题，需要 Supabase 项目所有者升级套餐或移除 spend cap。

### 可迁移教训

1. **「是不是我改坏的」必须用干净基线回答，不能用「看起来像」回答**。
   `git stash` + 重跑单个脚本只花了几分钟，但它把「回归」和「环境」彻底分开。
   没有这一步，我要么背一个不存在的锅去改代码，要么把真回归误判成环境。
2. **E2E 失败先看账号/配额/网络这三样**，再看产品逻辑。本仓 E2E 强依赖
   真实 Supabase（每个脚本注册测试账号），`exceed_egress_quota` 会让所有需登录脚本
   以同一种 selector 超时形态倒下 —— 形态高度一致本身就是环境问题的信号。
3. 纯本地 E2E（`e2e-tab-reorder` 8/8 通过）在云端挂掉时依然证明了拖拽转正的正确性 ——
   **按依赖分层的 E2E 设计是对的**：云端挂了，本地语义的验证不受影响。

---
