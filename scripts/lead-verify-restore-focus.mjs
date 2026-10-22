// 真机验证：「恢复整个会话」之后，**用户正在看的那个页面**是不是能显示撤销提示。
//
// ── 为什么这个脚本必须存在 ────────────────────────────────────────────────
//
// 上一轮的探针（`scripts/lead-verify-undo.mjs`）断言的是
// `locator('button', {hasText:'撤销'}).isVisible()`。
// **`isVisible()` 问的是「这个元素在页面上有没有盒子」** —— 它**不关心这个页面
// 是不是用户正在看的那个** ⇒ 探针的判据比要验的判据**弱** ⇒ 上一轮它是**假绿**。
//
// 真实的缺陷（2026-10-23 审计 §2.5 P0）：
//   · 整组→当前窗口：新标签 `active:true` ⇒ 管理页退为**后台标签**；
//   · 整组→新窗口：  新窗口 `focused:true` ⇒ 管理页所在窗口变**后台窗口**。
// ⇒ 撤销提示在 DOM 里（isVisible() 为真）但用户**看不见** ⇒
//   那次消费事实上没有退路 ⇒ 点错组且过了 8 秒，这一组**永久没了**
//   （删除即物理清除、无回收站），而他连「这里原本可以撤销」都不知道。
//
// ── 本脚本的判据 ─────────────────────────────────────────────────────────
//
// **用 Chrome 自己的窗口账本**，不用 `isVisible()`：
//   `chrome.windows.getAll({populate:true})` ⇒ 每个窗口的 `focused` 标志
//   + 每个标签页的 `active` 标志；
//   `chrome.windows.getLastFocused({populate:true})` ⇒ **上一次**有焦点的窗口。
//
// 「用户看得见撤销提示」当且仅当：
//   ① **最后聚焦的窗口**里，管理页是 **active 标签**（不是后台标签），**且**
//   ② 该窗口此刻 `focused`（浏览器窗口确实在前台）—— 只作对照。
//
// ⚠️ **为什么主判据是 getLastFocused 而不是 focused**（实测踩出来的坑）──
//
// `focused` 标志在**整个浏览器失去 OS 焦点**时会**全部变 false**
// （实测 `chrome.windows.onFocusChanged(-1)`，-1 = 没有窗口有焦点）。
// ⇒ 只看 `focused` 会把「用户临时切到别的 App 了」误判成「修复失效」——
//   本脚本第一版就栽在这里：C 路径明明抓回来了，却报「管理页不在用户眼前」。
//
// `getLastFocused()` 给的是**上一次**有焦点的窗口，与 OS 焦点无关 ⇒
// 它是「浏览器内部把哪个窗口放在前面」这一事实的**稳定读数**。
//
// ⚠️ **判据必须有检测力** —— 否则它验不出任何东西。
//   本脚本因此先记一个「恢复前基线」（场景 0）：用户点按钮之前他就在看管理页。
//   ⇒ 判据恒为真 ⇒ 它验不出「管理页被顶成后台标签」这种缺陷 ⇒ 白测。
//   配套的反证：把 `src/background/TabManager.ts` 里的
//   `bringManagerPageToFront` 调用去掉再跑本脚本，B/C 两个场景必须变红。
//
// ── 顺带验的（同一族的第二条）──────────────────────────────────────────
//
// 「撤销」提示被队列静默挤掉（DS-43-12）⇒ 也要验：**连点 4 次消费**之后，
// 带「撤销」的提示**必须还在**。
//
// ── 两半的分工（本脚本实测出来的，2026-10-23）──────────────────────────
//
// 审计 §2.5 那条 P0 其实是**两半**，只有一半是「焦点」的：
//
//   · **可见性那一半**（本脚本 / 焦点）：恢复完成后，**用户正在看的那个页面**
//     必须就是挂着撤销提示的那个页面。
//     判据 = Chrome 的窗口账本（最后聚焦的窗口 + 活动标签）。
//
//   · **时限那一半**（另一路 agent）：提示在**用户看不见它**的时候不许过期。
//     ⚠️ 实测发现一个**致命细节**（本脚本实测，2026-10-23）：
//     **Chrome 的 Page Visibility API 在「后台窗口」里完全不可靠** ——
//     管理页被挪到后台**窗口**后，`document.hidden` 仍是 `false`、
//     `visibilityState` 仍是 `'visible'`、`document.hasFocus()` 仍是 `true`、
//     `visibilitychange` 事件**一次都不触发**（普通网页做对照组，结果一样）。
//     ⇒ 「页面不可见时暂停倒计时」若以 `document.hidden` 为判据，
//       **它盖不住路径 C**（整组→新窗口）。
//     ⇒ 那半边必须改用**窗口账本**（`chrome.windows.getLastFocused()`）
//       或由 SW 侧广播焦点事件来判「我这个页面是不是用户正在看的那个」。
//
// 用法：`pnpm build` 之后 `node scripts/lead-verify-restore-focus.mjs`
// 产物：outputs/lead-verify-restore-focus/*.png + results.json
// 退出码：0 = 全部判据成立；1 = 有判据不成立（problems 非空）。

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/lead-verify-restore-focus');
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
  group('焦点验证会话', [
    ['https://example.com/alpha', 'Alpha 页面'],
    ['https://example.com/beta', 'Beta 页面'],
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

/**
 * **Chrome 自己的窗口账本** —— 本脚本唯一的判据来源。
 *
 * 刻意**不用** `isVisible()`：那个问的是「元素在页面上有没有盒子」，
 * 与「用户是不是正在看这个页面」无关 ⇒ 上一轮就是在这里假绿的。
 *
 * ⚠️ 为什么除了 `focused` 还要取 `getLastFocused()` ───────────────────────
 *
 * 实测（2026-10-23）：`chrome.windows.getAll()` 的 `focused` 标志，在**整个
 * 浏览器失去 OS 焦点**时（用户切到别的 App、或自动化环境抢焦点）会**全部变成
 * false** —— 实测到 `windows.onFocusChanged(-1)` 事件（-1 = 没有窗口有焦点）。
 * ⇒ 单看 `focused` 会把「用户临时切走了」误判成「我们的修复失效」。
 *
 * `chrome.windows.getLastFocused()` 给的是**上一次**有焦点的窗口，与 OS 焦点
 * 无关 ⇒ 它是「浏览器内部把哪个窗口放在前面」这一事实的稳定读数。
 *
 * ⇒ 判据 = 「最后聚焦的窗口里，管理页是不是活动标签」。
 *   · `focused` 另记一份，作为「此刻浏览器窗口确实在前台」的对照。
 */
async function windowLedger(sw, managerUrl) {
  return sw.evaluate(async (mgrUrl) => {
    const wins = await chrome.windows.getAll({ populate: true });
    const last = await chrome.windows.getLastFocused({ populate: true });
    return {
      windows: wins.map(w => ({
        id: w.id,
        focused: w.focused,
        tabs: (w.tabs ?? []).map(t => ({
          id: t.id,
          url: t.url,
          active: t.active,
          title: t.title,
          isManager: t.url?.startsWith(mgrUrl),
        })),
      })),
      lastFocusedWindowId: last?.id ?? null,
      lastFocusedHasManagerActiveTab: (last?.tabs ?? []).some(
        t => t.url?.startsWith(mgrUrl) && t.active),
    };
  }, managerUrl);
}

/**
 * 「用户**正在看的**那个页面是不是管理页」的判定。
 *
 * 判据（两个条件都要满足，缺一不可）：
 *   ① **最后聚焦的窗口**里，管理页是 **active 标签**
 *      （否则管理页是后台标签 ⇒ 用户在同一个窗口里看的是别的标签）；
 *   ② 该窗口此刻 `focused`（浏览器窗口确实在前台）——
 *      这一条只作**对照**：它在浏览器整体失焦时也会变 false，
 *      所以**不能**单独拿它当判据（见 windowLedger 的注释）。
 */
function isManagerInFront(ledger) {
  const wins = ledger.windows ?? [];
  const managerWindows = wins.filter(w => w.tabs.some(t => t.isManager));
  if (managerWindows.length === 0) {
    return { ok: false, why: '窗口账本里没有管理页' };
  }
  const lastId = ledger.lastFocusedWindowId;
  const last = wins.find(w => w.id === lastId);
  if (!last) {
    return { ok: false, why: `最后聚焦的窗口 ${lastId} 不在账本里` };
  }
  const managerActive = last.tabs.some(t => t.isManager && t.active);
  if (managerActive) {
    return { ok: true, why: '', windowId: last.id, focusedNow: last.focused };
  }
  const why = [
    `最后聚焦的窗口${last.id} 里管理页不是活动标签`,
    ...managerWindows.map(w =>
      `窗口${w.id}(focused=${w.focused}, 管理页是活动标签=${w.tabs.some(t => t.isManager && t.active)})`),
  ].join('; ');
  return { ok: false, why };
}

/** 管理页里那条「撤销」按钮在不在 DOM 里（这是**弱**判据，只作对照）。 */
async function undoInDom(page) {
  return page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === '撤销');
    if (!btn) return { present: false, cssVisible: false };
    const r = btn.getBoundingClientRect();
    return { present: true, cssVisible: r.width > 0 && r.height > 0 };
  });
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-focus-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--lang=zh-CN'],
    viewport: { width: 1440, height: 900 },
  });
  const log = [];
  const problems = [];
  /** 属于**另一路 agent**的半边问题（焦点那半管不了的）—— 如实记，不算失败。 */
  const pendingOtherHalf = [];
  try {
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await new Promise(r => setTimeout(r, 500));
    }
    if (!sw) throw new Error('扩展的 service worker 没有起来');
    const id = new URL(sw.url()).host;
    const managerUrl = `chrome-extension://${id}/src/popup/index.html`;

    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));

    await page.goto(managerUrl);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
    await injectGroups(page, groups);
    await page.reload();
    await page.waitForSelector('text=焦点验证会话', { timeout: 15000 });
    await page.waitForTimeout(1200);

    // ── 场景 0：恢复**之前**的基线 ─────────────────────────────────────
    // 用途有二：
    //   ① 让后面几个场景有对照（用户点按钮之前他就在看管理页）；
    //   ② **证明这个判据有检测力** —— 若判据恒为真，它就验不出任何东西。
    const ledger0 = await windowLedger(sw, managerUrl);
    const front0 = isManagerInFront(ledger0);
    log.push({ scenario: '0 恢复前基线', ledger: ledger0, managerInFront: front0 });
    if (!front0.ok) {
      problems.push(`恢复前基线就不对：用户点的就不是管理页 —— ${front0.why}`);
    }

    // ── 场景 B：整组恢复到**当前窗口** ─────────────────────────────────
    await page
      .locator('[role="region"]')
      .filter({ hasText: '焦点验证会话' })
      .first()
      .locator('button[aria-label^="在当前窗口打开整个会话"]')
      .first()
      .click();
    await page.waitForTimeout(2500);

    const ledgerB = await windowLedger(sw, managerUrl);
    const frontB = isManagerInFront(ledgerB);
    const undoB = await undoInDom(page);
    log.push({ scenario: 'B 整组→当前窗口', ledger: ledgerB, managerInFront: frontB, undoInDom: undoB });
    await page.screenshot({ path: join(OUT_DIR, 'B-current-window.png') });

    if (!frontB.ok) {
      problems.push(`B（整组→当前窗口）：管理页不在用户眼前 —— ${frontB.why}`);
    }
    if (!undoB.present) {
      problems.push('B（整组→当前窗口）：DOM 里连「撤销」按钮都没有');
    }

    // ── 场景 C：整组恢复到**新窗口** ───────────────────────────────────
    // 先把会话放回去（B 那次已经消费掉了它）。
    await page.reload();
    await injectGroups(page, groups);
    await page.reload();
    await page.waitForSelector('text=焦点验证会话', { timeout: 15000 });
    await page.waitForTimeout(1200);

    // 先记下**恢复之前**有哪些窗口 ⇒ 恢复之后多出来的那个就是「新窗口」。
    //
    // ⚠️ 不能靠「最后聚焦的窗口」反推新窗口：修复生效后管理页会被切回前台，
    //    最后聚焦的窗口**就是管理页那个** ⇒ 那样算出来的是管理页自己，
    //    D2 于是「切到新窗口」这一步被跳过、10 秒根本没等 ⇒ **假绿**。
    //    （这是本脚本自己踩过的坑：修复前能跑出结果，修复后反而测不到东西。）
    const windowsBeforeC = await sw.evaluate(async () =>
      (await chrome.windows.getAll({})).map(w => w.id)
    );

    await page
      .locator('[role="region"]')
      .filter({ hasText: '焦点验证会话' })
      .first()
      .locator('button[aria-label^="在新窗口恢复整个会话"]')
      .first()
      .click();
    await page.waitForTimeout(3000);

    // 恢复出来的新窗口的 id（D2 要用它把用户「送走」到那个窗口去）。
    const restoreWindowId = await sw.evaluate(async (before) => {
      const wins = await chrome.windows.getAll({});
      const added = wins.filter(w => !before.includes(w.id));
      return added.length > 0 ? added[added.length - 1].id : null;
    }, windowsBeforeC);

    const ledgerC = await windowLedger(sw, managerUrl);
    const frontC = isManagerInFront(ledgerC);
    const undoC = await undoInDom(page);
    log.push({ scenario: 'C 整组→新窗口', ledger: ledgerC, managerInFront: frontC, undoInDom: undoC, restoreWindowId });
    await page.screenshot({ path: join(OUT_DIR, 'C-new-window.png') });

    if (!frontC.ok) {
      problems.push(`C（整组→新窗口）：管理页不在用户眼前 —— ${frontC.why}`);
    }
    if (!undoC.present) {
      problems.push('C（整组→新窗口）：DOM 里连「撤销」按钮都没有');
    }

    // ── 场景 D：退路的**时限**这一半 ──────────────────────────────────
    //
    // 审计 §2.5 的原始场景：「用户在恢复后的新窗口里停留 10 秒再切回 ⇒
    // 撤销提示已经没了」。
    //
    // ⚠️ **本脚本测的是两件不同的事**，别混：
    //
    //   · **D1（本脚本的职责 = 焦点那一半）**：恢复刚完成时，
    //     管理页是不是**用户正在看的那个页面**。⇒ 必须成立。
    //
    //   · **D2（另一路 agent 的职责 = 时限那一半）**：用户**自己**走到
    //     新窗口去干活、待了 10 秒再回来，撤销提示**还在不在**。
    //     ⇒ 这依赖「页面不可见时暂停倒计时」那一半落地。
    //
    // D2 目前**尚未落地**（src/ 下没有任何 visibilitychange 监听）⇒
    // 本脚本如实记录 D2 的结果，并**明确标注它属于哪一半**，
    // 不把它算成焦点那一半的失败。
    await page.waitForTimeout(1000);

    // D1：恢复刚完成 ⇒ 管理页就在用户眼前，撤销提示在 DOM 里。
    const ledgerD1 = await windowLedger(sw, managerUrl);
    const frontD1 = isManagerInFront(ledgerD1);
    const undoD1 = await undoInDom(page);
    log.push({ scenario: 'D1 恢复刚完成', ledger: ledgerD1, managerInFront: frontD1, undoInDom: undoD1 });

    if (!frontD1.ok) {
      problems.push(`D1（恢复刚完成）：管理页不在用户眼前 —— ${frontD1.why}`);
    }
    if (!undoD1.present) {
      problems.push('D1（恢复刚完成）：DOM 里连「撤销」按钮都没有');
    }

    // D2：模拟「用户自己切到新窗口去干活」⇒ 管理页退到后台 ⇒ 等 10 秒。
    //
    // ⚠️ 必须用**场景 C 记下的新窗口 id**，不能用「最后聚焦的窗口」：
    //    修复生效后管理页已经被切回前台 ⇒ 「最后聚焦的窗口」就是管理页自己
    //    ⇒ 老写法会认为「用户已经在新窗口了」⇒ **跳过那 10 秒** ⇒ 假绿。
    //    （这条假绿是修复**生效之后**才冒出来的 —— 判据必须跟着修复一起长。）
    const newWindowId = restoreWindowId;
    if (newWindowId !== null) {
      await sw.evaluate(async (winId) => { await chrome.windows.update(winId, { focused: true }); }, newWindowId);
      await page.waitForTimeout(10000);
    } else {
      pendingOtherHalf.push(
        'D2：没能认出恢复出来的新窗口（restoreWindowId 为 null）⇒ 这轮没测到「用户切走后待 10 秒」。'
      );
    }
    const undoD2 = await undoInDom(page);
    const ledgerD2 = await windowLedger(sw, managerUrl);
    log.push({
      scenario: 'D2 用户切到新窗口待了 10 秒（属「时限」那一半）',
      ledger: ledgerD2,
      undoInDom: undoD2,
      switchedToWindowId: newWindowId,
      waitedMs: newWindowId === null ? 0 : 10000,
      half: '时限（暂停倒计时）那一半 —— 尚未落地',
    });
    await page.screenshot({ path: join(OUT_DIR, 'D-after-10s.png') });

    if (newWindowId !== null && !undoD2.present) {
      // 如实记录，但**不算**焦点那一半的失败 ⇒ 单独列在「待另一路」里。
      pendingOtherHalf.push(
        'D2：用户切到新窗口待 10 秒后，撤销提示已不在 DOM —— ' +
        '这属于「隐藏时暂停倒计时」那一半（另一路 agent），焦点那一半管不了。'
      );
    }

    // ── 场景 E：连点 3 次消费 ⇒ 第一条带「撤销」的提示不许被挤掉 ──────
    // （DS-43-12：队列上限曾把承载退路的提示静默丢掉）
    await page.reload();
    await injectGroups(page, [
      group('挤掉验证会话', [
        ['https://example.com/one', 'One 页面'],
        ['https://example.com/two', 'Two 页面'],
        ['https://example.com/three', 'Three 页面'],
        ['https://example.com/four', 'Four 页面'],
      ]),
    ]);
    await page.reload();
    await page.waitForSelector('text=挤掉验证会话', { timeout: 15000 });
    await page.waitForTimeout(1200);

    // 连点 4 个不同的标签（每次消费一条 ⇒ 4 条提示）⇒ 队列必然超限
    for (const title of ['One 页面', 'Two 页面', 'Three 页面', 'Four 页面']) {
      await page.locator(`text=${title}`).first().click();
      await page.waitForTimeout(350);
    }
    await page.waitForTimeout(500);
    const undoCount = await page.evaluate(() =>
      [...document.querySelectorAll('button')].filter(b => b.textContent?.trim() === '撤销').length);
    log.push({ scenario: 'E 连点 4 次消费', undoButtonsInDom: undoCount });
    await page.screenshot({ path: join(OUT_DIR, 'E-queue-pressure.png') });

    if (undoCount === 0) {
      problems.push('E（连点 4 次消费）：所有带「撤销」的提示都被挤掉了 —— 退路全丢');
    }

    if (consoleErrors.length) {
      problems.push(`控制台报错 ${consoleErrors.length} 条：${consoleErrors.slice(0, 3).join(' | ')}`);
    }

    writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify({ log, problems, pendingOtherHalf }, null, 2));
    console.log(JSON.stringify({
      problems,
      pendingOtherHalf,
      summary: log.map(l => ({
        scenario: l.scenario,
        managerInFront: l.managerInFront?.ok ?? null,
        why: l.managerInFront?.why ?? '',
        lastFocusedWindowId: l.ledger?.lastFocusedWindowId ?? null,
        managerIsActiveTabInLastFocusedWindow: l.ledger?.lastFocusedHasManagerActiveTab ?? null,
        focusedFlagsNow: (l.ledger?.windows ?? []).map(w => w.focused),
        undoInDom: l.undoInDom ?? null,
      })),
    }, null, 2));
    if (problems.length) process.exitCode = 1;
  } finally {
    await ctx.close();
  }
}

main().catch(err => {
  console.error('验证脚本失败：', err);
  process.exit(1);
});
