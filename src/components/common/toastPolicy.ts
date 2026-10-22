/**
 * Toast 的**行为策略**：多久活、什么时候停、要不要抢焦点。
 *
 * ── 这个模块在防什么（2026-10-22 审计 P0-5）───────────────────────────────
 *
 * v1.26.0 给「恢复即消费」配了撤销按钮（提示上挂一个动作）—— 方向完全正确。
 * 但**那条退路够不着**，实测（`scripts/lead-interact.mjs` 的 Tab 焦点序列）：
 *
 *   "button:折叠会话：React 19 升级 PR",
 *   ...
 *   "button:撤销",          ← 撤销按钮排在焦点序列的**最后**
 *
 * 三个事实叠在一起，把退路变成了「只对已经知道它在哪、并且手速够快的人存在」：
 *
 *   1. toast 3 秒后自动消失（普通提示的时长）；
 *   2. hover **不会**暂停计时（原先 Toast.tsx 里没有 onMouseEnter/onMouseLeave，
 *      也没有 onFocus/onBlur）⇒ 鼠标想去够它的时候，倒计时不等人；
 *   3. toast 通过 createPortal 挂在 body 末尾 ⇒ 它的按钮在 Tab 序列的**最后**。
 *
 * 这不是「按钮没做出来」，是「做出来了但用户够不着」——
 * 与上一轮「排序没接线」是同一类错误的另一个形态：**控件存在 ≠ 控件可用**。
 *
 * ── 为什么抽成纯函数 ─────────────────────────────────────────────────────
 *
 * 计时逻辑如果直接写在组件里，就只能靠「真等 10 秒」来测 —— 既慢又脆
 * （而且真等会掩盖「暂停后从暂停处续走」这类时序错误）。
 * 这里把三件事抽成纯函数 + 注入时钟（形状照 `src/background/syncBackoff.ts`）：
 *   ① 时长由「有没有动作」决定（不是写死一个数）；
 *   ② 倒计时的暂停/续走/上限（可注入假时钟，不真等）；
 *   ③ 焦点要不要接管（输入中 / 对话框打开时 / 鼠标用户时都不接管）。
 *
 * 组件（Toast.tsx）只负责把 DOM 事件接到这些函数上。
 */

// ── 参数 ────────────────────────────────────────────────────────────

/** 普通提示的默认时长（毫秒）—— 与 ToastContext.showToast 的默认值一致。 */
export const TOAST_DEFAULT_DURATION_MS = 3000;

/**
 * 带**动作按钮**的提示至少活多久（毫秒）。
 *
 * 为什么是 8 秒：3 秒不够用户读完「卡片不见了」再决定退不退回 ——
 * 而这条退路的全部价值恰恰在于「用户**没料到**会消费掉数据」。
 * Chrome 自己的「重新打开已关闭的标签」也是这个量级（8–10 秒）。
 *
 * ⚠️ 这条**只对带动作的提示**生效：普通成功提示（不需要用户做决定）
 * 仍是 3 秒 —— 把那些也拖长只是让屏幕更吵。
 *
 * ⚠️ 2026-10-22：这个数**不许往回改**。它就是「撤销窗口」的长度，
 * 也是对外承诺过的口径（README / 商店文案里的「给了你一条退路」）。
 * 守卫 tests/guards/toastUndoReachability.test.ts 钉着「带动作 ⇒ ≥ 8 秒」，
 * 谁把它改回 3 秒，测试就红。
 */
export const TOAST_ACTION_DURATION_MS = 8000;

/**
 * 累计暂停的上限（毫秒）。
 *
 * 暂停是为了让「正在看这条提示的人」能从容决定；**不是**为了让提示永远赖着。
 * 鼠标停在提示上不动、或焦点一直留在里面，都会让计时一直停着 ——
 * 没有上限的话，这条提示就变成了一个用户自己都关不掉的东西。
 *
 * 到上限就强制收起（用户随时可以自己按「撤销」/「关闭」，不必等它消失）。
 */
export const TOAST_MAX_PAUSED_MS = 30000;

// ── 时长策略 ────────────────────────────────────────────────────────

/** 提示的种类（与 Toast.tsx 的 ToastType 同形；独立声明是为了不产生模块环）。 */
export type ToastKind = 'success' | 'error' | 'info' | 'warning';

/**
 * 这条提示该活多久（毫秒）。0 = 常驻（要用户手动关）。
 *
 * ── 判据（钉的是**性质**不是字面量）──────────────────────────────
 *
 *   · **有没有动作**决定要不要给「做决定」留时间：
 *     带动作 ⇒ 至少 TOAST_ACTION_DURATION_MS；不带 ⇒ 保持调用方给的时长
 *     （普通成功提示仍是 3 秒）。
 *   · **错误**且调用方没指定时长 ⇒ 常驻（错误不该一闪而过）。
 *     但**带动作的错误不常驻**：「部分成功」那种提示上挂着「撤销」，
 *     一条永远不消失的提示比一条 10 秒后消失的提示更糟（用户没法继续做事），
 *     而且它让「撤销窗口」变成了无限期 —— 与「可撤销是个有界的窗口」这个
 *     已定的口径冲突。
 *
 * ── 幂等 ──────────────────────────────────────────────────────────
 *
 * 这个函数**可以对自己再跑一遍**：ToastContext 先算一次存进队列，Toast
 * 组件再算一次。两遍结果必须一样 —— 否则「算两次」就会让时长变一次
 * （第一次 3000 → 第二次 10000，于是 Toast 里的倒计时比队列里记的长 7 秒）。
 *
 * 幂等性来自「每一支都返回同一个数」：
 *   · 0（常驻）⇒ 再算还是 0；
 *   · 带动作 ⇒ max(已算过的值, 下限) = 已算过的值（因为它已经 ≥ 下限）；
 *   · 不带动作 ⇒ 原样返回。
 */
export const resolveToastDuration = (
  kind: ToastKind,
  durationMs: number | undefined,
  hasAction: boolean,
): number => {
  // undefined = 调用方没指定 ⇒ 用默认时长（普通提示的 3 秒）。
  const requested = durationMs ?? TOAST_DEFAULT_DURATION_MS;
  // duration <= 0 = 调用方明确要求常驻（尊重它，不改写）。
  if (requested <= 0) return 0;
  // 错误 + 用了默认时长 + 没有动作 ⇒ 常驻。
  if (!hasAction && kind === 'error' && requested === TOAST_DEFAULT_DURATION_MS) {
    return 0;
  }
  // 带动作 ⇒ 至少给一个「能做决定」的窗口。
  if (hasAction) return Math.max(requested, TOAST_ACTION_DURATION_MS);
  return requested;
};

// ── 页面可见性策略 ────────────────────────────────────────────────────

/**
 * 页面「用户看不看得见」的两种状态。
 *
 * ⚠️ 这个分类是**实测**出来的，不是照文档抄的。实测过程见
 * `scripts/_v44-probe-vissignals.mjs` 与 `outputs/_v44-visibility/`。
 *
 * ── 实测结论（2026-10-22，Chromium 149 / Chrome 156）────────────────────
 *
 *   · `document.visibilityState` 在**所有**场景下都恒为 `'visible'` ——
 *     包括「管理页被切到后台标签」「所在窗口变成后台窗口」「窗口最小化」。
 *     `visibilitychange` 事件**一次都不触发**。
 *     ⇒ **靠 `visibilityState` 判断「用户看不看得见」在这条链路上是行不通的**
 *       （这不是实现 bug，是浏览器在这个场景下的行为；用裸 CDP 连系统 Chrome
 *       复验，结论一样）。
 *
 *   · `document.hasFocus()` **能**正确区分「活动标签」与「后台标签」
 *     （后台标签 = false），但前提是**关掉 Playwright 的焦点模拟**
 *     （`Emulation.setFocusEmulationEnabled`）。
 *
 *   · `window` 的 `blur` / `focus` 事件**会**在标签切换时触发
 *     （实测：切到后台 → blur；切回来 → focus）。
 *
 * ⇒ 所以「用户看不看得见」的判据用 **`focus` 事件 + `hasFocus()`**，
 *   `visibilityState` 只作为**附加**条件（万一某些环境它真的变了也不至于漏判）。
 *
 * ── 为什么这件事重要 ──────────────────────────────────────────────────
 *
 * 「恢复整个会话」会把管理页切到后台（另一路在修「把管理页带回前台」）。
 * 若提示的倒计时在用户看不见的时候照走 ⇒ 他切回来时退路已经过期 ⇒
 * 那次消费事实上不可逆 ⇒ 用户从头到尾不知道有过退路。
 *
 * ⚠️ 但**暂停的是计时，不是生命周期**：页面重新可见时从暂停处**继续**
 * （不是从头计时），且暂停有上限（见 TOAST_MAX_PAUSED_MS）——
 * 否则一个永远没人看的后台标签页会永久挂着一个提示。
 */
export type PageAttention = 'visible' | 'blurred';

/**
 * 读当前页面的注意力状态（DOM 相关的一层薄壳）。
 *
 * 判据：`document.hasFocus()` 为 false ⇒ 用户不在这个页面上（页签被切走、
 * 或窗口失去焦点）⇒ 倒计时该停。
 *
 * 为什么不用 `visibilityState`：见上面的实测结论 —— 它在这个场景下恒为
 * 'visible'，拿它判会**永远判不出「用户看不见」**。
 */
export const detectPageAttention = (): PageAttention => {
  if (typeof document === 'undefined') return 'visible';
  if (document.visibilityState === 'hidden') return 'blurred';
  // hasFocus 是 false 的两种情况都算「用户不在这里」：
  //   · 这个页签不是活动页签；
  //   · 浏览器窗口整体失去焦点（用户去点别的程序了）。
  // 后者同样该停：用户在别的程序里干活，切回来时提示还在、还有时间点撤销。
  return document.hasFocus() ? 'visible' : 'blurred';
};

// ── 暂停策略 ──────────────────────────────────────────────────────────

/** 决定「倒计时现在该不该停」所需要的三个事实。 */
export interface CountdownPauseInputs {
  /** 鼠标停在提示上。 */
  hovered: boolean;
  /** 焦点在提示里（键盘用户正在读它）。 */
  focused: boolean;
  /** 用户看得见这个页面吗（页签被切走 / 窗口失去焦点 ⇒ false）。 */
  pageSeen: boolean;
  /**
   * 这条提示上有没有要用户**做决定**的动作（撤销类）。
   *
   * 为什么只有「有决定」的提示才在用户看不见时暂停：暂停是为了**等人**。
   * 一条「已保存」的提示没有任何人要做的决定 ⇒ 用户不在时它就该按自己的
   * 节奏走完（走完了也就没人看得见它了）；而一条挂着「撤销」的提示，
   * 用户不在时它过期 ⇒ 那次消费就变成了**不可逆**，而用户连「这里原本
   * 可以撤销」都不知道。
   */
  hasDecision: boolean;
}

/**
 * 倒计时现在该不该停。
 *
 * ── 为什么抽成纯函数 ───────────────────────────────────────────────────
 *
 * 这三个触发条件是**或**关系，而这个「或」很容易在重构时被改成「与」
 * （比如「页面不可见 **且** 鼠标在上面才停」）—— 那种改动看起来更精细，
 * 实际上把「用户伸手去够按钮」这条最重要的路径改坏了。
 * 抽成纯函数 ⇒ 判据能被直接断言，且**改坏必红**。
 */
export const shouldPauseCountdown = (inputs: CountdownPauseInputs): boolean =>
  inputs.hovered || inputs.focused || (inputs.hasDecision && !inputs.pageSeen);

// ── 焦点接管策略 ────────────────────────────────────────────────────

/** 用户最近一次是用**键盘**还是**指针**在操作页面。 */
export type InputModality = 'keyboard' | 'pointer';

export interface FocusClaimInputs {
  /** 提示上有没有动作按钮。 */
  hasAction: boolean;
  /** 动作按钮是否要求接管焦点（撤销类才要求；「查看」类不该要求）。 */
  autoFocusRequested: boolean;
  /** 用户最近一次是用键盘还是指针在操作。 */
  inputModality: InputModality;
  /** 用户当前是不是在文本框里打字（不能打断）。 */
  userIsTyping: boolean;
  /** 页面上有没有开着模态对话框（不能把焦点从对话框里抢走）。 */
  dialogOpen: boolean;
  /**
   * 用户此刻**看得见**这个页面吗。
   *
   * 为什么必须判：页面看不见时抢焦点是「抢给空气」—— 焦点确实会落到按钮上，
   * 但用户看不到那个焦点环；等他切回来时，焦点还停在那条提示里 ⇒
   * 倒计时被「焦点在提示内」这条判据一直按着 ⇒ 提示赖着不走。
   * ⇒ 看不见就不抢。
   */
  pageSeen: boolean;
}

/**
 * 要不要把焦点交给这条提示里的动作按钮。
 *
 * ── 为什么必须是「有条件」的 ─────────────────────────────────────
 *
 * 抢焦点是很重的手法：焦点一动，用户的下一次按键/点击就落在别处了。
 * 四种情况**绝不能**抢：
 *   · 用户正在文本框里打字（抢了 ⇒ 他打的字没了）；
 *   · 页面上开着对话框（抢了 ⇒ 焦点跑出对话框，焦点陷阱失效）；
 *   · 用户是用**鼠标**点的那个按钮（抢了 ⇒ 他的下一次按键会落在
 *     「撤销」按钮上，空格/回车就会**误触撤销**；而且焦点在提示里
 *     ⇒ 倒计时被暂停 ⇒ 提示赖在屏幕底部不走）；
 *   · 页面此刻**用户看不见**（抢了 ⇒ 焦点环他看不到，而焦点留在提示里
 *     ⇒ 倒计时一直被按着 ⇒ 提示赖着不走）。
 *
 * 所以只对**键盘用户**接管：他们本来就是用回车激活按钮的，
 * 接管后「撤销」就是**零次按键**可达（回车即可）。
 */
export const decideFocusClaim = (inputs: FocusClaimInputs): boolean => {
  if (!inputs.hasAction) return false;
  if (!inputs.autoFocusRequested) return false;
  if (inputs.inputModality !== 'keyboard') return false;
  if (inputs.userIsTyping) return false;
  if (inputs.dialogOpen) return false;
  if (!inputs.pageSeen) return false;
  return true;
};

/**
 * 这个元素是不是「正在输入的地方」。
 *
 * 判据只看**形状**（标签名 / contentEditable），不看具体是哪个输入框 ——
 * 搜索框、备注框、设置页的密码框，对「不能抢焦点」这件事是同一回事。
 */
export const isTextEntryElement = (
  element: { tagName?: string; isContentEditable?: boolean } | null,
): boolean => {
  if (!element) return false;
  const tag = (element.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return element.isContentEditable === true;
};

// ── 输入方式嗅探（DOM 相关的一层薄壳）────────────────────────────────

/**
 * 记住用户最近一次是用**键盘**还是**指针**在操作。
 *
 * 为什么需要这个：焦点接管只对键盘用户做（见 decideFocusClaim 的理由）。
 * 判据用「最近一次输入事件是 keydown 还是 pointerdown」——
 * 这是 WAI-ARIA 推荐的「输入方式」判据，不是猜。
 *
 * 为什么用**模块级**状态而不是每个 Toast 各记一份：输入方式是**页面级**的事实
 * （用户就是在这个页面上用键盘的），而 toast 可能同时有好几条。
 */
let lastInputModality: InputModality = 'pointer';

/** 读当前输入方式。 */
export const detectInputModality = (): InputModality => lastInputModality;

/** 记下一次输入事件（供 detectInputModality 读）。 */
export const recordInputModality = (modality: InputModality): void => {
  lastInputModality = modality;
};

/**
 * 在 document 上装输入方式嗅探器。返回卸载函数。
 *
 * 装在**捕获阶段**、且用 passive —— 只读不拦，绝不干扰用户的输入。
 */
export const installInputModalityTracker = (): (() => void) => {
  const onKeyDown = () => recordInputModality('keyboard');
  const onPointerDown = () => recordInputModality('pointer');
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  return () => {
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
  };
};


// ── 倒计时状态机（纯函数）────────────────────────────────────────────

/**
 * 倒计时的状态。
 *
 * `remainingMs` 与 `deadlineAt` 分开存，是因为**暂停**要把剩余时间冻结：
 * 暂停时用 remainingMs（冻结值），恢复时用它重算 deadlineAt ——
 * 于是「从暂停处续走」而不是「从头开始」也不是「重新给一整段」。
 */
export interface CountdownState {
  /** 总时长（毫秒）。 */
  durationMs: number;
  /** 冻结的剩余毫秒（只在暂停时有意义）。 */
  remainingMs: number;
  /** 运行中：到点时刻（epoch ms）。 */
  deadlineAt: number;
  /** 是否在跑。 */
  running: boolean;
  /** 已经累计暂停了多久（毫秒）—— 用来判上限。 */
  pausedTotalMs: number;
  /** 本次暂停的开始时刻（未暂停时为 null）。 */
  pausedAt: number | null;
  /** 是否已经到期（到期后不再复活）。 */
  expired: boolean;
}

/** 起跑。 */
export const startCountdown = (durationMs: number, now: number): CountdownState => ({
  durationMs,
  remainingMs: durationMs,
  deadlineAt: now + durationMs,
  running: true,
  pausedTotalMs: 0,
  pausedAt: null,
  expired: false,
});

/**
 * 暂停：**冻结**剩余时间。
 *
 * 冻结而不是「停表」是刻意的：用户悬停 1 秒后移开，提示应该**只剩**原来的
 * 那么久，而不是重新给一整段（那等于每次悬停都续一次命 ⇒ 提示永远不走）。
 */
export const pauseCountdown = (state: CountdownState, now: number): CountdownState => {
  if (!state.running || state.expired) return state;
  const remainingMs = Math.max(0, state.deadlineAt - now);
  return { ...state, running: false, remainingMs, pausedAt: now };
};

/**
 * 恢复：**从冻结处继续**（deadlineAt = now + 冻结的剩余）。
 *
 * 累计暂停超过 TOAST_MAX_PAUSED_MS ⇒ 强制到期（绝不让提示永远赖着）。
 */
export const resumeCountdown = (state: CountdownState, now: number): CountdownState => {
  if (state.running || state.expired) return state;
  const pausedForMs = state.pausedAt === null ? 0 : Math.max(0, now - state.pausedAt);
  const pausedTotalMs = state.pausedTotalMs + pausedForMs;
  if (pausedTotalMs >= TOAST_MAX_PAUSED_MS) {
    return {
      ...state,
      running: false,
      pausedAt: null,
      pausedTotalMs,
      expired: true,
      remainingMs: 0,
    };
  }
  return {
    ...state,
    running: true,
    deadlineAt: now + state.remainingMs,
    pausedAt: null,
    pausedTotalMs,
  };
};

/** 此刻还剩多少毫秒（不推进状态，纯读）。 */
export const remainingAt = (state: CountdownState, now: number): number => {
  if (state.expired) return 0;
  if (state.running) return Math.max(0, state.deadlineAt - now);
  return state.remainingMs;
};

/** 强制到期（手动关闭、暂停超上限等）。 */
export const forceExpire = (state: CountdownState): CountdownState => ({
  ...state,
  running: false,
  expired: true,
  remainingMs: 0,
});

// ── 倒计时控制器（注入时钟）─────────────────────────────────────────

/**
 * 时钟契约。生产用 `window`（见 Toast.tsx），测试注入假时钟 ——
 * 于是「暂停 3 秒后剩余时间不变」这类判据不用真等。
 */
export interface ToastClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

export interface ToastCountdownOptions {
  durationMs: number;
  clock: ToastClock;
  /** 到期时调用（一般是「开始淡出」）。 */
  onExpire: () => void;
}

export interface ToastCountdownHandle {
  /** 暂停（幂等）。 */
  pause(): void;
  /** 恢复（幂等；累计暂停超上限则直接到期）。 */
  resume(): void;
  /** 此刻还剩多少毫秒。 */
  remainingMs(): number;
  /** 是否已到期。 */
  isExpired(): boolean;
  /** 拆除（卸载时调用；**不会**触发 onExpire）。 */
  dispose(): void;
}

/**
 * 倒计时控制器：把「暂停/续走/上限」接到真实计时器上。
 *
 * 每一条提示各自持有一个控制器 ⇒ **堆叠多条时每一条独立生效**
 * （悬停最上面那条不会让下面那些也停下来）。
 */
export const createToastCountdown = (
  options: ToastCountdownOptions,
): ToastCountdownHandle => {
  const { durationMs, clock, onExpire } = options;
  let state = startCountdown(durationMs, clock.now());
  let timer: number | null = null;
  let capTimer: number | null = null;
  let disposed = false;
  let fired = false;

  const clearTimers = (): void => {
    if (timer !== null) {
      clock.clearTimeout(timer);
      timer = null;
    }
    if (capTimer !== null) {
      clock.clearTimeout(capTimer);
      capTimer = null;
    }
  };

  const fire = (): void => {
    if (disposed || fired) return;
    fired = true;
    state = forceExpire(state);
    clearTimers();
    onExpire();
  };

  const schedule = (): void => {
    if (timer !== null) {
      clock.clearTimeout(timer);
      timer = null;
    }
    if (disposed || state.expired || !state.running) return;
    const remaining = remainingAt(state, clock.now());
    if (remaining <= 0) {
      fire();
      return;
    }
    timer = clock.setTimeout(() => {
      timer = null;
      if (state.running) fire();
    }, remaining);
  };

  /**
   * 暂停期间的「强制收起」计时器。
   *
   * 为什么需要它：光在**恢复时**检查上限是不够的 —— 用户把鼠标停在提示上
   * 不动，就永远不会「恢复」，那条提示就永远赖着。
   * 所以暂停一开始就挂一个上限计时器，到点直接收起。
   */
  const scheduleCap = (): void => {
    if (capTimer !== null) {
      clock.clearTimeout(capTimer);
      capTimer = null;
    }
    if (disposed || state.expired || state.pausedAt === null) return;
    const budget = Math.max(0, TOAST_MAX_PAUSED_MS - state.pausedTotalMs);
    capTimer = clock.setTimeout(() => {
      capTimer = null;
      fire();
    }, budget);
  };

  // ⚠️ 起点就要把计时器挂上（不是等到 resume 才挂）。
  //
  // 少了这一行 ⇒ 提示**永远不会自己消失**（只有 pause/resume 才会 schedule）。
  // 这类缺陷 tsc 与 eslint 都看不见：类型对、lint 干净、代码读起来完全合理 ——
  // 只有「倒计时到底有没有在跑」这种**行为**断言才能抓到它
  // （守卫 tests/guards/toastUndoReachability.test.ts 的「堆叠时互不影响」那条
  // 就是这么变红的：下面那条到点没有到期）。
  schedule();

  return {
    pause(): void {
      if (disposed || state.expired || !state.running) return;
      state = pauseCountdown(state, clock.now());
      if (timer !== null) {
        clock.clearTimeout(timer);
        timer = null;
      }
      scheduleCap();
    },
    resume(): void {
      if (disposed || state.expired || state.running) return;
      if (capTimer !== null) {
        clock.clearTimeout(capTimer);
        capTimer = null;
      }
      state = resumeCountdown(state, clock.now());
      if (state.expired) {
        fire();
        return;
      }
      schedule();
    },
    remainingMs(): number {
      return remainingAt(state, clock.now());
    },
    isExpired(): boolean {
      return state.expired;
    },
    dispose(): void {
      disposed = true;
      clearTimers();
    },
  };
};
