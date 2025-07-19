# OneTab Plus - 测试指南

## 🎯 测试目标

本指南旨在：
1. **建立完善的测试体系**：单元测试、集成测试、端到端测试
2. **提高代码质量**：通过测试发现和预防bug
3. **确保重构安全**：测试作为重构的安全网
4. **提升开发效率**：自动化测试减少手动测试时间
5. **建立测试文化**：让测试成为开发流程的一部分

## 📊 测试架构

### 1. 测试金字塔

```
    🔺 E2E Tests (少量)
   🔺🔺 Integration Tests (适量)  
  🔺🔺🔺 Unit Tests (大量)
```

- **单元测试 (70%)**：测试单个函数、组件、类
- **集成测试 (20%)**：测试模块间的交互
- **端到端测试 (10%)**：测试完整的用户流程

### 2. 测试工具链

- **测试框架**: Jest
- **React测试**: @testing-library/react
- **模拟工具**: Jest mocks
- **覆盖率**: Jest coverage
- **E2E测试**: Playwright (计划中)

## 🔧 测试配置

### Jest配置 (`jest.config.js`)

```javascript
module.exports = {
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/src/tests/setup.ts'],
  moduleNameMapping: {
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  collectCoverageFrom: [
    'src/**/*.{js,jsx,ts,tsx}',
    '!src/**/*.d.ts',
    '!src/tests/**'
  ],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70
    }
  }
};
```

### 测试环境设置 (`src/tests/setup.ts`)

- Chrome扩展API模拟
- DOM API模拟 (IntersectionObserver, ResizeObserver)
- 浏览器API模拟 (localStorage, fetch)
- 全局测试工具函数

## 📝 测试编写指南

### 1. 单元测试

#### 工具函数测试

```typescript
// src/shared/utils/__tests__/commonUtils.test.ts
import { CommonUtils } from '../commonUtils';

describe('CommonUtils', () => {
  describe('debounce', () => {
    it('应该正确实现防抖功能', (done) => {
      const mockFn = jest.fn();
      const debouncedFn = CommonUtils.debounce(mockFn, 100);
      
      debouncedFn();
      debouncedFn();
      debouncedFn();
      
      expect(mockFn).not.toHaveBeenCalled();
      
      setTimeout(() => {
        expect(mockFn).toHaveBeenCalledTimes(1);
        done();
      }, 150);
    });
  });
});
```

#### React组件测试

```typescript
// src/components/__tests__/Button.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from '../Button';

describe('Button', () => {
  it('应该渲染按钮文本', () => {
    render(<Button>点击我</Button>);
    expect(screen.getByText('点击我')).toBeInTheDocument();
  });

  it('应该处理点击事件', () => {
    const handleClick = jest.fn();
    render(<Button onClick={handleClick}>点击我</Button>);
    
    fireEvent.click(screen.getByText('点击我'));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('应该支持禁用状态', () => {
    render(<Button disabled>禁用按钮</Button>);
    expect(screen.getByText('禁用按钮')).toBeDisabled();
  });
});
```

#### Hook测试

```typescript
// src/hooks/__tests__/useCounter.test.ts
import { renderHook, act } from '@testing-library/react';
import { useCounter } from '../useCounter';

describe('useCounter', () => {
  it('应该有正确的初始值', () => {
    const { result } = renderHook(() => useCounter(0));
    expect(result.current.count).toBe(0);
  });

  it('应该能够增加计数', () => {
    const { result } = renderHook(() => useCounter(0));
    
    act(() => {
      result.current.increment();
    });
    
    expect(result.current.count).toBe(1);
  });
});
```

### 2. 集成测试

#### 服务集成测试

```typescript
// src/services/__tests__/tabGroupService.test.ts
import { TabGroupService } from '../tabGroupService';
import { mockChrome } from '../../tests/setup';

describe('TabGroupService', () => {
  let service: TabGroupService;

  beforeEach(() => {
    service = new TabGroupService();
    jest.clearAllMocks();
  });

  it('应该能够创建标签组', async () => {
    const groupData = { name: '测试组', tabs: [] };
    mockChrome.storage.local.set.mockImplementation((data, callback) => {
      callback();
    });

    const result = await service.createGroup(groupData);
    
    expect(result.name).toBe('测试组');
    expect(mockChrome.storage.local.set).toHaveBeenCalled();
  });
});
```

#### 组件集成测试

```typescript
// src/features/__tests__/TabGroupManager.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import { TabGroupManager } from '../TabGroupManager';
import { TabGroupProvider } from '../TabGroupContext';

const renderWithProvider = (component: React.ReactElement) => {
  return render(
    <TabGroupProvider>
      {component}
    </TabGroupProvider>
  );
};

describe('TabGroupManager', () => {
  it('应该显示标签组列表', async () => {
    renderWithProvider(<TabGroupManager />);
    
    await waitFor(() => {
      expect(screen.getByText('我的标签组')).toBeInTheDocument();
    });
  });
});
```

### 3. 测试最佳实践

#### AAA模式 (Arrange-Act-Assert)

```typescript
it('应该计算正确的总价', () => {
  // Arrange - 准备测试数据
  const items = [
    { price: 10, quantity: 2 },
    { price: 5, quantity: 3 }
  ];
  
  // Act - 执行被测试的操作
  const total = calculateTotal(items);
  
  // Assert - 验证结果
  expect(total).toBe(35);
});
```

#### 测试命名规范

```typescript
describe('组件/函数名', () => {
  describe('特定方法/场景', () => {
    it('应该在特定条件下产生预期结果', () => {
      // 测试实现
    });
    
    it('应该在错误条件下抛出异常', () => {
      // 测试实现
    });
  });
});
```

#### 模拟和存根

```typescript
// 模拟外部依赖
jest.mock('../api/client', () => ({
  fetchData: jest.fn().mockResolvedValue({ data: 'mock data' })
}));

// 模拟Chrome API
const mockChrome = {
  storage: {
    local: {
      get: jest.fn(),
      set: jest.fn()
    }
  }
};

global.chrome = mockChrome;
```

## 📈 覆盖率目标

### 覆盖率阈值

- **全局目标**: 70%
- **关键工具函数**: 80%
- **服务层**: 75%
- **组件**: 60%

### 覆盖率类型

1. **行覆盖率**: 代码行被执行的百分比
2. **函数覆盖率**: 函数被调用的百分比
3. **分支覆盖率**: 条件分支被执行的百分比
4. **语句覆盖率**: 语句被执行的百分比

## 🚀 运行测试

### 基本命令

```bash
# 运行所有测试
npm test

# 运行测试并生成覆盖率报告
npm run test:coverage

# 监听模式运行测试
npm run test:watch

# 运行特定测试文件
npm test -- Button.test.tsx

# 运行特定测试套件
npm test -- --testNamePattern="Button"
```

### CI/CD集成

```yaml
# .github/workflows/test.yml
name: Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm run test:coverage
      - uses: codecov/codecov-action@v3
        with:
          file: ./coverage/lcov.info
```

## 📊 测试报告

### 自动生成报告

测试运行后会自动生成以下报告：

1. **JSON报告**: `test-reports/test-results.json`
2. **HTML报告**: `test-reports/test-results.html`
3. **Markdown报告**: `test-reports/test-results.md`
4. **覆盖率报告**: `coverage/lcov-report/index.html`

### 报告内容

- 测试统计信息
- 覆盖率分析
- 失败测试详情
- 慢测试识别
- 低覆盖率文件

## 🎯 测试策略

### 1. 优先级测试

**高优先级**:
- 核心业务逻辑
- 数据处理函数
- API服务层
- 关键用户流程

**中优先级**:
- UI组件交互
- 状态管理
- 工具函数
- 错误处理

**低优先级**:
- 样式相关
- 静态内容
- 第三方库封装

### 2. 测试驱动开发 (TDD)

```typescript
// 1. 先写测试
it('应该计算两个数的和', () => {
  expect(add(2, 3)).toBe(5);
});

// 2. 运行测试（失败）
// 3. 实现最小功能
function add(a: number, b: number): number {
  return a + b;
}

// 4. 运行测试（通过）
// 5. 重构代码
```

### 3. 回归测试

- 每次修复bug后添加对应测试
- 重要功能变更后增加测试覆盖
- 定期审查和更新测试用例

## 🔍 测试调试

### 调试技巧

```typescript
// 使用 screen.debug() 查看DOM结构
it('调试测试', () => {
  render(<MyComponent />);
  screen.debug(); // 打印当前DOM
});

// 使用 waitFor 处理异步操作
it('异步测试', async () => {
  render(<AsyncComponent />);
  await waitFor(() => {
    expect(screen.getByText('加载完成')).toBeInTheDocument();
  });
});

// 使用 act 包装状态更新
it('状态更新测试', () => {
  const { result } = renderHook(() => useCounter());
  
  act(() => {
    result.current.increment();
  });
  
  expect(result.current.count).toBe(1);
});
```

## 📚 参考资源

- [Jest官方文档](https://jestjs.io/docs/getting-started)
- [Testing Library文档](https://testing-library.com/docs/)
- [React测试最佳实践](https://kentcdodds.com/blog/common-mistakes-with-react-testing-library)
- [测试驱动开发指南](https://martinfowler.com/bliki/TestDrivenDevelopment.html)

## 🎯 下一步计划

### 短期目标
- [ ] 完善现有组件的单元测试
- [ ] 添加关键服务的集成测试
- [ ] 提高测试覆盖率到70%

### 中期目标
- [ ] 引入E2E测试框架
- [ ] 建立性能测试基准
- [ ] 完善CI/CD测试流程

### 长期目标
- [ ] 实现测试自动化
- [ ] 建立测试质量度量
- [ ] 推广测试最佳实践
