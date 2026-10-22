/**
 * 空态次级出口的**执行**判据（纯函数，2026-10-23 审计 R-12 收口）。
 *
 * ── 这个模块要防的回归类别 ────────────────────────────────────────────────
 *
 * 「**点了没反应、也没提示**」。
 *
 * 空态给了四个次级出口（登录 / 从云端拉回 / 打开设置 / 导入数据），
 * 它们各自指向一条**已经存在**的能力 ⇒ 接线看起来是显然的，
 * 也正因为显然，没有人给「点了会发生什么」写过一条断言：
 *
 *   · `TabList.tsx` 里 `onOpenAuth?.('login')` —— 宿主没传这个回调时，
 *     可选调用把它变成**什么都不做**（用户点「登录 TapStack 云端」，
 *     界面零变化、零提示 —— 他只会以为按钮坏了）；
 *   · `requestImport()` 没有订阅者时返回 false —— 那一格**会**出声
 *     （已有兜底），但没有任何测试钉住「它必须出声」。
 *
 * ⇒ 这条不变量收敛成一个纯函数：
 *
 *     **每个出口，要么触发一个可观察的状态变化，
 *       要么明确地什么都不做、并且出声说明为什么。**
 *
 *     没有第三条路。
 *
 * ── 为什么 IO 留在组件层 ────────────────────────────────────────────────
 *
 * 这里**不碰** chrome.*、不碰 store、不碰 toast —— 它只回答
 * 「这个出口该触发哪一个动作、做完算不算有交代」。
 * 真正的 IO 由组件注入（`EmptyStateExitDeps`）⇒ 这条不变量可以直接测：
 * 喂一组假 deps，看它到底调了谁、有没有出声。
 *
 * ── 为什么「哪个出口对应哪个动作」也归这里管 ────────────────────────────
 *
 * 早期版本把这个对应关系留在组件的 switch 里 ⇒ 组件一改接线，
 * 「登录出口到底调没调 openAuth」这件事就只能靠人读源码。
 * ⇒ 对应表放进判据层，组件只负责**注入**（把 chrome / store / toast 接上），
 * 「点了会发生什么」于是变成一条**可断言**的事实。
 */

/** 空态次级出口的种类。 */
export type EmptyStateAction = 'login' | 'download' | 'options' | 'import';

/**
 * 「这个出口此刻用不了」的**兜底**说明。
 *
 * 为什么要有兜底：调用方给的说明可能为空 ⇒ 那样「出声」就变成一句空话
 * ⇒ 等于把「点了没反应也没提示」这条缺陷换了个形状重新放回来。
 * ⇒ 这一层保证**永远有一句话**。
 */
export const EMPTY_STATE_EXIT_FALLBACK_MESSAGE = '这个出口暂时不可用，请稍后重试';

/**
 * 执行一个出口所需的**注入的副作用**。
 *
 * 每个 IO 返回 `boolean`：**这个动作此刻有没有真的发生**。
 * 返回 false 的含义是「点了不会有任何反应」⇒ 判据层会**替它出声**。
 */
export interface EmptyStateExitDeps {
  /**
   * 打开登录弹窗。**缺省** = 宿主没接上这个能力
   * （例如 TabList 没有收到 `onOpenAuth` 回调）⇒ 出口此刻不可用。
   */
  openAuth?: () => void;
  /** 打开设置页。 */
  openOptions: () => void;
  /** 从云端拉回会话（下载云端的会话列表到本机；与「恢复＝打开并消费」不是一件事）。 */
  restoreFromCloud: () => void;
  /** 请求打开导入。返回 false = 没有订阅者（实现了它的地方没挂上）。 */
  requestImport: () => boolean;
  /** 「此刻做不到」时的用户可见说明（按出口给；空的话 core 会用兜底句）。 */
  unavailableMessage: (action: EmptyStateAction) => string;
  /** 把这句说明交给用户（**出声**）。 */
  notifyUnavailable: (message: string) => void;
}

/** 一次出口执行的结果。 */
export type EmptyStateExitOutcome =
  /** 触发了一个可观察的状态变化（成功）。 */
  | { kind: 'handled' }
  /** 什么都没做成 —— 但**已经出声**说明了原因。 */
  | { kind: 'unavailable'; message: string };

/**
 * 执行一个空态出口。
 *
 * @param action 要执行的出口
 * @param deps   注入的副作用（IO 全在组件层）
 * @returns 执行结果；`unavailable` 时**一定**已经出声过了
 */
export function runEmptyStateExit(
  action: EmptyStateAction,
  deps: EmptyStateExitDeps
): EmptyStateExitOutcome {
  // 对应表（哪个出口 ⇒ 触发哪个动作）在这里，不在组件里 ——
  // 这样「点了会发生什么」是一条可以被断言的事实，而不是只能靠人读源码。
  let performed = false;
  switch (action) {
    case 'login':
      // `openAuth` 缺省 = 宿主没接上 ⇒ 这个出口此刻点了没反应。
      if (deps.openAuth) {
        deps.openAuth();
        performed = true;
      }
      break;
    case 'download':
      deps.restoreFromCloud();
      performed = true;
      break;
    case 'options':
      deps.openOptions();
      performed = true;
      break;
    case 'import':
      performed = deps.requestImport();
      break;
  }

  if (performed) return { kind: 'handled' };

  // 什么都没做成 ⇒ **必须出声**。
  // 「点了没反应也没提示」是本项目明令禁止的失败形态
  // （见 components/layout/importRequest.ts 的同一份理由）。
  const message = deps.unavailableMessage(action).trim() || EMPTY_STATE_EXIT_FALLBACK_MESSAGE;
  deps.notifyUnavailable(message);
  return { kind: 'unavailable', message };
}
