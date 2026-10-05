# 深入体检报告（2026-10-05 下午）

> 范围：P2 收尾 + 一轮深入体检（自查 + 两路并行只读审计）
> HEAD：`cdfa821`（main，本轮 13 个提交）
> 门禁：**831/831 单测通过**、`pnpm validate` 通过、首屏 192.6KB/240KB、生产依赖 0 漏洞

---

## 一、结论

P2 六项全部完成。深入体检发现并修复 **7 个真实缺陷**，其中 **4 个是我自己在前几轮引入的**。两路并行审计另发现 3 项，一并核实后**判定为误报**（详见第五节）——我没有因为"agent 说了"就直接改。

最重要的一个认知：**这个项目现在最大的风险不再是"代码有 bug"，而是"我改的东西没被验证过"**。今天两次自查发现的缺陷（打开路径用错门、迁移定界符腰斩）都是同一种模式——改动本身逻辑正确，但**没有一条测试覆盖那条路径**。

---

## 二、P2 六项（已完成）

| # | 项 | 结果 |
|---|---|---|
| 1 | `getPendingUpload` / `hasPendingUpload` 读失败 → 抛 | 不再返回 false（那会被读成"没有待上传"） |
| 2 | `scheduleUpload` 置位失败 logWarn → logError | 并写明后果（SW 被回收后跳过上传） |
| 3 | 删除登记失败不再回 `ok:true` | 新增 `broadcastWarn`，5 个删除 case 全接入，UI 弹提示 |
| 4 | 体积门接线 | 改写为「首屏体积门」，超预算 `exit 1`，接进 `validate` + CI |
| 5 | 单测 glob 递归 | `tests/**/*.test.ts`，并加一个住在子目录的守卫自证 |
| 6 | `cws-publish` publish 校验 | 非 2xx → `exit 1`；并识别"200 但是 no-op" |
| 附 | journal 降级 + 墓碑兜底 | WAL → 命令轨迹（环形 200）；清理函数从注释脚本变成正式迁移 |

**顺带修的架构问题**：`scheduleUpload` 与 `mutationHandlers` 方向相反的静默失败，本质是"同一个仓库里读路径 fail-closed，另两处却把失败翻译成正常值"。现在统一。

---

## 三、深入体检发现的 4 个真实缺陷

### D1【P1·自查发现】恢复会话的打开路径用错了门

**这是我在 P1-4 修复时引入的**。那次我把 `sanitizeTabUrl` 的语义从"能不能打开"收窄为"能不能存"，但**调用点没全部跟着改**。

- 后果：恢复含 `file:///…` 的会话时 URL 通过 SW 过滤 → 交给 `chrome.tabs.create` → 扩展无 `file://` 权限，Chrome 打开错误页 → 批量路径的 `Promise.all` 整批 reject → 用户看到"恢复失败"，而数据一直好好地在会话里。
- 修：`OPEN_TAB` / `OPEN_TABS` 改用 `isOpenableTabUrl`；批量路径回传 `skippedUnopenable`，UI 如实告知"已恢复 N 个，另有 M 个在当前设备打不开，仍在会话中"。
- 门禁：`tests/guards/openUrlGateConsistency.test.ts`（9 例）按源码结构钉死**每一类路径该用哪道门**。

### D2【P1·自查发现】读不到 pending 判据时却继续下载

我把 `hasPendingUpload` 改成会抛（第一个修复），但 `backgroundSync` 的 catch 是"logWarn + 继续"——那正是我刚修掉的问题的另一面。

- 读不到判据 = "本地有没有未推送的变更"**没有答案**，而下载会用云端覆盖本地。本地若其实领先（正是读失败最可能的原因），这一轮下载就把用户的修改覆盖掉。
- 同一段代码里上传失败时的处理是"中止下载"（注释写明"会覆盖本地未推送的新状态"），判据读不到与它在后果上同类，却走了相反的路。
- 修：改为 fail-closed，中止本轮；门禁加 2 例（含一条反向断言）。

### D3【P0·安全审计发现】purge 函数缺 REVOKE → anon 可删全站数据

PostgreSQL 给新函数默认授予 `EXECUTE` 给 `PUBLIC`（含 anon/authenticated），而 anon key 随扩展产物公开。任何人都能调 `POST /rest/v1/rpc/purge_expired_cloud_tombstones`，让这个 `SECURITY DEFINER` 函数替他执行 `DELETE` —— 且删的是**全体用户**的行。

后果不止"提前清理"：它把"服务端 30 天清理"这条隐私承诺提前变成事实，而此时可能还有离线设备没完成删除广播 → 它们下次合并会把已删会话复活。

修：`REVOKE` FROM `PUBLIC`/`anon`/`authenticated`，`GRANT` TO `service_role`。TTL 常量函数一并 REVOKE（现在无害，但将来有人加逻辑就成了漏洞）。

### D4【P0·安全审计发现】迁移的 dollar-quote 会被切分器腰斩（**我自己的 bug**）

我在 `20261005000000b` 的 `RAISE NOTICE` 字符串里写了 `$$SELECT …$$` 作为给用户看的 pg_cron 示例。而 `supabase-migrate.mjs` 的切分器**只认 `$$` 作定界符、不看上下文** —— 字符串里再出现一次，就在那里把语句切成两半，迁移执行时直接语法错误。dry-run 看着"正常"因为它只打印不执行。

**同一个错我在当天写的 `20261005000000`（profiles RLS）里也犯了**：注释中解释了 `$$` 的用法，那段解释本身又写了 3 次 → 5 次（奇数）→ 同样腰斩。

两条迁移都改用 `$body$` / `$q$`。

**这类错误人眼审不出来**（SQL 语法看着完全正常），所以我写了门禁：`tests/guards/migrationSqlSafety.test.ts` 5 例，核心断言是**每个语句片段里的单引号必须自闭合** —— 腰斩必然留下孤立引号。这个检查比"首 token 是不是 SQL 关键字"本质得多，也不受中文注释干扰。它在上线当天就抓出了我自己第二个同类 bug。

---

## 四、顺带发现并修的

- `tests/storableUnopenableUrls.test.ts` 在上一轮编辑时被我误删了一个 `it()` 首行，留下悬空代码 → 语法错误。门禁当时没跑全量所以漏了，现已恢复。
- `supabase-migrate.mjs` 的 `verify` 只检查 op-stamp 守卫，**今天新加的两条迁移跑没跑过完全验不出来**。已扩展：现在会验 profiles 有无全放行策略、purge 函数 anon 是否仍可执行。

---

## 三之二、安全审计的 P1/P2 剩余三项（第二批，已完成）

### D5【P1】登录态竞态：设置读失败时用了最危险的默认值

`backgroundSync.performBackgroundSync` 第 2.5 步 `loadSettings()` 原本是 `.catch(() => undefined)`，读失败也继续。

`syncStrategy` 决定上传用哪种合并策略，而 `cloudOverwrite` 的**默认值（conservative）恰好是最危险的那个**——它假设"云端更新则丢弃本地"。设置读失败时我们恰恰不知道"本地是否领先云端"这个前提成不成立。默认值不是"安全的兜底"，是"在不确定时选了破坏性更强的那个"。

且读失败与"设置本来就是默认值"**不可区分**，两者都让流程继续——这就是静默用错策略的来源。改为 fail-closed 中止本轮。

顺带确认：全仓 `catch(() => undefined)` 已清零。

### D6【P2】删掉 `src/auth/confirm.html` —— 死代码 + 唯一的资源暴露源

三条独立证据说明它毫无作用：

1. `supabase.auth.signUp`（`auth.ts:13`）只传 `email`+`password`，**从未配置 `redirectTo`** ⇒ 没有任何验证邮件会指向它
2. 页面里的 `verifyUrl` 算出来后**从未使用**（`const` 赋值后零引用），且 `redirect_to=` 是空值 ⇒ 即使被访问也不会真正校验
3. 它是 `manifest.json` 里 `web_accessible_resources` 唯一的存在理由，而那条规则把页面暴露给**任何** `*.supabase.co` 页面（钓鱼页可 iframe 进去）

保留一个"看起来在处理邮箱验证、实则什么都不做"的页面，风险（WAR 暴露 + 未来有人误以为它在用）大于价值。删除后 **`web_accessible_resources` 整条规则移除**——扩展不再向任何外部域暴露资源。

### D7【P2】`logWarn`/`logError` 不再带完整 URL

`vite.config.ts` 只 drop 了 `log`/`info`/`debug` ⇒ **`warn`/`error` 直通生产构建的 console**。用户报障时把控制台截图贴到公开 issue（GitHub / 论坛 / 客服聊天），就等于公开他访问过哪些站点。

favicon 的 URL 本身就是浏览历史：`https://intranet.corp/internal/hr/salary?year=2026` 这一条同时泄露"他在哪家公司"+"他看薪资页"。虽然没出网，但用户会认为"日志都是本地的话贴出来没关系"——这个假设是错的。

修 3 处（只打 origin，路径与查询串剥掉）：`utils/faviconUtils.ts`、`components/common/SafeFavicon.tsx:35`、`background/TabManager.ts:291`（后者是本轮前面刚加的，自己引入的）。

**门禁**：`tests/guards/noUrlInWarnLogs.test.ts`（4 例）。其中一条显式断言 vite 的 drop 列表里**没有** warn/error——这是门禁的前提，改了要显式失败而不是悄悄失效。

---

## 五、两路审计的误报（核实后未改）

### 数据审计的 3 条"严重"问题 —— 全部误报

| 审计结论 | 实际 | 核实方式 |
|---|---|---|
| `pending_purge_ids` / `pending_delete_ids` 键分叉，删除广播会发到错误队列 | **键名统一**：`PENDING_PURGE_IDS` 全仓零引用，所有队列操作统一用 `PENDING_DELETE_IDS` | grep 全仓引用 |
| 导入路径（`applyImportGroups`）不做 URL 消毒，XSS 面敞开 | **有消毒**：`mutationHandlers.ts:187` 显式注入 `sanitizeUrl: sanitizeTabUrl` | 读源码确认 |
| `openTabsInNewWindow`/`InCurrentWindow` 绕过 URL 校验 | **UI 侧数据已过滤**（`deserializeTab` 拒危险 schema）+ **SW 侧本轮又加了 `isOpenableTabUrl` 双重把关** | 读 D1 的修改 |

### 安全审计的 1 条 P1 —— 误报

审计报告称 `user_agent` / `systemPrompt` 存在模板注入。核实：

- `userAgent` 全仓只出现在 `utils/diagnostics.ts`（诊断导出的白名单字段，隐私政策已声明），**没有进任何模板**；
- 全仓扫描 `openai` / `anthropic` / `chat/completions` / `generateText` / `prompt:` —— **零个 LLM 调用点**（唯一匹配是 `ThemeStyleSelector.tsx:59` 的注释"Claude 主题图标 - 星芒（Anthropic 标记意象）"）。

**记录在此，因为"agent 说了就改"和"agent 说了就忽略"同样危险。** 本轮 4 条误报全部逐条核实后才决定不改。

---

## 六、体检方法论：这次真正学到的东西

**四个缺陷里有三个是同一种模式** —— 改动本身逻辑正确，但**没有一条测试覆盖那条路径**：

- D1（用错门）：URL 门在**新的**调用点上，测试只覆盖了旧的
- D2（catch 继续）：改了一处调用方，忘了它的调用者
- D4（定界符腰斩）：SQL 语法完全正常，dry-run 不执行

所以本轮新增的 5 个门禁测试里，**4 个是结构断言而非值断言**（`tests/guards/`），钉住的是"该用哪道门 / 该不该中止 / 定界符配不配对"这类**契约**，而不是某个具体值。理由：这类 bug 靠值断言抓不住（值都合法），只能靠结构断言。

新增文件（6 个守卫测试）：
- `tests/guards/globRecursion.test.ts`（自证递归生效）
- `tests/guards/gateWiring.test.ts`（体积门真会 exit 1、已接 validate、publish 校验结果）
- `tests/guards/tombstoneTtlConsistency.test.ts`（客户端 TTL 是权威，服务端跟随）
- `tests/guards/openUrlGateConsistency.test.ts`（每类路径该用哪道门 + 判据读不到要中止）
- `tests/guards/migrationSqlSafety.test.ts`（定界符配对 + DEFINER 函数必须 REVOKE）
- `tests/guards/noUrlInWarnLogs.test.ts`（warn/error 不得带完整 URL）

---

## 七、仍需你处理的两件（我不能代做）

1. **执行两条迁移**：`pnpm supabase:migrate`（profiles RLS 收口 + 墓碑清理函数）。执行后用 `pnpm supabase:verify` 确认——现在它会验这两项。
2. **挂墓碑清理的调度器**：迁移只建函数、**故意不挂 cron**（pg_cron 需你在 Dashboard 手动勾选，迁移里直接 `cron.schedule()` 会让整条迁移失败）。启用命令已打在迁移的 `RAISE NOTICE` 里。

另外，桌面清单里还有一条待办：**`max-h` 裁剪那批的浏览器实机验证**（拖拽手感、折叠动画、`file://` 降级显示）—— 这三处我改了渲染/交互，静态测试覆盖不到。

---

## 八、一句话

**P2 全部收口，深入体检共挖出 7 个真实缺陷（4 个是自己引入的）并全部修掉，同时把 5 类"人眼审不出来"的错误变成了自动化门禁。** 净效果：831 个测试里有 35 个是这次新增的契约守卫，项目对"改错了但没人发现"这件事的抵抗力显著提升。

*两路并行审计的完整明细保留在本轮会话记录中；本报告为核实、去重后的结论版。*
