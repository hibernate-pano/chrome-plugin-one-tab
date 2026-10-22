// 负责人亲手点一遍 —— 记录每一步用户**看得见**的反馈。
//
// 目的：验证「按了键有没有反应」「说得清发生了什么」。
// 产出：outputs/lead-interact/*.png + 一份反馈清单 JSON。

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/lead-interact');
const now = Date.now();
const iso = ms => new Date(ms).toISOString();

function tab(groupId, url, title, ageHours) {
  const domain = new URL(url).hostname;
  return {
    id: crypto.randomUUID(), url, title,
    favicon: `https://www.google.com/s2/favicons?domain=${domain}&sz=32`,
    createdAt: iso(now - ageHours * 3600e3), lastAccessed: iso(now - ageHours * 3600e3),
    group_id: groupId, pinned: false,
  };
}
function group(name, { notes, locked = false, order, ageHours, tabs }) {
  const id = crypto.randomUUID();
  return {
    id, name, notes, isFavorite: false, isLocked: locked, isDeleted: false,
    tabs: tabs.map(([url, title, age]) => tab(id, url, title, age ?? ageHours)),
    createdAt: iso(now - ageHours * 3600e3), updatedAt: iso(now - (ageHours - 0.5) * 3600e3),
    version: 1, displayOrder: order, lastOp: { d: 'demo-device', s: order },
  };
}
const groups = [
  group('V2 同步架构评审', { notes: 'P1 对账观察期结论周五同步', order: 1, ageHours: 2, tabs: [
    ['https://github.com/a/b/pulls', 'Pull requests · a/b'],
    ['https://docs.google.com/document/d/x/edit', 'V2 执行计划评审 — Google 文档'],
  ]}),
  group('React 19 升级 PR', { order: 2, ageHours: 6, tabs: [
    ['https://github.com/facebook/react/releases', 'React Releases · facebook/react'],
  ]}),
  group('面试准备（进行中）', { notes: '周五下午 3 点，二面', locked: true, order: 3, ageHours: 40, tabs: [
    ['https://github.com/donnemartin/system-design-primer', 'system-design-primer'],
  ]}),
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

/** 采集页面上「此刻用户看得见的」所有文字 */
async function visibleText(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[role="alert"], [role="status"], [role="dialog"], .toast, [class*="toast"], [class*="notice"]')) {
      const t = (el.innerText || '').trim();
      if (t) out.push({ kind: el.getAttribute('role') || el.className.toString().slice(0, 40), text: t.slice(0, 200) });
    }
    return out;
  });
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-lead-i-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--lang=zh-CN'],
    viewport: { width: 1440, height: 900 },
  });
  const log = [];
  try {
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) { sw = ctx.serviceWorkers()[0] ?? null; if (!sw) await new Promise(r => setTimeout(r, 500)); }
    const id = new URL(sw.url()).host;
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${id}/src/popup/index.html`);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
    await injectGroups(page, groups);
    await page.reload();
    await page.waitForSelector('text=V2 同步架构评审', { timeout: 15000 });
    await page.waitForTimeout(1200);

    // ── 1. 点开单个标签（= 消费该条）──
    const firstTabTitle = page.locator('text=Pull requests · a/b').first();
    await firstTabTitle.click();
    await page.waitForTimeout(1500);
    log.push({ step: '点开单个标签', visible: await visibleText(page) });
    await page.screenshot({ path: join(OUT_DIR, '01-after-open-tab.png') });

    // ── 2. 恢复整个会话 ──
    await page.locator('button[aria-label^="在新窗口恢复整个会话"]').first().click();
    await page.waitForTimeout(1800);
    log.push({ step: '恢复整个会话', visible: await visibleText(page) });
    await page.screenshot({ path: join(OUT_DIR, '02-after-restore.png') });

    // ── 3. 锁定会话后的删除（应确认并提示已锁定）──
    const lockedGroup = page.locator('[class*="group-header"]').filter({ hasText: '面试准备' }).first();
    await lockedGroup.waitFor({ timeout: 5000 }).catch(() => {});
    const delBtn = page.locator('button[aria-label="删除会话"]').last();
    await delBtn.click();
    await page.waitForTimeout(900);
    log.push({ step: '删除（锁定会话）', visible: await visibleText(page) });
    await page.screenshot({ path: join(OUT_DIR, '03-delete-locked-confirm.png') });
    // 关掉弹窗
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);

    // ── 4. 重命名 ──
    const editBtn = page.locator('button[aria-label="重命名会话"]').first();
    await editBtn.click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT_DIR, '04-rename.png') });
    log.push({ step: '重命名（编辑态）', visible: await visibleText(page) });
    await page.keyboard.press('Escape').catch(() => {});

    // ── 5. 锁定切换 ──
    const lockBtn = page.locator('button[aria-label="锁定会话"]').first();
    await lockBtn.click();
    await page.waitForTimeout(1200);
    log.push({ step: '锁定会话', visible: await visibleText(page) });
    await page.screenshot({ path: join(OUT_DIR, '05-after-lock.png') });

    // ── 6. 搜索无结果 ──
    const search = page.locator('input[placeholder*="搜索"]').first();
    await search.fill('zzz不存在的关键词zzz');
    await page.waitForTimeout(1200);
    log.push({ step: '搜索无结果', visible: await visibleText(page) });
    await page.screenshot({ path: join(OUT_DIR, '06-search-empty.png') });

    // ── 7. 键盘可达：Tab 走一遍，看焦点落在哪 ──
    await search.fill('');
    await page.waitForTimeout(600);
    await page.keyboard.press('Escape').catch(() => {});
    await page.evaluate(() => document.body.focus());
    const focusOrder = [];
    for (let i = 0; i < 22; i++) {
      await page.keyboard.press('Tab');
      focusOrder.push(await page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return 'null';
        return `${el.tagName.toLowerCase()}:${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 28)}`;
      }));
    }
    log.push({ step: 'Tab 焦点序列', focusOrder });

    writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(log, null, 1));
    console.log(JSON.stringify(log, null, 1));
  } finally {
    await ctx.close();
  }
}
main().catch(e => { console.error('失败:', e); process.exit(1); });
