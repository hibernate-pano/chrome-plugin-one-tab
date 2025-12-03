# TabVault Pro 宣传网站

这是一个为 TabVault Pro Chrome 扩展设计的现代化宣传网站。

## 功能特性

- ✨ 现代化的设计风格
- 📱 完全响应式设计
- 🎨 流畅的动画效果
- ⚡ 高性能和优化
- 🔍 SEO 友好

## 文件结构

```
landing-page/
├── index.html      # 主HTML文件
├── styles.css      # 样式文件
├── script.js       # JavaScript交互文件
└── README.md       # 说明文档
```

## 使用方法

### 本地预览

1. 直接在浏览器中打开 `index.html` 文件
2. 或者使用本地服务器：

```bash
# 使用 Python
python -m http.server 8000

# 使用 Node.js (需要安装 http-server)
npx http-server -p 8000

# 使用 PHP
php -S localhost:8000
```

然后访问 `http://localhost:8000`

### 部署

可以将整个 `landing-page` 文件夹部署到任何静态网站托管服务：

- GitHub Pages
- Netlify
- Vercel
- Cloudflare Pages
- 或其他静态网站托管服务

## 设计特色

### 颜色方案

- **主色调**: 紫色渐变 (#6366f1 → #8b5cf6 → #ec4899)
- **背景**: 白色和浅灰色
- **文字**: 深灰色系，确保良好的可读性

### 字体

- **标题**: Space Grotesk - 现代、几何感强
- **正文**: Inter - 清晰、易读

### 动画效果

- 平滑滚动
- 渐入动画
- 悬停效果
- 视差滚动

## 自定义配置

### 修改颜色

在 `styles.css` 中的 `:root` 变量中修改：

```css
:root {
  --color-primary: #6366f1;
  --color-primary-dark: #4f46e5;
  /* ... 其他颜色 */
}
```

### 修改内容

直接编辑 `index.html` 文件中的对应部分即可。

### 添加新功能

1. 在 `index.html` 中添加HTML结构
2. 在 `styles.css` 中添加样式
3. 在 `script.js` 中添加交互逻辑

## 浏览器支持

- Chrome (最新版本)
- Firefox (最新版本)
- Safari (最新版本)
- Edge (最新版本)

## 性能优化

- 使用 CSS 动画而非 JavaScript（性能更好）
- 图片懒加载（如果添加图片）
- 防抖滚动事件
- 优化的 CSS（避免重绘和回流）

## 注意事项

1. 确保所有链接（如 Chrome 商店链接）都指向正确的位置
2. 根据实际需要更新联系信息和社交媒体链接
3. 可以在浏览器开发者工具中测试不同设备尺寸的响应式效果

## 许可证

与主项目相同（MIT License）
