# 2026-11-13 审查近期改动（v1.29.0 → v1.31.0 + CI 修复）

## 出发点

Jasper 要求：对当前项目最近做的一批改动做一次审查，列出报告，说明「最近做了什么」以及「质量如何」。

## 执行过程

1. `git log --since=2026-10-25` + `git diff --stat b005bce~1 HEAD` 确定范围：
   119 个文件、+7894 / -1273 行，覆盖 v1.29.1 / v1.29.2 / v1.30.0 / v1.30.1 /
   v1.31.0 五个发布，以及 2026-11-13 的 CI 与 WebDAV TTL 修复。
2. 读取项目记忆中的两条历史纪律：WebDAV「假绿与门禁被绕过」、storage「读-改-写必须取真值」。
3. 跑基线：`node --test ... "tests/**/*.test.ts"` → 5100 tests / 0 fail / 0 skip，耗时约 305s。
4. 跑 `npx tsc --noEmit`、`npx eslint src` → 均干净；`npx vite build` → 通过。
5. 跑完整 `validate` 链路：元数据校验 1.31.0 → tsc(src+tests) → eslint(src+tests) →
   vite build → 体积门，全部通过；popup 首屏 189.2KB / 预算 190KB。
6. 变异验证三条（改坏实现 → 跑守卫 → 恢复）：
   - 删掉 apple.css 的 `--radius-lg` → `themeRadiusScale` 红 2 条（令牌缺失 + 刻度递进）。
   - 把 Toast 的顶边改成写死 `1rem` → `firstUseExperience` 红 1 条（回落值断言）。
   - 去掉 `monthsBefore` 的日历月钳制 → `cleanupPlan` 红 4 条（3/31→2/28、闰年、5/31 等）。
   三条变异均确认生效（`git diff --stat` 有对应改动），红的原因均为目标原因；随后 `cp` 恢复，
   `git diff --stat src/` 为空。
7. 数据安全核查：`mutationService` 注入 `getGroupsForWrite()`；`deleteGroups` 执行时刻再判锁定、
   `noteDeletedGroups` 与 `scheduleUpload` 均 await；确认部分删除不走 `overwriteCloud`。
8. 交付风险核查：`.env` / `*.zip` / `dist` 均未入库；`git grep service_role` 仅文档提及，无密钥。

## 遇到的问题

- 无阻塞。审查过程中发现三处非阻塞问题，已写入报告：
  1. popup 首屏预算仅剩 0.8KB（189.2 / 190），下一次加功能极易撞门。
  2. `verify.yml` 头部「本机 pnpm test 约 15 秒」已过期，实测约 305 秒。
  3. `.ai-logs/` 在 2026-11 无任何记录，而 11-12 / 11-13 有 20+ 提交。

## 最终结果

审查完成，结论：工程质量高于个人项目平均水平，接近可对外开源的水准；
门禁真实有效（变异验证三次全部被抓），数据安全防线未被这次改动破坏。
主要风险集中在交付侧（体积预算余量、E2E 不在 CI、发布包与 HEAD 的版本差），
而非代码正确性。本次未修改生产代码。

## 后续：审查建议的收口（同日 20:40 左右）

Jasper 确认后只做了两处文档级小修，未动生产逻辑：

1. `.github/workflows/verify.yml`：在「本机 pnpm test 约 15 秒」下方追加
   2026-11-13 复测更正（5100 条 / 约 305 秒），保留 10-06 的原始记录不改写。
2. `scripts/report-bundle-size.mjs`：追加 1.31.0 复测「189.2 / 190，余量 0.8KB」
   与「下一版先减等量再加」的棘轮纪律。

更正一处误报：上一轮报告说「空库时菜单显示『删除所有会话（0）』」。
核对 JSX 后发现父级已有 `menuGroupCount > 0` 守门，该行在空库时根本不渲染，
不是问题，未做改动。

验证：ruby YAML 解析通过（jobs=verify）；`report-bundle-size` 仍输出
189.2KB ≤ 190KB；`git diff --stat` 仅 2 文件 +9 行。未提交。
