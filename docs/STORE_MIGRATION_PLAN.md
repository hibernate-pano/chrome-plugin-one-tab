# OneTab Plus - Store迁移修复计划

## 🎯 目标
统一状态管理系统，解决新旧store混用导致的状态不一致问题

## 📋 当前问题分析

### 问题1: 双重Store架构
- **新版Store**: `src/app/store/index.ts` (目标架构)
- **旧版Store**: `src/store/index.ts` (需要废弃)
- **影响**: 状态分散，数据不同步

### 问题2: Hooks导入混乱
```typescript
// 混用情况
import { useAppDispatch, useAppSelector } from '@/app/store/hooks'; // 新版
import { useAppDispatch, useAppSelector } from '@/store/hooks';     // 旧版
```

### 问题3: 状态结构冲突
- 新版: `state.tabGroups.groups` vs 旧版: `state.tabs.groups`
- 导致组件访问错误的状态路径

## 🚀 修复阶段

### Phase 1: 准备阶段 (当前)
- [x] 分析问题点
- [ ] 备份关键文件
- [ ] 创建迁移脚本

### Phase 2: 统一Hooks导入
- [ ] 全局替换hooks导入路径
- [ ] 更新组件中的状态访问路径
- [ ] 验证类型安全

### Phase 3: 迁移Actions和Reducers
- [ ] 迁移settingsSlice到新架构
- [ ] 统一异步操作处理
- [ ] 清理重复的action creators

### Phase 4: 清理旧版Store
- [ ] 删除旧版store文件
- [ ] 更新导入引用
- [ ] 清理无用代码

### Phase 5: 验证和测试
- [ ] 功能测试
- [ ] 状态一致性验证
- [ ] 性能测试

## 📁 文件迁移清单

### 需要更新的组件文件
1. `src/popup/App.tsx` - 混用新旧hooks
2. `src/components/search/SearchResultList.tsx` - 使用旧版hooks
3. `src/components/auth/UserProfile.tsx` - 使用旧版hooks
4. `src/components/layout/Header.tsx` - 混用新旧actions
5. `src/components/performance/PerformanceTest.tsx` - 使用旧版hooks
6. `src/components/sync/SyncSettings.tsx` - 使用旧版hooks
7. `src/components/layout/SimpleThemeToggle.tsx` - 使用旧版hooks
8. `src/components/tabs/ImprovedTabList.tsx` - 状态路径不一致
9. `src/components/auth/RegisterForm.tsx` - 使用旧版hooks
10. `src/components/auth/LoginForm.tsx` - 使用旧版hooks
11. `src/components/layout/HeaderDropdown.tsx` - 混用状态
12. `src/components/tabs/TabList.tsx` - 使用旧版hooks

### 需要删除的文件
1. `src/store/index.ts` - 旧版store
2. `src/store/hooks.ts` - 旧版hooks
3. `src/store/slices/authSlice.ts` - 已迁移到新架构

### 需要迁移的文件
1. `src/store/slices/settingsSlice.ts` - 迁移到新架构
2. `src/store/slices/tabSlice.ts` - 部分功能迁移

## ⚠️ 风险控制

### 数据安全
- 迁移前备份所有状态相关文件
- 保持向后兼容的数据格式
- 实施渐进式迁移，避免功能中断

### 功能验证
- 每个阶段完成后进行功能测试
- 重点测试标签保存、同步、搜索功能
- 确保用户数据不丢失

## 📊 成功指标
- [ ] 所有组件使用统一的hooks
- [ ] 状态访问路径一致
- [ ] 无TypeScript类型错误
- [ ] 所有功能正常工作
- [ ] 性能无明显下降
