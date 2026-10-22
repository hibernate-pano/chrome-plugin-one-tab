/**
 * 空状态（一个会话都没有）时，除了「保存并关闭」之外还该给哪些出口。
 *
 * ── 缺陷原形（2026-10-22 审计 L-11） ─────────────────────────────────────
 * 空态只有一颗主 CTA「保存并关闭」。但走到这个空态的用户**不止一种**，
 * 而界面对其中两种**完全不给路**：
 *
 * | 用户 | 他真正需要的下一步 | 修复前的界面 |
 * |---|---|---|
 * | 全新用户 | 保存一个工作会话 | ✅ 给对了 |
 * | 换设备的老用户（已登录） | 「我的会话在云端，把它们拉回来」 | ❌ 没有 |
 * | 换设备的老用户（未登录） | 「先登录，登录后自动拉回」 | ❌ 没有 |
 * | OneTab / JSON 老用户 | 「把之前导的数据导进来」 | ❌ 没有 |
 *
 * 为什么第二条是 **P0 级**：本产品的云端价值主张是
 * 「换设备、换浏览器也能找回你的工作现场」（CHROMEWEBSTORE.md 的原文）。
 * 而 **自动同步默认关闭**（`autoSyncDefaultOff`），
 * 「登录成功时立即拉回一次」只在**登录那一刻**发生。
 * 于是新设备上的真实路径是：
 *
 *   装扩展 → 打开 TapStack → **看到一个空页面** → 只有一个「保存并关闭」
 *
 * 用户此刻最可能的判断是「**我的会话没了**」——
 * 而事实是它们好好地在云端。空态是这件事**唯一**能澄清的���口，
 * 却是唯一什么都没说的地方。
 *
 * ── 为什么不新造功能 ────────────────────────────────────────────────────
 * 这三条出口**全部指向已经存在的能力**：
 *   · 登录  → AuthModal（登录成功会触发 `restoreAfterLogin` 的整库拉取）
 *   · 下载  → `sendSyncCommand('download', …)`（菜单里的「从云端刷新数据」同一套）
 *   · 设置  → `chrome.runtime.openOptionsPage()`（WebDAV 需要在这里解锁）
 *   · 导入  → 菜单里的 JSON / OneTab 导入（同一套文件选择与结果提示）
 * 空态缺的只是**出口**，不是能力。
 */

/** 空态次级出口的种类。 */
export type EmptyStateAction = 'login' | 'download' | 'options' | 'import';

export interface EmptyStateActionsInput {
  /** 当前同步后端。 */
  syncBackend: 'supabase' | 'webdav';
  /** 是否已登录 TapStack 云端。WebDAV 用户恒为 false —— 他们不需要账号。 */
  isAuthenticated: boolean;
}

/**
 * 该给哪些次级出口（按展示顺序）。
 *
 * 判据只有两条：**后端是哪个**、**登没登录**。
 * 不做「后端是否已配置 / 是否已解锁」的判断 —— 那需要读后端状态，
 * 而空态是**冷启动第一屏**，那时的后端状态未必读得到；
 * 与其给一个可能立刻失效的按钮，不如给一个**永远可点**的出口。
 */
export function resolveEmptyStateActions(input: EmptyStateActionsInput): EmptyStateAction[] {
  if (input.syncBackend === 'webdav') {
    // 自带存储：账号由用户自己的云盘提供，「登录」对他毫无意义。
    // 解锁口令也只在设置页能填 ⇒ 出口是设置页。
    return ['options', 'import'];
  }
  // 云端：未登录时先登录（登录成功会自动拉回，见 restoreAfterLogin）；
  // 已登录时直接拉回。
  return input.isAuthenticated ? ['download', 'import'] : ['login', 'import'];
}

/** 次级出口的可见文字。 */
export const EMPTY_STATE_ACTION_LABEL: Record<EmptyStateAction, string> = {
  login: '登录 TapStack 云端',
  download: '从云端恢复会话',
  options: '打开设置恢复云盘会话',
  import: '导入数据',
};

/**
 * 次级出口的**补充说明**（悬停 / 读屏）。
 *
 * 为什么要说明：这三个动作都会改变用户对「我的数据在哪」的判断。
 * 不说清楚，用户会以为「导入数据」是导出、或者「从云端恢复」会覆盖本地。
 */
export const EMPTY_STATE_ACTION_HINT: Record<EmptyStateAction, string> = {
  login: '登录后会自动把云端会话拉回本机',
  download: '把云端会话拉回本机并合并，不会清掉本地内容',
  options: '自带存储需要先在设置里填好地址并解锁',
  import: '支持 OneTab 文本与 JSON 备份',
};
