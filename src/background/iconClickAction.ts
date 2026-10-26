/**
 * 「点扩展图标」的动作 —— **收集当前窗口的标签（有的话），然后打开标签管理器**
 * （2026-10-26 产品定案）。
 *
 * ── 这个模块为什么存在 ──────────────────────────────────────────────────
 *
 * `service-worker.ts` 是**有副作用的模块**（一 import 就注册一堆 chrome 监听器），
 * 而本仓的纪律是「守卫必须钉**行为**，钉源码长相等于零检测力」
 * （见 memory：接线守卫必须真的调用那条路径）。
 * ⇒ 把这段决策抽成**依赖注入**的纯逻辑：chrome API 全部从外面传进来，
 *   于是它能被单测直接调用、能被变异自证打断。
 *
 * ── 交互契约（2026-10-26，产品负责人定案）───────────────────────────────
 *
 *   点扩展图标 ⇒ 打开**标签管理器**（一定会打开）
 *              ⇒ 这一窗**有可收集的标签** ⇒ 先收集（存成会话并关掉这些标签）
 *              ⇒ 这一窗**没有可收集的标签** ⇒ 什么都不收集，直接打开管理器
 *
 * ⚠️ 与 2026-10-24 那一版的关系：那一版是「保存当前窗口并关闭这些标签，
 *   随后打开会话管理器」—— **多实例并存时旧交互才是对的**（动作发生在
 *   点的那一边、结果当场可见），2026-10-22 审计 P0-1 的「只打开管理器」
 *   被推翻。本版**不是**回到那个被推翻的版本：
 *   · 「收集在前、管理器在后」的顺序**保留**（多实例正确性靠它）；
 *   · 变的是**兜底**：以前「一个都没存下」就**什么都不做**（只弹一条错误
 *     通知）⇒ 用户点了图标，屏幕上什么都没发生 ⇒ 「点了像没点」——
 *     正是 2026-10-24 推翻 P0-1 时要消灭的那种体验。
 *
 * ── 为什么「没有可收集的标签」时**不**报那条错误 ──────────────────────────
 *
 * 「当前窗口里没有可保存的标签页」这条错误是给**快捷键**（⌘⇧S）准备的：
 * 那条路上用户按了键、屏幕上零反馈 ⇒ 必须给一句话。
 * 而点图标这条路上，用户**确实**得到了东西 —— 管理器打开了（他能看到自己的
 * 会话列表）⇒ 再补一条「没有可保存的标签页」的错误，等于对着一个**成功**
 * 的动作报错。
 * ⇒ 所以点图标这条路**先判断**「有没有可收集的标签」：
 *   没有 ⇒ **根本不进保存**（也就不会触发那条错误通知）⇒ 直接打开管理器。
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
  /**
   * 这批标签里有几个是**可收集**的（= 会被存进会话的那些）。
   *
   * 必须与**保存路径**同一套判据（domain 层的 `collectableTabs`）——
   * 否则会出现「图标说有、实际存不下」。
   */
  countCollectableTabs: (tabs: chrome.tabs.Tab[]) => Promise<number>;
  /** 保存整窗并关闭（`TabManager.saveAllTabs`）。返回 null = 一个都没存下。 */
  saveAllTabs: (tabs: chrome.tabs.Tab[]) => Promise<{ savedCount: number } | null>;
  /** 打开会话管理器（可指定开在哪个窗口）。 */
  openTabManager: (shouldRefresh: boolean, windowId?: number) => Promise<void>;
  /** 通知（success / error）。 */
  notify: (message: string, kind: 'success' | 'info' | 'error') => Promise<void>;
}

/**
 * 一次图标点击的结果（供调用方与守卫断言）。
 *
 * `managerOpened` 是**独立的一条**：新契约下「管理器有没有打开」与
 * 「收集成没成」是两件事 ——
 * 收集失败**也要**打开管理器（用户点了图标，就得落到管理器上）。
 */
export type IconClickOutcome =
  /** 收集成了（存了 N 个），管理器也打开了。 */
  | { kind: 'saved'; savedCount: number; managerOpened: boolean }
  /** 这一窗**没有可收集的标签** ⇒ 什么都没收集，管理器打开了。 */
  | { kind: 'nothing-to-collect'; managerOpened: boolean }
  /** 收集出错了（原因已由出错的那一层报过），管理器仍然打开了。 */
  | { kind: 'collect-failed'; managerOpened: boolean };

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
 * ── 每一段失败都有自己那一句「人话」 ─────────────────────────────────────
 *
 * 旧实现（v1.25.x）是一个大 try/catch ⇒ 任何异常都报同一句
 * 「无法保存当前窗口」—— 包括**保存已经成功、只是管理器没打开**那种
 * ⇒ 用户被告知「没存下」⇒ 去重复操作 ⇒ 存出一堆重复会话。
 * 现在按**谁出的错**分开说：
 *
 *   · 标签都没查到手    ⇒ 什么都没发生 ⇒ 「无法保存当前窗口…」
 *   · 保存方抛错        ⇒ 保存方自己报过原因（不重复报）
 *   · 管理器没打开      ⇒ 按**有没有收集成功**分两句说（不许谎报「已保存」）
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
    // 但**管理器照样打开**（新契约：点了图标就得落到管理器上）。
    return { kind: 'collect-failed', managerOpened: await openManager(deps, windowId, false) };
  }

  // ── 先判断「有没有可收集的标签」 ────────────────────────────────────────
  // 判不出来（抛错）时**照常尝试收集** —— 判断失败不等于没有可收集的标签，
  // 宁可多存一次（存了是用户想要的），也不要因为一次判断失败就跳过收集。
  let collectable: number | null = null;
  try {
    collectable = await deps.countCollectableTabs(tabs);
  } catch {
    collectable = null;
  }

  if (collectable === 0) {
    // 没有可收集的标签 ⇒ **不进保存**（也就不会弹「没有可保存的标签页」
    // 那条错误）⇒ 直接打开管理器。
    return { kind: 'nothing-to-collect', managerOpened: await openManager(deps, windowId, false) };
  }

  let summary: { savedCount: number } | null;
  try {
    summary = await deps.saveAllTabs(tabs);
  } catch {
    // 保存方（`TabManager.saveAllTabs`）在抛出前**自己报过**原因
    // （「保存标签页时发生错误，请重试」）⇒ 不再补第二条错误提示
    // （重复报会让人以为是两个故障）。
    return { kind: 'collect-failed', managerOpened: await openManager(deps, windowId, false) };
  }

  if (!summary) {
    // 保存方自己已经报了失败（并弹了具体原因：一个都没存下）
    // ⇒ 这里**不再重复报错**，但**仍然打开管理器**（新契约）。
    return { kind: 'collect-failed', managerOpened: await openManager(deps, windowId, false) };
  }

  // 管理页开在**同一个窗口**里：多实例并存时，别把用户带到另一个窗口去。
  const managerOpened = await openManager(deps, windowId, true);
  return { kind: 'saved', savedCount: summary.savedCount, managerOpened };
};

/**
 * 打开管理器；打不开时给一句**不撒谎**的话。
 *
 * @param collected 这条路上**是否真的收集成功了**（决定措辞能不能说「已保存」）
 * @returns 管理器有没有打开
 */
const openManager = async (
  deps: IconClickDeps,
  windowId: number | undefined,
  collected: boolean
): Promise<boolean> => {
  try {
    await deps.openTabManager(true, windowId);
    return true;
  } catch {
    // ⚠️ **不许**谎报「已保存」：没收集成功时说「已保存当前窗口」＝ 骗人
    //   （用户会以为数据存下了，其实没有）。
    await deps.notify(
      collected
        ? '已保存当前窗口，但没能打开会话管理器。'
        : '没能打开会话管理器。',
      'error'
    );
    return false;
  }
};
