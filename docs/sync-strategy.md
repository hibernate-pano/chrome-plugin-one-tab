# OneTabPlus 同步策略 (v1.4.6)

本文档详细介绍了 OneTabPlus 扩展中的数据同步策略，该策略旨在提供最佳的多设备体验，同时确保数据安全和一致性。在 v1.4.6 版本中，我们实现了实时双向同步功能，进一步提升了用户体验。

## 同步策略概述

OneTabPlus 采用**智能增量合并**策略进行数据同步，这是增量同步和智能合并的结合。这种策略既能保留用户数据，又能提供良好的用户体验。

### 核心原则

1. **数据安全第一**：不会丢失用户数据
2. **用户控制**：用户可以选择同步策略
3. **透明性**：清晰显示同步状态和冲突
4. **效率**：只同步必要的数据，减少网络使用

## 实时双向同步

从 v1.4.6 版本开始，OneTabPlus 实现了实时双向同步功能，使用 Supabase Realtime 技术。这意味着：

1. **即时更新**：当用户在一个设备上进行更改时，这些更改会立即同步到云端，并实时推送到用户的其他设备。

2. **拖拽操作同步**：标签拖拽操作（移动标签组或重新排序）也会自动同步到云端。

3. **数据一致性**：实时双向同步确保了所有设备上的数据一致性，减少了数据冲突的可能性。

4. **无缝体验**：用户可以在多个设备之间无缝切换，而不必担心数据同步问题。

### 实现原理

实时双向同步基于以下技术实现：

1. **Supabase Realtime**：使用 Supabase 的 Realtime 功能监听数据库变化。

2. **事件驱动**：当数据库中的数据发生变化时，会触发事件，客户端收到这些事件并更新本地数据。

3. **通用同步函数**：我们实现了一个通用的同步函数，用于处理所有类型的数据变更，减少了代码重复。

4. **JSONB 格式存储**：使用 PostgreSQL 的 JSONB 格式存储标签数据，提高了性能和灵活性。

## 数据模型扩展

为了支持高级同步功能，我们扩展了数据模型，添加了以下字段：

### 标签 (Tab)

```typescript
interface Tab {
  // 现有字段...

  // 同步相关字段
  syncStatus?: 'synced' | 'local-only' | 'remote-only' | 'conflict';
  lastSyncedAt?: string | null;
  isDeleted?: boolean; // 软删除标记
}
```

### 标签组 (TabGroup)

```typescript
interface TabGroup {
  // 现有字段...

  // 同步相关字段
  syncStatus?: 'synced' | 'local-only' | 'remote-only' | 'conflict';
  lastSyncedAt?: string | null;
  isDeleted?: boolean; // 软删除标记
}
```

### 用户设置 (UserSettings)

```typescript
interface UserSettings {
  // 现有字段...

  // 同步策略设置
  syncStrategy: 'newest' | 'local' | 'remote' | 'ask';
  deleteStrategy: 'everywhere' | 'local-only';
}
```

## 同步流程详解

### 1. 初始同步（首次登录或新设备）

当用户首次登录或在新设备上使用 OneTabPlus 时，执行初始同步：

1. 从云端下载所有数据
2. 与本地数据合并，保留所有标签组
3. 对于重复的标签组（ID相同），保留更新时间较新的版本
4. 标记所有数据为"已同步"

```typescript
// 使用智能合并策略
const mergedGroups = mergeTabGroups(localGroups, cloudGroups, settings.syncStrategy);

// 保存到本地存储
await storage.setGroups(mergedGroups);
```

### 2. 定期同步

OneTabPlus 支持自动定期同步和手动触发同步两种方式。同步过程分为上传和下载两个阶段：

#### 上传阶段

1. 识别本地新增或修改的标签组（比较 `updatedAt` 和 `lastSyncedAt`）
2. 将这些变更上传到云端
3. 更新本地 `lastSyncedAt` 时间戳

```typescript
// 获取需要同步的标签组
const groupsToSync = getGroupsToSync(tabs.groups);

if (groupsToSync.length > 0) {
  // 上传标签组
  await supabaseSync.uploadTabGroups(groupsToSync);

  // 更新本地标签组的同步状态
  const updatedGroups = tabs.groups.map(group => {
    const syncedGroup = groupsToSync.find(g => g.id === group.id);
    if (syncedGroup) {
      return {
        ...group,
        lastSyncedAt: currentTime,
        syncStatus: 'synced'
      };
    }
    return group;
  });

  // 保存更新后的标签组
  await storage.setGroups(updatedGroups);
}
```

#### 下载阶段

1. 从云端获取自上次同步以来的变更
2. 智能合并这些变更到本地数据
3. 更新所有受影响数据的 `lastSyncedAt`

```typescript
// 获取云端数据
const cloudGroups = await supabaseSync.downloadTabGroups();

// 使用智能合并策略
const mergedGroups = mergeTabGroups(localGroups, cloudGroups, settings.syncStrategy);

// 保存到本地存储
await storage.setGroups(mergedGroups);
```

### 3. 冲突处理

当同一标签组在不同设备上被修改时，可能会发生冲突。OneTabPlus 提供了多种冲突解决策略：

#### 最新版本策略 ('newest')

使用更新时间较新的版本：

```typescript
if (localUpdatedAt > cloudUpdatedAt) {
  return {
    ...localGroup,
    syncStatus: 'synced',
    lastSyncedAt: currentTime
  };
} else {
  return {
    ...cloudGroup,
    syncStatus: 'synced',
    lastSyncedAt: currentTime
  };
}
```

#### 本地版本策略 ('local')

总是使用本地版本：

```typescript
return {
  ...localGroup,
  syncStatus: 'synced',
  lastSyncedAt: currentTime
};
```

#### 云端版本策略 ('remote')

总是使用云端版本：

```typescript
return {
  ...cloudGroup,
  syncStatus: 'synced',
  lastSyncedAt: currentTime
};
```

#### 询问用户策略 ('ask')

标记为冲突，等待用户解决：

```typescript
return {
  ...localGroup,
  name: `${localGroup.name} (冲突)`,
  syncStatus: 'conflict',
  lastSyncedAt: null,
  // 保存云端版本以供用户选择
  cloudVersion: cloudGroup
};
```

### 4. 删除处理

删除操作是同步中的特殊情况，OneTabPlus 提供了两种删除策略：

#### 所有设备删除策略 ('everywhere')

标记为已删除，将在所有设备上删除：

```typescript
return {
  ...group,
  isDeleted: true,
  updatedAt: currentTime,
  lastSyncedAt: null // 需要同步此更改
};
```

#### 仅本地删除策略 ('local-only')

仅在本地删除，不同步到其他设备：

```typescript
return {
  ...group,
  syncStatus: 'local-only',
  isDeleted: true,
  updatedAt: currentTime,
  lastSyncedAt: currentTime // 已同步（实际上是忽略同步）
};
```

## 智能合并算法

智能合并算法是 OneTabPlus 同步策略的核心，它能够智能地合并来自不同设备的数据：

### 标签组合并

```typescript
const mergeTabGroups = (
  localGroups: TabGroup[],
  cloudGroups: TabGroup[],
  syncStrategy: UserSettings['syncStrategy'] = 'newest'
): TabGroup[] => {
  // 创建一个映射，以标签组ID为键
  const mergedGroupsMap = new Map<string, TabGroup>();
  const currentTime = new Date().toISOString();

  // 处理本地标签组
  localGroups.forEach(localGroup => {
    // 标记本地独有的标签组
    const group = {
      ...localGroup,
      syncStatus: 'local-only' as const,
      lastSyncedAt: null
    };
    mergedGroupsMap.set(localGroup.id, group);
  });

  // 处理云端标签组
  cloudGroups.forEach(cloudGroup => {
    const localGroup = mergedGroupsMap.get(cloudGroup.id);

    if (!localGroup) {
      // 云端独有的标签组
      const group = {
        ...cloudGroup,
        syncStatus: 'remote-only' as const,
        lastSyncedAt: currentTime
      };
      mergedGroupsMap.set(cloudGroup.id, group);
    } else {
      // 本地和云端都有的标签组，需要合并
      const mergedGroup = mergeGroup(localGroup, cloudGroup, syncStrategy);
      mergedGroupsMap.set(cloudGroup.id, mergedGroup);
    }
  });

  // 将映射转换回数组
  return Array.from(mergedGroupsMap.values())
    // 过滤掉已删除的标签组（如果deleteStrategy为'everywhere'）
    .filter(group => !group.isDeleted);
};
```

### 标签合并

```typescript
const mergeTabs = (
  localGroup: TabGroup,
  cloudGroup: TabGroup,
  currentTime: string
): TabGroup => {
  // 创建一个映射，以标签ID为键
  const mergedTabsMap = new Map<string, Tab>();

  // 添加本地标签
  localGroup.tabs.forEach(localTab => {
    mergedTabsMap.set(localTab.id, {
      ...localTab,
      syncStatus: 'synced',
      lastSyncedAt: currentTime
    });
  });

  // 添加或更新云端标签
  cloudGroup.tabs.forEach(cloudTab => {
    const localTab = mergedTabsMap.get(cloudTab.id);

    if (!localTab) {
      // 云端独有的标签
      mergedTabsMap.set(cloudTab.id, {
        ...cloudTab,
        syncStatus: 'synced',
        lastSyncedAt: currentTime
      });
    } else {
      // 本地和云端都有的标签，使用更新时间较新的版本
      const localAccessedAt = new Date(localTab.lastAccessed).getTime();
      const cloudAccessedAt = new Date(cloudTab.lastAccessed).getTime();

      if (localAccessedAt > cloudAccessedAt) {
        mergedTabsMap.set(cloudTab.id, {
          ...localTab,
          syncStatus: 'synced',
          lastSyncedAt: currentTime
        });
      } else {
        mergedTabsMap.set(cloudTab.id, {
          ...cloudTab,
          syncStatus: 'synced',
          lastSyncedAt: currentTime
        });
      }
    }
  });

  // 过滤掉已删除的标签
  const mergedTabs = Array.from(mergedTabsMap.values())
    .filter(tab => !tab.isDeleted);

  // 使用更新时间较新的标签组信息
  const localUpdatedAt = new Date(localGroup.updatedAt).getTime();
  const cloudUpdatedAt = new Date(cloudGroup.updatedAt).getTime();

  if (localUpdatedAt > cloudUpdatedAt) {
    return {
      ...localGroup,
      tabs: mergedTabs,
      syncStatus: 'synced',
      lastSyncedAt: currentTime
    };
  } else {
    return {
      ...cloudGroup,
      tabs: mergedTabs,
      syncStatus: 'synced',
      lastSyncedAt: currentTime
    };
  }
};
```

## 用户界面

### 同步设置

OneTabPlus 提供了丰富的同步设置选项，允许用户自定义同步行为：

1. **同步频率**：
   - 自动（每分钟）
   - 手动（仅当用户点击同步按钮）
   - 启动时（每次打开浏览器）

2. **冲突解决策略**：
   - 总是保留最新版本
   - 总是保留本地版本
   - 总是保留云端版本
   - 询问我（显示冲突解决界面）

3. **删除策略**：
   - 立即删除（从所有设备删除）
   - 仅本地删除（其他设备保留）

### 同步状态显示

OneTabPlus 提供了清晰的同步状态显示，帮助用户了解同步进度和结果：

- 同步状态（正在同步、同步成功、同步失败）
- 上次同步时间
- 压缩统计信息（如果启用了数据压缩）

```tsx
<SyncStatus compressionStats={compressionStats} />
```

### 冲突解决界面

当使用 'ask' 策略时，OneTabPlus 会显示冲突解决界面，允许用户选择要保留的版本：

- 显示本地版本和云端版本的差异
- 提供"保留本地版本"、"保留云端版本"和"保留两者"选项
- 允许用户逐个解决冲突

## 性能优化

为了提高同步性能，OneTabPlus 采取了以下优化措施：

1. **增量同步**：
   - 只同步有变更的数据，减少网络传输
   - 使用 `lastSyncedAt` 字段跟踪同步状态

2. **数据压缩**：
   - 使用 LZ-string 压缩数据，减少网络传输
   - 通常可减少 50-70% 的数据传输量

3. **批量操作**：
   - 批量上传和下载数据，减少网络请求次数
   - 使用事务确保数据一致性

## 安全考虑

OneTabPlus 采取了以下安全措施，确保用户数据安全：

1. **认证**：
   - 使用 Supabase Auth 进行用户认证
   - 支持邮箱/密码和第三方登录

2. **授权**：
   - 使用 Row Level Security (RLS) 确保用户只能访问自己的数据
   - 每个请求都需要有效的 JWT 令牌

3. **数据加密**：
   - 使用 HTTPS 加密传输数据
   - 密码使用 bcrypt 加密存储

## 故障排除

如果遇到同步问题，可以尝试以下解决方法：

1. **同步失败**：
   - 检查网络连接
   - 确保用户已登录
   - 查看控制台日志中的错误信息

2. **数据不一致**：
   - 手动触发完整同步
   - 检查是否有冲突需要解决
   - 在设置中选择合适的同步策略

3. **冲突无法解决**：
   - 尝试更改冲突解决策略
   - 手动编辑冲突的标签组
   - 导出数据作为备份

## 后续改进计划

1. **冲突解决 UI**：
   - 添加一个专门的冲突解决界面
   - 允许用户逐项选择要保留的版本

2. **同步历史**：
   - 记录同步历史
   - 允许回滚到之前的版本

3. **离线支持**：
   - 改进离线工作流程
   - 在恢复连接后智能同步

4. **选择性同步**：
   - 允许用户选择要同步的标签组
   - 支持排除某些标签组不同步

5. **多账户支持**：
   - 支持多个用户账户
   - 允许在账户之间共享标签组
