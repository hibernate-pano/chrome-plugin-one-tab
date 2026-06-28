# TabStack

当前版本：`1.13.6`

> **Save the session. Find it later. Restore it on any device.**
>
> OneTab 简单，但换电脑就没了。TabStack 让你的标签组跟着你走 —— 端到端加密、跨设备同步、8 套主题开箱即用。

[![Version](https://img.shields.io/badge/version-1.13.0-blue)]()
[![License](https://img.shields.io/badge/license-MIT-green)]()
[![MV3](https://img.shields.io/badge/Manifest-V3-orange)]()

## 为什么选 TabStack

| | OneTab | Session Buddy | **TabStack** |
|---|:---:|:---:|:---:|
| 跨设备同步 | ❌ 本机存储 | ❌ 本机存储 | ✅ **端到端加密** |
| Manifest V3 | ❌ 老旧 | ❌ 不再维护 | ✅ 原生 MV3 |
| 8 套主题 | ❌ | ❌ | ✅ |
| OneTab 格式兼容 | ✅ | ❌ | ✅ |
| 客户端加密 | ❌ | ❌ | ✅ AES-GCM |

**TabStack 适合谁**：同时开几十个标签页、又需要跨设备继续工作的人 —— 开发者、研究者、内容作者、商务用户。

## 核心能力

- **一键保存**：把当前窗口所有标签页存为一个工作会话
- **跨设备同步**：登录后自动同步，AES-GCM 端到端加密（云端只存密文）
- **智能搜索**：按会话名 / 备注 / 标签标题 / URL 快速找回
- **一键恢复**：在新窗口中恢复整个会话，不打乱当前窗口
- **会话管理**：重命名、备注、收藏、锁定、删除、拖拽排序
- **使用统计**：查看会话数、标签数、常用域名
- **8 种主题**：原始 / 经典 / 极光 / 奶油 / 粉红 / 薄荷 / 赛博 / 棱镜
- **键盘快捷键**：`Ctrl+Shift+S` 打开 / `Alt+Shift+S` 保存全部 / `Alt+S` 保存当前
- **导入导出**：JSON 备份 + OneTab 格式兼容

## 安装

### Chrome 商店

👉 [Chrome Web Store 搜索 `TabStack`](https://chrome.google.com/webstore)

### 开发模式

```bash
git clone https://github.com/hibernate-pano/chrome-plugin-one-tab.git
cd chrome-plugin-one-tab
pnpm install
pnpm build
```

打开 `chrome://extensions/` 开启开发者模式，加载 `dist` 目录。

## 同步模式

- **智能同步**：保存 / 删除 / 重命名后自动同步到云端（需登录）
- **登录自动下载**：登录后自动从云端拉取并与本地合并
- **手动同步**：随时通过界面按钮手动上传 / 下载
- 每次同步可选择**覆盖**或**合并**策略
- 云端 tombstone 软删机制，确保删除跨设备传播

## 快捷键

| 快捷键 | 动作 |
|---|---|
| `Ctrl+Shift+S`（mac: `Cmd+Shift+S`） | 打开 TabStack 弹窗 |
| `Alt+Shift+S` | 保存当前窗口全部标签页 |
| `Alt+S` | 保存当前标签页 |

## 隐私与安全

- 本地数据存储在浏览器扩展的 IndexedDB 中
- 云端数据使用 AES-GCM 256 + PBKDF2 100k 轮加密后传输
- 同步完全由你控制，不会在后台持续上传
- 不与任何第三方共享数据
- 详见 [PRIVACY_POLICY.md](./PRIVACY_POLICY.md)

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

CI 自动跑 `pnpm validate` + `pnpm test`，详见 `.github/workflows/ci.yml`。

## 技术栈

- **前端**：React 18 + TypeScript + Redux Toolkit
- **拖拽**：react-dnd
- **样式**：Tailwind CSS 3 + 8 套主题
- **后端**：Supabase（PostgreSQL + Row Level Security）
- **加密**：Web Crypto API（AES-GCM 256）
- **构建**：Vite + crxjs

## 仓库

- [hibernate-pano/chrome-plugin-one-tab](https://github.com/hibernate-pano/chrome-plugin-one-tab)
- [Issue 反馈](https://github.com/hibernate-pano/chrome-plugin-one-tab/issues)

## License

MIT
