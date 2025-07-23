# 基于时间戳的简化冲突检测机制设计

## 设计目标

替代复杂的版本号管理系统，使用时间戳比较实现简单、高效的冲突检测和解决机制。

## 核心概念

### 时间戳字段
```typescript
interface TabGroup {
  id: string;
  name: string;
  tabs: Tab[];
  createdAt: string;    // ISO 8601 格式
  updatedAt: string;    // ISO 8601 格式，每次修改时更新
  lastSyncedAt?: string; // 最后同步时间，用于冲突检测
  // 移除 version 字段
}
```

### 冲突检测逻辑

#### 1. 基本冲突检测
```typescript
function hasTimestampConflict(local: TabGroup, remote: TabGroup): boolean {
  const localTime = new Date(local.updatedAt).getTime();
  const remoteTime = new Date(remote.updatedAt).getTime();
  const lastSyncTime = local.lastSyncedAt ? new Date(local.lastSyncedAt).getTime() : 0;
  
  // 如果本地数据在最后同步后被修改，且远程数据也更新了，则存在冲突
  return localTime > lastSyncTime && remoteTime > lastSyncTime;
}
```

#### 2. 内容差异检测
```typescript
function hasContentDifference(local: TabGroup, remote: TabGroup): boolean {
  // 检查基本属性差异
  if (local.name !== remote.name || local.isLocked !== remote.isLocked) {
    return true;
  }
  
  // 检查标签页数量差异
  if (local.tabs.length !== remote.tabs.length) {
    return true;
  }
  
  // 检查标签页内容差异（简化版本）
  const localUrls = new Set(local.tabs.map(tab => tab.url));
  const remoteUrls = new Set(remote.tabs.map(tab => tab.url));
  
  return localUrls.size !== remoteUrls.size || 
         ![...localUrls].every(url => remoteUrls.has(url));
}
```

## 冲突解决策略

### 1. 最新优先策略（默认）
```typescript
function resolveByLatest(local: TabGroup, remote: TabGroup): TabGroup {
  const localTime = new Date(local.updatedAt).getTime();
  const remoteTime = new Date(remote.updatedAt).getTime();
  
  // 选择时间戳更新的数据
  const winner = remoteTime > localTime ? remote : local;
  
  return {
    ...winner,
    lastSyncedAt: new Date().toISOString()
  };
}
```

### 2. 智能合并策略（可选）
```typescript
function resolveBySmartMerge(local: TabGroup, remote: TabGroup): TabGroup {
  const localTime = new Date(local.updatedAt).getTime();
  const remoteTime = new Date(remote.updatedAt).getTime();
  
  // 合并标签页（去重）
  const allTabs = new Map<string, Tab>();
  
  // 添加本地标签页
  local.tabs.forEach(tab => {
    allTabs.set(tab.url, tab);
  });
  
  // 添加远程标签页（可能覆盖本地的）
  remote.tabs.forEach(tab => {
    const existing = allTabs.get(tab.url);
    if (!existing || new Date(tab.updatedAt || tab.createdAt).getTime() > 
                     new Date(existing.updatedAt || existing.createdAt).getTime()) {
      allTabs.set(tab.url, tab);
    }
  });
  
  // 选择较新的元数据
  const useRemoteMeta = remoteTime > localTime;
  
  return {
    ...local,
    name: useRemoteMeta ? remote.name : local.name,
    isLocked: useRemoteMeta ? remote.isLocked : local.isLocked,
    tabs: Array.from(allTabs.values()),
    updatedAt: new Date().toISOString(),
    lastSyncedAt: new Date().toISOString()
  };
}
```

## 实现接口设计

### SimplifiedConflictDetector
```typescript
export interface ConflictInfo {
  type: 'timestamp_conflict';
  localGroup: TabGroup;
  remoteGroup: TabGroup;
  conflictTime: string;
  recommendation: 'use_latest' | 'smart_merge' | 'user_choice';
}

export class SimplifiedConflictDetector {
  /**
   * 检测时间戳冲突
   */
  detectConflicts(localGroups: TabGroup[], remoteGroups: TabGroup[]): ConflictInfo[] {
    const conflicts: ConflictInfo[] = [];
    const remoteMap = new Map(remoteGroups.map(g => [g.id, g]));
    
    for (const localGroup of localGroups) {
      const remoteGroup = remoteMap.get(localGroup.id);
      if (!remoteGroup) continue;
      
      if (this.hasTimestampConflict(localGroup, remoteGroup)) {
        conflicts.push({
          type: 'timestamp_conflict',
          localGroup,
          remoteGroup,
          conflictTime: new Date().toISOString(),
          recommendation: this.getRecommendation(localGroup, remoteGroup)
        });
      }
    }
    
    return conflicts;
  }
  
  /**
   * 自动解决冲突
   */
  resolveConflicts(conflicts: ConflictInfo[], strategy: 'latest' | 'smart_merge' = 'latest'): TabGroup[] {
    return conflicts.map(conflict => {
      switch (strategy) {
        case 'smart_merge':
          return this.resolveBySmartMerge(conflict.localGroup, conflict.remoteGroup);
        case 'latest':
        default:
          return this.resolveByLatest(conflict.localGroup, conflict.remoteGroup);
      }
    });
  }
  
  private hasTimestampConflict(local: TabGroup, remote: TabGroup): boolean {
    // 实现时间戳冲突检测逻辑
  }
  
  private getRecommendation(local: TabGroup, remote: TabGroup): ConflictInfo['recommendation'] {
    const timeDiff = Math.abs(
      new Date(local.updatedAt).getTime() - new Date(remote.updatedAt).getTime()
    );
    
    // 如果时间差很小（5分钟内），建议智能合并
    if (timeDiff < 5 * 60 * 1000) {
      return 'smart_merge';
    }
    
    // 否则使用最新优先
    return 'use_latest';
  }
}
```

## 数据迁移策略

### 从版本号到时间戳的迁移
```typescript
export class TimestampMigrationService {
  /**
   * 迁移现有数据到时间戳模式
   */
  async migrateToTimestampMode(): Promise<void> {
    const groups = await storage.getGroups();
    const migratedGroups = groups.map(group => ({
      ...group,
      // 移除版本号字段
      version: undefined,
      // 确保时间戳字段存在
      updatedAt: group.updatedAt || group.createdAt,
      lastSyncedAt: null // 重置同步状态
    }));
    
    await storage.setGroups(migratedGroups);
  }
  
  /**
   * 验证迁移结果
   */
  async validateMigration(): Promise<boolean> {
    const groups = await storage.getGroups();
    return groups.every(group => 
      group.updatedAt && 
      !('version' in group) &&
      new Date(group.updatedAt).getTime() > 0
    );
  }
}
```

## 性能优化

### 1. 时间戳比较优化
```typescript
// 预计算时间戳，避免重复解析
class TimestampCache {
  private cache = new Map<string, number>();
  
  getTimestamp(dateString: string): number {
    if (!this.cache.has(dateString)) {
      this.cache.set(dateString, new Date(dateString).getTime());
    }
    return this.cache.get(dateString)!;
  }
  
  clear(): void {
    this.cache.clear();
  }
}
```

### 2. 批量冲突检测
```typescript
// 批量处理，减少循环开销
function batchDetectConflicts(localGroups: TabGroup[], remoteGroups: TabGroup[]): ConflictInfo[] {
  const remoteMap = new Map(remoteGroups.map(g => [g.id, g]));
  const timestampCache = new TimestampCache();
  
  return localGroups
    .map(local => {
      const remote = remoteMap.get(local.id);
      if (!remote) return null;
      
      const localTime = timestampCache.getTimestamp(local.updatedAt);
      const remoteTime = timestampCache.getTimestamp(remote.updatedAt);
      const lastSyncTime = local.lastSyncedAt ? 
        timestampCache.getTimestamp(local.lastSyncedAt) : 0;
      
      if (localTime > lastSyncTime && remoteTime > lastSyncTime) {
        return { local, remote, localTime, remoteTime };
      }
      return null;
    })
    .filter(Boolean)
    .map(conflict => ({
      type: 'timestamp_conflict' as const,
      localGroup: conflict.local,
      remoteGroup: conflict.remote,
      conflictTime: new Date().toISOString(),
      recommendation: 'use_latest' as const
    }));
}
```

## 测试策略

### 单元测试用例
1. 基本时间戳比较
2. 冲突检测准确性
3. 不同解决策略的结果
4. 边缘情况处理（无效时间戳、缺失字段等）

### 集成测试场景
1. 多设备并发修改
2. 网络延迟导致的时序问题
3. 大量数据的性能测试
4. 数据迁移的完整性验证

## 优势总结

1. **简化实现**：移除复杂的版本号管理
2. **直观理解**：时间戳比较更容易理解和调试
3. **性能提升**：减少计算复杂度
4. **维护性好**：代码更简洁，bug更少
5. **扩展性强**：易于添加新的冲突解决策略
