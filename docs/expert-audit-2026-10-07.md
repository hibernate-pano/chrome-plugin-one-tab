# 专家团体检报告（2026-10-07）

> 范围：TapStack v1.22.12（HEAD `15dbc5d`，tag `v1.22.12`）
> 方法：5 位专家分头只读审查（定位价值 / 交互 / 数据一致性 / 安全合规 / 架构质量）+ 项目总监逐条复验
> 性质：**只读审查，未修改任何产品代码**
> 与 `health-check-2026-10-06-expert-team.md` 的区别：那份几乎全在查 SQL 与文档；**这份专门补上它最大的盲区——交互、产品判断、以及「这个产品该不该存在」**

---

## 零、门禁实测（本机真实执行）

| 门禁 | 结果 |
|---|---|
| `tsc --noEmit`（src） | ✅ 通过 |
| `tsc -p tsconfig.test.json`（tests） | ✅ 通过 |
| `eslint src`（max-warnings 0） | ✅ 0 error / 0 warning |
| `eslint tests`（max-warnings 0） | ✅ 0 error / 0 warning |
| 单元测试 | ✅ **926 / 926 通过**（比 10-06 报告的 843 多 83） |
| 生产构建 | ✅ 成功 |
| 首屏体积 | ✅ 193.3KB / 240KB |
| 版本号一致性 | ✅ package.json / manifest.json / .env.example / README / CHROMEWEBSTORE / git tag 全为 1.22.12 |
| git 历史凭证 | ✅ 零泄露（`.env` / `.env.local` / `.mcp.json` / `.vercel` 从未进入历史） |
| 零循环依赖 | ✅ Tarjan SCC 实测：size>1 的环 = 0 |

**首次 `pnpm lint` 输出出现了一段 issues 列表，复跑后退出码 0、零 issue——那是输出代理的缓存回放，不是真实 lint 结果。记录在此，以免日后误读日志。**

---

## 一、结论先行

**这个项目的工程质量显著高于它的产品成熟度。** 926 个测试、变异验证、精确到行号的因果链、零循环依赖——这些是真跑出来的，不是文档装饰。

但五位专家从五个方向撞到了**同一件事**：

> **过去 13 个版本（1.22.0 → 1.22.12）的全部工程投入，都在保护一个「跨设备同步 + 非 E2E 加密 + 无回收站」的组合——而这个组合既不是产品的核心价值，又在持续制造用户数据风险。**

三句话版本：

1. **交互诚实度落后于工程诚实度。** 代码对「谎报成功」的防御是同类上游水平，但对「打开即删除」「保存即清空窗口」「3 秒冷却静默 return」这类**用户可见的意外**，处理还在下游。
2. **「工作会话保险箱」这个词和「删除即物理清除、无回收站」在语义上直接互斥。** 保险箱的心理契约是「丢了能找回来」。
3. **最严重的技术风险不是加密弱，是「代码里修了，线上库没修」这个治理缺失——它已经发生过一次。**

---

## 二、P0：需要你亲自决断的 4 件事

### P0-1【治理·已发生】profiles RLS 泄露已止血，但止血方式留下了永久性证据缺口

`profiles` 表曾带 `USING (true)` 全放行策略上线，anon key 可拉走全站 48 行的 `email` / `stripe_customer_id` / `subscription_status`，且能 PATCH 提权（`scripts/anon-rls-probe.mjs:14-18` 记录了 2026-10-05 实测）。

止血执行了，但**是绕过迁移链直接在库里跑的**，随后用 `supabase migration repair` 补了台账。

**后果不是「现在不安全」，而是「任何读代码的人——包括下一个 AI、包括审核员复查——都无法从仓库证明线上是安全的」。**

> ⚠️ 这一条我**不能从代码侧判定**，需要你在 Supabase Dashboard 复核。判据见第六节。

### P0-2【安全·待线上验证】purge 函数的 REVOKE 迁移至今未执行

`20261005000001_purge_expired_tombstones.sql:129` 写了 `REVOKE ... FROM PUBLIC`，但该迁移按记录**未在线上执行**。该函数是 `SECURITY DEFINER` + 执行真 `DELETE`（`:89-92`）。

**PostgreSQL 给新函数默认授予 `PUBLIC` EXECUTE。若未 REVOKE，任何人可 `POST /rest/v1/rpc/purge_expired_cloud_tombstones` 删除全站到期墓碑行。**

为什么现有门禁永远发现不了：`grep -rn "purge_expired\|rpc(" src/` → **零命中**。客户端根本不调它，所以没有任何单测、e2e 或 CI 步骤会覆盖这个暴露面。

### P0-3【数据一致性·已复验】同一个判据，两个调用方一个 fail-open 一个 fail-closed

这是本次审查**最实在、最确定、可立即修**的一条：

| 调用方 | 读不到 `pending_upload` 判据时 | 位置 |
|---|---|---|
| `backgroundSync`（后台轮询） | **中止下载**（fail-closed） | `src/background/backgroundSync.ts:126-142` |
| `downloadAndMerge`（popup 手动/自动同步） | **继续下载**（fail-open） | `src/services/syncEngine.ts:307-310` |

```ts
} catch (e) {
  // storage 读失败不阻塞主流程，走正常下载
  decision = { action: 'proceed' };   // ← 读不到判据却继续下载
}
```

`backgroundSync` 那侧的注释逐字解释了为什么必须 fail-closed：

> 「读不到 pending_upload 意味着『本地有没有未推送的变更』这个问题没有答案……若本地其实有未推送的新状态（正是读失败最可能的原因之一），这一轮下载就会把它覆盖掉 —— 用户的修改静默丢失。」

**后果**：IndexedDB 瞬时读失败（死句柄看门狗刚触发、quota 超限、事务 abort）→ 判据读不到 → 用云端旧数据覆盖本地未推送的新状态。**后台轮询修好了，popup 这条路径漏了。**

**修法**：`syncEngine.ts:307-310` 改为 `return { success: false, reason: 'precheck_unknown' }`，与 `backgroundSync` 同口径。纯 fail-closed 方向的改动，不影响正常路径。

### P0-4【架构·已复验】`getQueueDepth()` 把「队列里有别人的活」误当成「我在队列内」

`src/background/opStampMigratedGuard.ts:40-43`：

```ts
export function ensureOpStampMigrated(): Promise<void> {
  if (getQueueDepth() > 0) return runMigration();   // ← 判据错误
  return enqueue('opStampMigration', runMigration);
}
```

`getQueueDepth()` 返回**整个队列**的深度，不区分「我是不是这个 job 的一部分」。而 `runMigration` 做的是 `getGroups()` → `migrateOpStamps()` → `setGroups()`，**全量读-改-写 groups**。

**丢数据路径**：SW 冷启动时 `service-worker.ts:57` 调 `ensureOpStampMigrated()`，此刻若 60s 的 `backgroundSync` alarm 正在跑 `sync:download` → 判据成立 → 迁移**在队列外直接执行** → 与 `syncEngine.ts:422` 的 `setGroupsImmediate` 交错 → **违反单写者不变量，后写的赢，被覆盖的一方已经报成功给用户了**。

v1.22.0 之后**没有回收站**，这条路径丢的组用户找不回来。而它躲过了全部 926 个测试——当前测试体系写不出能抓住它的用例（要复现需构造「队列里有别人的活 + 同时触发 onInstalled」）。

**修法**：改成显式传参（`syncEngine.ts:263` 传 `true`，`service-worker.ts:57` 传 `false`），删掉 `getQueueDepth` 在这里的猜测。

---

## 三、P1 清单

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| **P1-1** | **交互：点扩展图标不是打开管理器，而是「保存当前窗口 + 清空标签页 + 新开标签页」** | `manifest.json:21-24`（无 `default_popup`）+ `service-worker.ts:170-180` | 这是一个**不可撤销的三连动作**，且第一步弹的是「正在保存...」这种进行时提示。用户对「保存」的心智模型是「复制」，实际是「剪切」 |
| **P1-2** | **交互：「点开单个标签即从会话移除」零告知** | `TabGroup.tsx:291-319`、`SearchResultList.tsx:230-246`；对照 `DraggableTab.tsx:276-283` 的删除按钮 | 用户预期「点开链接」，得到「点开链接 + 保险箱少一条记录」，**且与旁边 X 删除按钮撞形、都无法撤销** |
| **P1-3** | **交互：页内保存按钮关闭整个窗口，零 UI 反馈** | `Header.tsx:168-175`（不 await、不处理回包）+ `TabManager.ts:174-188` | 用户点了之后眼前一空，无法判断是保存了、崩了、还是跳转了 |
| **P1-4** | **定位：「保险箱」与「无回收站」语义互斥** | `README.md:15` / `manifest.json:23` vs `src/legal/privacy.html:46` | 二选一：改定位词（我倾向这个），或把回收站加回来 |
| **P1-5** | **定位：收藏和备注从不上云，但文档把它们与跨端同步并列宣传** | `tabSlice.ts:388-392` 注释 + `upload.ts:391-397` 载荷（无 notes/isFavorite）+ `types/tab.ts:58-75` | 这是**产品级静默失效**：A 设备写备注，切 B 设备搜不到。建议加上去云（两个字段的成本） |
| **P1-6** | **数据：设置同步无任何冲突检测，最后写入者无条件覆盖整行** | `upload.ts:1022-1026`（无 stamp/version）+ `syncEngine.ts:67-80`（`{...local, ...cloud}` 云端全赢） | 比会话的组级 LWW 更粗暴（整行粒度）。用户会认为是「设置随机失效」 |
| **P1-7** | **架构：`MIGRATION_KEYS` 漏了 5 个业务键** | `keys.ts:69-80`（9 项）vs `keys.ts:12-49`（16 项） | 漏掉 `PENDING_DELETE_IDS` / `DEVICE_SEQ` / `LAST_UPLOAD_TIME` / `JOURNAL` / `OP_STAMP_MIGRATED`。对从 v1.21.x 直升的老用户是真实数据丢失。5 分钟：改为从 `STORAGE_KEYS` 派生 |
| **P1-8** | **架构：`opStampMigratedGuard` 是唯一还在用「缓存读 + 防抖写」的生产路径** | `opStampMigratedGuard.ts:27,34` | 应为 `getGroupsForWrite()` + `setGroupsImmediate()`。2 行 |
| **P1-9** | **文档债：`rebuild-plan.md` 与代码直接矛盾** | `rebuild-plan.md:3` 称「影子双写上线，灰度 100%」，但 `package.json` 无 yjs/dexie、`src/` 零残留 | **说谎的文档比没有文档更危险** |
| **P1-10** | **发布事实：1.22.8 → 1.22.12 五个版本全部未上架，线上仍是 1.22.7** | `CHROMEWEBSTORE.md:165-170` | **这应该是第一优先**：所有这些修复一个用户都还没拿到 |

---

## 四、P2 观察项

| # | 问题 | 证据 |
|---|---|---|
| P2-1 | 打开标签有 3 秒冷却期，命中即静默 `return`（无置灰/toast） | `openGuard.ts:19` + `TabGroup.tsx:297` |
| P2-2 | 有数据时后台刷新失败完全静默（error 分支被 `groups.length === 0` 挡住） | `TabList.tsx:111` |
| P2-3 | Toast 顶部把 `type` 渲染成英文大写（SUCCESS / ERROR / WARNING） | `Toast.tsx:164-166` |
| P2-4 | 导入无确认、无数量提示，成功静默 reload（`importData` 是 merge 语义，不会覆盖，但会静默产生副本） | `HeaderDropdown.tsx:620-624`、`storage.ts:915-940` |
| P2-5 | 空状态无法区分「首次使用 / 老用户清空 / 新设备未同步」 | `TabList.tsx:144-172` |
| P2-6 | 锁定改变了「恢复后是否移除」的语义，但 tooltip 只写「锁定会话」 | `TabGroup.tsx:523` vs `:249-259` |
| P2-7 | `ModalFrame` 无 `overflow-y-auto`，长文案在矮窗口里确认按钮可能点不到 | `ModalFrame.tsx:39`（对照正确写法 `AuthModal.tsx:44-45`） |
| P2-8 | `unlimitedStorage` 在 MV3 下是冗余声明，全仓无配额探测代码 | `manifest.json:16` |
| P2-9 | CSP `img-src` 允许任意 `https:` / `http:`（favicon 真实需要，但侧信道敞口） | `manifest.json:8` |
| P2-10 | 死代码：`hydrationDecision.ts`（12 个用例测一段不会执行的路径）、`journal.ts`、`upload.ts` 的 `migrateToJsonb`（112 行零调用） | 各专家独立确认 |
| P2-11 | 7 个守卫测试钉死源码字面量，重构必然误报 | `tests/guards/` 全部 |
| P2-12 | `.env` 里 `VITE_APP_VERSION=1.9.3` 漂移，但该变量在 `src/` 零引用 | `.env:9` |

---

## 五、误判记录（专家团自查 + 总监复验撤回）

记录在案，因为「体检报告里的误判」和缺陷一样重要：

1. **「单双栏布局切换是死的」——撤回。** 初判依据是 `MainApp.tsx:39-41` 与 `Header.tsx:177-180` 的 `getContainerWidthClass` 硬编码返回同一值。但 `TabList.tsx:178` 确实按 `layoutMode` 切换 `grid-cols-1/2`，**单双栏是真的在切**。真正的问题只是容器宽度不跟着变（半吊子，不是全死）。
2. **「探活 digest 会把本地刚写入误判为云端无变更导致丢数据」——撤回。** 数据一致性专家自己在报告中推翻了这条假设，诚实标注「我没有找到一条确定性的丢数据路径」。这是本次审查里质量最高的一段自我纠错。
3. **「`restoreSnapshot` 快照为空时跳过回滚是缺陷」——降级为设计权衡。** 本地为空时无东西可丢，跳过回滚是正确的；只是让 README 的措辞不够精确。
4. **「导入是覆盖语义，会清空现有数据」——措辞过重。** 复核 `storage.ts:915-940` 后确认是 `mergeImportedGroups`（merge 语义）。但「无确认、无数量提示」仍然成立。

---

## 六、必须由你亲自处理的事（我严格只读，未执行任何一项）

### 1️⃣ 确认 P0-2（最高优先级）

Supabase Dashboard → SQL Editor：

```sql
SELECT p.proname, p.prosecdef, p.proacl
FROM pg_catalog.pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('purge_expired_cloud_tombstones','body_tombstone_expiry_days');
```

**判据**：`proacl` 中若出现 `{...=X/...}` 且调用方含 `anon` 或 `PUBLIC` → 确认暴露，跑 `pnpm supabase:migrate`。

### 2️⃣ 确认列级权限是否真收口

```sql
SELECT column_name, is_updatable, is_insertable
FROM information_schema.columns
WHERE table_schema='public' AND table_name='profiles'
  AND column_name IN ('plan','subscription_status','stripe_customer_id','ai_daily_count');
```

**判据**：若仍 `is_updatable = YES` 且表级 UPDATE 未撤 → 登录用户可自助升 Pro。

### 3️⃣ 复验 profiles 已止血

```bash
node scripts/anon-rls-probe.mjs    # 不要加 --write
```

**判据**：`profiles` 必须是 **0 行**。

### 4️⃣ 核实 `privacy@tapstack.app` 是否真实可收信

`privacy.html:70` 写了这个邮箱，但政策实际托管在 `tapstack-two.vercel.app`。审核员会照着它发函——一个收不到信的删除请求入口是合规风险。

### 5️⃣ 决定 1.22.8 → 1.22.12 的发布

线上还是 1.22.7。五个版本的修复（含死句柄自愈、三处谎报成功、导入往返丢数据）**一个用户都还没拿到**，而 P0-3 / P0-4 在用户拿到 1.22.12 之后就会真的暴露给他们。

---

## 七、产品判断（这一节没有代码能回答，只有你能回答）

**先说仓库里的证据**（安全专家已核查，数字可信）：

| 我要找的 | 实际情况 |
|---|---|
| 安装量 / 商店评分 / 评论 | **零记录** |
| GitHub issues / 用户反馈 | **零记录** |
| 注册账户 | 48 行 `profiles` |
| 活跃会话归属 | 全部属于同一个账户（你自己） |
| 付费 | 48 个账户里 0 个 `plan='pro'` |
| 埋点 | 只存本地，从不上报 |
| 商业化骨架 | `plan` / `stripe_customer_id` 列存在，`src/` 零处读取 |

**竞品现实**（2026-07 OneTab v2 已重写上线，带文件夹 + 全局搜索 + 星标 + E2E 加密）：

| 对手 | 用户为什么会用它而不是 TapStack |
|---|---|
| **Chrome 内置标签组** | 零安装、零账号、原生同步。TapStack 要求你**显式保存**，而这个存档**恢复时会自毁**（`TabGroup.tsx:249`） |
| **Chrome 会话恢复** | `Ctrl+Shift+T`，零学习成本，覆盖绝大多数场景。**这是 TapStack 最被低估的竞争对手** |
| **OneTab** | 成熟免费、10M+ 用户、v2 已把差异化功能追平。TapStack 剩下的主要是「中文 + 6 套主题」——那是皮肤，不是留存理由 |
| **Arc Pinned Tabs** | 它的交互模型更对：**不需要「保存」这个动作**，pin 住就行 |

**我的判断**：

TapStack 真正不可替代的那件事是「**把此刻这一屏工作现场原样冻结，之后能搜回来、整组展开继续干**」。这个价值是真的。

但支撑它的现在有 **5 个用户必须接受的条件**：装扩展、授 `tabs` 权限、注册账号、把工作现场上传到非 E2E 加密的云端、接受删除不可恢复。**每一步都是流失点，而每一步都不是那个核心价值。**

而过去 13 个版本的全部工程投入，方向是**修自己制造的同步 bug**——用户用本地功能时不会遇到这些故障，是同步让它们变致命的。

**所以我的建议不是「继续修」，也不是「砍掉」，而是：**

> **先发 1.22.12 → 修 P0-3 / P0-4 → 然后停下来去拿真实用户信号。**
>
> 你在另一个项目上写过「认可拿到真实用户信号优先于继续写功能」。**同样的判断在这里更紧迫**：你现在 5 个版本的修复悬在审核队列里，而 P0-3/P0-4 在用户拿到 1.22.12 之后就会暴露给他们。
>
> 如果去 V2EX / 少数派 / Reddit 发一版，问出三个问题——你平时怎么管理开了一堆的标签页、你用过 OneTab 吗为什么用或不用、你会为了跨设备找回把工作现场上传到别人的服务器吗——**没人回答，就说明这个东西不该继续做。**

---

## 八、还债优先级

| 顺序 | 动作 | 类型 | 工作量 | 前置 |
|---|---|---|---|---|
| 1 | 确认并修 P0-2（purge REVOKE） | **线上** | 30min | 你有 Dashboard |
| 2 | 发布 1.22.12 | **发版** | — | 商店审核 |
| 3 | 修 P0-3（fail-open → fail-closed）+ 补断言 | 代码 | 30min | 无 |
| 4 | 修 P0-4（`getQueueDepth` → 显式传参） | 代码 | 1–2h | 无 |
| 5 | 修 P1-1/2/3 三条交互（点图标 / 点标签 / 保存按钮） | 代码 | 半天 | 无 |
| 6 | P1-7 `MIGRATION_KEYS` 派生 + 守卫测试 | 代码 | 1h | 无 |
| 7 | 删过期文档 + 给 `rebuild-plan.md` 加状态横幅 | 减法 | 1h | 无 |
| 8 | P1-4 定位词二选一 | **产品决策** | — | 只有你能定 |
| — | 大文件拆分 | P2 | 2–3 天 | 可推迟 |

**总计：P0 代码项约 3 小时。真正的瓶颈不是工程量，是第八节那两个只有你能回答的问题。**

---

## 九、值得肯定的部分（不是客套）

1. **fail-closed 纪律贯彻得极彻底。** `syncDecision.ts:70` 的注释把不变式写死；我顺着验证了 `upload.ts` 的 hard-delete 降级分支——**它有 logError 告警 + 删后读回校验**，确保不残留行给对端复活。我最初怀疑它有幽灵复活漏洞，验证后确认**是我的误判**。
2. **墓碑取号走本机 Lamport 时钟**，而不是拿云端 `OLD+1` 凑。注释解释了原因：云端 seq 为 NULL 时 `OLD+1=1`，对方设备只要 seq≥2 就在合并里赢过这条墓碑 → 删除被静默撤销。**这种坑不是踩过一次能写出来的。**
3. **零循环依赖（实测 Tarjan SCC）。** `shared/mutationProtocol.ts` 是一个纯 re-export 垫片，`opStampMigratedGuard.ts:1-18` 甚至专门解释了「为什么单独成文件：反向 import 会形成循环依赖」——**这是有意识的设计，不是巧合。**
4. **CI 里显式校验 PostgreSQL 二进制可用性**，理由写明「三个二进制缺任意一个，整组 10 个用例会被 `{ skip }` 静默跳过——一次历史上出过两次事故的守卫，会在一片全绿里变成一片空洞」。这是对「假绿灯」有真实理解的工程文化。
5. **诚实披露加密局限。** README 与 `privacy.html:33` 主动写明「不是端到端加密」、密钥从公开的账户 ID 派生。我原本预设加密声明会夸大，**核查后逐项吻合，一处不虚**。15 条隐私声明里 14 条为真。
6. **零第三方出网。** 一个收集浏览历史的产品，`src/` 全库零 analytics、零第三方 SDK。**这比大多数同类扩展干净。**

---

*本报告由 5 位专家并行审查 + 项目总监逐条复验产出。审查过程中产生并撤回了 4 项误判（见第五节）。全程只读，未修改任何产品代码。*
