# 同步状态指示器使用指南

## 组件说明

`SyncStatusIndicator` 是一个轻量级的同步状态可视化组件，用于显示 `smartSyncService` 的实时同步状态。

## 特性

- ✅ 实时显示同步状态（同步中/待同步/已启用/已禁用）
- ✅ 显示最后同步时间
- ✅ 支持紧凑模式和详细模式
- ✅ 自动适配用户登录状态
- ✅ 定时自动更新（每10秒）
- ✅ 工具提示显示详细信息

## 使用方法

### 1. 紧凑模式（只显示状态点）

```tsx
import { SyncStatusIndicator } from '@/components/sync/SyncStatusIndicator';

// 在组件中使用
<SyncStatusIndicator mode="compact" />;
```

**效果**：

- 🔵 蓝色闪烁点 = 正在同步
- 🟡 黄色点 = 有待同步任务
- 🟢 绿色点 = 自动同步已启用
- ⚪ 灰色点 = 自动同步已禁用

### 2. 详细模式（显示状态文字和时间）

```tsx
import { SyncStatusIndicator } from '@/components/sync/SyncStatusIndicator';

// 在组件中使用
<SyncStatusIndicator mode="detailed" />;
```

**效果**：

- 🔵 同步中...
- 🟡 待同步 (2)
- 🟢 自动同步 · 5分钟前
- ⚪ 已禁用

### 3. 集成到现有组件

#### 方案A：添加到 Header 组件

```tsx
// src/components/layout/Header.tsx

import { SyncStatusIndicator } from '@/components/sync/SyncStatusIndicator';

// 在合适的位置添加：
<div className="flex items-center space-x-2">
  <SyncButton />
  <SyncStatusIndicator mode="compact" />
  {/* 其他按钮 */}
</div>;
```

#### 方案B：添加到 Footer 或状态栏

```tsx
// src/components/layout/Footer.tsx (如果有)

import { SyncStatusIndicator } from '@/components/sync/SyncStatusIndicator';

<footer className="bg-white dark:bg-gray-800 border-t">
  <div className="p-2 flex items-center justify-between">
    <div className="text-xs text-gray-500">TabVault Pro v1.8.0</div>
    <SyncStatusIndicator mode="detailed" />
  </div>
</footer>;
```

#### 方案C：添加到 SyncButton 旁边（推荐）

```tsx
// 直接在 SyncButton 组件后面添加
<div className="flex items-center space-x-1">
  <SyncButton />
  <SyncStatusIndicator mode="compact" showTooltip={true} />
</div>
```

## API 参考

### Props

| 属性          | 类型                      | 默认值      | 说明             |
| ------------- | ------------------------- | ----------- | ---------------- |
| `mode`        | `'compact' \| 'detailed'` | `'compact'` | 显示模式         |
| `showTooltip` | `boolean`                 | `true`      | 是否显示工具提示 |

### 状态颜色说明

| 颜色            | 状态     | 说明                        |
| --------------- | -------- | --------------------------- |
| 🔵 蓝色（闪烁） | 正在同步 | `currentTask` 存在          |
| 🟡 黄色         | 待同步   | `pendingTasks.length > 0`   |
| 🟢 绿色         | 已启用   | `isAutoSyncEnabled = true`  |
| ⚪ 灰色         | 已禁用   | `isAutoSyncEnabled = false` |

## 工具提示内容

悬停时显示：

```
最后同步: 2025-10-09 15:30:45
自动同步: 每5分钟
正在同步...
待同步任务: 2个
```

## 最佳实践

### 1. 推荐使用场景

- ✅ 在 Header 中使用紧凑模式
- ✅ 在 Footer/状态栏中使用详细模式
- ✅ 在设置页面中使用详细模式

### 2. 不推荐使用场景

- ❌ 在弹出菜单中使用（可能会干扰交互）
- ❌ 在列表项中重复使用（性能考虑）

### 3. 性能优化

- 组件已内置定时更新（10秒间隔）
- 未登录时自动隐藏，不占用资源
- 使用 React hooks 管理状态，避免不必要的渲染

## 示例：完整集成到 Header

```tsx
// src/components/layout/Header.tsx

import { SyncStatusIndicator } from '@/components/sync/SyncStatusIndicator';

// 在 SyncButton 后添加状态指示器
<div className="flex items-center space-x-4">
  {/* 现有的其他按钮 */}
  <SimpleThemeToggle />

  {/* 同步按钮和状态指示器 */}
  <div className="flex items-center space-x-1">
    <SyncButton />
    <SyncStatusIndicator mode="compact" />
  </div>

  <button onClick={handleSaveAllTabs}>保存所有标签</button>
</div>;
```

## 注意事项

1. **最小化改动原则**：

   - 该组件是**可选的**，不会影响现有功能
   - 可以随时添加或移除
   - 不依赖任何现有组件的修改

2. **兼容性**：

   - 已自动适配深色模式
   - 已适配移动端（紧凑模式推荐）
   - 已处理登录状态变化

3. **数据源**：
   - 直接使用 `smartSyncService.getSyncStatus()`
   - 不影响同步逻辑，只读取状态
   - 不会增加额外的同步请求

## 未来扩展

可以考虑添加：

- 点击查看同步详情
- 手动触发同步
- 同步历史记录
- 错误提示和重试

---

**创建日期**：2025-10-09  
**文档版本**：1.0.0  
**组件路径**：`src/components/sync/SyncStatusIndicator.tsx`
