# 2026-10-12 00:40 — 六方向专家团深度体检（只读）+ HTML 报告

## 对话出发点

用户要求：「调用你的 Agent 能力和专家团队，对当前项目进行深度体检，并撰写报告。
我需要的是 HTML 格式，可以直接在浏览器中打开的。」

动机不是单点排查，是**借 6 位常驻专家做一次全项目体检**，
且要一个能直接打开的产物（不是 Markdown）。

## 执行过程

### 1. 先拿基线，不引用文档
- 读 `MEMORY.md` 与 `.ai-logs/2026-10-09-113000-full-expert-health-check.md` 建立历史基线
- 发现项目**已有常驻专家团** `.codex/agents/`（6 个角色 + `_shared.md` 共享底座），
  且 10-09 已做过一轮六方向体检 → 本轮是**同口径复检**，重点是「1.23.0 之后变了什么」
- `node --test "tests/**/*.test.ts"`：**1117 pass / 0 fail / 0 skipped**（27s）
- `pnpm validate` 全绿，首屏 **197.7KB ≤ 240KB**

### 2. 并行 spawn 6 位专家
一次 spawn 6 个（data-safety / ux-honesty / security-compliance / architecture /
test-gate / product-strategy）。security-compliance **首次 spawn 报错**
（`WorkBuddy AI: Invalid request parameters`），close 两个已完成的后重新 spawn 成功。

### 3. 主线程并行做专家覆盖不到的事
- `pnpm lint` 报「353 errors」→ **这是假信号**：直接 `npx eslint` 跑出 exit 0 零输出。
  按 RTK.md 的恢复路径 `rtk proxy pnpm lint` 复核仍为干净。
  **并做负向验证**：故意在 `src/lib/utils.ts` 植入 `console.log` + 未使用变量 → lint 变红（exit 1），
  还原后恢复 exit 0 ⇒ 证明门禁是真的，不是「lint 坏了所以没报错」
- 独立复核专家最高危的每一条结论（见下）

## 遇到的问题（含我自己犯的错）

### 问题 1：`pnpm lint` 的「353 errors」是假信号，差点写进报告
第一反应是「lint 挂了，353 个错误」并准备作为 P0 上报。
复核三步：① `npx eslint src --ext ts,tsx --max-warnings 0 > file 2>&1; echo $?` → **exit 0，文件 0 行**
② `rtk proxy pnpm lint` → 干净 ③ 那些文件名全是 `dist/` 里的构建产物哈希名，src 下不存在。
**根因是输出包装层（rtk）的陈旧缓存，不是仓库。**
**若只看第一眼就上报，会造出一个「看起来证据充分、实则完全错误」的 P0。**

### 问题 2：一次 `apply_patch` 写 784 行 HTML 失败
大 patch 里有一行 CSS 缺前缀空格，被解析成 hunk header → `invalid hunk header`。
改用 `cat >> ... <<'HTMLEOF'` 分 5 段追加。
追加时 heredoc 里混进了 3 个 `+` 号（diff 习惯污染），用 python 事后清掉并做结构校验。

### 问题 3：并行 agent 压满内存导致一次 eslint 异常终止
末段复核时 `npx eslint` 报 `Linter process terminated abnormally (possibly out of memory)`。
3 秒后重跑 → exit 0 零输出。判定为**并发资源压力，非代码信号**，未写进报告。

## 独立复核（本轮的核心纪律）

专家报告不采信口头结论，每条高危项都自己再验一遍。**复核推翻/证实了 6 条**：

| 专家结论 | 复核方式 | 结果 |
|---|---|---|
| lint 353 errors | `npx eslint` + `rtk proxy` + 植入违规负向验证 | ❌ **撤回**（我自己的） |
| localStorage 回退 fail-open | 用**真实模块**跑探针（`/tmp/dsverify/probe.mjs`） | ✅ 证实：`getItem → null` |
| `settingsReadFailed` 门禁漏 pending | grep + 逐行读 + 检查守卫覆盖 | ✅ 证实：守卫只查置位/检查，**不查初值** |
| `_execute_action` 快捷键语义错 | python 解析 manifest.json + 读 `action.onClicked` | ✅ 证实：`default_popup` 不存在 |
| 通知开关无消费者 | **按陷阱 2 用 python 换工具全量扫 src** | ✅ 证实：7 处命中全是声明/映射/UI，零消费者 |
| RLS 未启用（上一轮 P0） | `supabase db query --linked` 实测 7 张表 | ❌ **已收口**，撤回 |
| profiles 可自助提权 | 实测 `relacl` + `pg_policy` + `column_privileges` | ✅ 证实：`authenticated=ardDxt` |
| README「每 60s 自动拉取」 | grep README + grep docsAlignment | ✅ 证实：README 4 处命中，守卫**零断言** |

**结论：一条撤回自己的、四条被专家撤回的、六条证实。**

## 最终结果

**成功。** 产出：

- `docs/health-check-2026-10-12-expert-team.html`（64KB，784 行，结构校验通过：
  标签全闭合、9 个锚点全有效、无占位符残留），已在默认浏览器打开验证
- 产品代码**零改动**，`git status --porcelain` 为空

报告结构：结论先行 → P0(2) → P1(7) → P2(10) → 门禁实测表 → 专家团与交叉验证 →
误判记录(12 条) → 未能验证项 → 需要负责人决断(5 组)。

### 门禁实测（本机真实数字）

| 项目 | 结果 |
|---|---|
| 全量单测 | 1117 pass / 0 fail / **0 skipped** |
| 真库守卫 `tests/guards/*` | 67 pass / 0 skipped |
| `pnpm validate` | exit 0 |
| 首屏体积 | 197.7KB ≤ 240KB |
| 变异验证 | 21 红 / **5 绿（全是真缺陷）** |
| 线上库只读实测 | 7 张表 RLS 全 true；profiles 仅 2 条策略 |

### 三个最重要的发现

1. **P0：localStorage 回退驱动 fail-open** —— 不变式只做在 IndexedDB 上，没做在驱动选择上。
   读失败 → 判成「没有数据」→ 整库覆盖 → 报成功 → 无回收站。**守卫从未测过这条路径。**
2. **P1：线上实测的 profiles 自助提权** —— 表级 `ardDxt` 含 w + WITH CHECK 只约束 id
   ⇒ 任何登录用户能改自己的 `plan`。客户端零依赖，收紧零业务影响。
3. **系统性：1.23.0 的 6 处文案漂移** —— 行为契约变了，只改了 changelog 行；
   `docsAlignment.test.ts` 对 `自动同步/syncEnabled/60s` **零断言**，所以一片全绿。

### 未做的事（如实记录）

- 未跑 16 个 E2E（需 headed Chrome + 会写线上库）
- 未跑 `anon-rls-probe.mjs --write`（只读纪律 + 线上处于 `exceed_egress_quota` 限流）
- 未触发 CI（对远端有副作用）；已确认最后绿是 10-06、之后 29 个提交未跑
- LWW「静默让路」路径是代码推理，未做两设备真机复现 ⇒ 报告里标为「高置信度待复现」而非已确认缺陷
