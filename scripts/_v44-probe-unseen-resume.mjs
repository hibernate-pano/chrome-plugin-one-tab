// 探针：切回管理页之后，倒计时到底续走了没有？（2026-10-22）
//
// 判据⑧ 的实测里出现了一处自相矛盾：切回管理页 2 秒后，
// 进度条的 transform **动了**（0.6679 → 0.5502，说明续走了约 0.94 秒），
// 但同一时刻的 animation-play-state 却是 'paused'。
// ⇒ 要弄清楚「续走了」之后又被谁按住了。
//
// 本探针在页面里挂上所有可能的事件（focus/blur/visibilitychange/
// focusin/focusout/mouseenter/mouseleave）与动画状态的时间线。

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/_v44-unseen-resume');
const now = Date.now();
const iso = ms => new Date(ms).toISOString();

const group = (id, name, tabs) => ({
  id,
  name,
  notes: '',
  isFavorite: false,
  isLocked: false,
  isDeleted: false,
  tabs: tabs.map(([url, title]) => ({
    id: crypto.randomUUID(),
    url,
    title,
    favicon: '',
    createdAt: iso(now - 3600e3),
    lastAccessed: iso(now - 3600e3),
    group_id: id,
    pinned: false,
  })),
  createdAt: iso(now - 7200e3),
  updatedAt: iso(now - 3600e3),
  version: 1,
  displayOrder: 1,
  lastOp: { d: 'probe', s: 1 },
});

const groups = [group(crypto.randomUUID(), '探针会话', [['https://example.com/alpha', 'Alpha 页面']])];

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

/** 在页面里挂事件时间线。 */
async function installProbe(page) {
  await page.evaluate(() => {
    window.__events = [];
    const t0 = Date.now();
    const push = (kind, detail) => window.__events.push({ t: Date.now() - t0, kind, detail });
    for (const kind of ['focus', 'blur']) {
      window.addEventListener(kind, () => push(`window.${kind}`, { hasFocus: document.hasFocus() }), true);
    }
    for (const kind of ['focusin', 'focusout', 'mouseenter', 'mouseleave', 'mouseover']) {
      document.addEventListener(kind, e => {
        const el = e.target;
        push(`document.${kind}`, {
          tag: el?.tagName,
          label: (el?.getAttribute?.('aria-label') || el?.textContent || '').trim().slice(0, 24),
          related: (e.relatedTarget?.textContent || '').trim().slice(0, 24),
        });
      }, true);
    }
    document.addEventListener('visibilitychange', () => push('visibilitychange', {
      state: document.visibilityState,
    }));
    window.__sample = () => {
      const live = document.querySelector('[role="alert"], [role="status"]');
      const inner = live ? live.querySelector('div.pointer-events-auto') : null;
      const progress = inner ? inner.querySelector('div[style*="tapstack-toast-progress"]') : null;
      const active = document.activeElement;
      return {
        hasFocus: document.hasFocus(),
        visibility: document.visibilityState,
        active: active ? `${active.tagName}:${(active.getAttribute('aria-label') || active.textContent || '').trim().slice(0, 18)}` : 'none',
        playState: progress ? getComputedStyle(progress).animationPlayState : null,
        scale: progress ? getComputedStyle(progress).transform : null,
        present: Boolean(inner),
      };
    };
  });
}

const samples = (page) => page.evaluate(() => window.__sample());
const events = (page) => page.evaluate(() => window.__events);

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-unseen-'));
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
  const log = [];
  try {
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await new Promise(r => setTimeout(r, 500));
    }
    const id = new URL(sw.url()).host;
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${id}/src/popup/index.html`);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
    await inject(page, groups);
    await page.reload();
    await page.waitForSelector('text=探针会话', { timeout: 15000 });
    await page.waitForTimeout(1200);
    await installProbe(page);

    await page.locator('text=Alpha 页面').first().click();
    await page.waitForTimeout(600);
    // 焦点挪出提示、鼠标挪开。
    await page.evaluate(() => {
      const el = document.activeElement;
      if (el && el !== document.body && typeof el.blur === 'function') el.blur();
      if (document.activeElement === document.body) document.body.focus();
    });
    await page.mouse.move(10, 10);
    await page.waitForTimeout(1500);
    log.push({ at: '切走前', s: await samples(page) });

    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    const other = await ctx.newPage();
    await other.goto('about:blank');
    await other.bringToFront();
    await page.waitForTimeout(800);
    log.push({ at: '切走后 0.8s', s: await samples(page) });
    await page.waitForTimeout(3000);
    log.push({ at: '切走后 3.8s', s: await samples(page) });

    await page.bringToFront();
    for (const ms of [100, 400, 800, 1500, 2500]) {
      await page.waitForTimeout(ms === 100 ? 100 : ms - (ms === 400 ? 100 : ms === 800 ? 400 : ms === 1500 ? 800 : 1500));
      log.push({ at: `切回后 ${ms}ms`, s: await samples(page) });
    }
    log.push({ at: '事件时间线', events: await events(page) });
    await other.close();
  } finally {
    await ctx.close();
  }
  writeFileSync(join(OUT_DIR, 'timeline.json'), JSON.stringify(log, null, 2));
  for (const row of log) {
    console.log(row.at, JSON.stringify(row.s ?? row.events));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
