# CLAUDE.md

本文件为Claude Code（claude.ai/code）在此代码库工作时提供指导。

## 项目概述

OneTab Plus是一个基于React、TypeScript和Redux Toolkit构建的Chrome标签页管理扩展。它允许用户通过Supabase云存储实现跨设备标签页的保存、组织和同步。

## 开发命令

**包管理器**：使用`pnpm`（由packageManager设置要求）

```bash
# 开发
pnpm dev              # 启动开发服务器（支持热重载）
pnpm build            # 生产环境构建（运行TypeScript检查 + Vite构建）
pnpm preview          # 预览生产环境构建

# 代码质量
pnpm lint             # ESLint检查（--max-warnings 0）
pnpm format           # 使用Prettier格式化代码
pnpm type-check       # TypeScript类型检查（不生成输出）
```

## 架构设计

### Chrome扩展结构
- **Manifest V3**：使用service worker（`src/background.ts`）替代后台页面
- **入口点**：
  - `src/popup/index.html` - 主弹窗界面
  - `src/background.ts` - 标签页管理和命令的service worker
  - `src/pages/` - OAuth回调和认证页面

### 状态管理
- **Redux Toolkit**包含三个主要slice：
  - `tabSlice` - 标签组和标签数据管理
  - `settingsSlice` - 用户偏好和配置
  - `authSlice` - 与Supabase的认证状态

### 核心功能实现
- **拖拽排序**：使用`@dnd-kit`库搭配自定义可排序组件
- **云端同步**：基于Supabase后端实现实时同步和加密
- **主题系统**：支持暗色/亮色/自动切换的上下文模式
- **性能优化**：React.Suspense懒加载，大数据列表虚拟化

### 文件结构
```
src/
├── components/        # 可复用UI组件
│   ├── business/     # 业务相关组件（Header, TabGroup等）
│   ├── dnd/          # 拖拽相关组件  
│   └── auth/         # 认证组件
├── store/            # Redux store和slices
├── utils/            # 工具函数（存储、同步、加密）
├── types/            # TypeScript类型定义
└── contexts/         # React上下文（主题、Toast通知）
```

### 存储策略
- **本地存储**：使用Chrome扩展存储API实现离线数据
- **云端存储**：Supabase支持JSONB格式和可选加密
- **缓存机制**：认证状态缓存30天以减少重复登录

### 构建配置
- **Vite**搭配`@crxjs/vite-plugin`进行扩展开发
- **代码分割**：手动切分React、Redux、Supabase和工具模块
- **路径别名**：`@/*`映射到`src/*`

## 测试

当前未配置自动化测试框架。手动测试通过以下方式进行：
- Chrome扩展开发者模式加载
- 开发服务器（`pnpm dev`）测试UI组件

## Chrome扩展部署

1. 构建：`pnpm build`
2. 在Chrome扩展程序（开发者模式）中加载`dist/`目录
3. 测试快捷键：Alt+Shift+S（保存全部）、Alt+S（保存当前）、Ctrl+Shift+S（打开弹窗）

## 重要实现说明

- Service worker处理标签页保存/恢复和OAuth回调
- 认证状态下拖拽操作实时同步至云端  
- 拖拽操作后空标签组自动删除
- 过滤Chrome内部页面（chrome://, chrome-extension://）
- 兼容OneTab格式的导入/导出功能
- 必须使用中文回复