# TabStack 个人项目迭代蓝图（Sprint 8+）

> **更新日期**：2026-08-05
> **基线版本**：v1.13.6（最后提交 `bdcfea7`）
> **作者**：ZCode (架构) + 户主（产品）
> **状态**：✅ 已批准 — 等待拆分为独立 spec

---

## 0. 这是什么

这份文档定义了 TabStack 个人项目阶段的**整个方向**，不是某一组改动的实现计划。三件并行的事：

| Sprint | 主题 | 一句话 |
|---|---|---|
| **S1** | 同步骨架加固 + 错误体验 | 数据更可靠的护栏 + 错误不再吓人 |
| **S2** | 启动性能 + 大列表性能 + UI 精致度 | 自己用着明显快、明显舒服 |
| **S3** | 新功能：会话预览 / 恢复增强 | 1–2 个针对"我自己"的高价值小功能 |

每 sprint 单独有**自己的详细 spec + plan**，但站在这份蓝图下来拆。

---

## 1. 目标 / 非目标

### Goals

1. **自己用着明显舒服**——打开 popup 更快、操作更顺、视觉更统一。
2. **数据更可靠**——同步错误、离线、加密失败三种情境下都有清晰恢复路径。
3. **架构健康**——死代码清掉、selector / memo / hydration 三处护栏再加固。
4. **保持可上架**——S2 后能做商店截图 4 张，完成已规划的 Ship It 剩余动作。

### Non-goals

1. **不为社群 / 商业化预留**扩展点（你已明确：纯个人项目）。
2. **不引入框架性新依赖**（React 18/Vite/CRXJS/lodash 锁版本不动）。
3. **不动 IndexedDB DB 名** `tabvaultpro`（数据兼容锁）。
4. **不动 syncEngine / syncUtils / hydrationDecision 三处核心护栏**。
5. **不做 React 19 / Vite 5 / CRXJS v3 升级**——等社区稳定后再说。

---

## 2. 用户与场景

### 主要用户

> 你自己。每天多次开关 popup、保存 / 恢复会话、可能开云同步（已配置 Supabase）。

### 三大场景

| 场景 | 频率 | 痛点 |
|---|---|---|
| **A. 临时保存当前工作窗口** | 每天 1–5 次 | popup 打开要等、save 按钮没立刻见 |
| **B. 切上下文：保存当前 → 切到另一个会话** | 每天 2–10 次 | 切换要等加载、列表卡顿 |
| **C. 公司 → 家无缝接续** | 每周 1–2 次 | 同步 UX 复杂度高、"上次同步时间"不清楚 |

### 隐性场景

- 在 popup 已经打开时切换 chrome tab，回来时 popup 状态丢失 → 等再次点击 icon 重新加载
- 想找一个 N 天前保存的会话，但搜索结果展示乱
- 主题切换后短时间内 popup 卡顿

---

## 3. 设计哲学（三条铁律）

> **保留品牌底色、提升密度与呼吸感**。TabStack 的颜色（teal + 橙）与字体已是用户身份的一部分，**不动**。改的是**信息层级、动效密度、视觉锚点**——让"高级感"来自克制与节奏，不来自颜色。

> **功能减负而非加码**。当前 UI 装的功能比它能从容展示的多——**砍掉"复杂到没人用的预览合并"、收拢多个分散入口、删掉死代码**。新功能留给 S3。

> **性能不是装饰而是地基**。诊断列出 14 项 perf 问题，**不全部修**，按"用户可感 × 改动成本"挑出最关键的 5–6 项做掉。修完会让 30+ / 100+ / 300+ 规模的会话都流畅。

---

## 4. Sprint 拆解

### S1 — 同步骨架加固 + 错误体验（≈ 1 周）

**目的**：在动 UI 之前先把数据可靠性的护栏补齐，避免 S2/S3 改动踩坏已有的 syncMergeSafety / hydrationDecision 防线。

#### S1 主要工作

| # | 任务 | 输出 |
|---|---|---|
| S1-1 | syncEngine 添加"上次同步尝试时间 / 失败原因"持久化 | storage 加 `last_sync_attempt_at` + `last_sync_error` |
| S1-2 | 5 类错误统一 throw 类型（`SyncError`, `StorageError`, `DecryptError`, `MigrationError`, `NetworkError`） | `utils/errors.ts` 新文件 + 全调用点改正 |
| S1-3 | 加密失败给出"导出原始 JSON"逃生口 | storage.ts decrypt 路径加 retry-with-passphrase 流 |
| S1-4 | 离线 / 网络变化提示 | `useNetworkStatus` hook + 顶部 8px 提示条 |
| S1-5 | syncEngine DI 集成测试覆盖"回滚 + tombstone 冲突 + 加密 envelope 漂移" 3 种回归 | tests/syncEngine.integration.test.ts |
| S1-6 | storage.hydrateAll 单源化（与 S2-3 共用，重构一次） | storage.ts + popup/index.tsx + AppContainer |

#### S1 不动

- mergeTabGroups / validateMergeResult / hydrationDecision 三个核心纯函数
- IndexedDB DB 名
- syncEngine 类结构

#### S1 完成标准

- `pnpm verify` 全绿
- 5 类错误都有专门测试
- 加密失败逃生口有手工验证脚本（`scripts/verify-decrypt-fallback.mjs`）

---

### S2 — 启动性能 + 大列表性能 + UI 精致度（≈ 2–3 周）

**目的**：让"打开 popup"、"刷新长列表"、"在菜单里找操作"这三件事变快变舒服。

> **S2 是最大块**——本蓝图里**唯一**有一个**单独详细 spec**（`2026-08-05-S2-ux-performance-polish-design.md`，紧随本文档）。

#### S2 概要

- **启动**：popup bootstrap 单源化 → settings 只读一次 → `@tanstack/react-virtual` 隔开 React 18 大列表区块；预计 popup 启动从 ~600ms → ~150ms。
- **大列表**：TabList + SearchResultList 虚拟化（30+ 会话启用）；DnD hover 与 storage persist 解耦（200ms 防抖 trailing）；selector 切片化。
- **UI 精致度**：Header 收 3 个主操作（Logo / Save / Search / Kebab）；Settings 抽成全屏 Tab；同步 UX 降级为单 status row；死代码删除（`SearchBar` / `SyncStatus` / `SyncStatusIndicator` / `ThemeToggleButton` / `StatusFeedback` / `refined.css` / `productivity.css`）。
- **测试**：覆盖率 ~40% → ~65%；+46 测试 → ~343；引入 `@testing-library/react` + `jsdom`（用户已初步认可，你将确认）。
- **不引入**：react-dnd 改动（保持）、tailwind 改动（v3.4）、React 18 升级（保持）。

---

### S3 — 新功能：会话预览 / 恢复增强（≈ 1–2 周）

**目的**：在数据可靠 + 体验顺滑的基础上，加 1–2 个**只对你个人有用**的小功能。

> S3 待 S2 落地之后再细化。下面是候选功能池子，正式 spec 会从里挑出 1–2 个来推。

#### S3 候选功能池

| 候选 | 价值 | 复杂度 |
|---|---|---|
| **3.1 Hover-to-preview**：鼠标悬停会话卡 → 浮窗显示前 5 个 tab 的 favicon + 标题 | 高 | 中 |
| **3.2 "上次读到这"小条**：根据 tab URL 上次恢复时间，显示在该卡顶部 | 高 | 中 |
| **3.3 收藏夹置顶组**：把收藏的会话独立渲染到顶部区域 | 中 | 低 |
| **3.4 工作流模板**：一键"开发模式"开一组预定义会话 | 中 | 中 |
| **3.5 跨设备"待读"清单**：用 Supabase 同步 1 个轻量"待读"列表 | 高 | 高（跨设备） |
| **3.6 暗色模式"自动"真正可用**：ThemeContext 修未达成的 `prefers-color-scheme` | 中 | 低 |
| **3.7 锁会话来防止手滑删**已经存在，但解锁 UX 太隐蔽——加强 | 中 | 低 |

S3 spec 阶段（待 S2 跑完后）会从中选 1–2 个来推。

---

## 5. 三个 sprint 的依赖与顺序

```
S1 ──► S2 ──► S3
 │      │      │
 │      │      └─▶ Chrome Web Store 上架
 │      └─▶ 商店截图拍齐（视觉系统已打磨）
 └─▶ 数据安全护栏
```

理由：
- **S1 先于 S2**：把数据可靠性的护栏补上，S2 改 storage / syncEngine 时不会踩死线。
- **S2 先于 S3**：新功能要在打磨好的 UI / 状态层上加才不会乱；商店截图也要等 S2 完。
- **不并行**：当前你一人项目，串行交付更易 review、避免 merge 噩梦。

---

## 6. 跨 sprint 的不变量（任何 sprint 都不能违反）

| 不变量 | 理由 |
|---|---|
| `mergeTabGroups` + `validateMergeResult` 测试全绿 | 同步数据安全 |
| `hydrationDecision` 测试全绿 | popup 启动安全 |
| IndexedDB DB 名 = `tabvaultpro` | 数据兼容 |
| Service Worker 不加回同步 / alarm 逻辑 | v1.12.0 推翻的旧设计 |
| `useTransition` 包裹搜索 | 已有节奏（MainApp.tsx:33） |
| 测试基础设施用 `node --test --experimental-strip-types` | 受限于自定义 TS loader |
| Chrome extension popup viewport 默认 380–450 px | 设计尺寸 |
| Popup 默认不暴露同步功能给未登录用户 | 隐私 + 避免 sync-ui 空转 |

---

## 7. 风险

| 风险 | 缓解 |
|---|---|
| S2 改 storage / syncEngine 踩坏 syncMergeSafety 测试 | S1 先加固 → S2 在护栏内改 |
| 引入 `@tanstack/react-virtual` 出现意外问题 | 已选事实标准 + 锁版本；80 行 fallback 已备好 |
| 引入 `@testing-library/react + jsdom` 改变测试基础设施 | 已在 S2 估算内 + 不动现有 297 测试 |
| UI 大改让你审美上不喜欢 | 保留品牌 + 设计系统统一在 S2 一次过；S2 spec 内有 mockup 节 |
| S3 新功能过于"自嗨"，你最终不用 | S3 选 1–2 个，每个都先用 1 周再说是否合并 |

---

## 8. 文档结构

| 文件 | 用途 |
|---|---|
| `2026-08-05-tabstack-personal-revamp-blueprint.md`（本文件） | 三 sprint 全景 + 依赖 + 不变量 |
| `2026-08-05-S2-ux-performance-polish-design.md` | S2 详细 spec（6 章节：哲学/范围/组件/数据流/错误/测试） |
| `2026-08-05-S2-ux-performance-polish-plan.md` | S2 实现 plan（writing-plans 产出） |
| `docs/superpowers/specs/2026-XX-XX-S1-sync-guards-design.md` | S1 详细 spec（S2 落地后单独写） |
| `docs/superpowers/specs/2026-XX-XX-S3-new-features-design.md` | S3 详细 spec（S2 收尾时单独写） |
| `docs/AI_HANDOFF.md` | 每次结构性改动后更新（**已设惯例**） |

---

## 9. 落地步骤（接下来的真实工作）

1. **本周**：写完 S2 详细 spec → 你 review
2. **第 2 周**：进入 writing-plans 拆 S2 实现计划 → 你 review
3. **第 3–4 周**：开 S2 实现 sprint
4. **第 5 周**：S2 完成，启动 S1 实现（独立可并行开发小部分）
5. **第 6 周**：S1 完成，写 S3 spec
6. **第 7–8 周**：S3 实现 + 上架收尾

具体节奏到时候再调。

---

## 附 A：诊断证据摘要

| 来源 | 内容 |
|---|---|
| Explore agent — `agent_49ad4581` | 14 项 perf 问题文件:行号清单 + 优先级 |
| Explore agent — `agent_66e5d5` | 12 项 UI/UX 问题文件:行号清单 + top 5 改进 |
| `docs/AI_HANDOFF.md` §5–7 | hydration race + 同步架构真相 + 8 条避坑 |

## 附 B：设计哲学的来源

> "保留品牌底色、提升密度与呼吸感" — 来自诊断的"v0.5–v0.8 prototype with v1 ambitions"判断 + 你确认"纯个人项目"
>
> "功能减负而非加码" — 来自 HeaderDropdown 655 行 / SyncButton 582 行 / ThemeStyleSelector 458 行 / SearchResultList 633 行 这些"过度设计"现象
>
> "性能不是装饰而是地基" — 来自 14 项 perf 问题前 5 项都不是装饰性优化

---

**本文档作为 S2 / S1 / S3 详细 spec 的蓝图依据。任何细节层面的更新都进对应独立 spec，本蓝图只做架构层记录。**
