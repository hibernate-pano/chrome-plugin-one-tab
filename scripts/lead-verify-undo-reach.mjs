// 真机验证：「撤销」够得着（2026-10-22 审计 P0-5）。
//
// ── 为什么要真机 ────────────────────────────────────────────────────────
//
// 这个缺陷的整个性质就是「**代码看起来对，但用户够不着**」：
//   · 计时逻辑在组件里，真机上要靠「等」才能看出来；
//   · 焦点顺序是浏览器的行为，tsc / eslint / jsdom 全都看不见；
//   · CSS 的 animation-play-state 是否真的冻住进度条，也只能在真浏览器里量。
//
// 所以下面四条判据全部在**真 Chrome + 真扩展**里跑：
//   ① 恢复之后 >3 秒，提示还在（旧的 3 秒口径已经不够用户做决定）；
//   ② 悬停时倒计时**不推进**（进度条与剩余时间都不动）；
//   ③ 键盘 Tab 能到达「撤销」按钮 —— 报出**实际步数**；
//   ④ 鼠标移开之后，提示**正常**消失（暂停不是「永远不消失」）。
//
// 2026-10-22 主审追加一条（⑧）：**用户看不见这个页面时**倒计时也得暂停 ——
// 「恢复整组」会把管理页推到后台，用户看不见它 ⇒ 退路不能在他看不见的时候过期。
//
// 产出：outputs/lead-verify-undo-reach/*.png + 一份 JSON 报告。

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/lead-verify-undo-reach');
const now = Date.now();
const iso = ms => new Date(ms).toISOString();

function tab(groupId, url, title) {
  return {
    id: crypto.randomUUID(),
    url,
    title,
    favicon: '',
    createdAt: iso(now - 3600e3),
    lastAccessed: iso(now - 3600e3),
    group_id: groupId,
    pinned: false,
  };
}

function group(name, tabs) {
  const id = crypto.randomUUID();
  return {
    id,
    name,
    notes: '',
    isFavorite: false,
    isLocked: false,
    isDeleted: false,
    tabs: tabs.map(([url, title]) => tab(id, url, title)),
    createdAt: iso(now - 7200e3),
    updatedAt: iso(now - 3600e3),
    version: 1,
    displayOrder: 1,
    lastOp: { d: 'verify-device', s: 1 },
  };
}

const groups = [
  group('可达性验证会话', [
    ['https://example.com/alpha', 'Alpha 页面'],
    ['https://example.com/beta', 'Beta 页面'],
    ['https://example.com/gamma', 'Gamma 页面'],
    ['https://example.com/delta', 'Delta 页面'],
  ]),
];

async function injectGroups(page, data) {
  await page.evaluate(async rows => {
    await new Promise((res, rej) => {
      const req = indexedDB.open('tabvaultpro', 1);
      req.onerror = () => rej(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ key: 'tab_groups', value: rows });
        tx.oncomplete = () => { db.close(); res(); };
        tx.onerror = () => { db.close(); rej(req.error); };
      };
    });
  }, data);
}

/** 提示是否还在（以及它现在的文字）。 */
async function toastState(page) {
  return page.evaluate(() => {
    const live = document.querySelector('[role="alert"], [role="status"]');
    const inner = live ? live.querySelector('div.pointer-events-auto') : null;
    const btn = inner
      ? [...inner.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '撤销')
      : null;
    const progress = inner ? inner.querySelector('div[style*="tapstack-toast-progress"]') : null;
    return {
      present: Boolean(inner),
      hasUndo: Boolean(btn),
      // 进度条的当前缩放：用来量「它有没有在走」。
      progressScale: progress ? getComputedStyle(progress).transform : null,
      animationPlayState: progress ? getComputedStyle(progress).animationPlayState : null,
      text: inner ? (inner.innerText || '').replace(/\s+/g, ' ').slice(0, 120) : '',
    };
  });
}

/** 当前焦点落在哪（用来量 Tab 步数）。 */
async function focusedLabel(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return 'body';
    const label = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30);
    return `${el.tagName.toLowerCase()}:${label}`;
  });
}

/** 距离「撤销」按钮还有几次 Tab（最多 max 步）。返回 {steps, order}。 */
async function tabStepsToUndo(page, max = 30) {
  const order = [];
  for (let i = 1; i <= max; i++) {
    await page.keyboard.press('Tab');
    const label = await focusedLabel(page);
    order.push(`${i}. ${label}`);
    if (label.includes('撤销')) return { steps: i, order };
  }
  return { steps: -1, order };
}

/**
 * 起一个装了扩展的持久化上下文。
 *
 * ⚠️ 为什么要两条路：Playwright 自带的 Chromium 需要 `npx playwright install`
 * 单独下载；本机没装时会直接抛「Executable doesn't exist」。
 * 而**系统 Chrome**（channel: 'chrome'）是现成的，扩展照样能装
 * （--load-extension 是 Chromium 内核的能力，系统 Chrome 就是 Chromium 内核）。
 * 所以：先试自带的，没有就用系统的 —— 验证脚本不该因为「没下载浏览器」而跑不了。
 */
async function launchWithExtension(profile) {
  const args = [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    '--no-first-run',
    '--lang=zh-CN',
  ];
  const opts = { headless: false, args, viewport: { width: 1440, height: 900 } };
  try {
    return await chromium.launchPersistentContext(profile, opts);
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (!/Executable doesn't exist/i.test(msg)) throw err;
    console.error('[提示] Playwright 自带的 Chromium 没装，改用系统 Chrome。');
    return await chromium.launchPersistentContext(profile, { ...opts, channel: 'chrome' });
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-undo-reach-'));
  const ctx = await launchWithExtension(profile);
  const problems = [];
  const report = { steps: [], stalls: [] };
  /** 环境卡顿记录（见下面 waitReal 的说明）。 */
  const stalls = [];
  /**
   * 会**测量真实耗时**的等待。
   *
   * 为什么需要它：实测里偶发「切回来之后提示没了」，追下去发现是
   * **环境卡顿** —— 页面里的定时器被拖后了 80 多秒（浏览器被挂起 / 机器
   * 睡了）。那不是产品缺陷，但把它算成产品缺陷就是**报告不诚实**。
   * ⇒ 每次等待都量一下真实耗时，超过 3 秒就记一条「卡顿」。
   *
   * 判据因此分两说：卡顿期间测出来的结果**不可信**，要在报告里说明。
   */
  const waitReal = async (page, ms, label) => {
    const t0 = Date.now();
    await page.waitForTimeout(ms);
    const actual = Date.now() - t0;
    if (actual > ms + 3000) {
      stalls.push({ label, asked: ms, actual });
    }
    return actual;
  };
  try {
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await new Promise(r => setTimeout(r, 500));
    }
    if (!sw) throw new Error('扩展的 service worker 没有起来');
    const id = new URL(sw.url()).host;

    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));

    await page.goto(`chrome-extension://${id}/src/popup/index.html`);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
    await injectGroups(page, groups);
    await page.reload();
    await page.waitForSelector('text=可达性验证会话', { timeout: 15000 });
    await page.waitForTimeout(1200);

    // ── 造出「恢复即消费」的那条提示 ─────────────────────────────────
    // 用**键盘**点标签行：这样「输入方式」被记成 keyboard ⇒ 焦点接管会生效
    // （这正是我们要验的路径）。
    const target = page.locator('text=Alpha 页面').first();
    await target.click();
    await page.waitForTimeout(400);

    const undoBtn = page.locator('button', { hasText: '撤销' }).first();
    const appeared = await undoBtn.isVisible().catch(() => false);
    if (!appeared) {
      problems.push('消费之后看不到「撤销」按钮 —— 连按钮都没出现，后面的判据无从谈起');
    }
    await page.screenshot({ path: join(OUT_DIR, '01-consume-toast.png') });
    report.steps.push({ step: '消费后提示已出现', appeared });

    // ── 判据 ①：>3 秒之后提示还在 ──────────────────────────────────
    await page.waitForTimeout(3500);
    const after3500 = await toastState(page);
    if (!after3500.present) {
      problems.push('3.5 秒之后提示已经没了 —— 旧的 3 秒口径对「需要用户做决定」不够');
    }
    report.steps.push({ step: '① 3.5 秒后仍在', state: after3500 });

    // ── 判据 ②：悬停时倒计时**不推进** ─────────────────────────────
    // 量两件事：进度条的 transform（视觉）与 animation-play-state（机制）。
    const box = await undoBtn.boundingBox();
    if (!box) throw new Error('找不到「撤销」按钮的位置');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(300);
    const hoverA = await toastState(page);
    await page.waitForTimeout(2500);
    const hoverB = await toastState(page);
    if (hoverA.progressScale !== hoverB.progressScale) {
      problems.push(
        `悬停时进度条还在走（${hoverA.progressScale} → ${hoverB.progressScale}）—— ` +
          '进度条继续缩而实际没在计时，界面在说谎',
      );
    }
    if (hoverB.animationPlayState !== 'paused') {
      problems.push(`悬停时 animation-play-state 不是 paused（实测 ${hoverB.animationPlayState}）`);
    }
    if (!hoverB.present) {
      problems.push('悬停时提示消失了 —— 「用户伸手去够按钮」的工夫里退路就没了');
    }
    report.steps.push({
      step: '② 悬停 2.5 秒期间进度条不动',
      before: { scale: hoverA.progressScale, playState: hoverA.animationPlayState },
      after: { scale: hoverB.progressScale, playState: hoverB.animationPlayState },
    });
    await page.screenshot({ path: join(OUT_DIR, '02-hover-paused.png') });

    // ── 判据 ③：键盘 Tab 能不能到「撤销」 ──────────────────────────
    // 重新造一条提示（上一条被悬停暂停住了，先让它退场）。
    await page.mouse.move(10, 10);
    await page.waitForTimeout(500);
    await page.evaluate(() => document.body.focus());
    const tabWalk = await tabStepsToUndo(page, 30);
    if (tabWalk.steps < 0) {
      problems.push(`按了 30 次 Tab 都没走到「撤销」—— 退路对键盘用户不可达（序列末尾：${tabWalk.order.slice(-3).join(' | ')}）`);
    }
    report.steps.push({ step: '③ Tab 到「撤销」的步数', steps: tabWalk.steps, order: tabWalk.order });
    await page.screenshot({ path: join(OUT_DIR, '03-tab-focus.png') });

    // ── 判据 ④：鼠标移开 + 焦点移出 ⇒ 提示**正常**消失 ────────────
    //
    // ⚠️ 上一步的 Tab 走查把焦点留在了「撤销」按钮上 ⇒ 倒计时**仍在暂停**
    // （这是对的：焦点还在提示里就说明用户还在读它）。所以 ④ 必须先把
    // 焦点也移出去，才测得到「移开鼠标 ⇒ 恢复计时 ⇒ 到点消失」这条路径。
    await page.evaluate(() => {
      const el = document.activeElement;
      if (el && el !== document.body && typeof el.blur === 'function') el.blur();
      if (document.activeElement === document.body) document.body.focus();
    });
    await page.mouse.move(10, 10);
    // 移开之后，剩余时间（≤10 秒）走完 ⇒ 提示必须消失。
    await page.waitForTimeout(12_000);
    const afterAway = await toastState(page);
    if (afterAway.present) {
      problems.push(
        '鼠标移开且焦点移出 12 秒后提示还在 —— 暂停把提示变成了关不掉的东西',
      );
    }
    report.steps.push({ step: '④ 移开鼠标且焦点移出 12 秒后消失', state: afterAway });
    await page.screenshot({ path: join(OUT_DIR, '04-after-mouse-away.png') });

    // ── 判据 ⑤：焦点一直留在提示里 ⇒ 到上限**强制收起**（逃生阀）──
    //
    // 这条是「不许提示永远赖着」的兜底：用户把鼠标停在提示上不动、
    // 焦点也留在里面 ⇒ 倒计时一直停着 ⇒ 必须由上限计时器强制收起。
    //
    // 用**另一条**标签（Gamma）造新提示 —— 上一条（Alpha）已经被消费掉了。
    await page.locator('text=Gamma 页面').first().click().catch(() => {});
    await page.waitForTimeout(600);
    const undoBtn3 = page.locator('button', { hasText: '撤销' }).first();
    if (!(await undoBtn3.isVisible().catch(() => false))) {
      problems.push('消费第二条之后没有新的提示 —— ⑤ 无法验证');
      report.steps.push({ step: '⑤ 跳过（没有新的提示）' });
    } else {
      const b3 = await undoBtn3.boundingBox();
      if (b3) {
        // 鼠标停上去（⇒ 暂停），并且**不**移开。
        await page.mouse.move(b3.x + b3.width / 2, b3.y + b3.height / 2);
      }
      await page.waitForTimeout(500);
      const parked = await toastState(page);
      if (parked.animationPlayState !== 'paused') {
        problems.push(`鼠标停在提示上时 animation-play-state 不是 paused（${parked.animationPlayState}）`);
      }
      // 上限是 30 秒 ⇒ 停满 34 秒后必须被强制收起。
      await page.waitForTimeout(34_000);
      const afterCap = await toastState(page);
      if (afterCap.present) {
        problems.push(
          '鼠标停在提示上不动 34 秒后提示还在 —— 暂停没有上限，它变成了关不掉的东西',
        );
      }
      report.steps.push({
        step: '⑤ 鼠标停着不动 34 秒后被强制收起',
        parked: { playState: parked.animationPlayState, scale: parked.progressScale },
        afterCap,
      });
    }
    await page.screenshot({ path: join(OUT_DIR, '05-force-collapsed.png') });

    // ── 判据 ⑥：键盘用户 ⇒ 焦点**自动**落在「撤销」上（零次按键可达）──
    //
    // 这是「键盘用户零次按键就能撤销」的那条路径。
    // 判据：**用键盘**触发消费（Tab 到标签行 → 回车），
    // 于是「输入方式」被记成 keyboard ⇒ 焦点接管的条件成立
    // （decideFocusClaim：键盘用户 + 不在输入框 + 没有对话框开着）。
    await page.mouse.move(10, 10);
    await page.waitForTimeout(500);
    await page.evaluate(() => document.body.focus());
    // 用键盘走到「Delta 页面」那一行。
    let deltaFocused = false;
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      const label = await focusedLabel(page);
      if (label.includes('Delta 页面')) { deltaFocused = true; break; }
    }
    if (!deltaFocused) {
      problems.push('用 Tab 走不到「Delta 页面」那一行 —— ⑥ 无法验证');
      report.steps.push({ step: '⑥ 跳过（走不到标签行）' });
    } else {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(700);
      const focusAfter = await focusedLabel(page);
      if (!focusAfter.includes('撤销')) {
        problems.push(
          `键盘触发的消费之后焦点落在「${focusAfter}」而不是「撤销」—— ` +
            '键盘用户仍然要自己 Tab 过去',
        );
      }
      report.steps.push({ step: '⑥ 键盘触发 ⇒ 焦点自动落在「撤销」', focused: focusAfter });
      await page.screenshot({ path: join(OUT_DIR, '06-keyboard-focus-claim.png') });
    }

    // ── 判据 ⑦：鼠标用户 ⇒ **不**抢焦点（否则下一次按空格会误触撤销）──
    //
    // 这是 ⑥ 的**反面**判据：焦点接管是「有条件」的，不是无脑抢。
    // 鼠标点了「恢复」之后，焦点必须留在原处 ——
    //   · 抢了 ⇒ 用户下一次按空格/回车就落在「撤销」上 = 误触；
    //   · 而且焦点停在提示里 ⇒ 倒计时被暂停 ⇒ 提示赖着不走。
    await page.mouse.move(10, 10);
    await page.waitForTimeout(400);
    // 重新注入一条数据（Delta 已被消费掉了）。
    await injectGroups(page, groups);
    await page.reload();
    await page.waitForSelector('text=可达性验证会话', { timeout: 15000 });
    await page.waitForTimeout(1200);
    // 用**鼠标**点「Delta 页面」那一行。
    await page.locator('text=Delta 页面').first().click();
    await page.waitForTimeout(700);
    const focusAfterMouse = await focusedLabel(page);
    if (focusAfterMouse.includes('撤销')) {
      problems.push(
        `鼠标触发的消费之后焦点被抢到「${focusAfterMouse}」—— ` +
          '鼠标用户下一次按空格就会误触撤销',
      );
    }
    report.steps.push({ step: '⑦ 鼠标触发 ⇒ 焦点不被抢', focused: focusAfterMouse });
    await page.screenshot({ path: join(OUT_DIR, '07-mouse-no-steal.png') });

    // ── 判据 ⑧：用户**看不见**这个页面 ⇒ 倒计时暂停 ⇒ 切回来还能撤销 ──
    //
    // 为什么这条判据最难测：**Playwright 默认开着「焦点模拟」**
    // （Emulation.setFocusEmulationEnabled），开着的时候 `document.hasFocus()`
    // 在任何页面都恒为 true ⇒ 「用户看不见」这件事在测试里**根本不会发生**
    // ⇒ 判据⑧必须先把这个模拟关掉，测的才是真实行为。
    //
    // （这同时印证了实测结论：`document.visibilityState` 在后台标签/后台窗口下
    //  恒为 'visible'、`visibilitychange` 一次都不触发；真正翻转的是
    //  `document.hasFocus()` 与 window 的 focus/blur 事件。）
    await page.mouse.move(10, 10);
    await injectGroups(page, groups);
    await page.reload();
    await page.waitForSelector('text=可达性验证会话', { timeout: 15000 });
    await page.waitForTimeout(1200);
    await page.locator('text=Alpha 页面').first().click();
    await page.waitForTimeout(600);
    const undoBtn8 = page.locator('button', { hasText: '撤销' }).first();
    if (!(await undoBtn8.isVisible().catch(() => false))) {
      problems.push('⑧ 无法验证：消费之后没有新的提示');
      report.steps.push({ step: '⑧ 跳过（没有新的提示）' });
    } else {
      // 焦点不能停在提示里 —— 否则测到的是「焦点在提示内」那条暂停判据，
      // 而不是「用户看不见」这一条。
      await page.evaluate(() => {
        const el = document.activeElement;
        if (el && el !== document.body && typeof el.blur === 'function') el.blur();
        if (document.activeElement === document.body) document.body.focus();
      });
      await page.mouse.move(10, 10);
      // 让倒计时先走 1.5 秒（剩下的时间 ≈ 6.5 秒）。
      await waitReal(page, 1500, '⑧ 切走前先走 1.5 秒');
      const before = await toastState(page);

      // 关掉焦点模拟 —— 之后 `document.hasFocus()` 才是真的。
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });

      // 真的把管理页切到后台：另开一个标签并激活它。
      const other = await ctx.newPage();
      await other.goto('about:blank');
      await other.bringToFront();
      await waitReal(page, 600, '⑧ 切走后落定');

      // ⚠️ 先断言**前置条件**成立，否则这条判据是空的
      //（"断言要钉路径不是终态"：必须证明「用户确实看不见了」）。
      const unseen = await page.evaluate(() => ({
        hasFocus: document.hasFocus(),
        visibility: document.visibilityState,
      }));
      if (unseen.hasFocus) {
        problems.push(
          '⑧ 前置条件不成立：切到后台标签后 document.hasFocus() 仍是 true —— ' +
            '测不到「用户看不见」这件事',
        );
      }

      // 等 9 秒：远超提示剩下的时间（8 秒窗口已用掉 1.5 秒）⇒
      // 如果倒计时没暂停，提示这时早该没了。
      //
      // ⚠️ 冻结值要取**切走之后**的那一帧，不能拿切走之前的那一帧比：
      // 「切走」这个动作本身要花掉零点几秒，那段时间页面还是可见的、
      // 倒计时本来就在走 —— 把它算进「看不见期间」是量错了东西。
      // 所以：切走 ⇒ 等它落定 ⇒ 取冻结值 ⇒ 再等 9 秒 ⇒ 比对。
      const frozen = await toastState(page);
      await waitReal(page, 9000, '⑧ 用户看不见的 9 秒');
      const during = await toastState(page);
      if (!during.present) {
        problems.push(
          '⑧ 用户看不见的 9 秒里提示过期了 —— 退路在用户看不见的时候就没了，' +
            '而他全程不知道有过退路',
        );
      }
      if (during.progressScale !== frozen.progressScale) {
        problems.push(
          `⑧ 用户看不见时进度条还在走（${frozen.progressScale} → ${during.progressScale}）—— 界面在说谎`,
        );
      }
      if (during.animationPlayState !== 'paused') {
        problems.push(`⑧ 用户看不见时 animation-play-state 不是 paused（实测 ${during.animationPlayState}）`);
      }
      await page.screenshot({ path: join(OUT_DIR, '08-page-unseen-paused.png') });

      // 切回管理页 ⇒ 从**暂停处**继续（不是从头），提示还在、还能撤销。
      //
      // ⚠️ 这里要**连续采样**而不是只看终点：中途某一刻又被按住的话，
      // 只看终点是看不出来的（终点那一帧可能是 paused，而中途确实走过）。
      // 判据：至少有一帧是 'running'（倒计时真的续走了），且总体在缩短。
      await page.bringToFront();
      const curve = [];
      for (let i = 0; i < 10; i += 1) {
        await waitReal(page, 250, `⑧ 切回后第 ${i + 1} 次采样`);
        const s = await toastState(page);
        curve.push({ ms: (i + 1) * 250, playState: s.animationPlayState, scale: s.progressScale });
      }
      const back = await toastState(page);
      if (!back.present) {
        problems.push('⑧ 切回管理页后提示没了 —— 暂停把退路变成了「过期」');
      }
      if (!curve.some(c => c.playState === 'running')) {
        problems.push(
          '⑧ 切回管理页后进度条从头到尾都是 paused —— 倒计时没有从暂停处继续（可能停住了）',
        );
      }
      report.steps.push({
        step: '⑧ 用户看不见 ⇒ 暂停；切回来 ⇒ 从暂停处继续',
        unseen,
        before: { scale: before.progressScale, playState: before.animationPlayState },
        frozen: { scale: frozen.progressScale, playState: frozen.animationPlayState },
        during: { scale: during.progressScale, playState: during.animationPlayState },
        back: { scale: back.progressScale, playState: back.animationPlayState, present: back.present },
        curve,
      });
      await page.screenshot({ path: join(OUT_DIR, '08b-page-back-resumed.png') });
      await other.close();
    }

    if (consoleErrors.length) {
      problems.push(`控制台报错 ${consoleErrors.length} 条：${consoleErrors.slice(0, 3).join(' | ')}`);
    }

    report.stalls = stalls;
    if (stalls.length) {
      problems.push(
        `环境卡顿 ${stalls.length} 次（${stalls.map(s => `${s.label}: 问 ${s.asked}ms 实耗 ${s.actual}ms`).join(' | ')}）` +
          '—— 这段时间里的测量不可信（浏览器被挂起/机器休眠），不是产品缺陷',
      );
    }
    writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify({ problems, ...report }, null, 2));
    console.log(JSON.stringify({ problems, tabSteps: report.steps.find(s => s.step.includes('步数'))?.steps }, null, 2));
  } finally {
    await ctx.close();
  }
}

main().catch(err => {
  console.error('验证脚本失败：', err);
  process.exit(1);
});
