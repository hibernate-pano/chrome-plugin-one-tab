// 真机验证：「点扩展图标 = **一定会打开标签管理器**」（2026-10-26 产品定案）。
//
// ── 这条探针在验什么 ─────────────────────────────────────────────────────
//
// 上一条真机验证（`lead-verify-icon-click.mjs`，2026-10-24）验的是
// 「点图标 = 把这一窗存成会话并关掉它」—— 那一半在 2026-10-26 **没变**
// （收集在前、管理器在后，仍是那一条路）。
//
// 2026-10-26 变的是**兜底**：以前「一个都没存下」就**什么都不做**（只弹
// 一条错误通知，屏幕上零变化）⇒ 用户点了图标，像是没点。
// ⇒ 新契约：**无论有没有可收集的标签，点图标都会打开标签管理器**。
//
// 这个「无论何种情况」只能在真 Chrome 里验 —— 单测里的 chrome mock
// 由我们自己写，它对「`chrome.notifications.create` 到底弹没弹」
// 「`chrome.tabs.create({url, windowId})` 到底开在哪个窗口」没有发言权。
//
// ── 两段验证（同一��� Chrome，同一个窗口）────────────────────────────────
//
//   ① 这一窗**没有可收集的标签**（只有一个被 pin 住的标签；默认设置下
//      固定标签页不收集）⇒ 点图标 ⇒ **管理器必须开在这个窗口里**；
//      那个标签**必须原样还在**（没被收集、没被关掉）；
//      且**不许**弹「当前窗口里没有可保存的标签页」那条错误
//      （用户这一趟确实拿到了东西 ⇒ 对着成功报错是错的）。
//   ② 再加一个**能收集**的标签 ⇒ 再点一次 ⇒ 这次它**必须**被存下并关掉
//      （徽标回执写着存了几个）⇒ 证明新契约没有把「收集」这一半改掉。
//
// ── 怎么「真的点图标」 ───────────────────────────────────────────────────
//
// Chrome 没有供脚本调用的「派发 action 点击」API，但扩展事件对象在
// Chromium 实现里带 `dispatch()` ⇒ 把一个**合成的 tab**（带 windowId）
// 投给**真实的** `chrome.action.onClicked` 监听器 ⇒ 走的是生产代码那条路。
// ⚠️ 若某个 Chrome 版本没有 `dispatch` ⇒ 脚本**直接失败**（不许静默降级
// 成「验了别的东西」）。

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/lead-verify-icon-click-empty');
const HEADLESS = process.env.HEADLESS === '1';

const problems = [];
const log = [];

function check(ok, message, detail = '') {
  if (!ok) problems.push(`${message}${detail ? ` —— ${detail}` : ''}`);
  return ok;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 在扩展的 service worker 上下文里列出全部标签（连窗口号）。 */
async function inventory(sw) {
  return sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.map(t => ({
      id: t.id,
      url: t.url ?? '',
      windowId: t.windowId,
      pinned: !!t.pinned,
      title: t.title ?? '',
    }));
  });
}

/** 读工具栏徽标（保存回执：写着存了几个）。 */
async function readBadge(sw) {
  return sw.evaluate(async () => chrome.action.getBadgeText({}));
}

/**
 * 在 SW 里装一个**通知探针**：把每一条 `chrome.notifications.create` 的
 * 消息记下来（照旧发出去，不改行为）。
 *
 * 为什么需要它：「没有可保存的标签页」那条错误是**通知**（不是页面上的字）
 * ⇒ 不盯着通知通道就看不到它 ⇒ 守卫会漏掉「对着成功报错」这个回归。
 */
async function installNotificationSpy(sw) {
  await sw.evaluate(() => {
    // @ts-ignore —— SW 上下文里的全局变量
    globalThis.__notifSpy = [];
    const original = chrome.notifications.create.bind(chrome.notifications);
    chrome.notifications.create = (...args) => {
      const first = args[0];
      const message = typeof first === 'string' ? '' : (first?.message ?? '');
      globalThis.__notifSpy.push(message);
      return original(...args);
    };
  });
}

async function readNotified(sw) {
  return sw.evaluate(() => globalThis.__notifSpy ?? []);
}

/** 把点击投给**真实的** `chrome.action.onClicked` 监听器。 */
async function dispatchIconClick(sw, windowId) {
  const dispatch = await sw.evaluate(async windowId => {
    const evt = chrome.action.onClicked;
    if (!evt || typeof evt.dispatch !== 'function') {
      return { ok: false, reason: '这个 Chrome 的 action.onClicked 没有 dispatch()' };
    }
    await evt.dispatch({ id: -1, windowId, url: 'https://example.com/x' });
    return { ok: true };
  }, windowId);
  if (!check(dispatch.ok, '没能把点击投给真实的 onClicked 监听器', dispatch.reason ?? '')) {
    throw new Error('触发失败 ⇒ 这轮验证作废（不许降级成验别的东西）');
  }
  await sleep(2500);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-icon-click-empty-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: HEADLESS,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--lang=zh-CN',
    ],
    viewport: { width: 1280, height: 800 },
  });

  try {
    // ── 0. 找到扩展的 service worker ────────────────────────────────────
    let sw = null;
    for (let i = 0; i < 40 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await sleep(500);
    }
    if (!sw) throw new Error('扩展的 service worker 没有起来');
    const extId = new URL(sw.url()).host;
    log.push({ step: '扩展已启动', extId });

    // ── 1. 一个窗口，一个标签，然后把它 pin 住 ─────────────────────────
    // （默认设置 collectPinnedTabs=false ⇒ 固定标签页**不收集**
    //  ⇒ 这一窗就「没有可收集的标签」）
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto('https://example.com/pinned-only');
    await sleep(1200);

    const before = await inventory(sw);
    const target = before.find(t => t.url.includes('/pinned-only'));
    if (!target) throw new Error(`没找到我们打开的标签：${JSON.stringify(before)}`);
    const windowId = target.windowId;

    const pinned = await sw.evaluate(async tabId => {
      await chrome.tabs.update(tabId, { pinned: true });
      const t = await chrome.tabs.get(tabId);
      return { pinned: !!t.pinned, windowId: t.windowId };
    }, target.id);
    check(pinned.pinned, '没能把标签 pin 住 ⇒ 这一窗就不可能是「没有可收集的标签」');
    await sleep(500);
    log.push({ step: '已 pin 住', pinned });

    await installNotificationSpy(sw);

    // ── 2. 点图标（这一窗没有可收集的标签）──────────────────────────────
    await dispatchIconClick(sw, windowId);

    const afterEmpty = await inventory(sw);
    const managerPrefix = `chrome-extension://${extId}/src/popup/index.html`;
    const inWindow = afterEmpty.filter(t => t.windowId === windowId);
    const managerTabs = inWindow.filter(t => t.url.startsWith(managerPrefix));
    const stillThere = inWindow.filter(t => t.url.includes('/pinned-only'));
    const notified = await readNotified(sw);
    const badge = await readBadge(sw);
    log.push({ step: '空窗口点完', inWindow, notified, badge });

    // ① 管理器必须开在**点的那一个窗口**里
    check(
      managerTabs.length >= 1,
      '这一窗没有可收集的标签时，点图标**仍然必须**打开标签管理器',
      `窗口 ${windowId} 里 ${managerTabs.length} 个`
    );
    // ② 那个标签必须原样还在（没被收集、没被关掉）
    check(
      stillThere.length === 1,
      '没有可收集的标签时，那个标签必须原样还在（既没存也没关）',
      `剩 ${JSON.stringify(stillThere.map(t => t.url))}`
    );
    // ③ 不许弹「当前窗口里没有可保存的标签页」
    check(
      !notified.some(m => m.includes('没有可保存的标签页')),
      '这一趟用户**确实**拿到了东西（管理器）⇒ 不许对着成功弹「没有可保存的标签页」',
      `弹了：${JSON.stringify(notified)}`
    );
    // ④ 没有收集 ⇒ 不该有保存回执徽标
    check(
      badge.trim() === '',
      '没有收集任何标签 ⇒ 不该出现「刚刚存了 N 个」的徽标',
      `徽标 = ${JSON.stringify(badge)}`
    );

    // ── 3. 再加一个**能收集**的标签，再点一次（另一半没被改掉）────────
    const page2 = await ctx.newPage();
    await page2.goto('https://example.com/collectable');
    await sleep(1500);

    await dispatchIconClick(sw, windowId);

    const afterCollect = await inventory(sw);
    const badgeAfter = await readBadge(sw);
    const inWindow2 = afterCollect.filter(t => t.windowId === windowId);
    const gone = inWindow2.filter(t => t.url.includes('/collectable'));
    log.push({ step: '可收集窗口点完', inWindow2, badgeAfter });

    check(
      gone.length === 0,
      '有能收集的标签时，它必须**被存下并关掉**（新契约没有把「收集」这一半改掉）',
      `还剩 ${JSON.stringify(gone.map(t => t.url))}`
    );
    check(
      /^\d+$/.test(badgeAfter.trim()) && Number(badgeAfter.trim()) > 0,
      '工具栏徽标应当显示「刚刚存了 N 个」⇒ 证明真的存成了',
      `徽标 = ${JSON.stringify(badgeAfter)}`
    );
  } finally {
    await ctx.close().catch(() => {});
  }

  const result = {
    ok: problems.length === 0,
    problems,
    log,
  };
  writeFileSync(join(OUT_DIR, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (problems.length > 0) {
    console.error(`\n❌ 真机验证失败：${problems.length} 条问题`);
    process.exit(1);
  }
  console.log('\n✅ 真机验证通过');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
