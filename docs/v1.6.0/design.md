# OneTab Plus v1.6.0 - 书签管理功能设计文档

## 架构设计

### 整体架构

OneTab Plus v1.6.0的书签管理功能将基于现有的标签管理架构进行扩展，保持一致的代码结构和设计模式。整体架构如下：

```
├── 前端界面 (React + TypeScript)
│   ├── 书签管理组件
│   ├── 书签操作组件
│   └── 书签搜索组件
├── 状态管理 (Redux)
│   ├── 书签状态切片
│   └── 书签操作动作
├── 存储层
│   └── Chrome Bookmarks API 接口
└── 浏览器交互层
    └── Chrome Extension API
```

### 数据流

1. **数据获取流程**：
   - 通过Chrome Bookmarks API获取书签数据
   - 将数据转换为应用内部格式并存储在Redux状态中
   - 组件从Redux状态中读取数据并渲染

2. **数据操作流程**：
   - 用户在UI上执行操作
   - 触发Redux动作
   - Redux中间件调用Chrome Bookmarks API
   - API操作完成后更新Redux状态
   - 组件重新渲染以反映变化

## 数据模型

### 书签节点 (BookmarkNode)

```typescript
interface BookmarkNode {
  id: string;           // 书签唯一标识符
  title: string;        // 书签标题
  url?: string;         // 书签URL，文件夹没有此属性
  parentId?: string;    // 父节点ID
  index: number;        // 在父节点中的位置
  dateAdded?: number;   // 添加日期（时间戳）
  dateLastUsed?: number; // 最后使用日期（时间戳）
  children?: BookmarkNode[]; // 子节点（仅文件夹有此属性）
  isFolder: boolean;    // 是否为文件夹
  favicon?: string;     // 网站图标URL
}
```

### 书签状态 (BookmarkState)

```typescript
interface BookmarkState {
  nodes: Record<string, BookmarkNode>; // 所有书签节点的映射
  rootNodeIds: string[];              // 根节点ID列表
  selectedNodeId: string | null;      // 当前选中的节点ID
  expandedFolderIds: string[];        // 已展开的文件夹ID列表
  searchQuery: string;                // 搜索查询
  searchResults: string[];            // 搜索结果（节点ID列表）
  isLoading: boolean;                 // 加载状态
  error: string | null;               // 错误信息
  lastSync: number | null;            // 最后同步时间
}
```

## 组件设计

### 主要组件

1. **BookmarkManager**：书签管理的主容器组件
   - 负责整体布局和状态管理
   - 包含搜索栏、书签树和操作按钮

2. **BookmarkTree**：书签树状视图组件
   - 递归渲染书签和文件夹的层次结构
   - 处理展开/折叠逻辑

3. **BookmarkItem**：单个书签项组件
   - 显示书签的图标、标题和URL
   - 处理点击、右键菜单等交互

4. **BookmarkFolder**：书签文件夹组件
   - 显示文件夹图标、名称和书签计数
   - 处理展开/折叠和拖放操作

5. **BookmarkSearch**：书签搜索组件
   - 提供搜索输入框和清除按钮
   - 处理搜索逻辑和结果显示

6. **BookmarkContextMenu**：书签上下文菜单组件
   - 提供书签和文件夹的操作选项
   - 处理各种操作的触发

7. **BookmarkEditDialog**：书签编辑对话框
   - 提供编辑书签属性的表单
   - 处理保存和取消操作

### 组件层次结构

```
BookmarkManager
├── BookmarkHeader
│   ├── NavigationTabs (标签页/书签切换)
│   └── BookmarkSearch
├── BookmarkToolbar
│   ├── CreateButton
│   ├── ImportButton
│   ├── ExportButton
│   └── ViewToggle (列表/树状视图切换)
├── BookmarkTree / BookmarkList
│   ├── BookmarkFolder
│   │   └── BookmarkItem
│   └── BookmarkItem
└── BookmarkContextMenu
    └── BookmarkEditDialog
```

## 状态管理

### Redux切片

1. **bookmarkSlice**：管理书签相关状态
   - 初始化书签数据
   - 处理书签的增删改查操作
   - 管理书签的展开/折叠状态
   - 处理书签搜索功能

### 主要动作

1. **加载书签**：
   - `loadBookmarks`: 从Chrome API加载所有书签
   - `loadBookmarksSuccess`: 加载成功后更新状态
   - `loadBookmarksFailure`: 处理加载失败

2. **书签操作**：
   - `createBookmark`: 创建新书签
   - `updateBookmark`: 更新书签属性
   - `moveBookmark`: 移动书签位置
   - `deleteBookmark`: 删除书签
   - `createFolder`: 创建新文件夹
   - `renameFolder`: 重命名文件夹

3. **UI状态**：
   - `selectBookmark`: 选择书签
   - `expandFolder`: 展开文件夹
   - `collapseFolder`: 折叠文件夹
   - `setSearchQuery`: 设置搜索查询
   - `clearSearch`: 清除搜索

## API集成

### Chrome Bookmarks API

将使用Chrome提供的Bookmarks API进行书签操作：

1. **获取书签**：
   - `chrome.bookmarks.getTree()`: 获取完整书签树
   - `chrome.bookmarks.search()`: 搜索书签

2. **操作书签**：
   - `chrome.bookmarks.create()`: 创建书签或文件夹
   - `chrome.bookmarks.update()`: 更新书签属性
   - `chrome.bookmarks.move()`: 移动书签位置
   - `chrome.bookmarks.remove()`: 删除单个书签
   - `chrome.bookmarks.removeTree()`: 删除文件夹及其内容

3. **事件监听**：
   - `chrome.bookmarks.onCreated`: 书签创建事件
   - `chrome.bookmarks.onRemoved`: 书签删除事件
   - `chrome.bookmarks.onChanged`: 书签修改事件
   - `chrome.bookmarks.onMoved`: 书签移动事件

## 用户界面设计

### 布局设计

1. **导航区域**：
   - 位于顶部，包含标签页和书签切换选项卡
   - 包含搜索框和操作按钮

2. **书签树区域**：
   - 占据主要内容区域
   - 支持单列和双列布局
   - 显示书签的层次结构

3. **操作区域**：
   - 右键菜单提供上下文操作
   - 悬浮按钮提供快速操作

### 交互设计

1. **书签操作**：
   - 单击书签：打开书签链接
   - 右键书签：显示上下文菜单
   - 拖放书签：移动书签位置

2. **文件夹操作**：
   - 单击文件夹：展开/折叠文件夹
   - 右键文件夹：显示上下文菜单
   - 拖放文件夹：移动文件夹位置

3. **搜索交互**：
   - 输入搜索词：实时显示匹配结果
   - 清除搜索：返回完整书签树

## 性能优化

1. **数据加载优化**：
   - 使用虚拟滚动处理大量书签
   - 实现懒加载机制，仅在需要时展开文件夹

2. **搜索优化**：
   - 实现防抖动机制，避免频繁搜索
   - 优化搜索算法，提高大量书签时的搜索性能

3. **渲染优化**：
   - 使用React.memo和useMemo减少不必要的重渲染
   - 优化组件更新逻辑，仅在数据变化时重新渲染

## 错误处理

1. **API错误**：
   - 捕获并处理Chrome Bookmarks API的错误
   - 提供用户友好的错误提示

2. **用户操作错误**：
   - 验证用户输入，防止无效操作
   - 提供操作确认机制，防止误操作

3. **恢复机制**：
   - 实现操作撤销功能
   - 提供错误恢复选项

## 测试策略

1. **单元测试**：
   - 测试Redux动作和reducer
   - 测试工具函数和辅助方法

2. **组件测试**：
   - 测试UI组件的渲染和交互
   - 测试组件的边界条件

3. **集成测试**：
   - 测试与Chrome Bookmarks API的集成
   - 测试完整的用户流程

4. **性能测试**：
   - 测试大量书签时的加载和渲染性能
   - 测试搜索功能的响应时间

## 实现计划

1. **阶段一：基础架构**
   - 设置Redux状态管理
   - 实现Chrome Bookmarks API的封装
   - 创建基本UI组件框架

2. **阶段二：核心功能**
   - 实现书签树的显示和导航
   - 实现基本的书签操作（打开、创建、编辑、删除）
   - 实现文件夹的展开/折叠功能

3. **阶段三：高级功能**
   - 实现书签搜索功能
   - 实现拖放重排功能
   - 实现书签导入/导出功能

4. **阶段四：优化和完善**
   - 性能优化
   - UI/UX改进
   - 错误处理和边界情况处理
   - 添加键盘快捷键支持
