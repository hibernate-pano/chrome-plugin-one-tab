# Landing Page 部署说明

单文件 HTML + Tailwind via CDN，无构建步骤。

## 本地预览

直接双击 `index.html`，或：

```bash
cd docs/landing
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000
```

## 部署到 GitHub Pages

1. Push 到 GitHub 后，访问 `https://github.com/<owner>/chrome-plugin-one-tab/settings/pages`
2. **Source**: Deploy from a branch
3. **Branch**: `main` / `(root)` —— 注意选 `docs/landing` 路径需要稍微不同的配置（见下）

### 方案 A：根目录部署（推荐，最简单）

把 `docs/landing/*` 移到根目录的 `index.html` + `assets/`。或者改用 `vitepress` / `docsify`。**当前方案是单文件，最快的方式是直接放在仓库根目录**：

```bash
cp docs/landing/index.html ./index.html
cp -r docs/landing/assets ./assets
git add index.html assets
git commit -m "docs(landing): add landing page at root for GitHub Pages"
git push
```

然后在 Pages 设置里 Source 选 `main` / `/ (root)`。

### 方案 B：保留在 `docs/landing/`（不改 repo 结构）

GitHub Pages 不支持子目录部署。**这种情况下：**
- 用 `<owner>.github.io/chrome-plugin-one-tab/landing/` 路径访问
- 需要在 `index.html` 里把 `../store-screenshots/` 改成 `./../store-screenshots/`
- 实际不推荐 —— URL 不干净

### 方案 C：自定义域名

如果有 `tabstack.app` 之类的域名：

1. `docs/landing/CNAME` 文件写入域名
2. DNS 加 CNAME 记录指向 `<owner>.github.io`
3. 在 Pages 设置里填自定义域名

## 截图占位替换

`docs/landing/index.html` 第 ~190 行附近，4 个占位 div：

```html
<span class="text-sm">popup-main.png</span>
```

拍完图后改成：

```html
<img src="../store-screenshots/popup-main.png" alt="TabStack 主界面" class="rounded-xl" />
```

详见 [`../SCREENSHOT_GUIDE.md`](../SCREENSHOT_GUIDE.md)。

## Lighthouse 目标

- Performance > 90
- Accessibility > 95
- Best Practices > 95
- SEO > 90

如果分数不达标，Tailwind via CDN 是最大瓶颈（首次解析 ~300KB）。生产环境可改用 Tailwind CLI 预编译，详见 Tailwind 官方文档。
