# TapStack 产品总监审计报告

> 日期：2026-10-22
> 范围：**只读产品审计**（未改任何代码）。视角 = 产品总监：产品本身缺什么、哪个流程断了、哪个决策是错的。
> 不含代码风格问题（那是别的 lane 的事）。
> 事实分级标注：**【代码事实】**= 可复现的代码/文档事实；**【判断】**= 我的产品判断；**【需拍板】**= 必须由你决定。
> 竞品事实一律引自仓库内已记录的调研，并注明「可能已过期」。

---

## 0. 门禁实测表（本机真实执行，非引用文档）

| 命令 | 结果 |
|---|---|
| `env -u NODE_OPTIONS node --test --import ./tests/_register-loader.mjs --experimental-strip-types "tests/**/*.test.ts"` | **tests 2939 / suites 750 / pass 2939 / fail 0 / skipped 0 / todo 0 / 61.9s** |
| `find src \( -name "*.ts" -o -name "*.tsx" \) -print0 \| xargs -0 wc -l` | **46,154 行 / 195 个源文件** |
| `find tests -name "*.test.ts" \| wc -l` | **223 个测试文件** |
| `git tag` + `git ls-remote --tags origin` | 最新 tag = **v1.24.3**（本地与远端一致，**v1.25.x 不存在**） |
| 版本号五处 | `package.json:3` / `manifest.json:4` / `.env.example:10` / `README.md:3` / `CHROMEWEBSTORE.md:362` 均 = **1.25.1** |
| `grep -o '"version"' dist/manifest.json` + `find src -newer dist/manifest.json` | dist = 1.25.1，无更新文件 ⇒ 构建产物不是旧的 |

**结论先行**：这东西现在像**一个功能齐备但契约没签完的半成品**。数据安全、文档诚实度、a11y 都已到位（别再往这些地方投钱），缺的是**产品模型层的契约**与**商业模式**。

三句话：

1. **核心动作是破坏性的、不可撤销的、零确认零反馈。** 点扩展图标 = 无确认关掉当前窗口全部标签；点「恢复」= 永久消费整个会话（无回收站、无撤销、无确认）。**最常做的破坏性动作零摩擦，最少做的破坏性动作有确认 —— 摩擦力分配反了。**
2. **它是纯中文产品，却用中英双语上商店。** 英文读者读完 listing 会装上一个装不了的扩展。
3. **它免费送掉了竞品收费 $36–60/年的那块。** 10 个竞品调研的结论已写在自家审计文档里：本地核心功能都免费，只有跨设备同步（OneTab $39.99/yr、BelayTab $36/yr、Tabbox $59.99/yr）能收钱。TapStack 的两个后端代码都已写好，付费墙只差一道门。

---

## 1. P0 结论（4 条）

### P0-1 · 点扩展图标 = 无确认销毁当前窗口；上一轮审计已定 P0，至今未修

**【代码事实】**

- `src/service-worker.ts:408-418` — `chrome.action.onClicked` → `showNotification('正在保存当前窗口为会话...')` → `tabManager.saveAllTabs(tabs)` → `tabManager.openTabManager(true)`。**全程没有任何确认环节。**
- `src/background/TabManager.ts:222-236` — 保存落盘后无条件 `chrome.tabs.create({url:'chrome://newtab'})` + `chrome.tabs.remove(tabIdsToClose)`。
- `src/types/tab.ts:247-296` — `UserSettings` 里**没有任何开关能关闭「保存即关闭」**（唯一相关项 `collectPinnedTabs` 只影响固定标签页）。
- `manifest.json:28` — 唯一披露是 `default_title`：「TapStack - 保存当前窗口并关闭这些标签」，hover 才看得到。
- **已识别未修**：`docs/audit-2026-10-20-round1.md:342-347` 已把它标为 P0（原文：「用户想找上周存的会话，点图标却把当前窗口的标签全关掉并存成一个新会话」），但它**不在该文档 §4 的修复表里**，代码至今原样。

**【判断】** 这不是「细节没打磨」，这是**产品契约的第一句话**。用户装扩展、点一次图标、当前窗口消失 —— 这个第一印象在 3 秒内决定他卸不卸。OneTab 之所以能做这个动作而不劝退人，是因为用户**已有 OneTab 使用习惯**；TapStack 的新用户没有任何前置契约。

**【需拍板】** 首次体验怎么改（见第 6 节拍板项 2）。

---

### P0-2 · 首次体验的顺序倒了：破坏性动作发生在解释之前

**【代码事实】** 执行顺序硬编码：

1. `src/service-worker.ts:411-412` 先 `saveAllTabs`（关标签）
2. `src/service-worker.ts:413` 再 `openTabManager(true)`（打开管理页）
3. `src/components/app/MainApp.tsx:30-36` 管理页 mount 之后才 `shouldShowOnboarding()`
4. `src/components/onboarding/OnboardingSteps.tsx:62-64` 引导第 2 步确实写了「**这些标签随之关闭**」—— 但那是**保存已经发生之后**

引导内容本身是对的（`OnboardingSteps.tsx:62` 用的是与顶栏按钮同源的 `saveAndCloseLabel` 常量，措辞纪律很好）。问题纯粹是**它在错误的时刻出现**。

**【用户会遇到什么】** 新用户装完 → 点图标 → 标签全没了 → 然后才看到一个弹窗告诉他「标签会关闭」。他刚经历了一次未授权的破坏，通知里那句话是在事后补的。

**【后果】** ① 用户的第一印象是「这扩展会吃掉我的标签」，而不是「这东西能把窗口收干净」；② 引导的**说服力被反噬** —— 用来解释的说明，出现在后果之后，作用从「告知」变成「找补」；③ 这也是 P1-2（商店文案不说关闭）在产品内的同构问题：**契约被藏在了错误的层级**。

**【判断】** 正确顺序应是：先读到「保存 = 剪切」的契约 → 再自己决定要不要执行。现在是：先被执行 → 再被告知。

---

### P0-3 · 首次点击零反馈：成功被吞、失败有声

**【代码事实】**

- `src/utils/storage.ts:282` — `showNotifications: false`（默认关）。
- `src/background/TabManager.ts:544-547` — `showNotification` 对任何非 `'error'` 的通知 `if (settings.showNotifications !== true) return;`。
- `src/service-worker.ts:410` — 「正在保存当前窗口为会话...」走 `showNotification(msg)`，默认 `kind='success'`（`service-worker.ts:128-131`）⇒ **被默认开关吞掉**。
- `src/background/TabManager.ts:203-211` — 保存成功的通知也是 success ⇒ **同样被吞**。
- `src/background/TabManager.ts:173-178` — 失败通知是 `'error'` ⇒ **永远发**。
- `src/components/layout/Header.tsx:302-307` — 按钮的 inline 反馈是 React state；图标点击走 SW、页面是新开的 ⇒ `saveFeedback` 恒为 `null` ⇒ **也没有 inline 反馈**。

**【用户会遇到什么】** 点完图标，标签消失了，**屏幕上没有任何一句话告诉他「保存了 12 个」**。唯一的线索是列表里多了一张卡片 —— 而新用户还不知道那列表是什么。

**【后果】**

- 违反项目自己的原则「用户按了键没反应必须有一句话解释」（`_shared.md` 第五节）—— 这里是它的镜像：**键按了，世界变了，一句话没有**。
- 净效果是**失败有声、成功无声**。这条原则在 `Header.tsx:218-265` 的按钮路径上守住了，在 SW 的图标路径上没守住 —— 同一个动作，两条路径，两种诚实度。
- 叠加 P0-1：新用户最需要确定性的一次交互，恰恰是唯一没有确定性反馈的一次。

---

### P0-4 · 「恢复」永久消费会话，零确认零撤销；而「删除」有确认 —— 摩擦力分配反了

**【代码事实】**

- `src/components/tabs/TabGroup.tsx:250-309` — `openAllTabs` → `consumeSession()` → 未锁定时 `dispatch(deleteGroup(group.id))`（物理删除）。**该函数里没有 `showConfirm`。**
- 同文件里删除有确认：`TabGroup.tsx:226`、`:490`；`deleteGroupRequiresConfirm({isLocked, confirmBeforeDelete})` 在 `TabGroup.tsx:209`。**同一组件里，破坏性更小的那条路有摩擦，破坏性更大的那条路没有。**
- 无回收站：`README.md:7`；`.codex/agents/_shared.md` 第四节第 4 条（v1.22.0 起删除即物理清除）。
- 全仓无用户可见的撤销入口：grep `撤销|undo` 只命中代码注释里的「删除广播被撤销」（同步语义）。
- 唯一逃生口是「锁」，但它是隐藏机制：`src/components/tabs/lockedDeleteCopy.ts:5-20` 说得很清楚 —— 锁的真实语义是「防误删 + **可反复恢复（不消费）** + 不可拖走」，而 UI 上只写「锁定防误删」。

**【用户会遇到什么】** 用户存了 3 个会话（研究、编码、购物）。第二天回来：
① 点「恢复整组」→ 标签在新窗口打开了，**原来那张卡片从列表里消失了** —— 没有确认、没有提示、没有撤销。他想再看一眼刚才那组里有哪几个链接，已经找不回来了。
② 误点错一张卡片 → 整组被消费掉，不可恢复。

**【后果】**

- 产品的每一次「前进」都是**单程票**。而「保存 = 剪切」这个模型本身就把用户推向不可逆。
- **这不是小功能缺失，是竞品主打卖点。** 仓库内已记录的调研（`docs/audit-2026-10-20-round1.md:360-363`）：TheTab 商店文案「Undo tab deletion instantly (feature OneTab still doesn't have!)」；BelayTab「Deleting a session shows an Undo link straight away」；原文结论「这是**竞品主打卖点**，不是小功能」。
- **已被显式推迟，但理由已过期**：`docs/audit-2026-10-20-round1.md:383-387` 记「本轮不实施」，理由「拿有趣的功能换地基稳固」，成本估「中（~7 天）」。而地基现在是稳的（两轮真机审计收口 + 2939 测试全绿 + v1.25.1 已提审）。`docs/audit-2026-10-20-round2.md:211-225` 留了 V2 设计（本地墓碑 + 云端 `is_deleted=false` 反向盖章，30 天窗口，并注明「撤销窗口结束后物理消失」要改**四处**文档承诺）。

---

## 2. P1 结论（10 条）

### P1-1 · 六处版本号同步断了：git tag 停在 v1.24.3

**【代码事实】** 五处 = 1.25.1（`package.json:3` / `manifest.json:4` / `.env.example:10` / `README.md:3` / `CHROMEWEBSTORE.md:362`）。**第六处（git tag）不存在** —— 本地与 `git ls-remote --tags origin` 一致，最新 tag 是 v1.24.3。

**这不是新问题**：`tests/releaseNotes.test.ts:1-8` 的文件头自己写着「历史上已经出现过『版本号升了、文档没记』的情况：v1.22.9 提审后迟迟没打 tag，直到 1.22.10 发版才补上」—— **同一个坑复发**。`.codex/agents/_shared.md:158` 规定「bump version → commit → 打**新** tag → push」。

**没有任何守卫**：`scripts/validate-extension.mjs:26,61,109` 只比 package.json ↔ manifest.json ↔ .env.example ↔ 文档，**都不碰 git tag**。

**后果**：线上/仓库版本对不上时，没有第二个真相源可查 —— 而「仓库版本 ≠ 线上版本」已是本项目反复吃过的亏。

**建议**：补 `v1.25.0` / `v1.25.1` 两个 tag（**绝不移动已存在的 tag**），并让 `validate-extension.mjs` 加一条「HEAD 的版本号必须已有一个 tag」（本地跑）。

---

### P1-2 · 商店文案的首屏两句话都不说「标签会被关掉」

**【代码事实】**

- `CHROMEWEBSTORE.md:28` Short Description：「保存、命名和恢复浏览器标签会话，跨设备同步找回。Save, restore & sync your tab sessions.」—— **无「关闭」**。
- `CHROMEWEBSTORE.md:33` Detailed Description 首句：「TapStack 把你当前浏览器窗口里的所有标签页保存为一个会话，随时找回、随时恢复，不让标签页堆积成灾难。」—— **无「关闭」**，且用了「保存」这个最容易引发「备份」联想的词。
- 「关闭」首次出现在第 1 条 feature bullet（`CHROMEWEBSTORE.md:36`），但**首屏（标题 + 一句话 + 首句）三处全都没有**。
- **守卫有洞**：`tests/docsAlignment.test.ts:862-882`（C-03）只断言 `· 一键保存：` 那一行，**Short Description 与首句完全不在覆盖范围内**。

**后果**：审核员读首屏看不到、下载者读首屏看不到 —— 装完第一次点图标才发现（回到 P0-1）。第 1 条 bullet 里的「关闭」对**已经在读第 9 行的人**有效，对**只读首屏的人**无效。

---

### P1-3 · 产品是纯中文界面，商店文案却中英双语 ⇒ 对一半读者是虚假承诺

**【代码事实】**

- 全仓**无任何 i18n 基础设施**：无 `src/i18n`、无 `public/_locales/`、`manifest.json` 无 `default_locale`。
- 全部 UI 字符串硬编码中文：`Header.tsx:406` placeholder「搜索会话或标签...」、`Header.tsx:816` 「登录 / 注册」、`HeaderDropdown.tsx:854-1216`「清理重复标签 / 设置… / 导出数据 / 诊断信息 / 导入数据 / 问题反馈 / 使用引导 / 退出登录」、`TabList.tsx:274`「早上好，先保存一个工作会话」。
- `CHROMEWEBSTORE.md:28, 54-69` 是中英双语；`:83` Primary Language 写「中文（简体）」。

**后果**：英文用户读完全英文的 listing、按下安装、点开扩展 —— 全是「保存并关闭 / 登录 / 注册 / 设置」。他没得到承诺过的产品。这是**漏斗前段的纯漏损**，也是差评与低评分的种子。

---

### P1-4 · README 的「锁定」描述比商店文案少两项，且这两项都会咬人

**【代码事实】**

- `README.md:43`：「锁定防误删（锁定后不可重命名、不可逐条删除其中的标签、不参与「清理重复标签」；仍可删除整个会话，但会先明确提示「该会话已锁定」）…」
- `CHROMEWEBSTORE.md:39`（商店版，多两项）：「…**不可把标签拖到别的会话**、不参与清理重复；仍可删除整个会话，只是会先提示「该会话已锁定」，而且这一步**一定**要确认」
- `CHROMEWEBSTORE.md:42` 另写明「**锁定的会话一定确认**，不受该开关影响」。
- 代码确实实现了：`src/store/slices/tabSlice.ts:550`（锁定组不因拖空而消失）、`TabGroup.tsx:289`（锁定组恢复不消费）、`TabGroup.tsx:209`（锁定组删除强制确认）。
- **`tests/docsAlignment.test.ts` 没有任何断言覆盖 `README.md:43` 这一行。**

**后果**：README 是 GitHub 上给潜在用户与贡献者看的第一份文档，它对「锁」的能力描述比商店文案少两项 —— 而「不可拖走」正是锁最容易被撞到的边界。

---

### P1-5 · `README.md:54` 的设置入口是一个死指针

**【代码事实】** `README.md:54`：「**两种后端可选**（设置菜单 →「数据同步到哪里」）」。全仓 grep「数据同步到哪里」**只命中 README 自身**，`src/` 下无此字符串。实际存在的名字是：菜单项「设置…」（`HeaderDropdown.tsx:876`）、设置页段落「数据同步」（`OptionsPage.tsx:776`）与「同步方式」（`OptionsPage.tsx:881`）。而且设置页是**独立标签页**（`manifest.json:30-33` `options_ui.open_in_tab: true`），不是「设置菜单」。

**后果**：用户按 README 指引找不到「数据同步到哪里」—— 而这是理解两种后端差异的唯一入口。与本仓已记录过的事故同构（设置页是独立标签页 ⇒ 指向「菜单」的文案是死指针）。

---

### P1-6 · 商店文案没有提任何「好看」的东西，而这是它唯一的差异化

**【代码事实】** `README.md:46`：「6 套主题风格（legacy / creamy / prism / apple / chrome / claude）+ 暗色模式，单 / 双栏布局」。代码侧齐全：`src/styles/themes/` 下 6 个 CSS 文件、`ThemeStyleSelector.tsx` 渲染 6 套、守卫 `tests/docsAlignment.test.ts:396-407` 钉住 README 的套数与实际选项一致。**但 `CHROMEWEBSTORE.md` 的 Detailed Description 里「主题」「布局」「双栏」一次都没出现**（全文只在数据使用表 `:165` 与版本历史里出现「主题风格」）。

**后果**：商店首图（`store-assets/screenshot-1-main.png`）里那套干净界面就是 6 套主题之一，但它在文案里没有任何位置。跨设备同步是所有竞品都有的；主题不是。**差异化没进 listing = 白做。**

---

### P1-7 · 商业模式：TapStack 现在免费送掉的，正是竞品收费 $36–60/年的那块

**【代码事实 / 仓库内已记录的调研】** `docs/audit-2026-10-20-round1.md:354-358`：10 个竞品调研的结论 —— **本地核心功能全部免费**，只有两个变现口：① **跨设备同步**（OneTab **$39.99/yr**、BelayTab **$36/yr**、Tabbox **$59.99/yr**）；② AI（Marqly $72/yr）。该文档给出的 TapStack 建议路径原文：「**WebDAV 永久免费 + 托管 Supabase 同步作为付费 Pro（$29–39/yr）**，差异点是『开源 + 可自托管 + 无需账号』」。

**【代码事实】** 付费墙所需的两个后端**都已经写好了**：`src/sync-backend/webdav/`（含口令加密、manifest 协议、凭据不上盘）与 `src/utils/supabase/`。现在两者都免费，`README.md:56-62` 与 `CHROMEWEBSTORE.md:45-46` 均无任何付费提示。

**判断**：在一个已经把工程纪律做到这个程度的仓库里，继续白送是最大的机会成本。**但前提是先修 P0**（理由见拍板项 3）。

---

### P1-8 · 商店版本历史表与文件头自相矛盾（1.24.1 到底发没发）

**【代码事实】**

- `CHROMEWEBSTORE.md:5`：「线上已发布 = **1.24.1**」
- `CHROMEWEBSTORE.md:7-8`：「1.25.0 与 1.25.1 此前从未提审（提交前草稿 `crxVersion` 就是 1.24.1）」
- `CHROMEWEBSTORE.md:388` 版本历史表 1.24.1 行的状态列写「**未提审**」
- 守卫 `tests/guards/storeChangelogStructure.test.ts:174-187` 只检查「状态列非空」与「四格」，**不校验状态与现实是否一致**。

**后果**：该文件在 `:16` 自称「Chrome Web Store 上架信息的**单一事实来源**」，却与自己矛盾。下一个人（人或 agent）据此判断线上版本会判断错。

---

### P1-9 · 商店 feature bullet 说「自动同步云端」，但自动下载默认关闭

**【代码事实】** `CHROMEWEBSTORE.md:45`：「· 登录同步：登录后会话自动同步云端，换设备、换浏览器也能找回你的工作现场」。而 `src/utils/storage.ts:251-256` 明写 `syncEnabled` 自 1.23.0 起**默认关闭**；`README.md:48` 与 `:67` 如实写了「自动下载**默认关闭**」「5/10/30/60 四档」。商店里只有 Permissions 表的 alarms 行（`CHROMEWEBSTORE.md:137`）提到默认关闭 —— **feature bullet 里没有**。

**守卫有洞**：`tests/docsAlignment.test.ts:684-756`（C-01）只查「不得说关掉后不创建定时任务」与「必须提到延迟上传」，**不覆盖这条 feature bullet**。

**后果**：审核员读 feature bullet 会以为有持续双向自动同步；用户开箱后第一周发现换设备要手动点同步，会认为是 bug。

---

### P1-10 · 真正缺的那块 table stakes 是「撤销」，不是「置顶 / 文件夹 / 备注」

详见第 4 节。核心判断：**置顶（收藏）、文件夹、备注、模板全部不是 table stakes** —— 因为 TapStack 的会话默认被消费、列表不会无限增长；「锁」已覆盖「置顶 + 可反复使用」；会话名已覆盖「备注」。**唯一真正缺、且竞品当卖点卖的是「撤销」**（= P0-4）。

---

## 3. P2 结论（7 条）

| # | 一句话 | 证据 |
|---|---|---|
| **P2-1** | `_shared.md:14` 的规模数字**过期一倍**：「src 约 23,000 行、88 个测试文件」；实测 **46,154 行 / 223 个测试文件**。这是每个 agent 开工必读的文件 —— 别的 agent 会据此以为仓库只有一半大。 | `.codex/agents/_shared.md:14` |
| **P2-2** | `docs/RELEASE-NOTES.md:11` 写「## v1.25.1（2026-10-20，**未提审**）」，而 `CHROMEWEBSTORE.md:362` 写「**已提交审核**（2026-10-21）」。同一版本两个状态。 | 两文件 |
| **P2-3** | 商店的 Privacy & Data Use 表（`CHROMEWEBSTORE.md:165`）说「界面偏好」会同步，**没排除三项设备级设置**（`syncBackend` / `syncEnabled` / `syncIntervalMinutes`，`src/types/tab.ts:405-409` 不上云）。README:169 与 privacy.html 写了，**审核员实际会看的那张表没写**。 | `src/types/tab.ts:405-409` |
| **P2-4** | 存一次会留下**两个**标签页：`TabManager.ts:231` 建 `chrome://newtab`，`service-worker.ts:413` → `TabManager.ts:82` 又建一个管理页，同一窗口。 | 两处 |
| **P2-5** | 管理页已开着时，点图标会**把焦点扔到另一个窗口**：`TabManager.openTabManager`（`TabManager.ts:70-84`）找到已存在的管理页就 `chrome.tabs.update(tab.id, {active:true})`，那是**另一个窗口**的标签 —— 激活它会把那个窗口拉到前台。用户在自己的窗口点图标 → 本窗口标签全被关 → 焦点跳走。 | `TabManager.ts:70-84` |
| **P2-6** | **连续保存同一批站点会得到同名会话**：会话名按主导域名命名（`src/domain/tabGroup/sessionName.ts:115-127`），三个 `github.com` 无法区分「哪一次」。缓解：卡片上已有相对时间。取舍是「域名命名解决了『这是哪』，丢了『哪一次』」。 | `sessionName.ts:115-127` |
| **P2-7** | 商店首图里会话卡片右侧 5 个操作全是**纯图标**（`TabGroup.tsx:925-977`，aria-label 齐全但视觉无文字），截图由 `scripts/make-store-screenshots.mjs` 注入演示数据生成（`CHROMEWEBSTORE.md:126-127`）。审核员/第一个下载者无法从图判断那 5 个图标是什么。 | `TabGroup.tsx:925-977` |

---

## 4. 竞品对照（交互模型，不是功能清单）

> ⚠️ **所有竞品事实均引自仓库内已记录的调研**（`docs/audit-2026-10-20-round1.md`），**非记忆**。本机 WebSearch 返回空、WebFetch 被重定向到 CWS 首页 ⇒ **无法在线核实现状**。OneTab / Workona / Arc / Toby / SessionBuddy 的当前定价与功能集均为 2026-10-19/20 记录，**可能已过期，建议核实**。

### 4.1 交互模型的四个真实差异

| 竞品 | 交互模型 | 与 TapStack 的关键差异 |
|---|---|---|
| **Chrome 原生标签组** | 标签组活在**标签栏**里，命名 + 着色，关窗口不关组，跨重启保留，可随 Chrome 账号同步 | TapStack 的标签**离开窗口**（进入会话列表），换来「窗口能彻底清空」。**两种物理隐喻**：原生是「收纳」，TapStack 是「剪切」 |
| **Chrome 会话恢复** | 浏览器自己记，零心智负担，但**不可命名、不可搜索、不可跨平台** | TapStack 换来命名/搜索/跨设备，付出「要自己记得用」的成本 |
| **OneTab**（`round1:350-351`） | 极简：保存即关，可重复打开，**无自动保存**（解包 CRX 无 `chrome.alarms`），有 `duplicates: allow\|reject` 选项与「Remove duplicates」菜单；**2026-03 v2.13 加了 folders/search**，但默认组名也是时间戳 ⇒ 用户抱怨「一堆叫 Saved 9/12 的组」（`round1:551`） | TapStack 的「按域名命名」正是对 OneTab 这个已知痛点的正面回应（`sessionName.ts:16-46`）。**在「找回」这一维 TapStack 已强于 OneTab** |
| **OneTab Plus** | 已于 **2025-01-28 下架**；其 Edge 版被 Koi 标记为恶意（`round1:352`） | 佐证这个品类**有真实付费需求**，也说明其信任度脆弱 |
| **TheTab / BelayTab**（`round1:360-363`） | 把 **Undo** 当卖点写在商店首屏 | **这正是 TapStack 缺的那块**（P0-4） |

### 4.2 缺了哪块 table stakes —— 结论：**只有「撤销」**

| 候选 | 是不是 table stakes | 理由（有据） |
|---|---|---|
| **置顶 / 收藏（pin）** | ❌ 不是 | 「锁」已覆盖且更强：`lockedDeleteCopy.ts:5-20` 明确锁 = 防误删 + **可反复恢复（不消费）** + 跨设备同步；收藏只是本机置顶偏好（1.22.13 下线，字段见 `src/core/orphanedGroupFields.ts:87`）。恢复收藏会重新引入「本机偏好不上云 → 跨端不一致」的老问题。**该做的是给锁改名，不是加收藏。** |
| **会话分组 / 文件夹** | ❌ 不是（OneTab 已加） | TapStack 的会话默认被消费，列表**不会无限增长**（`TabGroup.tsx:289`）。加文件夹 = 加一层导航 + 一套排序语义 + 一套跨端合并语义。若要加，先加**筛选视图**（域名筛选已有，`src/components/search/SearchFilterPanel.tsx`），不要持久化文件夹 |
| **标签页备注 / 会话备注** | ❌ 不是 | 会话名已承担注释职能且**参与搜索**（`src/utils/search.ts:180` groupName 参与匹配）。再加一个字段 = 同一件事两个地方写 |
| **全局搜索（跨设备）** | ✅ 已有 | 覆盖会话名 / 标签标题 / URL（`src/utils/search.ts:166-180`），登录即拉一次云端（`README.md:47`） |
| **重复检测** | ✅ 已有 | 「清理重复标签」+ 空会话清理（`tabSlice.ts:298`）；OneTab 有同款（`round1:351`） |
| **会话模板** | ❌ 不是 | 与「一次性的工作现场」心智冲突 |
| **导出为 HTML / 分享** | ❌ 不是（暂缓） | OneTab 文本 + JSON 已覆盖搬家与备份；HTML 分享需托管，是另一条产品线 |
| **撤销 / 回收站** | ✅✅ **是 —— 唯一的真空缺** | 竞品当卖点卖（`round1:360-363`）；本仓两轮审计都识别到并显式推迟（`round1:383-387`），理由已过期 |

---

## 5. 功能减法判断（5 个候选）

> **核心价值一句话**：TapStack 把「一整个工作窗口」变成一个**可命名、可找回、可跨设备搬运**的东西；用完就消失（恢复即消费），所以它是**待办队列**而不是**收藏夹**。

### 减法 #1 · 置顶 / 收藏（pin / favorite）—— **不恢复，但要把「锁」改名**

- **看起来该有**：Workona / SessionBuddy / Toby 都有；本仓 1.22.13 刚砍掉（`CHROMEWEBSTORE.md:396` ⑤）。
- **核心价值**：排序与命名。TapStack 已用「会话名按主导域名」+「锁定」覆盖。
- **摩擦点**：恢复收藏会重新引入 1.22.13 下线时的两个老问题 —— 本机偏好不上云导致跨端不一致；以及给极简列表加回一颗星标（`round1:396` 的截图守卫还专门盯着它别复活）。
- **建议**：**不恢复收藏**；改为**给「锁」正名**（拍板项 5）。
- **【需拍板】**

### 减法 #2 · 会话分组 / 文件夹 —— **暂缓**

- **看起来该有**：OneTab 2026-03 v2.13 已加 folders/search（`round1:551`）。
- **核心价值**：在长列表里给会话一个位置。
- **摩擦点**：TapStack 的列表因为「恢复即消费」**天然不会长**（`TabGroup.tsx:289`）。加文件夹 = 加一层导航 + 一套排序语义 + 一套跨端合并语义（会话要同时有 folder 字段才能同步）。
- **建议**：**暂缓**。若用户反馈「找不到旧会话」，先做**按域名的筛选视图**（能力已在），不要持久化文件夹。

### 减法 #3 · 导出为 HTML / 团队分享 —— **暂缓**

- **看起来该有**：SessionBuddy / 团队场景常见。
- **核心价值**：把会话给**别人**看。
- **摩擦点**：需要托管（纯客户端无法生成带链接的可分享静态页），是第二条产品线。
- **建议**：**暂缓**。OneTab 文本格式已能当作「给人的清单」（`CHROMEWEBSTORE.md:44`）。

### 减法 #4 · 会话备注 / 标签页备注 —— **不恢复（维持现状）**

- **看起来该有**：Workona / Toby 有；本仓 1.22.13 下线，理由是「会话命名已经覆盖了『给这组标签起个名字』这个需求」（`CHROMEWEBSTORE.md:396` ⑤）。
- **核心价值**：给会话加一句人类可读的说明。
- **摩擦点**：会话名**已经**参与搜索（`src/utils/search.ts:180`），恢复备注会让「同一句话有两个地方写」，且两者可能不一致。
- **建议**：**维持下线**；可考虑给会话名加「名字 + 一句话」的双段结构（**一个字段，不是两个**）—— 覆盖备注需求又不引入第二个真相源。**【需拍板】**（属新增，归 V2）

### 减法 #5 · 撤销上一次保存 / 恢复 —— **建议做（本节唯一的「该有而没有」）**

- **看起来该有**：TheTab / BelayTab 当卖点卖（`round1:360-363`）。
- **核心价值**：让「保存 = 剪切」这个不可逆动作**可反悔**。
- **摩擦点（当前是负的）**：保存关掉标签后没有反悔路径；恢复消费会话后没有反悔路径；删除没有回收站。三者叠加 ⇒ 产品的每一次「前进」都是单程票。
- **建议**：**做，但只做最近一次**（通知按钮 / 管理页顶部一行「刚刚保存了 N 个标签页 · 撤销」）。三档见拍板项 1。
- **【需拍板】**

---

## 6. 需要你亲自拍板的事

| # | 决策 | 三个选项 | **我的推荐 + 一句理由** |
|---|---|---|---|
| **1** | **要不要做「撤销」** | ① 不做；② 只撤销最近一次保存/恢复（~1–2 天）；③ 30 天撤销窗口（`round2:211-225` 有设计，~7 天，且要改 4 处文档承诺） | **②**。它正好补上「存错了 / 恢复错了」两个真实场景；③ 会与「删除即物理清除」这条已写进隐私政策和商店文案的承诺正面冲突 |
| **2** | **首次体验怎么改** | ① 首次保存走确认框；② 首次只存不关；③ 首次点图标只开管理页 + 引导，不自动保存 | **③**。唯一同时做到「不增加破坏性」「引导在正确位置」「第二次起仍是一键」的选项；② 会让核心契约在第一次就打折 |
| **3** | **要不要为同步收费** | ① 继续全免费；② WebDAV 永久免费 + Supabase 云同步 $29–39/yr（`round1:358` 原建议）；③ 软性收费（Pro 档多设备数） | **②，但前提是先修 P0-1/P0-3/P0-4**。在 P0 未修时收费，只会把漏斗前段的问题变成付费用户的投诉 |
| **4** | **英文怎么办** | ① 现在删掉商店文案的英文半边；② 做 i18n（V2）；③ 维持现状 | **①**。零成本、诚实、放弃一半漏斗但留住另一半；把英文预算留给 ② |
| **5** | **「锁」要不要改名/重定位** | ① 维持「锁定防误删」；② 改叫「固定 / 常用」，并允许锁定会话**仍可重命名**（重命名不是破坏性操作）；③ 恢复「收藏」只做置顶 | **②**。它其实是产品里唯一的「可重复使用」机制，名字却在讲最次要的那一面 |

---

## 7. 首发商店呈现：评分与改写建议

### 评分（审核员 + 第一个下载者双视角）

| 维度 | 分 | 理由 |
|---|---|---|
| 标题「TapStack」 | 5/10 | 7 个字符，不自我说明。「OneTab」「Workona」「Toby」一眼就知道干嘛；「TapStack」需一句解释 |
| 一句话（Short Description） | 5/10 | 说清了「保存/命名/恢复/同步」，但**漏了「会关标签」**，也没说「适合谁」 |
| 详细描述 | 8/10 | 全项目最成熟的一份文案（中英双语、9 条 feature、权限逐条解释、隐私诚实）。扣分：首句不说关闭、**自带存储那一条长度约等于前面所有条的总和**（喧宾夺主，90% 用户不用）、无「从 OneTab 搬家」钩子、没提主题/布局 |
| 截图（2 张） | 7/10 | 首图干净、「保存并关闭」按钮清晰可见。扣分：会话卡片 5 个操作全是无文字图标；只有 2 张 |
| **审核员合规视角** | 9/10 | 权限逐条说明、隐私表完整、Data Use 认证 —— 相当扎实 |
| **第一个下载者转化视角** | 5/10 | 首屏没说清「会发生什么」；无「从 OneTab 搬家」钩子；没说清「为什么用它而不是 Chrome 原生标签组」 |
| **综合** | **6.5/10** | 文案质量远高于商店均值，但**没把两个最关键的事实放到最前面** |

### 改写建议（可直接用）

**① Short Description**（`CHROMEWEBSTORE.md:28`，现 63 字，上限 132）

现：
> 保存、命名和恢复浏览器标签会话，跨设备同步找回。Save, restore & sync your tab sessions.

建议：
> 一键把当前窗口的标签页收成一个会话（**标签会被关闭**），随时找回恢复。Save your window's tabs into one session — and close them.

**② Detailed Description 首句**（`CHROMEWEBSTORE.md:33`）

现：
> TapStack 把你当前浏览器窗口里的所有标签页保存为一个会话，随时找回、随时恢复，不让标签页堆积成灾难。

建议：
> TapStack 一键把当前窗口的所有标签页**收进一个会话并关闭它们** —— 标签不再堆在窗口里，需要时一个动作全部找回、恢复。Save your window's tabs into one session and close them; get the whole set back with one click.

**③ 加一条获客 bullet（插到第 1 条之前）**

> · **从 OneTab 搬家**：OneTab 的文本格式可以直接导入（也能导出回 OneTab），你已有的标签组一键搬过来，还能按内容自动命名

理由：OneTab 格式**已经是事实上的互操作契约**（`round1:350` + 双向保真守卫 `tests/guards/oneTabRoundTripFidelity.test.ts`），这是 TapStack 唯一有独占性的获客钩子，现在只是第 8 条 bullet。

**④ 把自带存储那条缩短并后移**（`CHROMEWEBSTORE.md:46`，中英各一段，是整段文案里最长的部分）—— 保留事实完整性，压到 1/3 长度，细节移到 Permissions 表与隐私政策。

**⑤ 加一条主题/布局**（补 P1-6）

> · 6 套主题风格 + 浅色/深色，单栏/双栏布局，界面偏好随账号同步

**⑥ 加一条定位（回应 Chrome 原生标签组）**

> · 标签组留在标签栏里，关窗口就没了；TapStack 把整个窗口收成**一个可命名、可搜索、可跨设备**的会话

---

## 8. 数字与事实一致性

| README 的数字 | 代码事实 | 结论 |
|---|---|---|
| 当前版本 `1.25.1`（`README.md:3`） | `package.json:3` / `manifest.json:4` / `.env.example:10` = 1.25.1 | ✅（但 **git tag 缺**，P1-1） |
| **6 套主题**（`README.md:46`） | `src/styles/themes/` 6 个 CSS（legacy/creamy/prism/apple/chrome/claude）；`ThemeStyleSelector` 渲染 6 套；守卫 `tests/docsAlignment.test.ts:396-407` | ✅ |
| **5 / 10 / 30 / 60 分钟**（`README.md:48,:67,:170`） | `src/utils/storage.ts:204` `SYNC_INTERVAL_CHOICES = [5,10,30,60]`；`:207` 默认 10 | ✅ |
| PBKDF2 **250k**（`README.md:61`，WebDAV） | `src/sync-backend/crypto.ts:43` `PBKDF2_ITERATIONS = 250_000` + AES-256-GCM | ✅ |
| PBKDF2 **10 万次**（`README.md:83`，云端） | `src/utils/encryptionUtils.ts:9` `PBKDF2_ITERATIONS = 100_000` | ✅ |
| 上传延迟 **1.5–3 秒**（`README.md:170`） | `src/core/syncTiming.ts:29` 3000（普通）/ `:38` 1500（删除） | ✅ |
| 云端删除标记保留 **30 天**（`README.md:70`） | `src/legal/privacy.html:60` 同口径 | ✅ |
| 会话数 / 标签数 / 测试数 | README **未**声明 | ✅ 无可核对项 |

**六处版本号同步**：`package.json` ✅ / `manifest.json` ✅ / `.env.example` ✅ / `README` ✅ / `CHROMEWEBSTORE` ✅ / **git tag ❌（缺 v1.25.0 + v1.25.1）**。

**额外发现**：`_shared.md:14` 规模数字过期一倍（P2-1）；`CHROMEWEBSTORE.md:388` 的 1.24.1 状态与 `:5` 矛盾（P1-8）。

---

## 9. 我撤回的判断

1. **撤回：「保存后忘了刚才存了什么」是致命缺陷。** 展开会话卡片就能看到全部标签行，会话名还按主导域名命名 —— 信息根本没丢。真正的问题不是「忘了」，而是**同名会话分不出哪一次**（P2-6）。
2. **撤回：「恢复消耗会话必须加确认框」。** 恢复前展开卡片就是预览，确认框会变成噪音，且违背本项目「减法减的是常驻界面，不是反馈」的原则。**保留的是「应该给一次撤销」**（P0-4 第二档），不是「加确认」。
3. **撤回：「锁替代不了收藏」。** 读完 `src/components/tabs/lockedDeleteCopy.ts:5-20` 后确认锁 = 防误删 + **可反复恢复（不消费）** + 跨设备同步，比收藏强。问题只是**名字没把这层意思说出来**（转为拍板项 5）。
4. **撤回：「1.24.1 那行的『未提审』是文件头写错了」。** 更可能是**那一行没跟上**（文件头有 2026-10-21 的实测证据，行是更早写的未更新）。结果一样（文件与现实脱节），但归因从「文件头错」改为「台账没维护」，级别从 P0 降为 P1。
5. **上调一条：「主题/布局没进商店文案」原列 P2 → P1。** 理由：对照 `round1:354-358` 的 10 个竞品调研，**「本地功能」在整个品类里是同质化的** —— 差异只能来自体验与定位，而主题是唯一能被截图呈现的差异化。
6. **一次假阳性自查（按 `_shared.md` 陷阱 2）**：我一度怀疑 grep 找 `撤销|undo` 零命中 ⇒ 产品没有撤销入口。**用第二种方式复核**（读 `TabGroup.tsx:250-309` 完整 restore 路径 + `tabSlice.ts` deleteGroup 链路 + `lockedDeleteCopy.ts`）—— 结论成立，非假阴性。同样复核了 grep「数据同步到哪里」（确认只命中 README 自身）与 grep i18n（确认无 `src/i18n`、无 `_locales/`、无 `default_locale`）。

---

## 10. 未能验证项（受环境限制，非遗漏）

1. **竞品的当前现状无法在线核实。** 本机 `WebSearch` 返回空结果、`WebFetch` 被重定向到 CWS 首页（实测）。因此本报告**只**引用仓库内已记录的竞品事实（`docs/audit-2026-10-20-round1.md:350-363, 551`）。**OneTab / OneTab Plus / BelayTab / TheTab / Tabbox / Marqly / Workona / Arc / Toby / SessionBuddy 的当前定价、当前功能集、是否仍上架 —— 全部为 2026-10-19/20 记录，可能已过期，建议核实。** 我自己记忆中的竞品现状一律没写进结论。
2. **线上商店页未实测。** `CHROMEWEBSTORE.md:5` 记的「线上已发布 = 1.24.1」只能当作**仓库里的记述**，不是实测事实。审核状态（v1.1 API 查不到）同样未复核。P1-8 的定性依赖这一记述；若记述本身有误，P1-8 的归因会变（但「表格与文件头自相矛盾」不变）。
3. **线上隐私政策未复测。** 按 `_shared.md` 与 `CHROMEWEBSTORE.md:228-230` 的教训，改完 `src/legal/privacy.html` 必须 curl 逐字 diff。本轮为只读审计且外部网络受限，**线上内容与仓库是否仍逐字一致 = 未验证**。
4. **真机行为未实测。** P0-1 / P0-3 / P2-5 的实际观感（标签消失的冲击、焦点跳到哪个窗口、通知是否真的没弹）是从**代码路径推出来的，不是从屏幕上看到的**。建议真机各花 2 分钟复核。
5. **Supabase 生产库状态未复核。** 本轮与产品模型无关，未查（按 `_shared.md` 第八节，代码侧结论不能推断生产库状态）。

---

## 11. 汇总表（可直接派活）

| # | 级别 | 一句话标题 | 位置 | 建议 |
|---|---|---|---|---|
| P0-1 | P0 | 点扩展图标 = 无确认销毁当前窗口（上一轮审计已定 P0，未修） | `src/service-worker.ts:408-418`；`src/background/TabManager.ts:222-236`；`manifest.json:28` | 按拍板项 2 改首次体验；补一个「保存不关」的可配置项 |
| P0-2 | P0 | 首次体验顺序倒了：破坏性动作发生在解释之前 | `service-worker.ts:411-413` → `MainApp.tsx:30-36` → `OnboardingSteps.tsx:62-64` | 首次点图标只开管理页 + 引导，不自动保存 |
| P0-3 | P0 | 首次点击零反馈：成功通知被默认开关吞掉 | `src/utils/storage.ts:282`；`TabManager.ts:544-547`；`service-worker.ts:410`；`Header.tsx:302-307` | 图标点击路径的成功反馈无条件发出，或管理页顶部加「刚刚保存了 N 个标签页」 |
| P0-4 | P0 | 「恢复」永久消费会话，零确认零撤销；摩擦力分配反了 | `src/components/tabs/TabGroup.tsx:250-309`（对比 `:209`/`:226`/`:490`） | 按拍板项 1 做「撤销最近一次」；给锁补一条说明 |
| P1-1 | P1 | 六处版本号同步断了：git tag 停在 v1.24.3 | `git tag` / `git ls-remote`；`tests/releaseNotes.test.ts:1-8` | 补 v1.25.0 / v1.25.1 tag；`validate-extension.mjs` 加 tag 检查 |
| P1-2 | P1 | 商店首屏两句话都不说「标签会被关掉」 | `CHROMEWEBSTORE.md:28,33`；守卫洞 `tests/docsAlignment.test.ts:862-882` | 按第 7 节改写；给守卫补两条断言 |
| P1-3 | P1 | 纯中文产品却用中英双语上商店 | 全仓无 i18n；`CHROMEWEBSTORE.md:28,54-69,83` | 按拍板项 4：先删英文半边 |
| P1-4 | P1 | README 的「锁定」描述少两项（不可拖走 / 删除必确认） | `README.md:43` vs `CHROMEWEBSTORE.md:39,42` | 对齐 README；`docsAlignment.test.ts` 加钉住断言 |
| P1-5 | P1 | `README.md:54` 的设置入口是死指针「数据同步到哪里」 | `README.md:54`（src 全无此串） | 改成「设置页 → 数据同步 → 同步方式」；加守卫 |
| P1-6 | P1 | 商店文案完全没提主题/布局 —— 唯一的差异化没进 listing | `README.md:46` vs `CHROMEWEBSTORE.md` 全文 | 加一条 bullet + 一张主题截图 |
| P1-7 | P1 | 免费送掉了竞品收费 $36–60/年的跨设备同步 | `docs/audit-2026-10-20-round1.md:354-358`；`src/sync-backend/webdav/`、`src/utils/supabase/` | 按拍板项 3；**先修 P0** |
| P1-8 | P1 | 商店版本历史表与文件头自相矛盾（1.24.1 发没发） | `CHROMEWEBSTORE.md:5,7-8` vs `:388` | 核对后台后改行；守卫加「状态与现实一致」检查 |
| P1-9 | P1 | 商店 feature bullet 说「自动同步」，但自动下载默认关闭 | `CHROMEWEBSTORE.md:45` vs `src/utils/storage.ts:251-256` | 在 feature bullet 里补「自动下载默认关闭，可在设置开启」 |
| P1-10 | P1 | 真正缺的 table stakes 只有「撤销」，置顶/文件夹/备注都不是 | 第 4 节；`docs/audit-2026-10-20-round1.md:360-363` | 按第 5 节减法表执行 |
| P2-1 | P2 | `_shared.md` 规模数字过期一倍 | `.codex/agents/_shared.md:14` | 改为 46,154 行 / 223 测试文件 |
| P2-2 | P2 | RELEASE-NOTES 与商店台账的 1.25.1 状态不同步 | `docs/RELEASE-NOTES.md:11` vs `CHROMEWEBSTORE.md:362` | 台账加一行「2026-10-21 已提交审核」 |
| P2-3 | P2 | 商店 Data Use 表没排除三项设备级设置 | `CHROMEWEBSTORE.md:165` vs `src/types/tab.ts:405-409` | 补「用哪个后端/是否自动同步/同步间隔始终以本机为准」 |
| P2-4 | P2 | 存一次留下两个标签页（newtab + 管理页） | `TabManager.ts:231` + `service-worker.ts:413` | 复用被关掉的最后一个标签页位置，或关完直接开管理页而不建 newtab |
| P2-5 | P2 | 管理页开着时点图标，焦点被扔到另一个窗口 | `TabManager.ts:70-84` | 改为在当前窗口开管理页，或明确提示「已切到另一个窗口」 |
| P2-6 | P2 | 同域名连续保存得到同名会话，分不出「哪一次」 | `src/domain/tabGroup/sessionName.ts:115-127` | 名后补时间/序号，或把相对时间提到卡片头更显眼处 |
| P2-7 | P2 | 商店首图里 5 个操作全是无文字图标 | `TabGroup.tsx:925-977`；`store-assets/screenshot-1-main.png` | 重拍一张带文字标签或悬浮提示的图 |

**派活优先级建议**

- `P0-1 / P0-2 / P0-3` 打包成一个「首次体验」改动（同一个 PR，互相耦合）。
- `P0-4` 独立（涉及跨端语义与文档承诺）。
- `P1-1 / P1-8 / P2-2` 打包成一个「发版台账」改动（半小时）。
- `P1-2 / P1-9 / P2-3` 打包成一个「商店文案对齐」改动（配合第 7 节改写一起做）。
