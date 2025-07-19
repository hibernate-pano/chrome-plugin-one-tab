# OneTab Plus - 代码重构指南

## 🎯 重构目标

本次重构旨在：
1. **消除重复代码**：提取公共逻辑，提高代码复用性
2. **统一代码模式**：建立一致的编程模式和最佳实践
3. **提升可维护性**：简化代码结构，降低维护成本
4. **增强类型安全**：完善TypeScript类型定义
5. **优化性能**：减少不必要的重新渲染和计算

## 📊 重复代码分析

### 1. 确认对话框重复模式

**问题**：项目中存在多个相似的确认对话框实现
- `src/components/layout/Header.tsx` - 清理重复标签确认
- 其他组件中的删除确认、保存确认等

**解决方案**：
```typescript
// 使用统一的确认对话框组件
import { useConfirmDialog, ConfirmDialogPresets } from '@/shared/components';

const { showConfirm, confirmDialog } = useConfirmDialog();

// 删除确认
const handleDelete = () => {
  showConfirm({
    ...ConfirmDialogPresets.delete('此标签组'),
    onConfirm: async () => {
      await deleteTabGroup(groupId);
    }
  });
};

// 渲染确认对话框
return (
  <>
    {/* 其他内容 */}
    {confirmDialog}
  </>
);
```

### 2. 错误处理重复模式

**问题**：各组件中存在相似的错误处理逻辑
- 网络错误处理
- 认证错误处理
- 重试逻辑

**解决方案**：
```typescript
// 使用统一的错误处理Hook
import { useErrorHandling } from '@/shared/hooks';

const { handleError, retry, safeExecute, hasError, canRetry } = useErrorHandling({
  context: 'TabGroupManager',
  enableRetry: true,
  maxRetries: 3,
  showToast: true
});

// 安全执行异步操作
const loadTabGroups = async () => {
  const result = await safeExecute(async () => {
    return await tabGroupService.getAll();
  });
  
  if (result) {
    setTabGroups(result);
  }
};
```

### 3. 加载状态重复模式

**问题**：各组件中存在相似的加载状态管理
- 加载指示器
- 进度显示
- 取消操作

**解决方案**：
```typescript
// 使用统一的加载状态组件
import { LoadingState, useLoadingState, LoadingPresets } from '@/shared/components';

const { loading, startLoading, stopLoading, updateProgress } = useLoadingState();

// 包装内容
return (
  <LoadingState
    loading={loading}
    {...LoadingPresets.data}
    overlay
  >
    {/* 实际内容 */}
    <TabGroupList groups={groups} />
  </LoadingState>
);
```

### 4. 状态管理重复模式

**问题**：组件中存在相似的状态管理逻辑
- 分页状态
- 选择状态
- 加载状态

**解决方案**：
```typescript
// 使用通用状态管理器
import { CommonStateManager } from '@/shared/utils';

// 创建分页状态
const paginationState = CommonStateManager.createPaginationState(20);
const [pagination, setPagination] = useState(paginationState);

// 创建选择状态
const selectionState = CommonStateManager.createSelectionState<TabGroup>();
const [selection, setSelection] = useState(selectionState);

// 使用状态管理器的方法
const handleNextPage = () => {
  setPagination(prev => ({
    ...prev,
    page: paginationState.nextPage(prev.page)
  }));
};
```

## 🔧 重构实施计划

### Phase 1: 基础工具重构 ✅

1. **创建代码去重工具集** (`src/shared/utils/codeDeduplication.ts`)
   - 通用异步操作包装器
   - 通用状态管理器
   - 通用验证器和格式化器
   - 通用工具函数

2. **创建通用组件**
   - 确认对话框组件 (`src/shared/components/ConfirmDialog/`)
   - 加载状态组件 (`src/shared/components/LoadingState/`)

3. **创建通用Hook**
   - 错误处理Hook (`src/shared/hooks/useErrorHandling.ts`)

### Phase 2: 组件重构

1. **重构Header组件**
   ```typescript
   // 替换自定义确认对话框
   - 移除内联确认对话框JSX
   + 使用 useConfirmDialog Hook
   + 使用 ConfirmDialogPresets.cleanup
   ```

2. **重构TabGroup相关组件**
   ```typescript
   // 统一错误处理
   - 移除重复的try-catch块
   + 使用 useErrorHandling Hook
   + 使用 safeExecute 包装异步操作
   ```

3. **重构同步相关组件**
   ```typescript
   // 统一加载状态
   - 移除自定义加载指示器
   + 使用 LoadingState 组件
   + 使用 useLoadingState Hook
   ```

### Phase 3: 工具函数重构

1. **合并重复的工具函数**
   ```typescript
   // 节流和防抖函数
   - src/shared/utils/dragPerformance.ts (throttle)
   + src/shared/utils/codeDeduplication.ts (CommonUtils.throttle/debounce)
   
   // 格式化函数
   - 各组件中的时间格式化
   + CommonFormatter.timeAgo
   
   // 验证函数
   - 各组件中的URL验证
   + CommonValidator.url
   ```

2. **统一错误处理模式**
   ```typescript
   // 替换分散的错误处理
   - src/shared/utils/errorHandlers.ts (多个错误处理器)
   + 使用 useErrorHandling Hook 统一处理
   ```

### Phase 4: 类型定义重构

1. **合并重复的类型定义**
   ```typescript
   // 统一配置接口
   interface CommonConfig {
     enabled: boolean;
     timeout: number;
     retries: number;
   }
   
   // 统一状态接口
   interface CommonState<T> {
     data: T | null;
     loading: boolean;
     error: Error | null;
   }
   ```

## 📈 重构效果评估

### 代码量减少
- **确认对话框**：减少 ~200 行重复代码
- **错误处理**：减少 ~150 行重复代码
- **加载状态**：减少 ~100 行重复代码
- **工具函数**：减少 ~80 行重复代码

### 维护性提升
- **统一模式**：所有确认对话框使用相同的API
- **类型安全**：完整的TypeScript类型支持
- **测试覆盖**：公共组件更容易进行单元测试
- **文档完善**：统一的使用文档和示例

### 性能优化
- **组件复用**：减少重复的组件实例化
- **内存优化**：统一的缓存和清理策略
- **渲染优化**：使用React.memo优化重新渲染

## 🛠️ 使用指南

### 1. 确认对话框

```typescript
// 基础用法
import { useConfirmDialog, ConfirmDialogPresets } from '@/shared/components';

const { showConfirm, confirmDialog } = useConfirmDialog();

// 删除确认
const handleDelete = () => {
  showConfirm({
    ...ConfirmDialogPresets.delete('标签组'),
    onConfirm: async () => {
      await deleteItem();
    }
  });
};

// 自定义确认
const handleCustomAction = () => {
  showConfirm({
    title: '自定义操作',
    message: '确定要执行此操作吗？',
    confirmText: '执行',
    confirmButtonClass: 'bg-green-600 hover:bg-green-700 text-white',
    onConfirm: async () => {
      await customAction();
    }
  });
};
```

### 2. 错误处理

```typescript
// 基础用法
import { useErrorHandling } from '@/shared/hooks';

const { 
  handleError, 
  retry, 
  safeExecute, 
  hasError, 
  canRetry,
  clearError 
} = useErrorHandling({
  context: 'MyComponent',
  enableRetry: true,
  maxRetries: 3,
  showToast: true
});

// 安全执行异步操作
const loadData = async () => {
  const result = await safeExecute(async () => {
    return await api.getData();
  });
  
  if (result) {
    setData(result);
  }
};

// 手动处理错误
const handleManualError = (error: Error) => {
  handleError(error, loadData); // 传入重试函数
};
```

### 3. 加载状态

```typescript
// 基础用法
import { LoadingState, useLoadingState, LoadingPresets } from '@/shared/components';

const { loading, startLoading, stopLoading, updateProgress } = useLoadingState();

// 包装组件
return (
  <LoadingState
    loading={loading}
    {...LoadingPresets.data}
    overlay
    cancelable
    onCancel={() => abortOperation()}
  >
    <MyContent />
  </LoadingState>
);

// 进度加载
const uploadFile = async (file: File) => {
  startLoading('文件上传中...');
  
  try {
    await uploadWithProgress(file, (progress) => {
      updateProgress(progress, `上传进度 ${progress}%`);
    });
  } finally {
    stopLoading();
  }
};
```

### 4. 通用工具

```typescript
// 工具函数
import { CommonUtils, CommonFormatter, CommonValidator } from '@/shared/utils';

// 防抖
const debouncedSearch = CommonUtils.debounce(searchFunction, 300);

// 格式化
const timeAgo = CommonFormatter.timeAgo(new Date());
const fileSize = CommonFormatter.fileSize(1024 * 1024);

// 验证
const errors = CommonValidator.combine(url, [
  (value) => CommonValidator.required(value, 'URL'),
  (value) => CommonValidator.url(value, 'URL')
]);
```

## 🔍 最佳实践

### 1. 组件设计原则
- **单一职责**：每个组件只负责一个功能
- **可复用性**：设计时考虑多场景使用
- **可配置性**：提供足够的配置选项
- **类型安全**：完整的TypeScript类型定义

### 2. Hook设计原则
- **状态封装**：将相关状态逻辑封装在一起
- **副作用管理**：正确处理useEffect的依赖和清理
- **性能优化**：使用useCallback和useMemo优化性能
- **错误处理**：内置错误处理和恢复机制

### 3. 工具函数原则
- **纯函数**：无副作用，相同输入产生相同输出
- **类型安全**：完整的类型定义和泛型支持
- **错误处理**：优雅处理边界情况
- **文档完善**：清晰的JSDoc注释

## 📚 参考资源

- [React官方文档 - 组件复用](https://react.dev/learn/reusing-logic-with-custom-hooks)
- [TypeScript官方文档 - 泛型](https://www.typescriptlang.org/docs/handbook/2/generics.html)
- [代码重构 - Martin Fowler](https://refactoring.com/)
- [Clean Code - Robert C. Martin](https://www.amazon.com/Clean-Code-Handbook-Software-Craftsmanship/dp/0132350884)

## 🎯 下一步计划

1. **继续重构现有组件**：逐步替换项目中的重复代码
2. **完善测试覆盖**：为新的公共组件和Hook编写单元测试
3. **性能监控**：使用性能监控工具验证重构效果
4. **文档完善**：编写详细的使用文档和示例
5. **团队培训**：确保团队成员了解新的代码模式和最佳实践
