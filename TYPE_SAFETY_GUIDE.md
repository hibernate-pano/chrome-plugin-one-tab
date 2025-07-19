# OneTab Plus - 类型安全指南

## 🎯 类型安全目标

本指南旨在：
1. **消除any类型**：用具体的类型定义替换any类型
2. **完善接口定义**：为所有数据结构提供完整的类型定义
3. **增强类型推导**：利用TypeScript的类型推导能力
4. **提供工具类型**：创建可复用的工具类型
5. **确保类型一致性**：在整个项目中保持类型定义的一致性

## 📊 类型定义架构

### 1. 基础类型层 (`src/shared/types/common.ts`)

提供项目中最基础的类型定义：

```typescript
// 基础实体接口
export interface BaseEntity {
  readonly id: string;
  readonly createdAt: string;
  updatedAt: string;
}

// 异步操作状态
export interface AsyncState<T = any> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  lastUpdated: string | null;
}

// 分页查询结果
export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}
```

### 2. 工具类型层

提供高级的TypeScript工具类型：

```typescript
// 深度只读类型
export type DeepReadonly<T> = {
  readonly [P in keyof T]: T[P] extends object ? DeepReadonly<T[P]> : T[P];
};

// 深度可选类型
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

// 键路径类型
export type KeyPath<T> = {
  [K in keyof T]: T[K] extends object
    ? K | `${K & string}.${KeyPath<T[K]> & string}`
    : K;
}[keyof T];

// 根据键路径获取值类型
export type GetByPath<T, P extends string> = P extends `${infer K}.${infer Rest}`
  ? K extends keyof T
    ? GetByPath<T[K], Rest>
    : never
  : P extends keyof T
  ? T[P]
  : never;
```

### 3. 事件系统类型 (`src/shared/types/events.ts`)

类型安全的事件系统：

```typescript
// 事件映射接口
export interface EventMap {
  'tab:created': { tab: Tab; groupId?: string };
  'tab:updated': { tab: Tab; changes: Record<string, any> };
  'group:created': { group: TabGroup };
  // ... 更多事件定义
}

// 类型安全的事件接口
export interface TypedEvent<K extends keyof EventMap> extends BaseEvent {
  type: K;
  data: EventMap[K];
}

// 事件监听器类型
export type EventListener<K extends keyof EventMap> = (event: TypedEvent<K>) => void | Promise<void>;
```

### 4. API类型层 (`src/shared/types/api.ts`)

类型安全的API客户端：

```typescript
// API类型映射
export interface ApiTypeMap {
  'GET /tab-groups': {
    request: PaginationParams & { search?: string };
    response: PaginatedResult<TabGroup>;
  };
  'POST /tab-groups': {
    request: { name: string; tabs?: Tab[] };
    response: TabGroup;
  };
  // ... 更多API定义
}

// 类型安全的API客户端
export interface TypedApiClient {
  request<K extends keyof ApiTypeMap>(
    endpoint: K,
    data: ApiTypeMap[K]['request']
  ): Promise<ApiResponse<ApiTypeMap[K]['response']>>;
}
```

## 🔧 类型安全最佳实践

### 1. 避免使用any类型

❌ **错误示例**：
```typescript
function processData(data: any): any {
  return data.map((item: any) => item.value);
}
```

✅ **正确示例**：
```typescript
interface DataItem {
  value: string;
  id: string;
}

function processData<T extends DataItem>(data: T[]): string[] {
  return data.map(item => item.value);
}
```

### 2. 使用联合类型和字面量类型

❌ **错误示例**：
```typescript
interface Config {
  mode: string; // 太宽泛
  status: string; // 太宽泛
}
```

✅ **正确示例**：
```typescript
interface Config {
  mode: 'development' | 'production' | 'test';
  status: 'idle' | 'loading' | 'success' | 'error';
}
```

### 3. 使用泛型提高复用性

❌ **错误示例**：
```typescript
interface TabResponse {
  data: Tab[];
  total: number;
}

interface GroupResponse {
  data: TabGroup[];
  total: number;
}
```

✅ **正确示例**：
```typescript
interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

type TabResponse = PaginatedResponse<Tab>;
type GroupResponse = PaginatedResponse<TabGroup>;
```

### 4. 使用映射类型

❌ **错误示例**：
```typescript
interface CreateTabRequest {
  url: string;
  title: string;
  groupId?: string;
}

interface UpdateTabRequest {
  url?: string;
  title?: string;
  groupId?: string;
}
```

✅ **正确示例**：
```typescript
interface TabData {
  url: string;
  title: string;
  groupId?: string;
}

type CreateTabRequest = TabData;
type UpdateTabRequest = Partial<TabData>;
```

### 5. 使用条件类型

```typescript
// 根据条件选择不同的类型
type ApiResponse<T, E = Error> = {
  success: true;
  data: T;
} | {
  success: false;
  error: E;
};

// 提取Promise的返回类型
type PromiseType<T> = T extends Promise<infer U> ? U : T;

// 函数参数类型
type FunctionArgs<T> = T extends (...args: infer A) => any ? A : never;
```

## 🛠️ 实际应用示例

### 1. 组件Props类型定义

```typescript
// 基础组件Props
interface BaseComponentProps {
  className?: string;
  children?: React.ReactNode;
}

// 标签组件Props
interface TabComponentProps extends BaseComponentProps {
  tab: Tab;
  isSelected?: boolean;
  onSelect?: (tab: Tab) => void;
  onEdit?: (tab: Tab) => void;
  onDelete?: (tabId: string) => void;
}

// 使用泛型的列表组件Props
interface ListComponentProps<T> extends BaseComponentProps {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  onItemClick?: (item: T) => void;
  keyExtractor?: (item: T) => string;
}
```

### 2. Hook类型定义

```typescript
// 异步操作Hook的返回类型
interface UseAsyncReturn<T, E = Error> {
  data: T | null;
  loading: boolean;
  error: E | null;
  execute: (...args: any[]) => Promise<void>;
  reset: () => void;
}

// 使用示例
function useAsync<T, E = Error>(
  asyncFunction: (...args: any[]) => Promise<T>
): UseAsyncReturn<T, E> {
  // 实现...
}
```

### 3. 状态管理类型定义

```typescript
// Redux状态类型
interface RootState {
  tabs: TabsState;
  groups: GroupsState;
  sync: SyncState;
  ui: UIState;
}

// Action类型
interface Action<T = any> {
  type: string;
  payload?: T;
}

// Action Creator类型
type ActionCreator<T = any> = (...args: any[]) => Action<T>;

// Reducer类型
type Reducer<S, A extends Action = Action> = (state: S, action: A) => S;
```

### 4. 服务类型定义

```typescript
// 服务接口
interface TabService {
  getAll(params?: PaginationParams): Promise<PaginatedResult<Tab>>;
  getById(id: string): Promise<Tab>;
  create(data: CreateTabRequest): Promise<Tab>;
  update(id: string, data: UpdateTabRequest): Promise<Tab>;
  delete(id: string): Promise<void>;
}

// 实现类型安全的服务
class TabServiceImpl implements TabService {
  async getAll(params?: PaginationParams): Promise<PaginatedResult<Tab>> {
    // 实现...
  }
  
  // 其他方法实现...
}
```

## 🔍 类型检查工具

### 1. 类型守卫

```typescript
// 类型守卫函数
function isTab(obj: any): obj is Tab {
  return obj && 
         typeof obj.id === 'string' &&
         typeof obj.url === 'string' &&
         typeof obj.title === 'string';
}

// 使用类型守卫
function processItem(item: unknown) {
  if (isTab(item)) {
    // 这里TypeScript知道item是Tab类型
    console.log(item.url);
  }
}
```

### 2. 断言函数

```typescript
// 断言函数
function assertIsTab(obj: any): asserts obj is Tab {
  if (!isTab(obj)) {
    throw new Error('Object is not a Tab');
  }
}

// 使用断言函数
function processTab(item: unknown) {
  assertIsTab(item);
  // 这里TypeScript知道item是Tab类型
  console.log(item.url);
}
```

### 3. 类型验证

```typescript
// 运行时类型验证
import { z } from 'zod';

const TabSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  title: z.string(),
  groupId: z.string().optional(),
  createdAt: z.string().datetime()
});

type Tab = z.infer<typeof TabSchema>;

// 验证数据
function validateTab(data: unknown): Tab {
  return TabSchema.parse(data);
}
```

## 📈 类型安全收益

### 1. 编译时错误检查
- 在编译时发现类型错误，而不是运行时
- 减少生产环境中的类型相关bug
- 提高代码的可靠性

### 2. 更好的IDE支持
- 智能代码补全
- 准确的重构支持
- 实时错误提示
- 更好的导航功能

### 3. 自文档化代码
- 类型定义即文档
- 减少注释的需要
- 提高代码的可读性
- 便于团队协作

### 4. 重构安全性
- 类型系统确保重构的正确性
- 减少重构时的错误
- 提高重构的信心
- 支持大规模重构

## 🎯 下一步计划

### 1. 逐步迁移现有代码
- 识别项目中的any类型使用
- 逐步替换为具体的类型定义
- 完善现有接口的类型定义

### 2. 建立类型检查流程
- 在CI/CD中添加类型检查
- 设置严格的TypeScript配置
- 建立代码审查标准

### 3. 团队培训
- TypeScript高级特性培训
- 类型设计最佳实践分享
- 工具类型使用指南

### 4. 工具和自动化
- 使用类型生成工具
- 自动化类型检查
- 类型覆盖率监控

## 📚 参考资源

- [TypeScript官方文档](https://www.typescriptlang.org/docs/)
- [TypeScript深入理解](https://basarat.gitbook.io/typescript/)
- [类型挑战](https://github.com/type-challenges/type-challenges)
- [工具类型参考](https://www.typescriptlang.org/docs/handbook/utility-types.html)
