# Chrome标签管理器 (OneTab Clone)

这是一个Chrome浏览器扩展程序，用于高效管理和组织浏览器标签页。

## 功能特点

- 一键保存所有打开的标签页
- 将多个标签页转换为列表形式保存，减少内存占用
- 支持标签组管理和分类
- 支持标签页的导入/导出
- 支持标签页的恢复和删除
- 支持标签组的命名和重命名
- 支持标签页的搜索功能
- 支持快捷键操作

## 技术栈

- TypeScript
- React
- Chrome Extension API
- Webpack
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

## 贡献指南

欢迎提交 Pull Request 或创建 Issue。

## 许可证

MIT License 