import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  createToastCountdown,
  decideFocusClaim,
  detectInputModality,
  detectPageAttention,
  isTextEntryElement,
  resolveToastDuration,
  shouldPauseCountdown,
  type ToastClock,
  type ToastKind,
} from './toastPolicy';

export type ToastType = ToastKind;

/**
 * Toast 类型的中文标签（2026-10-07 P2-3）。
 *
 * 原先直接把 `{type}` 渲染进界面，于是一个全中文的产品在每一条成功/失败/
 * 提示上都会蹦出 SUCCESS / ERROR / WARNING 三个英文大写词（还带
 * `uppercase tracking-[0.18em]` 的标签样式）。这是**所有反馈的唯一通道** ——
 * 也就是说「每一条反馈都带一个英文单词」。
 */
const TYPE_LABEL: Record<ToastType, string> = {
  error: '出错',
  info: '提示',
  warning: '注意',
};

/**
 * Toast 上的**动作按钮**（2026-10-22 审计 P0-4：撤销「恢复即消费」）。
 *
 * 为什么需要它：产品里有些操作是**不可逆**的（恢复会话 = 消费掉那条记录），
 * 而「按了键之后给一条可点回去的路」是这类产品该有的最低配置 ——
 * Chrome 自己的「重新打开已关闭的标签」、Dropbox 的「撤销删除」都是这个形状。
 *
 * 形状说明：
 *   · 动作按钮**常驻可见**（不是 hover 才出现）—— 鼠标不在 toast 上时用户
 *     也必须看得见还有一条退路；
 *   · 点了动作之后 toast 立即退场（动作已经执行，再留着是噪音）；
 *   · 命中区按本项目自己的规则给到 36px（`min-h-9 min-w-9`，见
 *     components/layout/hitTarget.ts 的口径说明）。
 */
export interface ToastAction {
  /** 按钮文字。必须是一个**动作**（动词），不是一个状态。 */
  label: string;
  /** 点击后执行。抛错由调用方自己处理（组件不吞异常，也不假装成功）。 */
  onAction: () => void;
  /**
   * 出现时**要不要把焦点交到这个按钮上**。
   *
   * 默认 false。只有「不可逆操作的退路」（撤销）才该设 true ——
   * 抢焦点是很重的手法，判据见 toastPolicy.ts 的 decideFocusClaim。
   */
  autoFocus?: boolean;
}

interface ToastProps {
  message: string;
  type?: ToastType;
  duration?: number;
  onClose?: () => void;
  visible: boolean;
  /**
   * 离底边多远（px）—— 由上层按**实测高度**算好（见 toastStack.ts）。
   *
   * ⚠️ 旧实现这里是「堆叠序号」，偏移量写死成 `序号 * 76` ⇒
   * 一条**多行**的提示会被下面那条压住下半截 ⇒ 用户读不到结尾。
   * ⇒ 现在传的是**像素偏移**，由 ToastContext 累加各条**实测高度**得出。
   */
  stackOffset?: number;
  /**
   * 把这条提示的**实测高度**报给上层（用来堆叠时不互相遮挡）。
   *
   * 为什么要实测：提示的高度**取决于文案长度**（一行还是五行），
   * 写死的数字必然会在某条长提示上错 ⇒ 盖住用户必须看到的那半句。
   */
  onHeightChange?: (height: number) => void;
  /** 可选的「撤销/重做」动作按钮。给了就多一条退路。 */
  action?: ToastAction;
}

/**
 * 进度条收缩动画的 keyframes。
 * 原来是 setInterval(…, 60) 驱动一个 React state，只为了画一段 scaleX——
 * 每个 toast 白白重渲染约 50 次。改成纯 CSS 动画后重渲染次数归零。
 */
const PROGRESS_KEYFRAMES =
  '@keyframes tapstack-toast-progress { from { transform: scaleX(1); } to { transform: scaleX(0); } }';

/**
 * 生产时钟（注入点：toastPolicy 的倒计时控制器要一个时钟）。
 *
 * 用 `window` 而不是全局 `setTimeout`/`Date.now`：这样测试可以整套换成假时钟，
 * 于是「暂停 3 秒后剩余时间不变」这类判据不用真等。
 */
const WINDOW_CLOCK: ToastClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

export const Toast: React.FC<ToastProps> = ({
  message,
  type = 'info',
  duration = 3000,
  onClose,
  visible,
  stackOffset = 0,
  onHeightChange,
  action,
}) => {
  const [isVisible, setIsVisible] = useState(visible);
  const [animation, setAnimation] = useState('animate-fadeIn');
  // 进度条是不是在「走」。暂停时它必须跟着停 —— 否则就是界面在说谎
  // （进度条还在缩，实际却没在计时）。
  const [progressRunning, setProgressRunning] = useState(true);

  // 动作按钮的 DOM 引用：焦点接管要用它。
  const actionRef = useRef<HTMLButtonElement | null>(null);
  // 倒计时控制器：暂停/续走都在它上面做（每条提示一个 ⇒ 堆叠时互不影响）。
  const countdownRef = useRef<ReturnType<typeof createToastCountdown> | null>(null);
  // 提示自己的 DOM：用来判断「焦点是不是还停在这条提示里」。
  const cardRef = useRef<HTMLDivElement | null>(null);
  // 提示出现**之前**焦点在哪 —— 提示退场时要把焦点还回去。
  //
  // 为什么必须还：抢了焦点就必须还，否则提示一消失，焦点就掉到 <body> ——
  // 用户「回到列表」的那个位置没了（他得从头 Tab 一遍）。同理，用户用鼠标
  // 点完「撤销」，那个按钮随提示一起被卸载 ⇒ 焦点同样掉到 body。
  const preToastFocusRef = useRef<HTMLElement | null>(null);
  // 「鼠标停在提示上」与「焦点在提示里」是**两个独立的**事实 ——
  // 倒计时在**任一**成立时就该停住。所以分开记，再合成一个「是否暂停」。
  //
  // 为什么不能合成一个布尔量：鼠标移出提示，但焦点还在「撤销」按钮上时
  // （键盘用户 + 鼠标恰好扫过），若只看鼠标 ⇒ 倒计时恢复 ⇒ 提示在用户
  // 正看着那个按钮的时候消失 ⇒ 退路又没了。
  const hoveredRef = useRef(false);
  const focusedRef = useRef(false);
  // 「用户此刻看得见这个页面吗」—— 第三个暂停触发条件（2026-10-22 主审追加）。
  //
  // 为什么需要它：「恢复整个会话」会把管理页**从用户眼前拿走**
  // （新标签 active:true ⇒ 管理页退为后台标签；新窗口 focused:true ⇒
  // 管理页所在窗口变成后台窗口）。提示的 DOM 还在，但用户看不见 ⇒
  // 倒计时照走 ⇒ 他切回来时退路已经过期 ⇒ 那次消费事实上不可逆，
  // 而用户从头到尾**不知道有过退路**。
  //
  // ⚠️ 暂停的是**计时**，不是**生命周期**：重新可见时从暂停处**继续**
  //（不是从头计时），且暂停有上限（toastPolicy.TOAST_MAX_PAUSED_MS）⇒
  // 一个永远没人看的后台标签页不会永久挂着一个提示。
  const pageSeenRef = useRef(true);

  // onClose 每次渲染都是新的函数引用（ToastContext 里的箭头函数），
  // 放进 effect 依赖会让「弹窗期间再来一个弹窗」把计时器重置、动画重播。
  // 用 ref 取最新值，effect 只依赖 visible / duration。
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // onHeightChange 同样是「每次渲染都新的引用」⇒ 用 ref 取最新值，
  // 免得高度回调一变就重开观察器。
  const onHeightChangeRef = useRef(onHeightChange);
  useEffect(() => {
    onHeightChangeRef.current = onHeightChange;
  });

  /**
   * 把**实测高度**报给上层 —— 堆叠时按真实高度错开，而不是按写死的数字。
   *
   * ── 为什么必须实测 ────────────────────────────────────────────────────
   *
   * 提示的高度**取决于文案长度**（一行还是五行）。旧实现把偏移写死成
   * `序号 * 76`（= 一条单行提示的**估计**高度）⇒ 一条**多行**提示必然
   * 被下面那条压住下半截 ⇒ **用户读不到结尾**。
   *
   * 撞到这件事的是 OneTab 导入的**必说披露**（5 行）⇒ 被盖掉的正好是
   * 「这些会话的保存时间未知，列表里显示为「导入 · …」」那半句 ⇒
   * 说了等于没说。根因不在文案，在**堆叠算法**。
   *
   * ⚠️ 这个缺陷**早于**本次修复就存在（旧披露也有 4 行，同样被盖）——
   * 实证：把打包产物里的那句提示删短、重跑同一个探针 ⇒ 照样被盖。
   *
   * ── 测量口径 ──────────────────────────────────────────────────────────
   *
   * 用 `offsetHeight`（**不受 transform 影响**的布局高度）而不是
   * `getBoundingClientRect().height` —— 退场动画 `animate-fadeOut` 带
   * `translateY`，用它会被父级的 transform 干扰。
   */
  useEffect(() => {
    if (!isVisible) return;
    const card = cardRef.current;
    if (!card) return;
    const report = () => {
      const height = card.offsetHeight;
      if (height > 0) onHeightChangeRef.current?.(height);
    };
    // 先同步量一次（首帧就要拿到高度，否则第一帧按兜底值排 ⇒ 会跳一下）。
    report();
    if (typeof ResizeObserver === 'undefined') return;
    // 窗口变窄 ⇒ 文案重排 ⇒ 高度变了 ⇒ 重新报（否则会重新开始被盖）。
    const observer = new ResizeObserver(report);
    observer.observe(card);
    return () => observer.disconnect();
  }, [isVisible]);

  // 时长由「有没有动作」决定（不是写死一个数）——
  // 带动作的提示要给用户一个能做决定的窗口，普通提示仍是 3 秒。
  //
  // ⚠️ 幂等：ToastContext 存进队列时已经算过一次，这里再算一次是同一个值
  // （resolveToastDuration 对已算过的值再算一遍不改变它 —— 见该函数说明）。
  // 这样 Toast 组件无论是被 ToastContext 驱动还是被直接使用，时长口径一致。
  const effectiveDuration = resolveToastDuration(type, duration, action !== undefined);

  /**
   * 退场时把焦点还回去。
   *
   * 判据（钉的是**性质**）：**只有当焦点此刻仍然停在这条提示里**才还。
   * 如果用户已经把焦点挪到别处（他正在别的地方做事），还焦会把他拽回来 ——
   * 那比不还更糟。
   *
   * ⚠️ 必须在**提示还在 DOM 里的时候**判断「焦点是否在提示内」：
   * 提示被卸载的那一刻，浏览器会把焦点丢到 <body>，那时再问
   * 「activeElement 在不在提示里」永远是「不在」⇒ 永远还不回去。
   * 所以判据在**隐藏的那一刻**做（dismiss / 倒计时到期两处）。
   */
  const restoreFocusIfInside = () => {
    const card = cardRef.current;
    if (!card) return;
    const active = document.activeElement as HTMLElement | null;
    if (!active || !card.contains(active)) return;
    const target = preToastFocusRef.current;
    preToastFocusRef.current = null;
    // 目标可能已经不在文档里了（用户点的那个按钮随列表重排被卸载了）⇒ 不还。
    if (target && target.isConnected) {
      target.focus();
    }
  };

  useEffect(() => {
    setIsVisible(visible);
    if (!visible) return;

    setAnimation('animate-fadeIn');
    setProgressRunning(true);
    // 重新入场 ⇒ 重置「悬停/聚焦」这两个事实（上一轮的暂停不该延续到这一轮）。
    hoveredRef.current = false;
    focusedRef.current = false;

    // effectiveDuration <= 0 表示常驻（error 默认），需用户手动关闭
    if (effectiveDuration <= 0) return;

    let fadeOutTimer: ReturnType<typeof setTimeout> | undefined = undefined;

    const countdown = createToastCountdown({
      durationMs: effectiveDuration,
      clock: WINDOW_CLOCK,
      onExpire: () => {
        setAnimation('animate-fadeOut');
        fadeOutTimer = setTimeout(() => {
          // 退场前还焦（提示此时还在 DOM 里 ⇒ 判断「焦点是否在提示内」有效）。
          restoreFocusIfInside();
          setIsVisible(false);
          onCloseRef.current?.();
        }, 300);
      },
    });
    countdownRef.current = countdown;

    return () => {
      countdown.dispose();
      countdownRef.current = null;
      if (fadeOutTimer !== undefined) clearTimeout(fadeOutTimer);
    };
  }, [visible, effectiveDuration]);

  /**
   * 「用户看不看得见这个页面」⇒ 倒计时跟着停。
   *
   * ── 为什么监听这三个信号 ────────────────────────────────────────────
   *
   *   · `visibilitychange`（document）：主审要求的判据
   *     （`document.visibilityState === 'hidden'`）。**实测**在本项目的
   *     真实场景里它几乎不触发（后台标签/后台窗口都还是 'visible'），
   *     但留着它不亏：万一某个环境它真的变了，也不至于漏判。
   *   · `focus` / `blur`（window）：**实测唯一可靠**的信号 ——
   *     标签被切走 ⇒ blur；切回来 ⇒ focus。
   *   · `document.hasFocus()`：作为读数（见 toastPolicy.detectPageAttention），
   *     用来在「事件还没来」的时刻也判得准。
   *
   * ⚠️ 为什么不用 `visibilityState` 单独判：实测（2026-10-22，真机 + 真扩展，
   * 11 组探针）它在「管理页被切到后台标签」「所在窗口变成后台窗口」
   * 「窗口最小化」三种场景下**恒为 'visible'**，`visibilitychange` 一次都不触发。
   * 只按它判 ⇒ 这条暂停**永远不生效** ⇒ 退路照样在用户看不见的时候过期。
   * ⇒ 判据是「visibilityState 变 hidden **或** hasFocus() 为 false」
   *（后者才是实测能翻转的那一位）。
   *
   * ⚠️ 顺序：必须声明在**倒计时 effect 之后** —— 挂上监听时要先同步一次
   * 初始状态，而那时倒计时控制器必须已经存在（否则 pause() 打在空气上）。
   */
  useEffect(() => {
    if (!visible) return;
    const update = () => {
      const seen = detectPageAttention() === 'visible';
      if (seen === pageSeenRef.current) return;
      pageSeenRef.current = seen;
      syncPauseState();
    };
    // 提示可能是在页面**已经失去焦点之后**才挂上来的（「恢复整组」会新开
    // 窗口抢焦点，那时提示才刚创建）⇒ 挂上监听时先按当前状态同步一次。
    pageSeenRef.current = detectPageAttention() === 'visible';
    syncPauseState();
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
    };
  }, [visible]);

  /**
   * 暂停 / 恢复倒计时。
   *
   * 为什么 hover 必须能暂停：这条提示上可能挂着一条**不可逆操作的退路**
   * （撤销）。而「用户伸手去够那个按钮」这件事本身要花时间 ——
   * 提示在用户伸手的过程中消失，等于没有这条退路。
   *
   * 为什么 focus 也要暂停：键盘用户用 Tab 走到「撤销」按钮上时，
   * 他正在「读」那条提示（读提示与读按钮是要时间的）。
   *
   * 为什么「用户看不见这个页面」也要暂停：管理页被整组恢复推到后台时，
   * 提示还在但没人看得见它 ⇒ 计时照走 ⇒ 用户切回来时退路已经过期
   * ⇒ 那次消费不可逆，而用户不知道有过退路。
   *
   * ⚠️ 三个条件是**或**关系（判据在 toastPolicy.shouldPauseCountdown，
   * 纯函数、可单测）：鼠标与焦点**分开**记 —— 只有两者都不成立才恢复，
   * 鼠标扫过提示（触发 mouseenter/mouseleave）不该把正在读按钮的
   * 键盘用户的倒计时叫醒。
   *
   * ⚠️ 「用户看不见」这一条**只对挂着动作的提示**生效：没有决定要做的
   * 提示（「已保存」）不必等人 —— 它过期了也没人损失什么，而一条永远
   * 赖在屏幕底下的旧提示是在给用户添乱。
   */
  const syncPauseState = () => {
    const shouldPause = shouldPauseCountdown({
      hovered: hoveredRef.current,
      focused: focusedRef.current,
      pageSeen: pageSeenRef.current,
      hasDecision: action !== undefined,
    });
    if (shouldPause) {
      countdownRef.current?.pause();
      setProgressRunning(false);
    } else {
      countdownRef.current?.resume();
      setProgressRunning(true);
    }
  };

  const onMouseEnter = () => {
    hoveredRef.current = true;
    syncPauseState();
  };

  const onMouseLeave = () => {
    hoveredRef.current = false;
    syncPauseState();
  };

  // React 的 onFocus/onBlur 走的是 focusin/focusout（会冒泡）⇒
  // 焦点落在提示里的**任何**子元素上都会触发。
  const onFocusIn = () => {
    focusedRef.current = true;
    syncPauseState();
  };

  const onFocusOut = (event: React.FocusEvent<HTMLDivElement>) => {
    // 焦点还在提示内（从「撤销」移到「关闭」）⇒ 仍在读这条提示 ⇒ 不恢复计时。
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    focusedRef.current = false;
    syncPauseState();
  };

  /**
   * 焦点接管：把焦点交到「撤销」按钮上，让键盘用户**零次按键**就能撤销。
   *
   * 判据全在 toastPolicy.decideFocusClaim 里（纯函数，可单测）：
   * 只有「键盘用户 + 不在输入框里 + 没有对话框开着 + 动作要求接管」才抢。
   *
   * 为什么要这个：实测 Tab 序列里「撤销」排在**最后** —— 键盘用户要点到它
   * 要按十几次 Tab，而提示那会儿已经没了。抢焦点把这条退路变成一次回车。
   *
   * ⚠️ 幂等判据用 **DOM 现状**（按钮是不是已经是当前焦点）而不是 ref 标志：
   * ref 标志在 React StrictMode 的双调用下会「第一次置位、第二次跳过」⇒
   * 开发模式下永远抢不到焦点。DOM 现状是唯一可靠的事实来源。
   */
  useEffect(() => {
    if (!visible || !action) return;
    if (action.autoFocus !== true) return;
    if (actionRef.current === document.activeElement) return;

    const claim = decideFocusClaim({
      hasAction: true,
      autoFocusRequested: true,
      inputModality: detectInputModality(),
      userIsTyping: isTextEntryElement(document.activeElement as HTMLElement | null),
      dialogOpen: document.querySelector('[role="dialog"]') !== null,
      // 页面看不见就别抢：抢了也是「抢给空气」，而焦点留在提示里 ⇒
      // 倒计时一直被按着 ⇒ 提示赖着不走（见 decideFocusClaim 的说明）。
      pageSeen: detectPageAttention() === 'visible',
    });
    if (!claim) return;

    // 记住「抢之前焦点在哪」—— 退场时还回去（见 restoreFocusIfInside）。
    // 若当时焦点就在动作按钮上（理论上不该发生），就别还 —— 还了等于还一个
    // 马上要被卸载的按钮。
    const before = document.activeElement as HTMLElement | null;
    preToastFocusRef.current = before === actionRef.current ? null : before;

    // 下一帧再抢：此刻按钮可能还没渲染出来（首次渲染时 action 按钮在同一帧，
    // 但队列变化时不是）。requestAnimationFrame 让「元素已存在」这件事先成立。
    const raf = requestAnimationFrame(() => {
      if (actionRef.current === document.activeElement) return;
      actionRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [visible, action]);

  /**
   * Toast 的三段配色：**壳体跟主题，类型色是语义色**（2026-10-23 审计 V-7）。
   *
   * 修复前整块写死：壳底 `bg-white/95`、壳字 `text-slate-800`、
   * 深色态 `dark:bg-slate-900/95 dark:text-slate-800` ⇒ 6 套主题 × 明暗
   * 实测**没有一组**跟主题走（claude 暖纸主题里弹出一张冷白 / 石板灰卡片）。
   *
   * 现在：
   *   · 壳体读 `--color-bg-elevated` + `--color-text-primary`（主题令牌，
   *     深浅自动翻面 ⇒ 不需要 `dark:` 变体）；
   *   · 描边读 `--color-border-default`；
   *   · 类型色（rose / sky / amber）**保留** —— 危险=红、注意=琥珀
   *     是通用约定，不是「某个品牌的配色」；
   *   · 顶部进度条改读主题的语义色令牌（--color-accent / --color-danger），
   *     这样进度条与图标徽章是同一支色。
   *
   * ⚠️ 2026-10-25「安静的成功」：这里**没有**绿色那一档 ——
   * 「成功是状态，不是事件」⇒ 提示层不再有「完成」这个语义。
   */
  const getTypeStyles = () => {
    switch (type) {
      case 'error':
        return {
          shell: 'theme-bg-elevated theme-text-primary theme-border-default border',
          accent: 'bg-[var(--color-danger)]',
          iconWrap: 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300',
        };
      case 'warning':
        return {
          shell: 'theme-bg-elevated theme-text-primary theme-border-default border',
          accent: 'bg-[var(--color-warning)]',
          iconWrap: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
        };
      case 'info':
      default:
        // ⚠️ 2026-10-25 审阅后修正：`info` 与兜底**合并成一支**。
        // 联合类型已封闭（`ToastType` 不含 `'success'`）⇒ `default:` 是**死分支**，
        // 而它原先与 `case 'info':` 的内容**逐字重复**（两处重复的配色 / 图标
        // 迟早会漂移）。⇒ 合成一支：既没有重复，也保留了运行期兜底 ——
        // 万一有非 TS 的调用方传了意外类型，仍然走中性图标而不是崩。
        // 没有绿色那一档：成功是状态不是事件。
        return {
          shell: 'theme-bg-elevated theme-text-primary theme-border-default border',
          accent: 'bg-[var(--color-accent)]',
          iconWrap: 'bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300',
        };
    }
  };

  const getIcon = () => {
    switch (type) {
      case 'error':
        return (
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
          </svg>
        );
      case 'warning':
        return (
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
        );
      case 'info':
      default:
        // ⚠️ 2026-10-25 审阅后修正：与 `getTypeStyles` 同一处修正 ——
        // `default:` 是**死分支**（联合类型已封闭），而它原先与 `case 'info':`
        // 的图标**逐字重复**（两处重复的 SVG 迟早会漂移）⇒ 合成一支。
        // 保留 default 作为运行期兜底：万一有非 TS 的调用方传了意外类型，
        // 仍然走中性图标而不是崩。
        // 没有「对勾」那一档：成功是状态不是事件。
        return (
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
          </svg>
        );
    }
  };

  const typeStyles = getTypeStyles();

  /**
   * 退场：淡出 → 卸载 → 通知上层从队列里移除。
   *
   * 抽成函数是因为「点关闭」与「点动作」两条路径的退场必须完全一致 ——
   * 动作执行完若还把 toast 留在原地，用户会以为动作没生效（而动作其实做完了）。
   */
  const dismiss = () => {
    setAnimation('animate-fadeOut');
    setTimeout(() => {
      // 退场前还焦（点「关闭」/ 点动作之后，焦点不该掉到 body）。
      restoreFocusIfInside();
      setIsVisible(false);
      onCloseRef.current?.();
    }, 220);
  };

  // 错误要打断当前朗读（assertive），其余提示排队等空档（polite）。
  //
  // ⚠️ 「带动作」的提示**不因此变成 assertive**：只有**错误**才打断。
  // 「撤销」那条是普通提示（role=status，polite）—— 打断读屏会让正在读
  // 别的内容的用户被抢走注意力，而这条提示并不紧急。
  const isAssertive = type === 'error';

  // 外层 live region 永远挂载（不可见时只留一个空壳，不 display:none）：
  // 读屏只播报「已经存在于无障碍树里的区域」的内容变化，
  // 区域和文案同一帧插入的话多数读屏不会播报 —— 那就等于没有 aria-live。
  return createPortal(
    <div
      role={isAssertive ? 'alert' : 'status'}
      aria-live={isAssertive ? 'assertive' : 'polite'}
      aria-atomic="true"
      className={`pointer-events-none fixed bottom-4 left-1/2 z-[110] -translate-x-1/2 ${isVisible ? animation : ''}`}
      style={{ marginBottom: stackOffset }}
    >
      <style>{PROGRESS_KEYFRAMES}</style>

      {isVisible && (
        <div
          ref={cardRef}
          className={`pointer-events-auto relative min-w-0 max-w-[calc(100vw-2rem)] overflow-hidden theme-radius-card border shadow-[0_20px_60px_rgba(15,23,42,0.18)] backdrop-blur ${typeStyles.shell}`}
          // ── 悬停/聚焦 ⇒ 倒计时暂停 ──────────────────────────────────
          // 为什么：这条提示上可能挂着**不可逆操作的退路**（撤销）。
          // 「用户伸手去够那个按钮」要花时间，而提示在用户伸手的过程中
          // 消失 ⇒ 退路等于不存在。
          // 移开/失焦 ⇒ 从**暂停处**继续（不是重新计时）。
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
          onFocus={onFocusIn}
          onBlur={onFocusOut}
        >
          <div
            className={`h-1 w-full ${typeStyles.accent}`}
            style={{
              transformOrigin: 'left',
              animation: effectiveDuration > 0 && isVisible
                ? `tapstack-toast-progress ${effectiveDuration}ms linear forwards`
                : 'none',
              // 暂停时进度条**必须跟着停** —— 进度条还在缩而实际没在计时，
              // 那是界面在说谎（而且用户会以为「快没了」而放弃那条退路）。
              // `paused` 是接着停（不是跳回起点）；恢复时 `running` 接着走。
              animationPlayState: progressRunning ? 'running' : 'paused',
              opacity: effectiveDuration > 0 ? 1 : 0,
            }}
          />
          <div className="flex items-start gap-3 px-4 py-4">
            <div className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${typeStyles.iconWrap}`}>
              {getIcon()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold tracking-[0.18em] theme-text-muted">
                {TYPE_LABEL[type]}
              </div>
              <p className="mt-1 text-sm font-medium leading-6 text-current">{message}</p>
              {action && (
                <button
                  type="button"
                  ref={actionRef}
                  onClick={() => {
                    // 动作先执行、再退场：动作里可能是异步的（撤销要落盘），
                    // 但**退场不等待它** —— 界面不该被一次网络往返卡住。
                    // 动作失败由动作自己的调用方负责出声（组件不吞异常、
                    // 也不假装成功）。
                    action.onAction();
                    dismiss();
                  }}
                  className="mt-2 inline-flex min-h-9 min-w-9 items-center justify-center rounded-lg border border-current/20 bg-white/60 px-3 text-sm font-semibold text-current transition-colors hover:bg-white/90 dark:bg-white/10 dark:hover:bg-white/20"
                >
                  {action.label}
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={dismiss}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full theme-text-muted transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              aria-label="关闭提示"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
};

export default Toast;
