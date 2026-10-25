# 安静的成功 —— TapStack 提示体系收口设计

日期：2026-10-25
状态：待实现（本文件是实现的唯一依据）

---

## 1. 意图与为什么

产品负责人 2026-10-25 的要求：

> 遵循 Unix 的设计哲学，保持简洁安静。成功时无需过多提示，甚至无需提示，仅在出错时发出提醒。
> 对用户而言，一个好用的工具远比吵吵闹闹的工具强得多。

**为什么现在做**：本仓 2026-10-20 ～ 10-22 的三轮审计连续加了几条「成功必须出声」的规则
（`restoreFeedbackHonesty.test.ts` 的 A-1/A-2、`lockFeedbackCopy.ts` 的 L-9、
`auth/restoreFeedbackCopy.ts` 的 SC-6）。那些规则**各自都修掉了真缺陷**，但它们是按
「点了就要说话」立的，没有区分「这件事的结果界面自己说不说得出」。

结果是：每点开一个标签、每锁一个会话、每同步一次、每导入一次，屏幕上都要弹一张绿色的
「完成」卡片。**吵的不是错误（错误只在出事时响），是成功。**

值得注意的是，v1.20.2（2026-09-24）的发版说明里本来就写着「成功操作静默」—— 产品曾经
是这个样子的，是后来的审计把它推成了现在这样。**这次不是回退审计，而是把每条「必须出声」
的规则收窄到「界面表达不了的那部分」。**

---

## 2. 目标 / 非目标 / 反目标

### 目标

1. **结果能自己说话的，就让它自己说** —— 界面状态就是回执。
2. **界面表达不了的，说事实，不说「成功了」** —— 说「N 个读不出来」「N 条没移除掉」，
   不说「已恢复 8 个标签页 ✨」。
3. **失败照旧，而且更醒目** —— 错误是这套体系里唯一该抢注意力的东西。
4. **不能再吵回来** —— 收口必须是**编译期 + 守卫**双重保证，不是靠自觉。

### 非目标

- 不改任何数据语义、不改同步逻辑、不改存储格式。
- 不动 `chrome.notifications`（浏览器系统通知）。它已经「默认关 + 失败必发」，是合规资产
  不是噪音源；动它会牵连隐私政策与商店页的措辞。
- 不动撤销机制本身（8 秒窗口、键盘焦点接管、`toastUndoReachability` 的 36 条断言）。
- **不动 22 个 `showAlert` 错误模态**（产品负责人 2026-10-25 决定：这轮不做，以后再评估）。
  错误模态本来就是「你确实需要停下来看」的那一类。
- 不动就地方案里那些与 toast 无关的 `success` 字面量（见 §6.1 的命名空间清单）。

### 反目标（做到就算失败）

- ❌ **把成功提示全删了**，包括界面表达不了的事实（那会让产品开始撒谎）。
- ❌ **把「恢复即消费」的撤销退路删了**（那会让不可逆操作没有退路）。
- ❌ **删提示时顺手把成功门（先判 `success` 再报）也删了**（那会把拒开变成静默失败）。
- ❌ **只改文案不改判据**（下一个人照样能随手撒提示）。

---

## 3. 现状梳理（2026-10-25 实测，行号已逐条核对）

| 出口 | 数量 | 备注 |
|---|---|---|
| `showToast` 直接调用 | **72** | error 35 / success 19 / warning 7 / info 5 / 动态 6<br>（另有 1 处在 `auth/restoreFeedbackCopy.ts:9` 的注释里，不算调用） |
| `useEnhancedToast` 封装 | **47** | `showDeleteError` 28、`showRestoreError` 15、`showRestoreSuccessMessage` 4 |
| `showConsumeToast` | **7** | 住在 `src/components/tabs/useConsumeUndo.ts`（**不在** `toastHelper` 里） |
| 死 helper（零调用） | **7** | `showSaveSuccess` / `showSaveError` / `showRestoreSuccess` / `showDeleteSuccess` / `showSyncSuccess` / `showSyncError` / `showPinnedInfo` |
| 恢复类播报合计 | **11** | `showRestoreSuccessMessage` 4 + `showConsumeToast` 7 |
| `showAlert` 单按钮模态 | 22 | 手动同步失败、设置读失败、清理未完全同步… |
| `showConfirm` 双按钮模态 | 8 | 删全部、导入、首次推送… |
| 原生 `window.confirm` | 2 | `WebDavSettings.tsx` |
| 浏览器系统通知 | 15 处 `showNotification` 调用（`chrome.notifications.create` 3 处） | `kind:'error'` **必发**；success/info 受设置开关控制（默认关） |
| 徽标回执 | 1 个通道（2 处写入：写数字 + 清空） | `src/background/saveReceipt.ts` —— 点图标保存时在图标上刷数字，**不依赖任何开关** |
| 就地反馈 inline | ~14 | 保存按钮直接变「已保存 N」、空态 `saveFeedback`、设置页 hint |
| 状态行 | 2 | 菜单「上次成功同步 · N 分钟前」；`WebDavSettings` 的 `firstPush` 状态机（`kind:'done'`） |

**已经做对、本次必须保住的两件事**

1. **失败通道独立且够硬**
   - `toastPolicy.resolveToastDuration`：`error` + 无动作 + 默认时长 ⇒ **常驻**（duration 0，手动关）。
   - `toastQueuePolicy.isEvictable = !hasAction && !isError` ⇒ 错误与带撤销的提示**不会被后来者静默挤掉**。
   - `chrome.notifications` 的 error 分支**绕过开关**必发。
   - 「失败提示不受此开关影响，始终会通知」这句承诺写在**三处**：
     `src/legal/privacy.html:71`、`src/options/OptionsPage.tsx:1101`、`CHROMEWEBSTORE.md:261`。
     ⚠️ **README 里一个「通知」都没有**（`grep -c 通知 README.md` = 0）—— 别把 README 算进去。

2. **已经有两条安静的成功回执** —— 就地反馈（保存按钮直接变「已保存 N」）与图标徽标。
   这就是本设计要推广的形状。

---

## 4. 判据（唯一真理源）

### 4.1 一句话

> **结果能不能从界面状态自己看出来？能 ⇒ 沉默；不能 ⇒ 说事实。**

Unix 的映射：界面状态 = stdout（结果本身）；提示 = stderr（出错 + 界面表达不了的事实）。
**成功是状态，不是事件。**

### 4.2 三档裁决

| 档 | 什么时候 | 载体 | 例子 |
|---|---|---|---|
| `silent` | 结果完全在界面自明 | 无 | 锁定组恢复（窗口开了、卡片还在）；「云端已是最新」（同步时间行会前进成「刚刚」） |
| `fact` | 界面表达不了某个事实 | 中性 info toast，**能常驻就常驻** | 「本机 N 个会话仍保留」；「有 M 个读不出来」；导出/导入的计数 |
| `error` | 失败、部分失败、结果对不上 | 常驻 error toast（现状不动） | 恢复失败；「删了 3 条但你确认了 5 条」 |

**fact 档的时长：沿用现状 3000ms，不新增时长策略。**
需要「随时可查」的事实走**常驻位置**（菜单行 / 卡片行 / 设置项 hint），不靠 toast 撑着。

### 4.3 判据层（纯函数）

新增 `src/core/feedbackPolicy.ts`：

```ts
export type FeedbackLevel = 'silent' | 'fact' | 'error';

/** 一件事的结果，界面能不能自己说出来。 */
export type ResultVisibility = 'self-evident' | 'hidden';

export interface FeedbackInput {
  /** 结果是否完全能从界面状态看出来。 */
  visibility: ResultVisibility;
  /** 界面看不见、但用户必须知道的事实（数量对不上 / 读不出来 / 剪贴板写入…）。 */
  hiddenFact?: string;
  /** 这次操作不可逆（消费 / 删除 / 清空）。 */
  irreversible?: boolean;
  /** 有没有退路（撤销按钮）。 */
  hasEscape?: boolean;
}

export interface FeedbackDecision {
  level: FeedbackLevel;
  /** 判据本身给出的理由（供守卫与调试，不进界面）。 */
  reason: string;
}

/**
 * ⚠️ `FeedbackDecision` **不带 `message`** —— 事实文案留在调用方
 * （它本来就在那儿），判据只判「该不该出声」。
 * 早先的草稿在这里放过一个 `message?: string`，那会让调用点写成
 * `fb.message ?? msg` 这种双份真相，已在实现前删掉。
 */

export const decideFeedback = (input: FeedbackInput): FeedbackDecision => { … };
```

**判据的形状（必须是这样，不能是散落的 if）**

- `visibility === 'self-evident'` 且没有 `hiddenFact` ⇒ `silent`。
- 有 `hiddenFact` ⇒ `fact`（说那个事实，不说「成功了」）。
- 不可逆且界面不自明 ⇒ 至少 `fact`；不可逆且**没有退路** ⇒ `error`（不许静默地吃掉一次不可逆操作）。

**所有会出声的成功点都必须经过这个函数**，不允许组件自己拍脑袋决定说不说。

---

## 5. 逐条裁决

### 5.1 19 处 `success` 直接调用（逐个核对过行号）

| # | 位置 | 现在说什么 | 裁决 | 理由 / 改到哪去 |
|---|---|---|---|---|
| 1 | `Header.tsx:210` | 清理重复标签的结果（清掉 X 个重复标签、Y 个空会话） | **fact** | 列表会变，但「清了几个」界面表达不了；且这是**破坏性**操作。确认框里写的是「预计」，实到多少要实说 |
| 2 | `HeaderDropdown.tsx:355` | 云端已是最新 | **删** | 探活命中也写 `lastSyncTime`（`src/services/syncEngine.ts:776`）⇒ 菜单那行会前进成「刚刚」，已有安静回执 |
| 3 | `HeaderDropdown.tsx:570` | 已退出登录。本机 N 个会话仍保留，不会上传到其它账号 | **fact** | 「本机 N 个会话还留着、不会传到别的账号」界面表达不了 |
| 4 | `HeaderDropdown.tsx:638` | 已删除 N 个会话 | **条件 fact** | `deleteAllSuccessMessage`（`src/components/layout/deleteAllMessages.ts:158`）共 4 种文案 / 5 个分支。**只有 `deletedCount === confirmedCount` 这一支是界面自明的**（列表空了、数量与确认的一致）⇒ 一致时静默；其余四支（实际为 0 / 少于确认数 / 多于确认数）都是界面看不见的事实 ⇒ 出声 |
| 5 | `HeaderDropdown.tsx:812` | 导出备份（N 个会话） | **fact** | 文件名在浏览器下载条可见，「N 个」不可见 |
| 6 | `HeaderDropdown.tsx:848` | 导出 OneTab（N 个会话） | **fact** | 同上 |
| 7 | `HeaderDropdown.tsx:904` | 诊断摘要已复制，请在 issue 正文里粘贴 | **fact** | 剪贴板写入界面看不见 |
| 8 | `HeaderDropdown.tsx:1377` | 导入 JSON 备份 | **fact** | 列表会变，但「导入几个 / 几个读不出来 / 几个失败」界面永远看不见。⚠️ 这条路径**不 reload 整页**（只 `dispatch(loadGroups())`），所以提示能显示完 |
| 9 | `HeaderDropdown.tsx:1502` | 导入 OneTab | **fact** | 同上 |
| 10 | `WebDavSettings.tsx:807` | 已保存，已切换到新的云盘。…这些会话暂未上传；请点下方「检查并推送到云端」 | **fact** | 里面是**用户要做的下一步**，不是播报 |
| 11 | `WebDavSettings.tsx:1082` | 推送完成 | **删** | `firstPush` 状态机已就地渲染 `kind:'done'`（`WebDavSettings.tsx:1716`）⇒ 重复 |
| 12 | `WebDavSettings.tsx:1184` | 已从云端下载到本机 | **删** | 同上 |
| 13 | `WebDavSettings.tsx:1265` | 已切回 TapStack 云端。云盘上的文件不会被删除 | **删** | 后端选择器变了 ⇒ 自明 |
| 14 | `WebDavSettings.tsx:1342` | 已清除本机保存的云服务信息… | **删** | 表单被清空 ⇒ 自明 |
| 15 | `WebDavSettings.tsx:1400` | 已锁定：后台同步已停止，需要重新输入应用密码与加密口令 | **删** | 密码 / 口令输入框被清空 ⇒ 自明 |
| 16 | `OptionsPage.tsx:494` | 已退出登录 | **删** | 账号区状态变了 ⇒ 自明 |
| 17 | `OptionsPage.tsx:588` | 已开启自动同步，每 N 分钟同步一次。关闭浏览器后需重新输入应用密码才会继续 | **删** | 开关翻了 ⇒ 自明；后半句是**常驻属性** ⇒ 搬进该设置项的 hint |
| 18 | `OptionsPage.tsx:712` | 已切回 TapStack 云端，自动同步已关闭。云盘上的文件不会被删除 | **删** | 选择器状态变了 ⇒ 自明 |
| 19 | `TabGroup.tsx:448` | 已锁定。该会话不会被「清理重复标签」清理，也不能重命名或逐条删除；恢复后它仍会留在列表里 | **改成常驻**（见 §5.3） | 这是**规则披露**不是播报 |

### 5.2 恢复类 11 处播报

**判据：这次操作的结果，界面自己说不说得出？**

| 情形 | 位置 | 界面看得见吗 | 裁决 |
|---|---|---|---|
| **锁定组**整组恢复 | `TabGroup.tsx:567`、`SearchResultList.tsx:583` | 新窗口开了 N 个标签（看得见）+ 卡片**仍在列表里**（`consumeSession()` 对锁定组直接 return，不 dispatch 删除 —— `TabGroup.tsx:491`） | **删** |
| **锁定组**点开单标签 | `TabGroup.tsx:629`、`SearchResultList.tsx:637` | 页面打开（看得见）+ 那行**还在会话里**（锁定分支从不调 `deleteTabAndSync`） | **删** |
| **未锁定**整组恢复 | 同上两处 | 卡片从列表消失 ⇒ 分不清「打开了」还是「被删了」 | **保留** + 撤销退路（不可逆、无回收站） |
| **未锁定**点开单标签 | `TabGroup.tsx:672`、`SearchResultList.tsx:669` | 行消失 + 页面打开 ⇒ 同上 | **保留** + 撤销退路 |
| 批量恢复（搜索页） | `SearchResultList.tsx:880` | 打开了几个 / 移除了几个 / 锁着留下了几个 / 打不开几个 —— **四笔账界面都表达不了** | **保留**（fact） |
| 部分成功（跳过打不开的） | `TabGroup.tsx:543`、`SearchResultList.tsx:558` | — | **保留**（error 型 + 撤销）—— 现状不动 |
| 拖走最后一条标签 ⇒ 源会话消失 | `TabGroup.tsx:710` | 少了一张卡，但**是哪个会话、去了哪**界面说不出来 | **保留**（fact） |
| 撤销提示本身 | `useConsumeUndo.ts:71` | — | **保留**，换中性外观（见 §5.4） |

⚠️ **删锁定分支播报时，绝不能顺手删掉成功门。**
锁定分支里现在先判 `r.success !== true`（失败 → `showRestoreError`）再播报成功。删掉播报后，
**成功门必须留下**，否则 SW 拒开时会变成「什么都没发生」的静默失败 —— 那比谎报成功更糟。

`restoreFeedbackCopy.ts` 里 `openSingleTabSuccessMessage(isLocked)` 与
`restoreGroupSuccessMessage(count, isLocked, inCurrentWindow)` 的 **locked 分支随之成为死分支**，
一并清掉（`inCurrentWindow` 参数必须保留 —— 2026-10-25 定案「在当前窗口打开」是主操作）。

### 5.3 锁定说明：4 秒 toast → 常驻一行；解锁完全静默

锁定不是播报，是**规则披露**：它改了「恢复之后这个会话还在不在」这条本产品唯一会被说反的规则
（未锁定 ⇒ 恢复即消费；已锁定 ⇒ 保留可反复用）。toast 一关就没了。

**锁定后**：卡片上**常驻一行**小字，文案由 `lockFeedbackCopy.ts` 派生：

```
已锁定 · 恢复后保留在列表 · 不会被「清理重复标签」清理
```

**解锁后**：该行消失。**解锁完全静默 —— 不出提示。**

产品负责人 2026-10-25 的判断依据（写进本文件以免以后反复讨论）：

- 锁定的后果由**卡片常驻行**承担 ⇒ 随时可查。
- 未锁定的后果**本来就**写在恢复按钮的提示与 `aria-label` 上
  （`restoreOutcomeSentence(false)` = 「恢复后该会话会从列表移除，可撤销」）⇒ 也随时可查。
- 解锁是**移除**保护、回到默认行为；危险的方向是「锁定」（用户以为消费了其实没消费），
  不是「解锁」。
- 锁图标消失本身就是反馈。

- 好处：随时看得到；不占屏幕中心；不用盯着那 4 秒。
- 成本：卡片多一行字 ⇒ **密度要再调一次**（v1.28.3 刚收过一次密度，记忆里有
  「标签列表密度是产品级诉求」的定案 —— 这行是**说明**，不是**留白**，不违反那条）。

### 5.4 撤销提示：保留机制，去掉庆祝皮

「恢复即消费」是最高频且**不可撤销**的动作（无回收站），撤销按钮是唯一退路，
README:45 与 README:139-140、商店页 `:160` 都承诺了 ⇒ **必须留**。

但它现在是**绿色的成功卡片**。改：

- **视觉中性**：用 `info`（主题色），不用 `success`（绿）。顶部进度条、图标徽章一起变中性。
- **保留**：8 秒窗口、键盘焦点接管（`toastUndoReachability` 的 36 条断言一条都不能掉）、
  `autoFocus: true`（`useConsumeUndo.ts:90`）、队列不可静默挤掉。
- **文案瘦身**：现在点开一个标签要说「已打开该标签页，并从会话中移除该条记录。」——
  保留「记录被移除了」这个**界面表达不了的事实**（这是消费语义，必须说），
  去掉解释性铺陈（「该标签页」这种指代当前动作的词）。

---

## 6. 落地机制（本仓纪律：判据 / 守卫 / 对外文案 / 预览文案，四处齐改）

### 6.1 类型层：从 API 上删掉 `success`（**只删 toast 这一层**）

⚠️ **`'success'` 这个字面量在仓库里同时活在 8 个互不相干的命名空间里。**
本设计**只动 toast 那一层**，其余全部保持原样：

| 命名空间 | 位置 | 本次动不动 |
|---|---|---|
| **toast 类型** `ToastType` / `ToastKind` | `src/components/common/Toast.tsx:15`、`src/components/common/toastPolicy.ts:71` | **动** —— 删掉 `'success'` |
| **toast 默认值** | `Toast.tsx:107`、`src/contexts/ToastContext.tsx:96`（两处 `= 'success'`） | **动** —— 改成 `'info'` |
| **toast 消费通道** `useConsumeUndo.opts.type` | `src/components/tabs/useConsumeUndo.ts:48-52,63`（`'success' \| 'error'`） | **动** —— 改成 `'info' \| 'error'` |
| **toast 消费通道** `LoginRestoreTone` | `src/components/auth/restoreFeedbackCopy.ts:32`（喂给 `showToast`） | **动** —— `'success'` → `'info'` |
| **toast 通道** `toastHelper` 的 `type` 字段 | `src/utils/toastHelper.ts:40` | **动** |
| 浏览器通知 `kind` | `src/background/TabManager.ts:801` | **不动** |
| 就地反馈 `kind` | `Header.tsx:370,404,615,623,632`、`SearchResultList.tsx:177`、`TabList.tsx:136` | **不动** |
| `InlineNoticeTone` | `src/components/common/InlineNotice.tsx` | **不动** |
| `AlertDialog` 的 `type` | `src/components/common/AlertDialog.tsx:9` | **不动** |
| `TabGroup.syncStatus` | `src/types/tab.ts:293` | **不动** |

**具体改动**

- `Toast.tsx`：`ToastType` 去掉 `'success'`；`TYPE_LABEL`（`:25`）去掉 `success: '完成'`；
  `getTypeStyles()`（`:449`）去掉 success 分支 —— **default 分支当前返回的是 success 的样式
  （`:478`），必须改成 info 的样式**；`getIcon()`（`:484`）去掉对勾图标。
- `toastPolicy.ts`：`ToastKind` 去掉 `'success'`。
- `toastHelper.ts`：
  - `getNotificationConfig` 里 `save-success` / `delete-success` / `sync-success`
    **三个配置项删掉**（只被死 helper 用）；
  - **`restore-success` 保留** —— 它是**活路径**：`showRestoreSuccessMessage` 走的就是它
    （`toastHelper.ts:206`），而 `showRestoreSuccessMessage` 有 4 个调用点
    （§5.2 的一半出口）。它的 `type` 从 `'success'` 改成 `'info'`。
  - `getNotificationConfig` 的 `default:` 分支（`:129`）当前返回 `type: 'success'`
    ⇒ 改成 `'info'`。
  - **7 个死 helper 全删**：`showSaveSuccess` / `showSaveError` / `showRestoreSuccess` /
    `showDeleteSuccess` / `showSyncSuccess` / `showSyncError` / `showPinnedInfo`
    —— 它们是「随手撒成功提示」的后门。

**效果**：`showToast(x, 'success')` 变成**编译错误** ⇒ 新代码在类型层面就撒不出成功提示。
这是本次改造最硬的那道闸门 —— 别的都是约定，只有这条是机制。

### 6.2 守卫

新增 `tests/guards/quietSuccess.test.ts`：

1. **类型层**：`ToastType` / `ToastKind` 的联合类型里不含 `'success'`。
2. **调用层**：`src/**/*.ts(x)` 里**不得**出现 `showToast(…, 'success')`。
   ⚠️ **不得**写成 blanket 的「`type: 'success'` 全文 grep」—— 那个字面量还合法地存在于
   浏览器通知 `kind`、就地反馈 `kind`、`InlineNoticeTone`、`AlertDialog.type`、
   `TabGroup.syncStatus` 六个命名空间里（§6.1 的表）⇒ 那样写守卫必然误伤。
   **判据要写成命名空间限定的**（例如：解析 `toastPolicy.ts` 里 `ToastKind` 的联合类型成员；
   对 `showToast(` 的调用点解析第二个实参）。
3. **必说清单**：把 §5.1 / §5.2 里的 `fact` 项列成表，逐条断言
   **对应源码位置仍在调用判据层**。⚠️ 不是断言「出现了某段代码」—— 那是零检测力；
   要断言**调用真的经过 `decideFeedback`**（接线守卫必须真的调用那条路径）。
4. **可静默清单**：逐条断言对应位置**确实没有** `showToast` 调用，
   且**它依赖的状态载体真的存在**。例：锁定分支断言 `consumeSession()` 对 locked 直接 return
   （不 dispatch 删除）⇒ 所以「卡片还在」成立；断言锁定分支里 `deleteTabAndSync` 从未被调用
   ⇒ 所以「那行还在」成立。**不许只断言「没有提示」** —— 那是零检测力。
5. **退路仍在**：未锁定分支仍有 `showConsumeToast` 且挂了撤销 payload。
6. **成功门仍在**：锁定分支里 `success !== true` 的判定**出现在任何播报之前**，
   且**失败路径仍然调用 `showRestoreError`**（删了播报不许把失败也删掉）。
7. **失败不被静默**：全仓 `showToast` 的 `error` 型调用点数**不得少于基线 35**
   （基线值要写进守卫，否则「不得减少」没有锚点）。
8. **解锁静默**：锁定按钮的解锁分支**不得**有 `showToast`；同时断言
   `restoreOutcomeSentence(false)` 仍出现在恢复按钮的 tooltip / `aria-label` 上
   （⇒ 规则没有跟着提示一起消失）。

### 6.3 变异自证

新增 `tests/guards/quietSuccessMutation.test.ts`：每个例外分支配一个变异用例 ——
把「该出声的地方改成静默」当作变异，守卫**必须变红**。没有变异自证的守卫等于没有守卫。

至少要有 2 个**反向**变异：

- 把成功门删掉 ⇒ 守卫必须红。
- 把撤销按钮去掉 ⇒ 守卫必须红。

⚠️ **已有一条变异沙箱对源码格式敏感**：`tests/guards/moveEmptiesSessionFeedbackMutation.test.ts`
用**硬编码的多行源码片段**去替换 `TabGroup.tsx` 里
`showRestoreSuccessMessage(\n  moveEmptiesSessionMessage({…})\n)` 那一段。
本设计会动到那一行（它要从 success 改成 fact）⇒ **动那一行时必须同步更新这个变异文件**，
否则变异会匹配不上（该文件断言「变异必须真的跑起来」，所以会**显式报错**而不是静默假绿）。

### 6.4 现有守卫要改的（不是删掉，是把规则收窄）

| 守卫 | 现在钉的 | 改成钉 |
|---|---|---|
| `tests/restoreFeedbackHonesty.test.ts`（接线部分） | 列表页与搜索页的恢复**必须有成功播报**（`singleOpen >= 2` 等） | 锁定分支**允许不播报**，但必须判过成功门且失败必须出声；未锁定分支必须播报且带撤销 |
| `tests/restoreFeedbackHonesty.test.ts`（文案部分，`:66-84`） | `restoreGroupSuccessMessage(3, true)` 必须说「仍保留在列表中」、`openSingleTabSuccessMessage(true)` 必须说「仍保留在会话中」 | 这两条 locked 文案随死分支一起删 ⇒ **对应断言一并删掉**（不是改成别的话） |
| `tests/guards/loginRestoreFeedback.test.ts:62` | `loginRestoreFeedback({kind:'pulled',count:2}).tone === 'success'` | 改成 `'info'`（§6.1 的 `LoginRestoreTone`） |
| `tests/guards/toastUndoReachability.test.ts`（6 处） | `resolveToastDuration('success', …)` | 改成 `'info'` —— 它钉的是「带动作 ⇒ ≥8 秒」这个**性质**，不是 success 字面量 |
| `tests/guards/consumeUndoWiring.test.ts` | `showRestoreSuccessMessage` 接受 `action?: ToastAction` | 结构若变（§6.1）则同步 |
| `tests/guards/outwardCopyTruthfulness.test.ts` 等 | 对外文案与实现一致 | 同步更新 |
| `tests/guards/failureNotificationsAlwaysSend.test.ts` | `kind:'success'` 的浏览器通知 | **不动**（那是 `chrome.notifications` 的 kind，与 toast 类型是两套东西） |

### 6.5 对外文案（四处一致的第三、四处）

| 位置 | 现在说什么 | 改后 |
|---|---|---|
| `README.md:45` | 「**「被消费」的那一步有退路**：…屏幕上会出现一条带「撤销」按钮的提示，几秒内点一下」 | **仍成立**（撤销提示保留、仍是浮出提示）—— 措辞可补「中性」 |
| `README.md:139-140` | 「**这两种「移除」都可以撤销**：移除后屏幕上会出现一条带「撤销」按钮的提示…」 | **仍成立** —— 同上 |
| `CHROMEWEBSTORE.md:160` | 同上（退路承诺） | **仍成立** |
| `CHROMEWEBSTORE.md:261` | 权限表「在保存会话成功或失败时给出浏览器通知…」 | **不动**（浏览器通知不受本次改造影响） |
| `src/legal/privacy.html:71` | 「保存会话成功或失败时给出系统通知…失败提示不受此开关影响，始终会通知」 | **不动**（同上） |
| `src/options/OptionsPage.tsx:1101` | 「保存会话成功时发浏览器通知。失败提示不受此开关影响，始终会通知。」 | **不动**（同上） |

⚠️ **注意**：README 与商店页里大量「成功/失败」提法是在讲**同步与数据安全**的语义
（例如「以前界面报『同步成功』但其实没同步」），那些是**历史缺陷的记述**，不是对当前
toast 行为的承诺 ⇒ **不动**。只有描述「界面上会弹什么」的句子要改。

### 6.6 预览文案

本仓的「预览文案」= 弹窗 / 确认框里给用户看的预告（`restoreAllSearchConfirmMessage`、
`cleanDuplicatesConfirmMessage`、`deleteAllConfirmMessage` 等）。
它们本来就是**预告**（不是成功播报）⇒ 原则上不动。
唯一要看的：确认框里若写了「完成后会提示你…」，那属于对 toast 的承诺，要跟着改。

---

## 7. 分批实施

| 批次 | 内容 | 涉及文件 | 风险 |
|---|---|---|---|
| **1** | 判据层 `feedbackPolicy.ts` + 守卫 + 变异自证（先落判据，行为不变） | 新增 3 个文件 | 低 |
| **2** | 类型层删 `success`（**只删 toast 命名空间**）+ Toast 组件视觉 + 19 处 success 逐条裁决 + 7 个死 helper | `Toast.tsx`、`toastPolicy.ts`、`toastHelper.ts`、`ToastContext.tsx`、`useConsumeUndo.ts`、`auth/restoreFeedbackCopy.ts`、`Header.tsx`、`HeaderDropdown.tsx`、`WebDavSettings.tsx`、`OptionsPage.tsx`、`TabGroup.tsx` | 低（文案 + 调用层） |
| **3** | 恢复类：锁定分支删播报（**保留成功门**）+ 未锁定分支中性化 + 撤销文案瘦身 + 锁定说明常驻化 / 解锁静默 | `TabGroup.tsx`、`SearchResultList.tsx`、`restoreFeedbackCopy.ts`、`lockFeedbackCopy.ts`、`useConsumeUndo.ts` | **中** —— 碰 `restoreFeedbackHonesty` / `toastUndoReachability` 两套守卫，涉及卡片布局，且要同步 `moveEmptiesSessionFeedbackMutation.test.ts` 的硬编码片段 |
| **4** | 现有守卫改写（收窄规则而非删除）+ 四处对外文案同步 + 密度复调 | 4~6 个测试文件 + README / 商店页 | 中 |

**不在本轮范围**（产品负责人 2026-10-25 决定）：22 个 `showAlert` 错误模态转 toast。
等前四批落地、真机确认安静效果之后再评估。

---

## 8. 验证

- **全量套件 20–30 分钟**（记忆里的教训：30+ 变异沙箱各拷一份仓）⇒ **必须后台跑**，
  且**别把 `runMutationCases` 放进守卫文件**。
- **每个提交在自己的 worktree 里单独跑绿**（并行 agent 共用工作树会把别人的半成品一起提交）。
- **真机验证**（不能只靠单测）：
  1. 锁定一个会话 → 恢复 → 确认**没有任何 toast**、卡片还在、窗口开了。
  2. 锁定一个会话 → 点开其中一个标签 → 确认**没有任何 toast**、那行还在、页面开了。
  3. 未锁定会话 → 恢复 → 确认**只有一条中性提示**、有撤销、8 秒内点得到。
  4. 打开一个 `file://` 地址 → 确认**有错误提示**「已保留在会话中」。
     ⚠️ 这条走的是 **popup 侧的前置拦截**（`src/utils/inputValidation.ts:281` 的
     `isOpenableTabUrl`）⇒ **到不了 SW 的成功门**。SW 成功门由守卫 + 变异自证覆盖，
     **不要**在真机验证里假装能构造出来。
  5. 删全部会话，让实际条数与确认数**不一致** → 确认有 fact 提示；一致时确认**没有**提示。
  6. 导入一批会话 → 确认列表顶部/提示给出了「导入几个、几个读不出来」。
- **编译期闸门自证**：故意写一行 `showToast('x', 'success')` ⇒ 确认**构建失败**。
- **命名空间闸门自证**：故意在 `AlertDialog` 的 `type` 里写 `'success'` ⇒ 确认**构建仍然成功**
  （证明闸门没误伤别的命名空间）。

---

## 9. 留给实现者的

已经定了的（照做即可）：

1. 判据的形状（§4.3）、三档裁决（§4.2）、逐条裁决表（§5.1–§5.4）。
2. `success` 只从 **toast 命名空间**删除；`info` 承接事实类；其余 6 个命名空间不动。
3. 撤销机制不动，只换皮 + 瘦身。
4. 浏览器通知不动；22 个错误模态这轮不动。
5. 解锁完全静默；锁定的后果走卡片常驻行。
6. 批次 1–4 必做。

需要实现者自己判断的（不改变结果）：

- `feedbackPolicy.ts` 里 `decideFeedback` 的具体签名与 `reason` 文案。
- 锁定常驻那一行的**确切措辞与位置**（在卡片头还是标签行上方）—— 只要信息齐、跟着主题走、
  不违反密度定案即可。
- 撤销提示的**瘦身程度** —— 只要「记录被移除了」这个事实还在、撤销还在。
- 哪些 `fact` 的载体选 toast 还是常驻位置（判据只管「该不该说」，不管「在哪说」）。

**不许自己放宽的**：

- 判据必须**纯函数**且被组件**真的调用**（不许「源码里出现了 decideFeedback」就算数）。
- 守卫必须**钉不变量**（不许钉某句文案的确切字面量，除非那文案就是对外承诺）。
- 守卫必须**命名空间限定**（不许 blanket grep `'success'`）。
- 每条例外分支必须配**变异自证**。
- 改语义规则要**四处齐改**（判据 / 守卫 / 对外文案 / 预览文案）。
- 删提示时**不许顺手删成功门**。
