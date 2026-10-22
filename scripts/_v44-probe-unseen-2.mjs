// 专项探针：判据⑧「用户看不见 ⇒ 暂停 ⇒ 切回来还能撤销」的失败模式。
//
// 只跑 ⑧ 这一段（整个脚本 ~2.5 分钟，这里 ~30 秒），并且每一帧都记：
//   · 提示在不在 DOM 里、有几条
//   · 页面有没有被重新加载过（打标记）
//   · hasFocus / visibility / activeElement
//   · 进度条的 play-state 与 scale
//
// 目的：把「切回来之后提示没了」这件事的**机制**钉死（是倒计时到期？是组件
// 被卸载？是页面被重载？是量到了别的提示？）。

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/_v44-unseen-2');
const now = Date.now();
const iso = ms => new Date(ms).toISOString();

const mkGroup = () => ({
  id: crypto.randomUUID(),
  name: '探针会话',
  notes: '',
  isFavorite: false,
  isLocked: false,
  isDeleted: false,
  tabs: [
    ['https://example.com/alpha', 'Alpha 页面'],
    ['https://example.com/beta', 'Beta 页面'],
  ].map(([url, title]) => ({
    id: crypto.randomUUID(), url, title, favicon: '',
    createdAt: iso(now - 3600e3), lastAccessed: iso(now - 3600e3),
    group_id: 'x', pinned: false,
  })),
  createdAt: iso(now - 7200e3), updatedAt: iso(now - 3600e3),
  version: 1, displayOrder: 1, lastOp: { d: 'probe', s: 1 },
});

async function inject(page, data) {
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

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-unseen2-'));
  const args = [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    '--no-first-run',
    '--lang=zh-CN',
  ];
  const opts = { headless: false, args, viewport: { width: 1440, height: 900 } };
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(profile, opts);
  } catch (err) {
    if (!/Executable doesn't exist/i.test(String(err?.message ?? err))) throw err;
    ctx = await chromium.launchPersistentContext(profile, { ...opts, channel: 'chrome' });
  }
  const timeline = [];
  try {
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await new Promise(r => setTimeout(r, 500));
    }
    const id = new URL(sw.url()).host;
    const page = await ctx.newPage();
    page.on('console', m => { if (m.text().startsWith('[CD]')) console.log('  ', m.text()); });
    await page.goto(`chrome-extension://${id}/src/popup/index.html`);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
    await inject(page, [mkGroup()]);
    await page.reload();
    await page.waitForSelector('text=探针会话', { timeout: 15000 });
    await page.waitForTimeout(1200);

    // 打标记：页面一旦被重载，标记就没了。
    await page.evaluate(() => { window.__mark = 'alive'; });
    await page.locator('text=Alpha 页面').first().click();
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      const el = document.activeElement;
      if (el && el !== document.body && typeof el.blur === 'function') el.blur();
      if (document.activeElement === document.body) document.body.focus();
    });
    await page.mouse.move(10, 10);
    await page.waitForTimeout(1500);

    const sample = async (label) => {
      const s = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('div.pointer-events-auto')];
        const lives = [...document.querySelectorAll('[role="alert"], [role="status"]')];
        const card = cards[0];
        const progress = card ? card.querySelector('div[style*="tapstack-toast-progress"]') : null;
        const active = document.activeElement;
        return {
          mark: window.__mark ?? 'RELOADED',
          cards: cards.length,
          lives: lives.length,
          liveTexts: lives.map(l => (l.innerText || '').replace(/\s+/g, ' ').slice(0, 40)),
          cardText: card ? (card.innerText || '').replace(/\s+/g, ' ').slice(0, 60) : null,
          playState: progress ? getComputedStyle(progress).animationPlayState : null,
          scale: progress ? getComputedStyle(progress).transform : null,
          hasFocus: document.hasFocus(),
          visibility: document.visibilityState,
          active: active ? `${active.tagName}` : 'none',
          href: location.href.slice(-24),
        };
      });
      timeline.push({ label, ...s });
      return s;
    };

    await sample('切走前');
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    const other = await ctx.newPage();
    await other.goto('about:blank');
    await other.bringToFront();
    await page.waitForTimeout(600);
    await sample('切走后 0.6s');
    await page.waitForTimeout(3000);
    await sample('切走后 3.6s');
    await page.waitForTimeout(6000);
    await sample('切走后 9.6s');
    await page.bringToFront();
    for (let i = 1; i <= 12; i++) {
      await page.waitForTimeout(250);
      await sample(`切回后 ${i * 250}ms`);
    }
    await other.close();
  } finally {
    await ctx.close();
  }
  writeFileSync(join(OUT_DIR, 'timeline.json'), JSON.stringify(timeline, null, 2));
  for (const row of timeline) {
    console.log(
      `${row.label.padEnd(16)} mark=${row.mark} cards=${row.cards} lives=${row.lives} ` +
      `play=${row.playState} scale=${row.scale} focus=${row.hasFocus} vis=${row.visibility} ` +
      `active=${row.active} text=${JSON.stringify(row.cardText)}`,
    );
  }
}

main().catch(err => { console.error(err); process.exit(1); });
