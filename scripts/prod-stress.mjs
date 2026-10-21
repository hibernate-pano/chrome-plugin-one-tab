// 大数据量压力测试 —— 「拿得出手」必须过的关。
//
// 一个用了一年的用户会有：50~200 个会话，每个 10~40 个标签。
// 测的是：popup 打开要多快、搜索响应要多快、滚动会不会卡、DOM 会不会爆。
//
// 用法：pnpm build 之后 `node scripts/prod-stress.mjs`

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/prod-stress');
const now = Date.now();
const iso = ms => new Date(ms).toISOString();

const DOMAINS = [
  'github.com', 'arxiv.org', 'docs.google.com', 'news.ycombinator.com', 'stackoverflow.com',
  'developer.mozilla.org', 'figma.com', 'linear.app', 'notion.so', 'mail.google.com',
  'calendar.google.com', 'aws.amazon.com', 'console.aws.amazon.com', 'grafana.example.com',
  'jira.example.com', 'confluence.example.com',
];
const TITLES = [
  'Pull requests · project/repo', 'Attention Is All You Need', 'V2 执行计划评审 — Google 文档',
  'CRDTs and the cost of consistency | Hacker News', 'How to center a div', 'Design System 2.0',
  'ENG-1234 Fix sync watermark race condition', 'AWS S3 bucket policy reference',
  'Q3 OKR tracking sheet', 'Marketing site — homepage draft', 'TypeScript 5.6 release notes',
  'Chrome Extension Manifest V3 — Migration guide', 'Grafana dashboard / api latency',
];

function buildGroups(groupCount, tabsPerGroup) {
  const groups = [];
  for (let g = 0; g < groupCount; g++) {
    const id = crypto.randomUUID();
    const tabs = [];
    for (let t = 0; t < tabsPerGroup; t++) {
      const dom = DOMAINS[(g * 7 + t) % DOMAINS.length];
      tabs.push({
        id: crypto.randomUUID(),
        url: `https://${dom}/path/${g}/${t}?q=${t}`,
        title: `${TITLES[(g * 3 + t) % TITLES.length]} #${g}.${t}`,
        favicon: `https://www.google.com/s2/favicons?domain=${dom}&sz=32`,
        createdAt: iso(now - g * 3600e3),
        lastAccessed: iso(now - g * 3600e3),
        group_id: id,
        pinned: false,
      });
    }
    groups.push({
      id,
      name: `会话 ${g + 1}`,
      notes: '',
      isFavorite: false, isLocked: false, isDeleted: false,
      tabs,
      createdAt: iso(now - g * 3600e3),
      updatedAt: iso(now - (g + 0.5) * 3600e3),
      version: 1, displayOrder: g,
      lastOp: { d: 'demo', s: g },
    });
  }
  return groups;
}

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
        tx.onerror = () => { db.close(); rej(tx.error); };
      };
    });
  }, data);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-stress-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--lang=zh-CN'],
  });
  const results = {};
  try {
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) { sw = ctx.serviceWorkers()[0] ?? null; if (!sw) await new Promise(r => setTimeout(r, 500)); }
    const id = new URL(sw.url()).host;

    for (const [gc, tpg] of [[50, 20], [150, 25], [400, 20]]) {
      const label = `${gc}会话×${tpg}标签`;
      console.log(`\n════ 场景：${label} ════`);
      const page = await ctx.newPage();
      await page.setViewportSize({ width: 400, height: 600 });
      await page.goto(`chrome-extension://${id}/src/popup/index.html`);
      const skip = page.locator('button[aria-label="跳过引导"]');
      await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
      await inject(page, buildGroups(gc, tpg));
      const t0 = Date.now();
      await page.reload();
      await page.waitForSelector('text=会话 1', { timeout: 60000 });
      await page.waitForTimeout(800);
      const openMs = Date.now() - t0;
      console.log(`  打开到首屏可见: ${openMs}ms`);

      const dom = await page.evaluate(() => ({
        nodes: document.getElementsByTagName('*').length,
        cards: document.querySelectorAll('.tab-group-card').length,
        tabRows: document.querySelectorAll('[class*="tab-item"]').length,
        placeholders: document.querySelectorAll('[data-lazy-placeholder="true"]').length,
        docH: document.documentElement.scrollHeight,
      }));
      console.log('  DOM:', JSON.stringify(dom));

      // 搜索响应
      const search = page.locator('input[placeholder*="搜索"]').first();
      const t1 = Date.now();
      await search.click();
      await search.fill(process.env.STRESS_Q || 'watermark');
      await page.waitForFunction(() => {
        const el = document.querySelector('[aria-label^="搜索结果"]');
        return el && /共 \d+ 个匹配会话/.test(el.getAttribute('aria-label') || '');
      }, { timeout: 15000 }).catch(() => {});
      const searchMs = Date.now() - t1;
      console.log(`  搜索响应: ${searchMs}ms`);
      await page.screenshot({ path: join(OUT_DIR, `search-${gc}x${tpg}.png`) });

      // 搜索态 DOM
      const searchDom = await page.evaluate(() => ({
        nodes: document.getElementsByTagName('*').length,
        cards: document.querySelectorAll('.tab-group-card').length,
      }));
      console.log('  搜索态 DOM:', JSON.stringify(searchDom));

      // 滚动流畅度
      await search.fill('');
      await page.waitForTimeout(600);
      const scroll = await page.evaluate(async () => {
        // popup 的滚动容器是文档本身，不是 <main>
        const se = document.scrollingElement || document.documentElement;
        const t = performance.now();
        let frames = 0, maxGap = 0, last = t;
        const step = () => {
          const now = performance.now();
          maxGap = Math.max(maxGap, now - last);
          last = now;
          se.scrollTop += 400;
          frames++;
          if (se.scrollTop < se.scrollHeight - 800 && frames < 150) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
        await new Promise(r => setTimeout(r, 2500));
        return {
          frames,
          elapsed: Math.round(performance.now() - t),
          scrollTop: Math.round(se.scrollTop),
          scrollH: Math.round(se.scrollHeight),
          maxFrameGapMs: Math.round(maxGap),
          docNodes: document.getElementsByTagName('*').length,
          cards: document.querySelectorAll('.tab-group-card').length,
          tabRows: document.querySelectorAll('[class*="tab-item"]').length,
        };
      });
      console.log('  滚动:', JSON.stringify(scroll));

      results[`${gc}x${tpg}`] = { openMs, dom, searchMs, searchDom, scroll };
      await page.screenshot({ path: join(OUT_DIR, `list-${gc}x${tpg}.png`) });
      await page.close();
    }
  } finally {
    await ctx.close();
  }
  console.log('\n=== 汇总 ===');
  console.log(JSON.stringify(results, null, 1));
}

main().catch(err => { console.error(err); process.exit(1); });
