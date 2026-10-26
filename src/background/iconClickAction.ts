/**
 * 「点扩展图标」的动作 —— **保存当前窗口并关闭这些标签**（2026-10-24 恢复旧交互）。
 *
 * ── 这个模块为什么存在 ──────────────────────────────────────────────────
 *
 * `service-worker.ts` 是**有副作用的模块**（一 import 就注册一堆 chrome 监听器），
 * 而本仓的纪律是「守卫必须钉**行为**，钉源码长相等于零检测力」
 * （见 memory：接线守卫必须真的调用那条路径）。
 * ⇒ 把这段决策抽成**依赖注入**的纯逻辑：chrome API 全部从外面传进来，
 *   于是它能被单测直接调用、能被变异自证打断。
 *
 * ── 交互契约（2026-10-24，产品负责人定案）───────────────────────────────
 *
 *   点扩展图标 ⇒ 把**点到的那个窗口**的标签存成一个会话并**关掉它们**
 *              ⇒ 随后打开会话管理器（开在**同一个窗口**里）
 *
 * 2026-10-22 的审计 P0-1 曾把这改成「只打开会话管理器」，理由是
 * 「点图标的心智模型是『打开它看看』」。单实例时那条成立，**多实例时反了**：
 * 同时开着两个 Chrome 时，「点 A 的图标、B 里跳出一个管理器」= 点了像没点。
 * ⇒ 恢复旧交互；审计里的其它安全策略（删除确认、锁定豁免…）
 *   **一条都没动**，被推翻的只有「图标点击不许保存」这一条约定。
 *
 * ── 窗口必须取「点的那一个」 ────────────────────────────────────────────
 *
 * service worker 语境下的 `chrome.tabs.query({ currentWindow: true })`
 * 指的是**最后被聚焦的窗口** —— 多窗口 / 多 Chrome 实例并存时，它可能指向
 * **别的**窗口 ⇒ 点 A 的图标却把 B 的标签存走**并关掉**（存错 + 关错，
 * 两件不可逆的事一起做错）。
 * `chrome.action.onClicked` 传进来的 `tab` 就是被点时那个窗口的活动标签
 * ⇒ 它的 `windowId` 才是「用户以为在点的那个窗口」。
 */

/** 一次图标点击需要的全部外部能力（全部注入 ⇒ 本模块无副作用、可单测）。 */
export interface IconClickDeps {
  /** 查标签（参数与 `chrome.tabs.query` 一致）。 */
  queryTabs: (query: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>;
  /** 保存整窗并关闭（`TabManager.saveAllTabs`）。返回 null = 一个都没存下。 */
  saveAllTabs: (tabs: chrome.tabs.Tab[]) => Promise<{ savedCount: number } | null>;
  /** 打开会话管理器（可指定开在哪个窗口）。 */
  openTabManager: (shouldRefresh: boolean, windowId?: number) => Promise<void>;
  /** 通知（success / error）。 */
  notify: (message: string, kind: 'success' | 'info' | 'error') => Promise<void>;
}

/** 一次图标点击的结果（供调用方与守卫断言）。 */
export type IconClickOutcome =
  /** 存成了，并打开了管理器。 */
  | { kind: 'saved'; savedCount: number }
  /** 一个都没存下（保存方自己已经报过原因）⇒ 不开管理器、也不重复报错。 */
  | { kind: 'nothing-saved' }
  /** 存成了，但管理器没打开（**不许**说成「无法保存」—— 那会让用户重复操作）。 */
  | { kind: 'saved-but-manager-failed' }
  /** 整条路径失败（连标签都没查到手 / 保存抛错）。 */
  | { kind: 'failed' };

/**
 * 这次点击要操作哪个窗口。
 *
 * @param clickedTab `chrome.action.onClicked` 传进来的那个标签
 * @returns 窗口 id（拿不到就是 undefined ⇒ 调用方退回 currentWindow）
 */
export const resolveIconClickWindowId = (
  clickedTab?: { windowId?: number } | null
): number | undefined => {
  const windowId = clickedTab?.windowId;
  return typeof windowId === 'number' ? windowId : undefined;
};

/**
 * 执行一次图标点击。
 *
 * @param clickedTab 点击时 Chrome 传进来的标签（决定「点的是哪个窗口」）
 * @param deps 外部能力（注入）
 *
 * ── 为什么每一段失败都有自己那一句「人话」 ─────────────────────────────────
 *
 * 旧实现（v1.25.x）是一个大 try/catch ⇒ 任何异常都报同一句
 * 「无法保存当前窗口」—— 包括**保存已经成功、只是管理器没打开**那种
 * ⇒ 用户被告知「没存下」⇒ 去重复操作 ⇒ 存出一堆重复会话。
 * 现在按**谁出的错**分开说：
 *
 *   · 标签都没查到手    ⇒ 什么都没发生 ⇒ 「无法保存当前窗口…」
 *   · 保存方抛错        ⇒ 保存方自己报过原因（不重复报）
 *   · 一个都没存下      ⇒ 保存方自己报过原因（不重复报，也不谎报）
 *   · 管理器没打开      ⇒ 保存**已经成功** ⇒ 「已保存当前窗口，但没能打开…」
 */
export const runIconClick = async (
  clickedTab: { windowId?: number } | undefined,
  deps: IconClickDeps
): Promise<IconClickOutcome> => {
  const windowId = resolveIconClickWindowId(clickedTab);

  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await deps.queryTabs(
      windowId === undefined ? { currentWindow: true } : { windowId }
    );
  } catch {
    // 还没走到保存方 ⇒ 没有任何人报过原因 ⇒ 这里必须给一句话
    await deps.notify(
      '无法保存当前窗口，请重试。如果问题持续，请重启浏览器。',
      'error'
    );
    return { kind: 'failed' };
  }

  let summary: { savedCount: number } | null;
  try {
    summary = await deps.saveAllTabs(tabs);
  } catch {
    // 保存方（`TabManager.saveAllTabs`）在抛出前**自己报过**原因
    // （「保存标签页时发生错误，请重试」）⇒ 不再补第二条错误提示
    // （重复报会让人以为是两个故障）。
    return { kind: 'failed' };
  }

  if (!summary) {
    // 保存方自己已经报了失败（并弹了具体原因：一个都没存下）
    // ⇒ 这里**不再重复报错**，也**不开管理器**（那会让用户以为存成了）。
    return { kind: 'nothing-saved' };
  }

  // 管理页开在**同一个窗口**里：多实例并存时，别把用户带到另一个窗口去。
  try {
    await deps.openTabManager(true, windowId);
  } catch {
    // ⚠️ 保存**已经成功**了 ⇒ 这里绝不能说「无法保存当前窗口」
    //   （那会让用户以为数据没存下，去重复操作）。
    await deps.notify('已保存当前窗口，但没能打开会话管理器。', 'error');
    return { kind: 'saved-but-manager-failed' };
  }

  return { kind: 'saved', savedCount: summary.savedCount };
};
