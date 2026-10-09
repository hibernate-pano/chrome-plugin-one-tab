# TapStack 发版记录

> 本文件是**给自己读的发版流水**：每版做了什么、为什么、当时商店是什么状态。
> 倒序排列（最新在上），一版一节，直接往下追加即可。
>
> 与 [CHROMEWEBSTORE.md](../CHROMEWEBSTORE.md) 的分工：那份是**提交商店的文案源**
> （中英双语、用户视角、受 `tests/docsAlignment.test.ts` 漂移校验），本文件是**工程视角的
> 长期台账**（含根因、踩坑、修复顺序），不必翻译成英文、不必对齐商店审核口径。
> 两边都会写「本版改了什么」，但只有本文件会记住「为什么」和「后来怎么验证的」。

## v1.22.16（2026-10-09，待提审）

**这版的由来**：一次**六方向并行专家体检**（数据安全 / 交互诚实度 / 安全合规 / 架构 / 测试门禁 / 产品定位）。
起点是「995 个测试全绿」，终点是**发现 5 个 P0** —— 其中两条是**六位专家从不同方向独立命中的同一根因**。
本版把 P0 与无争议的 P1/P2 全部修掉，每条都做了「故意改坏实现、确认测试会红」的变异验证。

### P0 —— 迁移绕过单写者队列（会静默丢会话）

`service-worker.ts:49` 的 `migrateToV2()` 是**裸调用**，而紧挨它下方 10 行的注释就写着
「此刻处在队列外，必须入队」—— 规则在同一个函数里已知，只是没套到它身上。
`TabList.tsx:27` 的 popup 侧迁移同样直写。后果：与正在跑的 `sync:download` / mutation 交错时，
迁移拿 t0 快照覆盖 t1 刚写入的会话；被覆盖的一方**已经报成功给用户了**，而 v1.22.0 起无回收站。

**为什么 getGroupsForWrite() 救不了它**：那个函数只解决「本 realm 缓存陈旧」，
不提供任何跨任务/跨 realm 互斥。单写者队列才是互斥。而且 `mutationQueue` 的
`pending/running` 是模块级变量，popup 与 SW **各持一份实例** —— 就算在 popup 里调 `enqueue`
也串行不了 SW 的写入（`navigator.locks` 全仓零命中，已双复核）。

修法：三件迁移整体进 `enqueue('storageMigrations', …)`；popup 改发 `RUN_MIGRATIONS`
消息委托 SW 队列（与 `importGroups` 走 `sendMutation` 同一条先例），并**显式检查回包**
（`sendMessage` 对 `{success:false}` 是 resolve 不是 reject，不查就是失败静默通过）。

### P0 —— 三张浏览历史表的 RLS 从未启用

`tab_groups` / `tabs` / `user_settings` 的 12 条策略（3 表 × 4 类操作）一直在建，
但**全仓没有任何迁移 `ENABLE ROW LEVEL SECURITY`** —— PostgreSQL 的策略只在
`relrowsecurity = t` 时参与判定，**策略行存在 ≠ 策略生效**。
真库实测（24 条迁移按字典序全量重放）：三表 `relrowsecurity=f`，
匿名身份 `select` 读到全站行、`delete` 返回 `DELETE 1`。

**加重情节：门禁「查了但不判断」**。`migrationReplay.pg.test.ts:148` 的快照 SQL
确实带了 `relrowsecurity`，但 golden 比对的是 **policy 名字集合** ——
两库都不开 RLS 时名字完全一致，照样全绿。

修法：新增 `20261009120000_enable_rls_browser_history_tables.sql`，
**先确认四类策略齐备再启用**（缺任何一条 `RAISE EXCEPTION` 中止 ——
「RLS 开了但没策略」是默认拒绝，会当场锁死产品，比漏洞更严重）；
`verify()` 从「只查 profiles」扩到 7 张表查 `relrowsecurity` 并参与 ok 判定；
新增**行为验证**（插真数据 → anon 读必须 0 行、owner 正控必须 2 行、
匿名 UPDATE 后数据必须一字未改）。

顺带修了 fixture 失真：`DASHBOARD_FIXTURE` / `GOLDEN_SEED` 缺 `GRANT`，
anon 先被 `permission denied` 挡住，「表权限」与「行级策略」两道门混在一起，
RLS 行为验证根本跑不起来。

### P0 —— 迁移标志被覆盖（旧数据回滚覆盖新数据）

`storageAdapter.ts` 的 `migrateFromChromeStorage` / `migrateFromLocalStorage`：
`MIGRATION_SCAN_KEYS` 由 `Object.values(STORAGE_KEYS)` 全量派生、**包含 `migration_flags` 自己**，
于是搬运清单里出现这个键。流程是「① 开头读 flags（KV 可能为空 → `{}`）→
② 批量搬运（把源里的 flags 写进 KV）→ ③ 置位时用 ① 那个旧对象盖回去」——
源带来的其它迁移标志被抹掉。标志一丢，那个迁移就**重跑**，把更旧的数据再覆盖一次。

**第一版修复是错的**：我只做了「置位前重新读」，但批量写已经把 KV 原值覆盖了，
重新读读到的是被覆盖的那份。**是新加的测试把它抓出来的**（第二个用例红）。
改成三路合并（KV 现值 + 源现值 + 本次置位）才对。

### P0 —— 恢复会话的假承诺

`TabGroup.tsx` 先 `deleteGroup`、50ms 后才发 `OPEN_TABS`（恢复=消费原会话，产品负责人已确认此语义），
但回包文案写「打不开的标签**仍保留在会话中**」—— 那时会话已物理删除，是**假承诺**，
且与该语义自相矛盾。

**修法只改文案、不动顺序**：按锁定态分流（未锁定 →「原会话已从列表移除」；
已锁定 →「仍保留在会话中」，锁定组确实不走删除分支）。
SW 侧日志去掉它无权判断的那句（SW 不知道调用方锁没锁定）。
搜索侧两处 **fire-and-forget 补上回包** —— 它们原先完全看不见打开结果，而记录已被移除。

### P0 —— 保存预检失败仍报成功

`TabManager.saveCurrentTab` 有 3 条预检早退（内部页 / 固定页开关关闭 / URL 清洗后为空），
每条都自己弹了失败通知然后 `return` —— 而调用方**不看返回值**，无条件再弹
「当前标签页已保存」。用户连收两条互相矛盾的通知。

修法：返回 `Promise<boolean>`，两处调用方改 `if (saved)` 才发成功通知。
顺带修 P1：右键外层 catch 原只 `logError`（与快捷键同动作却零反馈），补「操作失败，请重试」。

### P1/P2 —— 诚实度与数据安全

- **设置读失败后用默认值覆盖真值**：`loadSettings.rejected` 无 reducer → Redux 停在
  `DEFAULT_SETTINGS` → `saveSettings` 盲写整份默认值覆盖真实设置，全程无声。
  修：`settingsReadFailed` 标记 + 写前拒绝 + `dispatchSaveSettings()` helper
  （判据只写一处，6 个调用点走它）+ 各处出声。
- **删除链路印记探测 fail-open**：新增 `supportsOpStampStrict()`（只供删除广播）。
  **第一版修法被现有测试证否过** —— 直接让宽松版抛错会打红
  `downloadChain.test.ts:783`「宁可少选列，不可让整次下载失败」（有意且正确）。
  正确方向是按调用方分流：上传/下载/digest 继续宽松，删除广播严格。
- **敏感键清单漂移**：原清单 5 项里只有 `migration_flags` 真正双向经 SecureStorage 落盘；
  `user_preferences` / `sync_tokens` 零写入方，`deviceId` 只有 get 无 set。
  收敛为 2 项 + 守卫（清单每个键必须有真实调用方；`auth_cache` 不在清单时源码必须
  有「为何暂不加密」的显式说明）。
- **键名与主题集合的第二份来源**：`journal` / `device_seq` / `tabvaultpro_device_id`
  三处手抄改引用权威表；`THEME_STYLES` 成为主题的唯一真相源（`ThemeStyle` 由它派生）。
- **上传节奏常量收敛**：防抖 3000ms 原先散在 5 处，收敛到 `src/core/syncTiming.ts`。
  刻意不合并 30s 协议超时 / 35s 保护窗口 / Toast duration（语义不同，数值接近是巧合）。
- **导入结果报数量**：新增 `importDetailed()`（`importData` 保留为 boolean 薄包装，
  9 处既有测试零改动），UI 改报「共 N 个、导入 X 个、跳过 Y 个」，并改用
  `dispatch(loadGroups())` 不再 `window.location.reload()`（reload 会把提示一起刷掉）。
- **新手引导文案**：遮罩是全屏且无点击处理器，文案却让用户「点击顶部按钮」→ 照做没反应。
  改为「关闭本引导后…」。
- **`「删除前确认」改名「删除会话前确认」**：该开关只接进整组删除与批量删除，
  单标签 X 完全不受控 —— 代码注释自己写着「该开关只应管单组删除」，只有 UI 标签在撒谎。
  同时给 X 的 title/aria-label 补「无法恢复」。

### 文档与线上

- **商店文案自相矛盾**：中文段先写「数据传输到你的云端账户」、后写「不上传你的浏览历史」；
  `Web history` 行与 `Website content` 行直接冲突。改为与 `privacy.html` 同口径，中英 + 数据表三处同改。
- **README「30 天后自动清理」**：与 `privacy.html` 的「随同步上传执行、不再登录则推迟」不同口径，
  README 单点夸大。改为同口径。
- **`docs/rebuild-plan.md` 说谎**：顶部称「影子双写上线，灰度 100%」且「本文档是重构唯一指导源」，
  而 `yjs` / `dexie` 在 `package.json` 与 `src/` 全量零残留。加逐条状态表横幅作废，
  保留决策痕迹但封死「照此实施」。
- **线上下线旧网页版**：`tapstack-two.vercel.app` 的项目 build 仍写着 `pnpm build:web`
  （该脚本已随 `src/web/` 删除）⇒ **最近 11 次生产部署全部 Error**。改为只托管
  `privacy.html` 的静态部署：SPA 下线（`/` 404）、隐私政策保留（200，内容更新）。

### 死代码与测试假绿

- 删除 4 个确认零引用的文件（`webTombstone.ts` / `UserProfile.tsx` / `background.ts` /
  `hydrationDecision.ts`）+ 其纯函数测试。**关键：删实现不连安全不变式一起丢** ——
  `hydrationDecision` 守护的「空读不得被固化」改挂到活代码上
  （断言 TabList 不得出现 `if (lastLoadedAt) return`、popup 不得重建水合路径）。
- **测试假绿两条**：① glob 退化时 65 个子目录测试静默消失、全绿零 skip
  （新增**顶层**外部锚点 `globRecursionAnchor.test.ts`）；② 商店文案抽取的长度阈值
  `> 400` 放行 440 字符的坏抽取（改为与独立推导逐字比对）。
- **推翻一条专家结论**：专家称「删掉 `map(normalizeImportedGroup)` 后 32 个导入测试全绿」，
  实测 **6 红（4 个既有）** —— 接线一直有守护。教训写进测试注释：
  引用外部结论前必须自己跑一遍变异。

### 我犯的错（记录在案，因为它们决定哪些修复可信）

1. **守卫写在被变异的函数体内** —— 变异把整个函数替换掉，守卫跟着消失、14/14 全绿。
   这正是我刚修的 glob P0-1 同一类自我指涉错误。
2. **变异验证两次无效**（基线本身红 / 变异脚本没写入），看到「全绿」差点当成守卫生效。
3. **差点造成双重导入**：给 `importFromOneTabFormat` 加统计时没删原有 `await`，
   会静默导入两份副本 —— **30 个既有导入测试全绿**，靠读 diff 自查发现。
4. **差点把不可达路径报成 P0**：P2-2「危险 URL 丢弃不告知」实测 9 个边界用例
   `droppedTabs > 0` 的用例数 = **0**，判为非缺陷、未改代码。
5. **猜导出名去搜引用，全猜错**（实际是 `applyWebRemoveTab` / `mintWebStamp`）。
   零引用结论必须基于真实标识符。

### 门禁

| 项目 | 结果 |
|---|---|
| `node --test "tests/**/*.test.ts"` | **1025 pass / 0 fail / 0 skipped** |
| `pnpm validate` | PASS（type-check + tests + lint + tests + build + bundle） |
| PG 真库门禁 | 67 pass / 0 skipped（含迁移两遍重放 + golden 双库 + RLS 行为验证） |
| 变异验证 | 11+ 组，全部「改坏 → 红 → 还原 → sha256 一致」 |
| 测试数 | 995 → **1025**（+30） |

---

## v1.22.15（2026-10-07，待提审）

**这版的由来**：1.22.14 提交后做了一轮五方向并行审查（1.22.12 / 1.22.13 / 1.22.14 各一，加上迁移与商店文案、测试质量两条横向）。结论是：**代码层面两个 P0 修复是真的关上了**，但「修复被守卫住」这件事没做到，而且商店面还挂着已下线功能的宣传。本版修的是审查确认的问题，并把「守卫本身不会红」这一类也补上。

### P0 —— 会丢会话的分页缺陷

1. **下载分页的排序键不允许并列**（`src/utils/supabase/download.ts`）。分页是 offset/limit，排序只给了 `created_at`。而 `created_at` **不是唯一键**：`oneTabFormatParser` 给同一批导入的每个组盖同一个 `now`，`factory` 用 `new Date().toISOString()`，连续快存会撞在同一毫秒。Postgres 对并列行不给跨查询顺序保证 ⇒ 页窗口重叠/跳过。

   **实测量级**（真 PG 16，450 行同一 `created_at`）：三次连续下载分别漏掉 **113 / 114 / 105** 个不同 id，而且因为是短页退出（`page.length < PAGE_SIZE`），**没有任何报错**。

   **后果是真丢数据**：漏掉的行被 `mergeOpStamped` 当作「云端不存在」，本地旧副本随后上传，覆盖掉更新的云端版本。

   **原注释还写着错的结论**：「分页窗口基于稳定排序，页间无重叠/无遗漏」——这句话在非唯一排序键上不成立。

   修法：`.order('created_at', {ascending:false}).order('id', {ascending:false})`，排序成为全序。

   **为什么原测试抓不到**：`upsertDownloadBatching.test.ts` 的 fixture 用 `new Date(2026,0,1,0,0,0,i)` 造**严格递增**的 created_at，假云端又按插入顺序 slice —— **并列这个维度根本没被建模**。那是 fixture 的产物，不是现实。

### P1 —— 读不到就必须说读不到，而不是编一个答案

2. **`getLastUploadTime` 的 `catch { return null }`**（`src/utils/storage.ts`）。`null` 的语义是「从未上传过」，于是瞬时读失败（死句柄看门狗 abort / quota / 事务 abort）会把 35 秒的 `recent_upload_guard` 静默关掉。它与 `getPendingUpload` 在**同一个 `Promise.all`** 里被 `downloadAndMerge` 读取 —— 1.22.13 只把其中一个改成了 fail-closed。现在改为抛错，与兄弟函数同口径（调用方的 catch 已经会返回 `precheck_unknown`）。

3. **JSON 备份导入的假成功**（`src/utils/storage.ts`）。全部标签都是不可存储 URL 时，`applyImportGroups` 过滤后返回空，但 `importData` 一路返回 `true` ⇒ 弹「成功」+ reload，列表什么都没多。1.22.14 把 `importFromOneTabFormat` 修好了，**JSON 这条路漏了**。现在发送前判「可导入组数」，为 0 时如实失败。

3b. **旧备份文件的形状容错**（`src/core/normalizeTabsData.ts` 新增 `normalizeImportedGroup`）。这是用户报的「导入之前下载的标签失败」的**直接根因之一**：JSON 备份是用户手上的文件、形状不可信，而 `applyImportGroups` 直接 `group.tabs.reduce(...)` —— 组里没有 `tabs`（旧版本/云端导出用的是 `tabs_data`）就抛 `Cannot read properties of undefined (reading 'reduce')` 并让 `importData` 返回 false：用户看到「导入失败」却无从得知原因，**而他的文件其实是好的**。

   下载路径早就用 `normalizeTabsData` 处理同一类形状（云端历史坏行），**导入路径此前没有** —— 这个不对称就是缺陷本身。现在两处同口径，并顺带补了**元素级**归一化（本地 `Tab` 是 camelCase `createdAt`/`lastAccessed`，云端 `TabData` 是 snake_case `created_at`/`last_accessed`；`normalizeTabsData` 只管容器形状、不管元素，所以从旧文件导入会丢时间戳 —— 该缺口在 `docs/dev-plan-2026-10-05.md` 的 A3 里已登记过）。容错清单：`tabs_data`/`tabsData`/`groups` 键名、嵌套 wrapper（`tabs_data:{tabs:[…]}`）、组与标签两级的 snake_case、缺 `name` 的可读回退、旧键 `is_locked`。

   **验证**：6 条新用例走真实 `importData` 路径（断言发往 SW 的载荷）；另验证了分层不变 —— popup 交给 SW 的是**原始**标签，`chrome://` / `edge://` / `javascript:` 仍由 SW 侧 `applyImportGroups` 在落库前丢弃（安全边界未被放宽），`file://` 与 `blob:` 保留。

4. **恢复会话路径把广播警告丢掉了**（`TabGroup.openAllTabs` + `SearchResultList` 三处）。删除类操作的第二步（云端删除标记登记）失败时 SW 会带 `broadcastWarn` 回来；UI 不读它，用户就以为删除/恢复成功，而云端行还活着 ⇒ 对端下次合并把会话复活（v1.22.0 起无回收站）。这两个调用点恰好是**最常用的「恢复整个会话」**。

   **为什么原守卫抓不到**：`tests/noSilentFalseSuccess.test.ts` 断言的是 `deleteBroadcastWarn` 出现次数 `>= 3`。那是**计数**不是不变量 —— 实测再加一个不读警告的 `dispatch(deleteGroup(...))`，14 个用例依然全绿；而搜索列表那条路径里它出现 **0** 次却一路绿灯。已改成「每个删除类调用点的链上都必须读」，并对 4 个组件文件逐个调用点校验。

5. **`precheck_unknown` 等内部代号直接弹给用户**（`src/components/sync/SyncButton.tsx`）。增补中文文案映射（`precheck_unknown` / `pending_upload_failed` / `snapshot_failed` / `already_syncing`）。

### 商店面 —— 提审阻塞

6. **新手引导仍在宣传已下线功能**（`src/components/onboarding/OnboardingSteps.tsx`）：还有整张「备注与收藏」卡、「⭐ 收藏重要会话」卡，以及三处提到「备注」的句子。**这是每个新用户的第一屏**。
   顺带发现审查报告没提到的第六处：一张 **「Web 仪表盘」**卡（网页版在 1.22.11 已物理删除，README 已不再宣传），以及卡片文案里的「保存、重命名、备注都自动备份」。
7. **搜索框 placeholder / aria-label 与空态提示**（`Header.tsx` / `SearchResultList.tsx`），并同步了 `OnboardingGuide` 的聚光灯锚点（`a11yLists.test.ts` 的「选择器能命中真实元素」守卫就是为这种失配准备的）。
8. **商店 listing 仍在写「点开标签会自动从会话中移除」**（中英各一处）—— 正是 1.22.13 宣告反转的行为，与同一份提交的 changelog 自相矛盾。
9. **搜索结果的「已打开」态从不渲染**：`markTabOpened` 一直在跑，但 `SearchResultList` 的行没有条件类也没有徽章（`DraggableTab` 有）。点开搜索命中后界面毫无变化，用户分不清「已标记」与「没生效」。已补齐，并统一了删除按钮文案。
10. **两张商店截图已于 2026-10-08 重拍**（页脚 v1.22.15），两行状态 ✅ Ready。

### 迁移重放 —— 静默跳过后面的安全迁移

11. **全量重放会在第 2 个文件中止，后面 22 个文件从未尝试**。5 个历史文件是裸语句（真 PG 16 两遍重放实测）：
    - `20251014063149` 2 条 `ALTER PUBLICATION … ADD TABLE`（**排在最前，所以一挂就断掉全部后续**）
    - `20251014063156` 8 条裸 `CREATE POLICY`
    - `20260303044037` 3 条、`20260303044048` 2 条（审查报告漏了这个文件）、`20260326034522` 4 条（小写 `create policy`，grep 大小写敏感时容易漏）

    而 `scripts/supabase-migrate.mjs` 用一个 try 包住整个 for 循环、出错即 `process.exit(1)` ⇒ 后面的 `20261005000000`（profiles PII 收口）与 `20261005000001`（REVOKE）**从未被尝试**，`verify()` 也不跑。

    修法：每条 DDL 先查存在性（`pg_catalog.pg_policy` **基表**，不用按 `polroles` 过滤的 `pg_policies` 视图）。另把 `20260924090000` 的 5 条也从不稳定的视图判定改成基表判定（它重放能过只因为迁移器以 owner 身份连接）。

12. **verify 把「迁移未执行」报成通过**：缺 purge 函数时旧实现打印「尚未执行 —— 跳过」并 `return true`，实测在那种库上确实输出 `VERIFY OK`。现改为失败（缺哪个函数都报），并补上「profiles 存在但 RLS 关闭」这条此前也没检的路径。

### 真库门禁本身（P0 —— 门禁在开发机上根本没跑起来）

13. **两个 `*.pg.test.ts` 起的 Postgres 在本机必挂，而挂法是「cancelled」不是「fail」**。
    Homebrew PG 16.15 在 `LC_ALL` 为空/未设时拒绝启动，真原因只写在 pg.log 里：
    `FATAL: postmaster became multithreaded during startup` / `HINT: Set the LC_ALL environment variable to a valid locale.`，
    而 pg_ctl 自己只回一句「无法启动服务器进程」。实测：`LC_ALL`+`LANG` 全无 → 起不来；
    `LC_ALL=` `LANG=` → 起不来；`LC_ALL=C`（或 `LANG=C`）→ 正常。
    测试用 `execFileSync` 原样继承宿主环境，于是本机（以及任何 locale 不完整的环境）上
    **13 条真库用例全部 cancelled、fail 0** —— 报告看起来一切正常，门禁等于不存在。

    修法（新共享起停器 `tests/_helpers/pgHarness.ts`，两份门禁共用）：
    - 所有 initdb/pg_ctl/psql 子进程统一注入 `env: { ...process.env, LC_ALL: 'C', LANG: 'C' }`；
    - 起库/初始化失败**不再从 `before` hook 抛**（那会让 node:test 把整组标成 cancelled），
      而是记进 `setupError`，由 `gate()` 在每个用例里 `assert.fail`，并把 pg.log 尾部
      带进失败信息 —— 「装了二进制但库起不来」一定是红的；
    - `SKIP_REASON` 只留给「`initdb`/`pg_ctl`/`psql` 根本不存在」一种情形；
    - 启动前探测端口：首选端口被占就向后换（每份门禁 20 个的窗口），全占满则显式失败
      并列出占用端口，不静默 skip；两份门禁的首选端口仍为 5599 / 5601，互不冲突。

### 验证

- `pnpm test` **935 → 995**（1.22.15 收尾实测：pass 995 / fail 0 / **cancelled 0** / skipped 0，退出码 0），`pnpm validate` 全绿，首屏 **193.6KB**（预算 240KB）。
  cancelled 从 13 归零就是上面第 13 条的直接结果：真库门禁此前在开发机上整组 cancelled，现在真的在跑。
- **新增端到端同步走查** `tests/syncRoundTripWalkthrough.test.ts`（按时间顺序走完一条旅程，而不是拆成不变量）：A 建 3 个会话 → 上传 → B（全新设备）下载（逐字段一致）→ A 改名 → B 看到新名字 → A 删除 → 上传广播 → B 下载**不复活**；另加规模走查（260 个会话、`created_at` 故意全并列）验证分批上传（6 个 UPSERT 请求）与分页下载（每页 200）零丢失。假云端与 `syncNoResurrectInvariants` 同一套 PostgREST 子集契约（不另造方言），另加两个 BEFORE UPDATE 守卫的逐条判定。变异验证：把上传路径的 `markCloudGroupsAsDeleted` 改成 no-op ⇒ 走查转红。
- **每个修复都做了变异验证**（改回缺陷 ⇒ 必须变红），逐条结果见下节。
- **迁移用真 PG 16 两遍/三遍重放**验证，并做了**终态等价性对比**：把 HEAD 的原始迁移跑在「对象事先不存在」的库上取参考快照，与加守卫后的版本对比 `pg_policies`（含 qual / with_check）/ `pg_publication_tables` / `regrowsecurity` / 触发器 / 函数（含 SECURITY DEFINER 与 ACL）/ 列定义 —— **89 行快照逐字相同**，证明守卫只把「重复创建」变成 no-op，没有改变终态。
- **新增杀菌门禁**：`tests/guards/migrationReplay.pg.test.ts`（文本护栏 + 真库两遍重放，无 PG 时 skip）、`tests/downloadPaginationStability.test.ts`（在假云端里建模「并列行顺序不稳定」，并断言 id 集合完整性 + 任一页失败必须整体失败）。

### 变异验证结果（改回缺陷 ⇒ 红）

> 2026-10-08 收尾时逐条复跑的实测结果（括号里是变红的用例条数）；每条都已恢复并复验全绿。

| 变异 | 结果 |
|---|---|
| 去掉下载的 `id` tiebreaker | 红 5 条（`downloadPaginationStability` 4 + 端到端走查 1；同批的 `upsertDownloadBatching` 不红——它建模的是分批不是排序） |
| 恢复 `getLastUploadTime` 的 `catch { return null }` | 红 |
| 关掉 importData 的「全不可导入」守卫 | 红 |
| 去掉 `importData` 里的 `normalizeImportedGroup` | 红（4 条） |
| 在 TabGroup 加一个不读 broadcastWarn 的第 4 个删除点 | 红（**旧的计数断言在这个变异下是全绿的**） |
| 去掉恢复路径的 broadcastWarn 读取 | 红 |
| 引导文案写回「备注」 | 红 |
| listing 写回「自动从会话中移除」 | 红 |
| listing 写回「收藏」 | 红 |
| 迁移里写回一条裸 `CREATE POLICY` | 红（文本护栏 + 真库重放同时红） |
| 迁移里写回裸 `ALTER PUBLICATION` | 红 |
| `20260924090000` 退回 `pg_policies` 视图判定 | 红 |
| 去掉起 PG 子进程的 `LC_ALL`+`LANG` 注入（回到修复前） | 红（**真库用例全部 fail、cancelled 0**；只去掉其中一个键不够，另一个会补位，所以反向验证要两个一起去） |
| `verifyProfilesRls` 的「profiles 不存在」改回「跳过 + return true」 | 红（1 条，cancelled 0） |

### 本版没做（有意）

- **商店截图已在本版内完成重拍**：`scripts/make-store-screenshots.mjs` 在 1.22.13 已经改好（不再注入备注/收藏），2026-10-08 执行并生成两张新图（页脚 v1.22.15），状态 ✅ Ready。
- **1.23 的治本项未动**：增量上传（本地 dirty 标记）、导入幂等、同步失败退避 —— 1.22.14 已把范围限定在止血，本版延续。
- **测试基建的其余缺口**（审查发现，未在本版关闭）：`purgeExpiredCloudTombstones` 仍无覆盖（它是唯一物理 DELETE 云端行的代码）；`backgroundSync` 的 fail-closed 守卫仍无运行时测试（删掉它 935 全绿）；`downloadSettings` 的 snake_case→camelCase 映射无测试；原生拖拽的边界与节流无行为测试；`upsertRowsInBatches` 的「按批失败」注释与实现不符（实现是幂等全量重跑收敛，不是按批隔离）。建议单独一版做。
- **agent 侧发现但未修的小项**：`productEvents.ts` / `diagnostics.ts` 里还留着 `session_favorited` 这个死事件名（英文标识符，用户不可见）；`downloadTabGroups` 以 PostgREST 错误对象（非 `Error` 实例）拒绝，调用方都取 `.message` 所以不影响行为。

---

## v1.22.14（2026-10-07，待提审）

**这版的由来**：Jasper 实测三个症状——导入之前下载的标签失败、清理重复标签
极慢卡死报错、同步上传下载都有问题。诊断结论：三者是同一根因的不同表现
（「每次操作整库读写 + 同步全库单请求重传 + MV3 SW 随时被杀」在大库下整体过载），
叠加用户实际在线版本停留在 1.22.7、1.22.13 的两个 P0 修复尚未到达用户。
整改方案定调「本地为主、同步次要」（Jasper 拍板），本版是止血（方案第 4–6 项）。

### 改动

1. **上传分批 upsert**（`upload.ts` 新增 `upsertRowsInBatches`，批大小
   `UPSERT_ROW_BATCH_SIZE=50`）：此前整库塞进单个 upsert，每组带加密后的
   tabs_data，几百组请求体可达数 MB，撞网关体积/超时上限 → 上传失败 →
   pending_upload 不清 → 60s alarm 整库重传无限循环。删除广播（`.in()` 过滤器）
   早在 1.22.5 就分批了，upsert 一直没有 —— 本次补齐。
2. **下载分页**（`download.ts`，`DOWNLOAD_PAGE_SIZE=200`，supabase-js 的
   `.range()` 实际发 `offset`/`limit` 查询参数）：与上传同一类根因的单次全表
   select。任一页失败即整体失败（fail-closed），绝不用半份数据合并。
3. **导入超时不再谎报失败**（`storage.ts` mergeImportedGroups）：sendMutation
   把 30s 超时折成 `{ok:false}`，旧实现照单全收报「导入失败」；但命令已进 SW
   队列且会执行完，用户重试同一份文件 = 整份副本（applyImportGroups 永远新建组）。
   现在超时按「已受理」处理，仅 TIMEOUT_REASON_PREFIX 命中，明确拒绝仍如实失败。
4. **OneTab 导入 0 可导入组时说明原因**（`storage.ts` + HeaderDropdown）：
   「全无效 URL 假成功」与「0 组」两条坏路径合并为一次前置判定，失败原因
   （区分「没解析出组」与「解析出 N 组但全被 URL 清洗丢弃」）直达弹窗。
   importFromOneTabFormat 返回 `{ok, reason?}`，调用点仅 UI 一处。

### 测试（新增 8 条，全部变异验证）

- `tests/upsertDownloadBatching.test.ts`（4 条）：fetch 层假云端断言真实落库
  与请求形状——130 行拆 3 批每批 ≤50、30 行单批、450 行 3 页 (0/200/400)、
  50 行单页。变异：批大小改回 100000 → 分批断言变红。
- `tests/localStorageFreshness.test.ts` 追加 4 条：超时视为受理且只发一次命令
  （变异：超时前缀判断改坏 → 红）、明确拒绝仍报失败、全无效 URL 如实失败且
  不落盘、混合文件有效部分照常导入。
- 既有 7 个带假云端的测试文件统一补了 `offset` 分页仿真（matches 忽略清单 +
  slice(offset, offset+limit)）——真实 PostgREST 本来就支持 offset，是桩此前没仿真到。

### 未做（属于治本 1.23，不在止血范围）

- 增量上传（本地 dirty 标记，只传变更组）——把同步从「每轮都贵」变「只传增量」的根。
- 导入幂等（同组名+标签指纹跳过）。
- 同步失败退避策略。

### 验证

`pnpm test` 935/935；`pnpm validate` 全绿（type-check / lint / build / 首屏 192.1KB）。

## v1.22.13（2026-10-07，待提审）

**这版的由来**：1.22.12 提交商店审核后，Jasper 决定「先把所有问题修完再发」，
于是组了一轮五方向专家团体检（定位价值 / 交互 / 数据一致性 / 安全合规 / 架构），
报告在 `docs/expert-audit-2026-10-07.md`。本版修的是其中**会丢用户数据**和
**用户可见的意外**那部分；纯工程债（死代码、大文件拆分）与产品定位决策未动。

### 两个 P0（丢数据）

1. **`downloadAndMerge` 的 precheck 从 fail-open 改为 fail-closed**
   （`syncEngine.ts:307-310`）。同一个 `pending_upload` 判据，
   `backgroundSync.ts:126-142` 读不到就中止下载，而 popup 手动/自动同步这条路径
   读不到却**继续下载** → IndexedDB 瞬时读失败时用云端旧数据覆盖本地未推送的新状态。
   两处现在同口径，中止原因 `precheck_unknown`。

2. **`ensureOpStampMigrated` 不再用 `getQueueDepth()` 猜自己在不在队列内**
   （`opStampMigratedGuard.ts`）。旧判据 `getQueueDepth() > 0` 表达的是
   「队列里有别人的活」，却被当成「我在队列内」→ SW 冷启动时若恰有 `sync:download`
   在跑，迁移会在**队列外**全量读-改-写 groups，与那条 job 的 `setGroupsImmediate`
   交错，违反单写者不变量；被覆盖的一方已经报成功给用户，且 v1.22.0 起无回收站。
   改为显式入参：`syncEngine.ts` 传 `true`（自己在 job 内）、`service-worker.ts` 传 `false`。
   顺带把该路径从「缓存读 + 防抖写」改为 `getGroupsForWrite()` + `setGroupsImmediate()`。

   **两个 P0 都躲过了全部 926 个测试** —— 前者的注入点不存在，后者要复现需构造
   「队列里有别人的活 + 同时触发 onInstalled」。因此补了 `tests/p0DataSafetyGuards.test.ts`，
   并按项目纪律做了**变异验证**（改坏实现必须变红）：5 条断言、3 次变异全部被捕获。

### 交互诚实度

3. **P1-2 点开标签不再删除记录**：原 `TabGroup.handleOpenTab` 与
   `SearchResultList.handleOpenTab` 都会在开标签后顺手 `deleteTabAndSync`——
   把不可撤销的破坏性操作挂在看起来像导航的点击上，且两处都与删除按钮撞形。
   现在点开只置 `tab.openedAt`（纯内存 UI 态，不落盘、不同步），
   该行灰化 + 显示「已打开」徽章，「从会话中移除」变成显式的独立按钮。
   `Tab` 类型新增 `openedAt?: number`，锁定组不显示该态（锁定恢复不消费）。

4. **P1-3 保存按钮给回包反馈**：原先只 `sendMessage` 不 await、不处理回包，
   保存会关掉整个窗口的标签但页内零反馈。现在 await 回包 + `isSaving` 禁用态 +
   「保存中…」/「已保存」/错误文案。tooltip 与 aria-label 补上「并关闭这些标签页」——
   **onboarding 聚光灯锚点同步改了**，`a11yLists.test.ts` 的「选择器能命中真实元素」
   守卫当场抓到了这个失配（改文案 → 第 4 步引导高亮静默消失）。这是该守卫存在的意义。

5. **P2 静默失败补说明**：3 秒冷却期（`TabGroup.tsx:297` 原本裸 `return`）、
   内部页面/固定标签页/不安全 URL 三处 `TabManager.saveCurrentTab` 静默 `return`、
   搜索结果打开标签的 `sendMessage` 无 `.catch`。Toast 的英文大写
   （`{type}` → `TYPE_LABEL[type]`）。`ModalFrame` 补 `overflow-y-auto` +
   内层 `min-h-full`（长确认框的按钮此前可能点不到，对齐 `AuthModal` 的写法）。

### 数据迁移

6. **P1-7 `MIGRATION_KEYS` 漏 5 个键**（`keys.ts` / `storageAdapter.ts`）。
   手抄的 9 项子集 vs `STORAGE_KEYS` 的 16 项，漏掉 `pending_delete_ids` /
   `device_seq` / `last_upload_time` 等——对 v1.21.x 直升的老用户是真实数据丢失
   （删除广播队列 / Lamport 时钟 / 下载保护窗口）。
   注意 `storageAdapter.ts` 里 localStorage 迁移那段的注释**自己写着**
   「pending_upload 不在迁移键表内」，就是这个 bug 的自述。
   改为 `MIGRATION_SCAN_KEYS` 由 `STORAGE_KEYS` 全量派生，
   `storageKvConvergence.test.ts` 的断言随之从「逐字相等」升级为「覆盖 STORAGE_KEYS 全集 + 反向无发明键」，
   双向变异均验证。

### 文档

7. README 不再宣传已移除的「拖拽排序」，不再声称「Yjs 影子双写 100% 灰度」
   （依赖与影子链 1.22.11 已物理删除，`package.json` 无 yjs/dexie）。

### 产品决策落地（Jasper 定，2026-10-07）

8. **删除「备注」与「收藏」两项功能（减法，不是上云）**。

   **决策过程值得记下来**：体检报告的 P1-5 建议「要么加上云，要么在文档里诚实标注
   仅本机」，两条路都合理。我第一版选了「加上云」，给的理由是「文档把它们和跨设备
   同步并列宣传了」——**这个理由是错的**，它把「文档承诺了」当成了「产品该有的
   行为」。被追问「这两项是标签管理器本身的功能吗」后重新审视：收藏的全部作用只是
   「列表排序时置顶」（`TabList.ts:134-136`）；备注是「给自己写一句话 + 参与搜索」，
   而会话名已经在承担「给这组标签起名字」的职责，备注是它的弱重复。
   负责人定：**「如果不是核心功能，就不要上去」** ⇒ 整条删除，不保留本地版。

   删除范围（17 个文件）：
   - 类型：`TabGroup.notes` / `TabGroup.isFavorite`
   - mutation 全链：`updateGroupFields` op、`applyUpdateGroupFields`、SW 的
     `case 'updateGroupFields'`、`persistGroupFields` thunk、`updateGroupFields`
     reducer、`GroupLocalFields` / `snapshotGroupLocalFields` / `restoreGroupLocalFields`
   - UI：收藏按钮、备注按钮、`FavoriteIcon` / `NotesIcon`、备注 textarea 编辑区、
     卡片上的收藏星标、搜索结果里的收藏星标与备注高亮
   - 搜索：`searchNotes` 选项、`NOTES_EXACT` / `NOTES_PARTIAL` 权重、
     `MatchDetail.field` 的 `'notes'`、搜索建议词里的备注
   - 列表排序：收藏置顶规则（现在纯按 createdAt 倒序）
   - 诊断：`favoriteSessionCount`、`updateGroupFields` 白名单项、
     `syncPreview` 指纹里的 notes/isFavorite
   - 测试：5 个文件中 14 条直接测这两项的用例
   - 文档：README 三处、商店文案中英各两处、截图脚本的演示数据注入
   - 首屏体积 193.6KB → **192.0KB**

   **遗留待办**：`store-assets/screenshot-1-main.png` 里**确实有收藏星标与备注块**
   （`scripts/make-store-screenshots.mjs` 的演示数据注入了这两项）。商店审核会核对
   截图与描述一致性，**提审前必须重拍**。已在 `CHROMEWEBSTORE.md` 的
   Screenshot Notes 标注，并把状态从 ✅ Ready 改成 ⚠️ 需重拍。

9. **去掉「保险箱」定位词**。产品自称「工作会话保险箱」，但 1.22.0 起删除即物理
   清除、无回收站、不可恢复——保险箱的心理契约是「丢了能找回来」，定位词与实际
   行为直接互斥。负责人明确「不需要回收站，也不需要保险箱」：
   - `manifest.json` 的 `default_title` → 「TapStack - 保存与恢复工作会话」
   - README 定位段 → 「工作会话收纳箱」，并加一段说明为何去掉该词（防止将来被加回来）
   - 隐私政策与商店文案原本就写「不提供回收站」，现已一致

### 线上验证（本版实测，非推断）

10. **安全 P0-1 / P0-2 已闭环**（此前报告标为「需线上验证」）：
    - `node scripts/anon-rls-probe.mjs` → profiles / tab_groups / user_settings / tabs
      **anon 读到 0 行**。邮箱泄露确认止血。
    - `POST /rest/v1/rpc/purge_expired_cloud_tombstones` → **HTTP 401 / 42501
      permission denied**；`body_tombstone_expiry_days` 同。对照实验：一个确定不存在的
      函数返回 **404 / PGRST202**，与此不同 —— 证明这两个函数**确实存在**
      （不是「不存在所以报错」），而 anon 被正确拒绝。**迁移 `20261005000001` 的
      REVOKE 已在线上生效。**

### 验证

`pnpm validate` 全绿：type-check(src/tests) / lint(src/tests, max-warnings 0) /
build / 首屏体积 192.0KB ≤ 240KB。`pnpm test` **927/927 通过**
（926 + 新增 9 条守卫：5 条 P0 数据安全 + 4 条「备注/收藏不得复活」）。

新守卫同样做了变异验证：把 `isFavorite` 加回 `TabGroup` 类型 → 红；在 README
能力介绍里写回「备注」→ 红；把 precheck 改回 fail-open → 红；把 `inQueue` 改回
`getQueueDepth` → 红；把真值读+直写改回缓存读+防抖写 → 红；迁移键表漏登记 /
发明键 → 红。

### 本版减法带来的用户可见变化

- 会话卡片上少了两个图标按钮（收藏、备注），操作区从 5 个降到 3 个
- 卡片不再显示备注块，所有会话的卡片高度变得一致
- 搜索不再匹配备注内容（会话名 / 标签标题 / URL 不受影响）
- 列表排序不再有收藏置顶，纯按保存时间倒序
- 导入的旧数据若含 `notes` / `isFavorite`，会随组保留但界面不再展示

### 本版没做（有意）

- P2 死代码（`hydrationDecision.ts` / `journal.ts` / `upload.ts:migrateToJsonb`）、大文件拆分、
  ADR 体系均未动 —— 不是发版阻塞项，且删死代码需先确认三个测试文件里哪些断言只测死代码。
- P1-6（设置同步无冲突检测、整行覆盖）未动 —— 需要改 `user_settings` 表结构与合并
  策略，工作量与风险高于本版其余各项，建议单独一版。
- 商店截图需重拍（见上），这是提审前的阻塞项。

## 如何追加一版

1. 版本号五处同步：`package.json` / `manifest.json` / `.env.example` / `README.md` / `CHROMEWEBSTORE.md`
   （`pnpm validate` → `scripts/validate-extension.mjs` 会校验，漏了会红）。
2. 在本文件顶部插入一节，标题格式：`## vX.Y.Z（YYYY-MM-DD，商店状态）`。
3. 状态用统一措辞：`已发布（日期）` / `已提交审核` / `未上架（并入 X.Y.Z）` / `待提审`。
4. 打 tag（**别漏**——v1.22.9 就曾漏了 tag，直到 1.22.10 发版才补）：
   `git tag -a vX.Y.Z <bump-commit> -m "TapStack X.Y.Z：一句话概括"`
   推送时**点名推** `git push origin vX.Y.Z`，不要 `git push --tags`（陈年旧 tag 会因
   workflow scope 被拒整批失败）。
5. `tests/releaseNotes.test.ts` 会校验本文件最新一节的版本号 == `package.json` 版本号，
   忘了写这一节会红。

---

## v1.22.12（2026-10-06，待提审）

- **触发**：用户报三件事——清理重复标签报错无法清理、数据同步异常、导出数据重新导入有问题。
  复查确认三类都真实存在，且**前两类的根因此前无人修复**（不是回归，是一直存在）。
- **两条独立的死锁路径**（这是本版的核心）：
  1. **IndexedDB 死句柄**：MV3 的 SW 空闲约 30s 被 Chrome 回收，浏览器**单方面**关闭
     IndexedDB 连接，但 JS 变量仍指向死句柄；`db.transaction()` 在其上既不 resolve 也不
     reject → Promise 永久挂起 → `mutationQueue` 的 `running` 永为 `true` → 之后所有语义
     命令与同步任务都排在它后面。线上 `removeTab.wait 34939ms` 的量级与 SW 回收时长吻合。
     `.workbuddy/memory/2026-10-06.md` 已把它记成「真 P0」，但代码里从未修过：
     只有 `onblocked` / `onversionchange`，**没有看门狗**。
     修法：5s 上限判失败 + 丢弃句柄 + 下次重新 open。死句柄无法被唤醒，一次失败可以
     重试，永久挂起不能。顺带补 settle 门（请求成功后到达的 `onabort` 不得二次 reject）
     与 `finally` 拆定时器（否则长会话累积定时器风暴）。
  2. **Supabase 请求无上界**：`client.ts` 每次 PostgREST 都是裸 `fetch`，无 `AbortSignal`、
     无上界。与 ① 是**两条独立路径**（本地存储 / 网络），此前只堵了 ①。
     修法：`global.fetch` 包 `AbortController`，45s 上界。取 45s 而非更低是因为必须
     **大于 popup 的 30s 协议上界**，否则用户先看到失败、再看到其实成功。`abort` 而非仅
     `reject`：只 reject 不 abort 的话连接仍挂着，等于没超时。
- **三处「谎报成功」**：无墓碑模型下删除分两段——本地物理移除 + 云端行标 `is_deleted`
  （广播）。第二段失败时本地确实删掉了，但云端行还在 ⇒ 对端下次合并当 remote-only 复活。
  SW 自 2026-10-05 起会如实返回 `broadcastWarn`，但只有 `deleteGroup` / `deleteAllGroups`
  经 `unwrapDeleteResult` 接住；**清理重复、拖拽搬空、单标签删除**三条直接
  `return res.payload!`，把警告连同 `MutationResult` 一起扔掉——用户看到「成功」，
  而这些会话会在其它设备上复活。修法：三处统一走 `DeleteOpResult`，UI 三处调用点
  surface 警告。
- **一条假守卫**：`tests/noSilentFalseSuccess.test.ts` 里那条名叫「cleanDuplicates /
  moveTab 同样接入（防止只改了三处）」的用例，调的实际是 `deleteAllGroups` +
  `renameGroup`——**恰好绕开了真正有问题的两个 op**。正是它让 899 全绿掩盖了上面的漏洞。
  已改成真调，并补了 UI 侧接线断言。
- **超时后的假回滚**：`protocol` 超时的语义是「popup 不再等了，SW 侧仍在继续」
  （`mutationProtocol` 与 `listErrorCopy` 的文案都这么写），但三个删除 reducer 一律整段
  还原 UI。于是磁盘上可能已删的内容被显示回来，用户看到「刚才明明删了，怎么又回来」，
  会去重试、会质疑数据完整性。超时现在**保留乐观结果**并给出可行动文案；明确的失败
  （SW 拒绝、存储抛错）才整段还原——那时磁盘确实没变。判据抽成 `isTimeoutFailure`，
  三处共用，避免「只改了两处」的重演。
- **导入往返丢数据**（三处）：
  1. **标题含 `|` 被静默改写**：解析器用 `split('|')` 全切，`A | B` 导入后变成 `A`，
     而导出端不做任何转义 ⇒ 往返即丢。改为只切第一个分隔符。
  2. **空壳组污染**：`sanitizeTabUrl` 丢弃危险/不可存储 tab 后，一个组可能全部 tab 被丢
     而留下 `tabs: []` 的空壳卡（要等下次云端下载的 `dropEmptyGroups` 才清），用户刚
     导入完就看到凭空多出的「空会话」。修法：`applyImportGroups` 过滤清洗后变空的组。
  3. **往返链路此前零覆盖**：补 `tests/importRoundTrip.test.ts`（8 例），含 `file://`
     往返契约——1.22.11 的 `sanitizeTabUrl` 只放行 http/https/ftp/about/loading，导出的
     JSON 含 `file://` 会被静默丢弃，本地 PDF 永久丢失。当前版已改为「可存储即保留」，
     用例钉住该契约。
- **验证**：单测 899 → 926。全部 9 组修复都做了反向验证（逐个撤销确认对应用例变红）。
  其中 2 组在反验中暴露「测试压根没覆盖」——超时豁免撤销后仍全绿 ⇒ 补 4 条超时用例；
  `broadcastWarn` 传递撤销后仍全绿 ⇒ 补 5 条 UI 侧接线断言。
- **e2e（真实 Chrome）**：新增 2 个脚本，共 22 条判据。
  `e2e-clean-dup-import-fix.mjs`（13 条，不需登录）覆盖清理与导入；
  `e2e-deadhandle-supabase-timeout.mjs`（9 条）覆盖死句柄自愈与请求超时真会触发。
  **过程中两次 e2e 判据本身是假通过**，靠「验证验证手段是否有效」抓出来：
  ① 第一版测的是页面里手写的原生 `fetch`，与本仓库实现无关；
  ② 第二版断言「请求带上了 signal」，摘掉 `abort` 后依然全绿。唯一能区分「超时生效」
  与「超时没接上」的判据是**把请求挂住够久、观察它是否被中止**——为此把上界改为
  `VITE_SYNC_REQUEST_TIMEOUT_MS || 45_000`（生产构建不带该变量，已核对产物为 `45e3`，
  并由单测钉住）。反向验证：摘掉 abort 后 3s 上界 vs 90s 挂死，对比清晰。
- **顺手修掉的两个 P0 合规项**（2026-10-06 体检报告列为商店审核阻塞）：
  README 宣传已删的「网页版 Dashboard」（`src/web/` 与 `vite.web.config.ts` 已删）；
  「30 天自动清理」承诺此前无调度器——本次实测线上 pg_cron
  `tapstack-tombstone-expiry` 已挂载（`0 3 * * 1`，active），承诺成立，无需改措辞。
  另实测 anon 读 `profiles` / `tab_groups` / `user_settings` / `tabs` 均为 0 行，
  上次体检的 PII 泄漏已止血。
- **仍未验证（诚实边界）**：MV3 SW 空闲 ~30s 被 Chrome **真实回收**这条路径没有触发过
  （不可控）；当前覆盖的是「句柄失效后队列自愈」，用真实 IDB 的 `close()` 构造等价故障。
  弱网下的 45s 上界同样由注入缩短值验证机制本身，未等满 45s。

## v1.22.11（2026-10-05，待提审——待 1.22.9 过审后提交）

- **诊断**：用户报控制台三连错，且三条**不同**操作报的是同一句
  `A listener indicated an asynchronous response by returning true, but the message channel
  closed before a response was received`（自动下载 / 加载列表 / 清理重复）。用真实构建产物 +
  Playwright 实测确认：干净 profile 下**不复现**（SW 健康、MUTATE 往返 1ms、零报错），
  只有「已登录 + 有数据 + 上传在途」才触发。完整因果链：
  1. 纯 FIFO 单写者队列让「用户点删除」排在「后台整库上传」后面等（上传 = 网络 + 逐组
     PBKDF2，几百会话秒级）。1.22.10 把延迟上传也收口进队列后更明显；
  2. SW 侧**没有一处超时**（消息协议裸 await、队列无任务上限、supabase 客户端无
     AbortSignal）→ popup 无限期转圈，没有任何「刚才没生效」的信号；
  3. Chrome 的 popup 一失焦就销毁 → 用户点别处的那一刻，所有在途 sendMessage 的 Promise
     一起 reject 成上面那句。
- **修法一：队列分两条车道**（`mutationQueue`）。`high`（用户直接发起的语义命令、手动同步、
  右键/快捷键保存）插到**尚未开始**的 `normal` 任务（延迟上传、alarm 兜底、后台轮询、迁移）
  之前；正在执行的那个 job 绝不被打断，同车道内仍 FIFO，单写者不变量不变（任何时刻只有一个
  job 在跑，有测试钉住）。
  **为什么重排不丢数据**：上传里两处危险操作——删除广播的「读走 → 广播 → 按确认清队」与
  groups 的「读 → 整组覆盖写」——早就是为并发写的（清队只移除点名确认成功的 id；mutation
  走 `getGroupsForWrite` 读真值）。两条性质合起来正好覆盖「上传排队期间用户又改了东西」。
  反过来说**去掉优先级会拿回 1.22.10 修掉的竞态**，两条一起才成立，不要只回退其中一条。
- **修法二：消息协议有界等待**（`sendMutation` / `sendSyncCommand` 默认 30s）。把「无限静默」
  换成可归因的失败，reason 带稳定前缀「操作超时」与具体操作名。超时不等于回滚——SW 侧任务
  会继续跑完，所以文案说「后台可能仍在继续」而不是「已取消」。
- **修法三：错误文案按 Chrome 真实串匹配**。`listErrorCopy` 此前只认 `message port`，而
  popup 被关闭抛的是 `message channel closed`——这个最高频的瞬时错误全部落进通用兜底，
  用户看到「会话列表暂时不可用」这种无从下手的说法；现已归入「与后台的连接已断开 → 点重新
  加载」。超时另有独立文案。
- **修法四**：`TabList` 的 `onMessage` 此前对**所有**消息无条件 `return true`（声明会稍后
  `sendResponse` 却从不调用），把 SW 广播的响应通道一直吊到页面销毁；现在只对真正处理的
  消息返回 true。
- 新增 `tests/queuePriority.test.ts`（12 例：单写者不变量、跨车道重排、同车道 FIFO、抛错
  不断链、深度归零、协议超时、文案匹配），**全部做过反向验证**（还原源码 → 9 条转红）。
- 顺带删掉一次性诊断脚本 `scripts/diag-message-channel.mjs`——诊断知识已写进本节与测试文件头，
  仓库对「写了没人跑的东西」零容忍。

## v1.22.10（2026-10-05，未上架——并入 1.22.11）

- **视口懒渲染（性能专项）**：会话卡片按是否接近视口（IntersectionObserver，rootMargin 600px）
  决定渲染真实标签行还是等高占位。根因不在数据层也不在 SW（实测清理全程毫秒级），而在 DOM 规模：
  400 会话 × 20 标签 = 10.2 万元素，删 100 个会话要一次性拆掉 2.5 万节点。
  效果：DOM 元素 10.2 万 → 1.5 万，点击到出结果 1.9s → 0.23s，最大帧间隔 1.4s → 0.12s。
  占位高度按行数 × 实测行距精确计算，文档总高与改造前逐像素一致，滚动不漂。
- **同步边界三连修**（来自 [深度体检报告](health-check-2026-10-05.md) 的三条 P1）：
  1. `scheduleUpload` 的 timer 快路径此前绕过单写者队列直接调 `upload()`（四条上传路径里
     唯一没包的），极端时序下可能丢一条删除广播意图 → 对端复活。现已收口进队列；
     四条路径的 enqueue 分工写进注释当红线（**`runScheduledUpload` 内绝不可再包，双层 = 死锁**）。
  2. plain 降级模式（有 `is_deleted`、无印记列）下，「本地新建、从未上过云就被删」的 id
     会让读回校验抛「云端缺失组」→ 上传整体失败 → `pending_upload` 永不清 → 该设备既传不上
     也下不来（同队列其他删除广播被连坐卡死）。口径已对齐 stamp 分支：存在的行必须已标删
     （吞写照样现形），缺失的行视为意图已达成。
  3. 1.22.0 的 `purgeTombstones` 把组级墓碑从 storage 物理移除，但没把 id 转入删除广播队列——
     它假设的「下一次 upload 兜底」读的正是被删掉的 storage 内容。凡「离线删除 + 墓碑从未上过云
     + 升级」，云端行仍活跃，下次下载整组复活。现改为**先登记意图再物理移除**（崩溃窗口落在
     「已登记、未移除」侧顶多重广播一次，幂等）。
- 三条修复各配回归测试（`tests/offlineDeleteNoResurrect.test.ts`、`tests/fastPathQueue.test.ts`），
  且都做过**反向验证**：临时还原修复后 0 过 3 挂，确认测试真咬得住行为。
- 门禁：单测 884 → 887 全过、`pnpm validate` 通过。

## v1.22.9（2026-10-04，已提交商店审核）

- **点击跟手性（性能专项）**：根因不是渲染，是单写者队列被加解密占满——上传/下载要给**每个会话**
  各做一次 AES-GCM，密钥派生 PBKDF2-SHA256 / 100k 迭代（单次约 9ms 纯 CPU），串行 300 个会话
  约 2.8s，用户点击必须排在后面。三处修法：有界并发（并发 8，约 3.6x）、tabSlice 走乐观更新
  （UI 不再等 SW 回传全量）、删掉下载前那次「整份快照备份」（多付一次全量写盘，而 digest 探活
  + fail-closed 读已覆盖它原本防的场景）。另修掉两处随会话数平方增长的计算。
- **数据一致性**：删除失败时会话自动放回列表并给出错误提示（此前界面毫无变化）；修复「正在删除的
  会话被清理重复/列表刷新带回来」的复活（各路径统一剥掉在途删除项；组删除与标签删除判定分开）。
- **V3 门禁可见化**：`y_audit_log` / `y_shadow_log` 此前**全仓零引用**——信号在采集但没人能看见，
  7 天门禁从未真正执行过，V3 的决策依据躺在一个没人打开的 KV 键里。新增 `src/core/yGate.ts`
  按天滚动聚合成 `y_audit_daily`，出四态判定（pass / fail / insufficient_coverage / no_data，
  **「无数据」与「覆盖不足」不得被读成通过**）；诊断导出（schema v2 → v3）与菜单「影子对账
  （开发者）」面板同源，不会出现「面板说通过、导出说没通过」。
- 单测 874 → 884；修掉一批假绿与失效防线。

## v1.22.8（2026-10-04，未上架——并入 1.22.9）

- 迁移台账对齐（无用户可见行为变化）：补齐早期直接在数据库控制台建立、仓库缺失的 13 个迁移文件，
  修正两个迁移共用同一版本号导致的排序/冲突隐患，此后 `supabase db push` 恢复可对账。
- 「云端删除标记行」清理脚本的保留期文案从旧文档的 7 天更正为与客户端一致的 30 天
  （脚本仍未启用，纯防误启用后提前清除导致离线设备复活已删会话）。

## v1.22.7（2026-10-04，已发布）

- 修复手动上传/下载弹窗里两张模式卡标题栏错位：卡片是按钮元素，浏览器默认垂直居中，
  带风险提示的覆盖模式与合并模式顶部对不齐。改为内容一律顶对齐。

## v1.22.6（2026-10-04，已发布）

- 修复「清理重复标签」后界面卡住：登记待删会话时逐条读写整队列，会话一多就是成千上万次存储往返
  （实测 2000 条约 9 秒）→ 改为批量登记（2 次往返，与条数无关），确认后立即关弹窗、后台清理。
- 清理完成后明确提示清掉了多少重复标签页与空会话（此前成功后完全无反馈，用户分不清「没反应」
  与「没有可清理的」）。
- 手动上传/下载弹窗优化：数字等宽对齐、新增「现有 → 预计（净变化）」行、配色跟随深浅主题、
  两个弹窗尺寸统一；修复窗口较矮时弹窗过高、标题与关闭按钮被顶出屏幕。

## v1.22.5（2026-10-04，已发布）

- 修复「清理重复标签」失败并反复报错：删除广播队列很长时（清理大量重复/空会话后）服务端请求
  URL 超过网关上限被拒 → 云端删除标记失败 → 上传整体失败并无限重试。删除广播与上传读回改为分批。
- 修复拖动标签时整个管理页刷新（每次落盘都把列表打回存储态）——自己发起的写入不再触发自身整页重载。
- 登录/注册弹窗改为真正的全屏居中浮层，不再渲染在顶部栏内被裁切。

## v1.22.4（2026-10-03，已发布）

- 新增三套主题：Apple 系统质感、Chrome 原生、Claude 原生（三风格齐备，明暗各具签名）；
  主题从 7 套下线「极光」到 6 套，存量设置按气质迁移；legacy 主题做像素级忠实回归。
- 修复登录弹窗在 popup 矮视口下被裁切、无法完整显示。

## v1.22.3（2026-09-30，未上架——并入 1.22.4）

- 修复列表不刷新、乐观写静默分叉（UI 显示新值、磁盘是旧值）、覆盖模式零防护三处。
- 修掉一批假绿与失效防线，让该版本重新可发布。

## v1.22.2（2026-09-30，已提交审核）

- 修复双栏视图空标签组重复渲染：视图按 id 去重 + 锁定零标签组按空壳熄掉。

## v1.22.1（2026-09-29，已发布）

- 同步可靠性加固补丁：修掉一批会丢用户数据的同步缺陷（防误删云端数据、防探活失效烧额度、
  防设备卡死），并建立真正的发版门禁。

## v1.22.0（2026-09-29，已提交审核）

- **废除墓碑体系**（产品拍板：删除即物理移除，回收站/恢复功能一并废除）：
  删除广播 = `pendingDeleteIds` + 云端 `is_deleted` 行 + TTL 30 天；合并 = 组级 LWW 整组覆盖。
- 配套：迁移台账新建、失败路径全程 fail-closed、诊断导出脱敏改为白名单式。

## v1.21.7（2026-09-28，已发布）

- 同步审计修复（1.21.4–1.21.6 的累积改动一并上线）：
  1. **防误删云端数据**——`tabs_data` 解密失败时旧代码降级成 `tabs:[]`，正好撞上空壳硬删除 →
     被剔除 → 登记 purge → 下次上传 DELETE 云端行，云端唯一副本永久消失。改为「读不出来就不碰」。
  2. **防探活烧额度**——下载路径只入队从不置 `pending_upload`，后台因此永不上传；云端多出的行又让
     `hasRemoteChanges` 行数比对恒不等，探活永久失效，退化成每 60 秒全量下载。这很可能就是额度
     吃紧的成因。
  3. **防设备卡死**——生产库遗留 `NEW.version < OLD.version → RETURN NULL` 守卫会静默吞写，
     落后设备上传被吞 → 读回抛错 → 上传失败 → 连带跳过下载 → 既不能上传也不能下载。修法是读回
     补 `version`，区分「被静默吞写」（报错）与「被更新一侧合法取代」（按设计输掉，不计失败）。

## v1.21.6（2026-09-28，未上架——并入 1.21.7）

- 读-改-写路径防陈旧缓存：所有 mutation 都是「读-改-写」，`storage.getGroups()` 有 30s 进程内
  缓存，而 groups 不止 SW 一个上下文写（popup 的迁移会整表写回）——拿陈旧快照改完写回会抹掉期间
  别的上下文写入的数据**且回报成功**。新增 `getGroupsForWrite()`，三处读-改-写入口统一改走它。
- 决定性验证：e2e 去掉 30s 等待后数据依然完好（修复前该场景把 2 个组全抹掉）。

## v1.21.5（2026-09-28，未上架——并入 1.21.7）

- 空组统一硬删除 + 双栏按次序对分。根因：切布局**不写存储**（e2e 实测存储逐字节不变），空组是
  既有数据——组内标签全被墓碑化后渲染成空卡，真正产地是同步合并（只盖标签级墓碑、从不处理组）。
  判据统一到 `core/mutationOps.ts`，覆盖 SW 单写者、同步合并落盘前、Redux 乐观层三条链路。

## v1.21.4（2026-09-28，已发布）

- Logo/icon 重设计「收拢的现场」（A 方案）：三层错位卡 + 折角，讲结果不讲机制，16px 独立 SVG，
  品牌蓝一体现代化设计。

## v1.21.3（2026-09-28，已发布）

- UI 打磨第三波（基于 ui-audit 实拍审查）：信息减法（删冗余徽章、时间去秒、按钮改描边）+ 排版细节。
- 主题收敛 8 → 4（legacy / aurora / creamy / prism），存量设置按气质迁移；顺手删死代码 2200+ 行。

## v1.21.2（2026-09-27，已发布）

- 修复「清理重复标签组」后计数反增（223 会话/994 标签 → 230/1106）：`cleanDuplicateTabs.fulfilled`
  把 SW 返回的 storage 全量（含墓碑）直灌 Redux，而 loadGroups 会过滤墓碑——多出的组/标签恰为
  墓碑量。抽出共用纯函数 `toActiveGroupsView`，fulfilled 与 loadGroups 共用。

## v1.21.1（2026-09-26，⚠️ 是否真的发布过尚未澄清）

- 防误删加固：「清空全部会话」始终弹出确认并显示会话数量（此前开关关闭时零确认直删）；回收站新增
  「全部恢复」批量入口；界面细节打磨。
- **注意**：CHROMEWEBSTORE.md 版本史里这一行是唯一的空洞——它夹在「1.21.0 已上架」与
  「1.22.0 已提审」之间，历史 changelog 写的是回收站功能（已被 1.22.0 废除）。是否真的上传过
  需向 Chrome Web Store 后台核对，核对前不要改写其状态。

## v1.21.0（2026-09-26，已发布——当天过审）

- 误删保护升级：删除的会话/标签 7 天内可在回收站恢复，7 天后自动彻底清除（此项后被 1.22.0 废除）。
- 同步引擎结构手术（日志收口、单写者路径拆分），无功能变化。

## v1.20.2（2026-09-24，已发布）

- 合并 1.19.3–1.20.2 一次性上架：同步可靠性加固（上传读回校验、软删失败阻断、落盘直写、彻底删除
  门禁）、点击体验（点开即响应、修复列表项闪现复活、防重复打开、成功操作静默）、增量同步探活
  （大幅降低流量）、网页版与扩展删除语义统一、RLS 性能优化。

---

## 早期版本索引（v1.20.2 之前，摘要）

完整记录见 `git log --oneline` 与 tag 附注；此处只留索引。

| 版本 | 日期 | 内容 |
|------|------|------|
| v1.20.1 | 2026-09-24 | 堵住代际 guard 残留窗口，回环过滤在途备份 |
| v1.20.0 | 2026-09-23 | 同步可靠性 + 重构收敛 + V2 影子双写 + 点击体验修复 |
| v1.19.3 | 2026-09-13 | 同步数据安全修复（云端守卫严格 `<`、印记跨设备可比、存量迁移接线）+ 网页版登录持久化 + 导入自动上云 + 依赖安全治理 |
| v1.19.2 | 2026-09-12 | 依赖安全治理：GitHub 告警 50→1（high 21→0），vite 4→6 + 17 条传递依赖钉版，新增 `security:audit` |
| v1.19.1 | 2026-09-12 | 同步层阶段二修复：云端守卫改严格 `<`、印记跨设备可比（换机/重装后可正常保存）、存量迁移接线 |
| v1.19.0 | 2026-09-12 | 阶段二：操作印记（OpStamp）全序决胜合并（仅 git 记录，未上架商店；该版本无 tag） |
| v1.18.0 | 2026-09-08 | 同步层阶段一（单写者）：修复保存被同步覆盖、点击标签即时消失、上传延迟 30s→1.5-3s |
| v1.17.3 | 2026-08-30 | 修复下载时 `tabs_data` 形状异常导致的崩溃 |
| v1.17.2 | 2026-08-26 | 小版本 |
| v1.17.1 | 2026-08-26 | hotfix：version guard 吞掉了所有云端软删 |
| v1.17.0 | 2026-08-26 | URL 消毒链 + 跨设备 URL 墓碑 + 服务端 version guard |
| v1.16.x | 2026-08-26 | 标签级墓碑同步修复 + 安全加固 |
| v1.15.8 | 2026-08-24 | 修复单栏布局下「可显示页面比双栏短一半」 |
| v1.15.7 | 2026-08-24 | UI 细节打磨 round-2 |
| v1.15.6 | 2026-08-24 | layout rework + dark mode fix + legacy theme 恢复 |
| v1.15.2–1.15.5 | 2026-08-13 | 破坏性操作前预览、同步失败可见、登录入口、onboarding 不再阻塞老用户、V3 持久化密钥、CSP 与 favicon 白名单对齐 |
| v1.15.0–1.15.1 | 2026-08-12～13 | 菜单重构拆分 HeaderDropdown；登录入口与 CTA 文案 |
| v1.13.x | 2026-06-28 | 测试覆盖扩张（SyncEngine DI、存储层集成、迁移测试、漏洞加固） |
| v1.12.0 | 2026-06-06 | SyncEngine 重构 + hydration 修复 + 跨设备删除传播 |
| v1.11.x | 2026-01～05 | 主题系统与布局优化、组件质量与可访问性、加密栈溢出修复、清理死代码 |
| v1.10.0 及更早 | 2025-04～2026-01 | 项目早期（OneTab Plus / TabVault Pro 时期）：布局、依赖、构建迁移等常规迭代 |

> 注：仓库里另有 `archive/*` 前缀的 tag（约 10 个），是历史分支的存档点，不对应任何发布版本。
