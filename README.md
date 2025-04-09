# OneTab Plus - Chrome标签管理器 (v1.0)

这是一个Chrome浏览器扩展程序，用于高效管理和组织浏览器标签页。现已发布稳定的 1.0 版本。

## 功能特点

- 一键保存所有打开的标签页
- 将多个标签页转换为列表形式保存，减少内存占用
- 支持标签组管理和分类
- 支持标签页的导入/导出
- 支持标签页的恢复和删除
- 支持标签组的命名和重命名
- 支持标签页的搜索功能
- 自动过滤 Chrome 内部页面（chrome://）和扩展页面（chrome-extension://）
- 可配置是否允许保存重复的标签页
- 支持浅色/深色主题
- 支持快捷键操作：
  - Alt+Shift+S: 保存所有标签页
  - Alt+S: 保存当前标签页
  - Ctrl+Shift+S (Mac: Command+Shift+S): 打开扩展弹窗

## 技术栈

- TypeScript
- React
- Redux
- Chrome Extension API
- Vite
- TailwindCSS

## 开发环境设置

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

## 在Chrome中安装开发版本

1. 打开Chrome浏览器，进入扩展程序页面 (chrome://extensions/)
2. 开启"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择项目的 `dist` 目录

## 使用说明

1. 点击工具栏中的扩展图标，将当前所有标签页保存到列表中
2. 在扩展管理页面中可以：
   - 查看所有保存的标签组
   - 恢复单个标签或整组标签
   - 对标签组进行重命名
   - 删除不需要的标签或标签组
   - 搜索已保存的标签页
   - 导入/导出标签数据
   - 访问设置页面进行个性化配置

## 详细文档

查看 [DOCUMENTATION.md](./DOCUMENTATION.md) 获取更详细的项目文档、架构说明和开发指南。

## 最近更新 (v1.0)

### 新功能

- **搜索功能优化**：
  - 将“搜索标签组”改为“搜索标签”
  - 搜索结果现在只显示匹配的标签，而不是显示整个标签组
  - 每个搜索结果显示标签所属的标签组

- **重复标签页处理**：
  - 添加了“允许保存重复的标签页”设置选项
  - 默认情况下，保存标签页时会过滤掉重复的 URL，只保留最新的一个

### 问题修复

- 修复了在弹出窗口中恢复标签页后，标签页没有从列表中删除的问题
- 改进了标签页恢复和删除的错误处理

## 贡献指南

欢迎提交 Pull Request 或创建 Issue。

## 许可证

MIT License