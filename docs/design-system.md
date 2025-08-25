# OneTab Plus 设计系统

## 概述

本文档定义了 OneTab Plus 的统一设计系统，包括视觉设计、交互模式、组件规范等，确保整个应用的一致性和可用性。

## 设计原则

### 1. 一致性 (Consistency)
- 相同的操作在不同场景下应有相同的表现
- 统一的视觉语言和交互模式
- 保持与用户期望的一致性

### 2. 简洁性 (Simplicity)
- 界面简洁明了，避免不必要的复杂性
- 突出核心功能，隐藏次要操作
- 使用清晰的视觉层次

### 3. 可访问性 (Accessibility)
- 支持键盘导航和屏幕阅读器
- 确保足够的颜色对比度
- 提供多种交互方式

### 4. 响应性 (Responsiveness)
- 适配不同屏幕尺寸
- 快速响应用户操作
- 提供即时反馈

## 颜色系统

### 主色调 (Primary Colors)
```css
--primary-50: #eff6ff;
--primary-100: #dbeafe;
--primary-200: #bfdbfe;
--primary-300: #93c5fd;
--primary-400: #60a5fa;
--primary-500: #3b82f6;  /* 主色 */
--primary-600: #2563eb;
--primary-700: #1d4ed8;
--primary-800: #1e40af;
--primary-900: #1e3a8a;
```

### 语义色彩 (Semantic Colors)
```css
/* 成功 */
--success-500: #10b981;
--success-600: #059669;

/* 警告 */
--warning-500: #f59e0b;
--warning-600: #d97706;

/* 错误 */
--error-500: #ef4444;
--error-600: #dc2626;

/* 信息 */
--info-500: #6366f1;
--info-600: #4f46e5;
```

### 中性色彩 (Neutral Colors)
```css
--gray-50: #f9fafb;
--gray-100: #f3f4f6;
--gray-200: #e5e7eb;
--gray-300: #d1d5db;
--gray-400: #9ca3af;
--gray-500: #6b7280;
--gray-600: #4b5563;
--gray-700: #374151;
--gray-800: #1f2937;
--gray-900: #111827;
```

## 字体系统

### 字体族 (Font Family)
```css
--font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
--font-mono: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
```

### 字体大小 (Font Sizes)
```css
--text-xs: 0.75rem;    /* 12px */
--text-sm: 0.875rem;   /* 14px */
--text-base: 1rem;     /* 16px */
--text-lg: 1.125rem;   /* 18px */
--text-xl: 1.25rem;    /* 20px */
--text-2xl: 1.5rem;    /* 24px */
--text-3xl: 1.875rem;  /* 30px */
```

### 字重 (Font Weights)
```css
--font-normal: 400;
--font-medium: 500;
--font-semibold: 600;
--font-bold: 700;
```

## 间距系统

### 基础间距 (Base Spacing)
```css
--space-1: 0.25rem;   /* 4px */
--space-2: 0.5rem;    /* 8px */
--space-3: 0.75rem;   /* 12px */
--space-4: 1rem;      /* 16px */
--space-5: 1.25rem;   /* 20px */
--space-6: 1.5rem;    /* 24px */
--space-8: 2rem;      /* 32px */
--space-10: 2.5rem;   /* 40px */
--space-12: 3rem;     /* 48px */
--space-16: 4rem;     /* 64px */
```

### 组件间距规范
- **卡片内边距**: 16px (space-4)
- **按钮内边距**: 8px 16px (space-2 space-4)
- **列表项间距**: 8px (space-2)
- **组件间距**: 16px (space-4)
- **页面边距**: 24px (space-6)

## 圆角系统

```css
--radius-sm: 0.25rem;   /* 4px */
--radius-md: 0.375rem;  /* 6px */
--radius-lg: 0.5rem;    /* 8px */
--radius-xl: 0.75rem;   /* 12px */
--radius-2xl: 1rem;     /* 16px */
--radius-full: 9999px;  /* 完全圆角 */
```

## 阴影系统

```css
--shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
--shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
--shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
--shadow-xl: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1);
```

## 动画系统

### 缓动函数 (Easing Functions)
```css
--ease-in: cubic-bezier(0.4, 0, 1, 1);
--ease-out: cubic-bezier(0, 0, 0.2, 1);
--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
--ease-bounce: cubic-bezier(0.68, -0.55, 0.265, 1.55);
```

### 动画时长 (Duration)
```css
--duration-fast: 150ms;
--duration-normal: 300ms;
--duration-slow: 500ms;
```

### 常用动画
- **淡入淡出**: opacity + transform
- **滑动**: transform: translateX/Y
- **缩放**: transform: scale
- **弹性**: ease-bounce

## 交互状态

### 按钮状态
1. **默认状态**: 基础样式
2. **悬停状态**: 颜色加深，添加阴影
3. **激活状态**: 颜色更深，阴影减少
4. **禁用状态**: 降低透明度，禁用交互
5. **加载状态**: 显示加载动画，禁用交互

### 输入框状态
1. **默认状态**: 边框为中性色
2. **聚焦状态**: 边框为主色，添加外发光
3. **错误状态**: 边框为错误色，显示错误信息
4. **禁用状态**: 背景变灰，禁用交互

### 卡片状态
1. **默认状态**: 基础阴影
2. **悬停状态**: 阴影加深，轻微上移
3. **选中状态**: 边框为主色，背景高亮
4. **拖拽状态**: 增加阴影，降低透明度

## 组件规范

### 按钮 (Button)
```typescript
interface ButtonProps {
  variant: 'primary' | 'secondary' | 'danger' | 'ghost';
  size: 'sm' | 'md' | 'lg';
  loading?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
  children: ReactNode;
}
```

**尺寸规范**:
- Small: 32px 高度，12px 内边距
- Medium: 40px 高度，16px 内边距
- Large: 48px 高度，20px 内边距

### 输入框 (Input)
```typescript
interface InputProps {
  size: 'sm' | 'md' | 'lg';
  state: 'default' | 'error' | 'success';
  disabled?: boolean;
  placeholder?: string;
  icon?: ReactNode;
}
```

### 卡片 (Card)
```typescript
interface CardProps {
  variant: 'default' | 'outlined' | 'elevated';
  padding: 'sm' | 'md' | 'lg';
  hoverable?: boolean;
  children: ReactNode;
}
```

## 响应式设计

### 断点 (Breakpoints)
```css
--breakpoint-sm: 640px;
--breakpoint-md: 768px;
--breakpoint-lg: 1024px;
--breakpoint-xl: 1280px;
--breakpoint-2xl: 1536px;
```

### 网格系统
- 使用 CSS Grid 和 Flexbox
- 移动优先的响应式设计
- 最小触摸目标: 44px × 44px

## 可访问性规范

### 颜色对比
- 正常文本: 最小对比度 4.5:1
- 大文本: 最小对比度 3:1
- 非文本元素: 最小对比度 3:1

### 键盘导航
- 所有交互元素支持键盘访问
- 清晰的焦点指示器
- 逻辑的Tab顺序

### ARIA标签
- 为复杂组件提供适当的ARIA标签
- 使用语义化HTML元素
- 提供屏幕阅读器友好的文本

## 图标系统

### 图标规范
- 使用 24px × 24px 的图标网格
- 2px 的描边宽度
- 圆角端点
- 统一的视觉风格

### 图标使用原则
- 每个图标都应有明确的含义
- 保持图标与文本的一致性
- 为图标提供替代文本

## 深色模式

### 颜色适配
- 使用CSS变量实现主题切换
- 确保深色模式下的对比度
- 适配所有组件和状态

### 实现方式
```css
:root {
  --bg-primary: #ffffff;
  --text-primary: #111827;
}

[data-theme="dark"] {
  --bg-primary: #111827;
  --text-primary: #f9fafb;
}
```

## 性能考虑

### 动画性能
- 优先使用 transform 和 opacity
- 避免触发重排和重绘
- 使用 will-change 优化动画

### 图片优化
- 使用适当的图片格式
- 提供多种分辨率
- 实现懒加载

## 实施指南

### 开发流程
1. 设计师提供设计稿
2. 开发者按照设计系统实现
3. 代码审查确保规范遵循
4. 测试验证交互和可访问性

### 工具推荐
- **设计工具**: Figma
- **开发工具**: Storybook
- **测试工具**: axe-core
- **文档工具**: Docusaurus

## 维护和更新

### 版本控制
- 设计系统采用语义化版本
- 重大变更需要迁移指南
- 定期审查和更新规范

### 反馈机制
- 收集开发者和用户反馈
- 定期评估设计系统效果
- 持续优化和改进
