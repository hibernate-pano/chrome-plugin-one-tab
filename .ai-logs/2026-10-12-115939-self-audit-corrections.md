# 2026-10-12 11:59 — 自我审计：3 处结论更正（永久停摆 / 注释前提 / 根因 commit）

## 对话出发点

体检报告交付、P0/P1 修复完成后，用户要求：
「请重新分析你的结论，并快速审查一遍，告诉我哪些是正确的，哪些是幻觉。」
⇒ 目标：对已交付的结论做对抗式复核，把「说错的」与「没验证就说的」全部标出来，
并让代码注释 / 报告与事实一致（这些注释是知识资产，错的知识资产比没有更糟）。

## 执行过程

不看旧报告结论，逐条重新取证（HEAD 版源码 + git 考古 + 重跑门禁）：

1. `rg "setBadgeText|setBadgeBackgroundColor|action\.setBadge" src/ tests/` → 零命中
   ⇒「快捷键路径没有 badge 通道、通知是唯一反馈渠道」成立。
2. `rg -n "showNotifications" src/` → 全部出现点 = 类型 / 默认值 / reducer×2 / UI /
   云端映射×2，无任何行为消费者；`TabManager.ts:453` 无条件 `chrome.notifications.create`
   ⇒「开关是死接线、开关撒谎」成立。
3. `git show 4488974` → 引入通知开关的同一提交里 `showNotifications: false`
   ⇒「默认 false 自引入之日即如此」成立。
4. HEAD 版 `handleAlarm` catch 分支确实写死 `NORMAL_INTERVAL_MINUTES`（已修）。
5. git 考古逐提交核对 `utils/notification` 的引用史（详见幻觉 3）。
6. 全量单测 1129 pass / 0 fail / 0 skipped；`pnpm validate` exit 0。

## 遇到的问题（审计发现的 3 处幻觉，全部出在上一轮结论 / 注释里）

### 幻觉 1：「原注释『异常路径拿不到用户档位』的前提是错的」

- 事实：HEAD 版 `const cfg = await readAutoSyncConfig()` 在 try **内**（首行），
  catch 在语法上确实引用不到 —— 原注释的作用域判断是对的。
- 正确叙述：把声明提到 try 外 + `?? NORMAL_INTERVAL_MINUTES` 兜底是**改进**
  （让异常路径也用上真档位），不是「纠错」。
- 附带边界：写死 60s 的 period 只持续到下一次重排 —— 下一轮 alarm（退避阶梯
  ≤5 分钟）或下一次 SW 唤醒都会用 cfg 重排回用户档位。「一次异常永久退回每分钟」
  是夸大；修复价值在于维持不变量「period 恒 = 用户档位」。

### 幻觉 2：「一次瞬时读错误就永久停掉自动同步」

- 事实：`service-worker.ts:184` 模块顶层**每次 SW 唤醒都会**重进 `setupBackgroundSync`
  重建 alarm（另有 onInstalled / onStartup / resyncAlarm 三个入口）。
- 正确口径：停摆到**下一次 SW 唤醒**为止 —— 无事件就无唤醒，时长不可控（可能很久），
  但不是永久。
- 修复（读失败重排 1 分钟）的价值因此是：把自愈收缩到 1 分钟内、不再依赖用户下次
  交互。缺陷方向没错，严重程度说大了。

### 幻觉 3：「dff8582 删 notification.ts 时没把判据搬过来」

- 事实链：
  · `git grep utils/notification d558d91^ -- src/` → `src/background.ts:5` 有 guard import；
  · `git show d558d91` → 删掉该 import，同一提交在 `src/service-worker.ts:46` 新增
    无判据 wrapper `const showNotification = async (msg, title) => { await tabManager.showNotification(...) }`；
  · 此后 `utils/notification` 全仓零引用；`dff8582`（2026-09-29）只是删除死文件
    （`git log --diff-filter=D` 证实）。
- ⇒ 判据绕过点在 **d558d91**（2026-01-25 "chore: refactor background sync layer"），
  不是 dff8582。大方向「判据曾存在、后来没搬」成立，根因归属更正。

## 更正动作（全部完成）

1. `src/background/backgroundSync.ts`：5 处注释重写（flag 文档 / readAutoSyncConfig
   catch / setup 分支 / handleAlarm 分支 / catch 分支）。未动任何代码与结构
   （`let cfg: AutoSyncConfig | null = null;` 有结构测试钉着，原位保留）。
2. `tests/autoSyncDefaultOff.test.ts`：H / I 段注释与断言消息同步更正；
   未动断言结构与正则。
3. `docs/health-check-2026-10-12-expert-team.html`：
   · 通知开关根因 commit 更正（dff8582 → d558d91，注明 dff8582 只是删死文件）；
   · P1 标题 / 现象 / 链路图改为「停摆到下一次 SW 唤醒（修复后 1 分钟自愈）」；
   · 「异常分支洗回 60s」表格行更正（作用域描述 + 影响窗口有限）；
   · 撤回表 +3 行（28→31 条，主线程 1→4 条）；
   · 顺手修正两处行号漂移（TabManager 452→453；settingsSlice 114/132→133/151）。
4. HTML 标签配对 sanity check：tr/td/details/table/div/section open==close。

## 结果

- 全量单测：**1129 pass / 0 fail / 0 skipped**（12.6s，修复与更正后重跑）。
- `pnpm validate`：**exit 0**（validate-extension + type-check×2 + lint×2 + build
  + bundle 门控 197.9KB ≤ 240KB）。
- 报告与注释现与事实一致；3 条更正已进入报告「误判记录」表。
- 教训：**结论也要做变异验证。** 「修复的理由」如果没被独立复核，危害与假绿测试
  相同 —— 这次 3 处幻觉里最误导的一处（「原注释前提是错的」）恰恰是写进注释里当
  「论证」用的。
