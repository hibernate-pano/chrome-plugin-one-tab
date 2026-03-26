# TabVault Pro Execution Plan

> 基于 [`COFOUNDER_ROADMAP.md`](/Users/panbo/Code/PanboProjects/chrome-plugin-one-tab/COFOUNDER_ROADMAP.md) 的第一版执行计划。目标不是扩功能，而是先把定位、承诺、可信度和关键闭环对齐。

---

## 1. 当前基线

### 产品基线

- 产品已具备保存、恢复、搜索、导入导出、登录、同步、主题等能力。
- 产品定位仍偏“标签管理器”，尚未收敛为“工作会话保险箱”。
- 对外文案与实际实现存在偏差，特别是同步能力。

### 工程基线

- 当前主背景入口为 `src/service-worker.ts`。
- 标签保存主流程在 `src/background/TabManager.ts`。
- 主界面入口在 `src/components/app/MainApp.tsx`。
- onboarding 文案在 `src/components/onboarding/OnboardingSteps.tsx`。
- README 与版本展示存在不一致问题。

---

## 2. 执行目标

### Phase A：P0 信任修复

目标：1 周内完成基础信任修复，使产品可以继续投入。

成功标准：

- 文案不再承诺不存在的能力。
- 调试残留不再泄漏到正式产品逻辑。
- 页面、文档、包版本统一。
- 用户第一次使用时不会被“实时同步”等描述误导。

### Phase B：P1 会话化升级

目标：2 到 3 周内完成核心心智切换。

成功标准：

- “标签组”逐步收敛为“会话”概念。
- 保存与恢复体验更像“工作现场恢复”。
- 搜索和恢复围绕会话而不是零碎标签展开。

### Phase C：P2 同步与付费验证

目标：在信任稳定后，再增强同步可靠性和商业化。

成功标准：

- 同步行为可解释、可预测。
- 免费与付费边界合理。
- 可以开始做小规模付费验证。

---

## 3. Phase A 详细计划

### A1. 清理调试与风险代码

目标：移除不应该出现在正式产品中的开发残留。

涉及文件：

- `src/background/TabManager.ts`

工作项：

- 删除本地 `127.0.0.1` 调试上报逻辑。
- 删除高噪音的批量 debug 日志。
- 保留必要的错误日志和最小运行日志。

验收标准：

- 保存标签流程不再向本地调试服务发送请求。
- 控制台日志缩减到可读且与用户价值相关。

### A2. 统一版本来源

目标：消除 README、页脚、包版本不一致的问题。

涉及文件：

- `package.json`
- `README.md`
- `src/components/app/MainApp.tsx`
- `manifest.json`

工作项：

- 确认统一版本源优先使用 `chrome.runtime.getManifest().version` 或构建期注入版本。
- 删除硬编码页脚版本。
- 更新 README 头部版本。
- 做一次版本一致性检查。

验收标准：

- 用户在产品内、源码文档、扩展清单里看到同一版本。

### A3. 修正文案与产品承诺

目标：把所有对外表述和当前真实能力对齐。

涉及文件：

- `README.md`
- `src/components/onboarding/OnboardingSteps.tsx`
- `src/components/sync/*`
- 可能涉及设置或帮助文案组件

工作项：

- 把“实时同步”改成当前真实能力描述。
- 统一同步模式文案。
- 审核“云端同步”“跨设备”“自动同步”等字样。
- 保留未来路线，但不当作现有能力承诺。

验收标准：

- 任意入口看到的同步描述都与当前实现一致。

### A4. 修复 README 对外可信度

目标：让仓库主页能直接对外使用。

涉及文件：

- `README.md`

工作项：

- 更新版本、定位与真实功能描述。
- 替换占位 GitHub 地址、Issue 地址、邮箱。
- 增加“当前同步模式”说明。
- 调整项目介绍，从“标签管理器”向“工作会话保险箱”过渡。

验收标准：

- README 可直接给用户、测试用户、潜在合作方阅读。

### A5. 建立最小回归清单

目标：在没有完整自动化测试之前，先建立可靠的人肉回归底线。

建议输出：

- `docs/manual-test-checklist.md` 或根目录 `MANUAL_TEST_CHECKLIST.md`

首批检查项：

- 保存当前窗口全部标签
- 恢复一个已保存会话
- 导入 OneTab 文本
- 登录与登出
- 手动上传同步
- 手动下载同步

验收标准：

- 每次 P0 变更后能快速手动验证关键闭环。

---

## 4. Phase B 详细计划

### B1. 会话命名策略

涉及文件：

- `src/domain/tabGroup/*`
- `src/background/TabManager.ts`
- `src/store/slices/tabSlice.ts`

工作项：

- 设计默认命名规则。
- 支持保存后快速重命名。
- 让名称更像会话而不是无意义时间分组。

### B2. 恢复体验升级

涉及文件：

- `src/service-worker.ts`
- `src/components/tabs/*`
- `src/background/TabManager.ts`

工作项：

- 支持恢复到新窗口。
- 恢复后给明确反馈。
- 处理 pinned tabs 行为一致性。

### B3. 搜索与找回

涉及文件：

- `src/components/search/*`
- `src/components/tabs/TabList.tsx`
- `src/utils/search.ts`

工作项：

- 优先展示会话级结果。
- 增加按域名、时间过滤。
- 增加最近恢复入口。

---

## 5. Phase C 详细计划

### C1. 同步可靠性说明

涉及文件：

- `src/services/smartSyncService.ts`
- `src/services/tabSyncWorkflow.ts`
- `src/components/sync/*`

工作项：

- 明确当前同步模式。
- 明确冲突与覆盖策略文案。
- 强化同步状态反馈。

### C2. 付费边界设计

建议输出：

- `PRICING_PLAN.md`
- `STORE_COPY.md`

工作项：

- 明确免费与 Pro 边界。
- 设计试用期和早期价格。
- 准备 Chrome Store 文案与截图。

---

## 6. 推荐执行顺序

### Sprint 1

- A1 清理调试与风险代码
- A2 统一版本来源
- A3 修正文案与产品承诺

### Sprint 2

- A4 修复 README 对外可信度
- A5 建立最小回归清单
- B1 会话命名策略设计

### Sprint 3

- B2 恢复体验升级
- B3 搜索与找回强化

### Sprint 4

- C1 同步可靠性说明与交互增强
- C2 付费边界与上架文案准备

---

## 7. 现在就可以开始的第一批代码动作

如果立刻进入实现，建议按下面顺序执行：

1. 清理 `src/background/TabManager.ts` 的调试上报和多余 debug 输出。
2. 用运行时版本替换 `src/components/app/MainApp.tsx` 中的硬编码版本。
3. 修正 `src/components/onboarding/OnboardingSteps.tsx` 的同步文案。
4. 重写 `README.md` 的顶部定位、功能描述和联系方式。
5. 增加一份手动回归清单文档。

---

## 8. 决策约束

后续每个变更在开始前都先过这 4 个问题：

1. 这项工作是否提升用户对“保存后不会丢”的信任？
2. 这项工作是否提升“之后能找回”的概率或速度？
3. 这项工作是否提升“跨设备继续工作”的价值？
4. 这项工作是否会制造新的过度承诺？

只要第 4 个问题答案是“会”，先不做。
