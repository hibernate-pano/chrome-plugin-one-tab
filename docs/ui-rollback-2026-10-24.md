# UI 回退到 v1.25.1 —— 判据与工作包（2026-10-24）

> 这份是**施工单**，不是发版记录。发版记录在 `docs/RELEASE-NOTES.md`。
> 目标版本：**v1.25.1**（tag `v1.25.1`，10-20 上架那版）。

## 一句话目标

**界面与交互回到 v1.25.1 的样子；1.27.0 的后端与安全修复一条不退。**

## 为什么是 v1.25.1

产品负责人 2026-10-24 的判断：「当前 UI 和设计的交互可能还需要再往前推一版」，
并指认 **v1.25.1**。⇒ 1.26.0（第 42 轮审计）那次改造同时动了**图标语义**与
**59 个文件的界面/交互**，那是这次要退掉的对象。

## 三条判据（**只按这三条分**，不靠感觉）

| 类别 | 判据 | 例子 |
|---|---|---|
| **长相**（退） | 改的是「看起来什么样 / 点下去之前怎么呈现」 | 卡片图标形状、卡头徽章、按钮排布、域名在标签行的位置、排序下拉的位置、引导页配色 |
| **功能**（留） | 改的是「能做到什么 / 出错时说不说实话」 | 撤销回执、删除确认、锁定豁免、跨设备披露、危险 URL 拦截、首次读取闸门、换账号提示、窗口化性能 |
| **结构**（留） | 改的是「代码怎么组织」，用户看不见 | 令牌化（`--radius-btn` / `--color-card-head-bg`）、动效阶梯（`--motion-*`）、主题预览支持（`[data-theme=x]` 选择器） |

**结构那一类特别说明**：1.26.0/1.27.0 把 6 套主题的圆角/卡头底色/动效**令牌化**了。
令牌化本身用户看不见（值没变的地方等于没改），而且它修掉了「4 种按钮形状」
「6 套主题各写各的」这类离群值 ⇒ **结构留着，值不动**。
⇒ 结论：**`src/styles/**` 整个不动**（除下面 §三 明确列出的例外）。

## 退掉的具体长相清单（照着这个退，别自己发挥）

### 1. 会话卡（`src/components/tabs/TabGroup.tsx`）
- 两枚「打开」图标 → 回到 v1.25.1 的形状（新的那版把「开新窗口」改成缺口框+出界箭头）
- 锁定图标 → 回到 v1.25.1（新的那版画「闭=已锁 / 开=未锁」两态）
- 卡头：favicon、徽章、日期、按钮的**排布与形状** → v1.25.1
- 标签行：域名回到**右对齐**（新的那版挪到标题同行）
- 卡片阴影/圆角 → v1.25.1

### 2. 顶栏（`src/components/layout/Header.tsx`）
- 按钮**排布与图标** → v1.25.1（1.27.0 的顶栏少了两个按钮、搜索框变宽、「8 标签」改成「8 个标签页」）

### 3. 菜单（`src/components/layout/HeaderDropdown.tsx`）
- 菜单项的**增删与排布** → v1.25.1

### 4. 搜索页（`src/components/search/SearchResultList.tsx` / `SearchFilterPanel.tsx`）
- 结果行布局、筛选面板长相 → v1.25.1
- ⚠️ **「排序」下拉是 1.26.0 新增的功能** —— 它是**功能**不是长相 ⇒ **留着**，
  但要放回 v1.25.1 的位置与长相（见下面 §三）

### 5. 引导（`src/components/onboarding/OnboardingSteps.tsx`）
- 引导的配色/布局 → v1.25.1

### 6. 主题选择器（`src/components/layout/ThemeStyleSelector.tsx`）
- 预览卡长相 → v1.25.1

## 三条**不许**退的东西（1.27.0 的真修复，退了就是把 bug 放回去）

1. **点扩展图标 = 保存当前窗口并关闭**（2026-10-24 产品负责人定案）
   —— `src/background/iconClickAction.ts` + `service-worker.ts` 的 `onClicked`
   + `TabManager.openTabManager(shouldRefresh, windowId)` + `saveAllTabs` 里
   带 `windowId` 的占位新标签。**这一整套不许动。**
2. **会话名筛选去首尾空白**（F2，`src/components/search/searchFilterAvailability.ts`）
   —— 它是**判据层**的修复，退了会让「徽章说 0 个筛选、列表已被筛空」。
3. **首次读取闸门 / 换账号提示 / 退出登录说明 / 导入导出诚实度 / 撤销回执** ——
   全部**功能**，必须在新长相上重新接回去。

## 守卫怎么办（**最重要的一条**）

守卫分两类，处理方式**相反**：

- **钉「长相」的守卫**（U-xx / V-xx 视觉审计那批、以及钉新图标/新徽章/新排布的）
  ⇒ **连守卫一起退**，并在守卫文件头写清楚：
  「2026-10-24 产品负责人要求界面回到 v1.25.1 ⇒ 本守卫钉的那条设计约定不再成立。
  退掉它的是**产品决定**，不是偷懒。」
  ⇒ **不许直接删文件**：要么改判据成 v1.25.1 的口径，要么删掉那条断言并留原因。
- **钉「功能/诚实度」的守卫** ⇒ **守卫一条不许退**，必须在回退后的界面上**重新接上**那条能力。
  「接不上」不是退守卫的理由。

⚠️ 本仓的硬规矩：**每条新守卫都要有变异自证**（改了实现必须变红）。
退掉一条守卫 = 少一条防线 ⇒ 退之前先确认它钉的**不是**别的东西。

## 验证口径（不许用「看起来差不多」交差）

- 全量 `pnpm test` 必须绿（退掉的守卫要先改判据，不许留红）
- `pnpm type-check` / `type-check:tests` / `lint` / `lint:tests` 全绿
- **截图对比**：`scripts/shot-ui.mjs`（本轮新增）拍管理页/搜索/设置页，
  与 `outputs/shot-ui-v1251/`（v1.25.1 的实拍）逐张比
- 真机：`scripts/lead-verify-icon-click.mjs` 仍要绿（点图标那条路没被碰坏）

## 工作包（互不重叠，可并行）

| 包 | 源文件 | 守卫 |
|---|---|---|
| **A（我）** | `tabs/TabGroup.tsx`、`tabs/TabList.tsx`、`tabs/lazyTabRows.ts`、`dnd/DraggableTabGroup.tsx`、`dnd/DraggableTab.tsx` | `sessionCardActions`、`consumeUndoWiring`、`toastUndoReachability`、`lockedTabDeleteGuard`、`moveEmptiesSessionFeedback`、`restoreOutcomeHonesty`、`deleteEntryAriaLabel`、`perf03CardWindowing*`、`audit20261023UiVisual`(U-10/U-11/U-15/U-18/U-21) |
| **B** | `search/SearchResultList.tsx`、`search/SearchFilterPanel.tsx`、`search/searchBrowseMode.ts` | `searchViewHonesty*`、`searchPageCopyHonesty*`、`searchFilterPanel`、`filterReachability`、`filterTrimConsistency*`、`sortControlScopeHonesty*`、`sessionSortWiring` |
| **C** | `layout/Header.tsx`、`layout/HeaderDropdown.tsx`、`layout/ThemeStyleSelector.tsx`、`layout/TabCounter.tsx` | `headerActionBudget`、`headerGeometry`、`audit20261023UiVisual`(U-01/U-23/V-3/V-4/V-5/V-11)、`audit20261019Ui` |
| **D** | `onboarding/OnboardingSteps.tsx`、`onboarding/OnboardingGuide.tsx`、`common/EmptyState.tsx`、`common/ModalFrame.tsx`、`common/AlertDialog.tsx`、`common/ConfirmDialog.tsx` | `onboarding*`、`audit20261023UiVisual`(V-1/V-2/V-8/V-12)、`uiTruthfulnessC`、`dialogButtonContrast` |

## 不许动的目录（后端与数据层，一行都不许改）

`src/core/` `src/domain/` `src/utils/` `src/services/` `src/sync-backend/`
`src/storage-kv/` `src/store/` `src/types/` `src/background/` `src/service-worker.ts`
`src/hooks/` `src/legal/`

## 补充一：A 包实测后的**例外与保留**（2026-10-24 施工时定）

上面 §三 说「`src/styles/**` 整个不动」，那是在**令牌化**的前提下说的
（令牌化用户看不见）。实测发现 CSS 里有**两处不是令牌化、是真的改了长相**
的规则 ⇒ 它们必须跟着回退，否则标签行的样子回不去。**这是对上面那条的
明确例外，只此两处**：

| 位置 | v1.25.1 | 1.27.0 | 处置 |
|---|---|---|---|
| `global.css` `.tab-item-title` | `flex-1` + `text-sm`（13px） | `flex: 0 1 auto` + `text-base`（14px） | **退回 v1.25.1** |
| `global.css` `.tab-item-url` | 无 `flex-shrink` | `flex-shrink: 0` | **退回 v1.25.1** |

这两条一起决定「域名在标签行里的位置」：v1.25.1 是**行尾右对齐**，
1.27.0 挪到了标题后面（中间空掉 700–1000px）。
⚠️ `.tab-item-title` **同时管着卡片里的标签行与搜索结果行** ⇒ 退一次两边一起回退。

**明确保留的（看起来像长相，其实是功能/安全，退了就等于把 bug 放回去）：**

1. **`.btn-icon` 的 36×36 命中区下限**（U-02，WCAG 2.2 SC 2.5.8）
   ⇒ 卡头按钮比 v1.25.1 略大一点点（28px → 36px），**不退**。
2. **卡片头用仓里的 `<Tooltip>`**（U-18）而不是原生 `title=`
   ⇒ 悬停提示、触屏可达、读屏引用，**不退**（原生 title 在触屏上永远不出现）。
3. **会话标题的 `role="button"` / `aria-describedby` / 锁定态不给 `cursor-pointer`**
   （L-8）—— 退了就变成「看起来能点、点了什么也不发生」，**不退**。
4. **锁定按钮 tooltip 里「现在是什么状态 + 点了会发生什么」**（U-11 / H-8）—— **不退**。
5. **恢复按钮提示里的后果说明**（WC-1，锁定会话不会被消费）—— **不退**。
6. **PERF-03 窗口化**（卡片远离视口只留等高占位、折叠态住在列表层）—— **不退**。
7. **撤销回执 / 成功门 / 锁定豁免 / 跨设备披露** —— **不退**。
8. **顶栏「上传 / 下载」两颗按钮的配色**（v1.25.1：上传=绿、下载=蓝；
   现在：都走 `theme-accent-soft` + `theme-accent-text`）—— **不退**。
   原因是对比度：v1.25.1 的 `text-green-600` 压 `bg-green-100` 实测只有 **≈3.0:1**，
   低于 AA 4.5:1。守卫 `tests/guards/themeContrast.test.ts` 钉着
   「这两颗必须走 accent 令牌、顶栏不得再出现写死灰阶」⇒ 改了它就等于改一条
   对比度守卫。**代价是绿/蓝的语义区分没了**（两颗同为 accent 色），如实记在这里。

⚠️ **截图对比时要预期到的两处差**（不是漏退）：
   · **标签行 44px → 54px**、卡头 45px → 53px —— 因为 `.btn-icon` 的 36px 命中区（上面第 1 条）。
   · **上传/下载两颗按钮同色** —— 上面第 8 条。
   两处都用 Playwright 量过真实几何，不是目测。

## 补充二：一条**新的文案口径**（紧凑处用短形式，句子里用全名）

1.27.0 的审计 H-10 要求「同一个实体不许几种叫法」，把顶栏的「N 标签」与
卡头的裸数字都改成了「N 个标签页」。界面回到 v1.25.1 ⇒ 这两处**紧凑的
计数器**恢复短形式，但**句子里的全名要求一条不退**：

| 位置 | 写法 | 谁在守 |
|---|---|---|
| 顶栏计数药丸 | `N 标签`（短形式） | `onboardingCopyHonesty` H-10 |
| 卡片数量徽章 | 裸数字（单位在 `aria-label` 里） | 同上 |
| 删除确认 / 保存提示 / 恢复提示 / 引导 | **N 个标签页**（全名） | 同上 + `lockedDeleteCopy` |

⇒ 改这条规则时**四处都要跟着改**（判据 / 守卫 / 对外文案 / 预览文案）。

## 补充三：引导页配色**也回退**（2026-10-24 拍板）

引导页的**布局**在 v1.25.1 与今天**逐字相同**（DOM、栅格、emoji 插图、
按钮排布都没变）⇒ 唯一真实的长相差是**配色**，而它整个住在
`src/styles/onboarding.css` 里（这个文件**不在任何 `@layer` 里** ⇒
组件层加任何 Tailwind 类都压不住它，伪元素的彩虹描边与深色分支更没法在
组件层还原）⇒ **要还原必须动那个 CSS 文件**。

**决定：回退。** 理由：产品负责人说的是「界面回到 v1.25.1 的样子」，
引导页是界面的一部分；不能因为「审计觉得新配色更好」就替他保留一版
他不想要的界面。

**动 CSS 时的硬约束：**

| 留 | 退 |
|---|---|
| 1.26.0 新增的**焦点环抑制规则**（那圈 2px 蓝框的修复） | 五色彩虹描边 → 回到 v1.25.1 |
| `--motion-*` 动效阶梯（结构） | 紫蓝渐变主按钮 → 回到 v1.25.1 |
| 写死色里**加深刻一档**后的取值 | 卡内层 / 标题 / 说明 / 特性卡 / 版本徽章 / 步骤点 / 图标底 的写死色 + `.dark` 覆盖 |

⚠️ **唯一一处明知与 v1.25.1 不逐字相同的地方**：v1.25.1 的主按钮
`#667eea` 上白字只有 **3.66:1**（AA 正文线 4.5:1 不达标）⇒ 把紫
**加深刻一档**（≈`#5b5bd6`），观感几乎一样，而**对比度守卫一条都不用退**。

## 补充四：菜单里那行「登录 / 注册」随 v1.25.1 恢复（2026-10-24）

### 事实

v1.25.1 的 ⋯ 菜单里**同时**有两个登录入口：

| 入口 | 位置 | 字面量 | 条件 |
|---|---|---|---|
| 内联链接 | 状态卡里，紧挨「TapStack 云端 · 未登录」 | `去登录` | `syncStatusView.needsLogin` |
| 独立菜单行 | 菜单正文，带图标 | `登录 / 注册` | `!isAuthenticated && settings.syncBackend !== 'webdav'` |

两者**条件逐字相同、动作也相同**（都开同一个登录弹窗）。
1.26.0 审计 L-6 以「一个菜单里两个同义入口看起来像没设计完」为由删掉了
独立行，并把全部文案改名为「去登录」（抽出常量 `MENU_LOGIN_LABEL`）。

### 决定：**恢复独立行**（产品决定）

它是**菜单项的增删**（长相）⇒ 随 v1.25.1 一起退回来；而且它本来就是仓里
**其他文案指向的那个入口**（`src/options/optionsAccount.ts` 头部：
「真实可用的登录入口在管理页的「⋯」菜单里（…「登录 / 注册」）」）
⇒ 删着的时候那句指针变成**死指针**（与「指向不存在的菜单」同一类缺陷）。

⚠️ **两个同义入口是已知且被接受的代价**，不是遗漏：用户要的是那一版的样子，
不是审计的审美偏好。

### 守卫怎么办（`tests/syncStatusHonesty.test.ts`）

那条 `doesNotMatch(MENU, /登录 \/ 注册/)` 钉的是 1.26.0 的**长相决定**
⇒ **改判据**，不是删文件：

| 退掉 | 换成钉住的不变量 |
|---|---|
| 「菜单里不许有独立的「登录 / 注册」行」 | ① 这一行存在，且条件仍是「未登录 && 非自带存储」<br>② 它带 `role="menuitem"`（读屏的菜单键盘模型）<br>③ 它真的调 `onOpenAuth('login')`（不许是摆设按钮） |

不变的部分：内联「去登录」仍由 `syncStatusView.needsLogin` 驱动
（自带存储用户恒为 false ⇒ 他们看不到任何登录入口）。

**变异自证**：把条件里的 `settings.syncBackend !== 'webdav'` 换成 `true`
⇒ 守卫变红（已验）；改回 ⇒ 变绿。

### 文案口径：**继续说「去登录」**，不改

1.26.0 审计 P0-2 立的契约是「**文案不许承诺一个不存在的字面量**」。
独立行恢复后，状态卡里的「去登录」**仍在**（没登录时它一定在）
⇒ 契约仍然成立，不需要改任何正文。

- 引导第 4 步、同步预览两处、空白态提示：**全部继续用 `MENU_LOGIN_LABEL`**。
- 独立行**不承载任何文案指针**（文案从不点名它）⇒ 两行并存不会让用户找不到按钮。

⇒ 与补充二同理：**语义规则没变，就不用动四处**；只有规则变了才连带改。

### 连带修掉的两处「文档在教不存在的规则」

| 位置 | 原来 | 现在 |
|---|---|---|
| `src/components/common/menuLabels.ts` 文件头 | 「删掉是对的」 | 写明两个入口并存、各自字面量、以及正文只指向「去登录」 |
| `src/options/optionsAccount.ts` 文件头 | `HeaderDropdown:805`（行号已过期） | 改成按内容指认（带图标的「登录 / 注册」那一行） |


