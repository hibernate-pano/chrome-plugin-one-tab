# OneTab Plus - 标签管理器文档 (v1.0)

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

- **标签页操作**：
  - 恢复单个标签页
  - 恢复整个标签组的所有标签页
  - 删除单个标签页
  - 搜索标签页（按标题或 URL）
  - 搜索结果只显示匹配的标签，而不是整个标签组

- **数据管理**：
  - 导出所有标签组数据
  - 导入标签组数据
  - 自动保存功能（可配置保存间隔）

- **用户界面**：
  - 可配置是否显示网站图标
  - 响应式设计，适应不同屏幕尺寸

### 快捷键

- `Alt+Shift+S`：保存所有标签页
- `Alt+S`：保存当前标签页
- `Ctrl+Shift+S`（Mac：`Command+Shift+S`）：打开扩展弹窗

## 用户设置

OneTab Plus 提供了多种可自定义的设置选项：

### 自动保存设置
- 启用/禁用自动保存
- 自动保存间隔（5分钟、10分钟、15分钟、30分钟、1小时）

### 标签组设置
- 标签组名称模板
- 允许/禁止保存重复的标签页

### 显示设置
- 显示/隐藏网站图标

### 操作确认设置
- 删除前确认

## 技术架构

### 整体架构

项目采用现代化的前端技术栈和 Chrome 扩展架构：

```
├── 前端界面 (React + TypeScript)
├── 状态管理 (Redux)
├── 存储层 (Chrome Storage API)
└── 浏览器交互层 (Chrome Extension API)
```

### 核心模块

1. **标签管理模块**
   - 标签页捕获
   - 标签组管理
   - 标签页恢复
   - 搜索引擎

2. **存储模块**
   - 本地数据持久化
   - 数据导入/导出
   - 数据压缩/解压
   - 数据同步

3. **UI模块**
   - 弹出窗口界面
   - 标签页列表组件
   - 设置页面
   - 主题系统

### 数据结构

1. **标签页对象**
```typescript
interface Tab {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  createdAt: string;
  lastAccessed: string;
}
```

2. **标签组对象**
```typescript
interface TabGroup {
  id: string;
  name: string;
  tabs: Tab[];
  createdAt: string;
  updatedAt: string;
  isLocked: boolean;
}
```

3. **用户设置**
```typescript
interface UserSettings {
  theme: 'light' | 'dark' | 'system';
  autoCloseTabsAfterSaving: boolean;
  autoSave: boolean;
  autoSaveInterval: number;
  groupNameTemplate: string;
  showFavicons: boolean;
  showTabCount: boolean;
  confirmBeforeDelete: boolean;
  allowDuplicateTabs: boolean;
}
```

## 使用指南

### 安装扩展

1. 打开 Chrome 浏览器，进入扩展程序页面 (chrome://extensions/)
2. 开启"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择项目的 `dist` 目录

### 基本使用

1. **保存标签页**：
   - 点击浏览器工具栏中的扩展图标，将保存当前窗口的所有标签页
   - 或使用快捷键 `Alt+Shift+S` 保存所有标签页
   - 或使用快捷键 `Alt+S` 保存当前标签页

2. **查看已保存的标签页**：
   - 点击浏览器工具栏中的扩展图标，打开弹出窗口
   - 或使用快捷键 `Ctrl+Shift+S`（Mac：`Command+Shift+S`）打开弹出窗口

3. **恢复标签页**：
   - 在弹出窗口中，点击标签页标题可以恢复单个标签页
   - 点击标签组顶部的"打开所有标签页"按钮可以恢复整个标签组

4. **管理标签组**：
   - 双击标签组名称可以重命名标签组
   - 点击锁定图标可以锁定/解锁标签组
   - 点击删除图标可以删除标签组

5. **搜索标签页**：
   - 在弹出窗口顶部的搜索框中输入关键词，可以搜索标签页标题或 URL
   - 搜索结果只显示匹配的标签，而不是整个标签组
   - 每个搜索结果显示标签所属的标签组

6. **导入/导出数据**：
   - 点击弹出窗口右上角的下拉菜单，选择"导出数据"或"导入数据"

7. **修改设置**：
   - 点击弹出窗口右上角的下拉菜单，选择"设置"

## 最近更新 (v1.0)

### 新功能

- **搜索功能优化**：
  - 将“搜索标签组”改为“搜索标签”
  - 搜索结果现在只显示匹配的标签，而不是显示整个标签组
  - 每个搜索结果显示标签所属的标签组

- **重复标签页处理**：
  - 添加了"允许保存重复的标签页"设置选项
  - 默认情况下，保存标签页时会过滤掉重复的 URL，只保留最新的一个
  - 用户可以在设置中启用允许重复的选项

- **Chrome 内部页面过滤**：
  - 保存标签页时自动过滤掉 Chrome 内部页面（chrome://）
  - 保存标签页时自动过滤掉扩展页面（chrome-extension://）

### 问题修复

- 修复了在弹出窗口中恢复标签页后，标签页没有从列表中删除的问题
- 改进了标签页恢复和删除的错误处理
- 添加了详细的日志记录，便于调试

## 开发指南

### 环境设置

1. 克隆仓库
```bash
git clone https://github.com/yourusername/chrome-plugin-one-tab.git
cd chrome-plugin-one-tab
```

2. 安装依赖
```bash
npm install
```

3. 开发模式运行
```bash
npm run dev
```

4. 构建生产版本
```bash
npm run build
```

### 项目结构

```
src/
├── background/        # 后台脚本
├── components/        # React 组件
│   ├── layout/        # 布局组件
│   ├── settings/      # 设置相关组件
│   └── tabs/          # 标签页相关组件
├── popup/             # 弹出窗口
├── settings/          # 设置页面
├── store/             # Redux 存储
│   └── slices/        # Redux 切片
├── styles/            # 全局样式
├── types/             # TypeScript 类型定义
└── utils/             # 工具函数
```

### 关键文件

- `src/background.ts`：扩展的后台脚本，处理标签页保存和快捷键
- `src/background/index.ts`：后台服务工作线程
- `src/components/tabs/TabGroup.tsx`：标签组组件，处理标签组的显示和操作
- `src/components/tabs/TabList.tsx`：标签列表组件，显示所有标签组
- `src/components/settings/SettingsPanel.tsx`：设置面板组件
- `src/store/slices/tabSlice.ts`：标签页相关的 Redux 切片
- `src/store/slices/settingsSlice.ts`：设置相关的 Redux 切片
- `src/utils/storage.ts`：存储相关的工具函数

## 贡献指南

欢迎提交 Pull Request 或创建 Issue。在提交代码前，请确保：

1. 代码符合项目的编码规范
2. 所有测试通过
3. 提交信息清晰明了
4. 更新相关文档

## 许可证

MIT License
