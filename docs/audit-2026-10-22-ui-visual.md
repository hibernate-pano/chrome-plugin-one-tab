# TapStack UI / UX 只读审计（2026-10-22）

> 视角：资深 UI/UX 审计 + 前端视觉工程。判据是「像不像一个成熟商业产品」。
> **本轮没有改任何代码**（只读）。所有临时脚本已删除，工作区只多了本文件。
> 基线：`dist/` 构建于 2026-10-22 03:47（v1.25.1）。

---

## 0. 审计边界与证据口径

| 项 | 说明 |
|---|---|
| 审计对象 | 管理页（`src/popup/index.html` 打开的是**真实浏览器标签页**，不是 popup）——`manifest.json` 无 `default_popup` 证实 |
| 实测环境 | macOS + Chromium（Playwright 载入 `dist/` 为解压缩扩展，`headless: false`） |
| 实测视口 | 1280×800（主）、700×800、500×800、400×600 |
| 证据标注 | 每条都标 **【代码】**（我读了源码并给出 `文件:行号`）或 **【截图】**（只有视觉证据）或 **【实测】**（浏览器里量到的数值） |
| 对比度 | 自写脚本（WCAG 相对亮度公式 + 真实叠放链：页面 → 顶栏浮层 → 卡片 → 卡头 → 井/抬升），**288 组 = 6 主题 × 2 明暗 × 24 对**；未用 axe / Lighthouse |
| 已知重叠 | `docs/audit-2026-10-22-round41.md`（同日的另一轮）已记 L-5/L-7/L-8/L-12。本报告在重叠处**只补实测数字与更省的修法**，不重复占位 |

⚠️ **一个必须先说的口径问题**：我实测时 `dist/` 是 03:47 的构建。**审计期间有别的 agent 在并发改源码**（`Header.tsx` / `TabGroup.tsx` / `global.css` / `OptionsPage.tsx` 已被改动，并新增了 `src/components/tabs/lockFeedbackCopy.ts`）。所以：

- 我实测到的「保存并关闭是实心蓝主按钮」**在当前工作树里已经不存在了** —— `Header.tsx:539` 已改成 `btn btn-secondary`。
- 下面凡是引用实测数值的行，都注明了「03:47 构建」。**重新 build 之后需要复测一次**（仓库自己的教训：`忘了 rebuild ⇒ 前后对比是假的`）。

---

## 1. 结论先行

1. **这个产品不是「没打磨」，是「用 400px popup 的尺子在画一个整页」。** 最硬的证据是字号：整页基准 12px，会话名 14px、标签名 13px、域名 12px —— **会话和它装的东西只差 1px**。这不是审美，是继承链上少了一档。
2. **顶栏的视觉预算全花在了「存档 / 同步 / 换肤」上，「找回」只拿到一颗 28×28 的图标。** 而这个产品 99% 的使用场景是「找回」—— 一屏 10 张卡，每张卡的恢复入口都是同一个灰蓝小箭头。
3. **6 套主题不是 6 种口味，是 6 种不同的产品。** 形状语言 4 种、硬编码颜色 3 处、对比度 288 组里 4 组不达标、深色模式下徽章是另一个品牌的灰蓝。
4. **该改的优先级很清楚**：先把**基准字号 + 命中区 + 主题色归属**这三件事修掉（它们是地基），再谈层级重排。层级重排在 12px 的字上怎么排都是错的。

---

## 2. P0 —— 会让成熟用户觉得「这不专业」，或让功能**不可用**

### U-01 · 顶栏仅存的两块实心色块是**写死的绿与蓝**，12 套主题下都不跟随 accent，且文字对比度不达标

- **位置**：`src/components/sync/SyncButton.tsx:506-510`（上传）、`:535-539`（下载）；配色来源 `tailwind.config.js:16-27`（`primary` 是固定品牌蓝 50–950，**不跟主题**）
- **代码 + 实测**：
  - 上传按钮写死 `bg-green-100 text-green-600`；下载按钮写死 `bg-primary-100 text-primary-600`。
  - 实测（legacy 与 claude 两套主题下读数完全一样）：`uploadBg = rgb(220,252,231)` / `uploadColor = rgb(22,163,74)`；`downloadBg = rgb(219,234,254)` / `downloadColor = rgb(37,99,235)`。
  - claude 主题的 accent 是 `#d97757`（陶土红）。⇒ **claude 主题的顶栏同时出现绿 / 蓝 / 陶土红三种色相**。
- **对比度实测**（标签 13px，属普通文本，需 ≥4.5:1）：
  - `green-600 #16a34a` on `green-100 #dcfce7` = **3.00:1** ❌
  - `primary-600 #2563eb` on `primary-100 #dbeafe` = **4.24:1** ❌
  - 两条在 **12 套主题×明暗下全部一样**（因为是写死的）⇒ **这不是某套主题的问题，是全部 12 套的问题**。
- **为什么是 P0**：这是顶栏最响的两块色块（保存按钮已被并发改成次级后，它们成了**唯一**的实心块）。一个把用户浏览历史存上云的产品，顶栏用「绿色上传 / 蓝色下载 / 陶土红保存」三色，是在告诉用户「这是三个不同的第三方服务拼起来的」。
- **最小改法**：把这两处的颜色换成主题令牌：`bg-[var(--color-accent-subtle)] text-[var(--color-accent-text)]`（或直接用仓里已有的 `.theme-accent-soft` / `.theme-accent-text` 工具类），并把 `bg-primary-*` 全部换成 `--color-accent-*`。**同时**把文字色从 `-600` 提到 `-700` 档（`--color-accent-text` 在 6 套主题里都已按 ≥4.5:1 调过，直接用它即可）。改动只在 `SyncButton.tsx:506-510` 与 `:535-539` 两个 className 串。

### U-02 · 卡片头的 6 颗按钮命中区只有 24×24 / 28×28，**低于本仓自己定的 36×36** —— 而 36px 那条规则被写在了「窄屏」里，方向正好反了

- **位置**：`src/components/tabs/TabGroup.tsx:824`（折叠，`p-1`）、`:967`（恢复，新窗口）、`:977`（当前窗口打开）、`:988`（重命名）、`:999`（锁定）、`:1018`（删除，全部 `p-1.5`）；`src/styles/global.css:1594-1599`；`src/components/layout/hitTarget.ts:22`
- **代码 + 实测**：
  - `hitTarget.ts:22` 明写 `MIN_HIT_TARGET_PX = 36`，文件头还写着「**顶栏所有小图标按钮统一到这个尺寸**」。
  - 但兑现这条的 CSS 是：
    ```css
    /* global.css:1593-1599 */
    @media (max-width: 640px) { .btn-icon { min-width: 2.25rem; min-height: 2.25rem; } }
    ```
    ⇒ **只有窄屏有 36px；≥641px 时 `.btn-icon` 只有 `p-2`（global.css:504-508），卡片头又额外用 `p-1` / `p-1.5` 把它压小。**
  - 实测 @1280px：折叠 **24×24**，其余五颗 **28×28**。
  - 对照实测：顶栏自己的图标按钮（主题切换 / 菜单）是 **36×36** ✅。**同一屏里，重要度低的顶栏图标比重要度高的卡片按钮更好点。**
- **为什么是 P0**：24×24 正好卡在 WCAG 2.2 SC 2.5.8 (AA) 的下限上；而「恢复整个会话」这个按钮用户往往在**没有鼠标**时也要点（触控板 / 触屏 / 屏幕阅读器）。仓库自己的标准被自己的 CSS 否掉了。
- **最小改法**：把 `global.css:1594` 的媒体查询从 `@media (max-width: 640px)` 改成**无条件**（`min-width/min-height: 2.25rem` 对图标按钮在任何宽度都成立，顶栏实测 36×36 已经证明放得下），再把 `TabGroup.tsx` 里 6 处 `p-1` / `p-1.5` 去掉（改用 `btn-icon` 自带的 `p-2`，命中区 36×36）。**一行 CSS + 删 6 个 class**，不必动 `hitTarget.ts`。

### U-03 · 标签行的「物理删除」按钮只有 22×22 —— 低于 WCAG 2.2 SC 2.5.8 (AA) 的 24×24，而它删掉的东西**不可恢复**

- **位置**：`src/components/dnd/DraggableTab.tsx:417`
- **代码 + 实测**：`className="btn-icon theme-btn-hover p-1 tab-item-delete-btn micro-interaction-button"` ⇒ 4px padding + 14px 图标 = **22×22**（实测确认）。
- **为什么是 P0**：
  1. 22 < 24 ⇒ **AA 直接不达标**（SC 2.5.8 Target Size (Minimum)）。
  2. v1.22.0 起删除是**物理清除、没有回收站**（`DraggableTab.tsx:418-422` 的注释自己写着「从会话中移除这条记录（无法恢复）」）⇒ 这是全产品最贵的一个按钮，给了全产品最小的点击区。
- **最小改法**：`DraggableTab.tsx:417` 的 `p-1` 改成 `p-1.5`（→ 26×26）或直接去掉改用 `.btn-icon` 的 `p-2`（→ 32×32）。若与 U-02 的无条件 36px 规则一起做，这一行不用改也会变成 36×36。

### U-04 · 整页基准字号是 12px，**会话名 14px / 标签名 13px / 域名 12px** —— 会话与它装的东西只差 1px，层级直接塌了

- **位置**：`tailwind.config.js:117-125`（自定义 `fontSize` 刻度）；`src/styles/global.css:728-731`（`.tab-group-title` → `text-base`）、`:806-809`（`.tab-item-title` → `text-sm`）、`:815-818`（`.tab-item-url` → `text-xs`）
- **代码 + 实测**：
  - Tailwind 刻度被整体下调一档：`xs 12px / sm 13px / base 14px / lg 16px / xl 18px / 2xl 20px / 3xl 24px`（Tailwind 默认是 12/14/16/18/20/24/30）。**页面里没有一处字用到 24px 以上。**
  - 实测：`body` 计算字号 = **12px**；会话名 14px/600，标签名 13px/400，域名 12px/400。
  - **根因实测**：`chrome-extension://` 源的 UA 规则是 `body { font-size: 75% }`（16 × 0.75 = 12px）。我做了三组对照：**同一个 Chromium 里 `file://` / `chrome://` / `http://localhost` 的 body 都是 16px，只有 `chrome-extension://` 是 12px**；并且把页面上两个 `<link>` 样式表**整个删掉**后 body 仍然是 12px ⇒ **不是应用的 CSS 造成的，但应用也从来没设过 body 字号，于是被动吃下了这条规则。**
- **为什么是 P0**：这不是「字小一点」。**会话名 14px/600 与它的标签名 13px/400 只差 1px** —— 用户扫一屏卡片时，「这是一组」和「这是组里的一条」在视觉上**同级**。所有层级设计（卡片 > 列表项 > 域名）全部失效，因为它们建在 1px 差上。
- **最小改法**（两步，缺一不可）：
  1. `src/styles/global.css:312-318`（`@layer base` 里的 `body { … }`）补一条 `font-size: 0.875rem;`（14px）—— 一次性把没有显式字号的元素抬起来；
  2. `tailwind.config.js:117-125` 的刻度整体上调一档到 Tailwind 默认（`xs 12 / sm 14 / base 16 / lg 18 / xl 20 / 2xl 24 / 3xl 30`），
     这样 `.tab-group-title`（text-base）= 16px、`.tab-item-title`（text-sm）= 14px、`.tab-item-url`（text-xs）= 12px ⇒ **层级差从 1px 变成 2–4px**。
  - ⚠️ 这一步会牵动所有已有的截图基线与视觉回归，**必须单独一次提交**，不要和别的改动混在一起。

---

## 3. P1 —— 影响可用性或让产品显得廉价

### U-05 · 单栏（默认布局）下 1280px 有约 **950px 死区**：域名被推到 x=1083，标题在 x=118

- **位置**：`src/styles/global.css:1400-1419`（顶栏栅格）、`:1545-1549`（`.session-list-stack`）；行布局在 `src/components/dnd/DraggableTab.tsx:354-409`
- **实测 @1280px，单栏（默认 `layoutMode: 'single'`，见 `src/utils/storage.ts:281`）**：
  - 卡片 **1120px 宽**，卡头 1118px，标签行 1118px。
  - `.tab-item-title` 的**盒子** x=118、宽 953px；`.tab-item-url` x=1083、右缘 1148。
  - 标题实际文字只有几百像素 ⇒ 标题文字与它的域名之间隔着 **约 700–1000px 空白**。
  - **切到双栏后同样的组件变成**：标题 x=118 宽 385、域名右缘 580（第二栏 x=686 / 右缘 1148）⇒ 空白降到 100–170px。
- **为什么是 P1**：单栏是默认，而它把一个 1120px 宽的卡铺满 1280 屏，每一行都是「左端一串字 + 右端一个域名 + 中间一大片空」。用户要判断「这条标签属于哪个站」，得把视线从屏幕最左扫到最右。**这就是"不像商业产品"的典型画面：信息在，但没排好。**
- **最小改法**（二选一，推荐前者）：
  - **A（推荐）**：把默认 `layoutMode` 改成 `'double'`（`src/utils/storage.ts:281`）—— 一行改动，1280px 立刻变成两栏，密度与可读性同时改善，且 `.session-grid` 的 `md:grid-cols-2` 实现在 `global.css:1558-1563` 已经存在（不是死代码）。
  - **B**：在 `.tab-item` 内把 `.tab-item-url` 从「行的右端」改成「紧跟标题」—— 即去掉 URL 的 `flex-1` 撑开，改为 `shrink-0` + 固定 `max-w-[200px]`，让右端留白收在卡片内。

### U-06 · 默认会话名在「本地 / 内网站点」场景退化成 `标签组 10月22日 15:30` —— **这才是「一屏 10 张卡长得一样」的真正根因**

- **位置**：`src/domain/tabGroup/sessionName.ts:115-126`（`deriveSessionNameFromChromeTabs`）、`:10-13`（`buildTimestampSessionName`）、`:82-100`（`deriveDominantHost`）
- **代码**：`deriveSessionNameFromChromeTabs` = `deriveDominantHost(urls) ?? buildTimestampSessionName(now)`；而 `deriveDominantHost` 对 `localhost` / IP / 非法协议**直接返回 null**（`:48-56`）⇒ 落到 `标签组 M月D日 HH:MM`。
- **为什么比「没有 favicon」严重**：默认名确实是域名（round41 L-12 说的），所以「同一站点的会话连着出现」在**公网域名**场景里成立；但**内网/本地/自建服务**场景里，一屏 10 张卡全是 `标签组 10月22日 09:12`、`标签组 10月22日 09:47` —— 连站点身份都没有，**favicon 也救不了**（它连域名都没有）。
- **最小改法**：在 `sessionName.ts:126` 的 fallback 里不要再用时间戳，改成**「域名 + 时间」**（`${host ?? '本地'} · 10月22日 15:30`）或直接取**第一个可导航标签的标题**（`tab.title` 往往就是页面名，信息量远大于时间戳）。纯函数，改动只在 `buildTimestampSessionName` 一个函数里。

### U-07 · 筛选面板是全页**唯一**一块不跟主题的颜色；面板里的标签与输入文字全是写死的灰阶

- **位置**：`src/components/search/SearchFilterPanel.tsx:251`（`text-primary-600 dark:text-primary-400`）、`:82 / 108 / 133 / 158`（标签 `text-gray-600 dark:text-gray-300`）、`:96 / 124 / 147 / 168`（输入框 `text-gray-900 dark:text-gray-100`）、`:229`（工具条标题 `text-gray-700 dark:text-gray-300`）
- **代码 + 实测**：`text-primary-600` 来自 `tailwind.config.js:16-27` 的固定品牌蓝。实测 claude 主题下，「显示筛选」按钮的 `color` = **rgb(37,99,235)**，而同屏 accent = **#d97757** ⇒ **整个筛选区里只有这一个元素是「别的产品的蓝」**，而且它恰好是这一行唯一的可点击文字。
- **为什么是 P1**：主题切换做到 6 套、连 `--color-focus-ring` 都按 12 组逐一调过（`global.css:325-333` 的注释写着这件事），却在**用户唯一会主动点的那一行**漏掉了主题化。暖色主题里这一行是冷的。
- **最小改法**：`SearchFilterPanel.tsx:251` 改 `theme-accent-text`；`:82/108/133/158` 改 `theme-text-secondary`；`:96/124/147/168` 改 `theme-text-primary`；`:229` 改 `theme-text-secondary`。全部是 class 名替换，仓库已有对应的 `.theme-*` 工具类。

### U-08 · 筛选面板在 400px 吃掉 **191px**，第一张会话卡**整体**落到折叠线以下

- **位置**：`src/components/tabs/TabList.tsx:365-372`（面板渲染在列表上方）、`src/components/search/SearchFilterPanel.tsx:76-77`
- **实测**：
  | 视口 | 面板高 | 面板底 | 首卡顶 | 首卡可见高 / 卡片总高 |
  |---|---|---|---|---|
  | 1280 | 82 | — | 117 → **223** | 整卡在屏内 |
  | 700 | 141 | — | 159 → **324** | 整卡在屏内 |
  | 500 | 191 | — | 151 → **366** | 234 / 287 |
  | 400 | **191** | 342 | **366** | **234 / 287**（视口 600 ⇒ 卡片下半截在屏外） |
- **为什么是 P1（不是 P0）**：见「我撤回的判断」第 1 条 —— 桌面端不成立，只有窄窗口成立。但窄窗口下**整张卡**掉到折叠线以下，用户第一眼看到的是一片空白 + 一堆表单。
- **最小改法**：`SearchFilterPanel.tsx:76-77` 改成**一行紧凑控件**而不是三块表单：
  - 把「域名 / 会话名 / 保存时间」收成**一条 chip 行**（`flex flex-wrap gap-1` 的小圆角 chip，点开才展开对应输入框），或整块挪进 `SearchFilterSection` 的**下拉浮层**（复用仓里已有的 `HeaderDropdown` / `Tooltip` 定位逻辑）。
  - 1280px 下则改成**贴着搜索框右侧的一个「筛选」按钮 + 已生效条件的 chip 行**（筛选条件生效时必须可见 —— `SearchFilterPanel.tsx:204-207` 的注释已经确立了这条契约，chip 行正好兑现它）。

### U-09 · 筛选面板的 4 列栅格把 3 个短字段摊到 ~280px 的格子里，第 4 格空着

- **位置**：`src/components/search/SearchFilterPanel.tsx:77`（`grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`）
- **实测 @1280px**：`lg` 断点（1024px）生效 ⇒ 4 列。3 个控件各占一列，输入框宽约 **280px**，装一个域名（`github.com`）；**第 4 列空着**。同时 `:78` 的「固定标签页」下拉是条件渲染（`collectPinnedTabs` 关闭时不渲染）⇒ 关掉这个设置时**空列会变成 2 个**。
- **为什么是 P1**：一行 82px 里塞了 3 个 280px 的输入框 + 一列空白，是「表格套表格」的做法；成熟的筛选条通常是「若干个窄控件挤在一起 + 右侧留白」，而不是把每个控件撑成 1/4 屏。
- **最小改法**：`:77` 改成 `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3`（配合 U-08 的 chip 方案则直接改成 `flex flex-wrap`），并给域名 / 会话名输入框加 `max-w-[16rem]`。

### U-10 · 卡片头两枚「打开」图标在 16px 下近乎同形（补强 round41 L-7，给一个更省的改法）

- **位置**：`src/components/tabs/TabGroup.tsx:41-73`（`OpenAllIcon` / `OpenAllInPlaceIcon` 的 path）、`:967` / `:977`（两个按钮）
- **代码 + 实测**：
  - `OpenAllIcon` = 圆角矩形 + **出框**箭头（`M21 3m0 0h-5.25M21 3v5.25`）；
  - `OpenAllInPlaceIcon` = 同一个圆角矩形 + **入框**箭头（`M21 3l-7.5 7.5`）。
  - ⇒ **两个图形的 90% 像素完全一样**，唯一区别是箭头朝向。
  - 实测截图（3× 设备像素比渲染）：两枚图标并排，第一枚 accent 色、第二枚灰色，肉眼读不出「一个开新窗口、一个开当前窗口」。
- **为什么是 P1**（round41 记为 P2，我提级）：这两颗是**整个产品最高频的两个动作**（「找回」），而且它们并排出现在每一张卡上。round41 的改法（把「当前窗口打开」收进「更多」）是对的，但**更省的做法是不用改结构，只改图形**：
- **最小改法**（任选其一，都在 `TabGroup.tsx:41-73` 一个文件内）：
  - 把 `OpenAllInPlaceIcon` 换成**方框 + 向左下箭头**（明确「就地」），或换成**两个重叠的小窗口**（业界通用「在新窗口打开」符号）；
  - 或者把「在新窗口恢复」改成**实心 accent 底 + 白色图标**（`tab-group-action-accent` 已经在承担「唯一高亮」的职责），「当前窗口打开」保持描边灰 —— **用形状 + 填充两重编码**，16px 下绝不含糊，且不增加任何按钮。

### U-11 · 「锁定会话」按钮画的图标是**当前状态**而不是**动作结果**：未锁定时画的是一把**开着的**挂锁

- **位置**：`src/components/tabs/TabGroup.tsx:47-53`（`LockIcon` 的 `locked=false` 分支）、`:999`（按钮）
- **代码**：未锁定 → 渲染 shackle 翘起的开锁；锁定 → 渲染闭锁。按钮的 `aria-label` 是「锁定会话」（动作）。
- **为什么是 P1**：图标约定（Material / Lucide / SF Symbols 一致）是**按钮上的图标表示「点了会发生什么」**。一个叫「锁定会话」的按钮画着一把开着的锁，语义正好相反 —— 用户读成「这个会话没锁」。
- **最小改法**：`TabGroup.tsx:47-53` 去掉 `locked` 参数，**永远画闭锁**；解锁时用 `aria-label="解锁会话"` 区分即可（颜色可保留 `tab-group-lock-icon` 作为状态提示）。

### U-12 · 288 组对比度里有 **3 处硬失败**：最关键的「恢复」图标在 claude 浅色下几乎看不见

- **位置**：`src/styles/themes/claude.css:32`（浅色 `--color-accent: #d97757`）、`src/styles/themes/legacy.css`（深色 `--color-accent: #3b82f6`，卡头底 `#1f2937` 见 `:259-261`）、`src/styles/themes/prism.css:31`（`--color-text-tertiary: #6366f1`）；图标色来源 `src/styles/global.css:504-508`（`.btn-icon` 用 `--color-text-tertiary`）与 `src/styles/themes/creamy.css:318-322`（`.tab-group-action-accent` 用 `--color-accent`）
- **实测**（脚本口径：真实叠放链 = 页面 → 顶栏浮层 → 卡片 → 卡头 → 井/抬升）：

  | 主题×明暗 | 组合 | 实测 | 阈值 | 结果 |
  |---|---|---|---|---|
  | legacy **dark** | accent 图标 / 卡头底 | **2.80** | 3.0（非文本） | ❌ |
  | claude **light** | accent 图标 / 卡片底 | **2.96** | 3.0（非文本） | ❌ |
  | claude **light** | accent 图标 / 卡头底 | **2.57** | 3.0（非文本） | ❌ |
  | prism light | 三级文字 / 卡片底 | 4.41 | 4.5（文本） | ⚠️ 临界 |

  其余 284 组通过；每套主题的最差值：legacy light 4.70 / legacy dark 2.80 / creamy light 3.02 / creamy dark 4.67 / prism light 3.61 / prism dark 5.63 / apple light 4.31 / apple dark 4.66 / chrome light 4.05 / chrome dark 4.57 / claude light 2.57 / claude dark 5.21。
- **为什么是 P1**：claude 浅色下 **「在新窗口恢复整个会话」那颗图标（accent 色）在卡片上只有 2.96:1，在卡头上只有 2.57:1** —— 全产品最该被看见的那个动作，在最像「有人精心设计过」的那套主题里，是一团看不清的浅橘色。
- **最小改法**：
  - claude 浅色：把 `--color-accent` 压深一档（`#d97757` → `#c2603f` 一类），或单独给 `.tab-group-action-accent` 用一个**更深的墨色令牌**（新增 `--color-accent-strong`，仓库在 legacy/creamy 里已有这个 token 的先例：`legacy.css` 深色块的 `--color-accent-strong: #60a5fa`）。
  - legacy 深色：`.tab-group-header` 的 `#1f2937`（`legacy.css:259-261`）与 accent `#3b82f6` 太近 ⇒ 把卡头底换成 `--color-bg-tertiary`（`#374151`）或把 accent 提到 `--color-accent-hover`（`#60a5fa`）。
  - prism light：`--color-text-tertiary: #6366f1` 略暗一点即可过 4.5。

### U-13 · creamy 浅色的数量徽章：白字压在琥珀渐变上 = **3.19:1**（需 4.5）

- **位置**：`src/styles/themes/creamy.css:205-211`
- **代码**：`background: linear-gradient(135deg, var(--color-accent) 0%, var(--color-accent-hover) 100%); color: #ffffff;` —— 渐变左端是 `#d97706`（琥珀），白字在左半边只有 **3.19:1**，右端 `#b45309` 是 5.02:1，中间 3.99:1。
- **为什么是 P1**：徽章虽然只有 12px，但它显示的是「这个会话有 4 个标签」—— 一条**数据**，且是每张卡上唯一的数字。数字看不清 = 用户不知道该点开哪张卡。
- **最小改法**：`creamy.css:208` 把 `color: #ffffff` 换成 `var(--color-accent-fg)`（creamy 自己已经定义了这个 token：浅色 `#0f172a`、深色 `#1c1917` —— `creamy.css:30` / `:124`）⇒ 白字变深墨字，3.19 → 约 6.5:1，且与同主题的按钮底色处理方式一致。

### U-14 · 6 套主题有 **4 种按钮形状语言**：chrome 是正圆、apple/claude 是 8px、prism 是 12px、legacy 主按钮是 6px

- **位置**：`src/styles/themes/chrome.css:164`（`.btn-icon{border-radius:9999px}`）、`:139-164`（`.btn-primary` 药丸 + `.search-input` 药丸）；`src/styles/themes/apple.css:159`（`.btn-icon` 8px）+ `:141-165`（`.btn-primary` 药丸）；`src/styles/themes/claude.css:164`（`.btn-icon` 8px）；`src/styles/themes/legacy.css:180-213`（`--radius-md: 6px`）；`src/styles/themes/prism.css:393`（`.btn-icon` 12px）；默认 `src/styles/global.css:504-508`（`rounded-lg` = 8px）
- **实测（逐套主题切过去读计算样式）**：

  | 主题 | `.btn-icon` | 涟漪 `::after` | `.btn-primary` | `.search-input` |
  |---|---|---|---|---|
  | chrome | **9999px（正圆）** | 8px | **9999px（药丸）** | 9999px |
  | apple | 8px | 8px | **9999px（药丸）** | 9999px |
  | claude | 8px | 8px | 8px | 9999px |
  | creamy | 8px | 8px | 8px | 9999px |
  | prism | **12px** | 8px | 8px | 9999px |
  | legacy | 8px | 8px | **6px** | **6px** |

  ⇒ **`.btn-primary` 3 种圆角**（9999 / 8 / 6）、**`.btn-icon` 3 种**（9999 / 8 / 12）、**`.search-input` 2 种**（9999 / 6）。另外 legacy 的 `.tab-group-count` 圆角实测 = **4px**（`legacy.css:265-277` 覆写），而默认主题是 `rounded-full` ⇒ 同一个「数量徽章」在不同主题下形状都不一样。
- **为什么是 P1**：这一条最像「**这是另一个产品的皮肤**」—— chrome 主题的圆按钮 + 药丸主按钮 + 药丸搜索框，组合起来就是 Google Material 的招牌；apple 主题的卡片浮起（`apple.css` 的 `translateY(-1px)` hover）+ 药丸主按钮 = Apple 的招牌。用户会下意识觉得「这个主题是外挂的」。
- **最小改法**：把「形状」也 token 化 —— 在 6 套主题里各加 `--radius-btn` / `--radius-btn-icon` 两个变量，默认 8px；chrome 改成 `--radius-btn: 10px`（**去掉 9999px，但保留药丸搜索框**）、apple 改成 `--radius-btn: 10px`（**去掉药丸主按钮**）。改动是 6 个 CSS 文件各加 2 行 + 改 6 处 `border-radius`，**不动任何 TSX**。

### U-15 · 会话卡没有视觉身份 —— 但加 favicon 的成本是**零**

- **位置**：`src/components/tabs/TabGroup.tsx:820-893`（卡头，**没有** favicon）；对比 `src/components/dnd/DraggableTab.tsx:380` 与 `src/components/search/SearchResultList.tsx:631`（标签行**有** `SafeFavicon`）
- **代码（关键）**：`SafeFavicon` 只在**标签行**出现，**卡片级一处都没有** ⇒ **行比卡更可辨识**，层级倒挂。
- **成本核算（这一条比 round41 L-12 说得更具体）**：会话里**已经存着每个标签的 `favicon` 字段**，来源是浏览器自己的 `chrome.tabs.Tab.favIconUrl`（`src/domain/tabGroup/factory.ts:41` → `src/utils/faviconUtils.ts` 只放行 https/http/data/chrome-extension）。
  ⇒ **卡片加 favicon 不需要新权限、不需要新网络请求、不需要第三方服务**，只需要在卡头复用已有的 `<SafeFavicon>`。
- **收益/成本**：收益 = 一屏 10 张卡从「10 个同名时间戳」变成「10 个可扫的图标」；成本 = 一个 `<SafeFavicon src={group.tabs[0]?.favicon} className="w-4 h-4" />`。
- **最小改法**：`TabGroup.tsx` 卡头的折叠按钮（`:823`）与标题之间插入 `<SafeFavicon src={dominantTab?.favicon} alt="" className="w-4 h-4 shrink-0" />`，其中 `dominantTab` 取**域名占多数的那个标签**（`deriveDominantHost` 已在 `sessionName.ts:82` 提供了判据，抽一个 `pickDominantTab(group.tabs)` 纯函数出来即可单测）。**注意**：这不能替代 U-06 —— 内网场景连域名都没有，还是得靠 U-06 修默认名。

---

## 4. P2 —— 不致命，但成熟产品不会这样

### U-16 · 深色模式下的数量徽章是**另一个品牌的冷灰蓝**
- **位置**：`src/styles/global.css:739-742`：`.dark .tab-group-count { background: rgba(148,163,184,0.12); color: #94a3b8; }` —— 写死的 slate，不读 `--color-*`。
- **实测**：claude 深色（暖黑 `#2a2825`）下，徽章是**冷灰蓝**（`#94a3b8`）—— 对比度 4.64:1（勉强过），但**色相不属于这套主题**；apple/chrome 深色同理。
- **最小改法**：`global.css:739-742` 改成 `background: var(--color-bg-tertiary); color: var(--color-text-tertiary);`（全局 token 在 6 套主题里都已定义），删掉这三条写死值。

### U-17 · chrome 主题的圆按钮里，涟漪是方的（实测：按钮 9999px，涟漪恒为 8px）
- **位置**：`src/styles/micro-interactions.css:72-79`（`.btn-icon::after { border-radius: 0.5rem; }`）vs `src/styles/themes/chrome.css:164`（`.btn-icon{border-radius:9999px}`）
- **实测**（逐套主题读 `.btn-icon` 与它的 `::after`）：**涟漪的圆角在 6 套主题下恒为 `8px`**（写死），而 chrome 的按钮是 **`9999px` 正圆** ⇒ 一个正圆按钮里出现一个方形涟漪。其它 5 套主题的按钮是 8/12px，与涟漪同值 ⇒ 看不出来。
- **为什么是 P2**：只在 chrome 主题上出现，但 chrome 恰好是「一眼像 Material」的那套 —— 它的每一个视觉细节都在被逐帧比对。
- **最小改法**：`micro-interactions.css:76` 的 `border-radius: 0.5rem` 改成 `border-radius: inherit`（一层就够，涟漪自动跟随按钮形状）。

### U-18 · 同一个 App 里两套 tooltip 节奏：顶栏 300ms 自建，卡片头走原生 `title`（≈1s，触屏完全没有）
- **位置**：`src/components/common/Tooltip.tsx:20`（`delay = 300`）vs `src/components/tabs/TabGroup.tsx:968 / 978 / 989 / 1000 / 1019`（原生 `title=`）
- **为什么是 P2**：原生 `title` 有 ~1 秒延迟、样式不可控、**触屏上永远不出现**。卡片头恰恰是新手最需要提示的地方。
- **最小改法**：`TabGroup.tsx` 卡头 6 处 `title=` 换成仓里已有的 `<Tooltip content="…">` 包裹（`Tooltip.tsx` 已经在 `Header.tsx:433` 用了）；`aria-label` 保持不变。

### U-19 · 卡头的时间戳与默认会话名重复表达同一件事
- **位置**：`src/components/tabs/TabGroup.tsx:891-893`（`.tab-group-time`，`formatTime(group.createdAt)`）vs `src/domain/tabGroup/sessionName.ts:10-13`（默认名 `标签组 M月D日 HH:MM`）
- **实测**：默认名场景下，卡头同时出现「标签组 10月22日 15:30」和「3 小时前」。
- **最小改法**：随 U-06 一起改（默认名不再含时间），或把 `formatTime` 的精度提到「10月22日 15:30」让两者互补。

### U-20 · 顶栏：6 个操作元素占 **434px**，比搜索框（**428px**）还宽 —— 「找回」的入口比「存档+同步+换肤」的总和还窄
- **位置**：`src/styles/global.css:1400-1419`
- **实测 @1280px**：`actions` x=754、宽 434（含 3 颗 36px 图标 + 上传/下载 148px + 保存 121px + 菜单 36px）；`search` x=314、宽 428；`brand` 宽 218。
- **为什么是 P2**：三段栅格 `auto | minmax(0,1fr) | auto` 里，右段是 `flex-shrink: 0`（`:1418`）⇒ **操作区永远赢**。今天 434 > 428 只是勉强；再加一颗按钮，搜索框就开始被压（`global.css:1421-1437` 的注释里记着这条防线上一次是怎么塌的）。
- **最小改法**：U-01 把上传/下载改成 `btn-icon` 后，这两处各省约 40px ⇒ 操作区降到 ~350px；再把 `:1418` 的 `flex-shrink: 0` 改成 `flex-shrink: 0` + 给搜索轨道的 `minmax` 留一个下限即可（那条防线已经在了）。

### U-21 · 标签行的删除键在 ≥768px 是 `opacity: 0` 但 `pointer-events: auto` —— **隐形但可点**
- **位置**：`src/styles/global.css:851-867`（`.tab-item-actions { opacity:100 md:opacity-0 }`、`:856` `:hover` 显形、`:865` `:focus-within` 显形）
- **实测**：不 hover 时 `opacity: 0`、`pointer-events: auto`；在该按钮中心做 `elementFromPoint` → **命中的是删除按钮自己**（`hitIsDeleteBtn: true`）。
- **为什么是 P2**：鼠标用户悬停时会显形（`:856`），风险有限；但**触屏没有 hover** ⇒ 见「未能验证项」第 4 条。
- **最小改法**：`:851` 的 `.tab-item-actions` 在 `md` 档改用 `opacity-0 pointer-events-none md:hover:pointer-events-auto`（或直接 `md:hidden` + 把删除放进卡头的「更多」菜单）。

### U-22 · 筛选面板的控件比整页其它地方还小一档：标签 12px、输入框 13px
- **位置**：`src/components/search/SearchFilterPanel.tsx:82 / 108 / 133 / 158`（`text-xs` = 12px）、`:96 / 124 / 147 / 168`（`text-sm` = 13px）
- **对比（实测）**：会话名 14px、**标签名 13px**、域名 12px ⇒ **一个需要精确输入域名的输入框（13px），和一个只用来读的标签名（13px），是同一个字号**；筛选器的字段标签（12px）比会话名还小两档。
- **最小改法**：随 U-04 的字号上调一起走（`text-xs` → `text-sm`、`text-sm` → `text-base`）。

### U-23 · 主题风格选择器用写死的蓝色焦点环
- **位置**：`src/components/layout/ThemeStyleSelector.tsx:336`、`:399`（`focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`）
- **为什么是 P2**：`focus-visible:outline-none` 把全站那套 `--color-focus-ring` 换成了 **Tailwind 固定蓝** ⇒ 在 claude / creamy 主题的设置页里，键盘用户会看到一圈不属于主题的蓝。
- **最小改法**：去掉 `focus-visible:outline-none focus-visible:ring-blue-500`，让全局 `global.css:331-333` 的 `:focus-visible` 生效（那套已经按 12 组调过）。

### U-24 · 6 套主题对「卡头是不是一个独立区块」的判断不一致：3 套有底色、3 套透明
- **位置**：`src/styles/global.css:722-726`（默认 `--color-bg-tertiary`）、`src/styles/themes/legacy.css:253-261`（写死 `#f9fafb` / `#1f2937`）、`creamy.css:194-198`（暖渐变）、`prism.css:295-298`（渐变）、`apple.css:150` / `chrome.css:150` / `claude.css:154`（`background: transparent`）
- **实测**：legacy 卡头 `background-color = rgb(249,250,251)`，与其余主题不同源。
- **为什么是 P2**：同一个组件在 6 套主题里结构上不是同一个东西（有的「有头」、有的「没头」）。这不是审美分歧，是**没定义**。另外 `legacy.css:253` 的 `#f9fafb` / `:260` 的 `#1f2937` 是**写死的**，不跟 `legacy` 自己的 token。
- **最小改法**：把「卡头底色」也 token 化（新增 `--color-card-head-bg`），6 套主题各给一个值（想要透明的三套给 `transparent` 即可），`legacy.css:253-261` 的两行写死值随之删掉。

### U-25 · 「标签行底色由主题决定」这件事，发生在**三个文件**里 —— 任何一处漏改，主题就漏
- **位置**：`src/styles/global.css:782-787`（`.tab-item`）、`src/styles/drag-drop.css`（**后加载**，由 `src/components/app/MainApp.tsx:11-12` import，晚于 `src/popup/index.tsx:6` 的 global.css）、以及各主题的覆盖（`creamy.css:283-295` 的注释把这件事写得很清楚）
- **代码**：`creamy.css:283-295` 的注释明说：「原先这里**不声明底色** ⇒ 底色落回 drag-drop.css（那个文件在 global.css **之后**加载），而那里写死的是 white / #1f2937 ⇒ creamy 深色态的每一条标签行都是一块**冷蓝灰**」。
- **为什么是 P2**：这是**已经修过一次**的坑（cream 已经补上了），但**结构性的坑还在**：一个属性由 3 个文件按加载顺序共同决定。任何新主题只写自己的 `.tab-item` 而忘了 drag-drop.css 的覆盖顺序，就会重演一次。
- **最小改法**：把 `.tab-item` 的底色/边框/圆角统一收进 `@layer components` 的一条规则，主题只覆盖 **CSS 变量**（`--tab-item-bg` / `--tab-item-border`）而不是直接写属性；`drag-drop.css` 只负责拖拽态（`.dragging` / `.drag-over`），不再声明静态底色。

---

## 5. 我撤回的判断（复核后不成立）

这一节和缺陷一样重要 —— 它证明我没有为了凑数硬找问题。

| # | 我怀疑过 | 复核结果 | 结论 |
|---|---|---|---|
| 1 | **「筛选面板把列表整个推出屏幕」**（这是给我的原始前提） | 实测 @1280px：面板**只有 82px**，首卡 y=117→**223**，视口 800 ⇒ 列表**没有**被推出屏幕；@700px 面板 141px、首卡 y=324，仍在屏内。只有 **≤500px**（面板 191px、首卡顶 366px、视口 600）才整卡落到折叠线下。 | **撤回 P0 前提**；降级为 U-08 的 **P1（仅窄屏）** |
| 2 | **「焦点环在会话标题与图标按钮之间不一致」** | 第一轮实测到图标按钮是 `1.5px solid rgb(107,114,128) offset 0`、标题是 `2px solid #1d4ed8 offset 2`，差点报成不一致。复核发现 `micro-interactions.css:64-70` 的 `.btn-icon { transition: all 60ms }` 让 outline 的宽度/偏移**动画进场**，我测在了动画中间。静置 300ms 后全站统一为 `2px solid var(--color-focus-ring) offset 2px`。 | **撤回** |
| 3 | **「保存按钮的可访问名重复」** | `Header.tsx:495-510` 确实有两个 span 各带一份文案（`hidden sm:inline` + `sm:hidden`），DOM `textContent` 会读两遍。但按钮上有 `aria-label`（`Header.tsx:503`）⇒ 可访问名走 aria-label，**读屏不会重复**。 | **撤回「可访问性缺陷」**；只保留「DOM 文本重复影响检索/测试断言」这一事实 |
| 4 | **「会话名本来就是域名，卡片因此有身份」** | `sessionName.ts:115-126` 确实优先取域名 ⇒ 对**公网域名**成立。但 `deriveDominantHost` 对 localhost / IP / 非 http 协议返回 null（`:48-56`）⇒ 落到时间戳名。 | **部分撤回**；保留 U-06 |
| 5 | **「棱镜 / 奶油主题缺 token」** | 我第一版对比脚本只认双引号选择器 `html[data-theme="x"]`，漏掉 `creamy.css:8` 的**单引号** `html[data-theme='creamy']`，于是报了一批「缺 token」的假阳性。复核源码后确认是**我的脚本**的锅。 | **撤回** |
| 6 | **「favicon 走的是 Google 的 s2/favicons 第三方服务」** | 我注入测试数据时用了 Google 的 favicon URL，一度以为产品依赖它。复核 `src/utils/faviconUtils.ts`（只放行 https/http/data/chrome-extension）与 `src/domain/tabGroup/factory.ts:41` 后确认：favicon 来自 `chrome.tabs.Tab.favIconUrl`（浏览器自己的缓存图标）。 | **撤回**（副作用：U-15 的修法因此确认为零成本、零第三方依赖） |
| 7 | **「`prefers-reduced-motion` 没覆盖到 drag-drop / animations」** | `global.css:349-398` 用 `*` + `!important` 覆盖了 `animation-duration` / `iteration-count` / `transition-duration`。实测（`emulateMedia({reducedMotion:'reduce'})`）：`animationDuration = 1e-06s`、`transitionDuration = 1e-06s`、卡片 transition = `0s`。 | **撤回** |
| 8 | **「顶栏的『切换布局 / 清理重复』与菜单项重复」** | `Header.tsx:432 / 448` 是 `hidden sm:block`，而 `HeaderDropdown` 里的同名项是 `sm:hidden` ⇒ 互斥出现，代码注释也写明是有意的窄屏补偿。 | **撤回** |

---

## 6. 未能验证项（明确标出，不假装验过）

1. **Windows / Linux 渲染**：全程只在 macOS + Chromium 实测。Windows 的滚动条 gutter 是 15–17px（macOS 8px），`global.css:1494-1496` 的注释自己也提到这点 ⇒ **400px 临界宽度在 Windows 上会更早触发品牌名隐藏与顶栏压缩**。未在 Windows 上验。
2. **Chrome 真机（非 Playwright 载入解压缩扩展）**：商店版可能有 CSP / 权限 / 扩展页尺寸差异；`manifest.json` 无 `default_popup` ⇒ 管理页是真实标签页，行为与 popup 不同，未在真机上对照。
3. **屏幕阅读器实播**：我只用 CDP 读了可访问名、`:focus-visible` 匹配结果与 Tab 序列，**没有用 VoiceOver / NVDA 实播**。U-11（图标语义反向）、U-13 之外的 aria 正确性都需要实播确认。
4. **触屏行为**：全部测量在鼠标指针下完成。U-21（`opacity:0` 的行删除键）**我怀疑在触屏上永远看不见**（触屏没有 hover，`:856` 的 `:hover` 规则不触发），但**没有在真触屏设备上验证过**。
5. **其余 4 套主题没有逐一截图**：除 legacy / claude 外，我是通过改 `data-theme` 属性取计算样式。主题切换有 250ms 的 `theme-transitioning` 过渡（`ThemeContext.tsx:23`），中途读数会偏色 —— 我在计算时避开了，但没有全部改完就重取一次。
6. **对比度只覆盖了「真实叠放链上的关键对」**：288 组是脚本枚举的 token 组合，**不是每一个 token 组合**；且**没有用 axe / Lighthouse 实跑**。
7. **真实数据形态**：所有会话数据是我注入的构造数据（2 个会话 / 6 个标签）。10–30 个会话、多域名混排、标题超长到截断、favicon 缺失等真实形态没验。
8. **改完之后没有复测**：本轮只读，未改任何代码 ⇒ 所有「最小改法」**未经实施验证**，可能连带影响未列出的地方（例如 U-04 的字号上调会影响所有截图基线）。
9. **并发改动未纳入**：审计期间别的 agent 改了 `Header.tsx` / `TabGroup.tsx` / `global.css` / `OptionsPage.tsx` 并新增 `lockFeedbackCopy.ts`。我引用的行号是**当时工作树**的（已在文中标注），**没有复核这些并发改动是否已经修掉了某条**。

---

## 7. 需要负责人亲自决断的事（我不替他决定）

1. **顶栏最终留几块实心色块？** 我的推荐：**0 块**。保存/上传/下载全部降为次级按钮或纯图标，靠 tooltip 与 hover 说明；页面唯一的实心主按钮留在空态卡上（那才是「只有一个明显该做的事」的时刻）。
2. **1280px 的默认布局是单栏还是双栏？** 我的推荐：**双栏**（`storage.ts:281` 一行）。单栏在 1280px 上铺出 1120px 的卡 + 950px 死区（U-05）。
3. **卡片要不要 favicon？取谁的？** 我的推荐：**取「域名占多数的那个标签」的 favicon**，纯函数化以便单测（U-15）。但这解决不了内网场景 —— 那个只能靠 U-06 修默认名。
4. **基准字号整体上调一档（12→14 / 刻度回默认）要不要做？** 我的推荐：**做**，它是 U-04 的根因，也是其它密度问题的地基。但它**会牵动所有截图基线**，必须单独一次提交、单独跑一遍视觉回归。
5. **「锁定」图标要不要改成永远画闭锁（U-11）？** 这会改变用户已经建立的心智模型（「锁形 = 当前状态」），如果产品里还有别的地方用同一套图标语言，需要一起改。

---

## 8. 汇总表（可直接派活）

| 编号 | 级别 | 一句话标题 | 位置 | 最小改法 |
|---|---|---|---|---|
| U-01 | P0 | 顶栏上传/下载写死绿蓝，不跟主题且对比度 3.00/4.24 不达标 | `src/components/sync/SyncButton.tsx:506-510, 535-539` | 两处 className 换 `theme-accent-soft` / `theme-accent-text`（替掉 `bg-green-100` / `bg-primary-100`） |
| U-02 | P0 | 卡片头按钮 24×24 / 28×28，低于本仓自定的 36px，而 36px 规则只写在窄屏 | `TabGroup.tsx:824,967,977,988,999,1018`；`global.css:1594-1599`；`hitTarget.ts:22` | 把 `global.css:1594` 的媒体查询去掉（36px 无条件生效）+ 删 6 处 `p-1`/`p-1.5` |
| U-03 | P0 | 标签行物理删除键 22×22，低于 WCAG 2.5.8 AA 的 24×24 | `src/components/dnd/DraggableTab.tsx:417` | `p-1` → `p-1.5`（或跟 U-02 一起自动变 36px） |
| U-04 | P0 | 基准 12px：会话名 14 / 标签名 13 / 域名 12，只差 1px | `tailwind.config.js:117-125`；`global.css:728,806,815` | 加 `body{font-size:0.875rem}` + 刻度回 Tailwind 默认（base 16 / sm 14） |
| U-05 | P1 | 单栏 1280px 有 ~950px 死区，域名被推到右缘 | `global.css:1400-1419,1545`；`DraggableTab.tsx:354-409` | 默认 `layoutMode` 改 `'double'`（`storage.ts:281`），或 URL 不再撑到行尾 |
| U-06 | P1 | 内网/localhost 场景默认名退化成时间戳 ⇒ 10 张卡全一样 | `src/domain/tabGroup/sessionName.ts:10-13,115-126` | fallback 改成「域名 · 时间」或取第一个标签标题 |
| U-07 | P1 | 「显示筛选」是全页唯一的写死蓝，面板内文字全是写死灰阶 | `SearchFilterPanel.tsx:251,82,108,133,158,96,124,147,168,229` | 全部换成 `theme-accent-text` / `theme-text-secondary` / `theme-text-primary` |
| U-08 | P1 | 400px 下筛选面板 191px，首卡整张落到折叠线下 | `TabList.tsx:365-372`；`SearchFilterPanel.tsx:76-77` | 面板改 chip 行或下拉浮层，不再整块插入列表上方 |
| U-09 | P1 | 4 列栅格把 3 个短字段摊到 ~280px，第 4 列空着 | `SearchFilterPanel.tsx:77` | 改 `lg:grid-cols-3` + 输入框 `max-w-[16rem]` |
| U-10 | P1 | 两枚「打开」图标 16px 近乎同形（补强 round41 L-7） | `TabGroup.tsx:41-73,967,977` | 换图形（重叠窗口/左下箭头）或把「恢复」改成 accent 实心底 |
| U-11 | P1 | 「锁定会话」按钮画的是开着的锁（画状态不画动作） | `TabGroup.tsx:47-53,999` | `LockIcon` 永远画闭锁，解锁靠 `aria-label` 区分 |
| U-12 | P1 | 288 组对比度 3 处硬失败，claude 浅色下恢复图标只有 2.57–2.96 | `claude.css:32`；`legacy.css`(深色 accent + `:259-261`)；`prism.css:31` | claude 浅色 accent 压深一档 / legacy 深色卡头底换 tertiary / prism tertiary 加深一点 |
| U-13 | P1 | creamy 浅色徽章白字压琥珀渐变 = 3.19:1 | `src/styles/themes/creamy.css:205-211` | `color:#fff` → `var(--color-accent-fg)` |
| U-14 | P1 | 6 套主题 4 种形状语言（主按钮 9999/8/6，图标按钮 9999/8/12），像换了个产品 | `chrome.css:164,139-164`；`apple.css:159,141-165`；`claude.css:164`；`prism.css:393`；`legacy.css:180-213` | 形状 token 化（`--radius-btn` / `--radius-btn-icon`），chrome/apple 去掉 9999px |
| U-15 | P1 | 卡片无视觉身份（行有卡没有）——但加 favicon 成本为零 | `TabGroup.tsx:820-893` vs `DraggableTab.tsx:380` | 卡头插 `<SafeFavicon src={dominantTab.favicon}>`，取域名的 favicon |
| U-16 | P2 | 深色徽章是写死的冷灰蓝（另一个品牌的颜色） | `global.css:739-742` | 改 `var(--color-bg-tertiary)` / `var(--color-text-tertiary)` |
| U-17 | P2 | chrome 的圆按钮（9999px）里涟漪恒为 8px ⇒ 圆里一个方 | `micro-interactions.css:72-79` vs `chrome.css:164` | 涟漪 `border-radius: inherit` |
| U-18 | P2 | 顶栏 tooltip 300ms、卡片头走原生 title（≈1s，触屏没有） | `Tooltip.tsx:20` vs `TabGroup.tsx:968-1019` | 卡头 6 处 `title=` 换 `<Tooltip>` |
| U-19 | P2 | 卡头时间与默认会话名重复表达同一件事 | `TabGroup.tsx:891-893`；`sessionName.ts:10-13` | 随 U-06 一起改 |
| U-20 | P2 | 顶栏操作区 434px 比搜索框 428px 还宽 | `global.css:1400-1419` | U-01 落地后操作区降到 ~350px |
| U-21 | P2 | 行删除键 ≥768px 是 `opacity:0` 但仍可命中 | `global.css:851-867` | `md` 档加 `pointer-events-none`，触屏下另给出口 |
| U-22 | P2 | 筛选控件比整页还小一档（标签 12px / 输入 13px） | `SearchFilterPanel.tsx:82,96` 等 | 随 U-04 的字号上调一起走 |
| U-23 | P2 | 主题风格选择器用写死的蓝色焦点环 | `ThemeStyleSelector.tsx:336,399` | 去掉 `focus-visible:outline-none focus-visible:ring-blue-500`，用全局环 |
| U-24 | P2 | 6 套主题对「卡头是不是区块」判断不一致（3 套透明 3 套有色） | `global.css:722-726`；`legacy.css:253-261`；`creamy.css:194`；`prism.css:295`；`apple/chrome/claude.css` 各 `:150/154` | 新增 `--color-card-head-bg` token，6 套各给一值，删 legacy 的写死值 |
| U-25 | P2 | 「标签行底色由主题决定」分散在 3 个文件，已修过一次还会再犯 | `global.css:782-787`；`drag-drop.css`（后加载）；`creamy.css:283-295` | 底色收成 token，drag-drop.css 只管拖拽态 |
