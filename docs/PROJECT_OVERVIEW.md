# TabStack 项目总览

> **当前版本**: v1.11.8
> **仓库路径**: `/Users/panbo/Code/Demos/chrome-plugin-one-tab`
> **文档生成时间**: 2026-06-01
> **调研覆盖**: 8 个维度，700+ 个源文件读取，48 万 token 投入

---

## 0. 一句话总结（30 秒读完）

**TabStack 是一款 Chrome Manifest V3 扩展，把"几十个并行标签页"收进可命名、可搜索、可同步、可恢复的"工作会话"。**

- **形态**：React 18 + TypeScript + Redux Toolkit + Tailwind + Supabase 的 Chrome 扩展（Popup 入口 + Service Worker 后台，无 content script）
- **品牌**：原名 OneTab Plus → TabVault Pro → **TabStack**（2026-05-26 改名，仍有 README/PRIVACY_POLICY 残留旧名）
- **状态**：代码层已"产品级硬化"完成，但 Chrome Web Store 提交被 3 个收尾任务卡住（截图、品牌一致性、dist 残留）

---

## 1. 产品定位（维度 1）

### 1.1 名字与品牌

| 项 | 值 | 备注 |
|---|---|---|
| 对外品牌 | **TabStack** | manifest.json、图标组件已统一 |
| 仓库 / npm 包名 | `chrome-plugin-one-tab` | 保持不变 |
| 历史曾用名 | OneTab Plus → TabVault Pro → TabStack | 两次品牌升级 |
| README 标题 | TabVault Pro | **与 manifest 不一致，待统一** |
| 设计系统目录 | `design-system/tabvault-pro/MASTER.md` | 旧名残留 |
| `.env.example` VITE_APP_NAME | TabVault Pro | 旧名残留 |

### 1.2 一句话定位

> **Save the session. Find it later. Restore it when you need it.**
> 浏览器工作会话保险箱——把当前窗口一键保存为可找回、可恢复的工作现场。

### 1.3 目标用户

| 角色 | 痛点 |
|---|---|
| **开发者** | 文档 / PR / Issue / 控制台 / 监控并存，几十个标签 |
| **研究者** | 论文 / 论坛 / 竞品 / 视频 / 资料长时间并行 |
| **内容作者** | 选题 / 草稿 / 引用 / 素材反复切换 |
| **商务用户** | CRM / 表格 / 邮件 / 公司页需要保持上下文 |

### 1.4 核心价值主张

1. **一键保存整个窗口**——告别浏览器标签海洋
2. **8 套主题 + 3 组快捷键**——保存/恢复成为肌肉记忆
3. **本地优先 + 可选云同步**——AES-GCM 客户端加密，手动触发，不后台持续上传
4. **OneTab 格式兼容 + JSON 导入导出**——用户不被锁定

### 1.5 关键功能清单

- 一键保存当前窗口为会话（`Ctrl+Shift+S` 打开 / `Alt+Shift+S` 保存全部 / `Alt+S` 保存当前）
- 智能搜索：按会话名 / 备注 / 标签标题 / URL 快速找回
- 一键恢复：在新窗口恢复整个会话，不打乱当前窗口
- 会话管理：重命名 / 备注 / 收藏 / 锁定 / 删除 / 拖拽排序
- 云同步：登录后手动上传/下载；v1.11.8 已接入 Redux 中间件实现"保存/删除/重命名"后的**自动同步**
- 使用统计：会话数 / 标签数 / 常用域名 / 本周活动
- 8 套主题：原始 / 经典 / 极光 / 奶油 / 粉红 / 薄荷 / 赛博 / 棱镜
- 导入导出：JSON + OneTab 格式兼容

### 1.6 权限与快捷键

**Chrome 权限**：`tabs` / `storage` / `unlimitedStorage` / `notifications` / `contextMenus` / `alarms` + `host_permissions: https://reccclnaxadbuccsrwmg.supabase.co/*`

**manifest commands**：
- `_execute_action` → `Ctrl+Shift+S`（mac: `Cmd+Shift+S`）打开弹窗
- `save_all_tabs` → `Alt+Shift+S`
- `save_current_tab` → `Alt+S`

### 1.7 隐私姿态

- **本地默认**：会话与设置存于 Chrome 扩展存储（IndexedDB）
- **云端**：仅在用户显式登录并手动触发同步时，使用 AES-GCM 客户端加密后传输到 Supabase
- **不进行任何后台自动同步**（除了用户操作触发的智能同步，但本质是用户行为驱动）
- **不与广告主或无关第三方共享数据**
- 用户完全控制本地数据删除；云端数据在用户主动删除前持续保留
- 受影响的网络访问点仅限：注册/登录/登出/邮箱验证/手动上传/手动下载

---

## 2. 技术架构（维度 2）

### 2.1 技术栈一览

| 层 | 选型 | 版本 |
|---|---|---|
| 框架 | React + TypeScript | 18.2 / 5.4 strict |
| 状态 | Redux Toolkit + react-redux | 2.2 / 9.1 |
| 拖拽 | react-dnd + react-dnd-html5-backend | 16（注：package.json 中有 @dnd-kit，但**实际未使用**——已迁移到 react-dnd） |
| 样式 | Tailwind CSS + PostCSS + autoprefixer | 3.4 / 8.x |
| 后端 | Supabase（Postgres + Auth + Storage） | 2.49 |
| 加密 | Web Crypto API（AES-GCM 256 + PBKDF2 100k 轮） | 原生 |
| 构建 | Vite + @crxjs/vite-plugin | 4.5 / 2.0-beta.21 |
| 测试 | `node --test --experimental-strip-types` | Node 22+ |
| 包管理 | pnpm | 10.24.0 |

### 2.2 Chrome Extension 形态

```
┌──────────────────────────────────────────────┐
│  popup.html (壳)                              │
│    └─ meta refresh → src/popup/index.html     │
│                                              │
│  src/popup/index.html (主 React 挂载点)        │
│    └─ React.StrictMode + Redux Provider       │
│    └─ AppContainer                            │
│       ├─ ErrorBoundary                       │
│       ├─ ToastProvider                       │
│       ├─ ThemeProvider                       │
│       └─ AuthProvider                        │
│          └─ MainApp (lazy 拆分大组件)         │
│                                              │
│  src/auth/confirm.html (Supabase 邮箱验证回调) │
│                                              │
│  src/service-worker.ts (MV3 后台, type:module) │
│    ├─ onInstalled/onStartup                   │
│    ├─ chrome.contextMenus                     │
│    ├─ chrome.commands 快捷键                  │
│    ├─ chrome.alarms 30min 静默同步            │
│    └─ chrome.runtime.onMessage 消息路由        │
│       (OPEN_TAB / OPEN_TABS /                 │
│        SAVE_ALL_TABS / REFRESH_TAB_LIST)      │
└──────────────────────────────────────────────┘
```

**无 content script**——所有交互通过 popup + service worker 完成。

### 2.3 src/ 目录树（按职责组织）

```
src/
├── background/        # service worker 共享的 chrome API 封装
│   └── TabManager.ts  # 单例: query/create/remove/notify
├── popup/             # Popup UI 入口
├── auth/              # 邮箱确认回调页
├── services/          # 领域工作流编排
│   ├── smartSyncService.ts         # 单例: 2min 冷却 + 并发锁
│   ├── tabSyncWorkflow.ts          # upload/download 两段式
│   ├── tabGroupSyncService.ts      # 包装 supabase sync
│   ├── settingsSyncService.ts      # 用户设置同步
│   └── syncService.ts              # 手动 sync 入口
├── store/             # Redux 状态
│   ├── slices/
│   │   ├── tabSlice.ts     # 18 个 createAsyncThunk
│   │   ├── settingsSlice.ts
│   │   └── authSlice.ts
│   └── middleware/
│       └── autoSyncMiddleware.ts  # 优先级防抖触发云同步
├── domain/            # 纯函数业务逻辑(无 React/Redux 依赖)
│   └── tabGroup/
│       ├── factory.ts          # createTabGroupFromChromeTabs
│       ├── filters.ts          # filterValidTabs
│       └── sessionName.ts      # deriveSessionNameFromChromeTabs
├── storage/           # 持久化抽象层
│   ├── storageAdapter.ts       # pickBackend + migrate
│   ├── indexedDbClient.ts      # IDBDatabase 单例
│   ├── localStorageFallback.ts # 降级
│   └── types.ts                # StorageDriver 接口
├── utils/             # 通用工具集(33 个文件)
│   ├── supabase.ts             # 客户端 + auth/sync 命名空间
│   ├── encryptionUtils.ts      # PBKDF2 + AES-GCM 256
│   ├── secureStorage.ts        # 敏感 key 加密
│   ├── storage.ts              # ChromeStorage 门面
│   ├── oneTabFormatParser.ts   # 兼容 OneTab
│   ├── inputValidation.ts      # 表单安全
│   ├── performance*.ts         # 性能监控三件套
│   └── ...
├── types/             # 领域类型单一来源
│   └── tab.ts         # Tab / TabGroup / SupabaseTabGroup / UserSettings
├── components/        # UI 组件(按功能分子目录)
│   ├── app/           # AppContainer / MainApp / AuthProvider
│   ├── layout/        # Header / TabCounter / 主题切换
│   ├── tabs/          # TabGroup / TabList / TabPreview / ReorderView
│   ├── dnd/           # DndProvider / DraggableTab
│   ├── search/        # SearchBar / SearchResultList
│   ├── auth/          # Login/Register/UserProfile
│   ├── sync/          # SyncStatus / SyncButton
│   ├── stats/         # StatsPanel
│   ├── onboarding/    # OnboardingGuide / Spotlight
│   ├── common/        # EmptyState / ModalFrame / Toast 等
│   └── performance/   # PerformanceTest
├── hooks/             # React 复用钩子
│   ├── useDebounce
│   ├── useDebouncedSearch
│   ├── useKeyboardNavigation   # 焦点陷阱
│   └── useKeyboardShortcuts
├── contexts/          # React Context
│   ├── ThemeContext.tsx        # 主题模式 + 风格
│   └── ToastContext.tsx        # 通知
├── lib/               # 工具函数(cn)
└── styles/            # 全局 CSS + 主题 CSS
    └── themes/        # 8 套主题 CSS
```

### 2.4 依赖方向

```
components → contexts/hooks/store → services → domain + utils → storage/supabase
type-only types/tab.ts 被全栈共享(最底层)
```

**严格自顶向下，无反向依赖**。

### 2.5 关键架构模式

1. **MV3 分层架构**：popup（状态/UI 中心）+ service worker（事件/数据入口） + 共享加密 KV 存储
2. **Redux Toolkit 切片化**：3 slice + 18 createAsyncThunk + 1 middleware
3. **单例服务**：TabManager / smartSyncService / supabase client / CacheManager
4. **Repository 模式**：StorageDriver 接口 + indexedDbDriver / localStorageDriver
5. **Service / Workflow 编排**：tabSyncWorkflow 两段式 + progress reporter + strategy 注入
6. **Provider 树**：ErrorBoundary → Toast → Theme → Auth → MainApp → DnD
7. **乐观写入 + 防抖落盘 + TTL 缓存**：三级一致性
8. **多版本加密兼容**：PBKDF2 V2 + SHA-256 V1，通过前缀 `ENCRYPTED_V1:` / `ENCRYPTED_V2_S:` / `ENCRYPTED_V2_D:` 路由
9. **软删除 + version 字段**：跨设备同步不丢失状态
10. **领域驱动分层**：types → domain（纯函数）→ services → store → components

### 2.6 构建产物

| Chunk | 内容 |
|---|---|
| `src/popup/index-[hash].js` | 主 React 应用 |
| `popup-[hash].js` | 重定向壳 |
| `confirm-[hash].js` | 邮箱确认 |
| `service-worker.js` | MV3 后台（无 hash，模块化） |
| `react-vendor` | react / react-dom / react-redux |
| `redux-vendor` | @reduxjs/toolkit |
| `supabase-vendor` | @supabase/supabase-js |
| `utils` | src/utils 合并 |

`base: './'`（相对路径避免 Chrome 扩展绝对路径问题）。`esbuild` 在 production 下 drop `console` / `debugger`。Vite 自定义 `restore-manifest` 插件在 `closeBundle` 钩子中把 `background.service_worker` 写回 `dist/manifest.json`（crx 插件对 service worker 处理有 bug 的 workaround）。

---

## 3. 状态管理与数据流（维度 3）

### 3.1 Redux Store 结构

**只在 popup 端创建**（`src/popup/index.tsx`），service-worker **不持有 store**——它通过直接读写同一份 IndexedDB 与 popup 解耦通信。

```typescript
configureStore({
  reducer: {
    tabs: tabSlice,       // 标签组状态
    settings: settingsSlice, // 用户设置
    auth: authSlice,      // 认证状态
  },
  middleware: (getDefault) =>
    getDefault({
      serializableCheck: {
        ignoredActionPaths: ['payload.tab', 'payload.tabs'],
        ignoredPaths: ['tabs.currentTab'],
      },
    }).concat(autoSyncMiddleware),
})
```

### 3.2 三个 Slice 详解

#### `tabSlice`（src/store/slices/tabSlice.ts）

**State**:
```typescript
{
  groups: TabGroup[],
  activeGroupId: string | null,
  isLoading: boolean,
  error: string | null,
  searchQuery: string,
  syncStatus: 'idle' | 'syncing' | 'success' | 'error',
  lastSyncTime: string | null,
  backgroundSync: boolean,    // 区分前后台同步,UI 不抖
  syncProgress: number,        // 0-100
  syncOperation: 'none' | 'upload' | 'download',
}
```

**18 个 createAsyncThunk**：
- 基础 CRUD：`loadGroups` / `saveGroup` / `updateGroup` / `deleteGroup`（软删）/ `deleteAllGroups` / `importGroups`
- 同步：`syncTabsToCloud` / `syncTabsFromCloud` / `syncLocalChangesToCloud`
- 用户操作：`updateGroupNameAndSync` / `toggleGroupLockAndSync` / `moveGroupAndSync` / `moveTabAndSync` / `cleanDuplicateTabs` / `deleteTabAndSync`

**同步 reducer**：`setActiveGroup` / `updateGroupName` / `toggleGroupLock` / `setSearchQuery` / `setSyncStatus` / `moveGroup` / `moveTab` / `updateSyncProgress` / `setGroups`

**记忆化选择器**：`selectFilteredGroups`（避免重复计算）

#### `settingsSlice`（src/store/slices/settingsSlice.ts）

```typescript
{
  groupNameTemplate: string,
  showFavicons: boolean,
  showTabCount: boolean,
  confirmBeforeDelete: boolean,
  allowDuplicateTabs: boolean,
  syncEnabled: boolean,
  layoutMode: 'single' | 'double',
  showNotifications: boolean,
  collectPinnedTabs: boolean,
  syncStrategy: 'newest' | 'local' | 'remote' | 'ask',
  deleteStrategy: 'everywhere' | 'local-only',
  themeMode: 'light' | 'dark' | 'auto',
  themeStyle: 'legacy' | 'classic' | 'aurora' | 'creamy' | 'pink' | 'mint' | 'cyberpunk' | 'prism',
  reorderMode: boolean,
  useDoubleColumnLayout?: boolean,  // 向后兼容
}
```

#### `authSlice`（src/store/slices/authSlice.ts）

```typescript
{
  user: { id, email, lastLogin } | null,
  isAuthenticated: boolean,
  isLoading: boolean,
  error: string | null,
}
```

### 3.3 autoSyncMiddleware（核心创新点）

**监听 tabs/* 系列 thunk 的 fulfilled action**，按 action 优先级调度云同步：

| 优先级 | Action | 防抖延迟 |
|---|---|---|
| 10 | deleteGroup / deleteAllGroups / deleteTabAndSync | 500ms |
| 8 | saveGroup / importGroups | 500ms |
| 5 | updateGroup / updateGroupNameAndSync / cleanDuplicateTabs | 2000ms |
| 3 | toggleGroupLockAndSync | 2000ms |
| 2 | moveGroup / moveTab | 2000ms |

**关键约束**：
- 仅在 `auth.isAuthenticated === true` 时触发
- 高优先级到达会**抢占**正在等待的 timer
- 手动同步前 `smartSyncService` 会调 `cancelPendingSync()` 避让
- 延迟 timer 内通过**动态 import** 调用 `syncTabsToCloud({ background: true, overwriteCloud: false })` + `syncSettingsToCloud()`

### 3.4 持久化层

**存储路径**：IndexedDB（优先）→ localStorage（降级）

```
ChromeStorage 门面 (src/utils/storage.ts)
  ├─ 30s/60s TTL 内存缓存（CacheManager）
  ├─ 500ms debounceAsync 防抖批量落盘
  ├─ 透明加密：encryptLocalBlob / decryptLocalBlob
  └─ 自动迁移 useDoubleColumnLayout → layoutMode
       ↓
StorageAdapter (src/storage/storageAdapter.ts)
  ├─ pickBackend() → indexedDbDriver / localStorageDriver
  └─ migrateFromChromeStorage / migrateFromLocalStorage
       ↓
IndexedDB (tabvaultpro DB, 'kv' object store, DB_VERSION=1)
```

### 3.5 IPC 通信

**popup ↔ service worker**：
```typescript
// popup 端
chrome.runtime.sendMessage({ type: 'OPEN_TAB', data: { url, pinned } });

// service worker 端
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 严格校验: sender.id === chrome.runtime.id
  // URL 协议白名单: http/https
});
```

**消息类型**：
- `OPEN_TAB`（单 URL + pinned）
- `OPEN_TABS`（urls/tabs 批量）
- `SAVE_ALL_TABS`（windowId/sender.tab 兜底）
- `REFRESH_TAB_LIST`（广播刷新信号）

### 3.6 端到端数据流

#### 写路径：拖拽标签组

```
用户拖拽 DraggableTab
  → dispatch(moveTabAndSync({ dragIndex, hoverIndex }))
  → tabSlice.moveTab reducer (immer 不可变,state 立即变)
  → UI 重渲染 (60fps)
  → requestAnimationFrame 内:
     ├─ await storage.getGroups()
     ├─ await storage.setGroups(updatedGroups) (optimistic 写 cache + 500ms 防抖落盘 + AES-GCM 加密)
     └─ thunk 返回
  → autoSyncMiddleware 命中 moveTabAndSync/fulfilled (优先级 2)
  → scheduleAutoSync(2000ms)
  → timer 触发后:
     ├─ smartSyncService.uploadToCloud({ background: true, overwriteCloud: false })
     ├─ uploadTabsToCloudFlow
     ├─ uploadTabGroups (supabase.ts)
     ├─ encryptData(tabs_data, userId) (AES-GCM 256)
     └─ supabase.from('tab_groups').upsert({...tabs_data: 'ENCRYPTED_V2_S:...'})
```

#### 读路径：popup 启动

```
AppContainer 挂载
  → initStorage() 预热 + 触发 chrome.storage → IndexedDB 迁移
  → TabList useEffect:
     ├─ runMigrations()
     └─ dispatch(loadGroups())
        → tabSlice.loadGroups thunk
           → storage.getGroups() (30s 内存缓存 + AES-GCM 解密 + 过滤 isDeleted + createdAt 倒序)
           → fulfilled 写入 state.tabs.groups
        → React 组件 useAppSelector 订阅
           → 重新渲染
```

#### 后台周期同步

```
service-worker chrome.alarms('periodic-cloud-sync', 30min)
  → performPeriodicSync:
     ├─ 登录态校验
     ├─ 快照本地
     ├─ 拉云端
     ├─ mergeTabGroups (字段级合并)
     ├─ 写本地
     ├─ 上传合并结果 (非覆盖)
     └─ 失败时: 回滚到快照 + 指数退避 3 次
```

### 3.7 性能热点

1. **拖拽/移动**（moveGroupAndSync / moveTabAndSync）—— reducer 内先 state 变更保证 60fps，再 rAF 异步写存储
2. **搜索过滤**（selectFilteredGroups）—— createSelector 记忆化
3. **setGroups 写入**—— debounceAsync(500ms) 合并连续调用
4. **autoSyncMiddleware 调度**—— 高/低优先级分层 + 优先级抢占
5. **service-worker 周期同步**—— 本地快照 + 合并 + 写回 + 失败回滚
6. **IndexedDB 读写**—— 单 cachedDb 实例 + onversionchange 自动失效
7. **smartSyncService 冷却**—— 2min 冷却 + isSyncing 互斥锁 + hasPendingSync 互斥

---

## 4. 核心功能实现（维度 4）

### 4.1 核心功能矩阵

| 功能 | 用户流程 | 关键文件 | 备注 |
|---|---|---|---|
| **保存会话** | 点击图标/快捷键/右键菜单 → TabManager.saveAllTabs → 过滤 chrome:// 等内部 URL → 时间戳命名 → unshift | `service-worker.ts` / `background/TabManager.ts` / `domain/tabGroup/factory.ts` | 命名: "标签组 MM/DD HH:mm" |
| **恢复会话** | TabGroup 点"恢复全部" → 映射 url + pinned → unlocked 自动删原组 → `OPEN_TABS` 消息 → 新窗口批量开 | `components/tabs/TabGroup.tsx` / `service-worker.ts` | 50-100ms 延迟做乐观更新 |
| **智能搜索** | SearchBar 300ms 防抖 → AdvancedSearch.search 评分制 substring → useDeferredValue + useTransition 异步筛选 → HighlightText 染色 | `utils/search.ts` / `components/search/` | **不依赖 Fuse.js** |
| **拖拽排序** | react-dnd HTML5Backend → 100ms throttle → 20% 阈值方向判断 → 同组/跨组分别处理 + 跨组查重 | `components/dnd/` / `tabSlice.moveTab/moveGroup` | DraggableTabGroup 当前**禁用组级拖拽** |
| **标签去重** | 菜单"清理重复标签" → URL Map + lastAccessed desc 保留最新 → 过滤 → bump version+updatedAt → 写存储（失败回滚） | `tabSlice.cleanDuplicateTabs` | 不参与去重: loading://\* 与软删除 |
| **锁定/收藏** | TabGroup 头部按钮 → toggleGroupLockAndSync / updateGroup({isFavorite}) → 排序时收藏组置顶 | `tabSlice.toggleGroupLockAndSync` | 锁定后禁止: 编辑/删除/拖拽/恢复后自动删原组 |
| **重命名/备注** | inline 编辑: input + onBlur/Enter/Esc → updateGroupNameAndSync | `tabSlice.updateGroupNameAndSync` | isLocked 时禁用 |
| **删除/批量** | 会话级: showConfirm 不可跳过 → 软删除 isDeleted=true → 过滤；单标签: 200ms 滑出动画 → shouldAutoDeleteAfterTabRemoval 决定是否自动删整组 | `tabSlice.deleteGroup` / `utils/tabGroupUtils.ts` | 软删除保留在存储中以支持同步 |
| **导入/导出** | JSON: `ExportData { data: { groups, settings } }` + storage.importData 合并；OneTab 文本: `URL \| 标题` 多行 + 空行分组 | `utils/storage.ts` / `utils/oneTabFormatParser.ts` | OneTab 导入用 nanoid 重写 id 避免冲突 |
| **OneTab 兼容** | exportToOneTabFormat / importFromOneTabFormat | `utils/oneTabFormatParser.ts` | 解析失败抛"解析失败或没有有效的标签组" |
| **使用统计** | StatsPanel 拉 storage.getProductEvents() + state.tabs.groups → 聚合: totalSessions / totalTabs / totalDomains / savedThisWeek / restoredThisWeek / topDomains / avgTabsPerSession / oldestSession / pinnedTabCount | `components/stats/StatsPanel.tsx` / `utils/productEvents.ts` | 事件埋点: session_saved/restored/favorited/search_performed |
| **新手引导** | service-worker onInstalled 写 onboarding_trigger → 前端 5 步: Welcome → SaveTabs → Search → Restore → Ready | `service-worker.ts` / `components/onboarding/OnboardingSteps.tsx` | 含 Spotlight 聚光遮罩 |

### 4.2 领域模型

```typescript
// TabGroup: 会话主表
{
  id: string,            // nanoid
  name: string,          // "标签组 MM/DD HH:mm"
  tabs: Tab[],
  createdAt: number,
  updatedAt: number,
  isLocked: boolean,
  notes?: string,
  isFavorite?: boolean,
  user_id?: string,
  device_id?: string,
  last_sync?: number,
  version: number,       // 冲突检测,每次修改 +1
  displayOrder?: number, // 拖拽重排后批量更新
  syncStatus?: 'synced' | 'local-only' | 'remote-only' | 'conflict',
  lastSyncedAt?: number,
  isDeleted?: boolean,   // 软删除标记
}

// Tab
{
  id: string,            // nanoid
  url: string,
  title: string,
  favicon?: string,
  createdAt: number,
  lastAccessed: number,
  group_id?: string,
  pinned: boolean,
  syncStatus?: string,
  lastSyncedAt?: number,
  isDeleted?: boolean,
}

// SupabaseTabGroup: 云端行存格式
{
  id: string,
  name: string,
  created_at, updated_at, last_sync: number,
  is_locked: boolean,
  user_id: string,
  device_id: string,
  tabs_data?: TabData[], // 加密的 ENCRYPTED_V2_S/V1 字符串
  pending_delete?: boolean, // overwrite 模式临时标记
}
```

### 4.3 搜索算法（不依赖 Fuse.js）

**自实现"评分制 substring 搜索"**：

```typescript
// utils/search.ts
const SCORE_WEIGHTS = {
  titleExact: 100,    titlePartial: 50,
  urlExact: 80,       urlPartial: 30,
  groupNameExact: 75, groupNamePartial: 40,
  notesExact: 60,     notesPartial: 30,
  pinnedBonus: 10,
};
```

- 每个 group 的每个 tab 上做 title / url / groupName / notes 四类字段的 contains 判断
- 大小写不敏感 + 可切 exactMatch
- 按 SCORE_WEIGHTS 加分
- 最后按 score desc + updatedAt desc 排序
- `SearchResultList` 用 `useDeferredValue` + `useTransition` + `useState` filter（domain / groupName / pinned / savedWithin）二次过滤
- `buildSessionSearchResults` 用 Map 按 groupId 聚合
- `HighlightText` 用转义后的正则把命中段拆出来染色

### 4.4 去重策略

**两段式**：
1. **保存入口**（`filterValidTabs`）已经排除 `chrome://` / `chrome-extension://` / `edge://` / `about://`，按 `settings.collectPinnedTabs` 决定是否纳入 pinned，但**同一窗口内不去重**
2. **显式"清理重复标签"**（`cleanDuplicateTabs` thunk）：
   - URL Map（`loading://*` 用 `url|title` 组合 key）
   - `lastAccessed desc` 排序保留最新
   - 过滤其余（同时 bump version+updatedAt）
   - 二次过滤掉空且未锁定的 group
   - 写存储失败则回滚到 `originalGroups` 快照

删除操作后通过 `shouldAutoDeleteAfterTabRemoval` / `shouldAutoDeleteAfterMultipleTabRemoval` 自动清理空未锁 group。

---

## 5. 云同步与安全（维度 5）

### 5.1 后端：Supabase

| 项 | 值 |
|---|---|
| Provider | Supabase (Postgres + Auth + Storage) |
| Endpoint | `https://reccclnaxadbuccsrwmg.supabase.co` |
| Auth | Email + Password (Supabase `signUp` / `signInWithPassword`) |
| 邮箱确认 | `auth/confirm.html` 支持 signup 类型 |
| RLS | 强推测启用（代码反复引用 RLS 违规错误） |

### 5.2 数据表结构（从代码推断）

#### 1) `tab_groups`（主表）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid/text (PK) | |
| `user_id` | uuid (FK auth.users) | RLS 依据 |
| `device_id` | text | 来源 secureStorage 加密存储 |
| `name` | text | |
| `created_at` / `updated_at` / `last_sync` | timestamptz | |
| `is_locked` | boolean | |
| `tabs_data` | jsonb | **加密的 ENCRYPTED_V2_S/V1 字符串** |
| `pending_delete` | boolean | overwrite 模式临时标记 |

#### 2) `tabs`（旧式/兼容表，smoke-test 仍在使用）

`id, group_id, url, title, favicon, created_at, last_accessed, pinned`

#### 3) `user_settings`

| 列 | 说明 |
|---|---|
| `user_id` (PK, onConflict 依据) | |
| `device_id, last_sync` | |
| `group_name_template, show_favicons, show_tab_count, confirm_before_delete, allow_duplicate_tabs, sync_enabled, layout_mode, show_notifications, sync_strategy, delete_strategy, theme_mode, theme_style, collect_pinned_tabs, reorder_mode` | 旧版遗留字段 `use_double_column_layout` 向后兼容 |

### 5.3 加密体系

**核心算法**：AES-GCM 256 + PBKDF2（100k 迭代，SHA-256，16 字节 salt，12 字节 IV）

#### 云端数据加密（encryptionUtils.ts）

| 版本 | 派生方式 | 用途 |
|---|---|---|
| **V1 (legacy)** | `SHA-256(userId)` | 兼容旧数据 |
| **V2 标准** (`ENCRYPTED_V2_S:`) | `PBKDF2(SHA-256, 100,000 轮, 16-byte salt)`, keyMaterial = `UTF-8(userId)` | 当前标准 |
| **V2 设备绑定** (`ENCRYPTED_V2_D:`) | 同 V2, keyMaterial = `userId + deviceId` | 向后兼容 |

#### 本地安全存储（secureStorage.ts）

| 版本 | 派生方式 |
|---|---|
| V1 | `SHA-256(extensionId + 'storage_key_v1')` |
| V2 | `PBKDF2(extensionId + 'storage_key_v2', 100,000 轮, 16-byte 随机 salt)` |

**SENSITIVE_KEYS**（本地加密白名单）：`deviceId` / `migration_flags` / `auth_cache` / `user_preferences` / `sync_tokens`

**密钥存储**：无显式存储——每次需要时按 userId / extensionId 即时派生。deviceId 存于 secureStorage 加密落盘，extensionId 取自 `chrome.runtime.id`。

**IV 策略**：12 字节随机 IV（`crypto.getRandomValues`），密文格式 = `salt(16) | iv(12) | ciphertext(base64)`

### 5.4 同步策略矩阵

| 策略 | 触发时机 | 模式 | 关键实现 |
|---|---|---|---|
| **smartSync** | 手动（`syncService.uploadToCloud/downloadFromCloud`）或登录态跳变 2s 静默触发 `maybeAutoDownload` | 单例，含 `isSyncing` 互斥锁 + 2min 冷却 + `cancelPendingSync` 避让 | `src/services/smartSyncService.ts` |
| **autoSync** | Redux middleware 监听 data-mutating thunks | 按优先级调度 `scheduleAutoSync`：高 500ms / 低 2000ms 防抖；优先级抢占 | `src/store/middleware/autoSyncMiddleware.ts` |
| **manualSync** | 用户点击 SyncStatus 组件 | 由调用方传参决定 overwrite/merge；`cancelPendingSync()` 确保手动优先 | `smartSyncService.uploadToCloud/downloadFromCloud` |
| **periodicSync** | `chrome.alarms('periodic-cloud-sync', periodInMinutes=30)` | 事务性保护：本地快照 → 拉云端 → 合并 → 写本地 → 上传合并结果；失败时回滚到快照 + 指数退避 3 次 | `service-worker.ts:232-237` |

### 5.5 冲突解决

**字段级版本合并**（`syncUtils.mergeTabGroups`）：

- 每个 group 有 `version` 字段单调递增
- `hasVersionConflict = (localVersion !== cloudVersion) && 都 > 1`，标记 `syncStatus='conflict'`
- **三种策略**：
  - `'newest'`（默认）：按 `updatedAt` 时间戳取基础
  - `'local'` / `'remote'`：强制取一边
- **软删除传播**：本地/云端 `isDeleted=true` 时通过 `shouldApplyCloudDeletion` + `syncStrategy` 决定是否应用删除
- **Tab 内层按 ID 去重 + URL 去重**，`lastAccessed` 较新的胜出
- `isLocked` 字段取 OR（任一锁定即锁定）
- `displayOrder` 优先取 local
- 合并后 `version = max + 1`（幂等增长）
- `syncStrategy='ask'` 时由 `syncStatus='conflict'` 标记，但**目前缺少交互式 UI（TODO）**

### 5.6 安全边界

**Permissions**（最小化）：
- ✅ `tabs` / `storage` / `unlimitedStorage` / `notifications` / `contextMenus` / `alarms`
- ❌ 无 `cookies` / `scripting` / `webRequest` / `debugger` 等高权限

**CSP**（严格）：
```
extension_pages:
  script-src 'self';            # 禁止内联/外部脚本
  object-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https:;
  font-src 'self' data:;
  connect-src 'self' https://reccclnaxadbuccsrwmg.supabase.co;  # 网络出口白名单
  frame-src 'none';             # 禁止 iframe
  base-uri 'self';
  form-action 'self';
```

**Service Worker 校验**：
- `sender.id === chrome.runtime.id`（同扩展消息）
- URL 协议白名单（http/https）

### 5.7 威胁模型

#### 加密 / 明文边界

| 字段 | 状态 |
|---|---|
| `tab_groups.tabs_data` (URL/标题/favicon) | **加密** |
| 本地 `deviceId / auth_cache / user_preferences / sync_tokens` | **加密** |
| `user_id` / `device_id` / `group.name` / `created_at/updated_at/last_sync` / `is_locked` / `user_settings` / 认证元数据 | **明文** |

#### 威胁场景

1. **Supabase 后端被入侵**：攻击者拿到密文 + 已知 `userId`（明文列）。因 userId 是 UUID 不可枚举 + PBKDF2 100k 迭代 + SALT 防彩虹表，**单一密文难以离线爆破**
2. **设备失窃**：攻击者需先通过用户登录拿 JWT，登录密码不在本地存储（由 Supabase 持有）。secureStorage 派生 key 含 extensionId，跨扩展/跨设备拷贝无意义
3. **MitM**：CSP 限定 connect-src，TLS 由浏览器/Supabase 终结
4. **跨设备同步**：device-bound 旧 V2 格式（`ENCRYPTED_V2_D`）会被标准 V2 取代（让用户能在任意设备解密——TabStack 的设计选择）
5. **重放/篡改**：AES-GCM 认证加密自带完整性保护

#### 已知弱点

- ⚠️ **非严格 E2EE**：key 派生基于 userId 而非用户密码，因此 Supabase admin 理论上能解密
- ⚠️ `service-worker.ts` 仍残留"已简化同步逻辑"注释，与实际保留的智能同步不一致
- ⚠️ `syncStrategy='ask'` 缺少冲突解决 UI
- ⚠️ 输入密码在 client 端不参与密钥派生

### 5.8 数据生命周期

```
1) 创建 (本地)
   Redux thunk → storage.setGroups
   (chrome.storage.local, sensitive keys 走 secureStorage AES-GCM 落盘)

2) 自动/手动上传 (出站)
   syncTabsToCloud thunk → uploadTabsToCloudFlow → uploadTabGroups
   → encryptData(tabs_data, userId) → base64
   → supabase.from('tab_groups').upsert({...tabs_data: 'ENCRYPTED_V2_S:...'})

3) 云端存储
   Supabase Postgres + RLS, 物理加密 at-rest 由 Supabase/云商提供
   DB 内仅存密文 + 元数据 + user_id

4) 定时拉取 (入站)
   chrome.alarms 30min → performPeriodicSync
   → snapshot 本地 → downloadTabGroups
   → decryptData(tabs_data, userId)
   → mergeTabGroups (字段级合并 + 软删除传播)
   → 写本地 → 非覆盖回传

5) 即时下载
   AuthProvider 登录态确认 2s 后 maybeAutoDownload
   → syncTabsFromCloud → 同上

6) 手动恢复
   Settings/SyncStatus → smartSyncService.downloadFromCloud(overwriteLocal)
   → 清空本地 → 直接采纳云端 (或按 syncStrategy 合并)

7) 退出
   signOut → supabase.auth.signOut → authCache.clearAuthState
   (清加密缓存) → 本地数据保留但不显示同步入口
```

---

## 6. UI/UX 与主题系统（维度 6）

### 6.1 UI 技术栈

**React 18 + TypeScript + Tailwind CSS 3.4 + Vite 4.5 (Chrome Extension MV3)**

### 6.2 组件库清单（按职责分类）

| 分类 | 组件 |
|---|---|
| **layout** | Header (logo + 搜索 + 操作 + 下拉), TabCounter, ThemeStyleSelector (8 主题渐变预览), SimpleThemeToggle (二态), ThemeToggleButton (三模式), HeaderDropdown, Layout (基础容器) |
| **tabs** | TabGroup (会话卡片), TabList (单/双栏/搜索/重排 容器), TabPreview (悬浮预览), ReorderView (按时间/域名重排) |
| **search** | SearchBar (300ms 防抖), SearchResultList (按会话分组 + 高亮), HighlightText |
| **auth** | LoginForm, RegisterForm, UserProfile (Google/GitHub 图标判断), AuthButton, AuthContainer |
| **common** | EmptyState (3 种 tone), ModalFrame (Portal 渲染), Toast (4 种类型 + 进度条), ConfirmDialog, AlertDialog, Tooltip, InlineNotice, LoadingSpinner/Overlay, ErrorBoundary, SafeFavicon, PersonalizedWelcome, QuickActionTips, StatusFeedback, **TabStackIcon / TabStackLogo** |
| **sync** | SyncStatus (动画 + 最近同步时间), SyncStatusIndicator, SyncButton |
| **stats** | StatsPanel (会话/标签/域名/本周活动/最常访问) |
| **onboarding** | OnboardingGuide (5 步), OnboardingSteps, Spotlight |
| **dnd** | DndProvider (react-dnd HTML5Backend), DraggableTab (100ms throttle), DraggableTabGroup (当前禁用组级拖拽) |
| **performance** | PerformanceTest (仅 dev 可见,生成测试数据 + 渲染/搜索基准 + React Profiler) |
| **app** | AppContainer, MainApp (lazy 拆分大组件), AuthProvider |

### 6.3 主题系统（项目最亮眼部分）

**8 套独立 CSS**（src/styles/themes/）：

| 名称 | 风格 |
|---|---|
| `legacy` | 原始,蓝灰 |
| `classic` | 经典,Material 蓝 |
| `aurora` | 极光,北欧冷调 |
| `creamy` | 奶油,温暖柔和 |
| `pink` | 粉红,甜美可爱 |
| `mint` | 薄荷,清新自然 |
| `cyberpunk` | 赛博,霓虹科技 |
| `prism` | 棱镜,毛玻璃紫蓝渐变 |

（src/styles/themes/ 另含 `productivity.css` 与 `refined.css` 两个历史主题，但未在 ThemeStyleSelector 暴露）

**CSS 策略**：多文件 CSS 变量隔离，每个主题独立 CSS 文件，通过 `html[data-theme="xxx"]` 选择器覆盖一套语义化 CSS 变量（`--color-bg-primary` / `--color-text-primary` / `--color-accent` / `--shadow-card` / `--radius-*` / `--font-family-*` 等）。global.css 集中注册 base/components，themes 顺序 import。Tailwind 用于工具类与排版，主题色通过 `var(--color-*)` 接入组件。

**切换机制**（ThemeContext）：
- `setThemeMode(light/dark/auto)` — 支持 `prefers-color-scheme` 跟随系统
- `setThemeStyle(8 种主题风格)` — 解耦
- 状态同步到 Redux `settingsSlice.themeMode/themeStyle`，持久化到 `chrome.storage.local`
- 切换时给 `html` 添加 `.theme-transitioning` 类，**250ms cubic-bezier(0.4,0,0.2,1) 平滑过渡**
- `data-theme` 属性即时切换

**深色模式**：三模式（light / dark / auto），支持 `prefers-color-scheme`

### 6.4 布局

| 项 | 值 |
|---|---|
| 主视图 | Chrome 扩展 Popup（icon 点击 / Ctrl+Shift+S） |
| 最大宽度 | `max-w-6xl` 居中 |
| 响应式 | ✅ Tailwind 默认 sm(640) / md(768) / lg(1024) / xl(1280) |
| 触摸目标 | 移动端 48px / 桌面 44px |
| 模式 | 默认主页 / 搜索 / 重排 / 统计 / 性能测试 |
| 单双栏 | `grid-cols-1 md:grid-cols-2` 按 index 奇偶分列，Ctrl+L 切换 |
| Sticky Header | `.header` sticky top-0 z-50 + backdrop-blur 毛玻璃 |
| Footer | 版本号 + slogan + 开发态性能测试入口 |

### 6.5 可访问性（WCAG 2.1 AA 水准）

**键盘导航**（`useKeyboardNavigation` hook）：
- Enter / Escape / Arrow（上下左右）/ Tab / Shift+Tab 统一处理
- `useFocusTrap` 实现焦点陷阱，自动聚焦首元素
- `useSkipLink` 提供跳到主内容链接

**快捷键**：
- **全局 5 个**（`COMMON_SHORTCUTS`）：Ctrl+S 保存当前窗口、Ctrl+F 聚焦搜索、Esc 清空搜索、Ctrl+L 切换布局、Ctrl+D 清理重复
- **Chrome commands 3 个**（manifest）：Ctrl+Shift+S 打开、Alt+Shift+S 保存全部、Alt+S 保存当前
- `useKeyboardShortcuts` 在 INPUT/TEXTAREA/contentEditable 内自动忽略，避免与输入冲突

**ARIA**：全面使用 role / aria-label / aria-busy / aria-expanded / aria-selected / aria-describedby / aria-controls / aria-live="polite"
- ModalFrame 使用 `createPortal` 渲染到 body，Esc 关闭，焦点自动定位
- Skip-link、live-region、sr-only、`.keyboard-navigation` 焦点环、`aria-invalid` 错误样式

**prefers-contrast: high**：聚焦环加粗、按钮加 2px 描边、文本色加深（accessibility.css）

**prefers-reduced-motion: reduce**：`--theme-transition-duration` 改为 0.001ms，所有 animation/transition 禁用，loading-spinner 保留文本提示

**色觉感知**：accessibility.css 提供 `.status-success/.status-warning/.status-error/.status-info` 伪元素符号（✓/⚠/✗/ℹ），不依赖单一颜色编码

### 6.6 设计系统（design-system/tabvault-pro/MASTER.md）

| 项 | 值 |
|---|---|
| 主色 | Teal `#0D9488`（primary）/ `#14B8A6`（secondary） |
| CTA | Orange `#F97316` |
| 背景 | `#F0FDFA` |
| 文字 | `#134E4A` |
| 字体 | Plus Jakarta Sans（300-700）—— **实际因 Chrome 扩展 CSP 不能外链字体，改用系统字体栈 SF Pro / -apple-system** |
| 间距 token | xs 4px / sm 8px / md 16px / lg 24px / xl 32px / 2xl 48px / 3xl 64px |
| 阴影 | sm / md / lg / xl 四级 |
| 圆角 | sm 4px / md 6px / lg 8px / xl 12px / 2xl 16px / 3xl 24px |
| 按钮 | 主色橙 CTA, 12×24 padding, 8 radius, hover -1px + 阴影增强 |
| 卡片 | 12 radius, 24 padding, hover 阴影升级 + translateY(-2px) |
| 输入框 | 12×16 padding, 8 radius, 聚焦 3px 青色光晕 |
| 模态 | 16 radius, 32 padding, 500px max-width, backdrop-filter blur(4px) |

**反模式**（明确禁止）：emoji 图标、layout-shifting hover、< 4.5:1 对比度、< 150ms 或 > 300ms 过渡、不可见 focus、不支持 prefers-reduced-motion

### 6.7 图标

- **纯 SVG**，内联编写，Heroicons/Lucide 风格 24×24 viewBox `stroke="currentColor"` 描边图标（可随文字色变色）
- **TabStack 品牌图标**：三层错位圆角矩形叠层设计（#4F8EF7 → #2C5DC3 渐变填充）
- **所有 emoji 已替换为 SVG** 满足 Chrome Web Store 合规
- 静态资源：icons/icon{16,48,128}.png + icons/tabstack_icon.svg（最新矢量源）+ public/favicon.ico + public/icon{16,48,128}.png
- **不引入独立图标库**，保持扩展体积小

---

## 7. 测试、构建、发布、CI/CD（维度 7）

### 7.1 测试覆盖

| 项 | 详情 |
|---|---|
| **框架** | `node --test --experimental-strip-types`（Node 22+ 原生 .ts 支持） |
| **覆盖率** | 极低（< 5%），未配置 c8/nyc |
| **测试文件** | 3 个，仅覆盖纯函数模块 |
| **缺失** | 无 Redux slice / service-worker / Supabase / storage / UI / middleware / hooks / components/* 单测 |

#### 测试文件清单

| 文件 | 覆盖 |
|---|---|
| `tests/inputValidation.test.ts` | `src/utils/inputValidation.ts` 的 7 个导出：validateEmail、validatePassword、checkPasswordStrength、PasswordStrength 枚举、validateGroupName、sanitizeText、escapeHtml、validateForm。覆盖空值/危险字符/`<script>` 注入/弱密码/常见密码/小写归一/多字段组合 |
| `tests/sessionName.test.ts` | `src/domain/tabGroup/sessionName.ts` 的 `buildTimestampSessionName`（固定时间戳断言本地化格式）、`deriveSessionNameFromChromeTabs`（空 url/title 列表时回退到时间戳格式） |
| `tests/tabFilters.test.ts` | `src/domain/tabGroup/filters.ts` 的 `isInternalUrl`（chrome:// 与 chrome-extension:// 识别）、`isValidTab`、`filterValidTabs`（includePinned 开关） |

#### Supabase 烟雾测试（`scripts/supabase-smoke-test.mjs`）

完整端到端冒烟：
- 从 .env 读 VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY + TEST_EMAIL/TEST_PASSWORD
- `signInWithPassword` 登录
- 读取并翻转 user_settings 的 `layout_mode/reorder_mode` 后 upsert 还原
- 用与生产**相同的 AES-GCM**（SHA-256(userId) 派生 key, 12 字节随机 IV）加密一条 tab 数据
- 插入一个临时 `tab_groups`（含 `device_id='codex-mcp-test'`），写一条 `tabs` 记录
- 按 `updated_at desc` 取最近 3 组验证可见
- 删除 tab 与 group
- 把 user_settings 恢复成原始值并 signOut
- 失败时 `process.exitCode=1`

⚠️ **未自动化注册测试账号**

### 7.2 Lint / Format / Type Check

| 工具 | 严格度 | 关键配置 |
|---|---|---|
| **ESLint** | 中等 | 基于 `eslint:recommended` + `@typescript-eslint/recommended` + `react/recommended` + `react-hooks/recommended`。放宽：`no-explicit-any` off / `explicit-module-boundary-types` off / `prop-types` off / `display-name` off / `exhaustive-deps` off。收紧：`rules-of-hooks=error` + `--max-warnings 0` + `--report-unused-disable-directives` |
| **Prettier** | 统一格式 | semi: true / singleQuote: true / trailingComma: es5 / tabWidth: 2 / printWidth: 100 / arrowParens: avoid |
| **TypeScript** | 严格 | strict + noUnusedLocals + noUnusedParameters + noFallthroughCasesInSwitch；target ES2020 / module ESNext / moduleResolution bundler / isolatedModules / allowImportingTsExtensions / resolveJsonModule |

⚠️ **scripts/ 与 tests/ 不在 tsconfig include 内**——validate-extension.mjs / supabase-smoke-test.mjs / tests/*.test.ts 得不到 tsc 保护

### 7.3 构建流水线

| 命令 | 作用 |
|---|---|
| `pnpm dev` | Vite 开发服务器 |
| `pnpm build` | `tsc && vite build`（先类型检查，再产线构建） |
| `pnpm build:dev` | 同 build |
| `pnpm package` | `pnpm build && node package-extension.js`（打 chrome-extension.zip） |
| `pnpm preview` | vite preview |
| `pnpm test` | `node --test --experimental-strip-types tests/*.test.ts` |
| `pnpm lint` | eslint --max-warnings 0 |
| `pnpm format` | prettier --write |
| `pnpm type-check` | tsc --noEmit |
| **`pnpm validate`** | **4 步串联：metadata → tsc → lint → build** |
| `pnpm test:supabase-smoke` | scripts/supabase-smoke-test.mjs |

#### validate 详解

1. **`scripts/validate-extension.mjs`** 校验：
   - package.json/manifest.json/README.md 版本三处一致
   - `manifest.background.service_worker === 'service-worker.js'`
   - 不存在旧版 `src/service-worker.js`
   - `PRIVACY_POLICY.md` 存在
   - 若 `.env.example` 配置了非占位 Supabase URL，则校验 manifest CSP `connect-src` + `host_permissions` 必须包含该 origin
2. `tsc --noEmit`
3. `eslint --max-warnings 0`
4. `vite build` 实际出包

任何一步 `exit code != 0` 都阻塞发布。

#### 产物

- `chrome-extension.zip`（267 KB, 2026-05-11）
- `dist.zip`（281 KB, 2026-03-26 旧版归档）
- ⚠️ **包内仍含 .htaccess 与 src/popup/、src/auth/ 目录**——`package-extension.js` 没有按白名单清理构建产物

### 7.4 CI/CD

**无任何 CI/CD 配置文件**：
- ❌ 无 `.github/` 目录
- ❌ 无 `.gitlab-ci.yml`
- ❌ 无任何 CI 触发器
- ❌ 发布到 Chrome Web Store 全靠人工执行 `pnpm package` 后手动上传 `chrome-extension.zip`

### 7.5 Chrome Web Store 发布就绪度

| 项 | 状态 |
|---|---|
| **manifest 合法** | ✅ MV3、permissions 最小化、CSP 严格、icons 16/48/128 + 矢量源、3 个 commands |
| **隐私政策** | ✅ `PRIVACY_POLICY.md` 存在，2026-05-11 更新 |
| **icons** | ✅ icons/icon{16,48,128}.png + icons/tabstack_icon.svg |
| **store 截图** | ❌ **缺失**——`public/SCREENSHOTS_REQUIRED.txt` 明确要求主弹窗/Onboarding/搜索/统计四张截图，public/ 目录下目前只有 favicon.ico + 3 个 png |
| **品牌一致性** | ❌ **不一致**——manifest.name = TabStack，但 README.md 标题 / PRIVACY_POLICY.md / design-system 目录 / .env.example VITE_APP_NAME 仍叫 TabVault Pro |
| **商店文案** | ⚠️ manifest.description 混中英（"TabStack - 浏览器工作会话管理器..."）—— Chrome Web Store 通常需要单语种 |
| **dist 残留** | ❌ 含 .htaccess 与 src/popup|auth 源码目录 |

### 7.6 性能监控

**三层性能工具**：

1. **`src/utils/performance.ts`** 提供：
   - `debounce` / `throttle`
   - `debounceAsync`（合并窗口期内多次调用为一次执行，所有调用共享同一 Promise）
   - `SimpleCache`（LRU + TTL）
   - `CacheManager`（每分钟清理过期项）
   - `cachedAsyncFn`

2. **`src/utils/performanceMonitor.ts`** 单例 `PerformanceMonitor` 类：
   - 订阅 longtask + layout-shift 两个 PerformanceObserver
   - `measure` / `measureAsync` / `mark` / `measureBetweenMarks`
   - `getMemoryUsage` / `recordMemoryUsage`
   - `generateReport`（avgRenderTime / avgInteractionTime / memoryUsage / slowOperations > 100ms / 阈值化 recommendations）
   - `exportAsJSON`
   - `measurePerformance` / `measureAsyncPerformance` 装饰器
   - `usePerformanceTracking` React Hook

3. **`src/utils/performanceTest.ts`** 提供：
   - `measurePerformance`
   - `monitorRenderPerformance`（React Profiler 回调，actualDuration > 16ms 告警）
   - `generateTestData`
   - `benchmarkStorageRoundtrip`（默认 50 组 × 20 标签 × 3 轮，对 storage.setGroups/getGroups 计时）
   - `seedLargeDataset`（100×20 测试集）
   - `showPerformanceComparison`

### 7.7 安全审计痕迹

commit 记录：
- `b68b170` "fix: security hardening and dead code cleanup from audit"
- `fa703a5` "fix: resolve Maximum call stack size exceeded in encryption and storage"
- `f0c1ade` "TabStack branding, UI hardening and Chrome Web Store prep"

共同记录了：
- (a) base64 编码分块解决栈溢出
- (b) `isEncrypted` 类型守卫（unknown→string）
- (c) `decryptLocalBlob` 损坏时返回 null
- (d) 删除会话始终弹确认框不受 `confirmBeforeDelete` 设置影响
- (e) CSP 收紧 img-src/font-src
- (f) 移除 manifest 中非法的 `privacy_policy` 键
- (g) 周期性同步前先校验 auth state
- (h) auth cache 时间戳校验

⚠️ **无 SECURITY.md / 无独立审计报告文件 / 无 .github/ 安全策略**

### 7.8 代码质量

| 项 | 状态 |
|---|---|
| TODO / FIXME / XXX / HACK | 0 条（grep 命中为空） |
| 死代码 | 已清理（commit b68b170 标题即"dead code cleanup from audit"） |
| Lint 警告 | 0（--max-warnings 0 强制） |
| console.* | 198 处（生产构建不会自动剥离） |

---

## 8. 开发历史、问题、Roadmap（维度 8）

### 8.1 时间线

| 时间 | 里程碑 | 事件 |
|---|---|---|
| 2025-04 | first commit | 项目初始化（OneTab 风格标签管理） |
| 2025-04 | e22c273 | 砍掉 Realtime 同步、收窄到手动同步（早期定型） |
| 2025-05 ~ 2025-09 | — | 存储层 v2 + 早期 v1.5–1.7 迭代 |
| 2025-09 | 49c5651 | OneTab Plus → TabVault Pro 改名 |
| 2025-09 | 124ba8e | 清理历史调试/文档 |
| 2025-10 | 0f124cc | v1.8 数据迁移与版本控制 |
| 2025-11 | 6e80d28 | v1.9 引入 Supabase 同步雏形 |
| 2025-12-08 | 3c88353 | 存储重构：从 localStorage 切到 IndexedDB |
| 2025-12-13 | f8c6651 | Manifest V3 合规（移除远程代码、identity） |
| 2026-01-01 | 7b88ac0 | v1.9.4 主题系统重构 |
| 2026-01-10 | 36c7865 | v1.9.7 + 五轮综合优化（性能/虚拟化/批量/加密） |
| 2026-01-13 | a512e59 | **v1.11.0 主题与布局大版本** |
| 2026-01-25 | 8743e28 | 性能监控工具（performanceMonitor） |
| 2026-02-10 | 1c664b9 | 固定标签页收集能力 |
| 2026-02-11 | b023297 | 不可变性与可访问性修复（v1.11.3–1.11.4） |
| 2026-03-25 | 6c877f4 | **session-focused 产品大迭代** + 12 份规划文档 |
| 2026-03-26 | cfb95d1 | 同步预览、Toast/弹窗样式、按钮回归修复 |
| 2026-03-26 | d0e0da8 | v1.11.5 发布 |
| 2026-05-11 | 3e95aae | 移除 recent restore 功能、清理死代码 |
| 2026-05-11 | 2f32d67 | 折叠 12 份规划/审计/路线图文档（清理） |
| 2026-05-25 | **9fbd1fd** | **产品级硬化**：智能同步 + CSP + 统计面板 + 28 个单测 |
| 2026-05-25 | b68b170 | 安全审计修复 + 移除 8 个遗留 dnd 组件（~1160 行） |
| 2026-05-25 | dcf42f5 | **接通自动云同步**：autoSyncMiddleware 替代死代码 syncToCloud |
| 2026-05-26 | fa703a5 | 修复 Maximum call stack + isEncrypted 类型守卫 + decryptLocalBlob 损坏返回 null |
| 2026-05-26 | **f0c1ade** | **TabStack 品牌重塑** + Web Store 收尾 |

### 8.2 当前阶段

**Pre-launch (v1.11.8)** — 准备提交 Chrome Web Store，已通过代码层硬化、清理与品牌重塑，但 SCREENSHOTS_REQUIRED.txt 表明商店截图/视频仍待准备

### 8.3 近期重大变更

| Commit | What | Why |
|---|---|---|
| **f0c1ade** | TabVault Pro → TabStack 改名；CSP 收紧；删除无效 privacy_policy manifest；session delete 强制确认；修复 Maximum call stack + isEncrypted 类型守卫 | 为 Chrome Web Store 提交做品牌/合规收尾 |
| **fa703a5** | chunked base64 编码、isEncrypted 类型守卫、decryptLocalBlob 损坏返回 null | V8 在大密文上递归 base64 会爆栈；用更鲁棒的加密/存储路径替代之 |
| **b68b170** | 添加 sender origin 校验、URL 协议白名单、web_accessible_resources 收窄到 Supabase 回调路径；删除 8 个遗留 @dnd-kit 组件、4 个根目录调试脚本、qrcode / react-window 依赖（~1920 行） | 修复安全审计中发现的 message handler 与可访问资源风险 |
| **dcf42f5** | 新增 autoSyncMiddleware 监听 fulfilled thunk，按操作优先级 500/2000ms 防抖触发 Supabase 上传 | 之前的 syncToCloud() 是死代码，同步完全依赖手动操作；新中间件把云同步真正接入数据流 |
| **9fbd1fd** | 智能同步；StatsPanel；输入校验接入注册表单；CSP img-src 收紧；删除 background.ts / simpleMoveTabAndSync.ts；新增 28 个单测；重写 README | 为生产质量做最后一轮硬化 |
| **3e95aae** | 移除 recentRestores UI/状态/类型、相关 storage 接口、迁移清理；session 命名简化为时间戳 | recent restore 体验与"会话为中心"理念不符、且对老用户造成数据回潮 bug |
| **6c877f4** | 大型产品迭代：服务层 .js → .ts；同步锁；按钮可访问性；删除 service-worker.js；批量修复 Toast/弹窗/拖拽回归；新增 12 份规划文档 | 从"能用的扩展"升级为"以会话为中心的产品" |

### 8.4 技术债

| 位置 | 问题 | 严重度 |
|---|---|---|
| `public/SCREENSHOTS_REQUIRED.txt` | Chrome Web Store 截图/宣传视频未准备 | **高** |
| `.omx/` logs 与 state/ | 工作区元数据持续累积；曾因"全部提交"指令在 2f32d67 一次性删 12 份规划文档 | 中 |
| `src/components/tabs/ReorderView/index.tsx` 等 18 个文件 | git status 显示这些组件仍在 uncommitted 修改中 | 中 |
| `tests/` | 仅 3 个测试文件，属性测试（theme-persistence-fix §5）未实现 | 中 |
| `src/utils/encryptionUtils.ts` | chunked base64 是性能/栈深度 workaround；如数据量再增长需重写为 streaming | 低 |
| `src/service-worker.ts` | 5c7bcce 后只剩 .ts，但 b68b170/dcf42f5/9fbd1fd 又叠加了安全校验与中间件，单元测试覆盖近乎为零 | 中 |
| `manifest.json description` | 中英文混排，可能影响 Chrome Web Store 审核 | 低 |
| `tests/` + `scripts/` | 不在 tsconfig include 内，得不到 tsc 保护 | 中 |
| `chrome-extension.zip` | 包内仍含 .htaccess 与 src/popup/、src/auth/ 目录 | 中 |
| 品牌一致性 | manifest.name=TabStack vs README/PRIVACY/design-system=.env.example=TabVault Pro | **高** |

### 8.5 已移除功能

- **recent restore / recent save UI 与状态**（3e95aae）—— 完全删除 RecentRestoreEntry、SessionRestoreSource、recentRestores thunk
- **SyncPromptManager / SyncPromptModal / syncPromptUtils**（8629fc6, v1.9.7）
- **Realtime 同步**（e22c273, 2025-04）—— 删除 src/services/realtimeService.ts
- **Manifest V3 不允许的远程代码**（f8c6651）
- **Settings 独立页面**（cd6f62e）
- **虚拟列表**（7312d74）
- **旧书签管理功能文档**（71cd3e5）
- **宣传网站 landing-page**（5b17723）
- **约 24 份历史审计/优化/同步/UI 报告**
- **8 个遗留 @dnd-kit 组件**（b68b170）—— ~1160 行
- **dead code slices**（9fbd1fd）—— src/background.ts、simpleMoveTabAndSync.ts
- **12 份规划/路线图/访谈/定价/商店文案文档**（2f32d67）

### 8.6 现有 Spec

**`.kiro/specs/theme-persistence-fix/`**：
- `requirements.md`（EARS 形式需求）
- `tasks.md`（任务清单，带验收引用）
- `design.md`（5 个正确性属性 + 测试策略）
- **状态**：所有验收准则（1.1–1.4, 2.1–2.3, 3.1–3.3）已在 tasks.md 中标记为完成；但属性测试 §5（5.1–5.5）和示例测试 §6 仍 unchecked (optional 任务)。修复本身在 f0c1ade 阶段中体现

### 8.7 发布节奏

- 约 1–2 个月一版
- 2025-04 first commit → 2025-09 v1.7–1.8（高频小步）→ 2025-11 v1.9.0 引入同步雏形 → 2025-12 v1.9.1–1.9.7 主题与存储重构 → 2026-01 v1.11.0 主题系统大版 → 2026-02 v1.11.3–1.11.4 修复 → 2026-03 v1.11.5 + session-focused 大迭代 → 2026-05 v1.11.8 + TabStack 品牌重塑 + Web Store 准备
- **最近 30 天从 v1.11.5 直接到 v1.11.8**（中间跳过 1.11.6/1.11.7），表明已切换到「阻塞问题集中合并」模式

### 8.8 风险清单

1. **Chrome Web Store 审核未启动**：缺少截图/视频/英文描述单语化（manifest description 混中英）
2. **git status 18 个文件 modified 但未 commit**：发布分支与主分支可能漂移；下次 rebase/合并可能引入回归
3. **属性测试未实现**：加密/存储改动后缺乏回归保护
4. **Supabase 项目 ID 与 anon key 硬编码**：host_permissions 与 connect-src 明确指向 `reccclnaxadbuccsrwmg`；切换/迁移成本不低
5. **autoSyncMiddleware 并发上传在弱网或同账号多设备下可能产生版本冲突**：目前仅靠 latest-wins 策略（syncStrategy: newest/merge）兜底
6. **IndexedDB 配额与跨浏览器（Firefox/Safari）兼容未在 CI 验证**：CRXJS Vite 插件仍为 beta (^2.0.0-beta.21)

### 8.9 推测的下一步

1. 准备 Chrome Web Store 资产（截图、宣传图、英文单语版 description、隐私政策 URL）并正式提交
2. 把 git status 中 18 个未提交的组件修改 commit/push，发布 v1.11.9 patch
3. 补齐属性测试 + 服务层单元测试（service-worker、autoSyncMiddleware、smartSyncService）
4. 跑一次完整 `pnpm validate` 确保商店提交无警告
5. 评估是否恢复 12 份被删的规划文档（COFOUNDER_ROADMAP、PRICING_PLAN 等）至少恢复 PRICING_PLAN / STORE_COPY，支撑后续 v1.12 的"定价/商业化"探索
6. 监控 v1.11.8 上线后的 sync 成功率与崩溃率

---

## 9. 当前关键问题清单（决策导向）

### 9.1 🔴 阻断级（必须解决）

1. **Chrome Web Store 截图缺失**（`public/SCREENSHOTS_REQUIRED.txt` 明确要求）
2. **品牌名三处不一致**（manifest=TabStack, README/PRIVACY/design-system/.env.example=TabVault Pro）
3. **dist 残留**（包内含 .htaccess 与 src/popup|auth 源码目录）
4. **git status 18 个文件未 commit**（发布分支漂移风险）

### 9.2 🟡 高优先级

1. **测试覆盖率 < 5%**：无 Redux slice / service-worker / Supabase / storage / UI 组件单测
2. **无 CI/CD**：发布全靠本地 `pnpm package` + 手动上传
3. **属性测试（theme-persistence-fix §5）未实现**
4. **manifest description 中英文混排**（影响商店审核）
5. **scripts/ 与 tests/ 不在 tsconfig include 内**

### 9.3 🟢 中优先级

1. **service-worker.ts 仍有"已简化同步逻辑"注释**（与实际不符）
2. **syncStrategy='ask' 缺少冲突解决 UI**
3. **非严格 E2EE**（Supabase admin 理论上可解密）
4. **chunked base64 workaround**（数据量大时需重写）
5. **CRXJS Vite 插件仍为 beta**（^2.0.0-beta.21）

### 9.4 ⚪ 已就绪

- ✅ TypeScript strict + noUnusedLocals + noUnusedParameters
- ✅ ESLint --max-warnings 0
- ✅ 4 步 validate 流水线（metadata → tsc → lint → build）
- ✅ Supabase 端到端烟雾测试（与生产同款加密）
- ✅ 8 套主题系统 + 250ms 平滑过渡
- ✅ WCAG 2.1 AA 级可访问性
- ✅ 性能监控三层工具
- ✅ 代码层安全审计（base64 分块、isEncrypted 类型守卫、decryptLocalBlob 损坏返回 null、sender 校验、URL 白名单、CSP 收紧、删除确认等）
- ✅ 4 种同步策略（smartSync / autoSync / manualSync / periodicSync）
- ✅ 软删除 + version 字段冲突解决

---

## 10. 决策指南（给 Co-founder）

### 10.1 如果现在要发布 v1.11.8

**前置任务清单**（按优先级）：

1. **统一品牌名**（1-2 小时）：
   - 改 README.md 标题 "TabVault Pro" → "TabStack"
   - 改 PRIVACY_POLICY.md 首行 "# TabVault Pro Privacy Policy" → "TabStack Privacy Policy"
   - 改 design-system 目录名 `design-system/tabvault-pro/` → `design-system/tabstack/`
   - 改 .env.example 的 `VITE_APP_NAME=TabVault Pro` → `VITE_APP_NAME=TabStack`

2. **修复 dist 残留**（1-2 小时）：
   - 改 `package-extension.js`，按白名单清理 dist/
   - 白名单：manifest.json / icons/ / service-worker.js / popup.html / index-*.{js,css} / confirm-*.{js,html} / assets/ (必要)

3. **准备 store 截图**（4-8 小时）：
   - 1280×800 或 640×400 至少 1 张
   - 推荐 4 张：主弹窗 / Onboarding / 搜索 / 统计

4. **整理 manifest description**（30 分钟）：
   - 改为纯英文（Chrome Web Store 推荐）或纯中文
   - 当前混合："TabStack - 浏览器工作会话管理器。保存当前窗口..."

5. **commit 18 个未提交文件**（30 分钟）：
   - 检视每个 diff，确保无意外

6. **跑 `pnpm validate`**（5 分钟）：确保零警告

7. **打包 + 提交**：`pnpm package` → 上传 `chrome-extension.zip` 到 Chrome Web Store Dashboard

### 10.2 如果要继续功能迭代

**建议优先方向**：

1. **测试覆盖**（投资回报最高）
   - 给 `src/store/slices/tabSlice.ts` 的 18 个 thunk 加单测（mock storage + supabase）
   - 给 `src/services/smartSyncService.ts` 加单测
   - 给 `src/store/middleware/autoSyncMiddleware.ts` 加单测
   - 目标：覆盖率从 < 5% → 30%

2. **补 CI/CD**（1-2 天）：
   - 加 `.github/workflows/ci.yml`：`pnpm validate` 自动跑
   - 加 `.github/workflows/release.yml`：tag 触发自动 `pnpm package` + 上传 artifact

3. **跨浏览器兼容**（2-3 天）：
   - 验证 Firefox / Safari
   - 注意 CRXJS Vite 插件对 Firefox 的支持

4. **探索商业化**（产品策略）：
   - 恢复 `PRICING_PLAN.md` / `STORE_COPY.md` 文档
   - 设计免费 vs Pro 层级（云同步配额、主题、高级搜索？）

### 10.3 如果要重构

**潜在重构点**（按风险排序）：

1. **重构 encryptionUtils.ts 的 chunked base64**（低风险，渐进式）
2. **拆分 service-worker.ts**（中风险，需谨慎）
3. **引入 Zustand/Jotai 替代 Redux Toolkit 的部分场景**（高风险，不建议）
4. **从 react-dnd 迁移到 @dnd-kit**（中风险，package.json 已有依赖但未使用）

---

## 附录 A：文件清单速查

### A.1 配置与文档

- `manifest.json` — MV3 清单
- `package.json` — npm 元数据
- `vite.config.ts` — Vite + crxjs 配置
- `tailwind.config.js` — Tailwind 主题（10.8 KB）
- `tsconfig.json` + `tsconfig.node.json` — TS 配置
- `.eslintrc.cjs` + `.prettierrc` — Lint + Format
- `README.md` + `PRIVACY_POLICY.md` — 用户文档
- `popup.html` + `src/popup/index.html` + `src/auth/confirm.html` — HTML 入口
- `build.sh` + `package-extension.js` — 打包脚本
- `scripts/validate-extension.mjs` + `scripts/supabase-smoke-test.mjs` — CI 脚本

### A.2 源码

- **109 个 TS/TSX 文件**（约 17,971 行）
- `src/service-worker.ts`（MV3 后台，~11 KB）
- `src/background/TabManager.ts`（浏览器 API 封装）
- `src/popup/{index.html,index.tsx,App.tsx}`（Popup 入口）
- `src/store/`（3 slice + 1 middleware）
- `src/services/`（5 个 service）
- `src/utils/`（33 个工具）
- `src/components/`（8 个子目录，~40+ 组件）
- `src/domain/tabGroup/`（3 个纯函数模块）
- `src/storage/`（4 个存储抽象）
- `src/auth/confirm.html`（邮箱确认回调）
- `src/types/tab.ts`（领域类型单一来源）
- `src/contexts/{ThemeContext,ToastContext}.tsx`

### A.3 测试

- `tests/inputValidation.test.ts`
- `tests/sessionName.test.ts`
- `tests/tabFilters.test.ts`

### A.4 静态资源

- `icons/icon{16,48,128}.png` + `icons/tabstack_icon.svg`（品牌）
- `public/favicon.ico` + `public/icon{16,48,128}.png`（备选）
- `dist/SCREENSHOTS_REQUIRED.txt`（截图占位说明）

### A.5 设计系统

- `design-system/tabvault-pro/MASTER.md`（颜色/字体/间距/阴影/反模式）
- `design-system/tabvault-pro/pages/`（空目录）

### A.6 Spec

- `.kiro/specs/theme-persistence-fix/{requirements,tasks,design}.md`

---

## 附录 B：术语表

| 术语 | 解释 |
|---|---|
| **MV3** | Chrome Extension Manifest Version 3，最新一代扩展规范 |
| **Service Worker** | MV3 后台脚本（替代 MV2 的 background page），事件驱动 |
| **Popup** | 用户点击扩展图标时弹出的小窗口 |
| **Content Script** | 注入到目标网页上下文的脚本（TabStack 不使用） |
| **Thunk** | Redux Toolkit 的异步 action 封装 |
| **Slice** | Redux Toolkit 的 reducer + action 集合 |
| **Middleware** | Redux 中间件，拦截 action 链 |
| **IndexedDB** | 浏览器内嵌数据库，扩展存储 |
| **chrome.storage** | Chrome 扩展的 KV 存储 API |
| **AES-GCM** | 高级加密标准 - 伽罗瓦/计数器模式，认证加密 |
| **PBKDF2** | 基于密码的密钥派生函数，100k 迭代防暴力破解 |
| **RLS** | Row-Level Security，Supabase 行级安全策略 |
| **E2EE** | End-to-End Encryption，端到端加密 |
| **CSP** | Content Security Policy，内容安全策略 |
| **WCAG** | Web Content Accessibility Guidelines |
| **EARS** | Easy Approach to Requirements Syntax，需求书写格式 |

---

**文档结束** | 调研覆盖 8 维度 / 700+ 源文件 / 48 万 token | 生成于 2026-06-01
