# TabStack S2 — UX 与性能打磨（详细 spec）

> **更新日期**：2026-08-05
> **Spec 范围**：Sprint 2 — "启动性能 + 大列表性能 + UI 精致度"
> **父蓝图**：`2026-08-05-tabstack-personal-revamp-blueprint.md`
> **基线版本**：v1.13.6
> **作者**：ZCode（架构 + 设计）+ 户主（产品）

---

## 0. Summary

S2 把"我自己用着明显快 / 明显舒服"作为单一成功标准。三大改动域：

1. **启动性能** —— popup 打开快一倍
2. **大列表性能** —— 50/100/300 会话都不卡
3. **UI 精致度** —— 信息层级 + 减负 + 视觉一致性

不动数据安全的护栏（syncEngine / syncUtils / hydrationDecision / IndexedDB DB 名）。S2 完成后把覆盖率从 ~40% → ~65%。

---

## 1. 哲学

### 三条铁律（继承自蓝图 §3）

1. **保留品牌底色**（teal `#0D9488` + 橙 `#F97316` + Plus Jakarta Sans）——不动。
2. **功能减负而非加码** —— HeaderDropdown / SyncButton / ThemeStyleSelector 三处"过度设计"砍掉。
3. **性能不是装饰而是地基** —— 14 项 perf 问题挑 8 项做，每项都要可感。

### 视觉设计原则（S2 期间所有新/改组件必须遵守）

| 原则 | 含义 |
|---|---|
| **主 CTA 唯一** | 橙色实心按钮全 popup 只能 1 个；不复制到 header / group card |
| **次要 CTA outline** | teal 边框 + 透明底，0 阴影 |
| **危险 CTA 浅色文字** | rose-50 背景 + rose-700 文字，**不**用大色块 |
| **hover 不用 scale** | 列表项 hover = `bg-gray-50 dark:bg-gray-800/50`，无 transform |
| **展开/折叠不用 max-height** | 改 `grid-template-rows: 0fr → 1fr` + opacity |
| **焦点环统一** | 2px teal + 2px offset，所有按钮一致 |
| **prefers-reduced-motion 尊重** | 全局动效在 reduce 模式下退化 |

### 约束

- 不引入 React 19 / Vite 5 / CRXJS v3 升级
- 不引入 Redux 状态库大改
- 不重写 syncEngine / syncUtils / hydrationDecision
- IndexedDB DB 名 = `tabvaultpro` 不动
- 服务端 SW 不重新加同步逻辑
- 不引入 Tailwind 升级（v3.4 保持）
- **只新增 1 个依赖**：`@tanstack/react-virtual` v3.x（事实标准，~7K）
- （S2 实施时）**新增 2 个测试 devDep**：`@testing-library/react` + `jsdom`

---

## 2. 改动范围（动/不动）

### ✅ 必须改（8 项，按 ROI 排序）

| # | 范围 | 改动 | 验收 |
|---|---|---|---|
| 1 | **popup bootstrap** | `initStorage` 单次化；settings 单源；hydration 与 hydration 失败的两种路径分流 | popup 冷启动从 600ms → ≤ 250ms（手动测） |
| 2 | **大列表虚拟化** | TabList + SearchResultList 用 `@tanstack/react-virtual` | 100 会话流畅滚动，无掉帧；30 内启用 |
| 3 | **DnD hover 解耦** | UI 立即 dispatch `moveTabLocal`；persistence 防抖 200ms trailing | 拖拽中无 storage.setGroups 调用；落盘在 hover 停 200ms 后 |
| 4 | **Selector 切片化** | 新建 `store/selectors/tabSelectors.ts`；TabList 用切片选择；`selectFilteredGroups` 复用 | TabList rerender 次数从 O(状态全量) → O(自己关心的字段) |
| 5 | **大组件 lazy** | `HeaderDropdown` / `SyncButton` / `ThemeStyleSelector` / `SearchResultList` 用 `lazy()` + 触发态引入 | popup entry dist 体积减 ≤ 30% |
| 6 | **CSS 减负** | 删除 `drag-drop.css` 重复块；9 个主题 CSS 改 dynamic import（按需加载） | global CSS dist 从 148K → ≤ 80K |
| 7 | **Header 收拢** | 8 个 icon → 4 个（Logo / Save / Search / Kebab）；kebab 进 settings tab | Header 一屏内可见，不溢出 |
| 8 | **同步 UX 降级** | 582 行 SyncButton → SyncStatusRow（status + 单按钮）；预览合并移到 SyncTab 高级区 | sync 错误 feedback 明确 |

### ⏸ 延后（6 项，等 S2 主线完工再考虑）

- `lodash` 替换为手写 throttle（去掉一个全量 import）
- 删死代码（`SyncStatus` / `SyncStatusIndicator` / `SearchBar` / `ThemeToggleButton` / `StatusFeedback` / `refined.css` / `productivity.css`）—— S2 第 5 项顺手做了
- 双 `dispatch(deleteGroup)` 修复（`TabGroup.tsx:166,191`）
- `max-height` transition 替换（`TabGroup.tsx:492-497`）
- 主题 10 → 3（保留 Aurora / Refined / Cyberpunk 三个深耕）
- hover 动效减密度（去掉 group/tab 两层 scale）

### ❌ 不动（清晰边界）

- React 18.2 / Vite 4.5 / CRXJS 2.x / lodash 锁版本
- syncEngine / syncUtils / hydrationDecision 三处
- IndexedDB DB 名 `tabvaultpro`
- Service Worker 不加回同步
- 已有 5 条不变量测试
- 写 chrome-extension.zip 包内权限
- popup 默认 viewport 380–450px

---

## 3. 架构与组件图（改完态）

### 3.1 组件分层

```
src/components/
├── app/
│   ├── AppContainer.tsx           # 删重复 initStorage useEffect
│   ├── MainApp.tsx                # 改 MainApp dispatch(loadSettings)
│   └── AuthProvider.tsx           # 不变
│
├── layout/
│   ├── Header.tsx                 # 重写为精简版（Logo / Save / Search / Kebab）
│   ├── Layout.tsx                 # 不变
│   ├── TabCounter.tsx             # 不变
│   ├── ThemeStyleSelector.tsx     # 简化为 3 选 1（与 SyncTab 拆开）
│   ├── SimpleThemeToggle.tsx      # 不变
│   └── ThemeToggleButton.tsx      # 删除
│
├── settings/                      # 新增目录（lazy full-screen tab）
│   ├── SettingsTabs.tsx           # 6 项垂直菜单 + 子视图容器
│   ├── AccountTab.tsx
│   ├── SyncTab.tsx                # 替代 SyncButton 主体（不含预览合并）
│   ├── AppearanceTab.tsx          # 主题 3 选 1 + 暗/亮/Auto
│   ├── ImportExportTab.tsx
│   ├── NotificationsTab.tsx
│   └── DangerZoneTab.tsx          # 清空 / 退出登录
│
├── tabs/
│   ├── TabList.tsx                # 虚拟化 + memo + 切片 selector
│   ├── TabGroup.tsx               # 保留 memo；操作收为 1 个 kebab + 2 暴露
│   ├── TabPreview.tsx             # 不变
│   └── ReorderView/index.tsx      # 视觉风格与主列表统一（去 divide-y）
│
├── search/
│   ├── SearchResultList.tsx       # 虚拟化 + memo + 复用 selectFilteredGroups
│   ├── SearchBar.tsx              # 删除
│   └── HighlightText.tsx          # 不变
│
├── sync/
│   ├── SyncStatusRow.tsx          # 新（替代 SyncButton 主体）
│   ├── SyncStatus.tsx             # 删除
│   ├── SyncStatusIndicator.tsx    # 删除
│   └── SyncButton.tsx             # 改成 SyncTab 内的"高级"次级操作
│
├── stats/
│   └── StatsPanel.tsx             # 不变（已是 lazy）
│
├── dnd/
│   ├── DraggableTab.tsx           # hover dispatch 解耦
│   ├── DraggableTabGroup.tsx      # 加 React.memo；移除未用 DnD 接线
│   ├── DndProvider.tsx            # 不变
│   └── DndTypes.ts                # 不变
│
└── common/
    ├── ModalFrame / AlertDialog / ConfirmDialog.tsx    # 不变
    ├── Toast.tsx                  # 位置改成 `right-2 top-2`（popup 边界）
    ├── Tooltip.tsx                # aria-describedby 修复
    ├── EmptyState.tsx             # hero-card 降级
    ├── LoadingSpinner.tsx         # 不变
    ├── LoadingOverlay.tsx         # 不变
    └── ErrorBoundary.tsx          # 友好文案 + i18n(zh/en)
```

### 3.2 新文件 vs 删除文件

**新增**：

```
src/hooks/useVirtualizer.ts                   # 封装 @tanstack/react-virtual
src/hooks/useNetworkStatus.ts                 # navigator.onLine + polling
src/components/sync/SyncStatusRow.tsx
src/components/settings/                      # 全目录
src/store/selectors/tabSelectors.ts
src/store/middleware/debouncedPersist.ts     # 200ms 防抖中间件
src/utils/errors.ts                           # 统一错误类（S1 也会用，先在 S2 定型）
src/components/tabs/TabGroupMenu.tsx         # 每组操作的 kebab 菜单
src/components/common/QuickKeyHint.tsx        # 空状态时的小贴士
tests/setup.ts                                # 测试基础设施
tests/fixtures/groups.ts                      # 50/100/200 会话合成
tests/helpers/flushPromises.ts                # React 异步帮助
tests/components/                             # UI 测试目录
```

**删除**：

```
src/components/layout/ThemeToggleButton.tsx
src/components/sync/SyncStatus.tsx
src/components/sync/SyncStatusIndicator.tsx
src/components/search/SearchBar.tsx
src/components/common/StatusFeedback.tsx
src/styles/themes/refined.css
src/styles/themes/productivity.css
src/store/middleware/autoSyncMiddleware.ts    # 拆分为更细的小中间件
```

### 3.3 视觉规范卡（Quick Reference）

| 元素 | 颜色 / 尺寸 | 备注 |
|---|---|---|
| 主 CTA | `bg-cta #F97316` / `text-white` / `rounded-xl` / `px-5 py-2.5` / `font-semibold` | 全 popup 仅 1 个 |
| 次要 | `border border-primary text-primary bg-transparent` / `rounded-xl` | outline |
| 危险 | `bg-rose-50 text-rose-700 border border-rose-200` | 文字为主 |
| 列表项 hover | `bg-gray-50 dark:bg-gray-800/50` | **不**用 scale |
| 卡片 shadow | `shadow-[0_2px_8px_-2px_rgba(0,0,0,0.05)]` → hover `shadow-[0_4px_16px_-4px_rgba(0,0,0,0.08)]` | 单一 shadow scale |
| 焦点环 | `focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2` | 全按钮一致 |
| 圆角 | `rounded-xl` (12px) / `rounded-2xl` (16px) 用于卡片 | 统一 |
| 过渡时长 | 150ms (color) / 200ms (transform/opacity) / 300ms (rare large flip) | 不超过 300 |

---

## 4. 状态层与数据流（关键改动）

### 4.1 Selector 切片化

```ts
// src/store/selectors/tabSelectors.ts（新增）

import { createSelector } from '@reduxjs/toolkit';

export const selectGroups = (s: RootState) => s.tabs.groups;
export const selectIsLoading = (s: RootState) => s.tabs.isLoading;
export const selectLastLoadedAt = (s: RootState) => s.tabs.lastLoadedAt;
export const selectSearchQuery = (s: RootState) => s.tabs.searchQuery;
export const selectLayoutMode = (s: RootState) => s.settings.layoutMode;

export const selectSortedGroups = createSelector(
  [selectGroups, (s: RootState) => s.tabs.searchQuery],
  (groups, _query) => [...groups].sort((l, r) => {
    const fav = !!l.isFavorite !== !!r.isFavorite;
    if (fav) return l.isFavorite ? -1 : 1;
    return new Date(r.createdAt).getTime() - new Date(l.createdAt).getTime();
  })
);
```

**消费者改动**（必做的 4 处）：

- `src/components/tabs/TabList.tsx` — 不再 `state => state.tabs`；改 `selectSortedGroups`
- `src/components/search/SearchResultList.tsx` — 改 `selectGroups + selectSearchQuery` 然后跑 `selectFilteredGroups`
- `src/components/app/MainApp.tsx` — 改 `selectLayoutMode + selectIsLoading`
- `src/components/tabs/TabGroup.tsx` — 已 memo（保留 comparator，复查可比性）

### 4.2 DnD Hover 与 Persist 解耦

```ts
// src/store/slices/tabSlice.ts
export const moveTabLocal = createAction<{ groupId: string; tabId: string; toIndex: number }>(
  'tabs/moveTabLocal'
);

// reducer（pure immer）
function moveTabReducer(state, { payload }) {
  // 改 state.tabs.groups；不写 storage
}

// thunk（用于 storage 持久化，200ms 防抖 trailing）
export const persistGroupsDebounced = createAction(
  'tabs/persistGroupsDebounced' // 中间件层处理
);

// src/components/dnd/DraggableTab.tsx
const handleHover = useCallback(
  throttle(() => {
    dispatch(moveTabLocal(payload));
    dispatch(persistGroupsDebounced());
  }, 100),
  [dispatch, payload]
);
```

```ts
// src/store/middleware/debouncedPersist.ts（新增）
export const debouncedPersistMiddleware: Middleware = (storeApi) => {
  let timer: number | null = null;
  return (next) => (action) => {
    if (action.type !== persistGroupsDebounced.type) return next(action);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      storeApi.dispatch(persistGroupsThunk());
      timer = null;
    }, 200);
    return undefined;
  };
};
```

### 4.3 Bootstrap 单源化

```ts
// src/popup/index.tsx
async function bootstrap() {
  await initStorage();                          // 一次性（不是 useEffect）
  const { groups, settings, lastLoadedAt } = await storage.hydrateAll();
  const tabsPreload = decideTabsHydration({ groups, lastLoadedAt });
  const preloaded = {
    tabs: { ...initialTabState, ...tabsPreload },
    settings,
  };
  const store = createStore(preloaded);
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <Provider store={store}><App /></Provider>
  );
}

// src/storage/index.ts（新增 hydrateAll）
export async function hydrateAll(): Promise<HydrateResult> {
  const groups = await getGroups();
  const settings = await getSettings();
  const lastLoadedAt = await getLastLoadedAt();
  return { groups, settings, lastLoadedAt };
}

// src/storage/storageAdapter.ts:101-119（ensureInitialized）
// 继续做迁移；但只跑一次，后续幂等

// ThemeContext.tsx:34-50（删除 chrome.storage.local.get 重复读）
// 改：通过 useSelector(selectThemeMode) 触发；不再主动 storage 读
```

### 4.4 Sync Status Row 模型

```tsx
// src/components/sync/SyncStatusRow.tsx
export const SyncStatusRow = () => {
  const status = useAppSelector(selectSyncStatus);
  const lastSyncAt = useAppSelector(selectLastSyncAt);
  const error = useAppSelector(selectLastSyncError);

  return (
    <div className="flex items-center gap-2 px-3 py-2 text-sm">
      <StatusDot state={status} /> {/* idle / syncing / error */}
      <span className="text-gray-600 dark:text-gray-400">{caption(status, lastSyncAt, error)}</span>
      <button onClick={() => syncService.syncOnce()} className="ml-auto text-primary">
        立即同步
      </button>
    </div>
  );
};
```

> **保留底层**：syncPreview / validateMergeResult 纯函数不删；UI 简化。

---

## 5. 错误处理与韧性（S2 子集）

> 详细的 5 类错误分层在 S1。本节列 S2 直接相关的：

| 错误 | S2 行动 |
|---|---|
| Storage 读取失败 | `storage.hydrateAll` 错误状态上抛 → ErrorBoundary fallback |
| 加密失败 | S1 负责；S2 不引入 |
| DnD hover 写盘失败 | 防抖 trailing 出错 → 1 个 toast "保存到本地失败" |
| 离线 / 网络变化 | S1 引入 `useNetworkStatus`；S2 用之 |
| 同步失败 | S1 负责；S2 仅在 SyncStatusRow 显示 |

---

## 6. 测试策略

### 6.1 目标

- 覆盖率 ~40% → ~65%（保守估）
- 测试总数 ~297 → ~343
- 已有 5 个不变量测试**必须保持绿**：hydrationDecision / syncMergeSafety / storageLayer / syncEngine / tombstone {Propagation,Gc}

### 6.2 新增测试细分

| 模块 | 新增测试 | 类型 |
|---|---|---|
| `src/store/selectors/tabSelectors.ts` | +6 | 纯函数 |
| `tabSlice.moveTab` reducer | +12 | 纯函数 reducer |
| `src/hooks/useVirtualizer.ts` | +4 | 接近纯函数（mock rect） |
| `src/store/middleware/debouncedPersist.ts` | +5 | mock dispatch + fake timers |
| `src/storage/hydrateAll` | +5 | fake-indexeddb |
| `src/utils/errors.ts` | +6 | 纯函数 |
| **`+38 单元测试（~风险函数）** | | |
| `TabList` 集成烟雾测试 | +3 | render + 1 个交互 |
| `SyncStatusRow` 集成 | +2 | render + 点击触发 |
| `TabGroupMenu` 集成 | +2 | 打开/关闭 + 选项 |
| **`+7 UI 组件测试** | | |

### 6.3 测试基础设施

**新增**：

- `tests/setup.ts` — chrome.runtime.id polyfill + fake-indexeddb + cache 清理模板
- `tests/fixtures/groups.ts` — 50/100/200 个会话合成
- `tests/helpers/flushPromises.ts` — React 异步等待

**改动**：

- 已有的 18 个 `*.test.ts` 文件 header 抽到 `setup.ts`，减少重复
- 不动 `tests/_alias-loader.mjs`（loader 限制）

**新增 devDep（待用户最终确认）**：

- `@testing-library/react` ~v14
- `jsdom` ~v24

### 6.4 验收标准

- `pnpm verify`（validate + test）全绿
- 新代码 ≥ 80% 测试覆盖（纯函数 ≥ 90%）
- 5 个不变量测试无修改保持绿
- 全部测试 ≤ 30s 跑完

### 6.5 CI

- `.github/workflows/ci.yml` 已存在 S2 加一层："pop packaged zip size 门禁 ≤ 200K gzip"
- 加 `pnpm test --no-coverage 2>&1 | tail -5` 输出检查

---

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| `@tanstack/react-virtual` 与 React 18 兼容性 | 已选 v3.x（专门为 R17/18 设计） |
| DnD hover persist 防抖丢数据 | UI 用本地 state 立即同步 → 防抖 trailing 兜底；hover 期间 forceClose 关 popup 不丢 |
| Bootstrap 单源化踩坏 hydrationDecision 流程 | 5 个不变量测试会拦截；重新跑 hydrationDecision.test.ts |
| `@testing-library/react + jsdom` 改变测试基建 | 仅测试环境引入；不影响 production bundle |
| Settings 全屏 Tab 让 popup 边界变复杂 | SettingsTabs 容器宽度严格 ≤ 380px |
| Lazy chunks 增加网络抖动 | popup 是从 chrome-extension:// 加载，无网络 |
| 死代码删除不彻底 | 删除前 grep 确认无 caller；`pnpm validate` 包含 lint |

---

## 8. 实施分阶段（写作计划前置）

下面是 S2 大致的 5 个阶段，每阶段 ≤ 1 天：

| Phase | 内容 | 验证点 |
|---|---|---|
| **P1** | 死代码删除 + Selector 切片化 + bootstrap 单源化 | hydrationDecision 测试绿 |
| **P2** | DnD hover 解耦 + debouncedPersist 中间件 | syncMergeSafety 测试绿 |
| **P3** | 虚拟化（TabList + SearchResultList） | 100 会话流畅滚动 |
| **P4** | 组件懒加载（HeaderDropdown / SyncButton / ThemeStyleSelector / SearchResultList） | popup entry ≤ 280K |
| **P5** | Header 收拢 + Settings 全屏 Tab + 错误 UX + 死代码最终删除 + UI 测试 | 全部测试绿 + popup 启动 ≤ 250ms |

每 Phase 完成 → commit 前 `pnpm verify`。

---

## 9. Out of Scope（后续 sprint 处理）

- 任何 React 19 / Vite 5 / CRXJS v3 升级
- 把 10 个主题做成"marketplace"
- 国际化（i18n）—— S2 仅 ErrorBoundary 中文化
- 多设备 / 商业化架构预设
- 自托管 Supabase 选项

---

## 10. 验收总览（S2 Done Definition）

| 验收项 | 方法 |
|---|---|
| popup 冷启动 ≤ 250ms | 手测 + 后续可加 perf script |
| 100/300 会话流畅滚动 | 手测；PerformanceTest 组件验证 |
| Header 不溢出 380px viewport | 手测 |
| settings 全屏 tab 工作 | 手测 |
| 同步 status row 显示正确 | 手测 + 模拟 5 类错误 |
| `pnpm verify` 全绿 | CI |
| 覆盖率 ≥ 65% | 估算（c8/istanbul 暂不引入） |
| 没有死代码 | grep `import ` 检查未使用 |
| 5 个不变量测试绿 | `pnpm test` |
| Chrome extension zip ≤ 200K gzip | CI 检查 |
| brand identity 不变 | 颜色字体对比 |
| 没有引入未批准的依赖 | `pnpm-lock.yaml` diff 检查 |

---

**本文档为 S2 的唯一实现依据。任何代码改动前必须参考本 spec 的章节定位。改完必须更新对应章节或加 change log。**
