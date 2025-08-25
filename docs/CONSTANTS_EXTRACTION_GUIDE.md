# OneTab Plus - 常量提取指南

## 🎯 常量提取目标

本指南旨在：
1. **消除魔法数字**：将硬编码的数字提取为有意义的常量
2. **统一字符串管理**：集中管理重复使用的字符串
3. **提高可维护性**：便于统一修改和管理配置值
4. **增强代码可读性**：用有意义的常量名替代硬编码值
5. **减少错误风险**：避免因硬编码值不一致导致的bug

## 📊 常量分类体系

### 1. 应用配置常量 (`src/shared/constants/index.ts`)

```typescript
// 应用基础信息
export const APP_CONFIG = {
  name: 'OneTab Plus',
  version: '1.5.12',
  description: 'A better OneTab extension for Chrome',
  homepage: 'https://github.com/yourusername/onetab-plus',
} as const;

// 时间常量（毫秒）
export const TIME_CONSTANTS = {
  DEBOUNCE_DELAY: 300,
  THROTTLE_DELAY: 1000,
  API_TIMEOUT: 30 * 1000,
  SYNC_INTERVAL_DEFAULT: 10 * 60 * 1000,
} as const;

// 限制常量
export const LIMITS = {
  MAX_GROUPS: 1000,
  MAX_TABS_PER_GROUP: 500,
  MAX_GROUP_NAME_LENGTH: 100,
  MAX_IMPORT_FILE_SIZE: 10 * 1024 * 1024, // 10MB
} as const;
```

### 2. 性能相关常量

```typescript
export const PERFORMANCE = {
  // 渲染性能阈值
  RENDER_WARNING_THRESHOLD: 16, // 60fps
  RENDER_ERROR_THRESHOLD: 33, // 30fps
  SLOW_OPERATION_THRESHOLD: 100,
  
  // 内存使用阈值
  MEMORY_WARNING_THRESHOLD: 70, // 百分比
  MEMORY_CRITICAL_THRESHOLD: 90,
  
  // 虚拟化配置
  VIRTUAL_LIST_OVERSCAN: 5,
  VIRTUAL_LIST_ITEM_HEIGHT: 50,
} as const;
```

### 3. UI相关常量

```typescript
export const UI = {
  // 动画时长
  ANIMATION_FAST: 150,
  ANIMATION_NORMAL: 200,
  ANIMATION_SLOW: 300,
  
  // 延迟时间
  TOOLTIP_DELAY: 500,
  HOVER_DELAY: 100,
  
  // 尺寸
  SIDEBAR_WIDTH: 280,
  HEADER_HEIGHT: 60,
  
  // Z-index层级
  Z_INDEX_DROPDOWN: 1000,
  Z_INDEX_MODAL: 1050,
  Z_INDEX_TOOLTIP: 1100,
} as const;
```

### 4. CSS类名常量 (`src/shared/constants/cssClasses.ts`)

```typescript
// 基础样式类
export const BASE_CLASSES = {
  FLEX: 'flex',
  FLEX_COL: 'flex-col',
  FULL_WIDTH: 'w-full',
  CENTER: 'justify-center items-center',
} as const;

// 交互状态类
export const INTERACTION_CLASSES = {
  HOVER_BG_GRAY: 'hover:bg-gray-100 dark:hover:bg-gray-700',
  FOCUS_RING: 'focus:outline-none focus:ring-2 focus:ring-blue-500',
  DISABLED: 'opacity-50 cursor-not-allowed',
} as const;

// 组件特定类
export const COMPONENT_CLASSES = {
  BUTTON_BASE: 'inline-flex items-center justify-center rounded-md font-medium transition-colors',
  BUTTON_PRIMARY: 'bg-blue-600 text-white hover:bg-blue-700',
  INPUT_BASE: 'flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2',
} as const;
```

### 5. 验证和网络常量

```typescript
export const VALIDATION = {
  URL_PATTERN: /^https?:\/\/.+/,
  EMAIL_PATTERN: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  MIN_PASSWORD_LENGTH: 8,
  MAX_PASSWORD_LENGTH: 128,
} as const;

export const NETWORK = {
  STATUS_OK: 200,
  STATUS_UNAUTHORIZED: 401,
  STATUS_NOT_FOUND: 404,
  DEFAULT_TIMEOUT: 30000,
  MAX_RETRIES: 3,
} as const;
```

## 🔧 常量提取原则

### 1. 什么时候提取常量

✅ **应该提取的情况**：
- 数字在多个地方使用
- 字符串在多个地方重复
- 配置值可能需要调整
- 魔法数字含义不明确
- 阈值和限制值

❌ **不需要提取的情况**：
- 只使用一次的值
- 显而易见的值（如0、1、true、false）
- 局部计算的临时值
- 与业务逻辑紧密耦合的值

### 2. 常量命名规范

```typescript
// ✅ 好的命名
export const MAX_RETRY_ATTEMPTS = 3;
export const API_TIMEOUT_MS = 30000;
export const DEBOUNCE_DELAY = 300;

// ❌ 不好的命名
export const MAX = 3;
export const TIMEOUT = 30000;
export const DELAY = 300;
```

### 3. 常量组织结构

```typescript
// ✅ 按功能分组
export const SYNC = {
  STRATEGIES: ['newest', 'local', 'remote'] as const,
  DEFAULT_STRATEGY: 'newest' as const,
  DEFAULT_INTERVAL: 10,
  MAX_CONFLICTS: 100,
} as const;

// ❌ 平铺所有常量
export const SYNC_STRATEGIES = ['newest', 'local', 'remote'];
export const SYNC_DEFAULT_STRATEGY = 'newest';
export const SYNC_DEFAULT_INTERVAL = 10;
export const SYNC_MAX_CONFLICTS = 100;
```

## 🛠️ 实际应用示例

### 1. 替换硬编码的超时时间

❌ **重构前**：
```typescript
// 在多个文件中重复
const response = await fetch(url, { timeout: 30000 });
setTimeout(callback, 5000);
setInterval(syncData, 600000);
```

✅ **重构后**：
```typescript
import { TIME_CONSTANTS } from '@/shared/constants';

const response = await fetch(url, { timeout: TIME_CONSTANTS.API_TIMEOUT });
setTimeout(callback, TIME_CONSTANTS.NOTIFICATION_DURATION);
setInterval(syncData, TIME_CONSTANTS.SYNC_INTERVAL_DEFAULT);
```

### 2. 替换硬编码的CSS类名

❌ **重构前**：
```typescript
// 在多个组件中重复
<button className="inline-flex items-center justify-center rounded-md font-medium bg-blue-600 text-white hover:bg-blue-700">
  确认
</button>
```

✅ **重构后**：
```typescript
import { getButtonClass } from '@/shared/constants/cssClasses';

<button className={getButtonClass('primary')}>
  确认
</button>
```

### 3. 替换硬编码的验证规则

❌ **重构前**：
```typescript
// 在多个地方重复
if (password.length < 8) {
  return '密码长度至少8位';
}

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  return '邮箱格式不正确';
}
```

✅ **重构后**：
```typescript
import { VALIDATION } from '@/shared/constants';

if (password.length < VALIDATION.MIN_PASSWORD_LENGTH) {
  return `密码长度至少${VALIDATION.MIN_PASSWORD_LENGTH}位`;
}

if (!VALIDATION.EMAIL_PATTERN.test(email)) {
  return '邮箱格式不正确';
}
```

### 4. 替换硬编码的性能阈值

❌ **重构前**：
```typescript
// 在性能监控代码中
if (renderTime > 16) {
  console.warn('渲染时间过长');
}

if (memoryUsage > 70) {
  triggerCleanup();
}
```

✅ **重构后**：
```typescript
import { PERFORMANCE } from '@/shared/constants';

if (renderTime > PERFORMANCE.RENDER_WARNING_THRESHOLD) {
  console.warn('渲染时间过长');
}

if (memoryUsage > PERFORMANCE.MEMORY_WARNING_THRESHOLD) {
  triggerCleanup();
}
```

## 📈 常量提取收益

### 1. 维护性提升
- **集中管理**：所有配置值在一个地方管理
- **统一修改**：修改一个地方即可影响全局
- **版本控制**：配置变更有明确的历史记录

### 2. 代码质量提升
- **可读性**：有意义的常量名提高代码可读性
- **一致性**：避免同一值在不同地方不一致
- **类型安全**：使用`as const`确保类型安全

### 3. 开发效率提升
- **IDE支持**：自动补全和重构支持
- **错误减少**：减少因硬编码值错误导致的bug
- **团队协作**：团队成员更容易理解和修改代码

## 🔍 常量提取检查清单

### 代码审查时检查
- [ ] 是否有重复的数字或字符串
- [ ] 魔法数字是否有明确含义
- [ ] 配置值是否可能需要调整
- [ ] 阈值和限制是否已提取为常量
- [ ] CSS类名是否重复使用

### 重构时检查
- [ ] 常量命名是否清晰明确
- [ ] 常量分组是否合理
- [ ] 是否使用了`as const`确保类型安全
- [ ] 是否有相关的类型定义
- [ ] 文档是否已更新

## 🎯 下一步计划

### 1. 逐步迁移现有代码
- 识别项目中的硬编码值
- 按优先级逐步提取常量
- 更新相关的使用代码

### 2. 建立常量管理流程
- 代码审查时检查硬编码值
- 新功能开发时优先使用常量
- 定期审查和整理常量定义

### 3. 工具和自动化
- 使用ESLint规则检查魔法数字
- 自动化常量提取工具
- 常量使用情况分析

### 4. 团队培训
- 常量提取最佳实践培训
- 代码审查标准建立
- 工具使用指南

## 📚 参考资源

- [Clean Code - Robert C. Martin](https://www.amazon.com/Clean-Code-Handbook-Software-Craftsmanship/dp/0132350884)
- [Refactoring - Martin Fowler](https://refactoring.com/)
- [TypeScript Const Assertions](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-4.html#const-assertions)
- [ESLint no-magic-numbers](https://eslint.org/docs/rules/no-magic-numbers)
