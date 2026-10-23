# AI Log：chrome-plugin-one-tab 深度体检（第 51 轮之后）

- 时间：2026-10-23 14:50
- 触发：Jasper 要求「看看我最近做了什么，对现有代码做个深入的体检」
- 仓库：`/Users/panbo/Code/Demos/chrome-plugin-one-tab`
- 审计基线：`f277835`（第 51 轮，2026-10-23 05:21）

## 1. 对话出发点

Jasper 的原话是「看看我最近做了什么，对现有代码做个深入的体检」。

从仓库自身的痕迹看，「最近」= 第 41–51 轮（2026-10-21 至 2026-10-23），
共约 50 个提交、566 个文件、+118424 行。三天内的主题高度集中：
**没有新功能，全是「界面在说谎 / 结构在自欺」的收口**。

我的判断：这次体检的重点不应该是「再挑一批新毛病」，
而是**「这一轮密集的自我修正本身，有没有留下新的不一致」**。
理由：这种高密度改动的真实风险不在单点，而在**同一族缺陷只修了一处**。

## 2. 执行过程

### 2.1 先确认「工作区是移动目标」

`git status` 有一个未跟踪文件 `tests/guards/_tmpSyncOutage.test.ts`（mtime 13:36），
内容是「第 52 轮」的临时实验。`.memory/external-auto-commit-during-agent-work.md`
明确记着「这台机器上有并发 agent 会话在改同一个仓库」。

⇒ **决策：不在真仓库里动手**。全部验证在 `git archive HEAD` 出来的
`/tmp/onetab-audit-*` 沙箱里做（node_modules 用 symlink）。
探针文件、变异改动、沙箱目录，结束时全部清掉。原始仓库全程只读。

### 2.2 跑了什么门禁（沙箱，HEAD 快照）

| 门禁 | 结果 |
|---|---|
| `node --test tests/**/*.test.ts` | **4505 pass / 0 fail / 1 skip**（4506 用例，1087 suite，320 秒） |
| `tsc --noEmit` | 通过 |
| `tsc -p tsconfig.test.json --noEmit` | 通过 |
| `eslint src` + `eslint tests` | 通过（0 warning） |
| `vite build` | 通过 |
| 首屏体积 | **182.6KB / 预算 185KB** ✅ |

⇒ **基线是干净的**。下面所有问题都是「绿灯底下」的问题。

### 2.3 变异探针：把「已修好的东西」改坏，看谁会红

按本仓纪律（`.memory/mutation-can-fail-to-apply.md`），先证明变异真的落地：

    old = "const { data: { user }, error: userError } = await supabase.auth.getUser();"
    assert s.count(old) == 2   # ← 前提自证

变异：`download.ts` 两处**裸 `getUser()`** 全部拆掉。

结果：

- **全量 4508 用例 ⇒ 67 个 fail** ⇒ 整体是有检测力的；
- **但 `authOutageUserFacing` / `authSessionSurvivesOutage` /
  `backendUnavailableHonesty` / `authVerdictHonesty` 四个守卫 ⇒ 49 个全绿**。

⇒ **专门守「云端故障期间会话不许被删」的那一族守卫，对
「download.ts 的核账号没走闸门」完全瞎**。这就是盲区。

### 2.4 探针：量出真实等待时间

三个探针，逐步排除 mock 自身的影响：

1. **探针 1**（云端 402）：`downloadTabGroups()` 只打了 `/auth/v1/health`，
   17ms 就抛 `BackendUnavailableError` ⇒ **主防线有效**，会话令牌还在。
2. **探针 2**（断网 + 本地会话未过期，mock 无视 abort）：耗时 **60.4 秒**。
   ⇒ 这个数字**不可信**（mock 不理 abort，SDK 的超时压根没生效）。
3. **探针 3**（同场景，mock 尊重 `AbortSignal`）：耗时 **45.0 秒**
   ⇒ **真值 = SDK 自带的 45 秒上限**（`client.ts` 的 `fetchWithTimeout`）。

### 2.5 对照实验：同场景下「已修的那条路」拖多久

探针 4，同一个网络（探活失败 ⇒ unknown ⇒ 放行；`/auth/v1/user` 挂住），
两条路并排跑：

    [A requireSessionUserId  ] 耗时 5013 ms   <- 第 52 轮刚修的那条
    [B downloadTabGroups     ] 耗时 45003 ms  <- 没修的那条

⇒ **9 倍差距**。同一份代码、同一场景、同一种故障，
一条 5 秒给出一句对的话，另一条 45 秒才放弃。

## 3. 遇到的问题

### 3.1 真缺陷：`download.ts` 的核账号绕过了三道闸门（P1）

**位置**：`src/utils/supabase/download.ts:240`（`downloadTabGroups`）
与 `:669`（`downloadSettings`）—— 两处**裸 `supabase.auth.getUser()`**。

第 51 轮把「读会话」收口成了唯一入口 `sessionRead.ts`
（先问云端在吗 → 5 秒上限 → 失败原样带出），
第 52 轮又给「核账号」这一层补上了同样的闸门
（`src/utils/supabase/session.ts:79` 的 `requireCloudAvailable` +
`:81` 的 `withDeadline`）。

**但 `download.ts` 的两处没跟上** —— 它走的是 `supabase.auth.getUser()`，
不是 `requireSessionUserId()`。

**后果链**（探针实测）：

1. 断网 ⇒ 探活 `/auth/v1/health` 连不上 ⇒ 判「**不知道**」⇒ **放行**
   （这一档放行是**对的**：本地会话没过期时，SDK 读它根本不需要联网）；
2. 本地会话没过期 ⇒ `getSession()` 从存储直接读出，**不需要联网** ⇒ 通过；
3. 然后裸 `getUser()` 去打 `/auth/v1/user` ⇒ 挂住 ⇒ **拖满 45 秒**
   （`client.ts` 的 `fetchWithTimeout` 上限）；
4. 而同步管线的协议上界是 **30 秒**（`core/mutationProtocol.ts:103`
   `DEFAULT_TIMEOUT_MS = 30_000`）⇒ **打爆** ⇒ 用户只看到「操作超时」，
   而真实原因是「联系不上云端」——**又是一句指错方向的谎**。

**可达性**：`downloadTabGroups` <- `supabaseAdapter.ts:93` <- 引擎；
`downloadSettings` <- `supabaseAdapter.ts:165` <- `syncEngine.ts:240`。
两条都是**用户点「同步」就会走**的路。

**为什么 4505 个绿灯没抓住**：那 4 个相关守卫守的是「**会话不许被删**」
（探活 ⇒ 不碰 SDK ⇒ 刷新压根不发生），测的是 402 这一档。
而本缺陷发生在**断网**这一档（探活说「不知道」⇒ 放行），
此时**会话不会被删**（守卫的全部断言仍然成立），
但**等待没有上限**——**守卫没测这个维度**。
⇒ 这正是「同一个谎的八次显形」的**第九次**：修一族的时候，
只修了「会不会说错话」，没修「等多久」。

**修法（建议，未动手）**：把这两处换成 `requireSessionUserId()`
（它已经是第 52 轮收口后的那一个：先问云端在吗 + 5 秒上限 + 失败原样带出），
或至少给这两处套上 `withDeadline(supabase.auth.getUser(), SESSION_READ_DEADLINE_MS, ...)`。
**两者都不该各自写一个数字**（本仓既有纪律：两处各写一份会漂，
而漂的方向永远是「某一处忘了加闸门」）。

### 3.2 台账与代码的轮次编号漂移（P2，文档债）

`f277835` 这一个提交里：

- commit message 说「**第 51 轮**」；
- `docs/RELEASE-NOTES.md` 里有「十一之十一、**第 51 轮**」；
- 但 `src/` 里有 **13 处**注释写「**第 52 轮**」
  （`authSlice.ts` 10 处、`session.ts` 1 处，另有 `tests/guards/authOutageUserFacing.test.ts`）；
- 而 `docs/RELEASE-NOTES.md` 里「**第 52 轮**」出现 **0 次**。

⇒ 代码里已经开始写第 52 轮的注释，**台账里还没有第 52 轮这一节**。
这不是「编号错了」的小事：台账是这轮工作的**唯一事实来源**
（本仓既有约定），「代码里有、台账里没有」= **有一批改动没进账**。
（很可能就是那位并发 agent 正在做的东西 ⇒ 不适合由我补。）

### 3.3 `_tmp` 实验文件会被测试 glob 收进去（P3，工具性）

`tests/guards/_tmpSyncOutage.test.ts` 匹配 `tests/**/*.test.ts`
（实测：单独跑它 ⇒ 26.5 秒 ⇒ **会**被 `pnpm test` 收进去）。

⇒ 它现在**只是碰巧没失败**（`assert.ok(true)` 收尾）。
一旦那位 agent 把它写成一个真断言，它就会**混进 CI 的 4506 个用例里**，
而文件名 `_tmp` 不会提醒任何人「这是实验不是守卫」。
（本仓的 `vitest.config.ts include` 曾有过同类事故，见记忆里的
「在 `src/popup/` 放失败测试仍显示 185 passed」。）

### 3.4 第 51 轮自己承认的「剩下的那一路」（台账已记，**代码未修**）

台账 §八之二末尾写得很诚实：

> **剩下的那一路（如实说）**：**同步**那条路（弹窗点同步 / SW 的定时同步）
> 会先碰 SDK（列探测 `supabase.from(...)`）⇒ 客户端仍会被建出来
> ⇒ 那一路在故障期间仍会挨那 8 次刷新。

**探针实证（跑那位 agent 的 `_tmpSyncOutage.test.ts` 的场景）**：
一轮完整同步（upload + download）在云端 402 期间，
请求日志是：

    POST /auth/v1/token       x 8    <- SDK 自己在退避重试
    GET  /rest/v1/tab_groups  x 2

⇒ **台账那条「如实说」是准确的**，而且它现在**正被一个 26.5 秒的
未跟踪实验文件反复验证着**。会话令牌这次没被删（兜底防线生效），
但**8 次刷新请求打在一个已经被配额限制的项目上**——
正是台账 §八之二自己说的那个代价。

## 4. 最终结果

### 4.1 结论

- **基线健康度：好。** 4505 绿灯、类型干净、lint 干净、构建干净、体积达标。
  第 41–51 轮的工程质量是真的高——**代码注释里写得出「为什么」的地方，
  质量明显高于一般 AI 生成的代码**（大量引用具体源码行号与实测数据）。
- **发现 1 个真缺陷（3.1 节的 P1）**：45 秒 vs 5 秒，9 倍差距，
  打爆 30 秒协议上界。**修法小、位置明确、已有现成的收口函数可用。**
- **发现 1 个盲区（变异实证）**：专门守「云端故障」的那一族守卫，
  对「核账号没走闸门」完全瞎 ⇒ **这条缺陷能进 CI**。
- **发现 2 个文档/工具性问题**：轮次编号漂移（第 52 轮没进台账）、
  `_tmp` 实验文件会混进测试 glob。

### 4.2 我没有做的事（如实说）

- **没有改任何生产代码。** 理由：(a) 仓库里有并发 agent 在写第 52 轮，
  `authSlice.ts` / `session.ts` 正是它正在改的文件 ⇒ 改它 = 抢写；
  (b) 本仓纪律（`.memory/external-auto-commit-during-agent-work.md`）明确要求
  「在 `/tmp` 沙箱里验证修法，把已验证的修法当建议交出去」。
- **没有补台账的第 52 轮。** 同上：那一节的内容属于那位 agent。
- **没有删 `_tmpSyncOutage.test.ts`。** 那是别人的在建工作。

### 4.3 产出

- 沙箱：`/tmp/onetab-audit-93956`（已删除，含 4 个探针文件）。
- 临时文件：`/tmp/onetab-audit-path` / `/tmp/probe_getuser_gate.test.ts` /
  `/tmp/mut_probe.sh` / `/tmp/download.ts.bak`（已全部清理）。
- 后台进程残留：**0**。
- 原始仓库 `git status`：与体检开始时**完全一致**
  （只有那个未跟踪的 `_tmpSyncOutage.test.ts`）。

### 4.4 待 Jasper 决策

1. **要不要我修 3.1 的 P1？**（`download.ts` 两处裸 `getUser()` →
   `requireSessionUserId()`）—— 建议先等那位 agent 的第 52 轮落地，
   否则可能在同一个文件上撞车。
2. **第 52 轮的台账谁来补？** —— 建议由写代码的那位补，
   我可以只做校对（编号漂移 + 缺节）。
3. **要不要给「核账号」这一层补一条守卫？**（守「等待有上限」，
   而不是守「会话不被删」）—— 那是本缺陷能进 CI 的根因。

---

## 5. 续：Jasper 说「没有其他 agent 在执行了，直接修复并提交」

（时间：2026-10-23 15:30 起）

### 5.1 修了什么

| 文件 | 改动 |
|---|---|
| `src/utils/supabase/session.ts` | 新增 `requireSessionUser()` —— 「核账号」的**收口入口**（先问云端在吗 → 5 秒上限 → 失败带机器判据）。`requireSessionUserId()` 改为调用它 ⇒ **一处**实现、两处复用 |
| `src/utils/supabase/download.ts` | 两处裸 `supabase.auth.getUser()` ⇒ 改走 `requireSessionUser()`；下游的 `user.id` 换成 `downloadUserId` / `settingsUserId`（**调和规则逐字保留**） |
| `tests/guards/downloadAccountCheckHasDeadline.test.ts` | 新守卫（结构 + 行为，4 条） |
| `tests/guards/downloadAccountCheckHasDeadlineMutation.test.ts` | 变异自证（4 条） |
| `tests/guards/syncRoundDuringOutage.test.ts` | 新守卫：整轮同步在云端故障期间会做什么（**把 §八之二 那条残留钉成可执行判据**） |
| `tests/guards/backendUnavailableHonesty.test.ts` | 判据从「download.ts 里有 ≥4 处」改成「**钉到具体的那两个错误变量**」 |
| `tests/guards/_tmpSyncOutage.test.ts` | **删除**（临时实验，零断言，且会被 `tests/**/*.test.ts` 收进 CI）⇒ 被上面那条真守卫取代 |
| `docs/RELEASE-NOTES.md` | 补「十一之十二、第 52 轮」台账（代码里早就有第 52 轮的注释，台账却缺这一节） |

### 5.2 修完的实测

```
[A requireSessionUserId]  耗时 5012 ms
[B downloadTabGroups    ]  耗时 5000 ms   ← 修复前是 45003 ms
[C downloadSettings     ]  耗时 5002 ms   ← 修复前是 45003 ms
```

⇒ 9 倍差距消除。三条路现在**同一档**（5 秒），且都在 30 秒协议上界之内。

### 5.3 守卫的检测力（变异自证，逐条读输出）

- 变异一（`download.ts` 改回裸调）⇒ 红在
  `downloadTabGroups 的核账号必须在上限内结束（实测 15026ms）` ⇒ **红在目标断言上**。
- 变异二（摘掉 `withDeadline`）⇒ 红在结构判据上。
- 变异三（上限 5 秒 → 45 秒）⇒ 红（上限还在但大到打爆 30 秒协议上界）。
- 变异四（换变量名）⇒ **仍然绿**（钉的是行为，不是长相）。

### 5.4 踩到的两个坑（如实记）

**坑一：自己写的守卫第一版是「假绿」的。**
第一版判据写的是「`session.ts` 里有 ≥1 处 `isBackendUnavailable(`」
⇒ 我把**账号**那处拆掉，读会话那处还在 ⇒ 计数照样 ≥1 ⇒ **守卫全绿**。
⇒ 靠变异自证抓出来的。改成**分别钉 `sessionError` 与 `userError`
两个具体的错误变量** ⇒ 才真的有检测力
（拆掉任一处都变红，已逐条验证）。

**坑二：把守卫改成「钉性质」时，差点犯「守卫钉字面量挡正确修复」那个坑。**
`backendUnavailableHonesty` 原判据是「`download.ts` 里 ≥4 处
`isBackendUnavailable(`」⇒ 本轮**收口**（把重复实现合并到一处）
反而会让它变红 ⇒ **逼着代码不许收口**。
⇒ 改成钉**性质**（会话两处 + 账号两处，**分别在两个文件里**），
并把「账号那两处在哪个文件」也写进注释（§5.1 表格）。

### 5.5 环境上的一个假信号（差点误报成「仓库坏了」）

`pnpm run lint` 突然报「460 errors in 13 files」，文件全是
`dist/supabase-vendor-*.js` / `dist/react-vendor-*.js` ⇒ 一看就不是
`src/` 的问题。

⇒ 根因：**本机的 `rtk` 工具**（`/opt/homebrew/bin/rtk`）把 `eslint` 的
调用**改写成了** `eslint -f json .` ⇒ 扫的是**整个仓库**（含 `dist/`）。
⇒ 绕过它、直接调 `node node_modules/eslint/bin/eslint.js src ...` ⇒ **0 问题**。
⇒ ⇒ **「lint 红了」这个信号在本机是假的**；CI 上跑的是真 eslint，不受影响。
（另有一类假信号：并发跑全量测试时，ESLint 多进程 worker 会偶发
「terminated abnormally (possibly out of memory)」—— 机器有 36GB、
空闲 56%，那是**并发压力**，不是内存不够；单跑必过。）

### 5.6 最终门禁（全绿）

| 门禁 | 结果 |
|---|---|
| `node --test tests/**/*.test.ts` | **4514 pass / 0 fail / 1 skip**（4515 用例） |
| `tsc --noEmit` | 通过 |
| `tsc -p tsconfig.test.json --noEmit` | 通过 |
| `eslint src` | 通过（0 问题） |
| `eslint tests` | 通过（0 问题） |
| `vite build` | 通过 |
| 首屏体积 | **182.6KB / 预算 185KB** ✅ |

### 5.7 本轮**没做**的（推迟，不是忘了）

- **同步那一路仍会挨那 8 次刷新**（第 51 轮 §八之二 已如实记）。
  本轮**没动**它：那要改 `sync-backend/supabaseAdapter.ts` 的**同步入口**
  （把探活挪到它之前），而「探活」住在 `src/utils/supabase/`
  （popup 首屏禁止组）⇒ 代价是把它挪出首屏 ⇒ **下一轮**的事。
  ⇒ 本轮把它**钉成了可执行判据**（`syncRoundDuringOutage.test.ts`）：
  等修好时，那条断言会红 ⇒ 提醒人把期望值改成新的。
- **首屏体积**没变（本轮只改 `src/utils/supabase/**`，
  那一整组本来就不在 popup 首屏里）。
- **没有改版本号、没有提审**：线上是 1.26.0，本轮改动**下一个版本**才带上
  （与第 49/50/51 轮一致）。
