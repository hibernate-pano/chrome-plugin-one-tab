# OneTab Plus v1.6.0 - 书签管理功能API参考

本文档提供了OneTab Plus v1.6.0版本中书签管理功能所使用的Chrome Bookmarks API的详细参考，以及项目内部API的说明。

## Chrome Bookmarks API

Chrome扩展提供了一套完整的书签管理API，允许扩展程序创建、组织和操作浏览器书签。以下是主要的API方法和事件：

### 权限要求

在使用Chrome Bookmarks API之前，需要在manifest.json中声明权限：

```json
{
  "permissions": ["bookmarks"]
}
```

### 数据类型

#### BookmarkTreeNode

表示书签树中的一个节点（书签或文件夹）。

```typescript
interface BookmarkTreeNode {
  id: string;                 // 节点唯一标识符
  parentId?: string;          // 父节点ID
  index?: number;             // 在父节点中的位置
  url?: string;               // 书签URL（文件夹没有此属性）
  title: string;              // 节点标题
  dateAdded?: number;         // 添加日期（时间戳）
  dateGroupModified?: number; // 文件夹内容最后修改日期（时间戳）
  dateLastUsed?: number;      // 书签最后使用日期（时间戳）
  children?: BookmarkTreeNode[]; // 子节点（仅文件夹有此属性）
}
```

### 方法

#### 获取书签

1. **chrome.bookmarks.getTree()**

   获取完整的书签树。

   ```typescript
   chrome.bookmarks.getTree(
     callback?: (results: BookmarkTreeNode[]) => void
   ): Promise<BookmarkTreeNode[]>;
   ```

   示例：
   ```typescript
   // 使用Promise
   const bookmarkTree = await chrome.bookmarks.getTree();
   
   // 使用回调
   chrome.bookmarks.getTree((results) => {
     console.log('书签树:', results);
   });
   ```

2. **chrome.bookmarks.getSubTree(id)**

   获取指定ID节点及其所有子节点。

   ```typescript
   chrome.bookmarks.getSubTree(
     id: string,
     callback?: (results: BookmarkTreeNode[]) => void
   ): Promise<BookmarkTreeNode[]>;
   ```

   示例：
   ```typescript
   // 获取指定文件夹的子树
   const subTree = await chrome.bookmarks.getSubTree('1');
   ```

3. **chrome.bookmarks.getChildren(id)**

   获取指定ID节点的直接子节点。

   ```typescript
   chrome.bookmarks.getChildren(
     id: string,
     callback?: (results: BookmarkTreeNode[]) => void
   ): Promise<BookmarkTreeNode[]>;
   ```

   示例：
   ```typescript
   // 获取书签栏的子节点
   const bookmarkBarChildren = await chrome.bookmarks.getChildren('1');
   ```

4. **chrome.bookmarks.get(idOrIdList)**

   获取指定ID的节点信息。

   ```typescript
   chrome.bookmarks.get(
     idOrIdList: string | string[],
     callback?: (results: BookmarkTreeNode[]) => void
   ): Promise<BookmarkTreeNode[]>;
   ```

   示例：
   ```typescript
   // 获取单个节点
   const node = await chrome.bookmarks.get('123');
   
   // 获取多个节点
   const nodes = await chrome.bookmarks.get(['123', '456']);
   ```

5. **chrome.bookmarks.search(query)**

   搜索书签。

   ```typescript
   chrome.bookmarks.search(
     query: string | {
       query?: string;
       url?: string;
       title?: string;
     },
     callback?: (results: BookmarkTreeNode[]) => void
   ): Promise<BookmarkTreeNode[]>;
   ```

   示例：
   ```typescript
   // 搜索标题或URL包含"chrome"的书签
   const results = await chrome.bookmarks.search('chrome');
   
   // 高级搜索
   const results = await chrome.bookmarks.search({
     title: 'Google',
     url: 'https://www.google.com'
   });
   ```

6. **chrome.bookmarks.getRecent(numberOfItems)**

   获取最近添加的书签。

   ```typescript
   chrome.bookmarks.getRecent(
     numberOfItems: number,
     callback?: (results: BookmarkTreeNode[]) => void
   ): Promise<BookmarkTreeNode[]>;
   ```

   示例：
   ```typescript
   // 获取最近添加的10个书签
   const recentBookmarks = await chrome.bookmarks.getRecent(10);
   ```

#### 修改书签

1. **chrome.bookmarks.create(bookmark)**

   创建新的书签或文件夹。

   ```typescript
   chrome.bookmarks.create(
     bookmark: {
       parentId?: string;
       index?: number;
       title?: string;
       url?: string;
     },
     callback?: (result: BookmarkTreeNode) => void
   ): Promise<BookmarkTreeNode>;
   ```

   示例：
   ```typescript
   // 创建书签
   const newBookmark = await chrome.bookmarks.create({
     parentId: '1',  // 书签栏
     title: 'Google',
     url: 'https://www.google.com'
   });
   
   // 创建文件夹（不指定URL）
   const newFolder = await chrome.bookmarks.create({
     parentId: '1',
     title: '我的文件夹'
   });
   ```

2. **chrome.bookmarks.update(id, changes)**

   更新书签或文件夹的属性。

   ```typescript
   chrome.bookmarks.update(
     id: string,
     changes: {
       title?: string;
       url?: string;
     },
     callback?: (result: BookmarkTreeNode) => void
   ): Promise<BookmarkTreeNode>;
   ```

   示例：
   ```typescript
   // 更新书签标题
   await chrome.bookmarks.update('123', { title: '新标题' });
   
   // 更新书签URL
   await chrome.bookmarks.update('123', { url: 'https://www.example.com' });
   ```

3. **chrome.bookmarks.move(id, destination)**

   移动书签或文件夹。

   ```typescript
   chrome.bookmarks.move(
     id: string,
     destination: {
       parentId?: string;
       index?: number;
     },
     callback?: (result: BookmarkTreeNode) => void
   ): Promise<BookmarkTreeNode>;
   ```

   示例：
   ```typescript
   // 移动书签到另一个文件夹
   await chrome.bookmarks.move('123', { parentId: '2' });
   
   // 移动书签并指定位置
   await chrome.bookmarks.move('123', { parentId: '2', index: 0 });
   ```

4. **chrome.bookmarks.remove(id)**

   删除书签或空文件夹。

   ```typescript
   chrome.bookmarks.remove(
     id: string,
     callback?: () => void
   ): Promise<void>;
   ```

   示例：
   ```typescript
   // 删除书签
   await chrome.bookmarks.remove('123');
   ```

5. **chrome.bookmarks.removeTree(id)**

   删除文件夹及其所有内容。

   ```typescript
   chrome.bookmarks.removeTree(
     id: string,
     callback?: () => void
   ): Promise<void>;
   ```

   示例：
   ```typescript
   // 删除文件夹及其所有内容
   await chrome.bookmarks.removeTree('456');
   ```

### 事件

1. **chrome.bookmarks.onCreated**

   当创建书签或文件夹时触发。

   ```typescript
   chrome.bookmarks.onCreated.addListener(
     (id: string, bookmark: BookmarkTreeNode) => void
   );
   ```

   示例：
   ```typescript
   chrome.bookmarks.onCreated.addListener((id, bookmark) => {
     console.log(`创建了新书签: ${bookmark.title}`);
   });
   ```

2. **chrome.bookmarks.onRemoved**

   当删除书签或文件夹时触发。

   ```typescript
   chrome.bookmarks.onRemoved.addListener(
     (id: string, removeInfo: {
       parentId: string;
       index: number;
       node: BookmarkTreeNode;
     }) => void
   );
   ```

   示例：
   ```typescript
   chrome.bookmarks.onRemoved.addListener((id, removeInfo) => {
     console.log(`删除了书签: ${removeInfo.node.title}`);
   });
   ```

3. **chrome.bookmarks.onChanged**

   当书签或文件夹的属性变更时触发。

   ```typescript
   chrome.bookmarks.onChanged.addListener(
     (id: string, changeInfo: {
       title: string;
       url?: string;
     }) => void
   );
   ```

   示例：
   ```typescript
   chrome.bookmarks.onChanged.addListener((id, changeInfo) => {
     console.log(`书签已更新: ${changeInfo.title}`);
   });
   ```

4. **chrome.bookmarks.onMoved**

   当书签或文件夹被移动时触发。

   ```typescript
   chrome.bookmarks.onMoved.addListener(
     (id: string, moveInfo: {
       parentId: string;
       index: number;
       oldParentId: string;
       oldIndex: number;
     }) => void
   );
   ```

   示例：
   ```typescript
   chrome.bookmarks.onMoved.addListener((id, moveInfo) => {
     console.log(`书签已移动: 从 ${moveInfo.oldParentId} 到 ${moveInfo.parentId}`);
   });
   ```

5. **chrome.bookmarks.onChildrenReordered**

   当文件夹中的子节点重新排序时触发。

   ```typescript
   chrome.bookmarks.onChildrenReordered.addListener(
     (id: string, reorderInfo: {
       childIds: string[];
     }) => void
   );
   ```

   示例：
   ```typescript
   chrome.bookmarks.onChildrenReordered.addListener((id, reorderInfo) => {
     console.log(`文件夹 ${id} 中的子节点已重新排序`);
   });
   ```

6. **chrome.bookmarks.onImportBegan**

   当开始导入书签时触发。

   ```typescript
   chrome.bookmarks.onImportBegan.addListener(() => void);
   ```

   示例：
   ```typescript
   chrome.bookmarks.onImportBegan.addListener(() => {
     console.log('开始导入书签');
   });
   ```

7. **chrome.bookmarks.onImportEnded**

   当书签导入完成时触发。

   ```typescript
   chrome.bookmarks.onImportEnded.addListener(() => void);
   ```

   示例：
   ```typescript
   chrome.bookmarks.onImportEnded.addListener(() => {
     console.log('书签导入完成');
   });
   ```

## 项目内部API

以下是OneTab Plus v1.6.0中书签管理功能的内部API设计：

### Redux状态管理API

#### 状态结构

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

#### Action Creators

1. **loadBookmarks**

   加载所有书签数据。

   ```typescript
   function loadBookmarks(): ThunkAction;
   ```

2. **executeBookmarkOperation**

   执行书签操作（创建、更新、移动、删除等）。

   ```typescript
   function executeBookmarkOperation(operation: BookmarkOperation): ThunkAction;
   ```

   其中 `BookmarkOperation` 可以是以下类型之一：

   ```typescript
   type BookmarkOperation = 
     | { type: 'CREATE_BOOKMARK'; data: { parentId: string; title: string; url: string; index?: number } }
     | { type: 'UPDATE_BOOKMARK'; data: { id: string; title?: string; url?: string } }
     | { type: 'MOVE_BOOKMARK'; data: { id: string; parentId?: string; index?: number } }
     | { type: 'DELETE_BOOKMARK'; data: { id: string } }
     | { type: 'CREATE_FOLDER'; data: { parentId: string; title: string; index?: number } }
     | { type: 'RENAME_FOLDER'; data: { id: string; title: string } };
   ```

3. **searchBookmarks**

   搜索书签。

   ```typescript
   function searchBookmarks(query: string): ThunkAction;
   ```

4. **selectBookmark**

   选择书签。

   ```typescript
   function selectBookmark(id: string): Action;
   ```

5. **expandFolder**

   展开文件夹。

   ```typescript
   function expandFolder(id: string): Action;
   ```

6. **collapseFolder**

   折叠文件夹。

   ```typescript
   function collapseFolder(id: string): Action;
   ```

7. **setSearchQuery**

   设置搜索查询。

   ```typescript
   function setSearchQuery(query: string): Action;
   ```

8. **clearSearch**

   清除搜索。

   ```typescript
   function clearSearch(): Action;
   ```

### 工具函数API

1. **transformBookmarkTree**

   将Chrome API返回的书签树转换为应用内部格式。

   ```typescript
   function transformBookmarkTree(
     chromeBookmarkTree: chrome.bookmarks.BookmarkTreeNode[]
   ): { 
     nodes: Record<string, BookmarkNode>; 
     rootIds: string[] 
   };
   ```

2. **flattenBookmarkTree**

   扁平化书签树为列表。

   ```typescript
   function flattenBookmarkTree(
     nodes: Record<string, BookmarkNode>, 
     rootIds: string[]
   ): BookmarkNode[];
   ```

3. **searchBookmarkNodes**

   在书签节点中搜索匹配项。

   ```typescript
   function searchBookmarkNodes(
     nodes: Record<string, BookmarkNode>, 
     query: string
   ): string[];
   ```

4. **getBookmarkPath**

   获取书签的完整路径（从根节点到当前节点）。

   ```typescript
   function getBookmarkPath(
     nodes: Record<string, BookmarkNode>, 
     nodeId: string
   ): BookmarkNode[];
   ```

5. **isDescendantOf**

   检查一个节点是否是另一个节点的后代。

   ```typescript
   function isDescendantOf(
     nodes: Record<string, BookmarkNode>, 
     nodeId: string, 
     folderId: string
   ): boolean;
   ```

### 组件Props API

1. **BookmarkManager**

   书签管理主组件。

   ```typescript
   interface BookmarkManagerProps {
     // 无需额外属性
   }
   ```

2. **BookmarkTree**

   书签树组件。

   ```typescript
   interface BookmarkTreeProps {
     nodeIds: string[];
     isSearchResult?: boolean;
   }
   ```

3. **BookmarkFolder**

   书签文件夹组件。

   ```typescript
   interface BookmarkFolderProps {
     folderId: string;
     isRoot?: boolean;
   }
   ```

4. **BookmarkItem**

   书签项组件。

   ```typescript
   interface BookmarkItemProps {
     bookmarkId: string;
   }
   ```

5. **BookmarkSearch**

   书签搜索组件。

   ```typescript
   interface BookmarkSearchProps {
     // 无需额外属性
   }
   ```

6. **BookmarkContextMenu**

   书签上下文菜单组件。

   ```typescript
   interface BookmarkContextMenuProps {
     nodeId: string;
     isFolder: boolean;
     position: { x: number; y: number };
     onClose: () => void;
   }
   ```

7. **BookmarkEditDialog**

   书签编辑对话框组件。

   ```typescript
   interface BookmarkEditDialogProps {
     nodeId: string;
     isFolder: boolean;
     isOpen: boolean;
     onClose: () => void;
   }
   ```

## 使用示例

### 加载书签

```typescript
import { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { loadBookmarks } from '@/store/slices/bookmarkSlice';
import { RootState } from '@/store';

function BookmarkManager() {
  const dispatch = useDispatch();
  const { isLoading, error } = useSelector((state: RootState) => state.bookmarks);
  
  useEffect(() => {
    dispatch(loadBookmarks());
  }, [dispatch]);
  
  if (isLoading) return <div>加载中...</div>;
  if (error) return <div>错误: {error}</div>;
  
  return (
    // 渲染书签管理界面
  );
}
```

### 创建书签

```typescript
import { useDispatch } from 'react-redux';
import { executeBookmarkOperation } from '@/store/slices/bookmarkSlice';

function AddBookmarkButton({ folderId }: { folderId: string }) {
  const dispatch = useDispatch();
  
  const handleAddBookmark = () => {
    const title = prompt('请输入书签标题:');
    const url = prompt('请输入书签URL:');
    
    if (title && url) {
      dispatch(executeBookmarkOperation({
        type: 'CREATE_BOOKMARK',
        data: {
          parentId: folderId,
          title,
          url
        }
      }));
    }
  };
  
  return (
    <button onClick={handleAddBookmark}>添加书签</button>
  );
}
```

### 搜索书签

```typescript
import { useState, useEffect } from 'react';
import { useDispatch } from 'react-redux';
import { searchBookmarks, clearSearch } from '@/store/slices/bookmarkSlice';

function BookmarkSearch() {
  const dispatch = useDispatch();
  const [query, setQuery] = useState('');
  
  useEffect(() => {
    const timer = setTimeout(() => {
      if (query.trim()) {
        dispatch(searchBookmarks(query));
      } else {
        dispatch(clearSearch());
      }
    }, 300);
    
    return () => clearTimeout(timer);
  }, [query, dispatch]);
  
  return (
    <div>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜索书签..."
      />
      {query && (
        <button onClick={() => setQuery('')}>清除</button>
      )}
    </div>
  );
}
```

### 展开/折叠文件夹

```typescript
import { useDispatch, useSelector } from 'react-redux';
import { expandFolder, collapseFolder } from '@/store/slices/bookmarkSlice';
import { RootState } from '@/store';

function FolderToggle({ folderId }: { folderId: string }) {
  const dispatch = useDispatch();
  const { expandedFolderIds } = useSelector((state: RootState) => state.bookmarks);
  
  const isExpanded = expandedFolderIds.includes(folderId);
  
  const handleToggle = () => {
    if (isExpanded) {
      dispatch(collapseFolder(folderId));
    } else {
      dispatch(expandFolder(folderId));
    }
  };
  
  return (
    <button onClick={handleToggle}>
      {isExpanded ? '折叠' : '展开'}
    </button>
  );
}
```

## 注意事项

1. **权限处理**：
   - 确保在manifest.json中声明了"bookmarks"权限
   - 处理用户可能拒绝权限的情况

2. **错误处理**：
   - 捕获并处理Chrome API可能抛出的错误
   - 提供用户友好的错误提示

3. **性能考虑**：
   - 对于大量书签，考虑分批加载或虚拟滚动
   - 优化搜索性能，使用防抖动机制

4. **事件监听**：
   - 监听Chrome书签API的事件，保持UI与实际书签数据的同步
   - 在组件卸载时移除事件监听器

5. **用户体验**：
   - 提供加载状态和错误反馈
   - 实现平滑的动画和过渡效果
