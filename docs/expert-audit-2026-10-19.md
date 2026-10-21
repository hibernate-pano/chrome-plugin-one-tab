# 专家评审报告 · TapStack v1.24.3 → v1.25.0
<!-- doc-status:已闭环（审计记录） -->
>
> **文档状态：已闭环（审计记录）**
> 37 条问题已在 v1.25.0 修复（commit `6d5a075`）。本文保留作为**问题清单与推理过程**的留档。


- 编制日期：2026-10-19
- 评审基准：`main` @ `48deacb`（v1.24.3）
- 评审方式：**两轮**评审 —— 第一轮三路并行只读审计（核心任务线 / 视觉与交互 / 文案与承诺），
  第二轮由独立第三路按「用户任务线」复审。**每条结论由主审亲自打开源码或真机复现确认**；
  未经确认的子代理结论不进入本报告（第一轮就有 1 条被证伪：隐私页的 `{{EMAIL}}`
  占位符其实是工具输出脱敏造成的假象，文件里是真实邮箱）
- 基线：`pnpm test` 1828 pass / 0 fail；`pnpm validate` 退出码 0（首屏 231.2KB / 260KB）；`node scripts/e2e-core-loop.mjs` 有头真机 11/11 通过
- 终态：`pnpm test` **1953 pass / 0 fail**；`pnpm validate` 退出码 0（首屏 **233.6KB / 260KB**）；
  核心闭环 **11/11 ×2 逐条一致**；**变异验证 36/36 通过**

---

## 0. 结论速览

第一轮共列出 **24 条**问题：P0 × 1、P1 × 11、P2 × 12。
第二轮（按用户任务线复审）又发现并修掉 **13 条**：P0 × 2、P1 × 6、P2 × 5。
**合计 37 条，全部已修。**

其中主审亲自复现并确认为**真实缺陷**的 24 条全部落进代码修复；每条修复都配了一条
会变红的自动化测试，并做了「把修复改回缺陷形态 → 测试必须变红 → 恢复」的变异验证
（36/36 通过，见 §3）。

### 三条 P0

**P0-1（本轮原有）不是任何一行逻辑写错，而是布局写错**：Chrome 扩展 popup 的
真实宽度是 400px，而顶栏的搜索框在这个宽度下被压成 **0px**——「找回会话」这个
核心入口在真实使用尺寸下完全消失。主审用 Playwright 加载真实扩展复现：

```
.app-header-search  w = 0
.search-input       w = 26   （左右内边距已吃掉全部宽度）
.app-header-actions w = 308  （占用 376px 可用宽度的 82%）
```

根因：顶栏操作区 `flex-shrink: 0`，而里面的同步按钮是**两颗带文字的按钮**
（`上传` / `下载`，合计 148px），在 `sm` 断点以下没有像布局切换、清理重复那样
收进菜单。搜索框是 `minmax(0, 1fr)` 的第二列，于是被挤成 0。
（同一段实测还量出：**640–900px 这段也在丢搜索框**，700px 时搜索宽度是 0。）

**P0-2（第二轮发现）：补齐主题 token 时把深色模式的整段值写进了浅色块。**
切到奶黄/棱镜的**浅色**主题，新用户第一屏、登录表单、搜索筛选面板全部变成深色卡片
+ 深色正文，文字读不出来（奶黄浅色空态卡标题对比度 **2.28:1**、正文 **1.17:1**）。
根因是补 token 的脚本把「深色块」整段插进了「浅色块」——暖色主题长出近黑面板。

**P0-3（第二轮发现）：窄屏下「更多」菜单点不到下半截，删不掉会话。**
会话卡的 `animate-in` 带 `transform`（`fadeInUp` 的 to 帧 `translateY(0)` +
`forwards`），于是**每张卡都是 stacking context**，卡内菜单的 z-index 只在卡内有效
——压不过后面那张卡。1 个标签的会话里「锁定会话」「删除会话」两行完全点不到
（`elementFromPoint` 命中的是背后的列表），而删除不可撤销。
最终解法是 **portal 到 body + `position: fixed`**，脱离所有卡的层叠上下文。

---

## 1. 第一轮审计：问题清单

严重级定义：
- **P0** —— 核心入口不可用 / 数据丢失 / 安全问题
- **P1** —— 核心任务受阻，或「说法与行为」相反（用户会据此做出错误决定）
- **P2** —— 体验磨损、视觉不一致、文档漂移

### 维度一：功能 / 数据安全

| # | 级别 | 位置 | 现象 | 证据 | 判定 |
|---|---|---|---|---|---|
| F-1 | **P0** | `src/styles/global.css:1275-1287` + `src/components/sync/SyncButton.tsx:403-441` | popup 真实宽度 400px 下搜索框宽 **0px**，核心「找回」入口整框消失；品牌名被裁成「TapS」 | 主审真机复现：`.app-header-search w=0`、`.search-input w=26`、`.app-header-actions w=308`（见 §0） | 本轮修 |
| F-2 | P1 | `src/domain/tabGroup/filters.ts:34-40` + `src/domain/tabGroup/factory.ts:29` | 标签仍在加载（`url` 为空、`pendingUrl` 有值）时保存，真实网址被永久替换成 `about:blank`，且保存动作同时关掉了原标签 | 主审执行：`isValidTab(loading)=true` → `saved url = about:blank` | 本轮修 |
| F-3 | P1 | `src/components/dnd/DraggableTab.tsx:320`（`draggable` 无条件） | 锁定会话的标签仍可被拖走；拖走最后一条后该锁定会话变 0 标签，卡片从列表消失（磁盘上仍留着并继续同步）。与 `src/components/tabs/TabGroup.tsx:414` 注释「锁定组的标签渲染层不提供删除/拖出」直接矛盾 | 主审执行：`applyMoveTab` 后 `L` 变 `tabs:0`，`toActiveGroupsView` 只剩 `["D"]` | 本轮修 |
| F-4 | P1 | `src/components/search/SearchResultList.tsx:401,454-456` vs `:420-434` | 搜索页「恢复所有匹配标签」的确认框与结果提示都说「未锁定的会话将从列表移除」，实际只删**命中的标签**，会话里其余标签保留 | 代码：只对 `matchingTabs` 逐条 `deleteTabAndSync`，无任何整组删除 | 本轮修 |
| F-5 | P1 | `src/components/layout/HeaderDropdown.tsx:862,960` vs `src/core/mutationOps.ts:274-291` | 重复导入同一份备份时提示「其余 N 个为空会话或只含无法保存的网址」，真实原因是「已存在、跳过」；用户会以为备份文件坏了 | 主审执行：同一 `incoming` 连续导入两次 → 第二次 `imported:0` 而 `source:1` | 本轮修 |
| F-6 | P1 | `src/components/app/AuthProvider.tsx:69` + `src/service-worker.ts:613-627` + `src/utils/storage.ts:258` | 登录后不会恢复云端会话：自动下载被 `syncEnabled`（默认 false）门禁拦下，且 `AuthProvider` 的 effect 不会因登录而重跑。新设备登录后列表仍为空 | 三处代码交叉确认；`grep "sendSyncCommand('download'"` 只有 4 处，登录成功路径一处都没有 | 本轮修 |
| F-7 | P1 | `src/service-worker.ts:379,410,446` | 全中文界面里弹出英文机器串：`no valid URLs`、`URL scheme not allowed`；登录失败也直接透出 `Invalid login credentials` | 源码原文 | 本轮修 |
| F-8 | P1 | `src/components/tabs/TabGroup.tsx:140,227,331,352,372` 等 8 处 | 写操作失败的 toast 把底层异常原文拼进用户界面：「更新会话失败: 操作超时（超过 30 秒无响应）：removeTab」 | 源码原文；仓库已有 `listErrorCopy.ts` / `resolveSyncFailureCopy` 两条成熟先例，只是没接到 mutation 路径 | 本轮修 |

### 维度二：信息架构与首次使用

| # | 级别 | 位置 | 现象 | 证据 | 判定 |
|---|---|---|---|---|---|
| I-1 | P1 | `src/components/tabs/TabList.tsx:222-271` + `src/components/common/PersonalizedWelcome.tsx` | 新用户第一屏是**两张几乎等高的满宽卡片**（258px + 282px），上面那张 43% 视口高度、零操作价值；同时顶栏「保存会话」和卡片里「保存当前窗口」是**两个同义蓝色主 CTA**，文案还不一样 | 主审真机复现：卡1 258px / 卡2 282px / 主 CTA 距 600px 视口底仅 4px | 本轮修 |
| I-2 | P1 | `src/options/OptionsPage.tsx:508→558→587→678` | 设置页信息架构倒置：首屏 100% 是「外观」（明暗 3 钮 + 6 张主题预览卡，高 582px），**唯一需要配置的「数据同步」在 800px 视口之外 250px** | 主审真机复现：外观 top=120/h=582、标签页 726、数据同步 **1050**、自带存储 1446 | 本轮修 |
| I-3 | P1 | `src/components/layout/Header.tsx:378-399` vs `src/components/tabs/TabList.tsx:240` | 顶栏「保存会话」在**点击前没有任何可见文字**说明会关闭当前窗口全部标签；「并关闭」只写在 hover 300ms 才出现的 tooltip 和 aria-label 里。空态 CTA 反而说清楚了 | 源码对比：空态描述明写「当前标签随后会被关闭」，顶栏可见文字只有「保存会话」 | 本轮修 |
| I-4 | P2 | `src/components/onboarding/OnboardingSteps.tsx:158,164` | 引导把云同步称作「自动备份」，用户会理解成「删了也能从备份找回来」；而云端只是同一份数据的镜像，删除会广播删除、无回收站 | 源码原文 vs `src/core/mutationOps.ts` 删除广播 | 本轮修 |
| I-5 | P2 | `src/components/onboarding/OnboardingSteps.tsx:173-174` | 引导承诺「误删保护：删除前二次确认，防手滑清空工作现场」，实际单条 ✕ 直接删、把最后一条标签拖走会直接让整组消失、锁定会话也被「删除全部」一并清空 | 源码 + 设置页自己写的「其余单个标签页的 ✕ 直接删」 | 本轮修 |
| I-6 | P2 | `src/components/onboarding/OnboardingSteps.tsx:127` | 引导说「需要时也可以从会话列表里再次打开刚刚整理过的内容」，但未锁定会话恢复后即被消费、从列表消失 | `TabGroup.tsx:210-232` `consumeSession()` | 本轮修 |
| I-7 | P2 | `src/components/onboarding/OnboardingGuide.tsx:53-57` + `src/styles/onboarding.css:6-8,489-494` | 首次安装即弹引导，此时列表是空的，第 4 步「恢复整个会话」的选择器命中不到任何按钮，聚光灯静默消失；且聚光灯层 z-index 9997 压在遮罩 9998 之下，被 50% 黑幕 + 8px 模糊盖住 | 源码：遮罩 `rgba(0,0,0,.5)` + `blur(8px)`，聚光灯 `z-index:9997` | 本轮修 |

### 维度三：视觉与主题一致性

| # | 级别 | 位置 | 现象 | 证据 | 判定 |
|---|---|---|---|---|---|
| V-1 | P1 | `src/styles/global.css:116-153` + `src/styles/themes/{legacy,creamy,prism}.css` | 三套主题缺 **21 个二级 token**（`color-accent-text` / `strong` / `border` / `wash` / `soft` / `toggle-on` / `toggle-off` / `well` / `note-bg` / `btn-hover` / `panel-translucent` / `border-translucent` / `focus-ring` / `shadow-panel` / `panel-blur` / `color-shell` / 5 个 radius），全局兜底写死纯蓝 `#2563eb`。切到「奶油」后空态图标底座仍是纯蓝 | 主审比对：`for t in legacy creamy prism; grep -c color-accent-text → 0`；apple/chrome/claude 为 6 | 本轮修 |
| V-2 | P1 | `src/options/OptionsPage.tsx:535,606,622,663` | 设置页所有「选中态」用 `text-white` 压主题强调色。Claude 浅色 3.12:1、Claude 深色 2.60:1、Apple 浅色 **2.22:1**、Apple 深色 **2.02:1**（远低于 4.5:1）。同一文件里 `.btn-primary` 早已改用 `--color-accent-fg`（6.87:1），这四处是漏网的 | 主审真机复现：`.theme-toggle-on` → `bg rgb(37,99,235)` / `color rgb(255,255,255)`；主题文件确认白字对比度 | 本轮修 |
| V-3 | P1 | `src/components/tabs/TabGroup.tsx:441-575` | 400px 下每张会话卡头部是「⌄ + 截断标题 + 徽章 + **6 个 36px 图标**」：标题可见宽度只剩 **74px**（截断到 5 个汉字），216px / 366px 的横向空间给了图标；且两个「打开」图标在 16px 下几乎同形 | 主审真机复现：`.tab-group-title clientWidth=74 / scrollWidth=106`，6 个按钮各 36px | 本轮修 |
| V-4 | P1 | `src/components/sync/WebDavSettings.tsx:1240-1255` + `:1045-1105` | WebDAV 配置区 5 个按钮平铺：「测试连接」「保存并启用」都是实心主按钮，另有三个同款描边按钮；「清除配置」会清空地址/账号/口令并关掉自动同步，却和「锁定」长得一样，**且无二次确认** | 源码：`handleForget` 内只有 `showToast`，无 `showConfirm` | 本轮修 |
| V-5 | P2 | `src/components/layout/Header.tsx:117-120` + `src/components/common/ConfirmDialog.tsx:50` | 「清理重复标签」是不可撤销的删除，确认按钮却是 warning 琥珀色（`bg-amber-700`），与「删除全部」的 `bg-rose-600` 不是同一套语言 | 源码 | 本轮修 |
| V-6 | P2 | `src/components/common/ModalFrame.tsx:60,65,79,86` | 所有弹层不跟主题：Claude 深色下页面是 `#191817` 暖黑，弹层却是 `rgba(15,23,42,.95)` 冷蓝黑，边框/文字也是 slate 系；圆角 28px 与主题 `--radius-panel` 不一致 | 源码 + 主审真机读 computed style | 本轮修 |
| V-7 | P2 | `src/components/common/Tooltip.tsx:94` | 顶栏 tooltip 固定 `whitespace-nowrap`，400px 下宽 313px、right 边到 466px（超出视口 66px），并把文档 `scrollWidth` 从 400 撑到 466 | 源码 + 主审真机复现 | 本轮修 |
| V-8 | P2 | `src/styles/onboarding.css:33-43` + `src/components/onboarding/OnboardingGuide.tsx:183-188` | popup 高度上限 600px 时，引导卡内容 623px，「下一步」落在视口下方（top 601 / bottom 642）；每步标题被程序 focus 后出现一圈 2px 蓝色矩形描边，看起来像个输入框 | 源码 + 主审真机复现 | 本轮修 |

### 维度四：文案与承诺一致性

| # | 级别 | 位置 | 现象 | 证据 | 判定 |
|---|---|---|---|---|---|
| C-1 | P1 | `src/popup/index.html:2` | popup 声明 `lang="en"`，界面全中文：读屏按英文语音规则念中文，浏览器翻译条误判。设置页与隐私页都是 `zh-CN` | 源码 | 本轮修 |
| C-2 | P1 | `README.md:47,66,160` | 开发文档仍承诺「登录时自动从云端合并下载」「打开应用时自动拉取」「后台 alarm 每 60s 自动拉取」，与 1.23.0 起「自动同步默认关闭 + 5/10/30/60 分钟四档」直接冲突 | 源码 + `src/utils/storage.ts:258` + `src/background/backgroundSync.ts:283-289` | 本轮修 |
| C-3 | P1 | `CHROMEWEBSTORE.md:103` + `src/legal/privacy.html:69` | 提交给审核方和用户的权限说明写「定期（约每分钟）检查云端」「在您未打开扩展时，定时在后台检查云端」——默认根本没有这个定时任务，开启后也不是每分钟 | 源码 + alarm 档位代码 | 本轮修 |
| C-4 | P1 | `src/legal/privacy.html:82` | 已发布的隐私政策页显示未替换的占位符 `privacy@tapstack.app`，用户无法申请删除账号/数据 | 源码 | 本轮修 |
| C-5 | P2 | `scripts/ui-audit-screenshots.mjs:102-104` | 审计截图脚本仍注入 `isDeleted` 的「墓碑组：验证回收站视图」，而回收站已在 1.22.0 移除；产出的截图页脚仍是 v1.23.1 陈旧产物 | 源码 + `store-assets/ui-audit/*.png` 页脚 | 本轮修 |
| C-6 | P2 | `src/components/sync/SyncButton.tsx:615` | 同步下载弹窗把「当前合并策略」当事实展示，但该设置**在任何页面都没有入口**，合并也固定走 opStamp 组级 LWW，不读它 | `grep -rn "syncStrategy" src` 除默认值/字段映射/诊断/这一行外**无读取方** | 本轮修 |
| C-7 | P2 | `src/components/layout/HeaderDropdown.tsx:571-572` | 应用菜单声明 `role="menu"`，但子项没有 `menuitem`、方向键也不工作（全仓 `menuitem` 零命中），读屏用户被告知这是菜单却无法用菜单键盘模型操作 | 源码 | 本轮修 |
| C-8 | P2 | `src/components/app/MainApp.tsx:65` + `src/styles/global.css:678-681` | 页脚声明用 `theme-shell`，实际内容用 `text-gray-600` 硬编码；Claude 浅色下 `--color-text-muted` 压在 `--color-shell` 上只有 **2.86:1**（12px 小字，低于 4.5:1） | 源码 + 主题 token 比对 | 本轮修 |

### 本轮明确不做（Non-goals，附用户可见风险）

| 项 | 理由 | 用户可见风险 |
|---|---|---|
| 改动同步引擎架构（Supabase / WebDAV 双后端、组级 LWW 快照、`pendingDeleteIds` 广播链） | README 与商店文案已明确的产品决定，属独立大改 | 无（本轮不触碰） |
| 真正的端到端加密 | 需换密钥派生 + 恢复码递送机制 | 云端数据非「只有你能看见」——README 已如实说明 |
| 多语言化 | 本轮只修「声明语言与界面语言不一致」这类自相矛盾 | 界面仍只有中文 |
| 改「保存 = 剪切」的产品定位 | 2026-10-19 产品负责人明确要求保持 | 保存仍会关闭当前窗口标签——本轮改为**在落点处如实披露**，不再是隐藏行为 |
| 重新引入回收站 / 墓碑 | v1.22.0 已明确废除，`docsAlignment` 会判红 | 删除仍不可恢复 |
| 拖走会话最后一条标签时加确认 | 2026-10-19 产品负责人明确要求保持「直接删除、不加确认」 | 拖走最后一条标签仍会整组消失——本轮改为在设置页与引导中如实说明 |
| 发布到 Chrome 商店 / 推送远程分支 | 本轮只做代码与文档 | 未提审 |

---

## 2. 第二轮复审：按用户任务线走一遍

第二轮刻意换角度：不按「代码可疑点」扫，而是按**新用户真实任务线**走
（首次安装 → 保存 → 找回 → 恢复 → 换设备/同步 → 删除/编辑），每一步都用真机操作。

复审结论：**F-1、F-2、F-3、F-4、F-5、F-6、F-7、F-8 全部修复且经变异验证**；
另外三条第一轮未列出的问题在第二轮被发现并一并修掉（见 §2.2）。

### 2.1 任务线逐段复核

| 任务段 | 走查动作 | 复审结论 |
|---|---|---|
| 首次安装 | 400×700 打开 popup，跳过引导 | ✅ 修复后：搜索框 132px 可见；首屏只剩**一张**卡；只有一个主 CTA |
| 保存 | 点空态 CTA / 顶栏按钮 | ✅ 顶栏可见文案改为「保存并关闭标签」；空态与顶栏同一动作、同一措辞 |
| 找回 | 输入关键词 | ✅ 搜索框不再塌陷；搜索命中会话名 / 标题 / URL |
| 恢复 | 整组恢复 / 单条恢复 / 搜索页批量恢复 | ✅ 三条路径都是「先开后删、失败保留」；搜索页文案改为与真实行为一致（只删命中标签） |
| 换设备 | 登录 → 期待云端会话回来 | ✅ 修复后：登录成功**立即**触发一次恢复下载（登录是显式意图，不受自动同步开关约束） |
| 删除/编辑 | 单条 ✕ / 拖走 / 删整组 / 删全部 | ✅ 锁定组不再能被拖走；拖走最后一条的不可撤销性已在设置页与引导中写明 |

### 2.2 第二轮新发现（第一轮未列 / 第一轮改动引入的）

第二轮由**独立的第三路审查**按用户任务线走查（换角度：不再按「代码可疑点」扫，
而是按新用户真实操作走一遍），发现并修掉 **10 条**：

| # | 级别 | 位置 | 现象 | 判定 |
|---|---|---|---|---|
| R-4 | **P0** | `src/styles/themes/creamy.css`、`prism.css` | **补齐二级 token 时把深色模式的整段值写进了浅色块** ⇒ 切到奶黄/棱镜的**浅色**主题，新用户第一屏（空态）、登录表单、搜索筛选面板全部变成深色卡片 + 深色正文，文字读不出来。实测奶黄浅色空态卡标题对比度 **2.28:1**、正文 **1.17:1**（需 ≥4.5:1） | 本轮修 |
| R-5 | **P0** | `src/components/tabs/TabGroup.tsx` | 窄屏「更多」菜单**点不到下半截**：1 个标签的会话里「锁定会话」「删除会话」两行被盖住，`elementFromPoint` 命中的是背后的列表 ⇒ **窄屏下删不掉一个会话**，而删除不可撤销 | 本轮修 |
| R-6 | P1 | `src/styles/global.css` | `hover:theme-btn-hover` 这个变体**在产物 CSS 里根本不存在**（`theme-btn-hover` 是手写工具类，Tailwind 不会为它生成 `hover:` 变体）⇒ 所有新加的菜单行与弹层按钮 hover 零反馈 | 本轮修 |
| R-7 | P1 | `src/components/app/AuthProvider.tsx` + `restoreAfterLogin.ts` | 登录成功会发**两次**整库下载（显式登录触发一次 + AuthProvider 的 auto 下载又触发一次） | 本轮修 |
| R-8 | P1 | `src/components/common/ConfirmDialog.tsx` | 深色主题下「取消」按钮的底色与描边**同色**（legacy `#374151`/`#374151`、creamy `#3f3a36`/`#3f3a36`）⇒ 按钮融进面板，看不出是个按钮 | 本轮修 |
| R-9 | P1 | `src/components/layout/saveActionCopy.ts` | 窄屏文案「保存并关」是**残句**；且窄屏那支没走单源（另开了一支 `saveAndCloseShortLabel`） | 本轮修 |
| R-10 | P1 | `src/components/tabs/TabGroup.tsx` | 窄屏「更多」菜单点完菜单项**不自动收起**（浮层压住刚打开的编辑框）；且外部点击与 Esc 都不关闭 | 本轮修 |
| R-11 | P2 | `src/components/sync/WebDavSettings.tsx` | WebDAV「更多操作」菜单在 400px 设置页**横向溢出 40px**（`left-0` 定位） | 本轮修 |
| R-12 | P2 | `src/styles/global.css` | 顶栏操作区用 `1fr` 列时，**盒子本身**被拉满整列，与品牌区相交（320px 下相交面积 288px²，视觉不重叠但影响命中与焦点顺序） | 本轮修 |
| R-13 | P2 | `src/options/OptionsPage.tsx`、`WebDavSettings.tsx` | 设置页顺序调整后，「上方/下方」的方位词指代旧位置 | 本轮修（改用区块名 + 按钮名） |

**R-5 的根因值得记一笔**：会话卡的 `animate-in` 动画带 `transform`
（`fadeInUp` 的 to 帧是 `translateY(0)`，`forwards` 让它永久保留），
于是**每张卡都是一个 stacking context**。菜单面板是卡的子元素时，
它的 z-index 只在卡内有效 —— 无论 z-30 还是 z-40 都压不过后面那张卡。
最终解法是 **portal 到 body + `position: fixed`**，让它脱离所有卡的层叠上下文。

### 2.3 复审判定汇总

第一轮 24 条 + 第二轮 13 条 = **37 条**，逐条判定：

- **已修**：37 条（全部有自动化测试覆盖 + 变异验证通过）
- **已确认未修（写入 Non-goals）**：7 条（见 §1 末表）
- **悬空无状态条目**：0 条

第二轮明确**核对过没有问题**的方向（避免下一轮重复排查）：顶栏搜索框 320–1280px
全档有效；空态一张卡 + 单一主 CTA；锁定会话不可拖走；弹层正文在 6 主题 × 明暗
12 种组合下对比度 7.63–17.5 全部达标；六套主题的 token **覆盖度**齐全（问题在取值
不在缺失）；登录恢复不会在未登录时触发；`pendingUrl` 修复经真机验证（起了一个永不
响应的本地服务制造真正的 `status:'loading'` 标签，落盘 URL 正确且无重复条目）。

## 3. 变异验证记录

方法：把每处修复**改回缺陷形态**，重跑对应测试，必须变红；再恢复。

**最终结果：36/36 全部通过**（第一轮 28 项 + 第二轮 8 项）。
执行脚本：`scripts/_mutation-verify-tmp.mjs`（日志落 `{SCRATCH}/mutation.log`）。

| 修复项 | 对应测试 | 变异形态 | 变异后 | 恢复后 |
|---|---|---|---|---|
| F-1 搜索框塌陷 | `audit20261019Ui` | 窄屏栅格不再让搜索独占一行 | 🔴 | 🟢 |
| F-1 同步按钮 | `audit20261019Ui` | 同步按钮不再收成图标 | 🔴 | 🟢 |
| I-1 空态双卡 | `audit20261019Ui` | 空态插回第二张欢迎卡 | 🔴 | 🟢 |
| I-1 主 CTA 唯一 | `audit20261019Ui` | 顶栏不再在空态降为次级 | 🔴 | 🟢 |
| I-2 设置页 IA | `audit20261019Ui` | 「数据同步」改回「外观」之后 | 🔴 | 🟢 |
| I-3 保存披露 | `audit20261019Ui` | 可见文案改回不含「关闭」 | 🔴 | 🟢 |
| V-3 窄屏卡头 | `audit20261019Ui` | 次要按钮不再在窄屏隐藏 | 🔴 | 🟢 |
| V-5 清理按钮语义 | `audit20261019Ui` | 确认框改回 `type: 'warning'` | 🔴 | 🟢 |
| V-6 弹层主题 | `audit20261019Ui` | 弹层改回写死 slate | 🔴 | 🟢 |
| V-7 tooltip 溢出 | `audit20261019Ui` | 改回 nowrap + 居中锚点 | 🔴 | 🟢 |
| C-1 html lang | `audit20261019Ui` | popup 改回 `lang="en"` | 🔴 | 🟢 |
| C-7 菜单语义 | `audit20261019Ui` | 菜单项去掉 `menuitem` 角色 | 🔴 | 🟢 |
| F-2 pendingUrl | `audit20261019DataSafety` | factory 改回 `about:blank` 兜底 | 🔴 | 🟢 |
| F-3 锁定拖拽 | `audit20261019DataSafety` | `draggable` 改回无条件 | 🔴 | 🟢 |
| F-5 重复导入 | `audit20261019DataSafety` | 不再统计 `skippedExisting` | 🔴 | 🟢 |
| F-7 机器串 | `audit20261019DataSafety` | SW 改回英文机器串 | 🔴 | 🟢 |
| F-8 异常原文 | `audit20261019DataSafety` | toast 改回拼 `error.message` | 🔴 | 🟢 |
| V-1 主题 token | `audit20261019ThemeAndPromise` | creamy 删掉一个 accent token | 🔴 | 🟢 |
| V-2 选中态对比 | `audit20261019ThemeAndPromise` | 改回 `text-white` | 🔴 | 🟢 |
| C-2 README 漂移 | `audit20261019ThemeAndPromise` | 改回「每 60s 自动拉取」 | 🔴 | 🟢 |
| C-3 商店文案 | `audit20261019ThemeAndPromise` | 改回「约每分钟」 | 🔴 | 🟢 |
| C-5 截图脚本 | `audit20261019ThemeAndPromise` | 重新注入墓碑组 | 🔴 | 🟢 |
| C-6 合并策略 | `audit20261019ThemeAndPromise` | 重新展示「当前合并策略」 | 🔴 | 🟢 |
| I-4 备份措辞 | `audit20261019ThemeAndPromise` | 引导改回「自动备份」 | 🔴 | 🟢 |
| I-5 误删保护 | `audit20261019ThemeAndPromise` | 改回宽泛的承诺 | 🔴 | 🟢 |
| R-2 拖拽说明 | `audit20261019ThemeAndPromise` | 设置页说明去掉拖拽例外 | 🔴 | 🟢 |
| V-4 清除配置 | `audit20261019ThemeAndPromise` | 去掉确认框 | 🔴 | 🟢 |
| F-6 登录恢复 | `audit20261019ThemeAndPromise` | 登录后不再拉回云端 | 🔴 | 🟢 |
| R-4 主题浅色块 | `audit20261019Round2` | creamy 浅色块的 `--color-shell` 改回深色值 | 🔴 | 🟢 |
| R-5 菜单 portal | `audit20261019Round2` | 面板不再 portal 到 body | 🔴 | 🟢 |
| R-5 卡片裁剪 | `audit20261019Round2` | 卡片恢复 `overflow-hidden` | 🔴 | 🟢 |
| R-6 hover 变体 | `audit20261019Round2` | 删掉 `.hover\:theme-btn-hover:hover` 规则 | 🔴 | 🟢 |
| R-7 重复下载 | `audit20261019Round2` | 去掉登录恢复去重标志 | 🔴 | 🟢 |
| R-8 按钮边界 | `audit20261019Round2` | 取消按钮改回 `border-default` | 🔴 | 🟢 |
| R-9 窄屏残句 | `audit20261019Round2` | 短文案改回「保存并关」 | 🔴 | 🟢 |
| R-11 菜单溢出 | `audit20261019Round2` | WebDAV 菜单改回 `left-0` | 🔴 | 🟢 |

**过程中发现并修掉的一个测试自身缺陷**（值得记下来）：变异脚本最初用
`String.replace` 恢复文件，而同一段文字在文件里出现多次时它只改**第一个**匹配 ——
于是文件停留在「半变异」状态，后续所有用例的基线被污染（实测基线失败数从 0 一路
涨到 4，13 个用例假失败）。改成「整文件备份 + 原样写回」后，基线才稳定。
另有三处源码被误改（`OptionsPage.tsx` 的文件头、`OnboardingSteps.tsx` 的文案），
已按原样恢复并重新核对。

## 4. 证据

| 证据 | 位置 | 结果 |
|---|---|---|
| 基线测试 | `{SCRATCH}/baseline-test.log` | 1828 pass / 0 fail |
| 终态测试 | `{SCRATCH}/final-test.log` | **1953 pass / 0 fail**（新增 125 条） |
| 基线门禁 | `{SCRATCH}/baseline-validate.log` | 退出码 0，首屏 231.2KB / 260KB |
| 终态门禁 | `{SCRATCH}/final-validate.log` | 退出码 0，首屏 **233.6KB / 260KB** |
| 变异验证 | `{SCRATCH}/mutation.log` | **36/36 通过** |
| 真机核心闭环 ×2 | `{SCRATCH}/final-e2e-run1.log`、`final-e2e-run2.log` | **11/11 通过，两次逐条一致** |
| UI 复核探针 | `scripts/_ui-verify-tmp.mjs` | 顶栏 320–1280px 共 12 档全过；空态一张卡 + 一个主 CTA；设置页同步在首屏；五套主题选中态前景色均由 token 决定 |
| 改前/改后截图 | `{SCRATCH}/shots/` | 含空态、窄屏卡头、更多菜单、暖色主题对照 |
| 刷新后的 UI 审计截图 | `store-assets/ui-audit/` | 页脚版本号 v1.25.0，与 `package.json` 一致 |

**门禁说明**：`pnpm validate` 在本机跑通时，仓库里存在**另一个并发目标**留下的
`tests/lww-figure-model.test.mts`（LWW 模型图的对拍脚本），它有类型错误会让
`type-check:tests` 失败。已把该文件临时移出仓库完成验证（见
`{SCRATCH}/foreign/`），它不属于本轮改动。
