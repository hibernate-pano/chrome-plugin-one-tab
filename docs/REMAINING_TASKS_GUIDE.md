# 同步改进实施指南 - 剩余任务

**生成时间**: 2025-10-10
**状态**: 🟡 核心改进已完成，剩余简单修改

---

## ✅ 已完成的核心改进

1. ✅ **类型定义扩展** - 添加 `version` 和 `displayOrder` 字段
2. ✅ **syncUtils 完全重写** - 字段级冲突解决 + 软删除支持
3. ✅ **deleteGroup 软删除** - 使用 `isDeleted` 标记
4. ✅ **Redux reducer 过滤** - loadGroups 和 syncTabsFromCloud 过滤已删除项
5. ✅ **版本号辅助函数** - versionHelper.ts 提供统一接口

---

## 🔧 剩余简单修改（约30分钟）

### 任务1: 更新修改操作增加版本号

**目标**: 所有修改操作都应递增版本号

#### 1.1 修改 `updateGroup` (tabSlice.ts:60-75)

```typescript
// 修改前
export const updateGroup = createAsyncThunk(
  'tabs/updateGroup',
  async (group: TabGroup) => {
    const groups = await storage.getGroups();
    const updatedGroups = groups.map(g => (g.id === group.id ? group : g));
    await storage.setGroups(updatedGroups);
    return group;
  }
);

// 修改后
import { updateGroupWithVersion } from '@/utils/versionHelper';

export const updateGroup = createAsyncThunk(
  'tabs/updateGroup',
  async (group: TabGroup) => {
    const groups = await storage.getGroups();

    // 使用辅助函数增加版本号
    const updatedGroups = groups.map(g =>
      g.id === group.id ? updateGroupWithVersion(g, group) : g
    );

    await storage.setGroups(updatedGroups);

    return updatedGroups.find(g => g.id === group.id)!;
  }
);
```

#### 1.2 修改 `updateGroupNameAndSync` (tabSlice.ts:443-463)

```typescript
// 修改前
export const updateGroupNameAndSync = createAsyncThunk(
  'tabs/updateGroupNameAndSync',
  async ({ groupId, name }: { groupId: string; name: string }, { dispatch }) => {
    dispatch(updateGroupName({ groupId, name }));

    const groups = await storage.getGroups();
    const updatedGroups = groups.map(g => {
      if (g.id === groupId) {
        return { ...g, name, updatedAt: new Date().toISOString() };
      }
      return g;
    });
    await storage.setGroups(updatedGroups);

    return { groupId, name };
  }
);

// 修改后
import { updateGroupWithVersion } from '@/utils/versionHelper';

export const updateGroupNameAndSync = createAsyncThunk(
  'tabs/updateGroupNameAndSync',
  async ({ groupId, name }: { groupId: string; name: string }, { dispatch }) => {
    dispatch(updateGroupName({ groupId, name }));

    const groups = await storage.getGroups();
    const updatedGroups = groups.map(g => {
      if (g.id === groupId) {
        return updateGroupWithVersion(g, { name });
      }
      return g;
    });
    await storage.setGroups(updatedGroups);

    console.log(`[UpdateGroupName] 更新标签组 ${groupId}, 新版本: ${(groups.find(g => g.id === groupId)?.version || 1) + 1}`);

    return { groupId, name };
  }
);
```

#### 1.3 修改 `toggleGroupLockAndSync` (tabSlice.ts:466-493)

```typescript
// 修改前
export const toggleGroupLockAndSync = createAsyncThunk(
  'tabs/toggleGroupLockAndSync',
  async (groupId: string, { dispatch }) => {
    dispatch(toggleGroupLock(groupId));

    const groups = await storage.getGroups();
    const group = groups.find(g => g.id === groupId);

    if (group) {
      const updatedGroup = {
        ...group,
        isLocked: !group.isLocked,
        updatedAt: new Date().toISOString(),
      };

      const updatedGroups = groups.map(g => (g.id === groupId ? updatedGroup : g));
      await storage.setGroups(updatedGroups);

      return { groupId, isLocked: updatedGroup.isLocked };
    }

    return { groupId, isLocked: false };
  }
);

// 修改后
import { updateGroupWithVersion } from '@/utils/versionHelper';

export const toggleGroupLockAndSync = createAsyncThunk(
  'tabs/toggleGroupLockAndSync',
  async (groupId: string, { dispatch }) => {
    dispatch(toggleGroupLock(groupId));

    const groups = await storage.getGroups();
    const group = groups.find(g => g.id === groupId);

    if (group) {
      const updatedGroup = updateGroupWithVersion(group, {
        isLocked: !group.isLocked
      });

      const updatedGroups = groups.map(g => (g.id === groupId ? updatedGroup : g));
      await storage.setGroups(updatedGroups);

      console.log(`[ToggleLock] 切换锁定状态 ${groupId}, 新版本: ${updatedGroup.version}`);

      return { groupId, isLocked: updatedGroup.isLocked };
    }

    return { groupId, isLocked: false };
  }
);
```

#### 1.4 修改 Redux reducer 中的 `updateGroupName` 和 `toggleGroupLock`

```typescript
// tabSlice.ts:820-833
updateGroupName: (state, action) => {
  const { groupId, name } = action.payload;
  const group = state.groups.find(g => g.id === groupId);
  if (group) {
    group.name = name;
    group.version = (group.version || 1) + 1; // 添加版本号
    group.updatedAt = new Date().toISOString();
  }
},
toggleGroupLock: (state, action) => {
  const group = state.groups.find(g => g.id === action.payload);
  if (group) {
    group.isLocked = !group.isLocked;
    group.version = (group.version || 1) + 1; // 添加版本号
    group.updatedAt = new Date().toISOString();
  }
},
```

---

### 任务2: 实现 `moveGroupAndSync` 更新 `displayOrder`

**文件**: tabSlice.ts:502-558

```typescript
// 完整替换 moveGroupAndSync 函数
import { updateDisplayOrder } from '@/utils/versionHelper';

export const moveGroupAndSync = createAsyncThunk(
  'tabs/moveGroupAndSync',
  async (
    { dragIndex, hoverIndex }: { dragIndex: number; hoverIndex: number },
    { dispatch }
  ) => {
    try {
      // 在 Redux 中移动标签组 - 立即更新UI
      dispatch(moveGroup({ dragIndex, hoverIndex }));

      // 使用 requestAnimationFrame 在下一帧执行存储操作，优化性能
      requestAnimationFrame(async () => {
        try {
          // 在本地存储中更新标签组顺序
          const groups = await storage.getGroups();

          // 检查索引是否有效
          if (
            dragIndex < 0 ||
            dragIndex >= groups.length ||
            hoverIndex < 0 ||
            hoverIndex >= groups.length
          ) {
            console.error('无效的标签组索引:', {
              dragIndex,
              hoverIndex,
              groupsLength: groups.length,
            });
            return;
          }

          const dragGroup = groups[dragIndex];

          // 创建新的数组以避免直接修改原数组
          const newGroups = [...groups];
          // 删除拖拽的标签组
          newGroups.splice(dragIndex, 1);
          // 在新位置插入标签组
          newGroups.splice(hoverIndex, 0, dragGroup);

          // ⭐ 关键：更新所有标签组的 displayOrder 和 version
          const updatedGroups = updateDisplayOrder(newGroups);

          // 更新本地存储 - 批量操作
          await storage.setGroups(updatedGroups);

          console.log(`[MoveGroup] 已更新所有标签组的 displayOrder`);

          // 注意：云端同步由 smartSyncService 统一管理（后台监听存储变化自动触发）
        } catch (error) {
          console.error('存储标签组移动操作失败:', error);
        }
      });

      return { dragIndex, hoverIndex };
    } catch (error) {
      console.error('移动标签组操作失败:', error);
      throw error;
    }
  }
);
```

---

### 任务3: 创建数据迁移脚本

**新建文件**: `src/utils/migrationHelper.ts`

```typescript
import { storage } from './storage';
import { initializeVersionFields } from './versionHelper';
import { TabGroup } from '@/types/tab';

/**
 * 数据迁移到 v2.0
 * 为所有标签组添加 version 和 displayOrder 字段
 */
export async function migrateToV2(): Promise<void> {
  try {
    const groups = await storage.getGroups();

    // 检查是否需要迁移
    const needsMigration = groups.some(g => g.version === undefined || g.displayOrder === undefined);

    if (!needsMigration) {
      console.log('[Migration] 数据已是 v2.0 格式，无需迁移');
      return;
    }

    console.log(`[Migration] 开始迁移 ${groups.length} 个标签组到 v2.0 格式...`);

    // 初始化 version 和 displayOrder
    const migratedGroups = groups.map((group, index) =>
      initializeVersionFields(group, index)
    );

    // 保存迁移后的数据
    await storage.setGroups(migratedGroups);

    console.log('[Migration] 迁移完成！');
    console.log(`[Migration] 已初始化 ${migratedGroups.length} 个标签组的 version 和 displayOrder`);

  } catch (error) {
    console.error('[Migration] 迁移失败:', error);
    throw error;
  }
}

/**
 * 获取迁移状态
 */
export async function getMigrationStatus(): Promise<{
  isV2: boolean;
  totalGroups: number;
  migratedGroups: number;
}> {
  const groups = await storage.getGroups();

  const migratedGroups = groups.filter(
    g => g.version !== undefined && g.displayOrder !== undefined
  );

  return {
    isV2: migratedGroups.length === groups.length,
    totalGroups: groups.length,
    migratedGroups: migratedGroups.length,
  };
}
```

#### 调用位置

**选项A**: 在 App 启动时自动迁移

```typescript
// src/App.tsx 或 src/background/index.ts
import { migrateToV2 } from '@/utils/migrationHelper';

// 在应用初始化时调用
async function initializeApp() {
  try {
    await migrateToV2();
    // ... 其他初始化逻辑
  } catch (error) {
    console.error('应用初始化失败:', error);
  }
}

initializeApp();
```

**选项B**: 在设置页面添加手动迁移按钮

```typescript
// src/pages/Settings.tsx
import { migrateToV2, getMigrationStatus } from '@/utils/migrationHelper';

function SettingsPage() {
  const [status, setStatus] = useState({ isV2: false, totalGroups: 0, migratedGroups: 0 });

  useEffect(() => {
    getMigrationStatus().then(setStatus);
  }, []);

  const handleMigrate = async () => {
    await migrateToV2();
    const newStatus = await getMigrationStatus();
    setStatus(newStatus);
    alert('数据迁移完成！');
  };

  return (
    <div>
      <h3>数据迁移状态</h3>
      <p>总标签组: {status.totalGroups}</p>
      <p>已迁移: {status.migratedGroups}</p>
      <p>状态: {status.isV2 ? '✅ 已迁移到 v2.0' : '❌ 需要迁移'}</p>

      {!status.isV2 && (
        <button onClick={handleMigrate}>
          立即迁移到 v2.0
        </button>
      )}
    </div>
  );
}
```

---

## 📝 修改清单（检查表）

### 核心改进（已完成）
- [x] 类型定义添加 `version` 和 `displayOrder`
- [x] 重写 syncUtils.ts
- [x] deleteGroup 改为软删除
- [x] loadGroups 过滤已删除项
- [x] syncTabsFromCloud 过滤已删除项
- [x] 创建 versionHelper.ts

### 剩余修改（需要完成）
- [ ] updateGroup 增加版本号
- [ ] updateGroupNameAndSync 增加版本号
- [ ] toggleGroupLockAndSync 增加版本号
- [ ] Redux reducer 中的 updateGroupName 增加版本号
- [ ] Redux reducer 中的 toggleGroupLock 增加版本号
- [ ] moveGroupAndSync 更新 displayOrder
- [ ] 创建 migrationHelper.ts
- [ ] 在应用启动时调用迁移函数

---

## 🧪 测试验证

完成所有修改后，测试以下场景：

### 场景1: 版本号递增
```
1. 创建标签组 → 检查 version = 1
2. 修改名称 → 检查 version = 2
3. 添加标签 → 检查 version = 3
4. 删除标签组 → 检查 version = 4, isDeleted = true
```

### 场景2: 手动排序保留
```
1. 拖动标签组顺序为 [C, A, B]
2. 检查 displayOrder: C=0, A=1, B=2
3. 刷新页面
4. 验证顺序仍为 [C, A, B]
```

### 场景3: 软删除
```
1. 删除标签组 X
2. 检查 storage 中 X.isDeleted = true
3. 验证 UI 不显示 X
4. 同步到设备B
5. 验证设备B也不显示 X
```

### 场景4: 并发修改
```
1. 设备A: 修改标签组名称 (version 1 → 2)
2. 设备B: 添加标签 (version 1 → 2)
3. 同步后检查 version = 3
4. 验证没有数据丢失
```

---

## 📊 预期效果

完成所有修改后：

| 功能 | 状态 |
|-----|------|
| **版本号管理** | ✅ 自动递增 |
| **软删除** | ✅ 跨设备同步 |
| **手动排序** | ✅ 持久化保存 |
| **冲突检测** | ✅ 版本号机制 |
| **字段级合并** | ✅ 避免覆盖 |
| **数据迁移** | ✅ 一键迁移 |

**整体评分**: 7.5/10 → **9.5/10** 🎉

---

## 💡 提示

1. **逐个修改，测试验证** - 不要一次性修改所有文件
2. **使用版本控制** - 每完成一个任务提交一次
3. **查看控制台日志** - 关注版本号变化的日志
4. **先迁移数据** - 在生产环境部署前先运行迁移

---

**生成时间**: 2025-10-10
**下次更新**: 完成所有修改后
