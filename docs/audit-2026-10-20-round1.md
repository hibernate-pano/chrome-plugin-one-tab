# 主审自审：2026-10-20 第一轮（基线 v1.25.0）
<!-- doc-status:已闭环（审计记录） -->
>
> **文档状态：已闭环（审计记录）**
> 本轮发现的问题（A-1 … A-16）已在 v1.25.1 修复。本文保留作为**问题清单与推理过程**的留档，不是待办清单。


> 本轮由产品负责人（主审）亲自上手 + 5 路专家并行审计交叉验证。
> 与 2026-10-19 那轮（37 条已修）不重叠 —— 本轮只列**新发现**或**修复不彻底**的条目。
>
> 复现脚本（主审亲手写的，可重跑）：
> - `scripts/prod-inspect.mjs` —— 真实 popup 尺寸（400×600）下的几何与溢出
> - `scripts/prod-interact.mjs` —— 真的点一遍：折叠/重命名/恢复/点开/锁定/键盘/菜单
> - `scripts/prod-a11y.mjs` —— 焦点链、焦点环、WCAG 对比度扫描（6 个主题态）
>
> 基线：`pnpm test` 1953 pass / 0 fail；`pnpm build` 通过。

---

## 0. 主审自己的判断

这个产品**已经比大多数独立 Chrome 扩展成熟**：有单写者队列、有 LWW 合并语义、有数据安全防线、
有 1953 个测试、有变异验证、有诚实的文案纪律（敢写「删除即物理清除、不可恢复」）。
2026-10-19 那轮把「声明=行为」这条线拉平了。

但站在「我要拿得出手给人看」的位置上，**还有三处硬伤**：

1. **「恢复」这个核心动作没有任何成功反馈。** 会话从列表里消失、窗口打开了，用户看到的是
   「卡片不见了」。搜索页有 `showRestoreSuccess`，列表页没有 —— 同一产品两个界面两种行为。
2. **「点开单标签即消费」是零反馈的删除。** 点一下标题，标签行消失，网址打开了。
   用户没看到任何提示，无法区分「已打开」和「被删了」。
3. **锁定会话的语义是反的。** 「锁定防误删」听起来是保护，但实现上锁定后**整组删不掉**，
   而「删除所有会话」**无视锁定全删** —— 确认框还不提这件事。

---

## 1. 主审亲自确认的问题（都有实测证据）

### A-1 · P0 · 列表页整组恢复后零反馈 —— 同一产品两个界面两种行为

- **位置**：`src/components/tabs/TabGroup.tsx:218-282`（`consumeSession`）、
  对照 `src/components/search/SearchResultList.tsx:484`
- **证据**（`scripts/prod-interact.mjs` 场景 3 实测）：点「在新窗口恢复整个会话」后，
  磁盘会话数 3 → 2，列表里「购物车」消失，**屏幕上没有任何提示**。
  搜索页同一动作有 `showRestoreSuccess(matchingTabs.length)`。
- **为什么是问题**：恢复是本产品的**头号动作**。「我点的那一卡怎么没了？」
  是用户看到卡片凭空消失时的第一反应。搜索页有反馈、列表页没有 ⇒ 用户在两个界面
  得到不同的反馈，而**列表页才是主界面**。
- **建议修法**：`consumeSession` 成功后调 `showRestoreSuccess(组内标签数)`。
  文案要说明「已在同一窗口打开 N 个标签，该会话已从列表移除」。

### A-2 · P0 · 点开单个标签 = 零反馈的删除

- **位置**：`src/components/tabs/TabGroup.tsx:296-360`（`handleOpenTab`）
- **证据**（场景 4 实测）：点标签标题 → 磁盘上该会话标签数 3 → 2，
  **行消失、页面打开、零提示**。
- **为什么是问题**：这是一个**不可撤销的删除**（无回收站），却是产品里最高频的动作。
  用户点了标题，期望是「打开这个页面」，看到的是「这行没了」。
  文案上标签的 aria-label 是「打开标签页: ResNet」，但视觉上没有任何「已打开」的痕迹。
- **建议修法**：点开成功后给一个轻量反馈（toast 或行内短暂的「已打开」态）。
  注意与「消费」语义不矛盾：文案要说「已打开并从会话移除」。

### A-3 · P1 · 锁定会话**删不掉**，而「删除所有」**无视锁定全删**（且确认框不提）

- **位置**：`src/components/tabs/TabGroup.tsx:685`（`{!group.isLocked && <删除按钮>}`）、
  `src/components/tabs/TabGroup.tsx:774`（更多菜单同样条件）、
  `src/core/mutationOps.ts:177-189`（`applyDeleteAllGroups` 无条件清空）
- **证据**（场景 5 实测按钮清单）：
  - 锁定组按钮 = `["折叠会话","在新窗口恢复…","在当前窗口打开…","解锁会话"]` —— **没有删除**
  - 普通组按钮 = `[…,"重命名会话","锁定会话","删除会话",…]`
  - `applyDeleteAllGroups` 直接 `groups: []`，不看 `isLocked`
  - `deleteAllConfirmMessage`（`src/components/layout/deleteAllMessages.ts:46`）只说
    「将删除本地全部 N 个会话，删除后无法恢复」——**不提锁定会话**
- **为什么是问题**：
  1. 用户锁定的动机是「这个重要，别弄丢」⇒ 结果**永远删不掉**（要先解锁才能删）。
     锁定变成了「不可删除」而不是「防误删」。
  2. 更糟的是：「删除所有会话」**连锁定的一起删**，而锁定正是用户用来保护它们的手段。
     用户以为「锁定的那些是安全的」，实际它们是**第一个被清空**的。
  3. README:43 与 CHROMEWEBSTORE.md:31 都写着「锁定防误删」—— 承诺与行为相反。
- **建议修法**（两条一起改，缺一条还是错的）：
  1. 锁定会话**保留删除入口**（删除是显式动作，锁定只防「逐条删」和「拖走」），
     但删除锁定会话时确认框要更重（明写「该会话已锁定」）。
  2. 「删除所有会话」要么跳过锁定会话，要么在确认框里**点名**「其中包含 N 个已锁定的会话」。
     后者更诚实，且改动更小。

### A-4 · P1 · 保存成功通知**谎报数量**：被丢弃的固定标签从不被提起

- **位置**：`src/background/TabManager.ts:179-184`（成功通知）、
  `src/background/TabManager.ts:131-141`（丢弃计数只进日志）
- **证据**：`collectPinnedTabs` 默认 `false`（`src/utils/storage.ts:270`）⇒
  默认保存时**所有固定标签被丢弃**。`filterValidTabs` 滤掉它们，
  `safeGroup.tabs.length` 只数存下来的。通知只写「已将 N 个标签页保存为新会话」。
  丢弃数只进了 `logWarn`，用户看不到。
  对照：`saveCurrentTab` **有**明确提示（`:285`「设置中未开启『保存固定标签页』」），
  整窗保存**没有**。
- **为什么是问题**：用户 pin 了 3 个工作台，保存后收到「已将 12 个标签页保存为新会话」，
  而窗口里那 3 个 pin 的标签**既没保存、也没关闭** —— 它们去哪了？用户无从得知，
  而这类页面通常正是最重要的。
- **建议修法**：丢弃数 > 0 时，通知与 popup 的成功反馈都要说
  「已保存 12 个标签页；另有 3 个固定标签未保存（可在设置中开启）」。

### A-5 · P1 · 「固定标签页」筛选器在默认配置下**永远筛不出东西**

- **位置**：`src/components/search/SearchResultList.tsx:607-640`（筛选面板的 pinned 下拉）
- **证据**：`collectPinnedTabs` 默认 `false` ⇒ 存进会话的标签 `pinned` 恒为 `false`
  ⇒ 「仅固定」永远 0 结果，「排除固定」等价于「全部」。空搜索结果页的提示里还写着
  「可结合域名、保存时间和固定标签筛选」。
- **为什么是问题**：把一个**在默认配置下无效的过滤器**摆在用户面前，还鼓励用户去用。
- **建议修法**：默认配置下**隐藏**这个筛选项（读 `collectPinnedTabs` 决定是否显示），
  或在选项关闭时给它一个「需在设置中开启」的说明。

### A-6 · P1 · 页脚版本号在**全部 6 个主题态**下低于 WCAG AA

- **位置**：`src/components/app/MainApp.tsx:62`（`text-gray-600 dark:text-gray-400` 硬编码）
- **证据**（`scripts/prod-a11y.mjs` 实测对比度）：
  | 主题态 | 实测 | 需求 |
  |---|---|---|
  | legacy 浅色 | 2.43:1 | 4.5:1 |
  | legacy 深色 | 3.67:1 | 4.5:1 |
  | claude 浅色 | 2.59:1 | 4.5:1 |
  | creamy 浅色 | 2.45:1 | 4.5:1 |
  | apple 浅色 | 3.36:1 | 4.5:1 |
- **为什么是问题**：2026-10-19 的 C-8 说这条「本轮修」，但它只把**容器**换成了
  `theme-shell`，**文字色仍然是 Tailwind 硬编码的 `text-gray-600`** ——
  换主题不换色，contrast 一点没改善。**这是一条「修了但没修到根因」的条目。**
- **建议修法**：改用主题 token（`theme-text-muted`），并给 6 套主题各配
  一个实测 ≥ 4.5:1 的 `--color-text-muted` 值。

### A-7 · P2 · 设置页 5 处说明文字低于 AA

- **位置**：`src/options/OptionsPage.tsx`（WebDAV 说明段）
- **证据**（实测）：`text-gray-500` 11px 说明文字 **2.54:1**；橙色警告
  「口令没有找回入口…」**3.19:1**；「清除配置」按钮红字 **3.76:1**。
  其中「口令没有找回入口」是**安全警告** —— 恰恰是最该读得清的那句。
- **建议修法**：11px 的正文用 `theme-text-muted`（≥4.5:1）；
  警告用 `--color-warning` 系并实测取值。

### A-8 · P2 · 焦点环用硬编码近黑色，主题 token 是空的

- **位置**：`src/components/common/Tooltip.tsx` 无关；实际在 `src/styles/global.css` 的
  `theme-focus` / `:focus-visible` 规则
- **证据**（实测 computed style）：搜索框聚焦时
  `outline: rgb(17,24,39) none 1.5px`（近黑 `#111827`），
  `getPropertyValue('--color-focus-ring')` 返回 **空串** —— 这个 token 根本不存在。
  在 claude 深色（暖黑 `#191817`）主题上，近黑 focus 环几乎不可见。
- **建议修法**：新增 `--color-focus-ring` token（每主题实测 ≥3:1），
  `:focus-visible` 改读它。

### A-9 · P2 · 一批「有设置、无入口、无读取方」的死设置

- **证据**（逐个 grep 计数）：

  | 设置 | 引用数 | 状态 |
  |---|---|---|
  | `groupNameTemplate` | 4 | 只在 storage 默认值 + 上云映射里，**没有任何读取方** |
  | `showFavicons` | 5 | 同上，**UI 从不读它**（favicon 永远显示） |
  | `showTabCount` | 4 | 同上，**UI 从不读它**（计数永远显示） |
  | `allowDuplicateTabs` | 4 | 同上，**清理重复的判据不读它** |
  | `deleteStrategy` | 3 | 同上，**删除永远走「 everywhere」** |
  | `reorderMode` | 3 | 组级排序已下线，只剩字段 |
  | `syncStrategy` | 15 | 有读取方（SW 合并），但**设置页无入口**（2026-10-19 C-6 只删了那行假展示） |

- **为什么是问题**：设置页里存在的开关，用户拨了没反应；上云的设置里带着用户
  从没设过的字段（`group_name_template: 'Group %d'` 会随备份导出到别的设备）。
  这是**「选项页在骗用户」**的一类问题。
- **建议修法**：要么接上入口（`showFavicons` / `showTabCount` 成本最低、价值最直接），
  要么从设置与上云映射里删掉。**留着一个无效开关比没有这个开关更糟。**

### A-10 · P2 · `displayOrder` 存了但从不用于排序

- **证据**：`displayOrder` 在 `types/tab.ts:90` 定义、`versionHelper.ts:39` 赋值、
  webdav layout 往返，但**渲染排序用的是 `createdAt` 倒序**
  （`src/components/tabs/TabList.tsx:217-219`、`src/store/slices/tabSlice.ts:88-92`）。
- **为什么是问题**：不是功能缺失（组级拖拽已下线，是产品决定），而是**数据模型在骗人**：
  每次同步都在往返一个永远无效的字段。
- **建议修法**：组级排序既然已下线，`displayOrder` 就该从模型里退役（迁移到不写），
  或者反过来把它接上（用户手动排序是合理需求，见产品定位审计）。
- **处理结果（2026-10-20 专项处置）**：本条**已修**，处置方向是**退役**（不是补读取方）。
  理由与完整论证见 §4.3。

---

### A-11 · P1 · 搜索结果**没有虚拟化**，宽泛关键词下 DOM 爆炸、滚动掉帧

- **位置**：`src/components/search/SearchResultList.tsx:804-860`（`sessionResults.map` 全量渲染）
- **证据**（`scripts/prod-stress.mjs` 实测，400 会话 × 20 标签 = 8000 标签）：

  | 场景 | 搜索词 | 搜索响应 | 搜索态 DOM 节点 | 滚动最大帧间隔 |
  |---|---|---|---|---|
  | 50×20 | `watermark` | 375ms | 11511 | 12ms |
  | 150×25 | `watermark` | 401ms | 42561 | 27ms |
  | 150×25 | `https` | 729ms | 42561 | **46ms** |
  | 400×20 | `watermark` | 447ms | 91311 | 12ms |
  | 400×20 | `https` | **1250ms** | **91311** | **88ms（≈11fps）** |

- **为什么是问题**：**主列表**做了虚拟化（`lazyTabRows` + `useNearViewport`），
  **搜索结果完全没做**。而「找回会话」是本产品的核心动作，搜索是最高频路径。
  宽泛关键词（域名片段、协议名、项目代号）非常常见 ——
  一用就是 9 万个 DOM 节点、1.25 秒卡顿、滚动掉到 11fps。
  这正是「用了一年之后产品垮掉」的典型形态。
- **建议修法**：搜索结果复用主列表那套 `resolveRowWindow` 虚拟化；
  另加「结果过多时只渲染前 N 条 + 提示」的兜底。

### A-12 · P1 · 右键菜单**只在扩展图标上右键才出现**，且与商店文案矛盾

- **位置**：`src/service-worker.ts:125-145`（三处 `contexts: ['action']`）
- **证据**：三处 context menu 的 `contexts` 全是 `['action']` ⇒ 只在扩展图标上右键出现。
  商店文案 `CHROMEWEBSTORE.md:30` 写「右键菜单：不打开管理界面，也能保存当前标签页或窗口里的其他标签页」，
  `:102` 写「让用户不打开管理页也能保存」。
- **为什么是问题**：
  1. 在**网页标签页上右键**（用户最自然的位置，也是竞品 OneTab 的做法）完全没有 TapStack。
  2. 文案承诺「不打开管理页也能保存」，实际要**先把鼠标移到工具栏再右键扩展图标** ——
     差了一整个交互动作，与承诺不符。
  3. 顺带：`saveCurrentTab` 右键分支末尾调 `tabManager.openTabManager(true)` ——
     保存完**强制弹出并刷新管理页**，与「不打开管理界面」的承诺正面相反。
- **建议修法**：
  1. `contexts` 扩成 `['action', 'page', 'tab']`，并在 `page`/`tab` 上下文里
     只提供「保存当前标签并关闭」「保存此窗口其他标签并关闭」。
  2. 右键保存成功后**不强制打开管理页**（快捷键路径就不打开，入口之间应一致）。

### A-13 · P2 · 搜索结果徽章显示的是**会话数**，用户真正关心的是**标签数**

- **位置**：`src/components/search/SearchResultList.tsx:768`
- **证据**：徽章渲染 `{sessionResults.length}`（匹配会话数）。
  搜 "React" 命中 1 个会话里的 2 个标签 → 徽章显示「1」，
  而结果区里列了 2 行标签。用户会以为只有 1 条结果。
- **建议修法**：徽章显示标签数（`matchingTabs.length`），文案区分
  「N 个会话 · M 个标签」。

### A-14 · P2 · 引导第 2 步引用的按钮名与实际按钮文案不一致

- **位置**：`src/components/onboarding/OnboardingSteps.tsx:60`
- **证据**：写「关闭本引导后，点击顶部的"**保存会话**"按钮」，
  而实际按钮可见文字是 `saveAndCloseLabel = '保存并关闭'`
  （`src/components/layout/saveActionCopy.ts:27`）。
- **为什么是问题**：2026-10-19 的 I-3 建立了一条纪律 ——
  「可见文案 = `saveAndCloseLabel`，与空态 CTA **逐字同源**」。
  改顶栏时把引导**漏在了纪律之外**：同一个按钮，三个地方写了三个名字
  （顶栏「保存并关闭」/ 空态「保存并关闭」/ 引导「保存会话」）。
- **建议修法**：引导引用 `saveAndCloseLabel` 常量，不再手写字符串。

### A-15 · P2 · `unlimitedStorage` 是白申请的权限

- **位置**：`manifest.json` 的 `permissions` 数组
  （审计基线 v1.25.0 时为 `manifest.json:13` = `"unlimitedStorage"`；
  该权限已被移除 ⇒ 给行号会漂，故按字段名指位）
- **证据**：会话数据存 **IndexedDB**（`tabvaultpro` / `kv` store，见
  `src/storage-kv/indexedDbClient.ts`），**不受 `chrome.storage` 的 10MB 配额约束** ——
  Chrome 文档明确 `unlimitedStorage` 只放宽 `chrome.storage`。
  `chrome.storage.local` 里实际只放 supabase 登录 session 与几个 flag（体积 KB 级），
  `src/storage-kv/storageAdapter.ts:103-149` 里的 `chrome.storage.local` 读写全是**旧数据迁移**。
  全仓 `chrome.unlimitedStorage.*` 零命中。
- **为什么是问题**：① 商店审核会问「为什么需要无限存储」；② 用户安装时多一个权限条目；
  ③ 隐私页 `src/legal/privacy.html:66` 还在为它作解释。
- **建议修法**：从 manifest 移除 `unlimitedStorage`（或先确认是否有任何 `chrome.storage`
  路径会写入大数据量——目前没有）。同时更新隐私页与 `CHROMEWEBSTORE.md` 的权限说明。

> **处理结果（2026-10-20 专项处置，详见 §4.2）**：本条**已修**。
> `manifest.json` 已移除 `unlimitedStorage`；`src/legal/privacy.html` 与
> `CHROMEWEBSTORE.md` 的权限说明已同步。**但原建议里那句
> 「或先确认是否有任何 `chrome.storage` 路径会写入大数据量」是必要的** ——
> 核查发现**确实有**：`src/service-worker.ts` 的 `migrateStorageKeys()` 会把
> 会话数据写回 `chrome.storage.local`（历史键 `tabGroups` → 现行键 `tab_groups`
> 的改名），而它的 catch 是静默吞掉 ⇒ 那一次写入失败就是**用户看不到自己的会话**。
> 该写入已删除，改名下沉到 KV 层（`MIGRATION_KEY_RENAMES` + `planMigrationWrites`），
> 迁移失败改为**显式失败**（读抛错 / 写整条失败），不再降级成「用户一个会话都没有」。
> 回归测试：`tests/unlimitedStorageRemoval.test.ts`。

---

## 2. 待专家报告汇总

（本节在 5 路专家报告到齐后补全）

---

## 3. 专家报告汇总（5 路 + 竞品调研）

> 本节在 5 路专家与竞品调研到齐后补全。

### 3.0 ⚠️ 一条**推翻本轮审计前提**的发现

**`manifest.json` 没有 `default_popup`** ⇒ 管理页**不是浏览器弹窗**，而是一个
`chrome.tabs.create({url})` 打开的**完整标签页**（`src/background/TabManager.ts:64-78`）。
`src/popup/` 只是目录命名残留。

这一条推翻了本轮审计（以及 2026-10-19 那轮）的一个基础前提：

| 文档里的说法 | 实际情况 |
|---|---|
| `docs/expert-audit-2026-10-19.md:28`「Chrome 扩展 popup 的真实宽度是 400px，顶栏搜索框被压成 0px」（标 **P0**） | 管理页宽度由用户决定（通常 ≥800px）。那个 P0 针对的是**不存在的场景** |
| `docs/RELEASE-NOTES.md:23` 同一论断 | 同上 |
| `CHROMEWEBSTORE.md:177` 同一论断写进了**提交给审核方的文案** | 审核方点开看到的是一个标签页，「扩展弹窗」这个说法本身是错的 |
| `scripts/_a11y-probe-tmp.mjs:11` `POPUP = {width:400,height:600}` | 本轮的全部 400×600 测量都基于这个错误前提 |

**影响与处置**：
- 本轮 A-6/A-7（对比度）**结论仍成立** —— 那些是**真实读到的计算值**，
  与视口宽度无关（页脚版本号在所有主题下都 <4.5:1）。
- 但**优先级判断**需要重估：一个不存在场景的 P0 曾挤掉真实场景的问题
  （如「点图标 = 保存并关闭」这条核心入口的破坏性）。
- 真实使用宽度下的几何与溢出**需要重新测量**（未完成，列为待办）。
- `CHROMEWEBSTORE.md:177` 那一段是给审核方看的用户视角文案，
  里面写「扩展弹窗」既是噪声也是错误说法 —— **已删除**。

**这条的教训**：「审计文档里写了什么」不能替代「产品实际怎么运行」。
本轮之前的多轮审计都从文档继承前提，没人回去核对过 manifest。

### 3.1 架构与工程债审计（`src/` 内部）

最高价值的三条：

1. **P0-1 单写者队列无超时 + 全部闸门在内存**（`src/background/mutationQueue.ts:49-88`）：
   `pending` / `running` / `runningName` 都是模块级内存变量，**全文无 timeout / abort**。
   任一 job hang ⇒ 后续所有保存/删除/上传全部排队，用户看到「点了没反应」。
   项目自己在 `src/utils/supabase/client.ts:159` 写下过这个风险（网络路径缓解了，
   但队列自身仍无超时）。
   后果之二：SW 被回收 ⇒ 内存闸门归零 ⇒ AutoSync 与 alarm 各排一条整库下载。
   后果之三（最严重）：`unsyncedDeleteIds`（`src/utils/storage.ts:38`）是
   「删除意图」的**唯一**防线，而 v1.22.0 起删除是**物理删除、无回收站** ——
   SW 在「写失败」与「下一轮上传」之间被回收 ⇒ 删除意图彻底消失 ⇒
   云端活跃行把已删组**整组加回来**，而用户已被告知「已删除」。
2. **P0-2 MV3 SW 回收/复活恢复路径：测试覆盖率为零**：
   `grep -rn "from '@/service-worker'" src/ tests/` → **0 命中**。
   `onInstalled` / `onStartup` / `setupContextMenus` / `primeSyncBackend` /
   `runScheduledUpload` **从未被任何测试执行过**。
   而「回收后能否正确恢复」是 MV3 的**最高频场景**（用户每次关标签 30s 后就回收）。
   仓库里已有正确范式（`tests/_helpers/localStorageMigrationColdStart.ts` 用
   **真实子进程**模拟冷启动），只是没推广到 backgroundSync / syncEngine /
   mutationQueue / sync-backend。
3. **P1-3 `tests/docsAlignment.test.ts` 惩罚正确修复**：
   它硬编码了已过时的测试基线 `695`（2026-10-02 快照），真实基线是 1831。
   实测：把文档里的 `695` 改成 `1831`（一次完全正确的修正）→ **4 处断言失败**。
   这条守卫**主动阻止你把文档改对** —— 典型「测试保护现状而不是保护行为」。

另有 P1-5（三处印记裁决规则无人看守：平局归本地从未被断言、服务端平局迁移
没进真库测试清单、`compareStampsLoose` 零直接测试）、P1-8（43 个零引用导出）、
P2-6（`tests/lww-figure-model.test.mts` 逃过所有门禁 —— **是主审自己上一轮
留下的文件**，已改造成真守卫，见 §4）。

### 3.2 产品定位与竞品对标审计

**最尖锐的一条（A-1，P0）**：`manifest.json` 无 `default_popup` ⇒
点扩展图标 = `saveAllTabs()` + 关闭标签 + 才打开管理页
（`src/service-worker.ts:234-243`）。**用户想找上周存的会话，点图标却把
当前窗口的标签全关掉并存成一个新会话。** 这是「找回」这条核心路径上的
一个不可撤销的破坏性动作。
唯一「只打开不保存」的路径是右键图标选「打开标签管理器」—— 用户几乎不会知道的二级菜单项。

**它纠正了我对竞品的三个误判**（竞品调研 agent 实证）：
- OneTab **没有**自动保存（解包 CRX 确认 background.js 里无 `chrome.alarms`）
- OneTab **有** `duplicates: allow|reject` 选项与「Remove duplicates」菜单
- **OneTab Plus 已下架**（2025-01-28 移除），其 Edge 版被 Koi 标记为恶意

**商业化结论**：10 个竞品里**本地核心功能一律免费**，唯二的变现点是
(a) 跨设备同步（OneTab $39.99/yr、BelayTab $36/yr、Tabbox $59.99/yr）
(b) AI（Marqly $72/yr）。TapStack 目前把「同步」也免费送了 ——
推荐路径是 **WebDAV 永久免费 + Supabase 托管同步作为付费 Pro（$29–39/yr）**，
差异化打「开源 + 可自托管 + 无需账号」。

**它还纠正了我对「撤销删除」的判断**：竞品证据比我最初掌握的更硬 ——
**TheTab 的商店描述原文**：「Undo tab deletion instantly (feature OneTab
still doesn't have!)」；BelayTab 官网：「Deleting a session shows an Undo
link straight away」。这是**竞品主打卖点**，不是小功能。

### 3.3 撤销删除可行性调研（专项）

**结论：能做，代价是「中」（~7 天），核心逻辑比预期便宜。**

关键发现（全部一手验证）：
- **云端「取消删除标记」的通路早就存在** —— `src/utils/supabase/upload.ts:773`
  那行 `is_deleted = false` 的注释写着「本地认为活跃 → 把 Web 端已软删、
  本地仍活跃（**恢复/取消删除**）的组复位为活跃」。作者早就预留了这个语义。
  WebDAV 侧同理（活跃分片覆盖墓碑分片，`adapter.ts:442-447`）。
- **本地删除分两段，边界清晰**：第一段 `persist(r.groups)` 落盘（本地不可撤销），
  第二段 `pendingDeleteIds` → 下一次上传才广播云端（1.5s–30s）。
- **真正的技术风险只有一条**：撤销必须盖一个**严格大于云端墓碑**的 stamp，
  否则撤销会被 LWW 静默吞掉（实测 5 个场景，2 个会失效）。
  解法是复用 `markCloudGroupsAsDeleted` 已有的 `max(lamport, cloud+1)` 公式。
- **代价集中在两处**：① 约 14 个测试断言「物理消失」（语义对撞，需改成
  「撤销窗口结束后物理消失」，**不是删断言**）；② 四层法定承诺
  （隐私政策 / 商店 listing / README / 一条 `assert.match(en, /no undo/i)` 断言）。

**主审判断（本轮不实施，理由见 §5）**：竞品证据确实硬，但撤销要动的是
**删除语义**这条本仓最敏感的线 —— 它有 14 个回归测试和 4 层文档承诺围着。
在**本轮已修的诚实性缺口还没补完**（A-5/A-7/A-8/A-9/A-10/A-15）的情况下动它，
是拿「有趣的功能」换「地基稳固」。且它的收益是**降低误删**，
而本产品的误删面已经由「锁定 + 二次确认 + 强制确认数量」覆盖了一部分。

### 3.4 交互与可访问性审计

见 §4 的修复清单（A-6/A-7/A-8 已修）。

### 3.5 文案承诺一致性审计

见 §4（A-4/A-14 已修，A-12 已修）。

---

## 4. 本轮已修复项（含变异验证）

| 编号 | 修复 | 回归测试 | 变异验证 |
|---|---|---|---|
| A-1 | 列表页整组恢复零反馈 → 共享文案模块 `restoreFeedbackCopy.ts` | `tests/restoreFeedbackHonesty.test.ts`（10） | 3/3 抓住 |
| A-2 | 点开单标签零反馈 → 同上 | 同上 | 同上 |
| A-4 | 保存通知谎报数量（固定标签被丢弃从不被提起）→ 摘要回传 popup + 共享文案 `saveFeedbackCopy.ts` | `tests/saveDroppedPinnedDisclosure.test.ts`（13） | 3/3 抓住 |
| A-11 | 搜索结果无虚拟化（1250ms / 91311 DOM / 11fps）→ 截断 + 说清 | `tests/searchWindowing.test.ts`（17） | 4/4 抓住 |
| A-12 | 右键菜单只在图标上出现 → 扩到 page/tab 上下文 + 不强开管理页 + 按**浏览器能力**裁剪 tab 上下文 | `tests/contextMenuReachability.test.ts`（15）+ `tests/deadSettingsAndEntryPoints.test.ts`（29） | 5/5 抓住 |
| A-13 | 搜索徽章显示会话数 → 改标签数 | 同 A-11 | 同上 |
| A-14 | 引导手写「保存会话」→ 引用 `saveAndCloseLabel` | `tests/deadSettingsAndEntryPoints.test.ts`（29） | 2/2 抓住 |
| **A-5** | **「固定标签页」筛选器在默认配置下永远筛不出东西** → 设置关闭时整块不渲染 + 条件一并作废 + 空态提示不再无条件承诺 | `tests/pinnedFilterAvailability.test.ts` | 3/3 抓住 |
| **A-9** | **一批「有设置、无入口、无读取方」的死设置** → `showFavicons`/`showTabCount` 接上入口且真被读；`groupNameTemplate`/`allowDuplicateTabs`/`deleteStrategy`/`reorderMode`/`syncStrategy` 五处一起删掉（含上云漏斗 `toCloudSettings`） | `tests/deadSettingsAndEntryPoints.test.ts`（30）+ `tests/guards/deviceLevelSettingsNotSynced.test.ts` | 8/8 抓住 |
| **A-9+** | **42703 降级只覆盖一列** → 改成通用规则（认缺哪列剔哪列，可连剔多列）；`download.ts` 那句不准确的注释同步改正 | `tests/supabaseMissingColumnFallback.test.ts`（25） | 5/5 抓住 |
| **A-9++** | **23502 降级只认五个硬编码列名 + 子串匹配整段错误文本** → 改成通用规则（认出撞哪列就补哪列，补的是**我们确实知道**的值）；三份手抄的退役列清单合并成一份 | `tests/supabaseNotNullFallback.test.ts`（21） | 4/4 抓住 |
| **A-10** | **`displayOrder` 存着但从不被读来排序** → 从类型、迁移、WebDAV 编解码、内容指纹四处一起退役；两条后端的会话形状对齐 | `tests/guards/retiredDisplayOrder.test.ts`（11）+ `tests/webdavLayout.test.ts` + `tests/localStorageFreshness.test.ts` | 6/6 抓住（见 §4.3） |
| **新增** | **会话默认名从时间戳改为域名派生**（A-16，见下） | `tests/sessionName.test.ts`（12） | 3/3 抓住 |
| **修复** | `tests/lww-figure-model.test.mts` 逃过所有门禁（glob 不匹配 `.mts`，一旦提交 CI 立刻红）→ 改造成真守卫 | 见 §4.1 | — |

### 4.0 A-9（死设置）· 一批「有设置、无入口、无读取方」的字段

**处置原则**（用户定）：一个设置要么**接上入口且真的被读**，要么**从类型、
默认值、上云映射里一起删掉**。留着一个无效开关比没有这个开关更糟 ——
用户拨了没反应。

| 设置 | 处置 | 理由 |
|---|---|---|
| `showFavicons` | **接入口** | 成本最低、价值最直接。设置页「外观」小节加开关；会话标签行 + 搜索结果标签行按它决定画不画图标 |
| `showTabCount` | **接入口** | 同上。会话卡片徽章 + 搜索结果徽章 + 顶栏「N 标签」三处共用一个开关 |
| `groupNameTemplate` | **删** | 默认值是英文 `'Group %d'`，而真实命名走 `deriveSessionNameFromChromeTabs`（按内容/域名派生）—— 这个模板从未参与 |
| `allowDuplicateTabs` | **删** | 唯一可能的语义是「保存时去重」，而保存路径**不判重**（判重只发生在「清理重复」这个显式动作里）。接上入口就得改保存语义（把最贵的一个动作变成有损的），不在本轮范围 |
| `deleteStrategy` | **删** | 删除永远走「到处删」。要做「只删本地」等于新增一套删除语义（墓碑/离线队列），风险远大于收益 |
| `reorderMode` | **删** | 会话组级拖拽排序早已下线（提交 545f67d），只剩字段 |
| `syncStrategy` | **删** | **它没有任何读取方**：合并固定走组级 LWW（`mergeOpStamped`），`backgroundSync` 里只有注释提到它、代码从不读它。接上入口只会造出「又一个无效开关」 |

**删除时四处同步**（本轮已全部落地）：`src/types/tab.ts` 的 `UserSettings`、
`src/utils/storage.ts` 的 `DEFAULT_SETTINGS`、`src/utils/supabase/upload.ts`
的 `allowedFields`、`src/utils/supabase/download.ts` 的 `fieldMapping`。

**额外两处（不加就等于「删了等于没删」）**：

- `storage.setSettings` 是所有设置写入的唯一漏斗（本地开关 / 导入备份 /
  云端合并 / 下载回写全都经过它）。**不**在这里剔除，退役键会被云端合并
  「带回来」⇒ 又变成死设置。
- `storage.getSettings` 读路径也要剔除，并触发一次回写 —— 让存量用户
  本地存储里的旧键**自愈**掉。

**第三处（上云漏斗，本轮补上）**：`services/settingsSyncService.toCloudSettings`
是 Supabase 与 WebDAV **共用的**「上云那份设置」生成处。Supabase 侧有
`allowedFields` 白名单兜着，但 **WebDAV 侧是整份透传**（零字段过滤）——
不剔，用户的云盘 `settings.json` 里就会一直躺着这些早已不存在的设置。
本地那侧（`setSettings`）也剔 ⇒ 两端成对：旧云端文件里残留的退役键，
下载合并时同样被剔。

**第四处（42703 降级，从「单列特判」改成通用规则）**：`user_settings`
这张表是早期在 Dashboard 建的，仓库里**没有 CREATE TABLE**，它的列靠一份份
ALTER 迁移往上加（`theme_style` / `collect_pinned_tabs` /
`sync_interval_minutes` 各一条）。没跑迁移的库**缺那一列**，而 PostgREST 的
upsert 把整行一次发过去 ⇒ Postgres 抛 `42703 undefined_column` ⇒
**整条设置同步死掉**。

修复前只有 `collect_pinned_tabs` 一列有降级分支，其余缺列的库照样断 ——
而 `download.ts` 的注释还宣称「上传侧有 42703 降级（缺列则忽略该字段重试），
所以迁移前后都不阻塞同步」，**那句话对除那一列外的列不准确**（注释在骗人
比没有注释更糟）。

现在改成通用规则（`src/utils/supabase/missingColumn.ts`，纯逻辑 + 可测的
上传包装）：认出缺的是哪一列 → 剔掉 → 重试；**重试还报 42703 就再剔一列**
（Postgres 只报第一个缺列，同时缺两列时一次只剔一列会卡在第二列上）。
受保护列（`user_id` / `device_id` / `last_sync`）永不剔除 —— `user_id` 是
主键兼 upsert 的冲突键，剔了就不是 upsert 了。循环有界。

**顺带清掉的「注释在讲不存在的东西」**：`background/backgroundSync.ts` 里
两处注释声称「`syncStrategy` 决定合并策略」并引用了一个早已不存在的
`cloudOverwrite` 默认值。合并**固定**走组级 LWW，从来不由任何设置决定 ——
留着会让读代码的人以为「有个设置在决定合并方式」。注释与日志文案已改为
陈述真实机制（读失败 = 只能拿到代码默认值 = 替用户猜 ⇒ 中止本轮）。

**第五处（23502 降级，同样从「按名单特判」改成通用规则）**：
`user_settings` 里若有列是 **NOT NULL 且无默认值**，Postgres 在 upsert 的
**INSERT 阶段**就抛 `23502 not_null_violation` —— 哪怕这一行已存在、
最终走 `ON CONFLICT DO UPDATE` 分支，INSERT 阶段的检查先发生 ⇒
**整条设置同步死掉**。

而 A-9 恰恰**扩大**了它的暴露面：以前我们写那五列，写的是非 null 值；
现在**不写了** ⇒ 数据库那一列成了 null ⇒ 库上若是 NOT NULL 无默认 ⇒
必撞 23502。

修复前这里是一份**硬编码的五个列名名单**，用「错误文本里包含列名」判定
撞的是哪一列。两个问题：① **只认这几个列** —— 任何别的 NOT NULL 无默认列
（哪怕是我们自己写出去的活列）撞上时降级不命中 ⇒ 错误原样抛出 ⇒ 同步断掉；
② **子串匹配整段错误文本** —— Postgres 的 `details` 会列出整行
（`Failing row contains (...)`），按子串扫会挑中 details 里排第一的那个列名
⇒ **补错列**。

现在改成通用规则（`src/utils/supabase/notNullFallback.ts`，纯逻辑 + 可测的
上传包装）：从错误里**认出撞的是哪一列** → 用**我们确实知道**的那个值补齐
→ 重试；重试还报 23502 就再补一列（Postgres 一次只报一列撞规）。

**这里必须说清一件事：23502 与 42703 的载荷语义是相反的。**
42703 = 那列**在**载荷里但库里没有 ⇒ 把它**剔掉**；
23502 = 那列的值是 null ⇒ 那列**不在**载荷里（或显式为 null）⇒ 把它**补上**。
所以「按 payload 里出现的列名判定」对 42703 是对的、对 23502 是**反的** ——
撞规的列恰恰是**不在** payload 里的那个。

**不认识的列不猜**：我们只对**确实知道默认值**的列补值（活列取当前
`DEFAULT_SETTINGS`，退役列取它们的历史默认值）。对一个我们不认识的列瞎填
一个值，可能写进类型不对的列（text 列写 boolean）⇒ 换个姿势失败，还把
库里那一行改坏了。宁可失败，也不猜 —— 错误原样冒出去，交给人看。

**「三份手抄清单」合并成一份**。修复前，同一批退役列在三处各抄了一份，
且**没有编译期关联**：
`types/tab.ts` 的 `RETIRED_SETTING_KEYS`（驼峰）、
`upload.ts` 的 `RETIRED_COLUMN_FALLBACKS`（云端列名 + 默认值）、
`download.ts` 的 `retiredColumns`（云端列名）。
改一处忘另一处 ⇒ 要么把退役键又带上了云，要么把一个**还活着的**列当成
退役列静默跳过（设置悄悄丢一项）。现在统一到
`types/tab.ts` 的 `RETIRED_SETTING_KEYS` / `RETIRED_SETTING_COLUMN_DEFAULTS`
/ `RETIRED_SETTING_COLUMNS` + `settingKeyToColumn()`（驼峰→列名的转换
也只有一份定义）。这与本仓既有的 `tests/storageKvConvergence.test.ts`
守卫是同一类问题。

`DEVICE_LEVEL_SETTING_KEYS` 未动（2026-10-18 产品定稿）。

### 4.0.1 A-12 补充 · `'tab'` 上下文的两件事（真机实测校正过）

1. **类型滞后 ≠ 运行时不支持**。`@types/chrome@0.0.262` 的 `ContextType`
   枚举里**没有** `'tab'`，但 Chrome 运行时**有** —— Chrome 自己的参数
   校验错误把合法词表原样列了出来（含 `tab`）。所以要断言，但不能
   `as any`：本轮用**逐个转换**的 `toChromeContextType()`，只有 `'tab'`
   这一个字面量需要断言，其余每一个值都必须本来就是合法的 `ContextType`
   （拼错会编译期就红）。
2. **判据是「能力」不是「版本号」**。实测 `'tab'` 在 Chrome 44~146 的
   schema 里没有、150 起才有。版本号判断依赖「我核实过的那个数字」，
   那个数字会过期；所以改成**特性探测**（拿一个探测用的 id 试着注册一次
   带 `tab` 的菜单项，抛异常就是不支持），依赖的是浏览器自己的答案。

   ⚠️ 顺带纠正一个说法：老浏览器上 create 失败**只影响那一项**，
   不会让其他菜单项也注册不上。


### 4.1 A-16（新增，由产品定位审计引出）· P0 · 会话默认名只有时间戳

- **位置**：`src/domain/tabGroup/sessionName.ts`
- **证据**：`deriveSessionNameFromChromeTabs(tabs, now)` 的 `_tabs` 参数
  **带下划线前缀（明确未使用）**，直接返回 `标签组 9月12日 19:51`。
  `factory.ts:25` 的 `options.name ??` 从来没有调用方传过 `name`
  ⇒ **保存时无法命名**，只能事后点标题重命名。
- **为什么是问题**：产品的承诺是「保存 → **之后找回**」（README:26-28）。
  而「找回」这一步**没有任何产品级支撑**：攒到 20 个会话，列表就是一列时间戳，
  用户必须靠搜索框 —— 而搜索要能命中，前提是标题与 URL 还在。
  于是**唯一能证明「这是哪个工作现场」的信息（域名）从不出现在列表里**。
  竞品核实指向同一处：OneTab 2026-03 的 v2.13 新增了 folders/search，
  它的默认组名同样是时间戳 —— 这正是它用户抱怨「一堆叫 Saved 9/12 的组」的原因。
- **修法**：默认名取**出现次数最多的域名**（并列取最先出现的 ⇒ 结果稳定）；
  取不到域名时回落时间戳（保持既有行为）。
  加载中的标签用 `pendingUrl`（与 `factory` 的 `resolveStorableUrl` 同源）。
- **不做的事**：① 不在名字里带标签数（卡片右侧已有数量徽章，重复是噪声）；
  ② 不改存量会话的名字（数据是用户的，替他改名字比不改更糟）——
  README 已写明「更早版本保存的会话仍是时间戳命名，重命名一次即可」。

### 4.2 A-15（`unlimitedStorage`）的连带风险 —— **移除前必须先查的那件事**

主审原以为这是「直接删一行 manifest」。**事实核查后发现不是**：

- Chrome 官方文档确认：`unlimitedStorage` **只**放宽 `chrome.storage.local`
  的 10MB 配额，**不影响 IndexedDB**（会话数据在 IndexedDB，不受此限）。
  ⇒ 从「权限声明」角度看它确实是白申请的。
- **但** `src/service-worker.ts:40-57` 的 `migrateStorageKeys()` 会往
  `chrome.storage.local` 写一份 `tab_groups` —— 而
  `src/storage-kv/storageAdapter.ts` 的 `migrateFromChromeStorage()` 随后
  把它搬进 IndexedDB 并**删源键**。
  ⇒ 老用户（v1.21.x 时代数据在 chrome.storage.local）直升时，
  **那一次写入会撞 10MB 配额**；而 `migrateFromChromeStorage` 的 catch 是
  `logWarn` 后 `skip migration` ⇒ **配额错误会让整份迁移被跳过**，
  数据留在 chrome.storage.local 里没丢，但 IndexedDB 里没有 ⇒
  **用户看不到自己的会话**。
- 处置交给专项 agent：先判定 `migrateStorageKeys` 这次写入是否冗余
  （`MIGRATION_SCAN_KEYS` 是否已含 `STORAGE_KEYS.GROUPS`），再决定移除与否。
  **在查清之前不移除** —— 这是本轮唯一一条「看起来是小事、实际会伤老用户数据」的条目。

### 4.3 A-10（`displayOrder`）· 退役，不是补读取方

**处置方向：收敛掉，而不是给它补一个读取方。**

先说复核结论（写「什么输入 → 什么结果」的证据，不靠印象）：

| 输入 | 结果 |
|---|---|
| 任何会话列表（`TabList.tsx` / `tabSlice.loadGroups` / `tabSlice.saveGroup.fulfilled`） | 排序**只**看 `createdAt` 倒序；改 `updatedAt` / `version` / `lastOp` / `isLocked` / `name` 都不改变顺序 |
| 会话组级拖拽排序（`moveGroup` / `applyMoveGroup` / `updateDisplayOrder`） | **早已下线**（提交 545f67d）—— 连入口都没有 |
| Supabase 上行 / 下行 | **从不携带**该字段；`supabase/migrations/*.sql` 里**没有** `display_order` 列 |
| WebDAV 分片 | 修复前**写进去又读出来**（唯一的携带方） |

⇒ 缺陷成立：它是一个**存着但从不被读来排序**的死字段，而且让**两条后端的会话形状不一致**
（WebDAV 带、Supabase 不带）⇒ 同一份数据在两条路径上解出来不同 ⇒ 覆盖预览的
「内容指纹」一比就判「内容变了」⇒ **没变过的会话被报成「将更新」**。

**为什么是「退役」而不是「接上」**：要真正实现「用户手动拖动时更新顺序」，等于要引入
一整套排序语义 —— 拖到第几位、与其他设备如何合并、删除后如何重排、跨设备并发拖动谁赢 ——
那是**产品决策**（要产品负责人拍板），不在「修一个死字段」的范围里。而现在它连
「用户手动拖动」这个入口都没有，是纯粹的残骸。按本仓既有惯例（删除优于添加），
**先把残骸收干净**，真要做手动排序时按一套完整语义重新加，那时它会有真正的读取方。

**四处一起退役**（少一处就等于没退役）：

| 位置 | 处置 |
|---|---|
| `src/types/tab.ts` 的 `TabGroup` | 删掉 `displayOrder` 字段声明（`version` **保留** —— 它是真的在用） |
| `src/core/versionHelper.ts` 的 `initializeVersionFields` | 只填 `version`，不再填 `displayOrder` |
| `src/utils/migrationHelper.ts` 的 `migrateToV2` | 判据不再要求 `displayOrder`（只要求 `version`） |
| `src/sync-backend/webdav/layout.ts` 的 `encodeGroup` / `decodeGroup` | 分片不再写它、解码不再读它 ⇒ 两条后端形状对齐 |
| `src/utils/syncPreview.ts` 的内容指纹 | 不再把它算进「内容是否变化」⇒ 覆盖预览不再误报 |

**关于老用户存量数据**：本地存储里可能还留着 `displayOrder` 这个键。删掉类型字段后
**读老数据时它被忽略**（多余字段无害）—— 这没问题。**刻意不**写「启动时把老数据里的
`displayOrder` 清掉」的迁移：那是在给一个**没人读的字段**做无用功（还会给迁移逻辑
增加一条分支、一个失败点）。

**回归测试**（`tests/guards/retiredDisplayOrder.test.ts`，11 条）钉的是**不变量**，
不是字面量（「源码里不再出现这个词」会因为别人写一句解释性注释而误伤）：

1. 排序只由 `createdAt` 决定 —— 改任何别的字段都不许改变顺序；
2. 两条后端解出来的会话**键集合**一致（不再有一边多一个键）；
3. 迁移只补 `version`，不往会话里塞任何新字段；
4. 覆盖预览：只有退役字段不同的两份数据必须判为「未变化」；
5. `TabGroup` 接口的属性清单里没有那个字段 —— **用 TypeScript 编译器 API 解析 AST**
   （不是 grep 文本）。为什么不用类型断言了事：本仓测试跑在
   `--experimental-strip-types` 下，它**只剥类型语法、不做类型检查** ⇒ 纯类型断言
   在 `pnpm test` 里**永远不会变红**，只有 `pnpm type-check:tests` 才拦得住 ⇒
   光靠它，这个回归在 CI 的测试步骤里是**看不见**的。

**变异验证 6/6 抓住**（`cp` 备份 / `cp` 恢复，全程未用 `git stash`）：

| 变异点 | 变红 |
|---|---|
| `encodeGroup` 重新写该字段 | ✅ |
| `decodeGroup` 重新读该字段 | ✅ |
| `initializeVersionFields` 重新填该字段 | ✅ |
| 内容指纹重新含该字段 | ✅ |
| `migrateToV2` 判据重新要求该字段 | ✅ |
| `TabGroup` 类型重新声明该字段 | ✅（AST 守卫 + scoped `tsc` 双重） |

---
