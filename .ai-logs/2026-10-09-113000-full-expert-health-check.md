# AI Log：专家团全方位体检（6 方向并行）

- 时间：2026-10-09 11:30 起（Asia/Shanghai）
- 项目：TapStack（chrome-plugin-one-tab）
- 触发：用户要求「只考虑本机，充分调用专家组资源，对当前项目做全方位、深入且详尽的审查与体检，调动最大 Token 上限与思考能力」

## 一、对话出发点（原始需求与动机）

用户要的不是单点排查，是**借 6 位常驻专家做一次全项目体检**，且要求「发现问题、解决问题」。
「只考虑本机」= 排除任何需要重新 clone / 换机器的方案建议（如把 `.codex/` 挪进仓库）。

上一轮（今天 10:25-11:05）刚做完两件事：
1. 组建 6 人专家团写入 `.codex/agents/`（本地资产，不进仓库）
2. 清理项目臃肿（方案 A：只删零引用确定无用项）——这解释了工作区现有的未提交改动

## 二、执行过程

### 1. 先拿基线真实数字，不引用文档
- `node --test` 全量：**995 tests / 0 fail / 0 skipped / 0 todo**（12.4s）
- src：**23,054 行 / 137 文件**；tests 88 个文件
- 关键：`skipped 0` —— 说明真库门禁这次是真跑了，不是静默跳过

### 2. spawn 踩到的坑：fork_context 与 agent_type 互斥
第一次尝试 `agent_type: "data-safety-expert"` + `fork_context: true` 三连，全部报错：
> Full-history forked agents inherit the parent agent type; omit agent_type, or spawn without a full-history fork.

修法：去掉 `fork_context`，改为把 `.codex/agents/_shared.md` 的要求写进 prompt。
这与 10-09 早上那次 spawn 的坑**完全相同**，说明它是工具的稳定约束，不是偶发。

### 3. 主线程并行做专家覆盖不到的事
- PG 真库门禁单跑：`tests/guards/*.test.ts` → 65 passed / 0 skipped
- `pnpm validate` 全绿：type-check + type-check:tests + lint + lint:tests + build + check:bundle
- 体积门控：首屏 **193.6KB ≤ 240KB** 预算
- `git reflog --date=iso` 核对工作区未提交改动来源（见第四节）

## 三、遇到的问题（含我自己犯的错）

### 问题 1：`pnpm validate` 里 `check:bundle` 打印预算但需确认是否真比较
已核实：脚本内有 `✅ 体积门控通过：193.6KB ≤ 240KB` 的显式比较，不是只打印。

### 问题 2：被清理的 `e2e-web-dashboard-sync.mjs` 看起来像误删（我第一反应）
该脚本头部注释写明它守护一个真实事故：云端守护触发器曾写成 `<=`，导致
Web 控制台的「局部 UPDATE」（payload 不带印记列）被静默跳过，**用户界面显示成功、云端毫无变化**。

第一反应判定为「P0 误删守卫」。**两轮复核后撤回**：
1. `git log --diff-filter=D -- "src/web/*"` → `db09f10 refactor(slim): 砍掉影子双写 / 网页版 / react-dnd`
   —— 网页版早在 10-05 就被砍了，`src/web/` 目录、`build:web` 脚本、`dist-web` 均已不存在。
2. 该 E2E 依赖 `pnpm build:web` 与 `src/web/`，跑了必然失败。
3. 关键：**触发器那条回归已被 `tests/opStampGuard.pg.test.ts` 用真库覆盖**，
   断言原文「Web 控制台的局部 UPDATE（不带印记列）必须生效」（tests/opStampGuard.pg.test.ts:255）。

结论：移除是正确的，覆盖未丢失。这条进「误判记录」。

### 问题 3：我把 `deadCodeGuards.test.ts` 的黑名单读成了白名单（第 3 次误判）
看到 `FORWARDING_SHIMS` 列了 17 个 `src/utils/*.ts` 路径，而文件系统里**一个都不存在**，
本机复核方式：`python3 os.walk('src')` + `git ls-files | grep -i web` + 逐个 `[ -f ]` 存在性检查。

差点报成「17 个转发垫片缺失、测试全绿是假绿」。读完整测试后撤回：
`FORWARDING_SHIMS` 的语义是**「已物理删除，不得复活」的黑名单**，
断言是 `filter(existsSync) === []` —— 文件不存在才是期望的通过态。测试设计是对的。

这条误判代价很大：如果只看「17 个文件不存在 + 测试绿」就下结论，会制造一个
看起来证据充分、实则完全错误的 P0。**这就是 `_shared.md` 陷阱 2 的现实版。**

## 四、外部自动化改动的对账（陷阱 4 口径）

工作区非我改动：
```
 D docs/y-bundle-report.md
 D scripts/e2e-web-dashboard-sync.mjs
 M scripts/run-e2e.mjs
?? .ai-logs/
```
- 来源：今天 10:55 的「清理项目臃肿（方案 A）」任务（见 `.ai-logs/2026-10-09-110000-cleanup-bloat.md`）
- `git reflog` 显示最后一次 commit 是 10-08 18:49，**这些改动全是 10-09 的未提交状态**
- 判定：**属正常遗留，不 reset、不 revert**。已在 E2E 一项上独立验证其正确性。

## 五、最终结果（本条日志先记到这里，专家报告回来后补）

门禁基线全部实测通过，问题清单待 6 位专家报告汇总后追加。

---

## 六、专家报告汇总（5/6 已回，UX 专家待回）

### 门禁实测（本机，非引用文档）

| 项目 | 结果 |
|---|---|
| `node --test "tests/**/*.test.ts"` | **995 pass / 0 fail / 0 skipped** |
| `tests/guards/*.test.ts` 单跑 | 65 pass / 0 skipped（PG 真库真跑） |
| `tests/guards/migrationReplay.pg.test.ts` | 11 pass，含 golden 双库比对 |
| `pnpm validate` | 全绿（type-check + lint + build + bundle） |
| 体积门控 | 193.6KB ≤ 240KB 预算 |
| 24 条迁移真库两遍重放 | 各 0 失败 |
| glob 退化实测 `tests/*.test.ts` | **930 pass / 0 fail / 0 skip（65 个静默消失）** |

### 已独立核实的 P0（我逐条读代码复核，非采信）

1. **三张浏览历史表 RLS 未启用** —— `grep "ENABLE ROW LEVEL SECURITY"` 对
   `tab_groups`/`tabs`/`user_settings` **零命中**，但策略存在
   （`20251014063156`）。代码侧成立；**线上状态需 Dashboard 复核**。
2. **门禁查了但不判断** —— `migrationReplay.pg.test.ts:148` 快照确实含
   `relrowsecurity`，但 golden 比的是 **policy 名字集合**，两库都不开 RLS 时
   名字完全一致，照样全绿。`verifyProfilesRls` 也只查 profiles。
3. **migration_flags 被覆盖** —— `storageAdapter.ts:75-93` 先整份复制
   `migration_flags`，再用只含 `chromeStorageMigrated` 的对象覆盖写回。
4. **迁移裸调用 + 规则就在旁边** —— `service-worker.ts:49` 裸调 `migrateToV2()`，
   而 `:57` 的注释明写「此刻处在队列外，必须入队」；`factory.ts` 不写
   `version`/`displayOrder`，`migrationHelper.ts:19` 判据就是这两个字段
   → **保存过会话后每次启动都跑整表写**。
5. **popup 侧无跨 realm 锁** —— `TabList.tsx:27` 裸调 `runMigrations()`；
   `navigator.locks` 全仓零命中（python + rg 双复核）。
6. **商店文案自相矛盾** —— `CHROMEWEBSTORE.md:34` 同一段先写「数据传输到
   你的云端账户」，后写「不上传你的浏览历史」，而会话数据的定义就是 URL。
7. **测试阈值形同虚设** —— `p0DataSafetyGuards.test.ts:208` 抽取断言
   `> 400`，坏抽取实测 440 字符可放行。
8. **glob 自我指涉** —— 断言递归 glob 的守卫住在 `tests/guards/` 里；
   剥注释复核后顶层测试对 guards 的引用 `False`（我一度怀疑有外部锚点，撤回）。

### 我自己的误判（4 条，全部已撤回）

1. 「17 个转发垫片缺失 = 假绿」→ 实为「不得复活」黑名单，文件不存在才是通过态。
2. 「删除 e2e-web-dashboard-sync.mjs 丢覆盖」→ 网页版已删、该回归已被
   `opStampGuard.pg.test.ts:255` 真库覆盖。
3. 「顶层有 syncBusyGate 引用 guards，所以 P0-1 不成立」→ 该引用在注释里，
   剥注释后零命中，P0-1 成立。
4. 「src/web 不存在」的初判方向反了 → 不是删错，是清理正确（前置物全灭）。

### 尚未完成

UX 诚实度专家报告待回（已发消息索要正文）。

---

## 七、6 位专家全部回报完毕 · 最终汇总

### 交叉验证：两位专家独立命中同一根因

**架构专家**「管理页迁移绕过 SW 单写者队列」与
**数据安全专家**「popup 侧迁移跨 realm 直写整表」是同一个缺陷的两种表述。
我独立读代码确认三处事实：

1. `TabList.tsx:27` → `runMigrations()` 裸调，无跨上下文委托
2. `service-worker.ts:49` → `migrateToV2()` 裸调，而 `:57` 注释明写「队列外必须入队」
3. `navigator.locks` 全仓零命中（python + rg 双复核）→ popup 与 SW 各持一份
   `mutationQueue` 模块实例，**就算 popup 里调 enqueue 也保护不了 SW 的写入**

`factory.ts` 确实不写 `version`/`displayOrder`，`migrationHelper.ts:19` 判据
就是这两个字段 → **保存过会话后每次启动都会跑整表写**（非一次性升级路径）。

### UX P0 我逐条核实（3/3 成立）

| 报告项 | 核实结果 |
|---|---|
| P0-2 先删后开 | ✅ `TabGroup.tsx:194` deleteGroup 在前，`:211` setTimeout 才 OPEN_TABS；`:225` 文案仍称「它们仍保留在会话中」 |
| P0-3 搜索侧无回包 | ✅ `SearchResultList.tsx:229` sendMessage 无 callback 参数，也无在途锁 |
| P0-1 谎报保存成功 | ✅ `TabManager.ts:230` 预检 return，`service-worker.ts:206` 调用方仍无条件发「当前标签页已保存」 |

### 全部 P0 汇总（去重后 5 条）

1. **三张浏览历史表 RLS 未启用**（安全）— 代码侧实测：`tab_groups`/`tabs`/
   `user_settings` 零 `ENABLE ROW LEVEL SECURITY`，但策略存在 ⇒ 策略是死的。
   本地真库重放后 anon 可读全站、可删他人数据。**线上状态需 Dashboard 只读 SQL 确认。**
2. **迁移绕过单写者队列**（架构 + 数据安全交叉命中）— 两处，可整段覆盖并发刚写入的
   会话且回报成功，末端是「本地与云端都没有」的真丢失。
3. **恢复 = 先物理删除再打开**（UX P0-2/P0-3）— 打开失败/跳过时记录已删；
   且文案承诺「仍保留在会话中」与实际相反。搜索侧连回包都不看。
4. **预检失败仍报成功**（UX P0-1）— 单标签保存三类预检提前 return，调用方无条件弹成功。
5. **测试假绿 ×2**（测试）— glob 退化静默丢 65 个测试（930 全绿 0 skip）；
   文案抽取阈值 `>400` 放行 440 字符的坏抽取。

### 测试专家实测变异结果（这是「995 全绿」的反证）

18 组变异：**15 组改坏变红，3 组改坏仍绿**（全部是真缺陷）。
还原后全量复跑 995/0 fail，17 个变异文件 `git diff` 全 CLEAN。

### 我的误判记录（累计 7 条）

1. 17 个转发垫片缺失 = 假绿 → 实为「不得复活」黑名单
2. 删除 e2e-web-dashboard-sync.mjs 丢覆盖 → 网页版已删，回归已被
   `opStampGuard.pg.test.ts:255` 真库覆盖
3. 顶层 syncBusyGate 引用 guards → 剥注释后零命中，测试专家正确
4. src/web 判断方向反了 → 清理正确
5. 安全专家报告里的 `handle_new_user` 判定（该专家自撤）
6. 产品专家的「76 个文件零引用」（该专家自撤）
7. UX 专家的「Header 仍 fire-and-forget」（该专家自撤）

### 未能验证项（受环境限制，非遗漏）

- 线上 Supabase schema / RLS / 迁移 ledger（无 Dashboard 凭证，按纪律不从代码推断）
- 真实双 realm 时序命中率（注入式交错证明因果链，未在真 Chrome 里跑）
- 13 个 E2E 脚本（需 headed Chromium + 线上库写权限）
- **CI 未跑**：本机只验了 `.github/workflows/verify.yml` 文本

### 门禁实测表（本机真实执行）

| 命令 | 结果 |
|---|---|
| `node --test "tests/**/*.test.ts"` | 995 pass / 0 fail / 0 skipped |
| `tests/guards/*.test.ts` | 65 pass（PG 真库真跑） |
| `pnpm validate` | 全绿 |
| 体积门控 | 193.6KB ≤ 240KB |
| 24 迁移两遍重放 | 各 0 失败 |
| 变异测试 | 18 组，15 红 3 绿（3 绿 = 真缺陷） |
| 还原校验 | sha256 逐个一致，git diff 全 CLEAN |

### 状态

**发现阶段完成。** 产品代码零改动（只读审查 + 变异后已全部还原）。
下一步是修复，其中 4 条属纯技术无争议，2 条涉及产品语义需负责人拍板。
