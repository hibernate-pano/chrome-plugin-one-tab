# TabStack 商店截图指南

Chrome Web Store 详情页的核心转化元素是 **主图**。本指南告诉你拍什么、怎么拍。

## 需要的 4 张图

| 文件名 | 尺寸建议 | 展示什么 |
|---|---|---|
| `popup-main.png` | 1280×800 | popup 主界面，至少 3 个会话组可见 |
| `popup-search.png` | 1280×800 | 搜索框有输入，有搜索结果列表 |
| `popup-sync.png` | 1280×800 | 同步状态指示（"已同步 X 分钟前"或"正在同步..."） |
| `popup-themes.png` | 1280×800 | 主题切换器展开，能看到至少 4 套主题 |

**总尺寸**：Chrome Web Store 推荐 1280×800 或 640×400 PNG/JPG。文件 < 1MB。

## 文件位置

全部放在 `docs/store-screenshots/`：

```
docs/
└── store-screenshots/
    ├── popup-main.png
    ├── popup-search.png
    ├── popup-sync.png
    └── popup-themes.png
```

拍完后 landing page 自动会读到（更新 `docs/landing/index.html` 里的 `<img>` 标签即可）。

## 怎么拍：Chrome 扩展 popup 截图

### 准备

1. `pnpm build` 后 `chrome://extensions/` 加载 `dist`
2. 用一个临时测试账号登录，确保有 Supabase 数据（这样能拍到 sync 状态）
3. 准备好 ~10 个会话组（demo 数据可用 `__TV_BENCH__.seedLargeDataset()` 生成）

### macOS 截图扩展 popup 的标准方法

Chrome 扩展 popup 默认会随点击关闭，无法用 `Cmd+Shift+4` 直接抓。

**推荐方法：DevTools 捕获**

1. 点扩展图标打开 popup
2. 在 popup 任意位置 **右键 → "检查"**
3. DevTools 打开后，按 `Cmd+Shift+P` 输入 `Capture screenshot`（或 `Capture full size screenshot`）
4. 选 `Capture screenshot` 即可截当前 viewport
5. **重要**：先把 viewport 调到 1280×800（DevTools 左上角设备图标 → Responsive）

### Windows / Linux 等价方法

Chrome DevTools 同上。系统截图工具框选 popup 区域。

## 4 张图的具体拍法

### popup-main.png

1. 加载默认主题（"原始"或"经典"）
2. 至少有 3 个不同名称的会话组
3. 至少 1 个会话组有 ≥ 5 个 tabs
4. 关闭 onboarding（如果首次启动）
5. 截图

### popup-search.png

1. 在搜索框输入一个常见关键字，如 "github" 或 "react"
2. 等待搜索结果显示（应该 200ms 内出结果）
3. 截图（带搜索框的当前内容 + 结果列表）

### popup-sync.png

1. 登录账号（如未登录）
2. 触发一次手动同步（界面按钮）
3. 等同步完成（status 变 "已同步 X 秒前"）
4. 截图（status bar 在底部能看到）

### popup-themes.png

1. 打开设置面板（通常是齿轮图标）
2. 切到主题选择 tab
3. 展开主题列表
4. 截图（能看到主题预览卡片）

## 拍完后的检查清单

- [ ] 4 张图全部上传到 `docs/store-screenshots/`
- [ ] 文件名完全匹配上述规范（小写 + 连字符）
- [ ] 每张图 < 1MB（用 `sips -s format jpeg --resampleHeight 800 input.png --out output.jpg` 压缩）
- [ ] 在 light theme 下重拍一份（如果想兼容白天环境）
- [ ] landing page `<img>` 标签 src 指向新路径
- [ ] git commit + push

## 备选：使用 brand icon

如果实在来不及拍，至少把 `icons/icon128.png` 复制成 `docs/store-screenshots/popup-main.png`，商店会有图但转化率会差。

**商店审核要求**：必须至少 1 张 screenshot，否则会被拒。
