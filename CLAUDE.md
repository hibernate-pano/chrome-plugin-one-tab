# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

TabVault Pro 是一个 Chrome 浏览器扩展程序，用于高效管理标签页。它提供一键保存标签页、云端同步、智能搜索等功能。

## 开发命令

### 基本命令
```bash
# 开发模式 - 启动开发服务器
pnpm dev

# 构建生产版本 - 编译并复制 service worker
pnpm build

# 开发版本构建
pnpm build:dev

# 打包扩展 - 构建并打包为可分发的扩展文件
pnpm package

# 代码检查
pnpm lint

# 代码格式化
pnpm format

# 类型检查 - 不生成文件，仅检查 TypeScript 类型错误
pnpm type-check

# 验证扩展
pnpm validate
```

### 测试扩展
1. 运行 `pnpm build` 构建扩展
2. 打开 Chrome，访问 `chrome://extensions/`
3. 启用"开发者模式"
4. 点击"加载已解压的扩展程序"
5. 选择 `dist` 文件夹

## 项目架构

### 技术栈
- **前端**: React 18 + TypeScript
- **状态管理**: Redux Toolkit (三个主要 slice: tabs, settings, auth)
- **构建工具**: Vite + @crxjs/vite-plugin
- **样式**: Tailwind CSS
- **后端服务**: Supabase (认证 + 数据同步)
- **拖拽功能**: @dnd-kit (主要实现) + react-dnd (备用)

### 核心架构设计

#### 1. Chrome 扩展结构
- **Service Worker** (`src/service-worker.ts`): Chrome MV3 后台脚本，处理扩展图标点击、快捷键、右键菜单等事件
- **Popup 页面** (`popup.html` / `src/popup/index.html`): 扩展的主界面
- **Manifest V3**: 使用 Chrome Extension Manifest V3 规范

#### 2. 状态管理架构
Redux Store 位于 `src/store/index.ts`，包含三个 slice:
- **tabSlice** (`src/store/slices/tabSlice.ts`): 管理标签组和标签数据
- **settingsSlice** (`src/store/slices/settingsSlice.ts`): 管理用户设置（主题、同步策略等）
- **authSlice** (`src/store/slices/authSlice.ts`): 管理认证状态和用户信息

#### 3. 数据持久化和同步
- **本地存储**: 使用 `chrome.storage.local` 存储标签组数据（键名：`tab_groups`）
- **云端同步**: 通过 Supabase 实现跨设备同步
  - 认证服务: `src/utils/supabase.ts` 中的 `auth` 对象
  - 同步服务: `src/utils/supabase.ts` 中的 `sync` 对象
  - 智能同步: `src/services/smartSyncService.ts` 和 `src/services/syncService.ts`
- **数据加密**: `src/utils/encryptionUtils.ts` 提供端到端加密
- **数据压缩**: `src/utils/compressionUtils.ts` 使用 lz-string 压缩数据

#### 4. Service Worker 关键功能
- **标签管理器** (`tabManager` 对象):
  - `saveAllTabs()`: 保存所有标签页并关闭
  - `openTabManager()`: 打开或激活标签管理器页面
  - `createTabGroup()`: 创建标签组，自动过滤无效标签（chrome://, edge://, about: 等）
- **存储迁移**: `migrateStorageKeys()` 处理旧键名 `tabGroups` 到新键名 `tab_groups` 的迁移
- **消息处理**: 监听来自前端的消息（OPEN_TAB, SAVE_ALL_TABS 等）

#### 5. 构建配置特殊处理
Vite 配置 (`vite.config.ts`) 包含特殊处理:
- **Service Worker 分离**: 由于 @crxjs/vite-plugin 不支持 service worker，通过自定义插件在构建后恢复 manifest.json 的 background 配置
- **手动代码分块**: 将 React、Redux、Supabase 等库分别打包到不同的 vendor chunk
- **生产环境优化**: 移除 console 和 debugger 语句
- **路径别名**: `@/*` 映射到 `src/*`

#### 6. 组件架构
组件分为以下几类:
- **app/**: 应用容器、认证提供者、同步提示管理器
- **auth/**: 登录、注册、用户资料组件
- **tabs/**: 标签列表、标签组、标签预览
- **dnd/**: 拖拽相关组件（支持 @dnd-kit 和 react-dnd 两种实现）
- **search/**: 搜索栏、搜索结果、高亮文本
- **sync/**: 同步状态、同步按钮
- **layout/**: 页头、主题切换、标签计数器
- **common/**: 通用组件（对话框、图标、加载动画等）

#### 7. 数据流
1. 用户点击扩展图标 → Service Worker 收集标签页 → 创建标签组 → 保存到 chrome.storage.local → 关闭标签页 → 打开标签管理器
2. 标签管理器启动 → 从 chrome.storage.local 加载数据 → 显示在 Redux Store → 渲染 UI
3. 用户修改数据 → Redux action → Reducer 更新 state → 保存到 chrome.storage.local → 如果启用同步则上传到 Supabase
4. 云端同步 → 下载 Supabase 数据 → 解密 → 合并本地数据 → 更新 Redux Store 和 chrome.storage.local

## 重要约定

### 存储键名
- **标签组**: `tab_groups` (旧键名 `tabGroups` 已弃用，会自动迁移)
- **用户设置**: `settings`
- **设备 ID**: `deviceId`

### Service Worker 限制
- Service Worker 中不能使用模块导入（避免模块加载问题）
- 所有核心功能直接在 `service-worker.ts` 中实现
- 使用简单的内联函数和工具类

### 数据格式
- **TabGroup**: 包含 id, name, tabs, createdAt, updatedAt, isLocked
- **Tab**: 包含 id, url, title, favicon, createdAt, lastAccessed
- **Supabase 存储**: 使用 JSONB 字段 `tabs_data` 存储标签数据（已加密）

### 环境变量
项目需要在 `.env` 文件中配置 Supabase 凭证:
- `VITE_SUPABASE_URL`: Supabase 项目 URL
- `VITE_SUPABASE_ANON_KEY`: Supabase 匿名密钥

### 快捷键
- `Ctrl+Shift+S` / `Cmd+Shift+S`: 打开标签管理器
- `Alt+Shift+S`: 保存所有标签页
- `Alt+S`: 保存当前标签页

## 常见问题

### 构建后 Service Worker 不工作
确保运行完整的构建命令 `pnpm build`，它会自动复制 `service-worker.js` 到 `dist` 目录并恢复 manifest.json 的 background 配置。

### 云端同步失败
检查:
1. Supabase 配置是否正确
2. 用户是否已登录（检查 authSlice 状态）
3. 是否有网络连接
4. Supabase RLS（行级安全）策略是否正确配置

### 标签组数据丢失
- 标签组存储在 `chrome.storage.local` 的 `tab_groups` 键中
- 使用 Chrome DevTools → Application → Storage → Extension Storage 检查数据
- 检查是否有存储键名迁移问题（`tabGroups` vs `tab_groups`）

### 拖拽功能异常
项目同时支持 @dnd-kit 和 react-dnd 两种拖拽实现，检查使用的是哪个实现以及对应的组件是否正确配置。
