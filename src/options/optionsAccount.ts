// 设置页的账号状态与出口 —— 2026-10-20 第二轮审计。
//
// ── 缺陷形状 ──────────────────────────────────────────────────────────────
//
// 设置页（`options_ui.open_in_tab: true`）是**独立标签页**，而管理页
// （`chrome.tabs.create` 开的另一个标签页）里有「⋯」菜单，菜单里有
// 「登录 / 注册」。
//
// 于是设置页里出现了两句**指向不存在的东西**的话：
//
//   · `OptionsPage.tsx` 的 autoSyncHint：「请先在右上角菜单登录。」
//   · `backendStatus.ts` 的 autoSyncBlockedCopy：「请先在菜单里登录。」
//
// 这两句在**设置页**里渲染 —— 而设置页**没有右上角菜单**，
// 也没有任何登录入口。用户照做得到的是「找一个不存在的菜单」，
// 于是他永远开不了自动同步（云端默认后端），也不知道为什么。
//
// 真实可用的登录入口在**管理页**的「⋯」菜单里（HeaderDropdown:805「登录 / 注册」）。
// 所以设置页要么：
//   ① 自己提供登录入口；要么
//   ② 明确说「回管理页登录」。
//
// 本模块提供 ① 的**判据**（纯函数，可测），文案与出口动作也在这里单源化。

/** 设置页里账号区域的展示形态。 */
export type AccountPanelMode =
  /** 已登录：显示邮箱 + 退出。 */
  | 'signed-in'
  /** 未登录且本次用的是自带存储：账号对当前后端无意义 ⇒ 不显示任何账号 UI。 */
  | 'not-needed'
  /** 未登录且用的是云端：显示「去登录」。 */
  | 'signed-out';

/**
 * 设置页的账号区域该显示成什么。
 *
 * 【判据只有一条】TapStack 账号**只对云端后端有意义**。
 * 用自带存储（WebDAV）的人没有 TapStack 账号，也不该被要求登录 ——
 * 给一个用 WebDAV 的人显示「去登录」是纯粹的噪音，而且会让他以为
 * 不用 WebDAV 就不能用这个扩展。
 *
 * ⚠️ 所以这里**必须**看后端，不能只看登录态。仓库里
 * `tests/guards/uiTruthfulnessC.test.ts` 已经钉住了同一个道理
 * （WebDAV 用户不需要登录）。
 *
 * @param syncBackend 当前同步后端
 * @param isAuthenticated 是否已登录
 */
export const accountPanelMode = (
  syncBackend: 'supabase' | 'webdav',
  isAuthenticated: boolean
): AccountPanelMode => {
  if (isAuthenticated) return 'signed-in';
  if (syncBackend === 'webdav') return 'not-needed';
  return 'signed-out';
};

/**
 * 未登录时那句提示该怎么写。
 *
 * 【为什么不能用「右上角菜单」】设置页**没有**右上角菜单
 * （菜单是管理页顶栏的东西）。这句话在设置页里渲染 ⇒ 必须指向
 * 本页**真实存在**的东西。
 *
 * @param syncBackend 当前同步后端
 */
export const loginHintCopy = (syncBackend: 'supabase' | 'webdav'): string =>
  syncBackend === 'webdav'
    ? '自带存储不需要 TapStack 账号。'
    : '尚未登录 TapStack 云端：自动同步即使打开也不会运行（后台每轮都会因未登录跳过）。请在本页点「登录 / 注册」。';

/**
 * 「被拒绝开启自动同步」时那句话该怎么写。
 *
 * 与 `loginHintCopy` 同一个约束：**必须指向本页真实存在的入口**。
 *
 * @param syncBackend 当前同步后端
 */
export const autoSyncBlockedCopy = (syncBackend: 'supabase' | 'webdav'): string =>
  syncBackend === 'webdav'
    ? '还没有登录 TapStack 云端，但当前用的是自带存储，不需要登录即可同步。'
    : '还没有登录 TapStack 云端，登录后自动同步才能运行。请在本页点「登录 / 注册」。';
