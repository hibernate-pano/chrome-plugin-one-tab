# OneTab Plus - 标签管理器文档 (v1.5.10)

## 项目概述

OneTab Plus 是一个 Chrome 浏览器扩展，用于高效管理和组织浏览器标签页。它允许用户一键保存所有打开的标签页，将它们转换为列表形式保存，从而减少浏览器的内存占用。用户可以随时恢复这些标签页，或者有选择地打开其中的部分标签页。

## 功能列表

### 核心功能

- **保存标签页**：

  - 保存当前窗口的所有标签页
  - 保存当前活动的标签页
  - 自动过滤 Chrome 内部页面（chrome://）和扩展页面（chrome-extension://）
  - 可配置是否允许保存重复的标签页

- **标签组管理**：

  - 创建标签组
  - 重命名标签组（点击重命名按钮或双击标签组名称）
  - 锁定/解锁标签组（锁定后的标签组在恢复标签页时不会被删除，也不能重命名）
  - 删除标签组
  - 恢复标签组中的所有标签页

- **标签页管理**：

  - 恢复单个标签页
  - 删除单个标签页
  - 拖放重新排序标签页
  - 在标签组之间移动标签页
  - 清理重复标签页

- **搜索功能**：

  - 搜索标签页标题和 URL
  - 实时搜索结果显示
  - 只显示匹配的标签，而不是整个标签组

- **数据导入/导出**：
  - 导出所有标签组数据为 JSON 文件
  - 导入 JSON 格式的标签组数据
  - 导出数据为 OneTab 格式，与原版 OneTab 兼容
  - 导入 OneTab 格式的数据，支持从原版 OneTab 迁移

### 云端同步功能

- **用户认证**：

  - 用户注册和登录
  - 邮箱/密码认证
  - 会话管理
  - 30天认证缓存，减少重新登录频率

- **数据同步**：

  - 自动同步标签组和设置到云端
  - 多设备间数据同步
  - 实时双向同步，使用 Supabase Realtime 技术
  - 标签拖拽操作的实时同步
  - 智能合并算法处理冲突
  - 自定义同步频率
  - JSONB 格式存储数据，提高性能

- **数据压缩与加密**：
  - 使用 LZ-string 压缩数据
  - 减少网络使用和提高同步速度
  - 压缩统计信息显示
  - 使用 AES-GCM 算法加密云端数据
  - 基于用户ID生成唯一加密密钥
  - 兼容处理旧版明文数据

### 用户偏好

- **标签管理偏好**：

  - 自定义标签组命名模板
  - 显示/隐藏网站图标
  - 显示/隐藏标签计数
  - 删除前确认
  - 允许/禁止重复标签页

- **主题选项**：

  - 浅色模式：始终使用浅色主题
  - 深色模式：始终使用深色主题
  - 自动模式：根据系统设置自动切换深色/浅色主题

- **同步选项**：
  - 冲突解决策略
  - 删除策略

## 技术架构

### 前端技术栈

- **核心框架**：React 18
- **状态管理**：Redux Toolkit
- **路由**：React Router
- **样式**：Tailwind CSS
- **类型检查**：TypeScript
- **构建工具**：Vite
- **拖放功能**：React DnD

### 后端技术栈

- **后端服务**：Supabase
- **数据库**：PostgreSQL
- **认证**：Supabase Auth
- **存储**：Supabase Storage

### 浏览器扩展

- **扩展框架**：Chrome Extension Manifest V3
- **构建插件**：@crxjs/vite-plugin

## 项目结构

```
chrome-plugin-one-tab/
├── dist/                  # 构建输出目录
├── docs/                  # 项目文档
├── public/                # 静态资源
│   └── icons/             # 扩展图标
├── src/                   # 源代码
│   ├── auth/              # 认证相关页面
│   ├── background/        # 后台脚本
│   ├── components/        # React 组件
│   │   ├── auth/          # 认证相关组件
│   │   ├── dnd/           # 拖放相关组件
│   │   ├── layout/        # 布局组件
│   │   └── sync/          # 同步相关组件
│   ├── popup/             # 弹出窗口
│   ├── services/          # 服务
│   ├── store/             # Redux 存储
│   │   └── slices/        # Redux 切片
│   ├── types/             # TypeScript 类型定义
│   └── utils/             # 工具函数
├── .env.example           # 环境变量示例文件
├── manifest.json          # 扩展清单文件
└── package.json           # 项目依赖
```

## 数据模型

### 标签 (Tab)

```typescript
interface Tab {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  createdAt: string;
  lastAccessed: string;
  group_id?: string;

  // 同步相关字段
  syncStatus?: 'synced' | 'local-only' | 'remote-only' | 'conflict';
  lastSyncedAt?: string | null;
  isDeleted?: boolean;
}
```

### 标签组 (TabGroup)

```typescript
interface TabGroup {
  id: string;
  name: string;
  tabs: Tab[];
  createdAt: string;
  updatedAt: string;
  isLocked: boolean;
  user_id?: string;
  device_id?: string;
  last_sync?: string;

  // 同步相关字段
  syncStatus?: 'synced' | 'local-only' | 'remote-only' | 'conflict';
  lastSyncedAt?: string | null;
  isDeleted?: boolean;
}
```

### 用户设置 (UserSettings)

```typescript
interface UserSettings {
  autoCloseTabsAfterSaving: boolean;
  groupNameTemplate: string;
  showFavicons: boolean;
  showTabCount: boolean;
  confirmBeforeDelete: boolean;
  allowDuplicateTabs: boolean;
  syncEnabled: boolean;

  // 同步策略设置
  syncStrategy: 'newest' | 'local' | 'remote' | 'ask';
  deleteStrategy: 'everywhere' | 'local-only';

  // 主题设置
  themeMode: 'light' | 'dark' | 'auto';
}
```

## 核心功能实现

### 标签保存

标签保存功能通过 Chrome Extension API 实现，主要使用 `chrome.tabs.query` 获取当前窗口的所有标签页，然后将它们保存到本地存储中。

```typescript
// 保存当前窗口的所有标签页
const saveAllTabs = async () => {
  const tabs = await chrome.tabs.query({ currentWindow: true });

  // 过滤掉 Chrome 内部页面和扩展页面
  const filteredTabs = tabs.filter(tab => {
    return !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://');
  });

  // 创建新的标签组
  const newGroup = {
    id: nanoid(),
    name: generateGroupName(),
    tabs: filteredTabs.map(tab => ({
      id: nanoid(),
      url: tab.url,
      title: tab.title,
      favicon: tab.favIconUrl,
      createdAt: new Date().toISOString(),
      lastAccessed: new Date().toISOString(),
    })),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isLocked: false,
  };

  // 保存到 Redux 存储
  dispatch(addGroup(newGroup));

  // 如果设置了保存后自动关闭标签页
  if (settings.autoCloseTabsAfterSaving) {
    await closeTabs(filteredTabs.map(tab => tab.id));
  }
};
```

### 标签组管理

标签组管理功能通过 Redux 实现，使用 Redux Toolkit 创建切片和 reducer。

```typescript
const tabSlice = createSlice({
  name: 'tabs',
  initialState,
  reducers: {
    addGroup: (state, action) => {
      state.groups.unshift(action.payload);
    },
    removeGroup: (state, action) => {
      state.groups = state.groups.filter(group => group.id !== action.payload);
    },
    renameGroup: (state, action) => {
      const { id, name } = action.payload;
      const group = state.groups.find(group => group.id === id);
      if (group) {
        group.name = name;
        group.updatedAt = new Date().toISOString();
      }
    },
    toggleLockGroup: (state, action) => {
      const group = state.groups.find(group => group.id === action.payload);
      if (group) {
        group.isLocked = !group.isLocked;
        group.updatedAt = new Date().toISOString();
      }
    },
  },
});
```

### 拖放功能

拖放功能使用 React DnD 库实现，允许用户重新排序标签页和标签组，以及在标签组之间移动标签页。

```typescript
// 标签拖放处理
const [{ isDragging }, drag] = useDrag({
  type: 'TAB',
  item: { id: tab.id, groupId: groupId },
  collect: monitor => ({
    isDragging: monitor.isDragging(),
  }),
});

const [{ isOver }, drop] = useDrop({
  accept: 'TAB',
  drop: item => {
    if (item.id !== tab.id) {
      dispatch(
        moveTabAndSync({
          sourceGroupId: item.groupId,
          sourceIndex: item.index,
          targetGroupId: groupId,
          targetIndex: index,
        })
      );
    }
  },
  collect: monitor => ({
    isOver: monitor.isOver(),
  }),
});
```

### 搜索功能

搜索功能通过 Redux 实现，使用 Redux Toolkit 创建切片和 reducer。

```typescript
const tabSlice = createSlice({
  name: 'tabs',
  initialState,
  reducers: {
    setSearchQuery: (state, action) => {
      state.searchQuery = action.payload;
    },
  },
});

// 搜索结果选择器
export const selectSearchResults = createSelector(
  [selectGroups, selectSearchQuery],
  (groups, searchQuery) => {
    if (!searchQuery) return [];

    const results = [];

    groups.forEach(group => {
      const matchingTabs = group.tabs.filter(tab => {
        const titleMatch = tab.title.toLowerCase().includes(searchQuery.toLowerCase());
        const urlMatch = tab.url.toLowerCase().includes(searchQuery.toLowerCase());
        return titleMatch || urlMatch;
      });

      if (matchingTabs.length > 0) {
        results.push({
          groupId: group.id,
          groupName: group.name,
          tabs: matchingTabs,
        });
      }
    });

    return results;
  }
);
```

### 云端同步

云端同步功能使用 Supabase 实现，通过 Supabase Auth 进行用户认证，通过 Supabase PostgreSQL 数据库存储标签组数据。

```typescript
// 上传标签组到云端
async uploadTabGroups(groups: TabGroup[]) {
  const deviceId = await getDeviceId();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) throw new Error('用户未登录');

  // 压缩标签组数据
  const { compressed, stats } = compressTabGroups(groups);

  const groupsWithUser = groups.map(group => ({
    id: group.id,
    name: group.name,
    created_at: group.createdAt,
    updated_at: group.updatedAt,
    is_locked: group.isLocked,
    user_id: user.id,
    device_id: deviceId,
    last_sync: new Date().toISOString()
  }));

  // 为第一个标签组添加压缩数据
  if (groupsWithUser.length > 0) {
    groupsWithUser[0].compressed_data = compressed;
  }

  // 上传到 Supabase
  const { data, error } = await supabase
    .from('tab_groups')
    .upsert(groupsWithUser, { onConflict: 'id' });

  if (error) {
    throw error;
  }

  return { result: data, compressionStats: stats };
}
```

## 开发指南

### 环境设置

1. 克隆仓库：

   ```
   git clone https://github.com/hibernate-pano/chrome-plugin-one-tab.git
   ```

2. 安装依赖：

   ```
   pnpm install
   ```

3. 启动开发服务器：

   ```
   pnpm dev
   ```

4. 构建扩展：
   ```
   pnpm build
   ```

### 加载扩展

1. 打开 Chrome 浏览器，进入扩展管理页面 (`chrome://extensions/`)
2. 启用开发者模式
3. 点击"加载已解压的扩展程序"
4. 选择项目的 `dist` 目录

### 调试扩展

1. 后台脚本调试：

   - 在扩展管理页面点击"背景页"链接
   - 使用 Chrome DevTools 调试

2. 弹出窗口调试：

   - 右键点击扩展图标，选择"检查弹出内容"
   - 使用 Chrome DevTools 调试

3. 标签页调试：
   - 打开扩展的标签页
   - 按 F12 打开 DevTools
   - 使用 Chrome DevTools 调试

## 贡献指南

1. Fork 仓库
2. 创建功能分支：`git checkout -b feature/your-feature-name`
3. 提交更改：`git commit -m 'Add some feature'`
4. 推送到分支：`git push origin feature/your-feature-name`
5. 提交 Pull Request

## 许可证

本项目采用 MIT 许可证。详见 [LICENSE](../LICENSE) 文件。
