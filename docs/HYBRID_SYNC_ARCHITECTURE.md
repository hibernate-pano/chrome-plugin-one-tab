# OneTabPlus 混合同步架构设计

## 架构概述

本文档定义了OneTabPlus项目中乐观锁同步机制与Supabase实时订阅监听的混合架构设计，明确职责分工，简化实现复杂度。

## 核心设计原则

### 1. 职责分离
- **用户主动操作**：使用简化的乐观锁机制
- **被动数据同步**：使用实时订阅监听
- **两种机制独立运行**：避免相互调用，减少复杂度

### 2. 简化优先
- 移除复杂的版本号管理，改用时间戳比较
- 实现"最新优先"策略，替代复杂的保守合并
- 简化同步协调器，保留核心功能

### 3. 性能优化
- 减少不必要的网络请求
- 智能判断同步需求
- 优化防抖和过滤机制

## 职责分工详细设计

### 用户主动操作流程

```
用户操作 → SimplifiedSyncService → 时间戳冲突检测 → 本地更新 → 推送到云端
```

**适用场景：**
- 保存新标签组
- 删除标签组
- 更新标签组（重命名、锁定等）
- 标签页的增删改操作

**处理流程：**
1. 用户触发操作
2. 调用SimplifiedSyncService
3. 执行时间戳冲突检测
4. 更新本地数据
5. 推送到云端
6. 更新UI状态

### 被动数据同步流程

```
实时监听 → 设备过滤 → 操作保护检查 → 直接更新本地数据 → 通知UI更新
```

**适用场景：**
- 接收其他设备的数据变化
- 多设备间的实时同步
- 被动响应云端数据更新

**处理流程：**
1. 接收Supabase实时事件
2. 过滤自己设备的变化
3. 检查是否有待处理的用户操作
4. 直接更新本地数据（无需Pull-Push）
5. 通知UI更新

## 关键组件设计

### SimplifiedSyncService

```typescript
interface SimplifiedSyncService {
  // 用户操作的主要接口
  syncUserOperation(operation: UserOperation): Promise<SyncResult>
  
  // 基于时间戳的冲突检测
  detectConflictsByTimestamp(local: TabGroup[], remote: TabGroup[]): ConflictInfo[]
  
  // 简化的冲突解决（最新优先）
  resolveConflictsByLatest(conflicts: ConflictInfo[]): TabGroup[]
}
```

### OptimizedRealtimeSync

```typescript
interface OptimizedRealtimeSync {
  // 智能设备过滤
  isOwnDeviceChange(payload: RealtimePayload): boolean
  
  // 操作保护检查
  shouldSkipRealtimeSync(): boolean
  
  // 直接数据更新（无Pull-Push）
  updateLocalDataDirectly(changes: DataChange[]): Promise<void>
}
```

### SimplifiedSyncCoordinator

```typescript
interface SimplifiedSyncCoordinator {
  // 核心操作保护
  registerUserOperation(operationId: string): void
  completeUserOperation(operationId: string): void
  
  // 检查是否有待处理操作
  hasPendingOperations(): boolean
  
  // 简化的状态管理
  getSyncStatus(): SyncStatus
}
```

## 数据流向图

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   用户操作      │───▶│ SimplifiedSync   │───▶│   云端数据库    │
│                 │    │ Service          │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                                         │
                                                         ▼
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   UI更新        │◀───│ RealtimeSync     │◀───│  实时事件推送   │
│                 │    │ (其他设备)       │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

## 实施策略

### 阶段1：创建新组件
- 创建SimplifiedSyncService
- 实现时间戳比较逻辑
- 保持与现有系统的兼容性

### 阶段2：迁移用户操作
- 逐步将用户操作迁移到新服务
- 保留原有服务作为备份
- 添加配置开关控制

### 阶段3：优化实时同步
- 简化realtimeSync逻辑
- 移除对乐观锁服务的依赖
- 优化设备过滤和防抖机制

### 阶段4：清理和优化
- 移除不再使用的复杂逻辑
- 优化性能和错误处理
- 完善测试覆盖

## 预期效果

### 性能提升
- 减少50%的网络请求
- 降低同步延迟至500ms以内
- 提升UI响应速度

### 代码简化
- 减少30%的同步相关代码
- 降低维护复杂度
- 提高代码可读性

### 用户体验
- 更快的操作响应
- 更稳定的多设备同步
- 更少的数据冲突

## 风险控制

### 向后兼容
- 保留现有接口
- 渐进式迁移
- 配置开关控制

### 错误处理
- 完善的降级机制
- 详细的日志记录
- 快速回滚能力

### 测试保障
- 单元测试覆盖
- 集成测试验证
- 性能基准测试
