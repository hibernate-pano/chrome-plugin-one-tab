# 2026-10-11 21:00 — 1.23.0 自动同步默认关闭 + 四档间隔

## 对话出发点

Jasper 的原话（分两轮）：

> 「既然是导致Supabase配额使用的主要原因，是因为每60秒的自动同步，而且是全量……
> 我需要你做一个大的版本，把自动同步功能默认关闭掉。用户在菜单中开启后，再启用自动同步。
> ……自动同步要关掉，默认是关掉的。用户开启后，让用户自己选是10分钟、半小时还是1小时，
> 这三个档位。」

我在中间一轮**明确反对过**（诊断对了一半但药方开错对象：烧配额的是「全量」不是「60 秒」，
且 1.22.17 已修 F2 增量 + 缺陷 1 探活短路；默认关会撞上 LWW 合并模型依赖副本新鲜度的
数据安全前提）。Jasper 读了之后回复：

> 「No，我现在坚持我的想法。数据默认自动同步关闭，用户可以手动开启。
> 选择时间有四档：五分钟、十分钟、半小时、一小时。」

⇒ 产品负责人拍板，我执行。**这一版的取舍与我的建议不同，记录在此以备复盘。**

## 执行过程

### 探索阶段的关键发现

`rg -n "syncEnabled" src/` 揭示了一条重要事实：**`syncEnabled` 这个设置一直存在却被
「存 / 传 / 诊读」，没有任何行为消费它** —— 是个纯摆设。这解释了为什么
「自动同步开关」在 UI 上从未存在：不是被删了，是从来没实现过。于是本次不是
「删掉一个开关」，而是「把一个摆设接上真正的行为」。

### 三个实现决策（我主动定的，有异议请推翻）

1. **本地改动的上传保持事件驱动**，不受本开关影响。
   理由：关掉上传省不下什么（F2 增量后只有真改动才传，量极小），反而把用户的编辑
   困在本机且无声 —— 而「失败要出声」是本仓第一原则。自动同步的配额成本 100% 在
   **下载方向**（`SELECT *` 整包 blob）。
2. **存量用户已存的 `syncEnabled:true` 予以保留，不强制翻转。**
   `getSettings` 是 `{...DEFAULT_SETTINGS, ...stored}`，老用户 stored 里自带 `true`，
   合并后仍是 `true`。只有新用户 / 键缺失才落到 `false`。若做「存量 true → false」
   的迁移，那是静默改用户设置 —— 正是 1.22.16「设置被静默重置」修掉的那类 bug。
3. **开启时默认 10 分钟档**（四档居中偏低：比 60s 省 10 倍，跨端延迟仍可接受）。

### 改动清单

| 文件 | 改动 |
|---|---|
| `src/types/tab.ts` | `UserSettings` 加 `syncIntervalMinutes: number` |
| `src/utils/storage.ts` | 新增 `SYNC_INTERVAL_CHOICES=[5,10,30,60]` / `DEFAULT_SYNC_INTERVAL_MINUTES=10` / `validateSyncIntervalMinutes`；`DEFAULT_SETTINGS.syncEnabled` 改 `false`；`getSettings` 里对档位做 fail-safe 校验（非法回落 10，不抛错） |
| `src/store/slices/settingsSlice.ts` | 加 `setSyncEnabled` / `setSyncIntervalMinutes` 两个 reducer |
| `src/background/backgroundSync.ts` | 导出 `SYNC_ALARM` / `RESYNC_ALARM_OP` / `AUTO_SYNC_DISABLED_REASON`；新增 `readAutoSyncConfig()`；`rescheduleAlarm` 改双参数 `(delay, period)`；`setupBackgroundSync` 先读配置再决定建不建；`handleAlarm` 每轮重读开关，关则自杀 |
| `src/core/mutationProtocol.ts` | `SyncOp` 加 `'resyncAlarm'` |
| `src/service-worker.ts` | SYNC 分支加 `resyncAlarm` 处理 + `auto:true` 下载的总开关门禁（包 `runSyncOp()` 闭包，不复制 enqueue） |
| `src/components/app/AuthProvider.tsx` | AutoSync 白名单加 `auto_sync_disabled`（关是稳态不是故障，每次开页面弹 warn 等于制造噪声） |
| `src/components/layout/HeaderDropdown.tsx` | 菜单加「自动同步」开关 + 四档选择器（档位引用 `SYNC_INTERVAL_CHOICES` 单点，不手抄数字） |
| `src/utils/supabase/upload.ts` / `download.ts` | 设置字段白名单/映射加 `syncIntervalMinutes` ↔ `sync_interval_minutes` |
| `supabase/migrations/20261011190000_add_sync_interval_minutes_to_user_settings.sql` | 新列；客户端有 42703 降级，发版先于迁移执行也安全 |

### 更新旧守卫（契约变更，不是绕过）

三处旧守卫钉的是 1.22 的旧契约，全部**红**了，逐条更新并保留其真正意图：

- `tests/newFeatures.test.ts`「注册 interval=1 分钟 alarm」→ 改为「注册 listener；
  空存储（默认关）下不建 alarm」。保留意图：listener 必须无条件注册、非本名事件静默返回。
- `tests/syncBackoff.test.ts`「period 恒为 NORMAL_INTERVAL_MINUTES(1)」→ 改为「period 取
  用户档位参数、delay 取参数」。保留意图：退避只改 delay、绝不改 period。
- `tests/syncBackoff.test.ts`「setupBackgroundSync 同步创建 alarm（不 await）」→ 改为新契约
  「先问总开关，关态清 alarm、开态按档位」。**这条的前题已消失**（无 alarm 成了合法稳态），
  并把代价如实记进注释：SW 启动到读完配置之间有几毫秒无 alarm，SW 刚启动的最小存活远超
  一次 storage 读，这个窗口在实践中不存在。

顺带发现 `newFeatures.test.ts` 的 chrome mock 缺 `alarms.clear`（新代码关态会调），
补齐 —— mock 必须与真实 chrome API 面一致。

## 遇到的问题

### 1. 我自己写的测试有假绿，被变异验证抓出来（两次）

**问题一**：C 段「关状态下触发 alarm → 清 alarm」删掉 `handleAlarm` 的门禁后测试仍全绿。
**根因不是断言不够强，而是测的不是生产代码**：`setupBackgroundSync` 在模块首次加载时
就 `addListener` 过；后续用例 `installChromeMock` 重挂 `globalThis.chrome`，早先注册的
listener 闭包里仍是**第一次那个 mock 的 chrome** —— 派发事件时被清的是旧 mock 的 clear，
而断言查的是当前 `handles.clearedAlarms`。**观测量与被测代码不在同一个对象上时，绿是必然的。**
修法：加结构层守卫（`handleAlarm` 必须含 `if (!cfg.enabled)` 且排在退避门禁之前），
并把这段踩坑过程写进测试注释留档。

**问题二**：SW 门禁结构断言只查「有没有调 `readAutoSyncConfig`」—— 把 `if (!cfg.enabled)`
改成 `if (false && !cfg.enabled)` 照样全绿。补了三条：`if (!cfg.enabled)` 必须在场、
必须回 `AUTO_SYNC_DISABLED_REASON`、放行后必须走 `runSyncOp()`（且门禁块内不得自己 enqueue）。

变异验证 4 处（setup 总开关 / period 写死 1 / handleAlarm 自杀门禁 / SW 门禁恒放行），
全部确认会红后守卫才算数。

### 2. 一个被证伪的根因假设（留档免得重犯）

B 段四档用例串味（用 30 的种子跑出 10 的结果），我一度认定是 **Redux 单例里
`loadSettings.fulfilled` 写入了 settings**。写探针跑了两条连续用例验证：
「先空存储(关) → 再开+5分钟」在**只清 settings 缓存**的情况下本来就正常。
真正病灶是**我的批量替换脚本漏了 B 段循环里的一个调用点**。
教训：先写探针复现再改，别用「看起来应该对」的猜测当根因 —— 与 1.22.17 审查时
「先证最省事方案不够」的同一条纪律。

### 3. 环境噪音（与本版无关）

- 工具数字参数序列化故障（`yield_time_ms` 被序列化成浮点导致校验失败），
  workaround：长命令前台起 + 重定向落盘 + 短命令轮询文件。
- 需云端的 E2E 仍因 Supabase `exceed_egress_quota` 失败（既有环境问题，
  已在 1.22.17 干净 HEAD 对照确认）。纯本地 `e2e-tab-reorder` 8/8 通过。

## 最终结果

**成功。**

- 单测 **1113 passed / 0 failed**（1.22.17 基线 1097 → +16，其中 15 条为新文件
  `tests/autoSyncDefaultOff.test.ts`，1 条为 mock 补齐后的旧文件修复）
- `pnpm type-check` / `type-check:tests` / `lint` / `lint:tests` → 全 exit 0
- `pnpm build` exit 0；体积门控 197.7KB / 240KB（+0.7KB，新增 UI 与逻辑）
- 纯本地 E2E `e2e-tab-reorder.mjs` 8/8
- 新增守卫 4 处变异验证全部确认变红

### 待办（未做，需要时再说）

1. **云端列迁移未执行**：`supabase/migrations/20261011190000_*.sql` 已写好但未在
   生产库跑。客户端有 42703 降级，所以发版先行是安全的；要让档位跨设备漫游才需执行
   （`pnpm supabase:migrate`）。
2. **版本号仍是 1.22.17**：本次是「大版本」改动，按 Jasper 的发版纪律应 bump 到 1.23.0
   后再 commit/tag/push —— 但**尚未做**，等 Jasper 确认后再发。
3. **诊断字段**：`diagnostics.ts:653` 的 `autoSyncEnabled` 现在有了真实行为支撑，
   值得在下个版本连同档位一起上报（当前只报开关，未报档位）。
4. **未做的产品增强**（Jasper 若要）：关态下 popup 首屏提示「数据可能已过期 N 小时」
   —— 我在第一轮建议过（防「静默过期」），本版未实现。
