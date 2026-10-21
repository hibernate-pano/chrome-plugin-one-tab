/**
 * 右键菜单的**判定纯函数**（2026-10-20 审计 A-12）。
 *
 * 为什么要单独抽一个模块：`src/service-worker.ts` 是 Service Worker 入口，
 * 在 node:test 里没法 import（它一进来就 `chrome.runtime.getManifest()`）。
 * 而「哪些菜单项在什么上下文出现」「标题分别是什么」「这个浏览器支不支持
 * 某个上下文」这些判定是**可测的纯逻辑** —— 抽出来就能被单测直接覆盖，
 * 不用起真浏览器。
 *
 * 抽出来的另一个好处：**一处定义，菜单注册与点击处理共用**。
 * 修复前「菜单在哪些上下文出现」写在 create 调用里、「点击后做什么」写在
 * onClicked 里，两处各写一遍 id 与语义，改一处忘另一处就会出现
 * 「注册了但点不动」或「能点但不注册」。
 */

/** 菜单项 id。注册与处理共用同一份 —— 拼错字符串是这类代码最常见的错。 */
export const CONTEXT_MENU_IDS = {
  /** 打开标签管理器（仅扩展图标上下文）。 */
  openTabManager: 'open-tab-manager',
  /** 在网页上 / 标签页标题上右键：保存**此标签页**并关闭。 */
  saveCurrentTab: 'saveCurrentTab',
  /** 在扩展图标上右键：保存**当前标签页**并关闭。 */
  saveCurrentTabFromIcon: 'saveCurrentTabFromIcon',
  /** 保存其他标签并关闭（仅扩展图标上下文）。 */
  saveOtherTabs: 'saveOtherTabs',
} as const;

export type ContextMenuId = (typeof CONTEXT_MENU_IDS)[keyof typeof CONTEXT_MENU_IDS];

/**
 * Chrome **运行时**认的上下文词表。
 *
 * ⚠️ 为什么不用 `chrome.contextMenus.ContextType`：`@types/chrome@0.0.262`
 *    的那份枚举**还没有 `'tab'`**（它是 2023 年的类型定义），而 Chrome
 *    运行时**是支持的** —— Chrome 自己的参数校验错误把合法词表原样列了出来：
 *
 *      Error at property 'contexts': Error at index 0: Value must be one of
 *      action, all, audio, browser_action, editable, frame, image, launcher,
 *      link, page, page_action, selection, tab, video.
 *
 *    也就是说 `'tab'` 在词表里，只是**类型定义滞后**。
 *    （实测核对：Chrome 44~146 的 schema 里没有 `tab`，150/151/155 有 ——
 *    所以它在老浏览器上确实会抛参数错误，见下面的能力探测。）
 *
 * 这里按运行时的真实词表定义**一份本地类型**：好处是 call site 上只需要
 * 一次**精确**断言（`as chrome.contextMenus.ContextType[]`，不是 `as any`），
 * 而任何一个拼错的上下文名都会编译不过。
 */
export const CONTEXT_TYPES = {
  all: 'all',
  page: 'page',
  frame: 'frame',
  selection: 'selection',
  link: 'link',
  editable: 'editable',
  image: 'image',
  video: 'video',
  audio: 'audio',
  launcher: 'launcher',
  action: 'action',
  tab: 'tab',
} as const;

export type RuntimeContextType = (typeof CONTEXT_TYPES)[keyof typeof CONTEXT_TYPES];

/**
 * 按**浏览器能力**裁剪要注册的 contexts。
 *
 * 【为什么按能力、不按版本号】版本号判断依赖「我核实过的那个数字」——
 * 而 `'tab'` 的起始版本是会变的（实测：Chrome 44~146 没有，150 起有），
 * 拿版本号当判据就要在注释里钉一个数字，那个数字迟早会过期。
 * 特性探测依赖的是**浏览器自己的答案**：试着注册一次，抛异常就是不支持。
 * 它不会过期，也不会因为我漏了一个中间版本而错。
 *
 * @param requested 想注册的全部上下文
 * @param supportsTabContext 当前浏览器是否接受 `'tab'` 上下文
 * @returns 实际可注册的上下文列表
 */
export function resolveContextTypes(
  requested: readonly RuntimeContextType[],
  supportsTabContext: boolean
): RuntimeContextType[] {
  if (supportsTabContext) return [...requested];
  return requested.filter(type => type !== CONTEXT_TYPES.tab);
}

/**
 * 把运行时的上下文名转成 `@types/chrome` 的 `ContextType`。
 *
 * 【为什么要这么绕，而不是在数组上直接断言】
 * 直接写 `[... ] as chrome.contextMenus.ContextType[]` 会被 TS 拒绝：
 * `'tab'[]` 与 `ContextType[]` **完全无交集**（`'tab'` 不在那份枚举里），
 * 只能靠 `as unknown as` 硬转 —— 那一转把**整个数组**的检查都放弃了，
 * 拼错任何一个上下文名都不会报错。
 *
 * 这里改成**逐个转换**：只有 `'tab'` 这一个字面量需要断言（且断言点被
 * 收窄到这一行），其余每一个值都必须**本来就是**合法的
 * `chrome.contextMenus.ContextType` —— 拼错会在编译期就红。
 *
 * 断言的理由写在那一行上：Chrome 运行时支持 'tab'（它自己的参数校验
 * 错误里列出了完整词表，含 tab），只是 `@types/chrome@0.0.262` 没跟上。
 */
export function toChromeContextType(
  type: RuntimeContextType
): chrome.contextMenus.ContextType {
  if (type === CONTEXT_TYPES.tab) {
    return CONTEXT_TYPES.tab as unknown as chrome.contextMenus.ContextType;
  }
  return type;
}
