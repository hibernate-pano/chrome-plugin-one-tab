# OneTab Plus - 领域驱动设计迁移计划

## 🎯 目标
按照领域驱动设计（DDD）原则重新组织代码结构，提升可维护性和业务逻辑的清晰度。

## 📋 当前结构分析

### 现有优势
- ✅ `src/features/` 目录已按功能模块组织
- ✅ 每个feature都有独立的store
- ✅ `src/shared/` 目录包含共享资源
- ✅ 使用Redux Toolkit和createAsyncThunk

### 需要改进的地方
- 🔄 组件分散在 `src/components/` 中，应移动到对应features
- 🔄 业务逻辑混合在组件中，需要抽取到服务层
- 🔄 类型定义分散，需要按领域组织
- 🔄 工具函数需要按领域重新分类

## 🏗️ 目标架构

```
src/
├── app/                    # 应用级配置
│   └── store/             # 全局store配置
├── features/              # 业务功能模块（领域）
│   ├── auth/              # 认证领域
│   │   ├── components/    # 认证UI组件
│   │   ├── services/      # 认证业务服务
│   │   ├── store/         # 认证状态管理
│   │   ├── types/         # 认证相关类型
│   │   └── index.ts       # 领域导出
│   ├── tabs/              # 标签管理领域
│   │   ├── components/    # 标签UI组件
│   │   ├── services/      # 标签业务服务
│   │   ├── store/         # 标签状态管理
│   │   ├── types/         # 标签相关类型
│   │   └── index.ts       # 领域导出
│   ├── sync/              # 同步领域
│   ├── settings/          # 设置领域
│   └── onboarding/        # 引导领域
├── shared/                # 共享资源
│   ├── components/        # 通用UI组件
│   ├── services/          # 通用服务
│   ├── utils/             # 工具函数
│   ├── types/             # 共享类型
│   ├── constants/         # 常量定义
│   └── hooks/             # 共享hooks
└── popup/                 # 应用入口
```

## 📦 领域定义

### 1. 认证领域 (Auth Domain)
**职责**: 用户身份验证、会话管理、权限控制
- **实体**: User, AuthSession
- **值对象**: AuthProvider, AuthCredentials
- **服务**: AuthService, AuthCacheService, OAuthService
- **组件**: LoginForm, RegisterForm, AuthButton, UserProfile

### 2. 标签管理领域 (Tabs Domain)
**职责**: 标签页和标签组的管理、搜索、拖拽
- **聚合根**: TabGroup
- **实体**: Tab
- **值对象**: TabMetadata, SearchQuery
- **服务**: TabGroupService, TabService, SearchService, DragDropService
- **组件**: TabList, TabGroup, TabItem, SearchBar

### 3. 同步领域 (Sync Domain)
**职责**: 云端同步、冲突解决、实时同步
- **实体**: SyncOperation, SyncConflict
- **值对象**: SyncStrategy, SyncStatus
- **服务**: SyncService, ConflictResolutionService, RealtimeSyncService
- **组件**: SyncButton, SyncStatus, SyncSettings

### 4. 设置领域 (Settings Domain)
**职责**: 用户偏好设置、主题管理、配置管理
- **聚合根**: UserSettings
- **值对象**: ThemeSettings, SyncSettings
- **服务**: SettingsService, ThemeService
- **组件**: SettingsPanel, ThemeToggle

### 5. 引导领域 (Onboarding Domain)
**职责**: 新手引导、帮助系统、用户教育
- **实体**: OnboardingStep, UserProgress
- **服务**: OnboardingService
- **组件**: OnboardingSystem, OnboardingStep

## 🚀 迁移阶段

### Phase 1: 重组目录结构 ✅ (当前)
- [x] 创建领域目录结构
- [x] 移动组件到对应领域
- [x] 更新导入路径
- [x] 验证构建无错误

### Phase 2: 抽取业务服务
- [ ] 从组件中抽取业务逻辑
- [ ] 创建领域服务接口
- [ ] 实现服务层
- [ ] 重构组件使用服务

### Phase 3: 定义领域实体
- [ ] 明确定义实体和值对象
- [ ] 重构类型系统
- [ ] 实现领域规则
- [ ] 确保类型安全

### Phase 4: 优化领域边界
- [ ] 明确领域间的依赖关系
- [ ] 实现领域事件
- [ ] 优化跨领域通信
- [ ] 完善错误处理

## 📋 文件迁移清单

### 认证领域组件迁移
- [x] `src/components/auth/AuthButton.tsx` → `src/features/auth/components/AuthButton.tsx`
- [ ] `src/components/auth/LoginForm.tsx` → `src/features/auth/components/LoginForm.tsx`
- [ ] `src/components/auth/RegisterForm.tsx` → `src/features/auth/components/RegisterForm.tsx`
- [ ] `src/components/auth/UserProfile.tsx` → `src/features/auth/components/UserProfile.tsx`
- [ ] `src/components/auth/AuthContainer.tsx` → `src/features/auth/components/AuthContainer.tsx`

### 标签管理领域组件迁移
- [ ] `src/components/tabs/*` → `src/features/tabs/components/`
- [ ] `src/components/dnd/*` → `src/features/tabs/components/dnd/`
- [ ] `src/components/search/*` → `src/features/tabs/components/search/`

### 同步领域组件迁移
- [ ] `src/components/sync/*` → `src/features/sync/components/`
- [ ] `src/services/syncService.ts` → `src/features/sync/services/SyncService.ts`

### 服务层迁移
- [ ] `src/utils/authCache.ts` → `src/features/auth/services/AuthCacheService.ts`
- [ ] `src/utils/cloudDataUtils.ts` → `src/features/sync/services/CloudDataService.ts`
- [ ] `src/utils/syncHelpers.ts` → `src/features/sync/services/SyncHelpers.ts`

## ⚠️ 注意事项

### 向后兼容性
- 保持现有API接口不变
- 渐进式迁移，避免破坏性变更
- 保留旧的导入路径作为过渡

### 依赖管理
- 明确领域间的依赖方向
- 避免循环依赖
- 使用依赖注入模式

### 测试策略
- 为每个领域服务编写单元测试
- 保持组件测试的独立性
- 添加集成测试验证领域交互

## 📊 成功指标

- [ ] 所有组件按领域组织
- [ ] 业务逻辑集中在服务层
- [ ] 领域边界清晰明确
- [ ] 代码可维护性提升
- [ ] 无TypeScript错误
- [ ] 所有功能正常工作
- [ ] 性能无明显下降

## 🔄 后续优化

1. **领域事件系统**: 实现跨领域的事件通信
2. **CQRS模式**: 分离命令和查询操作
3. **仓储模式**: 抽象数据访问层
4. **规约模式**: 封装业务规则
5. **工厂模式**: 统一对象创建逻辑
