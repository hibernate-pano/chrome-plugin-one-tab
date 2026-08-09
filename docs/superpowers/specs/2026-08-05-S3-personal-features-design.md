# TabStack S3 — 个人实用新功能（详细 spec）

> **更新日期**：2026-08-05
> **Spec 范围**：Sprint 3 — 4 个针对"我自己"的高价值小功能
> **父蓝图**：`2026-08-05-tabstack-personal-revamp-blueprint.md`
> **基线版本**：v1.14.0（S1 落地后，320 tests）
> **状态**：✅ 详细 spec — 待 plan

---

## 0. Summary

S3 基于审计建议（Post-S2 audit）选 4 个功能，全部服务于个人使用场景：**快速找回 + 少点一步 + 少恐惧**。

1. **Hover-to-preview** — 悬停会话卡显示 tab 预览（复活已存在的 TabPreview 组件）
2. **暗色 Auto 模式** — `prefers-color-scheme` 真正可用
3. **Favorites row** — 收藏会话置顶独立区（让 isFavorite 标志真正有用）
4. **Undo delete** — 软删 + 10s 撤销 toast（消除删除恐惧）

---

## 1. 功能 1：Hover-to-preview

### 1.1 目的

用户在列表中扫会话时，悬停即可预览内容（favicon 网格 + 标题），不用点开。

### 1.2 设计

- `src/components/tabs/TabPreview.tsx` 已在 F3 被删（S2 时是死代码）——**重建**（不是从 git 恢复——重写为新设计）。
- 交互：悬停 `TabGroup` 标题区域（`onMouseEnter`/`onMouseLeave`）→ 显示浮层。延迟 250ms（防误触），浮层跟随卡片位置（绝对定位在卡片内右下或右侧）。
- 内容：前 8 个 tab 的 favicon + 截断标题（两列网格）。超 8 个显示 "+N 更多"。
- 触摸设备：popup 无触摸主要场景，hover-only 即可。
- 视觉：`rounded-xl shadow-lg bg-white dark:bg-gray-800 border p-3 w-64 z-20`，符合 S2 视觉规范。
- 键盘可达性：focus 到卡片时也显示（`group-focus-within`），Esc 关闭。
- **无障碍**：浮层带 `role="tooltip"`？不——内容较多，用 `role="region"` + `aria-label="会话预览"` 更合适。

### 1.3 实现位置

- 新 `src/components/tabs/TabHoverPreview.tsx`（TabPreview 重名冲突已删，直接用 TabPreview 名）
- 挂在 `TabGroup.tsx` 的卡片容器内（position relative）

### 1.4 测试

- `tests/components/TabPreview.smoke.test.tsx`（jsdom，2 tests）：hover 触发渲染前 8 个 favicon；无 tab 时 null。

---

## 2. 功能 2：暗色 Auto 模式

### 2.1 目的

`prefers-color-scheme` 系统跟随当前不可用（S2 审计发现 `ThemeToggleButton` 删除后 Auto 模式不可达；`SimpleThemeToggle` 也删了——检查当前 AppearanceTab 的实现）。

### 2.2 设计

- `src/types/tab.ts` 的 `themeMode` 已支持 `'light' | 'dark' | 'auto'`（验证——S2 前有；检查是否被类型收窄）。
- `AppearanceTab.tsx` 模式选择器已有 Light/Dark/Auto 三档（S2 迁移时保留）——验证它是否真正工作。
- `src/contexts/ThemeContext.tsx`：`themeMode === 'auto'` 时监听 `window.matchMedia('(prefers-color-scheme: dark)')` 变化 → 应用 `.dark` class；系统切换时实时跟随。
- 用 `useEffect` + matchMedia listener，cleanup 移除。

### 2.3 测试

- `tests/themeMode.test.ts`（jsdom，3 tests）：auto + 系统 dark → html.dark 存在；auto + 系统 light → 无 dark；切换系统 → class 更新。
- 可能需要把"根据 mode+system 决定 dark 与否"抽成纯函数 `resolveThemeMode(mode, systemDark): boolean` 放 `src/utils/themeUtils.ts` 以便测试。

---

## 3. 功能 3：Favorites row（收藏置顶）

### 3.1 目的

`isFavorite` 标志目前只是排序第一（`selectSortedGroups` 里 favorite 先排），但视觉上没有独立区域。用户找不到"我收藏的会话"。

### 3.2 设计

- `TabList.tsx`：在虚拟化列表**上方**渲染一个"⭐ 收藏"独立区（仅当有 favorite 且非搜索模式）：
  - 横向滚动条（`overflow-x-auto`）或 2 列网格，卡片精简版（标题 + count + favicon 第一个 tab）
  - 点击卡片 → 正常打开该组（复用 TabGroup 的 restore 逻辑——抽一个小组件 `FavoriteStrip.tsx`）
  - 主列表仍然包含 favorite 组（不重复移除——保持 selectSortedGroups 不变，避免破坏排序逻辑）
- 或者更简单（推荐）：主列表顶部用分隔标题"收藏"然后列出 favorite 组，再是"最近"。这需要改 selectSortedGroups 的分组输出。**推荐方案**：`selectSortedGroups` 保持排序，新增 `selectFavoriteGroups`（createSelector，只挑 favorite）→ TabList 渲染两个 section。
- 虚拟化注意：favorite 区独立于 virtualizer（favorites 数量少，全渲染 OK）。

### 3.3 实现位置

- `src/store/selectors/tabSelectors.ts` — 加 `selectFavoriteGroups`
- `src/components/tabs/FavoriteStrip.tsx` — 新组件
- `TabList.tsx` — 渲染 `{favorites.length > 0 && !searchQuery && <FavoriteStrip groups={favorites} />}`

### 3.4 测试

- `tests/tabSelectors.test.ts` +2：selectFavoriteGroups 只含 favorite；空时 []。
- `tests/components/FavoriteStrip.smoke.test.tsx`（jsdom，2 tests）：渲染 favorite 卡；无 favorite 时 null。

---

## 4. 功能 4：Undo delete（软删 + 撤销）

### 4.1 目的

删除会话目前硬确认 + 不可逆。数据模型已有 `isDeleted`（tombstone 用于同步）——本地 UI 删除可做"软删 + 10 秒撤销"。

### 4.2 设计

- **改动最小方案**（推荐，不动 tombstone 同步语义）：
  - 删除按钮点击后：不立即 `deleteGroup`，而是 dispatch 新 action `requestGroupDelete(groupId)` → 存到 `uiSlice`（或 tabSlice 加 `pendingDelete: { groupId, timer }` 局部状态——**推荐用组件局部状态 + Redux 不变**）
  - 组件：`TabGroup` 内 `handleDelete` 改为：
    1. 显示 toast "会话已删除 · 撤销"（10s）
    2. toast 点撤销 → 取消（什么也不做）
    3. toast 超时 → `dispatch(deleteGroup(id))`（真正删除）
  - toast 需要可交互按钮——检查 `ToastContext` 的 API 是否支持 action button；不支持则扩展 `showToast` 支持 `action: { label, onClick }`。
- **不动** `deleteAllGroups`（DangerZone 仍硬确认）——批量删除保持强确认。
- tombstone 同步：撤销窗口内（10s）不触发同步（`deleteGroup` thunk 尚未跑），所以无跨设备影响。超时后正常走 tombstone 路径。

### 4.3 实现位置

- `src/contexts/ToastContext.tsx` — 扩展 toast 支持 action
- `src/components/tabs/TabGroup.tsx` — handleDelete 改为延迟删除 + 撤销
- `src/components/search/SearchResultList.tsx` — 同样模式（如果它也有删除按钮——检查；有则同样处理）

### 4.4 测试

- `tests/components/ToastContext.smoke.test.tsx`（jsdom，2 tests）：action toast 渲染按钮；点击触发 action 且 toast 消失。
- TabGroup 延迟删除逻辑抽成 hook `useDeferredDelete(onCommit)` → `tests/useDeferredDelete.test.ts`（3 tests：10s 后 commit；撤销取消；重复调用重置 timer）。**抽 hook 是为了可测**——Reducer 里不放 timer。

---

## 5. 文件清单

**新增**：
- `src/components/tabs/TabPreview.tsx`（重建，hover preview）
- `src/components/tabs/FavoriteStrip.tsx`
- `src/utils/themeUtils.ts`（resolveThemeMode 纯函数）
- `src/hooks/useDeferredDelete.ts`
- `tests/components/TabPreview.smoke.test.tsx`
- `tests/components/FavoriteStrip.smoke.test.tsx`
- `tests/themeMode.test.ts`
- `tests/useDeferredDelete.test.ts`
- `tests/components/ToastContext.smoke.test.tsx`

**修改**：
- `src/components/tabs/TabGroup.tsx` — hover preview 挂载 + handleDelete 延迟
- `src/components/search/SearchResultList.tsx` — 删除同模式（如有）
- `src/contexts/ToastContext.tsx` — action 支持
- `src/contexts/ThemeContext.tsx` — auto 模式 matchMedia
- `src/store/selectors/tabSelectors.ts` — selectFavoriteGroups
- `src/components/tabs/TabList.tsx` — FavoriteStrip 渲染

---

## 6. 测试预期

- 新增 ~14 tests（TabPreview 2 / FavoriteStrip 2 + selector 2 / themeMode 3 / useDeferredDelete 3 / ToastContext 2）
- 基线 320 → **~334**

---

## 7. 验收标准（Done Definition）

| # | 验收 | 方法 |
|---|---|---|
| 1 | 悬停会话卡显示 tab 预览（前 8 + +N） | 手动 + smoke test |
| 2 | Auto 暗色跟随系统实时切换 | 手动切换系统外观 + themeMode.test |
| 3 | 收藏区在列表顶部（非搜索模式） | 手动 + smoke test |
| 4 | 删除会话 → 撤销 toast 10s → 超时真正删除 | 手动 + useDeferredDelete.test |
| 5 | `pnpm verify` 全绿 ~334 | CI |
| 6 | 5 个不变量测试保持绿 | 显式跑 |
| 7 | 无新依赖 | package.json diff |

---

## 8. Out of Scope

- 跨设备撤销（同步层 tombstone 已是最终方案）
- Session merge（DnD group 合并）——复杂度高，留待后续
- Last-restored marker（lastAccessed 展示）——低成本，如果 S3 时间富余可加
- 工作流模板 / 跨设备待读清单
