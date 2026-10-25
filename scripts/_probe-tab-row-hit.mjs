/**
 * 收紧后的交互探针（不点标题 —— 点标题会「消费」那条标签，探针不许改数据）。
 *
 * 量的是：删除键的命中区是否还在自己那一行内、标题链接是否撑满了行高
 * （⇒ 整行可点）、分隔线是否还是 1px、拖拽环是否还在。
 *
 * 用法：pnpm build 之后 node scripts/_probe-tab-row-hit.mjs
 */
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const now = Date.now();
const iso = ms => new Date(ms).toISOString();

function tab(groupId, url, title) {
  return {
    id: crypto.randomUUID(), url, title, favicon: '',
    createdAt: iso(now - 3600e3), lastAccessed: iso(now - 3600e3),
    group_id: groupId, pinned: false,
  };
}

const id = crypto.randomUUID();
const groups = [{
  id, name: '探针会话', notes: '', isFavorite: false, isLocked: false, isDeleted: false,
  tabs: [
    ['https://example.com/one', 'One'],
    ['https://example.com/two', 'Two'],
    ['https://example.com/three', 'Three'],
  ].map(([url, title]) => tab(id, url, title)),
  createdAt: iso(now - 3600e3), updatedAt: iso(now - 1800e3),
  version: 1, displayOrder: 1, lastOp: { d: 'probe', s: 1 },
}];

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-probe-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--lang=zh-CN'],
  });
  try {
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await new Promise(r => setTimeout(r, 500));
    }
    if (!sw) throw new Error('15s 内未找到 service worker');
    const extId = new URL(sw.url()).host;

    const seed = await ctx.newPage();
    await seed.goto(`chrome-extension://${extId}/src/popup/index.html`);
    await seed.evaluate(async rows => {
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
    }, groups);
    await seed.close();

    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await page.goto(`chrome-extension://${extId}/src/popup/index.html`);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
    await page.waitForSelector('text=探针会话', { timeout: 15000 });
    await page.mouse.move(2, 2);
    await page.waitForTimeout(600);

    const report = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.tab-item')];
      const first = rows[0];
      const rowRect = first.getBoundingClientRect();
      const btn = first.querySelector('.tab-item-actions button');
      const btnRect = btn.getBoundingClientRect();
      const link = first.querySelector('.tab-item-title');
      const linkRect = link.getBoundingClientRect();
      const cs = getComputedStyle(first);
      // 命中测试：删除键中心命中的必须就是删除键自己
      const hit = document.elementFromPoint(btnRect.left + btnRect.width / 2, btnRect.top + btnRect.height / 2);
      return {
        rowH: +rowRect.height.toFixed(2),
        rowTop: +rowRect.top.toFixed(2),
        rowBottom: +rowRect.bottom.toFixed(2),
        btn: {
          top: +btnRect.top.toFixed(2),
          bottom: +btnRect.bottom.toFixed(2),
          h: +btnRect.height.toFixed(2),
          w: +btnRect.width.toFixed(2),
          insideRow: btnRect.top >= rowRect.top - 0.01 && btnRect.bottom <= rowRect.bottom + 0.01,
        },
        link: {
          h: +linkRect.height.toFixed(2),
          coversRowHeight: linkRect.height >= rowRect.height - 1,
          text: link.textContent.trim(),
        },
        borderBottom: cs.borderBottomWidth,
        borderBottomColor: cs.borderBottomColor,
        pointerEventsAtRest: getComputedStyle(first.querySelector('.tab-item-actions')).pointerEvents,
      };
    });

    // 悬停后删除键可见且可点
    const row = page.locator('.tab-item').first();
    await row.hover();
    await page.waitForTimeout(300);
    const hovered = await page.evaluate(() => {
      const actions = document.querySelector('.tab-item .tab-item-actions');
      const cs = getComputedStyle(actions);
      return { opacity: cs.opacity, pointerEvents: cs.pointerEvents };
    });

    // 拖拽反馈：6 套主题里每一套都必须**看得见**（环 / 虚线框 / 边框 任一）
    const dragging = {};
    for (const theme of ['legacy', 'creamy', 'prism', 'apple', 'chrome', 'claude']) {
      await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
      await page.waitForTimeout(250);
      await page.evaluate(() => document.querySelector('.tab-item').classList.add('dragging'));
      await page.waitForTimeout(350); // 等过渡走完（box-shadow 从 none 起步是离散过渡）
      dragging[theme] = await page.evaluate(() => {
        const el = document.querySelector('.tab-item');
        const cs = getComputedStyle(el);
        const out = {
          shadow: cs.boxShadow,
          outline: `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}`,
          borderColor: cs.borderTopColor,
          visible:
            (cs.boxShadow !== 'none' && cs.boxShadow !== '') ||
            (parseFloat(cs.outlineWidth) > 0 && cs.outlineStyle !== 'none') ||
            (cs.borderTopWidth !== '0px' && !/transparent|rgba\(0, 0, 0, 0\)/.test(cs.borderTopColor)),
        };
        el.classList.remove('dragging');
        return out;
      });
    }

    console.log(JSON.stringify({ report, hovered, dragging }, null, 2));
    await page.close();
  } finally {
    await ctx.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
