# 审计报告：新手引导 + 交互诚实度（2026-10-22）

**审计者**：交互诚实度专家 + 新手体验设计师
**范围**：引导全链路、跨设备同步承诺、空状态、Toast/错误文案、跨文件文案对、首屏三秒、商店文案
**结论数**：15 条（P0 × 2 / P1 × 6 / P2 × 7）
**纪律**：本轮**只读审计，未修改任何代码**。每条注明证据类型（**读代码** / **跑出来的** / **只看截图**）。

> ⚠️ **审计期间工作区被并行改动两次**，本报告已按**最终状态**重验全部结论。
> 详见「未能验证项」第 7 条。**有 1 条结论（P0-3）因外部修复而作废，已移入「我撤回的判断」**。

---

## 门禁实测（本机真实执行，非引用）

| 命令 | 结果 |
|---|---|
| `node scripts/prod-onboarding.mjs`（真 Chrome） | **16/16 通过** — 引导出现 / 6 步走完 / 跳过 / 重看 / 跨重启不回来，全部 ✅ |
| 自写探针（真 Chrome + 扩展）走完 6 步，逐步抓 `.onboarding-spotlight-ring` | **第 4 步 ring=false**（详见 P0-1） |
| 自写探针（真 Chrome）打开 ⋯ 菜单，dump 全部 `role="menuitem"` | 菜单项 8 条，**无「登录 / 注册」**，只有「去登录」（详见 P0-2） |
| 自写探针（真 Chrome）复刻 `action.onClicked` 全流程 | 标签**未被关闭**（并发修复后），见「我撤回的判断」第 1 条 |
| 自写探针（真 Chrome，400px 视口）制造保存失败后读按钮可见文本 | 可见文本 = `保存并关闭`，错误文案在 `hidden sm:inline` 里 ⇒ **不可见**（P1-4） |
| 自写探针（真 Chrome）按引导第 2 步指示点「保存并关闭」 | 窗口 4 标签 → 存下 2 个 → 剩 `about:blank` + 扩展页 + `chrome://newtab/`；按钮回「已保存 2」 |
| `git status --porcelain` | 工作区有 26 个文件被**外部并行改动**（见「未能验证项」第 7 条） |

**关于 `dist/`**：`dist` 是 gitignored，构建产物。工作区在审计期间被外部改动两次，我**重建了两次**（`npm run build`，均成功），每次探针都跑在当时的最新源码上。**未提交、未推送**。

---

## 结论先行

三件事必须先说清楚，因为它们决定了新用户的「第一个 5 分钟」体验：

1. **引导的触发链已经修好了**（记忆里那两条都成立）。但引导**内容**与产品现状仍有两处对不上。
2. **点扩展图标现在是安全的**（并发修复已落地，实测标签不被关闭）—— 这一点原本是我判定的 P0，现已作废，移入「我撤回的判断」。
3. **跨设备同步的承诺，在引导里说了一套、在菜单里是另一套**（详见 P0-2、P1-6），且**「自动同步默认关闭」这件事在管理页上完全没说**。

---

## P0

### P0-1 引导第 4 步「恢复整个会话」的聚光灯，在全新安装时整个消失

- **证据（跑出来的）**：真 Chrome 走完 6 步，逐步记录聚光灯是否存在：

  ```
  STEP0 欢迎使用 TapStack        ring=false   （首步本就不高亮）
  STEP1 先保存一个会话            ring=true
  STEP2 需要时快速找回            ring=true
  STEP3 恢复时继续，而不是重来    ring=false   ← 无高亮
  STEP4 换台设备也能找回          ring=true
  STEP5 核心闭环已经齐了          ring=false
  ```

  同一次运行中 `button[aria-label^="在新窗口恢复整个会话"]` 在 DOM 里**命中数 = 0**。

- **代码**：`src/components/onboarding/OnboardingGuide.tsx:58-62` — 第 4 步的 `spotlightTarget` 是
  `'button[aria-label^="在新窗口恢复整个会话"], button[aria-label^="在新窗口恢复所有匹配标签"]'`。
  这两个按钮只存在于 `TabGroup` 卡片上（`src/components/tabs/TabGroup.tsx`），**而全新安装时一个会话都没有 ⇒ 卡片不存在 ⇒ 选择器命中 0 个元素**。

- **为什么静默**：`src/components/onboarding/Spotlight.tsx` 的 `firstVisibleMatch()` 要求 `rect.width > 0 && rect.height > 0`；找不到时只 `logWarn`（console）并 `return null` 渲染 —— **界面上没有任何提示**。

- **为什么守卫守不到**：`tests/a11yLists.test.ts:459-485` 的交叉校验是**源码级**的：它把 `OnboardingGuide.tsx` 里的选择器字符串，与 `Header/TabGroup/SearchResultList` **源码里出现过的 aria-label 字面量**比对（`labels.some(label => label.startsWith(value))`）。只要 `TabGroup.tsx` 里那行字面量还在，选择器就算「命中」。**它从不检查运行时 DOM**，所以「元素存在但此刻不存在」这一类缺陷零检测力。

- **为什么是 P0**：全新用户**必然**是 0 会话，所以这个缺陷**只在新用户身上发生**（有会话的老用户反而正常）。第 4 步教的是「恢复」，而新用户此刻还没有任何可恢复的东西 —— 聚光灯本该指向搜索框（可搜到刚存的那条），却指向一个不存在的按钮。用户看到第 4 步无高亮 = 「这一步坏了」。

- **最小改法**（两处都要）：
  1. `OnboardingGuide.tsx:60-61` 给 `spotlightTarget` 加 fallback 链：找不到恢复按钮时退回 `'[aria-label="搜索会话或标签页"]'`。
  2. `tests/a11yLists.test.ts` 增一条**运行时**断言；或更省事 —— 在 `scripts/prod-onboarding.mjs` 里加一条：走完 6 步，逐步断言 `.onboarding-spotlight-ring` 存在（该脚本现在**只断言标题在变**，从不断言聚光灯存在）。

---

### P0-2 引导第 4 步承诺「通过右上角菜单『登录 / 注册』开启同步」，但菜单里**没有**这一项

- **证据（跑出来的）**：真 Chrome 打开 ⋯ 菜单，dump 全部 `role="menuitem"`：

  ```
  MENU = [
    { text: "",             aria: "从云端刷新数据" },
    { text: "去登录",        aria: null },
    { text: "切换为双栏布局", aria: null },
    { text: "清理重复标签",   aria: null },
    { text: "设置…",        aria: null },
    { text: "导出数据",      aria: null },
    { text: "导入数据",      aria: null },
    { text: "问题反馈",      aria: null },
    { text: "使用引导",      aria: null }
  ]
  HAS_登录_注册 = false
  EXACT_登录_注册_NODES = 0
  ```

  菜单里**一个字面量叫「登录 / 注册」的节点都没有**；入口的可见文字是「去登录」。

- **代码**：`src/components/onboarding/OnboardingSteps.tsx:175` — `通过右上角菜单「登录 / 注册」开启同步`。同一个字符串还出现在：
  - `src/components/sync/syncPreviewView.tsx:184` — `请先点右上角「⋯」菜单里的「登录 / 注册」。`
  - `src/components/sync/syncPreviewView.tsx:229` — `请先点「⋯」菜单里的「登录 / 注册」`

- **为什么会变成这样**：工作区的 `HeaderDropdown.tsx` 有一次未提交的改动（`2026-10-22 审计 L-6`），删掉了独立的 `MENU_ROW「登录 / 注册」`，只保留状态卡里内联的「去登录」。**这次改动没有同步这三处文案**。注意 `git show HEAD:src/components/layout/HeaderDropdown.tsx` 里该行（`:816`）还在 —— 所以这是**刚引入的回归**，不是历史遗留。

- **诚实度定性**：这**不是**「指向不存在的入口」（入口存在，叫「去登录」），而是「**承诺了一个不存在的字面量**」。用户按引导去找「登录 / 注册」，在菜单里翻两遍找不到 —— 这是「指向了一个找不到的东西」，触犯契约 ③ 与 ⑤。

- **最小改法**：三处文案统一改成实际存在的「去登录」：
  - `OnboardingSteps.tsx:175` → `通过右上角菜单「去登录」开启同步`
  - `syncPreviewView.tsx:184` / `:229` → 同上
  - 更好的做法：把「去登录」提成一个共享常量（如 `src/components/layout/menuLabels.ts`），三处引用同一个，避免下次再漂。

---

### P0-3 ~~引导第 2 步教的第一个动作，在新用户的主路径上当场失败~~ —— **已作废，见「我撤回的判断」第 1 条**

审计中途，并行 agent 把 `chrome.action.onClicked` 改成了「只打开管理器、不保存不关标签」（`src/service-worker.ts:429-438`，并新增 `tests/guards/iconClickIsNonDestructive.test.ts` 钉住）。重建后实测：**点图标不再关闭任何标签**，引导第 2 步照做可以正常保存（`btnText: "已保存 2"`）。本条因此不成立。

**但它换来了一个新的、更小的缺口**（降级为 P2-16，见下）：引导第 2 步说「点击顶部的『保存并关闭』按钮」，而现在**图标点击不再保存**，所以「保存并关闭」这个动作的**主入口变成了引导本身指的那个按钮** —— 这条现在是对的了。真正剩下的问题是：商店文案里「快捷键 Ctrl+Shift+S 保存整窗并关闭（等同点击扩展图标）」已被同步改成「点扩展图标只会打开会话管理器」（`CHROMEWEBSTORE.md:37`，外部改动已修），**引导里却没有对应的一句**告诉新用户「点图标不会保存，要保存请点这个按钮」。

---

## P1

### P1-3 保存失败在窄屏下完全不可见（错误文案被 CSS 藏了）

- **证据（跑出来的）**：真 Chrome，400×800 视口，窗口内只有扩展页（无可保存标签）⇒ 走失败路径后读按钮：

  ```json
  { "spans": [
      { "cls": "hidden sm:inline whitespace-nowrap", "text": "没有可保存的标签页", "vis": false },
      { "cls": "sm:hidden",                      "text": "保存并关闭",           "vis": true  } ],
    "toasts": [],
    "visibleText": "保存并关闭",
    "bodyHasErr": false }
  ```

  错误文案存在，但落在 `hidden sm:inline` 的 span 里 ⇒ 窄屏**看不见**；窄屏分支渲染的是 `saveAndCloseShortLabel`（原样「保存并关闭」）；**没有任何 toast**；整页文本里搜不到「没有可保存的标签页」或「保存失败」。

- **代码**：`src/components/layout/Header.tsx:511-526`。宽屏分支（`hidden sm:inline`，`:511-519`）有 `saveFeedback?.kind === 'error'` 分支；窄屏分支（`sm:hidden`，`:520-526`）**只处理 `success`**，漏掉 `error`。失败文案在 `:250-253` / `:258` 正常生成，只是渲染时被 CSS 藏了。

- **为什么是 P1**：窄屏用户点了保存，屏幕上什么都没变（按钮文案不变，无 toast），**唯一能说清发生了什么的地方被 CSS 藏了**。这正是契约 ①「用户按了键没反应必须有一句话解释」被违反 —— 而且是在最需要解释的时候。

- **最小改法**：`Header.tsx:520-526` 的窄屏分支补 `error` 分支（可用截断版文案），或失败时改走 `showToast`（页面内，不受 `sm:` 断点影响）。

---

### P1-4 搜索页的「恢复整个会话」「点开单标签」零成功反馈，且锁定分支成功失败都无声

- **代码**：
  - `src/components/search/SearchResultList.tsx:379` — `consumeSession()` 之后**只在** `skippedUnopenable > 0` 时提示（`:380-389`），正常路径一句不说。
  - `src/components/search/SearchResultList.tsx:441-450` — 未锁定分支点开单标签，成功后 `dispatch(deleteTabAndSync)` 只报 `deleteBroadcastWarn`（失败才报），**没有成功播报**。
  - `src/components/search/SearchResultList.tsx:419-427` — **锁定**分支只有 `.catch`，**没有 `.then`**。而 SW 拒开是 `sendResponse({success:false})`（`src/service-worker.ts` 的 `OPEN_TAB` handler）⇒ promise **resolve 而非 reject** ⇒ `.catch` 不触发 ⇒ **成功和失败都零反馈**。
  - 全文件 `showRestoreSuccessMessage` 只在 `:584` 用过一次（批量恢复）—— 印证「单会话恢复 / 单标签点开两条路径既没实现、也没被守」。

- **对照**：`src/components/tabs/TabGroup.tsx:359 / 405 / 441` 三个路径**都有**成功播报。同一个产品动作，列表页有声、搜索页无声。

- **守卫盲区**：`tests/restoreFeedbackHonesty.test.ts` 只断言 `TabGroup.tsx` 有 `restoreGroupSuccessMessage`/`openSingleTabSuccessMessage`，对搜索页只查 `restoreAllSearchSuccessMessage`（**批量**）。所以搜索页的单会话恢复与单标签点开两条路径**既没实现、也没被守**。

- **最小改法**：搜索页三处各补一行 `showRestoreSuccessMessage(...)`，复用 `src/components/tabs/restoreFeedbackCopy.ts` 里**已有的**文案函数（已导出，无需新写）；同时给 `tests/restoreFeedbackHonesty.test.ts` 补搜索页的对应断言。

---

### P1-5 「跨设备同步」在引导里承诺「保存后会自动同步到云端」，但**自动同步默认关闭这件事在界面上没说过**

这是本次审计被点名的问题（「尤其跨设备同步」）。查下来的结论比预想更细：**上传**和**拉取**是两件事，引导把两件都说成了「自动」，而其中一件默认是关的、且关这件事在管理页上完全不可见。

- **代码事实**：
  - `src/utils/storage.ts:276` — `syncEnabled: false, // 默认关闭自动同步（用户在菜单中开启）`。
  - `src/background/backgroundSync.ts:234` — 后台轮询 alarm 只在 `settings.syncEnabled === true` 时注册 ⇒ **「自动（定时）拉取」默认不跑**。
  - `src/background/TabManager.ts:201` — 保存路径调 `syncEngine.scheduleUpload(...)`；`src/services/syncEngine.ts:316` 的 `scheduleUpload` **不检查 `syncEnabled`**（全文件只有 `:201` 一处提到它，且是注释）⇒ **「保存后上传」确实会自动发生**。
  - 登录后拉取：`src/components/auth/restoreAfterLogin.ts` — 登录成功主动拉一次（不受 `syncEnabled` 约束，`LoginForm.tsx:72` / `RegisterForm.tsx:79` 都调它）⇒ **「新设备登录后会自动拉回」也成立**。

- **所以引导的文案不算谎报**（`OnboardingSteps.tsx:187`「保存后会自动同步到云端；新设备登录后会自动拉回云端的会话」+ `:193`「保存和重命名都会同步到云端」）。

- **但「自动同步默认关闭」这件事，管理页上完全没说**（**读代码 + 跑出来的**）：
  - 全仓搜索「自动同步」，**管理页（`HeaderDropdown.tsx` / `SyncButton.tsx` / `TabList.tsx`）里零处**对用户可见的说明。`TabList.tsx:398` 那句「自动同步默认关闭」是**代码注释**，不是界面文案。
  - 探针确认：打开 ⋯ 菜单，菜单文本里 `自动同步` 命中数 = **0**（菜单里有「从云端刷新数据」，没有自动同步开关）。
  - 真正的开关在**设置页**（`src/options/OptionsPage.tsx:564-568`，文案是「打开后，TapStack 会按下面的间隔在后台自动同步」）。

- **后果**：新用户按引导以为「登录了就等于开同步了」。他换到第二台设备登录 → 会话被拉回 ✓（登录那一下）。但**两台设备都在线时**，第一台存的东西**不会自动出现在第二台** —— 因为「定时拉取」默认关。他会得出「这产品同步不可靠」的结论，而事实上只需在设置页打开开关。

- **与商店文案的对照**：`CHROMEWEBSTORE.md:137` 写得**比引导还准确**：

  > 「**此外，每次本地保存 / 重命名 / 删除都会安排一次延迟上传**……与自动同步开关无关——自动同步默认关闭，关掉它只是不再周期性拉取，你本地的改动仍会上传。」

  同一件事，商店页说清楚了「自动同步默认关闭」且区分了上传/拉取，引导和设置页入口没跟上。

- **最小改法**（三处同步改，契 ⑤）：
  1. `OnboardingSteps.tsx:175` 那一行补上默认状态，例如：`通过右上角菜单「去登录」开启同步；定时自动拉取默认关闭，可在设置里打开`。
  2. `OnboardingSteps.tsx:193` 的「自动同步」卡片描述改准：`保存和重命名都会上传到云端；定时拉取可在设置里开启`。
  3. 管理页 ⋯ 菜单里加一行同步状态说明（复用 `src/components/layout/backendStatus.ts` 已有文案），或至少在「从云端刷新数据」旁说清「自动拉取默认关闭」。

---

### P1-6 锁定会话里点开单标签，**成功时谎报成功**

- **代码**：`src/components/tabs/TabGroup.tsx:451-461` 锁定分支用 `.then(() => { showRestoreSuccessMessage(openSingleTabSuccessMessage(true)); })` —— **不看回包的 `success`**。而 SW 拒开时是 `sendResponse({success:false, error})` ⇒ promise **resolve** 而非 reject ⇒ `.then` 照样跑 ⇒ 界面播「已打开该标签页」，实际一个标签都没开。

- **对照**：未锁定分支（`TabGroup.tsx:467-500`）**有**成功门（`r.success === false` 走错误分支、`r.success !== true` 走「无回包」分支）。同一个文件、同一个动作，锁定分支缺了这道门。

- **最小改法**：`TabGroup.tsx:452-461` 改成 callback 形式，照抄未锁定分支的 `r.success` 判定。

---

### P1-7 「回到默认视图」名不副实，且在「只靠筛选」时**点了完全没反应**

- **代码**：`src/components/layout/Header.tsx:285-287` — `handleResetToDefaultView = () => { clearSearch(); }` —— **只清搜索词，不清筛选条件**。筛选状态住在列表层（`src/components/search/useSearchFilters.ts`），Header 拿不到。

- **后果**：`src/components/search/searchBrowseMode.ts:68-74` 的 `resolveSearchViewMode(query, hasActiveFilters)` 在「搜索词空 + 有生效筛选」时返回 `'browse'` ⇒ 点完 Logo **仍在筛选浏览态**，「回到默认视图」没兑现。更糟：用户本来就只靠筛选（没输关键词）时，点 Logo ⇒ `setSearchValue('')` 写回已是 `''` 的值 ⇒ **React bail out，零 DOM 变化、零提示**。

- **最小改法**：(a) 首选 —— 把 `useSearchFilters` 提升到 App 层，或给 Header 传 `onResetToDefaultView` 由 TabList 一起清；(b) 兜底 —— 改文案为「清除搜索词」并在筛选仍生效时说「筛选条件仍然生效」。

---

### P1-8 商店文案承诺的「域名徽章」在界面上不存在

- **商店文案**：`CHROMEWEBSTORE.md:110`「每个会话有域名徽章与标签数徽章」—— 这是**审核员可见正文**（同文件 `:115` 的注释明确警告过「这里的正文是给审核员看的可见文字」）。

- **实现**：`src/components/tabs/TabGroup.tsx:969` 的卡头只有 `tab-group-count`（标签数徽章）+ 锁定图标 + 时间，**没有域名徽章**（全文件 `grep "域名徽章\|domain-badge"` 零命中）。域名只出现在每行标签的 URL 列。

- **最小改法**：改文案 ——「每个会话有标签数徽章，标签行右侧显示域名」。**不要**改实现去加一个徽章（那是新增功能，需要产品拍板）。

---

### P1-9 权限表把会话数据的存储位置说错，与同一份 listing 指向的隐私政策自相矛盾

- **商店文案**：`CHROMEWEBSTORE.md:134`「`storage` … 在本地保存用户的**会话数据**、设置与登录状态」。

- **实际**：会话数据在 **IndexedDB**（`src/storage-kv/`），`chrome.storage.local` 只放登录态与几个设置标记（`src/utils/storage.ts`）。

- **自相矛盾**：同一份 listing 链接出去的隐私政策页（`src/legal/privacy.html`）写的是「会话数据默认保存在您浏览器的 IndexedDB…chrome.storage 只存放登录状态与少量设置标记」。审核员两份都看。

- **最小改法**：改文案 ——「在本地保存用户的登录状态与设置标记；会话数据存放在浏览器的 IndexedDB 中，不受 chrome.storage 配额限制」。

---

### P1-10 Known Issues 说「多设备同步要求登录」，但自带存储不需要账号

- **商店文案**：`CHROMEWEBSTORE.md:425`「多设备同步要求登录；未登录用户仅使用本地功能」。

- **实际**：`src/core/authGuard.ts` 对 webdav 直接放行 —— WebDAV 用户没有 TapStack 账号也能跨设备同步。同一份 listing 的 `:46`（自带存储）和 `:153` 已经写对了。

- **为什么是 P1**：Known Issues 是审核员判断「产品有无账号硬依赖」的依据，说错可能影响审核结论。

- **最小改法**：改文案 ——「使用 TapStack 云端同步需登录；选择「自带存储」（WebDAV）不需要账号。未登录且未配置云盘的用户仅使用本地功能。」

---

## P2

### P2-11 Known Issues 抹掉了「删最后一条标签会先确认」这个例外

`CHROMEWEBSTORE.md:427` 说「单条标签删除、以及把最后一条标签拖到别的会话，会立即生效、不弹确认」。但 `src/components/tabs/TabGroup.tsx` 的判据是 `!confirmBeforeDelete || !shouldAutoDeleteAfterTabRemoval(group, tabId)` —— 开着确认开关且删的是最后一条时**会先确认**。

同一份 listing 的 Detailed Description（`:42`）**已经写对了**（「单条标签删除会立即生效、不弹确认——**但如果这一删会让整个会话消失，就会先确认**」），只有 Known Issues 这一段没跟上。**同一份文件里两处自相矛盾。**

**最小改法**：把 Known Issues 那句改成「单条标签删除会立即生效、不弹确认——但如果这一删会让整个会话消失，就会先确认；把最后一条标签拖到别的会话，会立即生效、不弹确认」。

---

### P2-12 「标签组」这个用户可见的词，与产品其它地方的「会话」不是一回事

- **实测**：`deriveSessionNameFromChromeTabs` 在 `github.com` 上给出 `github.com`，但在**本机地址 / 内网 IP / file://** 上回落到 `标签组 10月22日 04:12`（跑出来的，5 个 case 全列）。
- **矛盾**：产品术语是「会话」（界面上大量用「会话」），只有这个**用户可见的默认名**用「标签组」。用户看到列表里一条叫「标签组 10月22日 04:12」的项，而空态 CTA 写「先保存一个**工作会话**」—— 同一屏两种叫法。
- **注意**：`CHROMEWEBSTORE.md:38` 承诺的正是「取不到域名时退回「标签组 月日 时:分」」—— **商店与实现一致**，所以这不是谎报，是**跨文件文案对不齐**（契约 ④）。
- **最小改法**（保守）：改 `src/domain/tabGroup/sessionName.ts:12-13` 的前缀为「会话」，**同步**改 `CHROMEWEBSTORE.md:38` —— 两处一起改，任一处不改就变成谎报。

---

### P2-13 搜索框 placeholder 与引导、空态提示说的不是同一件事

- `src/components/layout/Header.tsx:426` placeholder「搜索会话或标签...」／ `:430` aria-label「搜索会话或标签页」／ `src/components/onboarding/OnboardingSteps.tsx:108`「搜索会话名、标签标题或 URL」／ `src/components/search/SearchResultList.tsx` 空态「输入会话名、标签标题或网址」。
- 用户在引导里被告知能搜 URL，在搜索框的 placeholder 里看不到这个能力（而 placeholder 是**唯一**在输入前就可见的说明）。
- **最小改法**：placeholder 改成「搜索会话名 / 标签 / URL...」。

---

### P2-14 同步成功的路径没有任何一句话

- `src/components/sync/SyncButton.tsx` 的成功路径只有三种**警告**（设置重读失败 / 空本地跳过覆盖 / 云端读不出来），**普通成功路径一句不说**。上传成功时列表一个字都不变 ⇒ 用户分不清「同步成功了」与「点了没反应」。
- 同仓自己的口径就在 `src/components/layout/HeaderDropdown.tsx`（云端无变化时也要给一句「已是最新」）。
- **最小改法**：成功分支补一条 toast（按方向给「上传完成 / 下载完成」）。

---

### P2-15 「右键标签标题」在 Chrome 150 以下不存在

`CHROMEWEBSTORE.md:37` 承诺四个右键菜单项，包括「右键标签标题」。`src/service-worker.ts` 用特性探测注册 `tab` 上下文（Chrome 150 之前不支持 ⇒ 只有 `page` 上下文），而 `manifest.json` 的 `minimum_chrome_version` 是 **120**。

**最小改法**：提 `minimum_chrome_version` 到 150，或在文案里加限定（「Chrome 150 及以上可右键标签标题」）。

### P2-16 图标点击改成「只打开管理器」后，引导没有跟上说明这个变化

- **背景（并发改动已落地）**：`src/service-worker.ts:429-438` 的 `chrome.action.onClicked` 现在只调 `tabManager.openTabManager()`，**不再保存、不再关标签**；`manifest.json` 的 `default_title` 已同步改成「TapStack - 打开会话管理器」；`CHROMEWEBSTORE.md:37` 已同步改成「**点扩展图标只会打开会话管理器，不会动你当前的标签页**」。三处都对。

- **缺口**：**引导没跟上**。`src/components/onboarding/OnboardingSteps.tsx:62-64` 仍然只说「关闭本引导后，点击顶部的『保存并关闭』按钮」—— 没说「点图标不会保存」，也没说「保存并关闭会用按钮、右键图标或快捷键」。新用户若把引导当成「点图标 = 保存」的理解（这是点图标类扩展最常见的心智模型），会先点图标、发现什么都没发生，然后困惑。

- **为什么是 P2 不是 P0**：引导**没有说错话**（它说的每个动作都真的会发生），只是**没覆盖**图标这个入口的行为变化。而且商店页已经说清了 —— 审核员看到的是对的。

- **最小改法**：`OnboardingSteps.tsx:62` 那一行补一句，例如「点扩展图标只会打开这个页面，不会动你的标签页；要收起来请用下面的按钮（或右键图标 / Ctrl+Shift+S）」。

---

## 我撤回的判断（复核后不成立）

1. **「点扩展图标会先存掉整窗并关闭标签，导致引导第 2 步必然失败」** —— **撤回（审计中途被并发修复）**。
   - 我最初的判定基于 `src/service-worker.ts` 的旧 `action.onClicked`（`showNotification` → `saveAllTabs` → `openTabManager(true)`），并用探针复刻出「`savedCount:2` → 标签全关 → 窗口只剩 `about:blank` + 扩展页 + `chrome://newtab/`」这条链，据此判为 P0。
   - **复核方式**：审计中途并行 agent 改了 `src/service-worker.ts:429-438`（只调 `openTabManager()`，不保存不关标签），并新增 `tests/guards/iconClickIsNonDestructive.test.ts` 钉住「图标点击不得销毁当前窗口」。我**重建 dist 后重跑探针**：`P1_URL_BEFORE == P1_URL_AFTER` ⇒ 标签存活；按引导第 2 步点「保存并关闭」⇒ `btnText = "已保存 2"`，正常。
   - ⇒ 该结论**作废**。留下的残余缺口已降级为 **P2-16**（引导没说明图标行为变了）。

2. **「引导触发会丢」的两条记忆仍然成立** —— 复核后**不成立，已修好**。
   - 复核方式：**跑** `scripts/prod-onboarding.mjs`（真 Chrome）16/16 全绿（含「版本推进 + 重启后触发信息仍是 install」与「看完/跳过后跨重启不再回来」）；**读** `src/utils/onboardingStorage.ts` 的 `recordOnboardingTrigger`（合并而非覆盖 + 「已看过」写侧闸门）与 `shouldShowOnboarding`（读侧闸门）；**读** `src/core/onboardingTrigger.ts`（`compareVersionStrings` 逐段数值比较 + `isFeatureBearingUpdate` 方向性）。三条修复都在，`src/components/layout/HeaderDropdown.tsx` 也有「使用引导」重看入口（真机点它引导真的重放）。
   - ⇒ 任务第 1 问「现在修好了吗」的答案是：**是**。

3. **「首次安装的引导不出现」** —— 不成立。同上，16/16 通过。

4. **「引导高亮目标与 DOM 选择器对不上」** —— **部分不成立**。`Header.tsx` 的 aria-label 与 `OnboardingGuide.tsx` 的 `spotlightTarget` **逐字对得上**（跑出来的：步骤 1/2/4 的 ring 都存在）。**唯一对不上的是第 4 步的运行时存在性** —— 已单列为 P0-1。
   - 顺带撤回：`OnboardingGuide.tsx` 旧选择器（`button[aria-label^="恢复整个会话"]`）**确实**匹配不到任何元素，注释与 `tests/a11yLists.test.ts` 的守卫都成立。

5. **「引导不能跳过 / 跳过后回不来」** —— 不成立。跑出来的：菜单里确有「使用引导」，真机点它引导重放。

6. **「设置页让用户去找一个不存在的菜单」** —— 不成立（2026-10-20 已修）。**读** `src/components/layout/backendStatus.ts` 的 `autoSyncBlockedCopy(status, isAuthenticated, loginEntry)` —— 管理页传 `'菜单'`、设置页传 `'本页'`（`src/options/OptionsPage.tsx:501`），且 `src/options/optionsAccount.ts:82` 说「请在本页点「登录 / 注册」」。**跑出来的**：真机点顶栏「上传」「下载」→ toast =「还没有登录 TapStack 云端，登录后同步才能使用。请先点右上角「⋯」菜单里的「登录 / 注册」」。指向存在的入口（但**字面量**已被 L-6 改动删掉，见 P0-2 —— 这里撤回的是「入口不存在」这半句）。

7. **「Toast 有英文大写类型词（SUCCESS/ERROR/WARNING）」** —— 不成立。`src/components/common/Toast.tsx` 的 `TYPE_LABEL` 已把四种类型译成「完成/出错/提示/注意」。全仓扫 `showToast(...)` 里含 3+ 大写字母的调用：**零命中**（复核方式：`grep -rnE "(showToast|showAlert|showConfirm|showNotice)\(\s*['\"\`][^'\"\`]*[A-Z]{3,}" src/` 无输出）。

8. **「残留英文」** —— 基本不成立。扫出的英文串全部在 `logError/logWarn/logInfo` 的**日志**里，不进 DOM；用户可见文案里的英文只有 `OneTab`、`URL`、`JSON`、`WebDAV`、`TapStack` 这类专有名词。

9. **「点扩展图标后什么都没发生」** —— **撤回**。我最初怀疑 `service-worker.ts:410` 的 `showNotification` 是静默的；复核 `src/background/TabManager.ts` 的 `showNotification` 后确认：`kind:'error'` 永远发，只有 `success` 受 `settings.showNotifications` 开关约束，而**失败路径确实会发通知**（跑出来的：捕获到一次 `chrome.notifications.create`，message =「当前窗口里没有可保存的标签页」）。真实缺陷是**成功**路径在默认设置下无通知，不是「全部静默」。

10. **「引导里承诺了自动同步但自动同步默认关 ⇒ 引导在撒谎」** —— **部分撤回**。复核 `src/services/syncEngine.ts` 后确认：**上传**（`scheduleUpload`）**不受** `syncEnabled` 门控，**登录后拉取**（`restoreAfterLogin`）也不受 —— 所以引导那句「保存后会自动同步到云端；新设备登录后会自动拉回云端的会话」**字面为真**。真正的缺陷收窄为「**默认关闭这件事在管理页没说**」，已单列为 P1-6。

11. **「搜索框 placeholder 与 aria-label 不一致 = 用户可见不一致」** —— 降级。两者差一个字，但面向不同受众（视觉 vs 读屏），且读屏用户听到的更完整。真正的跨文件不一致在 P2-13。

12. **「点开标签 = 消费该条」被引导说反了** —— 不成立。`src/components/onboarding/OnboardingSteps.tsx:146` 明确写「未锁定的会话恢复后即从列表移除」并教用户「想反复使用同一组，请先锁定该会话」，与 1.24.1 的定案**一致**。

---

## 未能验证项（受环境限制，非遗漏）

1. **真机上「人工点工具栏扩展图标」**：Playwright 无此 API，我**没有真正点击浏览器工具栏的扩展图标**。图标路径的结论（标签不被关闭、引导第 2 步可正常保存）是用探针**复刻** `action.onClicked` 的内部调用得到的，SW 代码同源。建议负责人手工点一次确认。
2. **窄屏（400px）下部分 UI 表现**：只验了保存按钮的错误文案（P1-4）。空态 CTA、引导卡、筛选面板在窄屏下的其他表现未逐一验（`scripts/prod-onboarding-narrow.mjs` 存在但未跑）。
3. **读屏实际播报**：无障碍断言全部基于源码与 `aria-*` 属性，**没有真实读屏软件验证**。
4. **真机 Chrome 的扩展右键菜单 `tab` 上下文**：只读了特性探测代码，**未在 Chrome <150 上实测**（P2-15 由代码逻辑推出）。
5. **商店后台 / 线上商店页的真实状态**：未查 CWS API、未抓线上商店页 ⇒ P1-8/P1-9/P1-10/P2-11/P2-12/P2-15 全部是**仓库内 `CHROMEWEBSTORE.md` 与实现的对照**；线上 listing 是否逐字相同未验。
6. **真实云盘服务（坚果云 / Nextcloud）的协议行为**：未验。
7. **工作区在审计期间被外部并行修改两次**（这是本轮最重要的环境限制）：
   - 第一次：`HeaderDropdown.tsx` 删掉独立的「登录 / 注册」菜单行（`2026-10-22 审计 L-6`）⇒ **P0-2 由它直接引入**。
   - 第二次：`service-worker.ts` 把 `chrome.action.onClicked` 改成「只打开管理器」（配 `tests/guards/iconClickIsNonDestructive.test.ts`）⇒ **我的原 P0-3 因此作废**（见「我撤回的判断」第 1 条）；同时 `manifest.json` 的 `default_title`、`CHROMEWEBSTORE.md:37` 都同步改了。
   - 审计结束时 `git status` 显示 **26 个文件**有未提交改动（源码 19 + 测试 7，另有多个新增文件）。**这不是我改的**（本轮严格只读，探针全在 `/tmp` 且已删，`dist` 是 gitignored 的构建产物）。
   - **对结论的影响**：我**重建 dist 两次**，每条结论都在**当时的最新源码**上重验过（行号以最终状态为准）。**但负责人若要动手修，请先 `git stash`/`git diff` 核对一遍行号** —— 并行改动仍在进行，行号可能再次漂移。
8. **`tests/` 守卫的实测**：本轮**没有跑** `node --test`（只读审计不需要执行）。我对 `tests/a11yLists.test.ts` / `tests/restoreFeedbackHonesty.test.ts` 的判断是**读断言源码**得出的，不是运行结果。

---

## 汇总表

| # | 级别 | 一句话标题 | 位置 | 最小改法 |
|---|---|---|---|---|
| P0-1 | P0 | 全新安装（0 会话）时引导第 4 步聚光灯整个消失，守卫是源码级的、守不到 | `src/components/onboarding/OnboardingGuide.tsx:60-61`；`tests/a11yLists.test.ts:459-485`；`scripts/prod-onboarding.mjs` | target 加 fallback 到搜索框；守卫加**运行时**断言（逐步断言 ring 存在） |
| P0-2 | P0 | 引导承诺「右上角菜单『登录 / 注册』」，菜单里只有「去登录」（工作区改动引入） | `src/components/onboarding/OnboardingSteps.tsx:175`；`src/components/sync/syncPreviewView.tsx:184,229` | 三处改成实际存在的「去登录」，或提共享常量 |
| P1-3 | P1 | 保存失败在窄屏完全不可见（`error` 分支被 `sm:hidden` 吞掉） | `src/components/layout/Header.tsx:511-526` | 窄屏分支加 error 分支，或失败改走 toast |
| P1-4 | P1 | 搜索页「恢复整组/点开单标签」零成功反馈（锁定分支成功失败都无声） | `src/components/search/SearchResultList.tsx:379,419-427,441-450` | 复用 `restoreFeedbackCopy.ts` 已有文案补三处 + 补守卫 |
| P1-5 | P1 | 「自动同步默认关闭」在管理页上完全没说，用户以为登录=开同步 | `src/components/onboarding/OnboardingSteps.tsx:175,193`；`src/utils/storage.ts:302`；`src/options/OptionsPage.tsx:564-568` | 引导补默认状态说明；菜单加一行状态说明（商店文案 `CHROMEWEBSTORE.md:137` 已写对，照抄） |
| P1-6 | P1 | 锁定会话点开单标签**谎报成功**（不看回包 success） | `src/components/tabs/TabGroup.tsx:451-461` | 照抄同文件未锁定分支的 success 门 |
| P1-7 | P1 | 「回到默认视图」只清搜索词不清筛选，只靠筛选时点了零反应 | `src/components/layout/Header.tsx:285-287`；`src/components/search/searchBrowseMode.ts:68-74` | 提升 useSearchFilters 到 App 层 / 或改文案 |
| P1-8 | P1 | 商店承诺的「域名徽章」不存在（审核员可见正文） | `CHROMEWEBSTORE.md:110` vs `src/components/tabs/TabGroup.tsx:969` | 改文案 |
| P1-9 | P1 | 权限表说会话数据存 chrome.storage，与隐私政策的 IndexedDB 说法矛盾 | `CHROMEWEBSTORE.md:134` | 改文案 |
| P1-10 | P1 | Known Issues「多设备同步要求登录」与自带存储矛盾 | `CHROMEWEBSTORE.md:425` | 改文案 |
| P2-11 | P2 | Known Issues 抹掉「删最后一条会先确认」这个例外（同文件 `:42` 已写对） | `CHROMEWEBSTORE.md:427` | 改文案 |
| P2-12 | P2 | 默认会话名用「标签组」，产品其它地方叫「会话」 | `src/domain/tabGroup/sessionName.ts:16-19` + `CHROMEWEBSTORE.md:38` | 两处一起改（改一处就变谎报） |
| P2-13 | P2 | placeholder 没提 URL，引导却教了能搜 URL | `src/components/layout/Header.tsx:426` vs `src/components/onboarding/OnboardingSteps.tsx:108` | placeholder 补 URL |
| P2-14 | P2 | 同步成功路径一句话不说 | `src/components/sync/SyncButton.tsx` | 补成功 toast |
| P2-15 | P2 | 「右键标签标题」在 Chrome<150 不存在，但 min 是 120 | `CHROMEWEBSTORE.md:37` vs `src/service-worker.ts` 特性探测 | 提 min 到 150 或加限定 |
| P2-16 | P2 | 图标改成「只打开管理器」后，引导没说明这个变化 | `src/components/onboarding/OnboardingSteps.tsx:62-64` | 补一句「点图标不会保存」 |

> 原 P0-3（点图标会先存掉整窗并关标签）已作废 —— 见「我撤回的判断」第 1 条。
