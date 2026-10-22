/**
 * 搜索页零结果页的**空态出口**（2026-10-23 审计 SC-4）。
 *
 * ── 缺陷本体 ──────────────────────────────────────────────────────────────
 * 主列表的空态给了三个出口（登录 / 从云端恢复 / 打开设置 / 导入），
 * 那是 L-11 专门为「换设备的老用户」准备的 —— 他的会话在云端，
 * 而自动同步默认打开与否不由他决定。
 *
 * 但搜索页的零结果分支把这一整块**藏掉了**：只有一句
 * 「没有找到与"X"相关的会话或标签，请尝试其他关键词」。
 * ⇒ 用户会话本来就在云端、却先搜了一下（或顺手加了筛选条件），
 *   他就**一条出路都没有** —— 空态那三个出口正是为这一刻准备的。
 *
 * ── 为什么复用，不另写一套 ────────────────────────────────────────────────
 * 「该给哪些出口」的判据住在 `components/tabs/emptyStateActions.ts`
 * （后端 × 登录态），「点了会发生什么」的判据住在 `core/emptyStateExits.ts`。
 * 两处都在**判据层**、与界面无关 ⇒ 搜索页直接复用它们即可。
 *
 * 另写一套的后果很具体：主列表说「登录 TapStack 云端」、
 * 搜索页说「登录账号」，同一个产品两套说法；主列表给三个出口、
 * 搜索页给两个 ⇒ 用户在两个界面遇到两种待遇。
 *
 * ── 这个模块只做一件事：把「界面注入的 IO」翻译成判据层认得的形状 ──────
 *
 * 真正的 IO（弹窗、设置页、同步协议、导入请求）由组件注入；
 * 这里只负责**接线**，于是「点了会发生什么」可以被直接测：
 * 喂一组假 IO，看每个出口到底调了谁。
 */
import type { EmptyStateAction, EmptyStateExitOutcome } from '@/core/emptyStateExits';
import { runEmptyStateExit } from '@/core/emptyStateExits';
import { EMPTY_STATE_EXIT_UNAVAILABLE } from '@/components/tabs/emptyStateActions';

/** 执行一个出口所需的**注入的副作用**（组件层提供）。 */
export interface SearchEmptyStateExitIo {
  /**
   * 打开登录弹窗。**缺省** = 宿主没接上这个能力 ⇒ 这个出口此刻不可用，
   * 判据层会替它出声（见 `EMPTY_STATE_EXIT_UNAVAILABLE.login`）。
   */
  openAuth?: () => void;
  /** 打开设置页。 */
  openOptions: () => void;
  /** 从云端拉回会话。 */
  restoreFromCloud: () => void;
  /** 请求打开导入。返回 false = 没有订阅者（实现了它的地方没挂上）。 */
  requestImport: () => boolean;
  /** 把「此刻用不了」的说明交给用户（**出声**）。 */
  notifyUnavailable: (message: string) => void;
}

/**
 * 执行一个空态出口。
 *
 * 与主列表的空态**走同一个判据层**（`runEmptyStateExit`）⇒
 * 「哪个出口对应哪个动作」「做不到时必须出声」这两条不变量
 * 在两个界面之间自动保持一致。
 *
 * @param action 要执行的出口
 * @param io     注入的副作用
 * @returns 执行结果；`unavailable` 时**一定**已经出声过了
 */
export const runSearchEmptyStateExit = (
  action: EmptyStateAction,
  io: SearchEmptyStateExitIo
): EmptyStateExitOutcome =>
  runEmptyStateExit(action, {
    // 宿主没给登录弹窗的回调 ⇒ 这个出口此刻**点了没反应**
    // ⇒ 不传这个键（=「这个能力此刻不存在」）⇒ 判据层会替它出声。
    ...(io.openAuth ? { openAuth: io.openAuth } : {}),
    openOptions: io.openOptions,
    restoreFromCloud: io.restoreFromCloud,
    requestImport: io.requestImport,
    unavailableMessage: which => EMPTY_STATE_EXIT_UNAVAILABLE[which],
    notifyUnavailable: io.notifyUnavailable,
  });
