# TabStack

当前版本：`1.12.0`

> Save the session. Find it later. Restore it when you need it.

TabStack 是一个面向重度浏览器用户的**工作会话保险箱**。把当前窗口保存成可找回、可恢复的工作现场。

## 适合谁用

- **开发者**：文档、PR、Issue、控制台、监控 — 同时开几十个标签页
- **研究者**：论文、论坛、竞品、视频、资料需要长时间并行
- **内容作者**：选题、草稿、引用、素材反复切换
- **商务用户**：CRM、表格、邮件、公司页需要保持上下文

## 核心能力

- **一键保存**：将当前窗口所有标签页保存为一个工作会话
- **智能搜索**：按会话名、备注、标签标题、URL 快速找回
- **一键恢复**：在新窗口中恢复整个会话，不打乱当前窗口
- **会话管理**：重命名、备注、收藏、锁定、删除、拖拽排序
- **云端同步**：登录后自动同步到云端（支持手动上传/下载）
- **使用统计**：查看保存的会话数、标签数、常用域名等数据分析
- **8 种主题**：原始、经典、极光、奶油、粉红、薄荷、赛博、棱镜
- **键盘快捷键**：Ctrl+Shift+S 打开、Alt+Shift+S 保存全部、Alt+S 保存当前
- **导入导出**：JSON 备份、OneTab 格式兼容

## 安装

### Chrome 商店

访问 [Chrome Web Store](https://chrome.google.com/webstore) 搜索 `TabStack`

### 开发模式

```bash
git clone https://github.com/hibernate-pano/chrome-plugin-one-tab.git
cd chrome-plugin-one-tab
pnpm install
pnpm build
```

在 `chrome://extensions/` 开启开发者模式，加载 `dist` 目录。

## 开发

```bash
pnpm install          # 安装依赖
pnpm dev              # 开发模式
pnpm build            # 生产构建
pnpm test             # 运行测试
pnpm type-check       # 类型检查
pnpm lint             # 代码规范
pnpm validate         # 全面验证（元数据 + 类型 + Lint + 构建）
```

### 测试

```bash
# 单元测试
pnpm test

# Supabase 端到端烟雾测试
TEST_EMAIL="your@email.com" TEST_PASSWORD="password" pnpm test:supabase-smoke
```

## 同步模式

- **智能同步**：保存/删除/重命名等操作后自动同步到云端（需登录）
- **登录自动下载**：登录后自动从云端拉取并与本地合并
- **手动同步**：随时通过界面按钮手动上传/下载
- 每次同步可选择**覆盖**或**合并**策略

## 隐私与安全

- 本地数据存储在浏览器扩展的 IndexedDB 中
- 云端数据使用 AES-GCM 客户端加密后传输
- 同步完全由你控制，不会在后台持续上传
- 详见 [PRIVACY_POLICY.md](./PRIVACY_POLICY.md)

## 技术栈

- **前端**：React 18 + TypeScript + Redux Toolkit
- **拖拽**：react-dnd
- **样式**：Tailwind CSS 3 + 8 套主题
- **后端**：Supabase（PostgreSQL + Row Level Security）
- **加密**：Web Crypto API（AES-GCM）
- **构建**：Vite + crxjs

## 仓库

- [hibernate-pano/chrome-plugin-one-tab](https://github.com/hibernate-pano/chrome-plugin-one-tab)
- [Issue 反馈](https://github.com/hibernate-pano/chrome-plugin-one-tab/issues)

## License

MIT
