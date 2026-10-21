// 设置页的信息架构判定 —— 2026-10-20 第二轮审计。
//
// ── 为什么单独一个模块 ────────────────────────────────────────────────────
//
// 本仓没有 DOM 测试环境（没有 jsdom / happy-dom / @testing-library），
// 而这三条判据恰恰是「看起来对不对」全靠人脑判断的：
//   · 面板该不该默认展开；
//   · 面板收起时能不能只靠 aria 藏住；
//   · 退出入口该往哪儿指。
//
// 判据写死在 `.tsx` 里就只能靠「读源码看着对」来保证 ⇒ 下一个改动很容易
// 把它改回去而没人发现。所以抽成纯函数，让测试能**真的调用它**、
// 证伪「无论什么状态都返回同一个值」这种常量实现。
//
// 这里的每个函数都不碰 DOM、不碰 chrome API —— 于是可以被 SSR 渲染
// （tests/optionsInertGate.test.ts 用的那套 harness）直接断言。

/** 同步后端。 */
export type SyncBackend = 'supabase' | 'webdav';

/**
 * 「自带存储配置」区块是否**默认折叠**。
 *
 * 判据：**用户当前用的不是 WebDAV，就折叠**。
 *
 * - 用 WebDAV 的人：这块表单是他要用的，展开省一次点击；
 * - 用 Supabase（默认，90% 的人）的人：这块表单与他无关，折叠掉，
 *   首屏留给「同步方式」「自动同步」这些真正常用的项。
 *
 * ⚠️ 已经配过 WebDAV 的人一律展开：哪怕他现在用 Supabase 同步，
 * 「我的云盘配好了」这件事他每次进来都想一眼看到 —— 那比省一屏值钱。
 *
 * 【为什么只管初始状态】用户手动展开/折叠之后不再被自动改回去 ——
 * 自动改回去会让「我刚展开就被折叠了」变成一个说不清的 bug。
 */
export const shouldCollapseWebDavSection = (
  syncBackend: SyncBackend,
  isWebDavConfigured: boolean
): boolean => {
  if (isWebDavConfigured) return false;
  return syncBackend !== 'webdav';
};

/**
 * 折叠态下，面板内容该怎么藏。
 *
 * 【为什么要两个通道一起上】`hidden` 让浏览器把内容移出可交互树
 * （真正移出 Tab 序列、移出无障碍树），`aria-hidden` 让读屏软件
 * 明确把它当「不存在」。只上其中一个都会漏：
 *   · 只上 aria-hidden ⇒ 键盘用户 Tab 进一片看不见的输入框，
 *     盲按 Enter 就可能提交一份他看不见的表单；
 *   · 只上 hidden ⇒ 现代浏览器其实也够了，但显式的 aria-hidden
 *     是给读屏软件的第二道声明，缺了它某些辅助技术仍会念出来。
 *
 * 仓库里已有的先例：ThemeStyleSelector 的主题列表就是两个通道一起上
 * （见 tests/a11yLists.test.ts 对它的断言）。
 */
export interface CollapsiblePanelState {
  /** 外层容器的 aria-hidden（读屏软件用）。 */
  'aria-hidden': boolean;
  /** 内层内容的 hidden（浏览器用：移出可交互树）。 */
  hidden: boolean;
}

/**
 * 折叠面板的属性（纯函数，供渲染层直接展开）。
 *
 * @param expanded 当前是否展开
 */
export const collapsiblePanelState = (expanded: boolean): CollapsiblePanelState => ({
  'aria-hidden': !expanded,
  hidden: !expanded,
});

/**
 * 设置页的退出入口该指向哪儿 —— 纯函数，产出**下一步动作**而不是文案。
 *
 * 【为什么需要判定而不是直接写死一句话】设置页是 `open_in_tab: true`
 * 打开的**独立标签页**，而管理页也是 `chrome.tabs.create` 打开的独立标签页。
 * 用户从管理页进设置页时，浏览器历史里**可能**有管理页（他是从那里点进来的），
 * 也可能**没有**（他是从扩展详情页的「扩展选项」进的）。
 * 所以「按后退」不是可靠的退出方式 —— 必须有一条**永远存在**的显式出口。
 *
 * 判据：
 *   · 管理页已经开着 ⇒ 焦点切过去（不新开一个，用户会得到两个管理页）；
 *   · 没有开着 ⇒ 新开一个。
 *
 * 两条路径的共同点是**用户一定能看到会话列表** —— 这正是「退出设置页」
 * 想要的结果。
 */
export type ManagerPageExitAction = 'focus-existing' | 'open-new';

/**
 * 该做什么才回得到管理页。
 *
 * @param hasExistingManagerTab 当前是否已经有管理页标签
 */
export const managerPageExitAction = (hasExistingManagerTab: boolean): ManagerPageExitAction =>
  hasExistingManagerTab ? 'focus-existing' : 'open-new';

/**
 * 管理页的 URL（相对扩展根）—— 见 `@/core/managerPage` 的完整说明。
 *
 * 那里是**单一真相源**（background 与 options 两个执行上下文共用）。
 * 本模块只做再导出，方便调用方从一个地方取全部设置页判据。
 */
export { MANAGER_PAGE_PATH } from '@/core/managerPage';

/**
 * 「同步间隔」这一档是否显示。
 *
 * ⚠️ 本轮**不改**这个行为 —— 「同步间隔」radiogroup 保持**始终渲染**。
 *
 * 理由：仓库里有一条已落地的决定（2026-10-17 B8 缺陷 4），
 * 配套守卫 `tests/syncStatusHonesty.test.ts` 钉着
 * 「档位行：**始终渲染**」这句话与「注释不得再声称条件渲染」。
 * 改它不是「顺手优化」，是**推翻一条已定的产品决定**。
 *
 * 那一决定本身是对的：把「多久跑一次」藏起来，用户想设的时候找不到。
 * 而「自动同步关着时这一档没有意义」这件事，用**提示文案**说明
 * （见下）比隐藏控件更诚实 —— 藏起来会让人以为这个功能不存在。
 *
 * 所以这里**保留**这个函数（它记录了判据本身），
 * 但渲染层不按它条件渲染；它的返回值只用于决定**提示文案**。
 */
export const shouldShowSyncInterval = (autoSyncEnabled: boolean): boolean =>
  autoSyncEnabled;

/**
 * 自动同步关闭时，「同步间隔」下面那句提示。
 *
 * 【为什么要有这句】设置项「藏起来」和「不存在」对用户是两件事。
 * 说清楚它还在、只是要先打开自动同步，用户才知道去哪儿找；
 * 而「间隔越短越快」那句只讲了代价，没讲**它现在不生效**。
 */
export const syncIntervalHint = (autoSyncEnabled: boolean): string =>
  autoSyncEnabled
    ? '间隔越短，跨设备看到新内容越快，但出站流量也越多。'
    : '自动同步关着时这一档不生效。打开「自动同步」后按下面的间隔在后台同步；间隔越短，跨设备看到新内容越快，但出站流量也越多。';
