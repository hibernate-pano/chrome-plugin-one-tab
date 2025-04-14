# OneTabPlus 优化同步策略

本文档详细介绍了 OneTabPlus 扩展中优化后的数据同步策略，该策略旨在提供更高效的多设备体验，同时确保数据安全和一致性。

## 优化背景

在之前的实现中，我们发现以下问题：

1. **设备ID性能问题**：使用设备ID进行实时通道订阅可能导致大量用户时的性能问题，每个设备创建单独的订阅会对系统造成压力。

2. **同步策略复杂**：之前的同步策略依赖于软删除标记和删除操作记录，同步过程复杂，有多个步骤和潜在的失败点。

## 优化方案

### 1. 移除设备ID依赖

- **移除设备特定的过滤**：使用每个用户的单一通道监控所有变更，而不是创建设备特定的通道
- **实现服务器端过滤**：使用Supabase的行级安全(RLS)策略在数据库级别过滤数据
- **使用更高效的通道结构**：为每个用户创建单一订阅，处理所有数据类型

### 2. 真正的双向同步

- **实现真正的双向同步**：专注于同步实际数据，而不是跟踪删除操作
- **使用"最后写入者胜出"方法**：基于时间戳自动解决冲突
- **简化数据模型**：移除复杂的跟踪字段，专注于核心数据
- **实现适当的合并策略**：当冲突发生时，智能合并数据而不是简单选择一个版本

## 同步流程详解

### 1. 初始同步（首次登录或新设备）

当用户首次登录或在新设备上使用 OneTabPlus 时，执行初始同步：

1. 获取本地数据
2. 获取云端数据
3. 合并数据（保留所有唯一项）
4. 保存合并后的数据到本地
5. 将合并后的数据推送到云端

```typescript
// 执行初始同步
async performInitialSync() {
  // 1. 获取本地数据
  const localGroups = await storage.getGroups();
  const localSettings = await storage.getSettings();
  
  // 2. 获取云端数据
  const cloudGroups = await supabaseSync.downloadTabGroups();
  const cloudSettings = await supabaseSync.downloadSettings();
  
  // 3. 合并数据（保留所有唯一项）
  const mergedGroups = mergeData(localGroups, cloudGroups);
  const mergedSettings = { ...localSettings, ...cloudSettings };
  
  // 4. 保存合并后的数据到本地
  await storage.setGroups(mergedGroups);
  await storage.setSettings(mergedSettings);
  
  // 5. 将合并后的数据推送到云端
  await supabaseSync.uploadTabGroups(mergedGroups);
  await supabaseSync.uploadSettings(mergedSettings);
}
```

### 2. 实时同步

实时同步基于以下技术实现：

1. **Supabase Realtime**：使用 Supabase 的 Realtime 功能监听数据库变化
2. **事件驱动**：当数据库中的数据发生变化时，会触发事件，客户端收到这些事件并更新本地数据
3. **精确更新**：只更新变更的特定项，而不是全量同步

```typescript
// 处理远程变更（插入或更新）
async function handleRemoteChange(groupId: string) {
  // 获取特定变更的标签组
  const { data: changedGroup } = await supabase
    .from('tab_groups')
    .select('*')
    .eq('id', groupId)
    .single();
  
  // 转换为应用格式
  const formattedGroup = convertSupabaseGroupToAppFormat(changedGroup);
  
  // 获取当前标签组
  const groups = await storage.getGroups();
  
  // 查找并替换或添加变更的标签组
  const updatedGroups = [...groups];
  const existingIndex = updatedGroups.findIndex(g => g.id === groupId);
  
  if (existingIndex >= 0) {
    // 更新现有标签组
    updatedGroups[existingIndex] = formattedGroup;
  } else {
    // 添加新标签组
    updatedGroups.push(formattedGroup);
  }
  
  // 保存更新后的标签组
  await storage.setGroups(updatedGroups);
  
  // 更新 Redux 存储
  store.dispatch(setGroups(updatedGroups));
}
```

### 3. 本地变更同步

当本地数据发生变更时，我们采用以下策略：

1. **单项同步**：如果只有一个标签组发生变更，只同步该标签组
2. **批量同步**：如果有多个变更，合并后一次性同步
3. **防抖处理**：使用防抖机制避免频繁同步

```typescript
// 同步本地更改到云端
export const syncLocalChangesToCloud = createAsyncThunk(
  'tabs/syncLocalChangesToCloud',
  async (changedGroup: TabGroup | null, { getState, dispatch }) => {
    const { auth } = getState();

    // 如果用户已登录，自动同步到云端
    if (auth.isAuthenticated) {
      // 如果提供了特定的标签组，只同步该标签组
      if (changedGroup) {
        // 使用 syncService 同步单个标签组
        const { syncService } = await import('@/services/syncService');
        return await syncService.syncGroupToCloud(changedGroup);
      } else {
        // 如果没有提供特定标签组，同步所有数据
        dispatch(syncTabsToCloud({ background: true }));
        return true;
      }
    }
    return false;
  }
);
```

## 智能合并算法

智能合并算法是优化同步策略的核心，它能够智能地合并来自不同设备的数据：

```typescript
function mergeData(localData: TabGroup[], cloudData: TabGroup[]): TabGroup[] {
  const mergedMap = new Map<string, TabGroup>();
  const currentTime = new Date().toISOString();
  
  // 添加所有本地项到映射
  localData.forEach(item => {
    const localItem = {
      ...item,
      syncStatus: 'synced',
      lastSyncedAt: currentTime
    };
    mergedMap.set(item.id, localItem);
  });
  
  // 合并云端项，冲突时使用更新版本
  cloudData.forEach(cloudItem => {
    const localItem = mergedMap.get(cloudItem.id);
    
    if (!localItem) {
      // 云端独有项，添加它
      const newItem = {
        ...cloudItem,
        syncStatus: 'synced',
        lastSyncedAt: currentTime
      };
      mergedMap.set(cloudItem.id, newItem);
    } else {
      // 项存在于本地，使用更新版本
      const localTime = new Date(localItem.updatedAt).getTime();
      const cloudTime = new Date(cloudItem.updatedAt).getTime();
      
      if (cloudTime > localTime) {
        // 云端版本更新，使用云端版本
        const updatedItem = {
          ...cloudItem,
          syncStatus: 'synced',
          lastSyncedAt: currentTime
        };
        mergedMap.set(cloudItem.id, updatedItem);
      }
    }
  });
  
  return Array.from(mergedMap.values());
}
```

## 性能优化

为了提高同步性能，我们采取了以下优化措施：

1. **单一用户通道**：每个用户只创建一个 Realtime 通道，减少服务器负担
2. **精确更新**：只更新变更的特定项，减少数据传输
3. **智能合并**：使用基于时间戳的智能合并算法，减少冲突
4. **防抖机制**：使用防抖机制避免频繁同步

## 安全考虑

我们采取了以下安全措施，确保用户数据安全：

1. **行级安全策略**：使用 Supabase 的行级安全策略确保用户只能访问自己的数据
2. **服务器端过滤**：在数据库级别过滤数据，减少客户端处理
3. **自动更新时间戳**：使用数据库触发器自动更新时间戳，确保数据一致性

## 结论

通过以上优化，我们实现了一个更高效、更可靠的同步策略，能够支持大量用户同时使用，同时保证数据的安全和一致性。这种策略特别适合像 OneTabPlus 这样的浏览器扩展，它需要在多个设备之间无缝同步用户数据。
