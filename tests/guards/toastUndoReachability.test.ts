// 「撤销」按钮必须**够得着**（2026-10-22 审计 P0-5）。
//
// ── 这个守卫在防什么 ──────────────────────────────────────────────────────
//
// P0-4 给「恢复即消费」配了撤销按钮。做出来了，但**用户够不着**：
//
//   1. toast 3 秒后自动消失（普通提示的时长）；
//   2. hover **不**暂停计时 ⇒ 鼠标想去够它的时候，倒计时不等人；
//   3. toast 挂在 body 末尾 ⇒ 它的按钮排在 Tab 序列的**最后**。
//
// 三个事实叠在一起 ⇒ 那条退路只对「已经知道它在哪、并且手速够快的人」存在。
// 这与上一轮「排序没接线」是同一类错误：**控件存在 ≠ 控件可用**。
//
// ── 为什么钉「行为」不钉「字面量」──────────────────────────────────────
//
// 钉 `onMouseEnter=` 这个字符串毫无意义：把实现从 onMouseEnter 换成
// onPointerEnter 守卫照样绿，但行为可能已经变了。
// 所以本守卫钉的是**可观测的不变式**：
//   · 悬停/聚焦时倒计时**不推进**（假时钟推进 10 秒，剩余时间不变）；
//   · 恢复时**从暂停处续走**（不是从头、也不是再给一整段）；
//   · 暂停有上限（鼠标停着不动，提示最终仍会收起）；
//   · 带动作的提示活得比普通成功提示久（但普通成功提示仍是 3 秒）；
//   · 焦点接管有条件（打字中 / 对话框开着 / 鼠标用户 ⇒ 不抢）。
//
// 接线层（Toast.tsx 把这些函数接到 DOM 事件上）用**结构断言**钉，
// 但钉的是「有没有把 pause 接到 hover 上」这种**关系**，不是某个类名。
//
// ── 变异自证（每条守卫都做过）──────────────────────────────────────────
//
// ① 把 `syncPauseState` 里的 `countdownRef.current?.pause()` 删掉
//    ⇒ 「悬停时不推进」变红。
// ② 把 `resumeCountdown` 的 `deadlineAt: now + state.remainingMs`
//    改成 `now + state.durationMs`（从头开始）
//    ⇒ 「从暂停处续走」变红。
// ③ 把 `scheduleCap` 里的 `fire()` 改成不 fire
//    ⇒ 「暂停有上限」变红。
// ④ 把 `resolveToastDuration` 里的 `hasAction` 分支删掉
//    ⇒ 「带动作的活得更久」变红。
// ⑤ 把 `decideFocusClaim` 里的 `userIsTyping` 判据删掉
//    ⇒ 「打字时不抢焦点」变红。
// ⑥ 把 `shouldPauseCountdown` 里的 `!inputs.pageSeen` 那一支删掉
//    ⇒ 「用户看不见时暂停」变红。
// ⑦ 把 `shouldPauseCountdown` 的 `||` 改成 `&&`
//    ⇒ 「三个触发条件是或关系」变红。
// ⑧ 把 Toast.tsx 里的 `window.addEventListener('blur', update)` 删掉
//    ⇒ 「接线：真的在监听可见性/焦点」变红。
// ⑨ 把 `TOAST_ACTION_DURATION_MS` 改成 3000
//    ⇒ 「撤销窗口不许被改回 3 秒」变红。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '../_alias-loader.mjs')
).href;

before(async () => {
  register(LOADER_PATH);
});

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** 去注释后的源码：注释里提到一个符号不等于生产在用它。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ─────────────────────────────────────────────────────────────────────────
// 假时钟：让「暂停 10 秒之后还剩多少」不用真等
// ─────────────────────────────────────────────────────────────────────────

interface FakeTimer {
  fn: () => void;
  at: number;
  id: number;
}

/**
 * 可注入的假时钟。
 *
 * 形状照 `src/background/syncBackoff.ts`（本仓「纯函数 + 注入时钟」模板）：
 * 只有一个 `now()` 与一对 setTimeout/clearTimeout，测试可以整套换掉。
 */
function createFakeClock(start = 1_000_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, FakeTimer>();

  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number): number => {
      const id = nextId++;
      timers.set(id, { fn, at: now + Math.max(0, ms), id });
      return id;
    },
    clearTimeout: (id: number): void => {
      timers.delete(id);
    },
    /** 把时间往前推 ms，并**按到期顺序**触发定时器。 */
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        const due = [...timers.values()]
          .filter(t => t.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due.id);
        now = due.at;
        due.fn();
      }
      now = target;
    },
    /** 还有几个定时器在跑（用来判「有没有多挂一个上限计时器」）。 */
    pending: () => timers.size,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 一、时长策略：带动作 ⇒ 给一个能做决定的窗口；普通成功提示仍是 3 秒
// ─────────────────────────────────────────────────────────────────────────

describe('时长由「有没有动作」决定', () => {
  it('带动作的提示活得比普通成功提示久（3 秒不够读完「卡片不见了」）', async () => {
    const { resolveToastDuration, TOAST_DEFAULT_DURATION_MS } = await import(
      '@/components/common/toastPolicy'
    );
    const plain = resolveToastDuration('success', TOAST_DEFAULT_DURATION_MS, false);
    const withAction = resolveToastDuration('success', TOAST_DEFAULT_DURATION_MS, true);
    assert.ok(
      withAction > plain,
      `带动作的提示（${withAction}ms）必须比普通提示（${plain}ms）活得久 —— ` +
        '「撤销」的退路只在它还在的时候存在',
    );
    // 下限：8–10 秒量级（Chrome 自己的「重新打开已关闭的标签」是这个数量级）。
    assert.ok(
      withAction >= 8000,
      `带动作的提示至少要给 8 秒（实测 ${withAction}ms）—— 3 秒连读完提示都不够`,
    );
    assert.ok(
      withAction <= 15000,
      `带动作的提示不该超过 15 秒（实测 ${withAction}ms）—— 那是常驻噪音`,
    );
  });

  it('普通成功提示**不受影响**（仍是 3 秒 —— 把那些也拖长只是让屏幕更吵）', async () => {
    const { resolveToastDuration, TOAST_DEFAULT_DURATION_MS } = await import(
      '@/components/common/toastPolicy'
    );
    assert.equal(
      resolveToastDuration('success', TOAST_DEFAULT_DURATION_MS, false),
      TOAST_DEFAULT_DURATION_MS,
      '不带动作的成功提示必须还是 3 秒',
    );
    assert.equal(
      resolveToastDuration('info', TOAST_DEFAULT_DURATION_MS, false),
      TOAST_DEFAULT_DURATION_MS,
      '不带动作的普通提示必须还是 3 秒',
    );
  });

  it('调用方**明确**要求常驻（duration <= 0）时尊重它，不改写', async () => {
    const { resolveToastDuration } = await import('@/components/common/toastPolicy');
    assert.equal(resolveToastDuration('error', 0, false), 0);
    assert.equal(resolveToastDuration('success', 0, false), 0);
  });

  it('错误 + 无动作 + 默认时长 ⇒ 常驻（错误不该一闪而过）', async () => {
    const { resolveToastDuration, TOAST_DEFAULT_DURATION_MS } = await import(
      '@/components/common/toastPolicy'
    );
    assert.equal(resolveToastDuration('error', TOAST_DEFAULT_DURATION_MS, false), 0);
  });

  it('错误 + **有动作** ⇒ 不常驻（撤销窗口必须是**有界**的）', async () => {
    const { resolveToastDuration, TOAST_DEFAULT_DURATION_MS } = await import(
      '@/components/common/toastPolicy'
    );
    const d = resolveToastDuration('error', TOAST_DEFAULT_DURATION_MS, true);
    assert.ok(d > 0, '带动作的错误提示不能常驻 —— 那会让「撤销窗口」变成无限期');
  });

  it('**撤销窗口不许被改回 3 秒**（主审 2026-10-22 明确要求钉住这条）', async () => {
    const {
      TOAST_ACTION_DURATION_MS,
      TOAST_DEFAULT_DURATION_MS,
      resolveToastDuration,
    } = await import('@/components/common/toastPolicy');
    // 钉的是**性质**（「这个窗口至少 8 秒」），不是某个具体数字 ——
    // 将来有人想把它调到 10 秒或 12 秒是合理的，掉回 3 秒不是。
    assert.ok(
      TOAST_ACTION_DURATION_MS >= 8000,
      `撤销窗口至少 8 秒（实测 ${TOAST_ACTION_DURATION_MS}ms）—— ` +
        '3 秒连读完「卡片不见了」都不够，退路等于没有',
    );
    assert.ok(
      resolveToastDuration('success', TOAST_DEFAULT_DURATION_MS, true) >= 8000,
      '带动作的提示实际拿到的时长也必须 ≥ 8 秒',
    );
    // 但普通成功提示**不受影响**（把那些也拖长只是让屏幕更吵）。
    assert.equal(
      resolveToastDuration('success', TOAST_DEFAULT_DURATION_MS, false),
      TOAST_DEFAULT_DURATION_MS,
      '普通成功提示必须还是 3 秒',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 二、倒计时：暂停不推进 / 恢复从暂停处续走 / 暂停有上限
// ─────────────────────────────────────────────────────────────────────────

describe('倒计时：悬停与聚焦时暂停（这是「够得着」的地基）', () => {
  it('暂停后时间**不推进**（推 10 秒，剩余时间不变）', async () => {
    const { createToastCountdown } = await import('@/components/common/toastPolicy');
    const clock = createFakeClock();
    let expired = 0;
    const cd = createToastCountdown({
      durationMs: 10_000,
      clock,
      onExpire: () => { expired += 1; },
    });

    clock.advance(3_000);
    const atPause = cd.remainingMs();
    assert.ok(atPause > 0 && atPause <= 10_000);

    cd.pause();
    clock.advance(10_000);
    assert.equal(cd.remainingMs(), atPause, '暂停期间剩余时间必须**冻结**');
    assert.equal(expired, 0, '暂停期间不许到期 —— 「用户伸手去够按钮」的工夫里提示消失 = 退路没了');
  });

  it('恢复后**从暂停处续走**（不是从头，也不是再给一整段）', async () => {
    const { createToastCountdown, TOAST_MAX_PAUSED_MS } = await import(
      '@/components/common/toastPolicy'
    );
    const clock = createFakeClock();
    let expired = 0;
    const cd = createToastCountdown({
      durationMs: 10_000,
      clock,
      onExpire: () => { expired += 1; },
    });

    clock.advance(3_000);
    cd.pause();
    // 暂停一小会儿（**不能**超过上限：超过就该强制收起了，那是另一条守卫）。
    clock.advance(5_000);
    cd.resume();
    const afterResume = cd.remainingMs();
    // 从暂停处续 ⇒ 剩下约 7 秒（10 - 3），不是 10 秒（从头）也不是 3 秒。
    assert.ok(
      afterResume > 6_500 && afterResume <= 7_000,
      `恢复后应剩约 7000ms（实测 ${afterResume}ms）—— 少了就是「从头开始」，多了就是「重新给一整段」`,
    );

    clock.advance(6_900);
    assert.equal(expired, 0, '还没到点就不该到期');
    clock.advance(200);
    assert.equal(expired, 1, '续走之后应当正常到期');
    assert.ok(TOAST_MAX_PAUSED_MS > 0, '暂停上限必须是个正数');
  });

  it('暂停**有上限**：鼠标停着不动 ⇒ 提示最终仍会收起（不许永远赖着）', async () => {
    const { createToastCountdown, TOAST_MAX_PAUSED_MS } = await import(
      '@/components/common/toastPolicy'
    );
    const clock = createFakeClock();
    let expired = 0;
    const cd = createToastCountdown({
      durationMs: 10_000,
      clock,
      onExpire: () => { expired += 1; },
    });

    cd.pause();
    // 只推进到上限之前：还没到。
    clock.advance(TOAST_MAX_PAUSED_MS - 1_000);
    assert.equal(expired, 0, '还没到上限不该收起');
    // 推进过上限：强制收起。
    clock.advance(2_000);
    assert.equal(expired, 1, '暂停超过上限后必须强制收起 —— 否则提示变成关不掉的东西');
  });

  it('暂停期间**不重置**计时（暂停 ≠ 续一命）', async () => {
    const { createToastCountdown } = await import('@/components/common/toastPolicy');
    const clock = createFakeClock();
    let expired = 0;
    const cd = createToastCountdown({
      durationMs: 5_000,
      clock,
      onExpire: () => { expired += 1; },
    });
    clock.advance(1_000);
    cd.pause();
    clock.advance(1_000);
    cd.resume();
    clock.advance(3_900);
    assert.equal(expired, 0, '总共只过了 1+3.9=4.9 秒（暂停的那 1 秒不算）');
    clock.advance(200);
    assert.equal(expired, 1);
  });

  it('每条提示各自持有自己的倒计时 ⇒ **堆叠时互不影响**', async () => {
    const { createToastCountdown } = await import('@/components/common/toastPolicy');
    const clock = createFakeClock();
    let a = 0;
    let b = 0;
    const cdA = createToastCountdown({
      durationMs: 10_000, clock, onExpire: () => { a += 1; },
    });
    const cdB = createToastCountdown({
      durationMs: 10_000, clock, onExpire: () => { b += 1; },
    });
    assert.ok(cdB, '下面那条提示也要有自己的控制器');
    // 只暂停上面那条（用户在看它）。
    cdA.pause();
    clock.advance(10_000);
    assert.equal(a, 0, '被暂停的那条不该到期');
    assert.equal(b, 1, '下面那条该照常到期 —— 悬停最上面那条不该让下面那些也停下来');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 三、焦点接管：只在安全的时候抢
// ─────────────────────────────────────────────────────────────────────────

describe('焦点接管有条件', () => {
  const base = {
    hasAction: true,
    autoFocusRequested: true,
    inputModality: 'keyboard' as const,
    userIsTyping: false,
    dialogOpen: false,
    pageSeen: true,
  };

  it('键盘用户 + 安全环境 ⇒ 抢（这条退路变成一次回车）', async () => {
    const { decideFocusClaim } = await import('@/components/common/toastPolicy');
    assert.equal(decideFocusClaim(base), true);
  });

  it('**正在打字** ⇒ 不抢（抢了 ⇒ 他打的字没了）', async () => {
    const { decideFocusClaim } = await import('@/components/common/toastPolicy');
    assert.equal(decideFocusClaim({ ...base, userIsTyping: true }), false);
  });

  it('**对话框开着** ⇒ 不抢（抢了 ⇒ 焦点跑出对话框，焦点陷阱失效）', async () => {
    const { decideFocusClaim } = await import('@/components/common/toastPolicy');
    assert.equal(decideFocusClaim({ ...base, dialogOpen: true }), false);
  });

  it('**鼠标用户** ⇒ 不抢（他下一次按空格会误触撤销）', async () => {
    const { decideFocusClaim } = await import('@/components/common/toastPolicy');
    assert.equal(decideFocusClaim({ ...base, inputModality: 'pointer' }), false);
  });

  it('**页面用户看不见** ⇒ 不抢（抢了也是抢给空气，焦点还把倒计时按着）', async () => {
    const { decideFocusClaim } = await import('@/components/common/toastPolicy');
    assert.equal(decideFocusClaim({ ...base, pageSeen: false }), false);
  });

  it('动作没要求接管 ⇒ 不抢（抢焦点是很重的手法）', async () => {
    const { decideFocusClaim } = await import('@/components/common/toastPolicy');
    assert.equal(decideFocusClaim({ ...base, autoFocusRequested: false }), false);
    assert.equal(decideFocusClaim({ ...base, hasAction: false }), false);
  });

  it('「正在输入的地方」的判据只看**形状**（不看是哪个输入框）', async () => {
    const { isTextEntryElement } = await import('@/components/common/toastPolicy');
    for (const tag of ['input', 'textarea', 'select']) {
      assert.equal(
        isTextEntryElement({ tagName: tag.toUpperCase() }),
        true,
        `${tag} 是在输入的地方`,
      );
    }
    assert.equal(isTextEntryElement({ tagName: 'DIV' }), false);
    assert.equal(isTextEntryElement({ tagName: 'DIV', isContentEditable: true }), true);
    assert.equal(isTextEntryElement(null), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 四、接线层：这些纯函数真的被接到了 DOM 事件上
// ─────────────────────────────────────────────────────────────────────────

describe('接线：暂停/恢复/抢焦点真的接在 Toast 上', () => {
  const TOAST = read('src/components/common/Toast.tsx');
  const TOAST_CODE = stripComments(TOAST);

  it('悬停与聚焦**都**接到暂停上（只接一边 ⇒ 另一半的用户还是够不着）', () => {
    // 钉的是「关系」：hover 事件与 focus 事件最终都通向 countdown.pause()。
    assert.match(
      TOAST_CODE,
      /onMouseEnter=\{[^}]*\}/,
      'Toast 必须接 onMouseEnter（悬停要能暂停）',
    );
    assert.match(
      TOAST_CODE,
      /onMouseLeave=\{[^}]*\}/,
      'Toast 必须接 onMouseLeave（移开要能续走）',
    );
    assert.match(
      TOAST_CODE,
      /onFocus=\{[^}]*\}/,
      'Toast 必须接 onFocus（键盘用户走到按钮上时也要暂停）',
    );
    assert.match(
      TOAST_CODE,
      /onBlur=\{[^}]*\}/,
      'Toast 必须接 onBlur',
    );
    // 暂停必须真的调到底层控制器的 pause —— 不是只改一个 state。
    assert.match(
      TOAST_CODE,
      /countdownRef\.current\?\.pause\(\)/,
      '悬停/聚焦必须真的暂停倒计时（不是只改进度条的样式）',
    );
    assert.match(
      TOAST_CODE,
      /countdownRef\.current\?\.resume\(\)/,
      '移开/失焦必须真的续走倒计时',
    );
  });

  it('鼠标与焦点的暂停是**两个独立的事实**（只看一个会让另一半的用户够不着）', async () => {
    const { shouldPauseCountdown } = await import('@/components/common/toastPolicy');
    const base = { hovered: false, focused: false, pageSeen: true, hasDecision: true };
    // 只看鼠标 ⇒ 键盘用户读按钮时提示照样消失。
    assert.equal(shouldPauseCountdown({ ...base, hovered: true }), true);
    assert.equal(shouldPauseCountdown({ ...base, focused: true }), true);
    // 两个都不成立 ⇒ 不停。
    assert.equal(shouldPauseCountdown(base), false);
    // 接线：Toast 必须把这两个事实**分别**传进去（合成一个布尔量就丢了信息）。
    const code = stripComments(read('src/components/common/Toast.tsx'));
    assert.match(
      code,
      /hovered:\s*hoveredRef\.current/,
      'Toast 必须把「鼠标在不在」单独传给暂停判据',
    );
    assert.match(
      code,
      /focused:\s*focusedRef\.current/,
      'Toast 必须把「焦点在不在」单独传给暂停判据',
    );
  });

  it('进度条**跟着停**（进度条还在缩而实际没在计时 = 界面在说谎）', () => {
    assert.match(
      TOAST_CODE,
      /animationPlayState:\s*progressRunning\s*\?\s*'running'\s*:\s*'paused'/,
      '进度条必须用 animation-play-state 跟着暂停/续走',
    );
  });

  it('抢焦点用**条件判据**（decideFocusClaim），不是无条件 focus()', () => {
    assert.match(
      TOAST_CODE,
      /decideFocusClaim\(/,
      '焦点接管必须走 decideFocusClaim（有条件判据）',
    );
    assert.match(
      TOAST_CODE,
      /actionRef\.current\?\.focus\(\)/,
      '判据通过后必须真的把焦点交到动作按钮上',
    );
  });

  it('抢了焦点就要**还回去**（否则提示一消失，焦点掉到 body）', () => {
    assert.match(
      TOAST_CODE,
      /restoreFocusIfInside/,
      '必须有还焦逻辑',
    );
    assert.match(
      TOAST_CODE,
      /target\.isConnected/,
      '还焦前要确认目标还在文档里（用户点的那个按钮可能已随列表重排被卸载）',
    );
  });
});

describe('接线：撤销这条退路真的被要求接管焦点', () => {
  it('useConsumeUndo 的撤销动作必须 autoFocus（否则键盘用户零次按键到不了）', () => {
    const src = read('src/components/tabs/useConsumeUndo.ts');
    const actionBlock = src.match(/notify\(message,\s*\{[\s\S]*?\n {6}\}\);/);
    assert.ok(actionBlock, '应能找到撤销动作的定义');
    assert.match(
      actionBlock[0],
      /autoFocus:\s*true/,
      '撤销动作必须要求接管焦点 —— 实测 Tab 序列里「撤销」排在最后，' +
        '键盘用户要按十几次 Tab，而提示 3 秒后就没了',
    );
  });

  it('动作按钮的 autoFocus 默认为 false（抢焦点是很重的手法）', () => {
    const src = read('src/components/common/Toast.tsx');
    assert.match(
      src,
      /autoFocus\?:\s*boolean/,
      'autoFocus 必须是可选的',
    );
    // 判据里「没要求就不抢」由 decideFocusClaim 保证（已在上文钉过）。
  });
});

describe('接线：时长口径只有一处（不写死第二个数）', () => {
  it('toastHelper 的时长必须走 resolveToastDuration，不许自己写一个数', () => {
    const src = stripComments(read('src/utils/toastHelper.ts'));
    assert.match(
      src,
      /resolveToastDuration\(/,
      'toastHelper 必须用共享的时长策略 —— 两处各写一个数，迟早漂',
    );
    // 「带动作 ⇒ 写死一个毫秒数」这个形状不许再出现。
    const hardCoded = src.match(/action\s*\?[^;\n]*\d{3,}\s*:/);
    assert.equal(
      hardCoded,
      null,
      'toastHelper 里不许再出现「带动作 ⇒ 写死 N 毫秒」的分支',
    );
  });

  it('仓里不再有第二个「带撤销的提示活多久」的出处', () => {
    const copy = stripComments(read('src/components/tabs/consumeUndoCopy.ts'));
    assert.doesNotMatch(
      copy,
      /=\s*\d{4,}\s*;?\s*$/m,
      'consumeUndoCopy 里不再定义毫秒数 —— 时长只有一个出处（toastPolicy）',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 五、用户看不见这个页面时：倒计时暂停（2026-10-22 主审追加）
// ─────────────────────────────────────────────────────────────────────────
//
// ── 这个守卫在防什么 ──────────────────────────────────────────────────────
//
// 「恢复整个会话」会把管理页**从用户眼前拿走**（新标签 active:true ⇒
// 管理页退为后台标签；新窗口 focused:true ⇒ 管理页所在窗口变成后台窗口）。
// 提示的 DOM 还在、倒计时还在走 ⇒ 用户切回来时退路已经过期 ⇒
// 那次消费事实上**不可逆**，而用户从头到尾不知道有过退路。
//
// ⚠️ 暂停的是**计时**，不是**生命周期**：重新可见时从暂停处**继续**
//（不是从头），且暂停有上限 ⇒ 一个永远没人看的后台标签页不会永久挂着一个提示。
//
// ── 一条实测出来的坑（别再踩）────────────────────────────────────────────
//
// 主审给的判据是 `document.visibilityState === 'hidden'`。
// **实测（2026-10-22，真机 + 真扩展，11 组探针）它在项目里的真实场景下
// 恒为 'visible'**：后台标签、后台窗口、窗口最小化 —— 全都不触发
// `visibilitychange`。只按它判 ⇒ 这条暂停**永远不生效**。
// ⇒ 判据必须用实测能翻转的那一位：`document.hasFocus()` / `focus`|`blur` 事件。

describe('页面用户看不见时：倒计时暂停', () => {
  it('用户看不见 + 有决定要做 ⇒ 暂停（退路不能在用户看不见的时候过期）', async () => {
    const { shouldPauseCountdown } = await import('@/components/common/toastPolicy');
    assert.equal(
      shouldPauseCountdown({
        hovered: false,
        focused: false,
        pageSeen: false,
        hasDecision: true,
      }),
      true,
      '用户看不见时，挂着「撤销」的提示必须停 —— 否则退路在他看不见的时候就没了',
    );
  });

  it('用户看不见 + **没有**决定要做 ⇒ 不暂停（不必为一个没人要做的决定等人）', async () => {
    const { shouldPauseCountdown } = await import('@/components/common/toastPolicy');
    assert.equal(
      shouldPauseCountdown({
        hovered: false,
        focused: false,
        pageSeen: false,
        hasDecision: false,
      }),
      false,
      '「已保存」这种提示不必等用户回来 —— 它过期了也没人损失什么，' +
        '而一条永远赖在屏幕底下的旧提示是在给用户添乱',
    );
  });

  it('页面可见时，三个触发条件都不成立 ⇒ 不暂停', async () => {
    const { shouldPauseCountdown } = await import('@/components/common/toastPolicy');
    assert.equal(
      shouldPauseCountdown({
        hovered: false,
        focused: false,
        pageSeen: true,
        hasDecision: true,
      }),
      false,
    );
  });

  it('三个触发条件是**或**关系（改成「与」就把「伸手去够按钮」这条路改坏了）', async () => {
    const { shouldPauseCountdown } = await import('@/components/common/toastPolicy');
    const base = { hovered: false, focused: false, pageSeen: true, hasDecision: true };
    // 每个条件单独成立都要能暂停。
    assert.equal(shouldPauseCountdown({ ...base, hovered: true }), true);
    assert.equal(shouldPauseCountdown({ ...base, focused: true }), true);
    assert.equal(shouldPauseCountdown({ ...base, pageSeen: false }), true);
  });

  it('「用户看不看得见」的读数：hidden / 没有焦点 ⇒ 看不见；其余 ⇒ 看得见', async () => {
    const { detectPageAttention } = await import('@/components/common/toastPolicy');
    const original = (globalThis as { document?: unknown }).document;
    const stub = (visibilityState: string, hasFocus: boolean) => {
      (globalThis as { document?: unknown }).document = {
        visibilityState,
        hasFocus: () => hasFocus,
      };
    };
    try {
      stub('hidden', true);
      assert.equal(detectPageAttention(), 'blurred', 'visibilityState=hidden ⇒ 看不见');
      stub('visible', false);
      assert.equal(
        detectPageAttention(),
        'blurred',
        'hasFocus()=false ⇒ 看不见（**实测**后台标签/后台窗口就是这一位在翻转）',
      );
      stub('visible', true);
      assert.equal(detectPageAttention(), 'visible', '页面可见且有焦点 ⇒ 看得见');
    } finally {
      (globalThis as { document?: unknown }).document = original;
    }
  });

  it('看不见的那段时间**不计入**倒计时；重新看得见时**从暂停处续走**', async () => {
    const { createToastCountdown } = await import('@/components/common/toastPolicy');
    const clock = createFakeClock();
    let expired = 0;
    const cd = createToastCountdown({
      durationMs: 10_000,
      clock,
      onExpire: () => { expired += 1; },
    });

    clock.advance(2_000);
    const atPause = cd.remainingMs();
    // 「页面看不见」⇒ 暂停。
    cd.pause();
    clock.advance(20_000);
    assert.equal(expired, 0, '用户看不见的 20 秒里不许到期 —— 退路还在');
    assert.equal(cd.remainingMs(), atPause, '看不见期间剩余时间必须冻结');
    // 「页面重新看得见」⇒ 从暂停处继续（不是从头）。
    cd.resume();
    const afterResume = cd.remainingMs();
    assert.ok(
      afterResume > 7_500 && afterResume <= 8_000,
      `重新可见后应剩约 8000ms（实测 ${afterResume}ms）—— 从头开始就等于给了一条新的 8 秒`,
    );
    clock.advance(7_900);
    assert.equal(expired, 0);
    clock.advance(200);
    assert.equal(expired, 1, '可见时间用完后应当正常到期');
  });

  it('暂停仍然**有上限**（一个永远没人看的后台标签页不会永久挂着一个提示）', async () => {
    const { createToastCountdown, TOAST_MAX_PAUSED_MS } = await import(
      '@/components/common/toastPolicy'
    );
    const clock = createFakeClock();
    let expired = 0;
    const cd = createToastCountdown({
      durationMs: 10_000,
      clock,
      onExpire: () => { expired += 1; },
    });
    cd.pause();
    clock.advance(TOAST_MAX_PAUSED_MS + 1_000);
    assert.equal(
      expired,
      1,
      '看不见的时间超过上限后必须强制收起 —— 否则「暂停」变成「永不消失」',
    );
  });

  it('接线：Toast 真的在监听「可见性 / 焦点」的变化', () => {
    const code = stripComments(read('src/components/common/Toast.tsx'));
    assert.match(
      code,
      /addEventListener\(\s*'visibilitychange'/,
      '必须监听 visibilitychange（主审指定的判据）',
    );
    assert.match(
      code,
      /addEventListener\(\s*'focus'/,
      "必须监听 window 的 focus（**实测**它才会在切回标签时触发）",
    );
    assert.match(
      code,
      /addEventListener\(\s*'blur'/,
      "必须监听 window 的 blur（**实测**它才会在切走标签时触发）",
    );
    assert.match(
      code,
      /detectPageAttention\(\)/,
      '必须用 detectPageAttention 读「用户看不看得见」（判据只有一处）',
    );
    assert.match(
      code,
      /shouldPauseCountdown\(/,
      '暂停判据必须走 shouldPauseCountdown（纯函数、可单测）',
    );
    // 监听到了还不够：变化必须真的**接到暂停上**。
    assert.match(
      code,
      /pageSeenRef\.current\s*=\s*seen/,
      '可见性变化必须写回状态，再触发暂停同步',
    );
  });

  it('接线：抢焦点也必须看「页面看不看得见」（抢给空气会把倒计时按着）', () => {
    const code = stripComments(read('src/components/common/Toast.tsx'));
    const claim = code.match(/decideFocusClaim\(\{[\s\S]*?\}\)/);
    assert.ok(claim, '应能找到 decideFocusClaim 的调用');
    assert.match(
      claim[0],
      /pageSeen:\s*detectPageAttention\(\)/,
      '焦点接管的判据里必须有 pageSeen —— 页面看不见时抢焦点没有意义',
    );
  });
});

