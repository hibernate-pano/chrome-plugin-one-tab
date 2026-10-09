# AI Log：死代码清理 + 散落常量收敛 + 接线用例（并推翻一条专家误判）

- 时间：2026-10-09 15:38 → 16:28 (Asia/Shanghai)
- 项目：TapStack（chrome-plugin-one-tab）
- 触发：用户说「先做，把你能做的都做了」（做完 4 项决策 + P1-4 + 7 个 P2 之后）

## 一、对话出发点（原始需求与动机）

剩余无争议项三组：架构 P2-5（死代码）、架构 P2-4（散落常量）、
测试 P1（importData 接线用例）。用户授权「把你能做的都做了」。

## 二、执行过程

### 1. 死代码清理（逐个核实导出名，不只按文件名搜）

先做**双重复核**（文件名 + 每个导出标识符），避免「只搜文件名」的假阴性：

| 文件 | 核实方式 | 结论 |
|---|---|---|
| `src/core/webTombstone.ts` | 导出名 applyWebRemoveTab / mintWebStamp / WebRemoveTabResult 全仓零引用 | 删（112 行） |
| `src/components/auth/UserProfile.tsx` | UserProfile 导出零引用 | 删（88 行） |
| `src/background.ts` | 自述 DEPRECATED，只有 `export {}` | 删（4 行） |
| `src/core/hydrationDecision.ts` | decideTabsHydration / buildTabsPreloadedState 零生产调用方 | 删（68 行） |
| `tests/hydrationDecision.test.ts` | 对应纯函数测试 | 删（113 行） |

**⚠️ 关键判断：删实现不能连安全不变式一起丢。**
`hydrationDecision` 守护的是历史 P0「瞬时空读被固化 → TabList 永久跳过 loadGroups
→ 用户看到空列表而数据还在」。它退役后，该不变式的**活代码守护者**变成了
「TabList 每次挂载无条件 dispatch(loadGroups())」。所以：
- 在 `deadCodeGuards.test.ts` 的 DEAD_FILES 登记这 4 个文件（防复活）
- 在 `storeHydration.test.ts` 新增 3 条断言，把不变式改挂到活代码上：
  ① TabList 不得出现 `if (lastLoadedAt) return`（那正是丢数据的机制）
  ② popup 入口不得重建 preloadedState 水合
  ③ hydrationDecision 实现与测试都必须不存在（防半途复活）

### 2. 散落常量收敛（架构 P2-4）

「上传防抖 3000ms」原先散在 **5 处**手抄：
- `syncEngine.ts` 的 `scheduleUpload(delayMs = 3000)`
- `TabManager.ts` 的 `scheduleUpload(3000)` ×2
- `mutationHandlers.ts` 的 `NORMAL_MS = 3000`
- `service-worker.ts` 的消息 fallback `: 3000`

新建 `src/core/syncTiming.ts`（`UPLOAD_DEBOUNCE_MS = 3000` /
`DELETE_PRIORITY_UPLOAD_MS = 1500`），5 处全部改引用。

**为什么放 core/ 而不是 syncEngine.ts**：`mutationHandlers.ts` 是纯模块
（deps 注入、**不 import syncEngine** —— 循环依赖约束见 opStampMigratedGuard
的注释），它取不到 syncEngine 的常量。core/ 是纯逻辑层，双方都能引。

**刻意不合并的三项**（写在模块注释里）：30s 协议超时、35s 上传保护窗口、
Toast 的 3000ms duration —— 数值接近纯属巧合、语义不同，并成一个常量会让
「单独调整某一个」变成不可能。

守卫 + 变异 S（改回手抄 3000 → 19/20 红 → 还原 20/20，sha256 一致）。

### 3. migrateToJsonb：标注而非删除

全仓复核：**零生产调用方**（只有实现 + ports.ts 接口声明 + 注释提及）。
它是「未接线的运维工具」，不是普通死代码。

判定：**保留 + 显式标注**，不删。理由（写进方法注释）：
- 它是目前唯一能把云端旧格式行迁到 JSONB 的代码，删了要重写，
  而重写必然重新推导「分页 count 交叉校验」「fail-closed 中止」这些已写在里面的教训
- 不删不增加常驻负担（不是 UI、不进主路径）
- 按「减法减的是常驻界面与维护负担，不是运维能力」

同时核实并写明：**它没有专测**（tests/scripts 零命中），调用前需自行核对。

### 4. 测试 P1：importData 接线用例 —— **推翻了专家结论**

专家（测试门禁方向）报告称：删掉 `data.data.groups.map(normalizeImportedGroup)`
这一行，**32 个导入相关测试全绿**，故「调用点无人测」。

**我不采信、直接做变异实测**，结果：**6 个测试红**，其中 **4 个是既有测试**：
- `旧形状 {tabs_data:[...]} 不再抛异常，标签完整送达`
- `标签元素是云端 snake_case 时，时间戳映射到本地 camelCase（不再丢）`
- `嵌套 wrapper {tabs_data:{tabs:[...]}} 也能恢复出标签`
- `缺 name 的组给可读回退，不留空标题卡片`

⇒ **接线一直有守护，专家的 P1 是误判**（可能其变异形态不同，或基于更早的
代码状态）。这也解释了我起初 grep 时看到的那个「几乎和我写的一样」的既有用例。

处理：
- 我新加的 2 条断言**保留**（它们仍是加强：源码级接线断言定位比行为用例直接；
  端到端断言旧文件的 **2 个标签逐条**送达，既有用例多为单标签或只断言 ok）
- **改写注释**：把「专家称 32 个全绿」改为「实测 6 红、接线一直有守护」，
  并把教训写进去 —— 引用外部结论前必须自己跑一遍变异；
  那句话若被下一个人采信，会让他去修一个不存在的问题，甚至删掉真实有效的守护

## 三、遇到的问题（报错、阻塞、意外行为）

### 问题 1：import 插入位置错（正则匹配到 `import type`）

给 `mutationHandlers.ts` 插 `syncTiming` import 时，我的正则
`^import .*?;\n` 匹配到了 `import type {...}` 那行的**中间**（多行 import 语句），
导致常量未定义、tsc 报 `Cannot find name 'UPLOAD_DEBOUNCE_MS'`。
改用 `apply_patch` 按精确上下文插入后修复。

### 问题 2：`syncTiming` 首次插入后 grep 复查发现"未插入"

复查用 `grep -c "syncTiming"` 得到 0，一度以为脚本失败。
实际是脚本写入了「注释里提到 core/syncTiming.ts」但 import 没插成功
（同问题 1）。教训：**用 tsc 而不是 grep 判断 import 是否到位**。

### 问题 3：注释里写了不准确的行号

给 migrateToJsonb 写注释时写「见下方 240 行附近的截断保护」，
实测该保护在 **263 行**。改为「见本方法内的 db-max-rows 截断保护」
（不写具体行号，行号会随编辑漂移，写错比不写更误导）。

### 问题 4：我的导出名猜测全错

复核 webTombstone 时我猜的导出名（webRemoveTab / removeTabFromGroup /
removeTabFromPayload）**全部不存在**，实际是 `applyWebRemoveTab` /
`mintWebStamp` / `WebRemoveTabResult`。
教训：**先读文件拿到真实导出名，再搜引用** —— 猜名字搜出来的「零引用」
是假阴性（这次差点据此误判「已确认零引用」，虽然结论碰巧一致）。

## 四、最终结果（成功/失败/部分完成）

### 全部完成

| 项 | 结果 | 变异验证 |
|---|---|---|
| 死代码 4 文件 + 1 测试 | 删除 + 登记防复活 + 不变式改挂活代码 | 3 条新断言（守护者迁移） |
| 散落常量 5 处 | 收敛到 core/syncTiming.ts | S：改回手抄 → 19/20 红 |
| migrateToJsonb | 保留 + 显式标注「无自动调用方、无专测」 | — |
| importData 接线 | 加强 2 条断言 + **推翻专家误判** | T：实测 6 红（4 既有 + 2 新增） |

### 门禁

| 命令 | 结果 |
|---|---|
| `node --test "tests/**/*.test.ts"` | **1025 pass / 0 fail / 0 skipped** |
| `pnpm validate` | **PASS** |
| 累计改动 | 50 文件，+2339 / −901 |

### 误判记录（本轮 2 条，都是我的）

1. 猜导出名去搜引用 → 全猜错。虽然结论（可删）碰巧正确，
   但方法是错的：**零引用结论必须基于真实标识符**。
2. 曾用 grep 判断 import 是否插入 → 得到误导性结果。**tsc 才是判据。**

### 推翻的专家结论（1 条）

测试方向 P1「importData 归一化调用点无人测」→ 实测 6 红，接线一直有守护。
已在测试注释里记录实测数据与教训（不写未经核实的结论进注释）。

### 未完成

- **发版**：仍未 bump 版本 / commit / 打 tag（本轮及之前所有改动都还在工作区）
- 需 Dashboard 复核的三项（线上 RLS / profiles 列级权限 / tombstone cron）
- 架构 P2-6 大文件拆分：专家建议**不动**（只在下次触碰时按已识别边界增量拆），
  我采纳该建议，本轮未拆
