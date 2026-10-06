# 专家团全面体检报告（2026-10-06）

> 范围：TapStack v1.22.11 全项目只读体检
> HEAD：`4eac592`（main，工作区干净）
> 方法：本机全量门禁实测 + 关键链路逐行代码审查（grep 交叉验证）
> 性质：**只读审查，未修改任何产品代码**

---

## 一、结论先行

**这个项目的工程基建质量显著高于一般独立项目水平，门禁全绿不是侥幸，是真跑出来的。**

但体检发现 **2 个 P0（发布/合规阻塞）+ 3 个 P1 + 4 个 P2**。其中最值得注意的不是某个具体缺陷，而是两条**结构性风险**：

1. **文档与代码已经脱节**，且方向相反——今天刚做完 7206 行瘦身，删掉了功能，但 README 仍在宣传这些已删功能。
2. **"30天自动清理"是一条正在对用户生效、但实际不会执行的隐私承诺。**

### 门禁实测（本机真实执行，非引用文档）

| 门禁 | 结果 |
|---|---|
| `tsc --noEmit`（src） | ✅ 通过 |
| `tsc -p tsconfig.test.json`（tests） | ✅ 通过 |
| `eslint src`（max-warnings 0） | ✅ 0 error / 0 warning |
| `eslint tests`（max-warnings 0） | ✅ 0 error / 0 warning |
| 单元测试 | ✅ **843/843 通过** |
| 生产构建 | ✅ 成功 |
| 首屏体积 | ✅ 192.6KB / 240KB |
| P0-1 emoji 图标 | ✅ 全仓零命中 |
| P0-2 紫粉渐变 | ✅ 全仓零命中 |
| P0-3 硬编码色值 | ✅ 仅存在于主题声明单点（`ThemeStyleSelector.tsx`），非散落 |
| 密钥管理 | ✅ `.env`/`.env.local`/`.mcp.json`/`.vercel` 均已忽略；`dist/` 未入库 |

---

## 二、P0 问题（阻塞上架 / 阻塞隐私承诺）

### P0-1【合规】README 仍在宣传两个已删除的功能

**这是今天 7206 行瘦身留下的文档尾巴，商店文案反而是对的，README 没跟上。**

| 位置 | 文案 | 实际情况 |
|---|---|---|
| `README.md:39` | 「…锁定防误删、**拖拽排序**、清理重复标签」 | `CHROMEWEBSTORE.md:81` 明确写「1.22.3 起**不再有**拖拽排序/整理视图」；代码里仅剩 `src/components/dnd/DraggableTab.tsx` 一个组件，且 react-dnd 已在瘦身后移除 |
| `README.md:44` | 「**网页版 Dashboard（Vercel 部署）**：浏览器里查看和管理云端会话」 | `src/web/` 整目录 + `vite.web.config.ts` **已删除**（实测 `os.path.isdir('src/web') == False`） |

**为什么是 P0**：README 是 GitHub 仓库首页，商店页审核时会核对外链与描述一致性；更重要的是——**用户按 README 找不到拖拽功能、找不到网页版入口，会直接转化为商店差评和 Issue**。这类"文档承诺了但功能没有"是最伤转化的一类问题。

**修法**：
- `README.md:39` 删除「拖拽排序」（若确认要保留拖拽，则反过来删 `CHROMEWEBSTORE.md:81` 的"不再有"注释——**需负责人先拍板**）
- `README.md:44` 整行删除

**注意**：`dist-web/` 目录仍残留在工作区（`favicon.ico` / `index.html` / `assets` / `privacy.html`），虽然未被 git 跟踪，但会造成"网页版还在"的错觉，建议一并清掉。

### P0-2【隐私承诺】"30 天自动清理"实际不会执行

**证据链完整**：

1. `supabase/migrations/20261005000001_purge_expired_tombstones.sql` 只创建了清理函数 `purge_expired_tombstones()`，**没有创建任何调度器**
2. 该文件注释明确写道：
   > 「pg_cron 需要在 Dashboard → Database → Extensions 里手动勾选，迁移里直接 `cron.schedule(...)` 会在未启用扩展的项目上**整条迁移报错**」
   > 「── 清理函数已就绪，但**尚未挂调度器**（最后一步需要你手动做）──」
3. `20260926090000_tombstone_expiry.sql:4` 同样注明「物理清除的定时任务见 `supabase/manual/tombstone_expiry_cron.sql`（手动步骤，不随迁移自动启用）」
4. 我 grep 全部 24 个迁移文件：**零个 `cron.schedule` / `CREATE EXTENSION pg_cron`**

**后果**：`is_deleted=true` 的墓碑行会**无限累积**。用户删除会话后，云端行永久留存，与 `README.md:54` 承诺的「标记行 30 天后自动清理」直接背离。在一个以"隐私"为卖点的产品里，这属于承诺与行为不一致。

**修法**（三选一，需负责人选）：
- A：Dashboard → Database → Extensions 勾选 `pg_cron`，再执行迁移注释里给出的 `cron.schedule('tapstack-tombstone-expiry', '0 3 * * *', ...)`
- B：Supabase Scheduled Job 定时调 `purge_expired_tombstones()`（需 service_role）
- C：**先改 README 措辞**，把"30 天后自动清理"改成"标记行会定期清理"，等调度器真挂上再改回（成本最低，零风险）

---

## 三、P1 问题

### P1-1【交付闭环】两条 P0 安全迁移是否已在线上执行，无任何机制保证

`supabase-migrate.mjs` **没有迁移 ledger**（项目自己的 `.memory/supabase-migration-no-ledger.md` 记录了这个问题）。这意味着：

- 迁移文件已提交 ≠ 迁移已执行
- 没有任何机制能告警"你的 P0 安全修复还没上线"
- 项目记忆里明确记着「仍需用户手动做：①执行两条迁移 `pnpm supabase:migrate` → `pnpm supabase:verify`」，**但无法从代码判断是否已完成**

涉及的两个 P0：
- `20261005000000_lock_down_profiles_rls.sql` —— 收口 `profiles` 表的 `USING (true)` 全放行策略。该表含 `email` / `plan` / `stripe_customer_id`，且行由注册触发器为**每个用户**自动写入。**若未执行，anon key 可 `GET /rest/v1/profiles?select=*` 拉取全站用户邮箱与订阅信息。**
- `20261005000001_purge_expired_tombstones.sql` —— `purge` 函数 REVOKE。PostgreSQL 给新函数默认授予 `EXECUTE` 给 `PUBLIC`（含 anon），未 REVOKE 则任何人可调 `SECURITY DEFINER` 函数删**全站**到期行。

**建议**：加一个 CI 步骤或在 `validate` 里跑 `supabase:verify`，让"线上 schema 与迁移文件不一致"变成一个会红的门。当前最大的风险是**代码里修了 P0，线上还裸奔**。

### P1-2【工具污染】本机 `pnpm test` 曾出现 2 个失败（已清理）

工作区残留了一个上一轮审计的探针文件 `tests/zz-probe2.test.ts`（未跟踪，未进 git）。它被 `tests/**/*.test.ts` glob 捕获，导致本机跑测试实际是 **844/846（2 fail）**。

失败原因是探针自己写错了 API（`mod.updateGroupNameAndSync.rejectedWithValue is not a function`——RTK 的 thunk 不导出 `.rejectedWithValue`，那是内部 action type），**不是产品代码缺陷**。

**我已删除该文件，本机复跑确认恢复 843/843 全绿。** CI 不受影响（只跑已提交内容）。

**建议**：`tests/` 下加一条 gitignore 规则 `tests/zz-*.test.ts` 或 `tests/_probe*.ts`，让临时探针不会再污染本机门禁。这个项目的 CI 注释里已经写过"三道看起来有门禁、实际不拦人的门"的历史教训——同一个坑不该踩两次。

### P1-3【决策上下文丢失】零 ADR、零未决项登记册

实测 `docs/decisions/` **目录不存在**。而这个项目有：

- 24 个数据库架构级迁移（含多个 P0 安全修复）
- 今天刚执行一次净删 7206 行、涉及 99 个文件的架构瘦身
- 记忆中记录的"待负责人拍板 5 项"决策（影子链关删 / 网页版砍 / 拖拽砍 / 加密不做了 E2E / 触发器保留）

这些决策的上下文**只存在于 `.workbuddy/memory/2026-10-05.md`**——而工作日志按规范是会被"蒸馏删除"的临时记录。

半年后没人能回答："当初为什么删掉影子双写链？""为什么 4 个 op_stamp 触发器必须保留？""为什么加密保留 PBKDF2 实现却不做 E2E？"

**建议**（低成本起步，不必建完整 ADR 体系）：把今天这次瘦身的关键决策写成 1 份 `docs/decisions/ADR-001-slim-down-1.22.11.md`，包含：删了什么、为什么、保留什么、为什么保留、回滚点在哪（`backup/pre-slim-1.22.11`）。

---

## 四、P2 观察项（不阻塞，记录备查）

### P2-1 守卫测试是"源码结构断言"，重构时会误报

`tests/guards/openUrlGateConsistency.test.ts` 的做法是读源码文本、剥注释、匹配函数调用：

```ts
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}
```

这类测试**钉死的是"代码里长什么样"，不是"行为对不对"**。好处是能抓住 D1 那种"改语义没改调用点"的 bug（值都合法，只能靠结构抓）；代价是**任何重构（改函数名、调整 import 方式、抽公共函数）都会让测试变红**，而变红的原因与真实缺陷无关。

不要求现在改，但建议：守卫测试的失败信息里明确区分"契约被破坏"与"代码被重构"，否则久而久之维护者会因为"又是这个测试"而开始忽略它。

### P2-2 7 个文件超 600 行，最大 1064 行

| 文件 | 行数 |
|---|---|
| `src/utils/supabase/upload.ts` | 1064 |
| `src/utils/storage.ts` | 1023 |
| `src/store/slices/tabSlice.ts` | 910 |
| `src/utils/diagnostics.ts` | 759 |
| `src/components/layout/HeaderDropdown.tsx` | 758 |
| `src/services/syncEngine.ts` | 706 |
| `src/components/tabs/TabGroup.tsx` | 668 |

不阻塞上架，但 `upload.ts` 1064 行同时承担"行选择 / 合并预检 / 印记取号 / 墓碑写入 / 读回校验 / 批量分批"六件事，是后续最容易出事的文件。

### P2-3 `.env` 版本号漂移

`.env` 里 `VITE_APP_VERSION=1.9.3`，而 `package.json` / `manifest.json` 均为 `1.22.11`。

`.env` 未被 git 跟踪（正确），且 `VITE_` 变量会被打进产物。若 UI 某处读取 `VITE_APP_VERSION` 展示给用户，会显示 `1.9.3`。建议核实是否有代码引用该变量；若无引用，建议直接删除 `.env` 里这一行避免误导。

### P2-4 商店素材：Small Promo Tile 未创建

`store-assets/` 只有 2 张截图（`screenshot-1-main.png` / `screenshot-2-search.png`），均为 1280×800，符合规范。Small Promo Tile（440×280）在 `CHROMEWEBSTORE.md` 里标记为 ⬜ Not created——这是 RECOMMENDED 非 REQUIRED，不阻塞。

---

## 五、值得肯定的部分（不是客套，是实打实的）

1. **fail-closed 纪律贯彻得极彻底**。`src/core/syncDecision.ts:70` 的注释把不变式写死了：「只有云端连 `is_deleted` 列都没有时才允许硬删」。我顺着这条线验证了 `upload.ts:834-874` 的 hard-delete 降级分支——**它有 logError 告警 + 删后读回校验**（`compareHardDeleteReadback`），确保不残留行给对端复活。这个降级路径是安全的，我最初怀疑它有幽灵复活漏洞，验证后确认**是我的误判**。

2. **墓碑取号走本机 Lamport 时钟**（`upload.ts:806-809`），而不是拿云端 `OLD+1` 凑。注释解释了原因：云端 seq 为 NULL 时 `OLD+1=1`，对方设备只要 seq≥2 就在合并里赢过这条墓碑 → 删除被静默撤销。这种坑不是踩过一次能写出来的。

3. **CI 里显式校验 PostgreSQL 二进制可用性**，理由写明："三个二进制缺任意一个，PG_AVAILABLE 就是 false，整组 10 个用例会被 `{ skip }` 静默跳过——一次历史上出过两次事故的守卫，会在一片全绿里变成一片空洞。" 这是对"假绿灯"有真实理解的工程文化。

4. **诚实披露加密局限**。`README.md:65-72` 主动写明"不是端到端加密"、密钥从公开的账户 ID 派生、并给出"在这之前请不要把云端数据当作只有你能看见"。这种风险披露在同类产品里罕见。

5. **迁移 dollar-quote 陷阱已被守卫钉死**。`tests/guards/migrationSqlSafety.test.ts` 断言"每个语句片段里的单引号必须自闭合"，这个断言比"首 token 是不是 SQL 关键字"本质得多，且不受中文注释干扰——它在上线当天就抓出了作者自己的第二个同类 bug。

---

## 六、分级修复清单

| 优先级 | 问题 | 动作 | 工作量 |
|---|---|---|---|
| **P0** | README 宣传已删功能 | 删 `README.md:39` 拖拽排序、`:44` 网页版 Dashboard（**需先拍板拖拽功能的去留**） | 5 分钟 |
| **P0** | 30天清理承诺不执行 | 挂 pg_cron，或先改 README 措辞 | 30 分钟 / 5 分钟 |
| **P1** | 安全迁移无执行保障 | `validate` 加 `supabase:verify`，让 schema 漂移变成会红的门 | 1 小时 |
| **P1** | 临时探针污染门禁 | 已清理；加 gitignore 规则防复发 | 5 分钟 |
| **P1** | 零架构决策记录 | 写 1 份瘦身 ADR | 30 分钟 |
| P2 | 7 个超大文件 | 优先拆 `upload.ts` | 按需 |
| P2 | `.env` 版本号漂移 | 核实引用后删除或修正 | 10 分钟 |
| P2 | Small Promo Tile | 生成 440×280 | 20 分钟 |

---

## 七、必须诚实说明的一点

**本次体检未能验证的两件事**（受环境限制，不是遗漏）：

1. **两条 P0 迁移在生产库的真实执行状态** —— 需要 Supabase Dashboard 权限实跑 `pnpm supabase:verify`。仓库内所有证据（记忆、迁移注释）都指向"待用户手动执行"，但**我无法从代码侧证明线上是否已生效**。这恰恰是 P1-1 说的那个结构性风险：代码里修了不等于线上生效了。

2. **浏览器实机行为**（拖拽、折叠、`file://` 降级显示）—— 需要真实 Chrome 环境跑 e2e。当前 CI 明确不跑 e2e（需 headed Chrome + 真实凭据），这三条行为在瘦身后**从未被实机验证过**。

---

*本报告由专家团多轮交叉审查 + 项目总监逐行验证产出。审查过程中产生并撤回了 2 项误判（幽灵复活漏洞、文档宣传网页版），核实后确认均为误报——记录在案以备后续查阅。*
