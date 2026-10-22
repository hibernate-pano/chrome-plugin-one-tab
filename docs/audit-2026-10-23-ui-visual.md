# 第 43 轮审计 · 视觉与可访问性

> 审查员：视觉与可访问性审查员（round 43）
> 基准提交：`23d2aab`（`pnpm build` 后真机 `chromium.launchPersistentContext` + `--load-extension=dist`）
> 审计对象：`src/` 全部 UI 层（6 套主题 × 亮/暗）、`src/styles/`（global + 6 主题 + onboarding + micro-interactions + drag-drop）
> 产出时间：2026-10-23

**本轮性质：只读审计。** 未改动 `src/` 与 `tests/`；唯一新增文件是本报告。

## 0. 方法与口径

| 项 | 口径 |
|---|---|
| 渲染宿主 | `chrome-extension://<id>/src/popup/index.html`（管理页是真实浏览器标签，不是 popup —— `manifest.json` 无 `default_popup`） |
| 浏览器 | Playwright `chromium.launchPersistentContext({headless:false})`，装 `dist/` |
| 主题切换 | `document.documentElement.setAttribute('data-theme', x)` + `classList.toggle('dark')` —— 与产品自己的切主题路径同源 |
| 对比度 | WCAG 相对亮度公式；栈式合成（页面 → 顶栏 → 卡 → 卡头 → 井/浮层），与 `scripts/contrast-audit.mjs` 同模型 |
| 命中区 | WCAG 2.2 SC 2.5.8 AA = 24×24；本仓自订 `MIN_HIT_TARGET_PX = 36`（`src/components/layout/hitTarget.ts`） |
| 焦点可见性 | Playwright **真按 Tab**，每次等待 520~600ms 让过渡落定后再读 `getComputedStyle`；像素级判据另走「截图 → canvas 读真实像素」 |
| 产物 | `outputs/v43/`（gitignored），23 个探针脚本，43 张截图；探针脚本已删除（不入库） |

**读前须知（与第 42 轮的重叠）**：第 42 轮已修的 12 条（命中区 36px、字号层级、筛选面板重写、tooltip 统一、对比度 0 不达标、按钮形状语言、顶栏动作预算、卡片头 favicon、锁定态视觉区分、菜单瘦身）本轮**不重复报告**。核对表见 `docs/audit-2026-10-22-round42.md` §2.5。

---

## 1. 缺陷清单

### V-1 · P0 · 引导页整页写死配色：6 套主题换过去，主按钮还是同一条紫蓝渐变

**位置**：`src/styles/onboarding.css:36-62, 141-188, 231-255, 332-364, 569-588`

**证据**

【代码事实】`onboarding.css` 是一条**独立于主题系统**的样式表：主按钮 `.onboarding-btn-primary` 写死 `background: linear-gradient(135deg, #667eea, #764ba2)`；卡片描边 `.onboarding-card::before` 写死 5 色渐变 `#667eea → #764ba2 → #f093fb → #f5576c → #fda085`；步骤点 `.onboarding-dot.active` / `.completed` 写死 `#667eea`；`.onboarding-feature-card` 写死 `#f9fafb` + `#f3f4f6`；`.onboarding-title` 写死 `#111827`；`.onboarding-description` 写死 `#6b7280`；`.onboarding-version-badge` 写死 `#4338ca` + 蓝紫渐变底；`.onboarding-icon-wrapper` 写死 `linear-gradient(135deg, #eff6ff, #ede9fe)`。全文 587 行里，`var(--color-*)` 只出现 **3 次**（`:298` 跳过按钮字色、`:310` 跳过按钮 hover 字色、`:372` 特性卡描述字色，均为 2026-10-20 那一轮补的）。

【实测】claude 浅色主题下引导页真机计算值（`outputs/v43/probe19.json`）：

| 元素 | 实测值 | claude 主题令牌 |
|---|---|---|
| 主按钮底 | `linear-gradient(135deg, rgb(102,126,234), rgb(118,75,162))` | accent `#c2603f`（陶土红） |
| 卡片描边 | `linear-gradient(135deg, rgb(102,126,234), rgb(118,75,162), rgb(240,147,251), rgb(245,87,108), rgb(253,160,133))` | border `#d9d5c9` |
| 卡片内底 | `rgba(255,255,255,0.97)` | bg-elevated `#faf9f5` |
| 标题字 | `rgb(17,24,39)` | text-primary `#141413` |
| 特性卡底 | `rgb(249,250,251)` | bg-secondary `#faf9f5` |
| 版本徽章字 | `rgb(67,56,202)` | accent-text `#9b4928` |

【截图】`outputs/v43/shots/onboarding-claude-light.png` —— 一个陶土红产品里弹出一张紫蓝渐变按钮 + 彩虹描边卡，首屏第一眼就出戏。

**最小改法**：`onboarding.css` 全面改读主题令牌。
1. `.onboarding-btn-primary` 的 `background` 改 `var(--color-accent)`，`color` 改 `var(--color-accent-fg)`；
2. `.onboarding-card::before` 的 5 色渐变改 `var(--color-accent)` 单色（`borderGlow` 动画保留，只动 opacity）；
3. `.onboarding-dot.active` / `.completed` 改 `var(--color-accent)`；
4. `.onboarding-card-inner` 改 `var(--color-bg-elevated)`，删掉整段 `.dark .onboarding-card-inner`；
5. `.onboarding-title` / `.onboarding-feature-title` / `.onboarding-shortcut-desc` 改 `var(--color-text-primary)`；
6. `.onboarding-description` / `.onboarding-feature-desc` / `.onboarding-theme-name` 改 `var(--color-text-muted)`；
7. `.onboarding-feature-card` / `.onboarding-shortcut-item` / `.onboarding-theme-card` 改 `var(--color-bg-secondary)` + `var(--color-border-subtle)`；
8. `.onboarding-icon-wrapper` 渐变改 `var(--color-accent-wash)`；
9. `.onboarding-version-badge` 改 `var(--color-accent-text)` + `var(--color-accent-wash)`；
10. `.onboarding-kbd` 改 `var(--color-bg-elevated)` + `var(--color-border-default)`；
11. `.onboarding-overlay` 的 `rgba(0,0,0,.5)` 保留（遮罩本就该压暗）；
12. `.onboarding-spotlight-ring` 的 `rgba(102,126,234,…)` 改 `var(--color-accent)`。

> 附带效果：白字压 `#667eea` 只有 **3.66:1**（14px 粗体 ⇒ 未达 AA 4.5:1）。改用 `--color-accent` / `--color-accent-fg` 后各主题的对比契约已经现成（`--color-accent-fg` 就是为「白字压 accent 底」准备的），这条对比缺陷一并消失。

---

### V-2 · P0 · 弹窗与确认框的焦点环写死成品牌蓝：apple / chrome / claude 三套主题下**既不跟主题，深色模式还看不见**

**位置**：`src/components/common/ModalFrame.tsx:71`、`src/components/common/ConfirmDialog.tsx:39,50,61,66,93`、`src/components/common/AlertDialog.tsx:35,46,57,68,73`、`src/options/OptionsPage.tsx:161,669,718,737,905`、`src/components/sync/SyncButton.tsx:673`、`src/components/auth/AuthModal.tsx:84`、`src/components/common/Toast.tsx:240,249`

**证据**

【代码事实】这些位置用 Tailwind 的 `focus-visible:outline-primary-600` / `focus-visible:outline-primary-500` / `focus-visible:outline-slate-600` / `dark:focus-visible:outline-slate-300`（写死的 `#2563eb` / `#3b82f6` / `#475569` / `#cbd5e1`）。而主题系统里 `html[data-theme=x] :focus-visible` 的定义**只有 3 套主题有**：`legacy.css:468`、`creamy.css:402`、`prism.css:657`。**apple / chrome / claude 三套没有自己的 `:focus-visible` 块** ⇒ 这三套主题里，Tailwind 工具类（`utilities` 层）压过全局 `:focus-visible`，环色就是固定蓝。

【实测 · 计算值】（`outputs/v43/probe14.json`，真按 Tab 逐按钮读 `outlineColor`）：

| 主题 | 主题 `--color-focus-ring` | 弹窗里实测环色 | 跟主题？ |
|---|---|---|---|
| legacy 浅/深 | `rgb(29,78,216)` / `rgb(147,197,253)` | 同左 | ✔ |
| creamy 浅 | `rgb(180,83,9)` | 同左 | ✔ |
| creamy 深 | `rgb(245,158,11)` | 「全部删除」= `rgb(203,213,225)` | ✘ |
| prism 浅/深 | `rgb(90,111,214)` / `rgb(165,180,252)` | 浅✔ / 深「全部删除」`rgb(203,213,225)` | 部分✘ |
| **apple 浅/深** | `rgb(0,113,227)` / `rgb(122,184,245)` | `rgb(37,99,235)` / `rgb(203,213,225)` | ✘ ✘ |
| **chrome 浅/深** | `rgb(25,103,210)` / `rgb(138,180,248)` | `rgb(37,99,235)` / `rgb(203,213,225)` | ✘ ✘ |
| **claude 浅/深** | `rgb(180,85,47)` / `rgb(224,139,109)` | `rgb(37,99,235)` / `rgb(203,213,225)` | ✘ ✘ |

claude 的 accent 是陶土红 `#c2603f`，但弹窗焦点环是 `rgb(37,99,235)` —— **别家产品的蓝**。

【实测 · 像素级】光看 `outlineColor` 不够 —— 焦点环的可见性取决于它**与所在表面**的对比。用「真按 Tab 聚焦 → 截图 → canvas 读真实像素」量环带两侧（`outputs/v43/probe23.json`，阈值 3:1 / WCAG 1.4.11）：

| 主题/明暗 | 「取消」环 vs 内侧 | 「关闭弹窗」环 vs 面板 |
|---|---|---|
| legacy 浅/深 | 2.81 / 2.57 | 6.70 / 8.14 |
| creamy 浅/深 | 2.38 / 2.15 | 5.02 / 5.23 |
| prism 浅/深 | 2.15 / 2.78 | 4.08 / 8.82 |
| apple 浅 | 2.42 | 5.17 |
| **apple 深** | **1.69** | **2.70** ✘ |
| chrome 浅 | 2.42 | 5.17 |
| **chrome 深** | **1.72** | **2.78** ✘ |
| claude 浅 | 2.33 | 4.91 |
| **claude 深** | **1.80** | **2.96** ✘ |

**36 组实测里 15 组低于 3:1。**

**深色模式为什么这么糟**：写死的 `#2563eb` 压在三套主题的深色面板底上 —— apple `#2c2c2e` = **2.70:1**、chrome `#292a2d` = **2.78:1**、claude `#262523` = **2.96:1** —— **三套全部低于 3:1**。浅色模式下同一个蓝压白底是 5.17:1（够），所以问题**只在深色模式爆发**：用户切到深色，弹窗的焦点环淡到几乎贴着面板。

换成主题自己的 `--color-focus-ring` 后立刻恢复：apple 深 `#7ab8f5` = 6.64:1、chrome 深 `#8ab4f8` = 6.81:1、claude 深 `#e08b6d` = 5.89:1。

**「取消」那一列为什么全是 2.1~2.8**：它的底是 `theme-bg-tertiary`，环带紧贴按钮圆角边缘 ⇒ 内侧那一格是**环与按钮底色的抗锯齿过渡像素**，不是纯环色 ⇒ 数字被稀释。**这一列不算独立缺陷** —— 真正达标要看环与**面板**的比值（外侧列）。真正低于 3:1 的是**深色模式下 apple / chrome / claude 的「关闭弹窗」与「取消」**（2.70 / 2.78 / 2.96）—— 那里环和面板直接相邻，是硬失败。

**为什么 creamy/prism 深色也错**：`html[data-theme="creamy"] :focus-visible`（特异性 0-2-0）能压过 Tailwind 的 `.focus-visible\:outline-primary-600:focus-visible`（0-2-0，同特异性 ⇒ **后写的赢**）。但 `dark:focus-visible:outline-slate-300`（0-3-0，构建产物 `@121410`）**特异性更高**，所以深色下的「全部删除」按钮仍拿到 slate。

**最小改法**（两步，缺一不可）：

1. **删掉所有写死的焦点环工具类** —— 全局 `:focus-visible` 已经读 `--color-focus-ring`，工具类只是在覆盖它。涉及上列全部位置。
2. **给 apple / chrome / claude 三套主题补上自己的 `:focus-visible` 块**（否则删掉工具类后，这三套仍读全局的 `:focus-visible`，而全局那条在 `@layer base` 里，会被 Tailwind utilities 层压过 —— 必须让主题文件自己声明一条**未分层**的规则）：

```css
/* apple.css / chrome.css / claude.css 各补一份 */
html[data-theme="apple"] :focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}
```

只做第 1 步不够（会退回全局规则）；只做第 2 步也不够（工具类特异性更高，仍会赢）。**两步都要做。**


---

### V-3 · P1 · ⋯ 菜单的**内容**完全不跟主题：面板跟主题，里头的东西全是写死的灰阶与品牌蓝

**位置**：`src/components/layout/HeaderDropdown.tsx:798`（分隔线）、`:800`（标题）、`:814`（刷新图标）、`:859`/`:871`（去登录 / 去设置）、菜单项行（`text-gray-700 dark:text-gray-300`）、15 处 `text-gray-500` 图标

**证据**

【代码事实】面板本身用了 `theme-bg-elevated theme-radius-card theme-shadow-panel border theme-border-default`（跟主题 ✔），但**内部每一行都是写死的 Tailwind 灰阶**：
- `:798` `<div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">` — 分隔线
- `:800` `<p className="text-sm font-medium text-gray-900 dark:text-gray-100">` — 标题
- 菜单项行 `w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300`
- 15 处图标 `className="h-4 w-4 mr-2 text-gray-500"`
- `:814` 刷新图标 `text-primary-600 dark:text-primary-400`
- `:859`/`:871` 去登录 / 去设置 `text-primary-600 underline hover:text-primary-700`

【实测】claude 浅色主题下打开菜单（`outputs/v43/probe17.json`）：

| 文本 | 实测色 | 应为 |
|---|---|---|
| 「未登录」 | `rgb(17,24,39)` | claude text-primary `#141413` |
| 「切换为双栏布局」「清理重复标签」「设置…」「导出数据」「导入数据」「问题反馈」「使用引导」 | `rgb(55,65,81)`（gray-700） | claude text-secondary |
| 「去登录」 | `rgb(37,99,235)`（固定品牌蓝） | claude accent `#c2603f` |
| 「删除所有会话（1）」 | `rgb(190,18,60)` | danger 令牌 |

「去登录」在 claude 下是**固定蓝**，而 claude 的品牌色是陶土红 —— 这是「别家产品的蓝」第二次出现在用户最常点的入口上。

**为什么守卫没抓到**：`tests/guards/hardcodedGrayTextScanned.test.ts` 只扫 `text-gray-400` / `text-gray-500`；`text-gray-600/700/900` 与 `text-primary-600` 是**故意不拦**的（守卫头部注释说明它们对比度 ≥7.1:1）。那条守卫守的是「对比度」，不是「跟不跟主题」—— 这正是本条的缺口。

**最小改法**：把菜单内所有写死灰阶换成主题令牌（仓里已有现成工具类）：
- `text-gray-700 dark:text-gray-300` → `theme-text-primary`
- `text-gray-900 dark:text-gray-100` → `theme-text-primary`
- `text-gray-500`（图标） → `theme-text-muted`
- `border-gray-200 dark:border-gray-700` → `theme-border-default`
- `text-primary-600 dark:text-primary-400` → `theme-accent-text`
- 「去登录」/「去设置」的 `text-primary-600` → `theme-accent-text`

---

### V-4 · P1 · 「显示筛选」按钮只有 20px 高 —— 低于 WCAG 24px，低于本仓自订的 36px；320px 下还折成两行，图标被挤到行间

**位置**：`src/components/search/SearchFilterPanel.tsx:605-609`

**证据**

【代码事实】按钮类名只有 `text-sm theme-accent-text font-medium hover:underline flex items-center flat-interaction` —— **没有 `min-h-9`**，也没有任何内边距。

【实测】逐宽度（`outputs/v43/probe16.json`）：

| 视口 | 按钮尺寸 |
|---|---|
| 320px | **67.1 × 40**（两行） |
| 360 / 390 / 768 / 1280 / 1920px | **68.3 × 20** |

- 高度 20px < WCAG 2.2 SC 2.5.8 的 24px AA，< 本仓 `MIN_HIT_TARGET_PX = 36`；
- 320px 下按钮 40px 高 ⇒ **文字折成两行**，`<svg>` 图标孤零零落在两行文字中间（`probe11` 记录：svg top=159，文字行 top=148 / 168）；
- 全站逐元素扫描（可见 + 在视口内 + 可交互），**所有宽度下它是唯一一个 <24px 的元素**（除品牌按钮，见 V-5）。

【截图】`outputs/v43/shots/state-filter-real.png`

**最小改法**：`SearchFilterPanel.tsx:605-609` 的类名加 `min-h-9 min-w-9 px-2 shrink-0 whitespace-nowrap`。`whitespace-nowrap` 一并解掉 320px 折行。

---

### V-5 · P1 · 320px 下品牌按钮塌成 **2.7×20px**，logo 只有 2.7px 可见，右侧 40% 不可点

**位置**：`src/styles/global.css:1584-1625`（窄屏栅格）、`:1647-1651`（420px 隐藏品牌名）

**证据**

【代码事实】`@media (max-width: 640px)` 里 `.app-header-grid { grid-template-columns: auto auto; grid-template-areas: 'brand actions' 'search search'; }`，`.app-header-brand { min-width: 0; overflow: hidden; }`。品牌名在 `@media (max-width: 420px)` 被 `display:none` 隐藏。**但没有任何一条规则保证品牌按钮本身保留可用的盒子** —— 品牌名一隐藏，按钮宽度就塌成 logo 自身的宽度，再被 `overflow:hidden` + `min-width:0` 一起夹住。

【实测】逐宽度（`outputs/v43/probe16.json` + `probe19.json`）：

| 视口 | 品牌盒 | logo 实际可见宽 | logo 右侧 80% 处命中 | 品牌盒外一像素命中 |
|---|---|---|---|---|
| **320px** | **2.7 × 20** | **2.7px** | ❌ 命中 `.btn-icon` | `.app-header-grid` |
| 340px | 22.7 × 20 | 20px | ✔ 命中 brand | `.app-header-grid` |
| 360px | 35.3 × 20 | 20px | ✔ 命中 brand | ✔ 命中 brand |
| 400px | 55.3 × 20 | 20px | ✔ | ✔ |

320px 时：品牌按钮只有 2.7px 宽（可点面积 54px²），logo 的**右侧 40% 根本点不到**（命中的是旁边的按钮）。且按钮高 20px，仍 < 24px。

【截图】`outputs/v43/shots/v43-brand-320.png` —— 顶栏只剩一个太阳图标，左边本该有品牌标识的地方是空的。

**注**：`src/components/layout/brandLayout.ts` 的 `isBrandContentClipped()` 只负责**隐藏品牌名**（避免半个字），不保证品牌**按钮**的盒子 —— 缺口在这两件事之间。

**最小改法**：`global.css` 的 `.app-header-brand` 补一条最小宽度，并把品牌名隐藏时的按钮变成正方形图标按钮。

```css
@media (max-width: 640px) {
  .app-header-brand {
    grid-area: brand;
    min-width: 36px;      /* ← 新增：至少一个 36px 命中区 */
    overflow: hidden;
  }
}
@media (max-width: 420px) {
  .app-header-brand .app-header-brand-name { display: none; }
  .app-header-brand { min-width: 36px; justify-content: center; }  /* ← 新增 */
}
```

---

### V-6 · P1 · 菜单里的两个内联按钮（「去登录」「去设置」）命中区只有 **36.4 × 16px**

**位置**：`src/components/layout/HeaderDropdown.tsx:859`、`:871`

**证据**

【代码事实】两处都是 `className="shrink-0 text-xs font-medium text-primary-600 underline ..."` —— 没有 `min-h-9`。

【实测】`outputs/v43/probe17.json`（菜单内所有可交互项逐个量）：

| 项 | 尺寸 | 判定 |
|---|---|---|
| 「去登录」 | **36.4 × 16** | ✘ 高 < 24 < 36 |
| 「从云端刷新数据」 | 28 × 28 | ✘ 低于本仓 36px |
| 其余 8 个菜单项 | 254 × 36 | ✔ |

**最小改法**：`:859` / `:871` 的类名加 `min-h-9 px-2 inline-flex items-center`；`:814` 那颗刷新按钮的 `p-1.5` 改成 `p-2`（28 → 32）并补 `min-h-9 min-w-9`，或直接换成仓里现成的 `.btn-icon`（36px）。

---

### V-7 · P2 · Toast 整块写死：claude 暖纸主题里弹出一张冷白 / 石板灰 / 翠绿卡片

**位置**：`src/components/common/Toast.tsx:110-137`

**证据**

【代码事实】四种类型的 `shell` / `accent` / `iconWrap` 全是写死的 Tailwind 调色板（emerald / rose / sky / amber + `bg-white/95 text-slate-800` / `dark:bg-slate-900/95 dark:text-slate-100`），**没有一处读主题令牌**。

【实测】真机触发「锁定会话」成功提示，逐主题（`outputs/v43/probe12.json`）：

| 主题 | 壳底 | 主题 bg-secondary | 壳字 | 主题 text-primary | 图标徽章对比 |
|---|---|---|---|---|---|
| claude 浅 | `rgba(255,255,255,0.95)` | `#faf9f5` | `rgb(30,41,59)` | `#141413` | **3.32:1** |
| creamy 浅 | `rgba(255,255,255,0.95)` | `#ffffff` | `rgb(30,41,59)` | `#44403c` | 3.32:1 |
| legacy 浅 | `rgba(255,255,255,0.95)` | `#ffffff` | `rgb(30,41,59)` | `#111827` | 3.32:1 |
| apple 浅 | `rgba(255,255,255,0.95)` | `#ffffff` | `rgb(30,41,59)` | `#1d1d1f` | 3.32:1 |
| 任一主题 深 | `rgba(15,23,42,0.95)` | 暖黑（如 claude `#262523`） | `rgb(241,245,249)` | `#f0eee6` | 9.26:1 |

成功图标徽章恒为 `rgb(209,250,229)` 底 / `rgb(5,150,105)` 字 = **3.32:1**（过了 3:1 非文本线，但不是主题色 —— 翠绿出现在陶土红产品里）。顶部进度条恒为 `rgb(16,185,129)`。

【截图】`outputs/v43/shots/toast-real-claude.png`

**最小改法**：`Toast.tsx:110-137` 的 `shell` 里 `bg-white/95 text-slate-800` → `theme-bg-elevated` + `theme-text-primary`；`dark:bg-slate-900/95 dark:text-slate-100` 整段删掉（主题令牌自动翻面）。类型色保留 emerald/rose/sky/amber 作为**语义色**是可以的（成功=绿、危险=红是通用约定），但**壳体与文字必须跟主题**；`accent`（顶部条）建议改 `var(--color-success)` / `--color-danger` 一类令牌。

---

### V-8 · P2 · 空态的图标带 `role="img" aria-label={title}`，与旁边的 `<h3>` **逐字重复** ⇒ 读屏播报两遍

**位置**：`src/components/common/EmptyState.tsx:59-67`

**证据**

【代码事实】图标容器 `role="img" aria-label={title}`；紧邻的 `<h3>{title}</h3>` 渲染同一个字符串。

【实测】`outputs/v43/probe17.json`：`imgLabel = "早上好，先保存一个工作会话"`，`h3Text = "早上好，先保存一个工作会话"`，`same: true`。图标本身 `accessibleText = ""`（SVG 无可访问名），所以**唯一的名字来源就是这个 aria-label**，而它和 h3 逐字相同。

读屏会播报：「[图片] 早上好，先保存一个工作会话」→ 紧接着「早上好，先保存一个工作会话，标题 3 级」。

**最小改法**：给图标容器加 `aria-hidden="true"`，删掉 `role` 与 `aria-label` —— 文字已经在 `<h3>` 里，图标是纯装饰。

```tsx
<div className="..." aria-hidden="true">
  {icon || <DefaultIcon />}
</div>
```

---

### V-9 · P2 · 主题切换动画的名单里，**空态、菜单、弹窗三个真实存在的表面都不在其中** ⇒ 它们切主题时是「硬切」

**位置**：`src/styles/global.css:286-322`（过渡名单）、`:382-431`（reduced-motion 同名单）

**证据**

【代码事实】名单包含 `.empty-state` / `.empty-state-icon` / `.empty-state-title` / `.empty-state-description` / `.dropdown-menu` / `.dropdown-item` / `.popup-menu` / `.modal-content` / `.tooltip` / `.card-glass` / `.badge` / `.badge-accent` / `.search-result-item` / `.search-result-link` / `.search-bar-input` / `.btn-ghost` / `.ts-panel`（`ts-panel` **在 CSS 里根本没有规则**）。

逐个核「CSS 有规则 / TSX 有引用」：

| 类 | CSS 规则数 | TSX 引用数 | 判定 |
|---|---|---|---|
| `.dropdown-menu` | 5 | **0** | 死类 |
| `.popup-menu` | 5 | **0** | 死类 |
| `.modal-content` | 5 | **0** | 死类 |
| `.dropdown-item` | 8 | **0** | 死类 |
| `.empty-state-icon` | 6 | **0** | 死类 |
| `.empty-state-title` | 3 | **0** | 死类 |
| `.empty-state-description` | 3 | **0** | 死类 |
| `.card-glass` | 4 | **0** | 死类 |
| `.badge-accent` | 5 | **0** | 死类 |
| `.search-result-item` | 6 | **0** | 死类 |
| `.search-result-link` | 8 | **0** | 死类 |
| `.search-bar-input` | 12 | **0** | 死类 |
| `.btn-ghost` | 4 | **0** | 死类 |
| `.empty-state` | 19 | 2（都是 `.empty-state-default-icon`） | 死类 |
| `.tooltip` | 8 | 35 | **活的，但组件没用这个类名** |
| `.ts-panel` | **0** | 3 | **反向死类：用了但没规则** |

**实测**（`outputs/v43/probe13.json` / `probe17.json`）：

```
菜单面板 .ts-panel       过渡时长 = 0s     ← 名单里没有它
菜单项   [role=menuitem] 过渡时长 = 0.15s
会话卡   .tab-group-card 过渡时长 = 0.2s
弹窗面板 [role="dialog"]  过渡时长 = 0s     ← 名单里是 .modal-content（不存在）
```

⇒ **空态、菜单、每一个弹窗在切主题时是硬切**，而会话卡是 0.2s 淡入。同一次操作里，列表在渐变、菜单在闪 —— 这是「不像成品」的观感来源。

**最小改法**（两条，缺一不可）：
1. 把 `ModalFrame.tsx:71` 的面板加上 `modal-content` 类（CSS 规则已存在且写好了对 `theme-*` 变量的过渡），`HeaderDropdown.tsx:786` 加上 `popup-menu` 类；
2. `Tooltip.tsx` 的提示条 class 加上 `tooltip`（但要先解决下一条：`.tooltip` 与组件自带的 Tailwind 类**打架**，见 V-10）；
3. 清掉真正没用的 12 个死类，避免下次再有人往这份名单里加名字。

---

### V-10 · P2 · `.tooltip` 这条 CSS 规则与 `<Tooltip>` 组件**完全脱节** —— 组件根本没用这个类名，规则里那套淡入/缩放也没生效

**位置**：`src/components/common/Tooltip.tsx:150-158`（组件的 className）、`src/styles/global.css:1179-1189`（`.tooltip` 规则）、`src/styles/micro-interactions.css:241-252`（`.tooltip` / `.tooltip.show`）

**证据**

【代码事实】`Tooltip.tsx` 渲染的提示条 class 是：
`absolute z-50 max-w-[min(20rem,calc(100vw-1.5rem))] whitespace-normal break-words px-3 py-2 text-sm text-white bg-gray-900 dark:bg-gray-800 rounded-lg shadow-xl backdrop-blur-sm border border-gray-700 dark:border-gray-600 pointer-events-none animate-fadeIn`

—— **没有 `tooltip` 这个类名**。而 `global.css:1179` 的 `.tooltip` 规则写的是完全另一套（`@apply absolute z-50 px-2 py-1 rounded-md; @apply text-xs font-medium whitespace-nowrap; background: var(--color-bg-elevated); color: var(--color-text-primary);`）。`micro-interactions.css:241` 的 `.tooltip { opacity: 0; transform: scale(0.95); }` + `.tooltip.show { opacity: 1; ... }` 也永远不生效。

**实测**（`outputs/v43/probe14.json`）：6 套主题 × 明暗共 12 组，提示条实测底色恒为 `rgb(17,24,39)` / `rgb(31,41,55)`，**没有任何一组跟主题走**（claude 浅的 bg-elevated 是 `#faf9f5`、text-primary 是 `#141413`）。`hasTooltipClass = false`（12/12）。

**连带问题**：提示条永远写死冷灰底 + 白字 ⇒ 在 claude 暖纸主题里同样出戏（V-3 / V-7 是同一类问题在别处的表现）。另外 `.tooltip` 规则里的 `whitespace-nowrap` 与组件实际的 `whitespace-normal break-words` 相反 —— 说明这两处早就不是同一个东西了。

**最小改法**：二选一，但**必须二选一**（不能让两套规则继续并存）：
- **A（推荐）**：组件的 className 里加 `tooltip`，并把组件自带的 `bg-gray-900 dark:bg-gray-800 text-white border-gray-700 dark:border-gray-600` 删掉，交给 `.tooltip` 规则用 `var(--color-bg-elevated)` / `var(--color-text-primary)` / `var(--color-border-default)`；同时把 `micro-interactions.css` 的 `.tooltip` / `.tooltip.show` 两块删掉（组件是条件挂载，不需要显隐两态）。
- **B**：删掉 `global.css:1179` 与 `micro-interactions.css:241-252` 的 `.tooltip` 规则，组件保留自己的 Tailwind 类，但把写死的灰换成 `theme-bg-elevated` / `theme-text-primary` / `theme-border-default`。

---

### V-11 · P2 · 设置页「当前主题」的选择环用 45% 透明度 ⇒ claude 下对卡底只有 **1.87:1**，几乎看不见

**位置**：`src/styles/global.css:1470`（`.theme-accent-ring`）、`src/components/layout/ThemeStyleSelector.tsx:220,384`

**证据**

【代码事实】`.theme-accent-ring { --tw-ring-color: var(--color-accent-border); }`，而 `--color-accent-border` 在 6 套主题里都是 **40%~45% 透明度**的 accent（如 claude 浅 `rgba(217,119,87,0.45)`）。

【实测】（`outputs/v43/probe18.json`）环色对卡片自身底色的对比：

| 主题 | 环 | 卡底 | 对比 | WCAG 非文本 3:1 |
|---|---|---|---|---|
| legacy 浅 | `rgba(37,99,235,.45)` | `rgb(255,255,255)` | 2.63 | ✘ |
| legacy 深 | `rgba(96,165,250,.45)` | `rgb(31,41,55)` | 2.51 | ✘ |
| **claude 浅** | `rgba(217,119,87,.45)` | `rgb(250,249,245)` | **1.87** | ✘ |
| claude 深 | `rgba(224,139,109,.45)` | `rgb(38,37,35)` | 2.57 | ✘ |
| prism 浅 | `rgba(102,126,234,.45)` | `rgba(255,255,255,.92)` | 2.16 | ✘ |
| prism 深 | `rgba(167,139,250,.45)` | `rgba(30,20,55,.95)` | 2.74 | ✘ |
| apple 浅 | `rgba(0,113,227,.4)` | `rgb(255,255,255)` | 2.63 | ✘ |
| apple 深 | `rgba(10,132,255,.45)` | `rgb(44,44,46)` | 2.14 | ✘ |

**8/8 全部低于 3:1**。用户看设置页时**看不出当前选的是哪个主题**。

> 注：`global.css:1472` 的注释恰好记录了这个坑（「不用 `--color-accent-border`：那是 45% 透明度的淡描边，压在浅底上只有 1.6:1 —— 选中指示线看不见」），并为此造了 `.theme-accent-ink-border`（读 `--color-accent-text`）。**`.theme-accent-ring` 漏在了这次修复之外** —— 同一个文件里的同一个坑，一处修了另一处没修。

**最小改法**：`global.css:1470` 改成读不透明的主题墨色。

```css
.theme-accent-ring { --tw-ring-color: var(--color-accent-text); }
```

（`--color-accent-text` 就是各主题为「当墨色用的 accent」准备的，`global.css:1472` 的注释已证明它在 6 套主题的弹层底上都 ≥3:1。）

---

### V-12 · P2 · 引导页的 emoji 是**系统彩色字形**，不跟主题、不跟深浅色，还会被读屏逐字念出来

**位置**：`src/components/onboarding/OnboardingSteps.tsx:16,29,34,39,50,79,84,89,105,115,120,125,136,151,156,161,172,202,210,215,236`（21 个渲染点 / 18 种）

**证据**

【代码事实】引导页用 `🧭 💾 🔍 🚀 🪟 📌 🔒 🗂 ⏱ 🌐 🪄 📍 🕘 ☁ 🔄 📤 🛟 ✅` 共 **21 个渲染点 / 18 种** emoji 当插画，**没有任何一个带 `aria-hidden`**。

【实测】`outputs/v43/probe15.json`：6 套主题 × 明暗共 12 组，`aria-hidden` 全部为 `null`；emoji 用的是系统字体（`-apple-system, "system-ui", …`），**不随主题的字体栈走**（prism 用 Inter、chrome 用 Google Sans，emoji 仍是系统字形）。

读屏行为：`<span>🧭</span>` 是一个有内容的文本节点 ⇒ 会被播报为「指南针」/「compass emoji」；18 个 emoji 逐个念。

【截图】`outputs/v43/shots/onboarding-claude-light.png` —— 三张特性卡里的 emoji 是 macOS 的彩色 Apple 彩色字形，与卡片里其它任何视觉元素都不是一套语言。

**最小改法**（两件事，缺一不可）：
1. 给每个 emoji 容器加 `aria-hidden="true"`：`<div className="onboarding-feature-icon" aria-hidden="true">💾</div>`；`.onboarding-icon-wrapper > span` 同样处理；
2. emoji 作为插画本身是**这个产品的廉价感来源之一**（系统彩色字形 + 卡通风格 + 产品其余部分是克制的线性图标）。建议把 5 步的主图标换成仓里已有的 SVG 图标（`src/components/common/TapStackIcon.tsx`、`ChevronIcon.tsx` 等），特性卡图标换成与正文同风格的线性图标；emoji 至少要**统一尺寸与基线**（`.onboarding-feature-icon { font-size: 1.5rem }` 现在各平台渲染出的视觉大小差异很大）。

---

### V-13 · P2 · apple 深色主题：整页底色是**纯黑 `#000000`**，卡片是 `rgb(28,28,30)`，只有一条 8% 白描边 ⇒ 硬边

**位置**：`src/styles/themes/apple.css:107`（`--color-bg-primary: #000000`）、`:157`（`--color-shell: #000000`）、`:143-146`（`--color-bg-secondary: #1c1c1e`）

**证据**

【代码事实】apple 深色把 `--color-bg-primary` 与 `--color-shell` 都设成 `#000000`；卡片底 `#1c1c1e`（`rgb(28,28,30)`），边框 `--color-border-translucent: rgba(255,255,255,0.1)`。

【实测】`outputs/v43/probe19.json`：apple 深色 `body` 背景 = `rgb(0,0,0)`，而 chrome 深是 `rgb(32,33,36)`、claude 深是 `rgb(25,24,23)`、legacy 深是 `rgb(17,24,39)` —— **只有 apple 是绝对 0**。

**为什么是问题**：纯黑不是「深色」，是**没有底色**。卡片底是 `--color-bg-secondary: #1c1c1e`，边框是 `--color-border-subtle: rgba(255,255,255,0.08)`。算下来：

| 对比 | 值 |
|---|---|
| 卡片底 `#1c1c1e` vs 页面纯黑 `#000000` | **1.23:1** |
| 8% 白描边（合成后 `rgb(46,46,48)`）vs 页面纯黑 | **1.55:1** |
| 8% 白描边 vs 卡片底 | **1.26:1** |

⇒ 卡片与页面之间**几乎没有任何明度差**（1.23:1），分隔全靠那条 1.26:1 的描边 —— 在 OLED 屏上整块内容像浮在虚空里。而且 `#000000` 与相邻主题（chrome `#202124`）之间切换时是**从有底色跳到无底色**，不是从一种深灰跳到另一种深灰。

**最小改法**：apple 深色的 `--color-bg-primary` 从 `#000000` 改成 `#1c1c1e` 一档（或 `#141416`），`--color-shell` 同步。这样页面底与卡片底拉开一档，卡片靠明度差浮起来，不再靠一条描边撑着。

---

### V-14 · P2 · 同类交互的动效时长没有统一节奏：60 / 80 / 100 / 120 / 150 / 200 / 300 / 400ms 混用

**位置**：`src/styles/micro-interactions.css:22,68,103,135,169,187,222,234,244,345`、`src/styles/global.css:443,767,1218`、`src/styles/drag-drop.css:345`、`src/styles/onboarding.css:146,241,267,302,338,392`

**证据**

【代码事实】`transition: all` 在三份文件里出现 17 次，时长各不相同：

| 时长 | 出现在 |
|---|---|
| 60ms | `micro-interactions.css:68,187`（`.btn-icon` 等） |
| 80ms | `micro-interactions.css:22,135,234,345` |
| 100ms | `micro-interactions.css:169,222,244` |
| 120ms | `micro-interactions.css:103` |
| 150ms | `micro-interactions.css` / `global.css`（`.tab-group-card` 的 `transition: all 0.2s` 除外） |
| 200ms | `global.css:443,767,1218`、`drag-drop.css:345`、`onboarding.css:241,267,302,338,392` |
| 250ms | `global.css:212`（`--theme-transition-duration`，主题切换） |
| 300ms | `onboarding.css:146` |

【实测】同一屏上三处不同节奏（`outputs/v43/probe18.json`）：

```
菜单面板 .ts-panel       0s
菜单项   [role=menuitem] 0.15s
会话卡   .tab-group-card 0.2s
卡头     .tab-group-header 0.25s
顶栏     .header          0.25s
图标按钮 .btn-icon        0.15s
标签行   .tab-item        0.15s（只过渡 transform/opacity，不过渡颜色）
```

**具体症状**：`.btn-icon` 是 60ms（`micro-interactions.css:68`），`.btn` 是 150ms，`.btn-primary` 是 80ms —— **同一次点击里三个按钮反馈速度不同**；`.tab-item` 的过渡只含 `transform, opacity`，**背景色/文字色不参与过渡** ⇒ 标签行换主题时是硬切，而它旁边的卡头是 0.25s 渐变。

**最小改法**：定义一组命名时长并统一（建议 `--motion-fast: 120ms` / `--motion-base: 180ms` / `--motion-slow: 250ms` / `--ease-standard: cubic-bezier(0.4,0,0.2,1)`），把上表 17 处改成这 4 个档；`.tab-item` 的过渡补上 `background-color, border-color, color`。

---

### V-15 · P2 · `<Tooltip>` 渲染的 `role="tooltip"` **没有 id，也没有任何元素用 `aria-describedby` 指向它** ⇒ 读屏用户拿不到这段说明

**位置**：`src/components/common/Tooltip.tsx:150-158`（提示条渲染）、`:32-41`（`showTooltip` / `hideTooltip`）

**证据**

【代码事实】提示条有 `role="tooltip"` 但**没有 `id`**；`Tooltip.tsx` 里没有任何一处生成 `aria-describedby`，也不给子元素打 id。

【实测】（`outputs/v43/probe18.json`）逐个触发器：

| 触发器 | `aria-describedby` | tooltip 有 id 吗 | 有元素指向它吗 |
|---|---|---|---|
| 「锁定会话」 | `null` | 否（空串） | **false** |
| 「重命名会话」 | `null` | 否 | **false** |
| 「菜单」 | `null` | 否 | **false** |

【影响】tooltip 里承载的是**关键状态语义**，不只是装饰：
- 锁定按钮的提示是「会话未锁定 · 点此锁定（锁定后不会被「清理重复标签」清理，也不能重命名或逐条删除）」—— 这是第 42 轮 U-11 定案「tooltip 必须同时说明当前状态和点了会发生什么」的那一半；
- 但读屏用户**读不到** —— `role="tooltip"` 没有被引用时，多数读屏不会播报它。

**最小改法**：给提示条生成稳定 id 并挂到触发元素上。

```tsx
// Tooltip.tsx：用 useId() 生成 id，渲染时挂 aria-describedby
const tipId = useId();
// 包裹层：cloneElement 到 children，或用 <div aria-describedby={tipId}> 包裹
<div className={...} id={tipId} role="tooltip">{content}</div>
```

注意 `Tooltip` 的 children 可能是 `<button>`（有 `aria-label`）也可能是 `<h3 role="button">`（已有 `aria-describedby` 指另一个 hint）—— 合并时要把两个 id 用空格拼在一起，不要覆盖。

---

### V-16 · P3 · `.ts-panel` 是个**反向死类**：组件用了它，但 CSS 里没有任何规则

**位置**：`src/components/layout/HeaderDropdown.tsx:786`、`:1010`、`:1074`

**证据**

【代码事实】`grep -rn "\.ts-panel" src/styles/` = **0 命中**；`grep -rn "ts-panel" src/ --include="*.tsx"` = **3 命中**（菜单主面板 + 两个子菜单面板）。

三处面板的位置/圆角/阴影/边框全靠旁边的 `theme-*` 工具类撑着，`ts-panel` 这个名字本身什么也没做。

**实测】面板过渡时长 = `0s`（V-9 已列）：因为 `.ts-panel` 既不在主题过渡名单里，也没有任何自己的 transition 声明 ⇒ 主题切换时菜单面板硬切。

**最小改法**：要么给 `.ts-panel` 补一条真正的规则（`@apply theme-bg-elevated theme-radius-card theme-shadow-panel border theme-border-default;` + 进 `global.css:286-322` 的过渡名单），要么删掉这个类名。前者更合理 —— 三处面板的样式现在重复了三遍。

---

### V-17 · P3 · 锁徽章的对比度在 creamy / prism 两套主题下**测不出来** —— 测量链断在透明卡头上，不是缺陷但也没被验证过

**位置**：`src/styles/global.css:779-786`（`.tab-group-header` 读 `--color-card-head-bg`）、`src/components/tabs/TabGroup.tsx:1101-1109`

**证据**

【实测】（`outputs/v43/probe10.json`）12 组里 8 组有值：

| 主题/明暗 | 徽章墨 | 徽章底 | 对比 |
|---|---|---|---|
| legacy 浅/深 | `rgb(29,78,216)` / `rgb(147,197,253)` | accent-wash 10%/14% | 5.60 / 6.38 |
| apple 浅/深 | `rgb(0,99,200)` / `rgb(122,184,245)` | 10% / 14% | 5.06 / 6.90 |
| chrome 浅/深 | `rgb(23,93,189)` / `rgb(138,180,248)` | 10% / 14% | 5.52 / 5.16 |
| claude 浅/深 | `rgb(155,73,40)` / `rgb(240,164,136)` | 12% / 14% | 4.92 / 5.74 |
| **creamy 浅/深** | `rgb(173,80,9)` / `rgb(251,191,36)` | 12% / 14% | **null** |
| **prism 浅/深** | `rgb(72,87,174)` / `rgb(165,180,252)` | 12% / 16% | **null** |

**为什么 null**：creamy / prism 的卡头底是**透明**的 ⇒ 合成链要一直往上走到页面底，中间经过 `--color-card-head-bg`（transparent）就断了。**这是测量缺口，不是确认的缺陷** —— 但也意味着这两套主题下的锁徽章**从未被验证过**。

**最小改法**：在 `scripts/contrast-audit.mjs` 的模型里补上「卡头透明 ⇒ 直接落到卡底」的分支，把 creamy / prism 的锁徽章纳入自动检查；本条暂列 P3，不单独修代码。

---

## 2. 状态覆盖矩阵

6 套主题 × 亮/暗 × 关键界面态的实测覆盖。「✔」= 本轮真机截过图并量过值；「△」= 本轮覆盖但只量了值没单独截图；「—」= 本轮未覆盖（已列入第 44 轮待办）。

| 界面态 | legacy 浅 | legacy 深 | creamy 浅 | creamy 深 | prism 浅 | prism 深 | apple 浅 | apple 深 | chrome 浅 | chrome 深 | claude 浅 | claude 深 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 会话列表（≥1 组） | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 空态（无会话） | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 引导页（首屏） | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 筛选面板展开 | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| ⋯ 菜单展开 | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 确认框（普通） | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 危险确认框 | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Toast（成功） | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Toast（错误/警告/信息） | — | — | — | — | — | — | — | — | — | — | ✔ | ✔ |
| 设置页 | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 锁定会话 | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 未登录态（菜单） | ✔ | — | ✔ | — | ✔ | — | ✔ | — | ✔ | — | ✔ | — |
| 同步中（菜单刷新按钮） | — | — | — | — | — | — | — | — | — | — | — | — |
| 同步失败 | — | — | — | — | — | — | — | — | — | — | — | — |
| 搜索结果（有关键词） | ✔ | — | ✔ | — | ✔ | — | ✔ | — | ✔ | — | ✔ | — |
| 窄屏 320px 品牌塌缩 | ✔ | — | — | — | — | — | — | — | — | — | — | — |
| 焦点环（弹窗 4 按钮 · 计算值） | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 焦点环（弹窗 3 按钮 · **像素级**） | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 焦点环（引导页 5 元素） | ✔ | — | ✔ | — | ✔ | — | ✔ | — | ✔ | — | ✔ | — |

**矩阵之外的专项覆盖**

| 专项 | 覆盖 |
|---|---|
| 视口宽度 | 320 / 340 / 360 / 390 / 400 / 768 / 1280 / 1920（8 档，逐档量几何） |
| 横向溢出 | 320/360/390/768/1280/1920 **全部 `scrollW === clientW`，无溢出** |
| `prefers-reduced-motion: reduce` | 全量：过渡全部压到 `0.001ms`、动画迭代数 = 1、`getAnimations()` 里 **0 个 running / 0 个 infinite** |
| 焦点 Tab 序 | 320/400/768/1280 四档，无 `display:none` 残留、无 0 尺寸元素 |
| 主题切换过渡 | 12 个表面逐个量过渡属性与时长 |

---

## 3. 撤回的判断

复核后**不成立**、已从清单里撤掉的：

| 原判 | 复核结论 |
|---|---|
| 「焦点环宽度只有 1.5px，被 `overflow:hidden` 裁掉」 | **不成立** —— 1.5px 是 `.btn-icon { transition: all 60ms }` 在**过渡中途**采样到的 `outline-width`。每次 Tab 后等 600ms 再读，12 套主题全部是 `2px solid` + `offset 2px`。**这正是第 42 轮踩过的同一个坑**，采样时机不落定就会造假红 |
| 「焦点环在所有主题下都看不见（像素级 36/36 全军覆没）」 | **不成立** —— 探针用 `element.focus()` **程序化聚焦**，而 Chrome 的 `:focus-visible` 启发式**不认**程序化聚焦（上次交互是鼠标点击）⇒ `outline-style` 保持 `none` ⇒ 截到的是**没有环**的图。改成**真按 Tab** 后，36 组里 21 组达标、15 组不达标（见 V-2）。**这条假红的教训**：焦点环的任何像素级判据都必须先确认 `outline-style !== 'none'` |
| 「焦点环宽度是 1.5px（探针二）⇒ 环比规范细」 | **不成立** —— 同上，`b.focus()` 触发的不是 `:focus-visible`，量到的是默认 outline 的 1.5px。真按 Tab 后是 2px |
| 「读屏会播报引导页的 emoji」 | **降级并部分撤回** —— `aria-hidden` 确实全缺（18 种 emoji / 21 个渲染点），但 emoji 在读屏里通常被当作**文字**播报（"compass"、"magnifying glass"），不是图片名。缺陷是「本该是装饰的图标进了朗读队列」，比「播报图片名」轻。改法不变：加 `aria-hidden="true"` |
| 「弹窗里出现两个重复的 `summary`，Tab 序里也出现两次」 | **不成立** —— 那是探针注入的 fixture 集与后续探针不同造成的假象。真实 2 组 fixture 下每张卡恰好一个 `summary` |
| 「锁定徽章对比度不达标」 | **不成立** —— 能测的 8 组全部 4.92~6.90:1，远超阈值。creamy / prism 的 `null` 是测量链断在透明卡头上（见 V-17），**测不出 ≠ 不达标** |
| 「主题对比度有硬失败」 | **不成立** —— `scripts/contrast-audit.mjs` 本轮复跑，12 组 **0 不达标**（最差 prism/light 3.00:1、creamy/light 3.02:1，均在阈值 3 以上） |
| 「保存按钮的 `aria-label` 与可见文本不一致」 | **不成立** —— 长 aria-label + 短可见标签的同型问题，与第 42 轮撤回的第 3 条同源，不是本轮问题 |
| 「引导页第 4 步聚光灯消失」 | **不在本轮范围** —— 第 42 轮 P0-1 已修（`spotlightSelectorChain.ts` + 守卫），本轮不重复 |
| 「菜单项图标 `text-gray-500` 对比度不足」 | **不成立** —— `gray-500` 的对比度本身达标；问题在**它不跟主题**（V-3），不在对比度。守卫 `hardcodedGrayTextScanned` 放行 600/700/900 是有意的（对比度 ≥7.1:1），本轮的缺口是「跟不跟主题」这个维度没有守卫 |
| 「顶栏动作元素挤爆宽度」 | **不成立** —— 第 42 轮 U-20 已修（顶栏 6 → 4），本轮实测 320~1920px **全部无横向溢出** |
| 「卡头按钮命中区不足 36px」 | **不成立** —— 第 42 轮 U-02/U-03 已修，本轮实测菜单项 254×36、卡头 `.btn-icon` 36px，全部达标 |
| 「emoji 是插画，应当全部替换」 | **降级为 P2 且部分撤回** —— 「emoji 读屏逐字播报」与「不跟主题字体」是**确凿**的（V-12）；但「emoji 本身廉价」是审美判断，不是缺陷。改为给出**可选**建议，不作为必修项 |

---

## 4. 给第 44 轮的待办（本轮未覆盖）

| 项 | 为什么没做 |
|---|---|
| Toast 的 error / warning / info 三种类型逐主题 | 本轮只触发了 success；另三种的壳体样式与 success 同构（同一个 `getTypeStyles()` 模板换色），预计结论一致，但没实测就不写进清单 |
| 同步中 / 同步失败两个状态 | 需要真连一个后端才能触发，本轮无凭据 |
| 未登录态的深色模式 | 菜单在深色下的实测只覆盖了 claude 浅色一轮 |
| 设置页的完整逐主题矩阵（只覆盖了 4 套主题的主题环） | 设置页元素多，本轮聚焦「当前主题」环这一处 |
| 320px 下引导页的布局 | 引导是固定 520px 卡片，320px 下是否溢出未量 |
| 搜索结果的键盘导航 | 与本轮的视觉/可达性口径交叉，本轮未做 |

---

## 5. 附：本轮的方法性提醒

**采样时机**。本轮有两条判断差点被自己的采样方式做假：焦点环宽���（V-2 之前的假红）与 Tab 序里的重复元素。两者都不是靠读代码能发现的 —— 只有真机、真按 Tab、等过渡落定后才看得清。**任何"过渡中途"的读数都不能直接当结论。**

**守卫的覆盖面 ≠ 需求的覆盖面**。`hardcodedGrayTextScanned` 守的是「对比度」，`contrast-audit.mjs` 守的是「主题令牌自身的对比」—— 两者都不管「这个元素**跟不跟**当前主题」。本轮 4 条 P0/P1（V-1 V-2 V-3 V-7）全部落在这个缝里。**新增守卫时要把「跟主题」当成独立维度来钉，而不是指望对比度守卫顺带覆盖。**
