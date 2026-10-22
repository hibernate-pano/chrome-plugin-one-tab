// 真机验证：「恢复即消费」的撤销（P0-4）。
//
// 为什么要真机：这条链路由 **界面 → toast 动作按钮 → Redux thunk → SW 的
// restoreConsumed 分支 → storage 的撤回队列** 五层组成。tsc 与 eslint 看不见
// 「按钮没渲染」「点了没反应」「SW 拒收新 op」这三类缺陷 —— 它们只会在真实
// 浏览器里出现（本仓同类教训见 memory: SW 启动即崩这一类缺陷）。
//
// 产出：outputs/lead-verify-undo/*.png + 一份逐步反馈 JSON。

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/lead-verify-undo');
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
    lastOp: { d: 'verify-device', s: 1 },
  };
}

const groups = [
  group('撤销验证会话', [
    ['https://example.com/alpha', 'Alpha 页面'],
    ['https://example.com/beta', 'Beta 页面'],
  ]),
  group('锁定不消费会话', [['https://example.com/gamma', 'Gamma 页面']], { locked: true }),
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

/** 采集页面上「此刻用户看得见的」所有文字（含 toast 里的动作按钮）。 */
async function visibleText(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[role="alert"], [role="status"], [role="dialog"]')) {
      const t = (el.innerText || '').trim();
      if (t) out.push(t.replace(/\s+/g, ' ').slice(0, 220));
    }
    return out;
  });
}

/** 列表页当前可见的会话名。 */
async function visibleGroupNames(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[class*="group-name"], [class*="group-header"]')]
      .map(el => (el.innerText || '').trim().split('\n')[0])
      .filter(Boolean),
  );
}

/**
 * 某张会话卡片（role=region，aria-labelledby 指向它的标题）。
 *
 * ⚠️ 定位必须**按会话名**而不是按「第几个」—— 列表按保存时间排序，
 * 「最后一个」未必是锁定那个（第一版脚本就栽在这里：点到了未锁定那条，
 * 于是「锁定会话不该有撤销」这条断言其实在检查另一个会话）。
 */
function cardOf(page, sessionName) {
  return page.locator('[role="region"]').filter({ hasText: sessionName }).first();
}

/** 某张卡里的标签行标题，按出现顺序。 */
async function tabTitlesOf(page, sessionName) {
  const card = cardOf(page, sessionName);
  return card.evaluate(el =>
    [...el.querySelectorAll('[class*="tab-item"], [class*="tab-title"]')]
      .map(t => (t.innerText || '').trim().split('\n')[0])
      .filter(Boolean),
  );
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-undo-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--lang=zh-CN'],
    viewport: { width: 1440, height: 900 },
  });
  const log = [];
  const problems = [];
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
    await page.waitForSelector('text=撤销验证会话', { timeout: 15000 });
    await page.waitForTimeout(1200);

    // ── 1. 点开单个标签（= 消费该条）→ 提示上必须有「撤销」──
    await page.locator('text=Alpha 页面').first().click();
    await page.waitForTimeout(1200);
    const afterOpen = await visibleText(page);
    log.push({ step: '点开单个标签', visible: afterOpen });
    await page.screenshot({ path: join(OUT_DIR, '01-consume-single-tab.png') });

    const undoBtn = page.locator('button', { hasText: '撤销' }).first();
    const hasUndo = await undoBtn.isVisible().catch(() => false);
    if (!hasUndo) problems.push('消费之后看不到「撤销」按钮 —— 不可逆的操作没有退路');
    // 消费掉的那条标签必须**不在**列表里了（判据看标签行，不看会话名）。
    const titlesAfterConsume = await tabTitlesOf(page, '撤销验证会话');
    if (titlesAfterConsume.some(t => t.includes('Alpha'))) {
      problems.push('消费之后那条标签还在会话里（消费没发生？）');
    }

    // ── 2. 点撤销 → 标签必须回到**原来的位置**──
    if (hasUndo) {
      await undoBtn.click();
      await page.waitForTimeout(1500);
      const afterUndo = await visibleText(page);
      log.push({ step: '撤销消费', visible: afterUndo });
      await page.screenshot({ path: join(OUT_DIR, '02-after-undo.png') });
      const titles = await tabTitlesOf(page, '撤销验证会话');
      if (!titles.some(t => t.includes('Alpha'))) {
        problems.push('点了撤销，那条标签没有回到列表 —— 撤销没生效');
      }
      // 顺序：消费前是 Alpha、Beta；消费掉 Alpha 后剩 Beta；
      // 撤销必须把 Alpha 插回**原位** ⇒ 仍是 Alpha、Beta（不是 Beta、Alpha）
      const alphaAt = titles.findIndex(t => t.includes('Alpha'));
      const betaAt = titles.findIndex(t => t.includes('Beta'));
      if (alphaAt >= 0 && betaAt >= 0 && alphaAt > betaAt) {
        problems.push('撤销后标签顺序变了（Alpha 被追加到了末尾，而不是插回原位）');
      }
    }

    // ── 3. 恢复整个会话（= 消费整条会话）→ 也要有撤销 ──
    await cardOf(page, '撤销验证会话')
      .locator('button[aria-label^="在新窗口恢复整个会话"]')
      .first()
      .click();
    await page.waitForTimeout(1800);
    const afterRestore = await visibleText(page);
    log.push({ step: '恢复整个会话', visible: afterRestore });
    await page.screenshot({ path: join(OUT_DIR, '03-consume-whole-group.png') });

    const undo2 = page.locator('button', { hasText: '撤销' }).first();
    if (!(await undo2.isVisible().catch(() => false))) {
      problems.push('整组恢复之后看不到「撤销」按钮');
    } else {
      await undo2.click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: join(OUT_DIR, '04-after-undo-whole-group.png') });
      const names = await visibleGroupNames(page);
      if (!names.some(n => n.includes('撤销验证会话'))) {
        problems.push('撤销整组消费后，那条会话没有回到列表');
      }
    }

    // ── 4. 锁定会话恢复 ⇒ 从不被消费 ⇒ **不该**有撤销 ──
    // 必须点**锁定那张卡**的按钮（按名字定位，不按「第几个」）。
    await cardOf(page, '锁定不消费会话')
      .locator('button[aria-label^="在新窗口恢复整个会话"]')
      .first()
      .click();
    await page.waitForTimeout(1800);
    const afterLocked = await visibleText(page);
    log.push({ step: '恢复锁定会话', visible: afterLocked });
    await page.screenshot({ path: join(OUT_DIR, '05-locked-restore.png') });
    const undo3 = page.locator('button', { hasText: '撤销' }).first();
    if (await undo3.isVisible().catch(() => false)) {
      problems.push('锁定会话恢复后出现了「撤销」—— 锁定组从不被消费，挂了就是骗人');
    }
    // 锁定会话必须仍在列表里（它从不被消费）
    const namesAfterLocked = await visibleGroupNames(page);
    if (!namesAfterLocked.some(n => n.includes('锁定不消费会话'))) {
      problems.push('锁定会话恢复后从列表消失了 —— 锁定组从不被消费');
    }

    if (consoleErrors.length) {
      problems.push(`控制台报错 ${consoleErrors.length} 条：${consoleErrors.slice(0, 3).join(' | ')}`);
    }

    writeFileSync(join(OUT_DIR, 'log.json'), JSON.stringify({ log, problems }, null, 2));
    console.log(JSON.stringify({ problems, steps: log.map(l => l.step) }, null, 2));
  } finally {
    await ctx.close();
  }
}

main().catch(err => {
  console.error('验证脚本失败：', err);
  process.exit(1);
});
