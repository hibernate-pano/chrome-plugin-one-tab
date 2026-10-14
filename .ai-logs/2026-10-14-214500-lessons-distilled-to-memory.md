# 把 2026-10-14 两轮修复的经验教训沉淀为纪律

- 时间：2026-10-14 21:45
- 触发：Jasper：「请将修改中的经验教训记录下来，存为 AI log 或转化为 skill，
  针对那些项目问题，以后不要再犯。」

## 1. 对话出发点

上一轮我修了 WebDAV 的 P0（同步门禁把自带存储用户挡在门外），
过程中犯了几类错误。Jasper 要求把它们固化成不会再犯的纪律。

## 2. 执行过程

### 2.1 沉淀到 `.memory/`（本地知识库，**不**进版本控制 —— 仓库既有约定）

新增四条，每条都带 `Why`（这次的真实场景与证据）/ `How to apply` / `Related`：

| 文件 | 一句话 |
|---|---|
| `fallback-catch-must-not-equal-pre-fix-behavior.md` | 兜底 catch 的兜底值不能等于「修复前的行为」，否则修复不可验证 |
| `fix-verified-only-on-mock-means-nothing.md` | 只在 mock 上验证过的修复等于没验证（单测构造状态会绕开门禁） |
| `e2e-assertion-must-distinguish-failure-modes.md` | E2E 断言必须能区分失败原因，否则前提不成立会让它假绿 |
| `mutation-verification-read-assertions-not-summary.md` | 变异验证看断言行为，不看脚本总结行 |

发现 `.memory/` 已被 `.gitignore:33` 排除，且既有 10 条记录从未进过版本控制
⇒ 判定为「有意的本地知识库」，不擅自 `-f` 提交。

### 2.2 沉淀到跨项目记忆（`/Users/panbo/.codex/memories/extensions/ad_hoc/notes/`）

既有记忆里已有「假绿 / 变异验证」的通用纪律（来自 video-manager 那次），
但缺这次的两条**新形态**，故写更新说明而非直接改记忆文件：
- 兜底伪装（catch 兜底值 = 修复前行为）
- 门禁绕过（单测构造已认证态，跳过真实门禁）—— 建议作为「假绿清单第三类」

### 2.3 纪律立刻生效（当场抓到一处残留隐患）

按新写的第一条纪律自检当前代码，发现
`readConfiguredBackendId` 的 `catch { return 'supabase' }`
**仍然等于修复前行为**（触发路径已因静态 import 消失，但形态在）。
⇒ 补 `logWarn` 让「读失败」可区分，并回填到 `.memory/` 的补记段。

补记里还记了一条同源错误：写那段注释时我先写了「因此这里出声」，
但代码里当时**并没有** `logWarn` —— 注释宣称做了某事、实现没做，
正是同一条纪律要防的东西。

## 3. 最终结果

- 4 条纪律进 `.memory/`（本地知识库，与既有 10 条同处）
- 1 份跨项目记忆更新说明
- 1 处代码隐患当场修掉（兜底出声）
- 验证：type-check 通过；1311 单测全绿；E2E 7 项全过；无残留进程

## 4. 未做

- 未把 `.memory/` 提交进版本控制（仓库约定排除，需 Jasper 决定是否改变）
- 未做成 skill：这几条是「判断纪律」而非「可执行流程」，
  放 `.memory/` 与既有惯例一致；skill 留给有明确步骤的流程（如发版纪律）
