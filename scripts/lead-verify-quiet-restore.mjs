// 真机验证：「安静的成功」Task 3 —— 恢复类播报收口（2026-10-25）。
//
// ── 这个脚本在验什么 ──────────────────────────────────────────────────────
//
// Task 3 把「恢复即消费」这条链上的成功播报收口了：
//   · 锁定组恢复 ⇒ **静默**（锁定组从不被消费 ⇒ 那张卡还在 ⇒ 界面自明）；
//   · 锁定说明 ⇒ **常驻**在卡片上（随时可查，toast 会消失）；
//   · 解锁 ⇒ **静默**（那行消失本身就是反馈）；
//   · 撤销提示 ⇒ **中性**（带退路，但不再庆祝）。
//
// 单测与源码守卫只能证明「代码长成该长的样子」；这个脚本验的是**用户
// 真正看见的东西**：有没有 toast、那条 toast 长什么样、撤销还在不在、
// 记录回不回得来。
//
// ⚠️ 判据必须**断言目标状态**，不能只打印「跑完了」——
//   本仓吃过假绿探针的亏（见 memory: 截图/探针要断言目标状态）。
//   下面每一条都是「看得见的具体状态」，不是「脚本没报错」。
//
// ⚠️ 「没有 toast」这条判据怎么判：popup 里**别的**地方也有 role=status
//   （列表加载态、搜索结果播报…）⇒ 不能只按 role 抓。判据用的是
//   **「有『关闭提示』按钮的那一个 live region」** —— 只有 toast 有这个按钮。
//   一条都没有 ⇒ 真的没出声。
//
// 用法：`pnpm build` 之后 `node scripts/lead-verify-quiet-restore.mjs`
// 产出：outputs/lead-verify-quiet-restore/*.png + log.json

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/lead-verify-quiet-restore');
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

function group(name, tabs, { locked = false } = {}) {
  const id = crypto.randomUUID();
  return {
    id,
    name,
    notes: '',
    isFavorite: false,
    isLocked: locked,
    isDeleted: false,
    tabs: tabs.map(([url, title]) => tab(id, url, title)),
    createdAt: iso(now - 7200e3),
    updatedAt: iso(now - 3600e3),
    version: 1,
    displayOrder: 1,
    lastOp: { s: 1, d: 'verify-quiet' },
  };
}

const groups = [
  group('未锁定会话甲', [
    ['https://example.com/alpha', 'Alpha 页面'],
    ['https://example.com/beta', 'Beta 页面'],
  ]),
  group('未锁定会话乙', [['https://example.com/epsilon', 'Epsilon 页面']]),
  group('锁定会话丙', [
    ['https://example.com/gamma', 'Gamma 页面'],
    ['https://example.com/delta', 'Delta 页面'],
  ], { locked: true }),
  // ⚠️ 标题里带「页面」两个字：批量恢复那条检查要**四笔账都在**，
  // 而「打不开的那几个」只有在命中集合里真的有 file:// 时才会计入
  // （否则那一账是 0，文案层按设计就不写它 —— 那是文案层的既有口径）。
  group('文件会话丁', [['file:///etc/hosts', '本机文件页面']]),
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
        tx.onerror = () => { db.close(); rej(tx.error); };
      };
    });
  }, data);
}

/**
 * 此刻用户**看得见**的 toast。
 *
 * 每条带：
 *   · text   —— 整条提示的文字；
 *   · label  —— 类型角标（'提示' / '出错' / '注意'；**没有「完成」**）；
 *   · accent —— 顶部那条装饰条的实际颜色（判「是不是绿色成功皮」用）；
 *   · isNeutralAccent / isDangerAccent —— 那条装饰条等于哪个主题令牌。
 */
async function visibleToasts(page) {
  return page.evaluate(() => {
    const resolveVar = name => {
      const probe = document.createElement('div');
      probe.style.color = `var(${name})`;
      document.body.appendChild(probe);
      const v = getComputedStyle(probe).color;
      probe.remove();
      return v;
    };
    const accentVar = resolveVar('--color-accent');
    const dangerVar = resolveVar('--color-danger');

    const out = [];
    for (const el of document.querySelectorAll('[role="alert"], [role="status"]')) {
      // 只有 toast 有「关闭提示」按钮 —— 别的 live region 没有 ⇒ 这里过滤掉它们。
      if (!el.querySelector('button[aria-label="关闭提示"]')) continue;
      const text = (el.innerText || '').trim();
      if (!text) continue;
      const labelEl = el.querySelector('.text-xs.font-semibold');
      const accentEl = el.querySelector('div.h-1.w-full');
      const accent = accentEl ? getComputedStyle(accentEl).backgroundColor : '';
      out.push({
        text: text.replace(/\s+/g, ' ').slice(0, 300),
        label: (labelEl?.innerText || '').trim(),
        accent,
        isNeutralAccent: accent === accentVar,
        isDangerAccent: accent === dangerVar,
        hasUndo: Array.from(el.querySelectorAll('button'))
          .some(b => (b.innerText || '').trim() === '撤销'),
        hasFocus: document.hasFocus(),
      });
    }
    return out;
  });
}

/** 把当前还挂着的 toast 都关掉（让下一条判据从零开始数）。 */
async function clearToasts(page) {
  const closes = page.locator('button[aria-label="关闭提示"]');
  const n = await closes.count();
  for (let i = 0; i < n; i += 1) {
    await closes.first().click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(200);
}

/**
 * ── toast 录像机 ────────────────────────────────────────────────────────────
 *
 * 为什么需要它：普通提示只活 **3 秒**（挂动作的才活 8 秒）。
 * 「动作之后隔 3 秒再看一眼有没有 toast」这个判据是**假绿**的 ——
 * 真的弹了，但它已经过期了 ⇒ 看着像「什么都没说」。
 * 本仓吃过这种亏（memory: 截图/探针要断言目标状态）。
 *
 * ⇒ 录像机在**动作开始前**挂上，把**出现过**的每一条 toast 都记下来
 *   （文字 + 类型角标 + 装饰条颜色）；动作结束后再取出来。
 *   ⇒「全程没有出声」= 录像为空（不是「此刻看不见」）。
 *
 * ⚠️ 为什么用 MutationObserver 而不是 setInterval：
 *   弹窗页在真机场景里是**后台标签**（恢复动作会新开标签把它挤到后台）
 *   ⇒ Chrome 会把后台标签的定时器节流到 1 次/秒甚至 1 次/分钟
 *   ⇒ 轮询会**漏记**（本仓踩过：假绿）。MutationObserver 不是定时器
 *   ⇒ 后台标签照常触发。
 */
async function startToastRecorder(page) {
  await page.evaluate(() => {
    const resolveVar = name => {
      const probe = document.createElement('div');
      probe.style.color = `var(${name})`;
      document.body.appendChild(probe);
      const v = getComputedStyle(probe).color;
      probe.remove();
      return v;
    };
    const accentVar = resolveVar('--color-accent');
    const dangerVar = resolveVar('--color-danger');

    const state = { events: [], open: new Set(), observer: null };
    const scan = () => {
      const now = new Set();
      for (const el of document.querySelectorAll('[role="alert"], [role="status"]')) {
        // 只有 toast 有「关闭提示」按钮 —— 别的 live region 没有 ⇒ 过滤掉它们。
        if (!el.querySelector('button[aria-label="关闭提示"]')) continue;
        const text = (el.innerText || '').trim();
        if (!text) continue;
        const labelEl = el.querySelector('.text-xs.font-semibold');
        const accentEl = el.querySelector('div.h-1.w-full');
        const accent = accentEl ? getComputedStyle(accentEl).backgroundColor : '';
        now.add(text);
        if (!state.open.has(text)) {
          state.open.add(text);
          state.events.push({
            text: text.replace(/\s+/g, ' ').slice(0, 300),
            label: (labelEl?.innerText || '').trim(),
            accent,
            isNeutralAccent: accent === accentVar,
            isDangerAccent: accent === dangerVar,
            hasUndo: Array.from(el.querySelectorAll('button'))
              .some(b => (b.innerText || '').trim() === '撤销'),
          });
        }
      }
      state.open = now;
    };
    const observer = new MutationObserver(() => scan());
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    state.observer = observer;
    scan();
    window.__qt3 = state;
  });
}

/** 停掉录像机，取回**整个动作窗口内出现过**的每一条 toast。 */
async function stopToastRecorder(page) {
  return page.evaluate(() => {
    const state = window.__qt3;
    if (!state) return [];
    if (state.observer) state.observer.disconnect();
    const events = state.events;
    window.__qt3 = null;
    return events;
  });
}

/** 等一条 toast 出现（最多 timeout 毫秒）——「刚弹出来就被采样」才不会漏。 */
async function waitForToast(page, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const toasts = await visibleToasts(page);
    if (toasts.length > 0) return toasts;
    await page.waitForTimeout(150);
  }
  return [];
}

/** 某张会话卡片（按**会话名**定位，不按「第几个」）。 */
function cardOf(page, sessionName) {
  return page.locator('[role="region"]').filter({ hasText: sessionName }).first();
}

/** 某张卡里的标签行标题，按出现顺序。 */
async function tabTitlesOf(page, sessionName) {
  const card = cardOf(page, sessionName);
  return card.evaluate(el =>
    [...el.querySelectorAll('.tab-item-title')]
      .map(t => (t.textContent || '').trim())
      .filter(Boolean),
  );
}

/** 那张卡上有没有「锁定说明」这一行（常驻行）。 */
async function lockDisclosureOf(page, sessionName) {
  const card = cardOf(page, sessionName);
  const el = card.locator('.tab-group-lock-disclosure').first();
  if ((await el.count()) === 0) return null;
  return ((await el.innerText()) || '').trim();
}

/** 列表页当前可见的会话名。 */
async function visibleGroupNames(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[role="region"]')]
      .map(el => {
        const t = el.querySelector('h3');
        return (t?.innerText || '').trim();
      })
      .filter(Boolean),
  );
}

/** 浏览器里现在有几个标签页（用来判「真的开出来了」）。 */
async function browserTabCount(sw) {
  return sw.evaluate(async () => (await chrome.tabs.query({})).length);
}

/** 一条提示是不是「中性的」（不是绿色成功皮）。 */
function isNeutralToast(toast) {
  return toast.label === '提示' &&
    !/完成|成功/.test(toast.text) &&
    toast.isNeutralAccent;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-quiet-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--lang=zh-CN'],
    viewport: { width: 1440, height: 900 },
  });
  const log = [];
  const problems = [];
  const check = (label, ok, detail) => {
    log.push({ label, ok, detail });
    if (!ok) problems.push(`${label} —— ${detail}`);
  };

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
    await page.waitForSelector('text=锁定会话丙', { timeout: 15000 });
    await page.waitForTimeout(1200);

    // ══════════════════════════════════════════════════════════════════
    // ① 锁定组恢复 ⇒ 没有任何 toast、卡片还在、窗口开了、常驻说明在
    // ══════════════════════════════════════════════════════════════════
    {
      await clearToasts(page);
      const before = await browserTabCount(sw);
      const disclosureBefore = await lockDisclosureOf(page, '锁定会话丙');
      check(
        '①a 锁定卡片上那行常驻说明存在',
        !!disclosureBefore && disclosureBefore.includes('已锁定') &&
          disclosureBefore.includes('保留') && disclosureBefore.includes('清理重复标签') &&
          disclosureBefore.includes('拖到别的会话'),
        `实际：${JSON.stringify(disclosureBefore)}`,
      );

      await startToastRecorder(page);
      await cardOf(page, '锁定会话丙')
        .locator('button[aria-label^="在当前窗口打开整个会话"]')
        .first()
        .click();
      await page.waitForTimeout(3500);
      await page.bringToFront();
      const toasts = await stopToastRecorder(page);
      const after = await browserTabCount(sw);
      const names = await visibleGroupNames(page);
      const disclosureAfter = await lockDisclosureOf(page, '锁定会话丙');
      await page.screenshot({ path: join(OUT_DIR, '01-locked-restore-silent.png') });

      check('①b 锁定组恢复 ⇒ 整个动作窗口内没有任何提示', toasts.length === 0,
        `实际出现了 ${toasts.length} 条：${JSON.stringify(toasts)}`);
      check('①c 锁定组恢复 ⇒ 卡片还在（从不被消费）',
        names.some(n => n.includes('锁定会话丙')), `实际列表：${JSON.stringify(names)}`);
      check('①d 锁定组恢复 ⇒ 标签真的开出来了', after > before,
        `打开前 ${before} 个标签，打开后 ${after} 个`);
      check('①e 锁定组恢复 ⇒ 那行常驻说明还在',
        !!disclosureAfter && disclosureAfter.includes('已锁定'),
        `实际：${JSON.stringify(disclosureAfter)}`);
    }

    // ══════════════════════════════════════════════════════════════════
    // ② 锁定组点开单个标签 ⇒ 没有任何 toast、那行还在、页面开了
    // ══════════════════════════════════════════════════════════════════
    {
      await clearToasts(page);
      const before = await browserTabCount(sw);
      const titlesBefore = await tabTitlesOf(page, '锁定会话丙');
      await startToastRecorder(page);
      await page
        .locator('a.tab-item-title[aria-label^="打开标签页: Gamma 页面"]')
        .first()
        .click();
      await page.waitForTimeout(3000);
      await page.bringToFront();
      const toasts = await stopToastRecorder(page);
      const after = await browserTabCount(sw);
      const titlesAfter = await tabTitlesOf(page, '锁定会话丙');
      const disclosure = await lockDisclosureOf(page, '锁定会话丙');
      await page.screenshot({ path: join(OUT_DIR, '02-locked-single-tab-silent.png') });

      check('②a 锁定组点开单标签 ⇒ 整个动作窗口内没有任何提示', toasts.length === 0,
        `实际出现了 ${toasts.length} 条：${JSON.stringify(toasts)}`);
      check('②b 锁定组点开单标签 ⇒ 页面真的开出来了', after > before,
        `打开前 ${before} 个标签，打开后 ${after} 个`);
      check('②c 锁定组点开单标签 ⇒ 那条记录还在（锁定 = 组内不删）',
        titlesAfter.length === titlesBefore.length,
        `点开前 ${titlesBefore.length} 行，点开后 ${titlesAfter.length} 行`);
      check('②d 锁定组点开单标签 ⇒ 那行常驻说明还在',
        !!disclosure && disclosure.includes('已锁定'), `实际：${JSON.stringify(disclosure)}`);
    }

    // ══════════════════════════════════════════════════════════════════
    // ⑦ 锁定 → 解锁 ⇒ 没有任何 toast、那行消失（再锁回去，顺带验锁定也静默）
    // ══════════════════════════════════════════════════════════════════
    {
      await clearToasts(page);
      await startToastRecorder(page);
      await cardOf(page, '锁定会话丙')
        .locator('button[aria-label="解锁会话"]')
        .first()
        .click();
      await page.waitForTimeout(2500);
      await page.bringToFront();
      const toasts = await stopToastRecorder(page);
      const disclosure = await lockDisclosureOf(page, '锁定会话丙');
      await page.screenshot({ path: join(OUT_DIR, '03-unlocked-silent.png') });
      check('⑦a 解锁 ⇒ 整个动作窗口内没有任何提示', toasts.length === 0,
        `实际出现了 ${toasts.length} 条：${JSON.stringify(toasts)}`);
      check('⑦b 解锁 ⇒ 那行常驻说明消失了', disclosure === null,
        `实际：${JSON.stringify(disclosure)}`);

      // 再锁回去（后面的检查要一个锁定的会话；顺手也验「锁定也静默」）
      await clearToasts(page);
      await startToastRecorder(page);
      await cardOf(page, '锁定会话丙')
        .locator('button[aria-label="锁定会话"]')
        .first()
        .click();
      await page.waitForTimeout(2500);
      await page.bringToFront();
      const toasts2 = await stopToastRecorder(page);
      const disclosure2 = await lockDisclosureOf(page, '锁定会话丙');
      check('⑦c 锁定 ⇒ 整个动作窗口内没有任何提示', toasts2.length === 0,
        `实际出现了 ${toasts2.length} 条：${JSON.stringify(toasts2)}`);
      check('⑦d 锁定 ⇒ 那行常驻说明回来了',
        !!disclosure2 && disclosure2.includes('已锁定'), `实际：${JSON.stringify(disclosure2)}`);
    }

    // ══════════════════════════════════════════════════════════════════
    // ③ 未锁定点开单个标签 ⇒ 一条中性提示 + 撤销 + 撤销后回原位
    // ══════════════════════════════════════════════════════════════════
    {
      await clearToasts(page);
      await startToastRecorder(page);
      await page
        .locator('a.tab-item-title[aria-label^="打开标签页: Alpha 页面"]')
        .first()
        .click();
      // 等它真的弹出来再采样（普通提示只活 3 秒 ⇒ 固定等 1.5 秒会漏）
      const shown = await waitForToast(page);
      const recorded = await stopToastRecorder(page);
      await page.bringToFront();
      await page.screenshot({ path: join(OUT_DIR, '04-unlocked-single-tab.png') });
      check('③a 未锁定点开单标签 ⇒ 恰好一条提示', shown.length === 1 && recorded.length === 1,
        `当前可见 ${shown.length} 条 / 全程出现过 ${recorded.length} 条：${JSON.stringify(recorded)}`);
      if (shown.length === 1) {
        check('③b 那条提示是中性的（不是绿色「完成」皮）', isNeutralToast(shown[0]),
          `实际：${JSON.stringify(shown[0])}`);
      }
      const undo = page.locator('button', { hasText: '撤销' }).first();
      const hasUndo = await undo.isVisible().catch(() => false);
      check('③c 那条提示上挂着「撤销」', hasUndo, '没有撤销 = 不可逆的删除没有退路');

      // 8 秒窗口：过了 5 秒还在（能点得到）
      await page.waitForTimeout(5000);
      await page.bringToFront();
      const stillThere = await undo.isVisible().catch(() => false);
      const after5s = await visibleToasts(page);
      check('③d 5 秒后撤销仍然点得到（8 秒窗口）', stillThere,
        `5 秒后可见：${stillThere}；提示：${JSON.stringify(after5s)}`);
      check('③e 5 秒后提示还挂着（没被提前清掉）', after5s.length === 1,
        `实际 ${after5s.length} 条`);
      await page.screenshot({ path: join(OUT_DIR, '05-undo-still-there.png') });

      if (hasUndo) {
        await undo.click();
        await page.waitForTimeout(2500);
        const titles = await tabTitlesOf(page, '未锁定会话甲');
        const alphaAt = titles.findIndex(t => t.includes('Alpha'));
        const betaAt = titles.findIndex(t => t.includes('Beta'));
        check('③f 撤销后那条记录回来了', alphaAt >= 0, `实际顺序：${JSON.stringify(titles)}`);
        check('③g 撤销后记录回到**原来的位置**（不是追加到末尾）',
          alphaAt >= 0 && betaAt >= 0 && alphaAt < betaAt,
          `实际顺序：${JSON.stringify(titles)}`);
        await page.screenshot({ path: join(OUT_DIR, '06-after-undo.png') });
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // ④ 未锁定整组恢复 ⇒ 一条中性提示 + 撤销 + 撤销后会话回来
    // ══════════════════════════════════════════════════════════════════
    {
      await clearToasts(page);
      await startToastRecorder(page);
      await cardOf(page, '未锁定会话乙')
        .locator('button[aria-label^="在当前窗口打开整个会话"]')
        .first()
        .click();
      const shown4 = await waitForToast(page);
      const recorded4 = await stopToastRecorder(page);
      await page.bringToFront();
      await page.screenshot({ path: join(OUT_DIR, '07-unlocked-group-restore.png') });
      check('④a 未锁定整组恢复 ⇒ 恰好一条提示',
        shown4.length === 1 && recorded4.length === 1,
        `当前可见 ${shown4.length} 条 / 全程出现过 ${recorded4.length} 条：${JSON.stringify(recorded4)}`);
      if (shown4.length === 1) {
        check('④b 那条提示是中性的', isNeutralToast(shown4[0]),
          `实际：${JSON.stringify(shown4[0])}`);
        check('④c 那条提示上挂着「撤销」', shown4[0].hasUndo,
          `实际：${JSON.stringify(shown4[0])}`);
      }
      const undo = page.locator('button', { hasText: '撤销' }).first();
      const hasUndo = await undo.isVisible().catch(() => false);
      check('④d 那条提示上挂着「撤销」（页面可见）', hasUndo,
        '没有撤销 = 不可逆的删除没有退路');
      if (hasUndo) {
        await undo.click();
        await page.waitForTimeout(2500);
        const names = await visibleGroupNames(page);
        check('④e 撤销后整条会话回到列表',
          names.some(n => n.includes('未锁定会话乙')), `实际列表：${JSON.stringify(names)}`);
        await page.screenshot({ path: join(OUT_DIR, '08-after-undo-group.png') });
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // ⑥ 打不开的地址（file://）⇒ 必须有错误提示「已保留在会话中」
    //
    // ⚠️ 排在 ⑤ **之前**：批量恢复会把命中的那些**消费掉**（含打不开的那条
    // —— 未锁定会话里打不开的地址也不再保存在列表中）⇒ ⑤ 跑完这条就没了。
    // ══════════════════════════════════════════════════════════════════
    {
      await clearToasts(page);
      await startToastRecorder(page);
      const link = page.locator('a.tab-item-title[aria-label^="本机文件"]').first();
      const found = await link.count();
      check('⑥a 打不开的地址在列表里', found > 0, 'file:// 那条没渲染出来');
      if (found > 0) {
        await link.click();
        const toasts = await waitForToast(page);
        const recorded6 = await stopToastRecorder(page);
        await page.bringToFront();
        await page.screenshot({ path: join(OUT_DIR, '10-unopenable-error.png') });
        check('⑥b 打不开的地址 ⇒ 有提示', toasts.length >= 1 && recorded6.length >= 1,
          `当前可见 ${toasts.length} 条 / 全程出现过 ${recorded6.length} 条（点开 file:// 必须明说「打不开」）`);
        if (toasts.length >= 1) {
          check('⑥c 那条提示说清「已保留在会话中」',
            toasts.some(t => t.text.includes('已保留在会话中')),
            `实际：${JSON.stringify(toasts.map(t => t.text))}`);
          check('⑥d 那条提示是错误档（不是中性提示）',
            toasts.some(t => t.label === '出错' && t.isDangerAccent),
            `实际：${JSON.stringify(toasts.map(t => ({ label: t.label, accent: t.accent })))}`);
        }
        const titles = await tabTitlesOf(page, '文件会话丁');
        check('⑥e 那条记录还在（没被吃掉）', titles.length === 1,
          `实际 ${titles.length} 行：${JSON.stringify(titles)}`);
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // ⑤ 搜索页批量恢复 ⇒ 一条提示，四笔账的数字都在
    // ══════════════════════════════════════════════════════════════════
    {
      await clearToasts(page);
      const search = page.locator('input[aria-label="搜索会话名、标签标题或 URL"]');
      await search.fill('页面');
      await page.waitForTimeout(1500);
      const bulk = page.locator('button[aria-label^="在新窗口恢复所有匹配标签页"]').first();
      const hasBulk = await bulk.isVisible().catch(() => false);
      check('⑤a 搜索页有「恢复所有匹配标签页」入口', hasBulk, '批量恢复入口不见了');
      if (hasBulk) {
        await bulk.hover().catch(() => {});
        await bulk.click();
        await page.waitForTimeout(800);
        const confirm = page.locator('button', { hasText: '全部恢复' }).first();
        const hasConfirm = await confirm.isVisible().catch(() => false);
        check('⑤b 批量恢复有确认框', hasConfirm, '确认框没出来');
        if (hasConfirm) {
          await startToastRecorder(page);
          await confirm.click();
          const toasts = await waitForToast(page);
          const recorded5 = await stopToastRecorder(page);
          await page.bringToFront();
          await page.screenshot({ path: join(OUT_DIR, '09-batch-restore.png') });
          check('⑤c 批量恢复 ⇒ 恰好一条提示',
            toasts.length === 1 && recorded5.length === 1,
            `当前可见 ${toasts.length} 条 / 全程出现过 ${recorded5.length} 条：${JSON.stringify(recorded5)}`);
          if (toasts.length === 1) {
            const t = toasts[0].text;
            check('⑤d 四笔账的数字都在（恢复了几个 / 移除了几个 / 留下几个 / 打不开几个）',
              /已恢复 \d+ 个标签页/.test(t) &&
                (/已从所属会话移除 \d+ 个标签页/.test(t) ||
                  /没有任何一条被从会话中移除/.test(t)) &&
                /\d+ 个在已锁定的会话里/.test(t) &&
                /\d+ 个在当前设备无法打开/.test(t),
              `实际：${t}`);
            // ⚠️ 这一条**不是**中性提示：命中里有打不开的 ⇒ 这是**部分失败**
            // ⇒ 走错误通道（「失败是事件」）。这是本仓既有的口径
            // （`unopenable > 0 ? { type: 'error' }`），Task 3 没动它。
            check('⑤e 有打不开的 ⇒ 那条提示走**错误**通道（失败是事件）',
              toasts[0].label === '出错' && toasts[0].isDangerAccent,
              `实际：${JSON.stringify({ label: toasts[0].label, accent: toasts[0].accent })}`);
            check('⑤e-2 那条提示上仍然挂着「撤销」（部分成功也是一次消费）',
              toasts[0].hasUndo, `实际：${JSON.stringify(toasts[0])}`);
          }
        }
      }
      await search.fill('');
      await page.waitForTimeout(1000);

      // ⑤f：再来一次**没有打不开的**批量恢复（只命中锁定会话里的一条）
      // ⇒ 纯成功 ⇒ 那条提示必须是**中性**的（info 外观、无「完成」药丸、无对勾）。
      await clearToasts(page);
      await search.fill('Gamma');
      await page.waitForTimeout(1500);
      const bulk2 = page.locator('button[aria-label^="在新窗口恢复所有匹配标签页"]').first();
      if (await bulk2.isVisible().catch(() => false)) {
        await bulk2.hover().catch(() => {});
        await bulk2.click();
        await page.waitForTimeout(800);
        const confirm2 = page.locator('button', { hasText: '全部恢复' }).first();
        await confirm2.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        await startToastRecorder(page);
        await confirm2.click().catch(() => {});
        const toasts2 = await waitForToast(page);
        const recorded5f = await stopToastRecorder(page);
        check('⑤f 纯成功的批量恢复 ⇒ 恰好一条提示',
          toasts2.length === 1 && recorded5f.length === 1,
          `当前可见 ${toasts2.length} 条 / 全程出现过 ${recorded5f.length} 条：${JSON.stringify(recorded5f)}`);
        if (toasts2.length === 1) {
          check('⑤g 纯成功的批量恢复 ⇒ 那条提示是**中性**的（info 外观）',
            isNeutralToast(toasts2[0]), `实际：${JSON.stringify(toasts2[0])}`);
          check('⑤h 纯成功的批量恢复 ⇒ 说清「没有任何一条被移除」',
            /没有任何一条被从会话中移除/.test(toasts2[0].text) &&
              /另有 1 个在已锁定的会话里/.test(toasts2[0].text),
            `实际：${toasts2[0].text}`);
        }
        await page.screenshot({ path: join(OUT_DIR, '11-batch-restore-clean.png') });
      }
      await search.fill('');
      await page.waitForTimeout(800);
    }

    if (consoleErrors.length) {
      problems.push(`控制台报错 ${consoleErrors.length} 条：${consoleErrors.slice(0, 3).join(' | ')}`);
    }

    writeFileSync(join(OUT_DIR, 'log.json'), JSON.stringify({ log, problems }, null, 2));
    console.log(JSON.stringify({
      problems,
      passed: log.filter(l => l.ok).length,
      total: log.length,
    }, null, 2));
  } finally {
    await ctx.close();
  }
}

main().catch(err => {
  console.error('验证脚本失败：', err);
  process.exit(1);
});
