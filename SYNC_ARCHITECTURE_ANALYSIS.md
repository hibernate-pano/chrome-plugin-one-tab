# OneTabPlus 同步架构分析报告

## 📋 当前同步服务概览

### 1. 主要同步服务文件

| 文件 | 职责 | Realtime 使用 | 状态 |
|------|------|---------------|------|
| `src/services/realtimeSync.ts` | 实时同步服务 | ✅ 大量使用 | 需要移除 |
| `src/services/UnifiedSyncService.ts` | 统一同步服务 | ✅ 使用 | 需要移除 |
| `src/services/optimisticSyncService.ts` | 乐观锁同步服务 | ❌ 不使用 | 保留并重构 |
| `src/services/SimplifiedSyncService.ts` | 简化同步服务 | ❌ 不使用 | 保留并重构 |
| `src/features/sync/services/SyncService.ts` | 同步领域服务 | ❌ 不使用 | 保留并重构 |
| `src/services/autoSyncManager.ts` | 自动同步管理器 | ❌ 不使用 | 需要重构 |

### 2. Supabase Realtime 使用位置

#### 🔴 需要移除的 Realtime 代码

**realtimeSync.ts (第110-141行)**:
```typescript
this.channel = supabase
  .channel('tab_groups_changes')
  .on('postgres_changes', {
    event: '*',
    schema: 'public',
    table: 'tab_groups',
    filter: `user_id=eq.${this.currentUserId}`
  }, (payload) => {
    this.handleRealtimeChange(payload);
  })
  .subscribe((status) => {
    this.handleConnectionStatus(status);
  });
```

**UnifiedSyncService.ts (第77-89行)**:
```typescript
this.channel = supabase
  .channel('unified_tab_groups_sync')
  .on('postgres_changes', {
    event: '*',
    schema: 'public',
    table: 'tab_groups',
    filter: `user_id=eq.${this.currentUserId}`
  }, (payload) => {
    this.handleRealtimeChange(payload);
  })
  .subscribe((status) => {
    logger.info('📡 实时订阅状态:', status);
  });
```

### 3. 同步服务调用关系

#### 📍 Background.ts 调用
- **第225行**: 调用 `optimisticSyncService.scheduleSync()`
- **触发时机**: 保存标签页后

#### 📍 拖拽操作调用
- **dragOperationsSlice.ts 第155行**: 调用 `optimisticSyncService.schedulePushOnly()`
- **触发时机**: 标签组拖拽后

#### 📍 标签组操作调用
- **tabGroupsSlice.ts**: 通过 `syncCoordinator` 执行原子操作
- **触发时机**: 创建、删除、更新标签组

### 4. 定时同步现状

#### 🔄 autoSyncManager.ts
- **当前间隔**: 5/10/30 分钟可选 (第404-417行)
- **实现方式**: `setInterval`
- **需要修改**: 改为 10 秒间隔

#### 🔄 实时同步初始化
- **第44行**: `await this.initializeRealtimeSync()`
- **需要移除**: 完全移除实时同步初始化

### 5. 拖拽功能分析

#### 📍 标签组拖拽 (需要删除)
- **dragOperationsSlice.ts**: `moveGroup` 异步操作 (第131-164行)
- **DragDropService.ts**: `moveGroup` 方法 (第245-280行)
- **SimpleDraggableTabGroup.tsx**: 标签组拖拽组件
- **SortableTabGroup.tsx**: 可排序标签组组件

#### 📍 标签拖拽 (需要保留)
- **dragOperationsSlice.ts**: `moveTab` 异步操作 (第28-129行)
- **DragDropService.ts**: `moveTab` 方法 (第180-240行)
- **SimpleDraggableTab.tsx**: 标签拖拽组件
- **SortableTab.tsx**: 可排序标签组件

### 6. Redux 状态管理

#### 🔄 syncSlice.ts
- **实时同步状态**: `isRealtimeEnabled` (第20行)
- **需要移除**: 实时同步相关状态和 actions
- **保留**: 手动同步相关状态

#### 🔄 dragOperationsSlice.ts
- **标签组拖拽**: `moveGroup` action
- **需要移除**: 标签组拖拽相关代码
- **保留**: 标签拖拽相关代码

### 7. 数据加密兼容性

#### ✅ 加密功能状态
- **encryptionUtils.ts**: 完整的加密/解密实现
- **兼容性**: 支持加密和明文数据混合
- **状态**: 无需修改，与新架构兼容

## 🎯 重构优先级

### 高优先级 (立即执行)
1. 移除 `realtimeSync.ts` 和 `UnifiedSyncService.ts`
2. 删除标签组拖拽功能
3. 重构 `autoSyncManager.ts` 定时间隔

### 中优先级 (后续执行)
1. 重构核心同步服务为 pull-first 模式
2. 更新 Redux 状态管理
3. 添加手动同步按钮

### 低优先级 (最后执行)
1. 清理未使用的依赖
2. 更新文档和类型定义
3. 性能优化和测试

## 📝 注意事项

1. **数据兼容性**: 确保新架构与现有数据加密功能兼容
2. **用户体验**: 重构过程中保持功能可用性
3. **错误处理**: 完善网络异常和同步失败的处理机制
4. **测试覆盖**: 确保所有同步场景都有充分测试
