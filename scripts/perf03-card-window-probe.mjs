#!/usr/bin/env node
/**
 * PERF-03 探针：卡片级窗口化到底有没有真的省掉工作量（真 Chrome + 真产物）。
 *
 * ── 这个脚本量什么 ──────────────────────────────────────────────────────
 *
 * 1. **DOM 节点数**（修复前 1000 张卡全渲染 ⇒ 4.5 万个节点）。
 * 2. **真实渲染的卡片数**（窗口化后应当只有视口附近那几张）。
 * 3. **文档总高**（这是**最关键**的一项）：窗口化前后必须**一致** ——
 *    占位高度与真卡不逐像素一致 ⇒ 滚动条会漂、内容会跳。
 * 4. **长任务**（`PerformanceObserver('longtask')`）：修复前有一条
 *    1.46～1.63 秒的长任务占住主线程。
 *
 * 用法：
 *   pnpm build && node scripts/perf03-card-window-probe.mjs
 *   node scripts/perf03-card-window-probe.mjs --dist /tmp/某次构建/dist
 *
 * ⚠️ 需要**有头** Chrome（扩展的 IndexedDB 注入要走真实扩展上下文）。
 */
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i > -1 && args[i + 1] ? args[i + 1] : fallback;
}

const DIST = resolve(process.cwd(), arg('dist', 'dist'));
const GROUP_COUNT = Number(arg('groups', '1000'));
const TAB_COUNT = Number(arg('tabs', '5'));
const OUT = arg('out', '');

const now = Date.now();
const iso = ms => new Date(ms).toISOString();

function makeGroups(count, tabsPerGroup) {
  const groups = [];
  for (let i = 0; i < count; i++) {
    const id = `g${String(i).padStart(4, '0')}${Math.random().toString(36).slice(2, 10)}`;
    groups.push({
      id,
      name: `会话 ${i}`,
      notes: '',
      isFavorite: false,
      isLocked: false,
      isDeleted: false,
      tabs: Array.from({ length: tabsPerGroup }, (_, k) => ({
        id: `${id}-t${k}`,
        url: `https://example.com/${i}/${k}`,
        title: `标签 ${i}-${k}`,
        favicon: '',
        createdAt: iso(now - i * 1000),
        lastAccessed: iso(now - i * 1000),
        group_id: id,
        pinned: false,
      })),
      createdAt: iso(now - i * 1000),
      updatedAt: iso(now - i * 1000),
      version: 1,
      displayOrder: i,
      lastOp: { d: 'probe', s: i + 1 },
    });
  }
  return groups;
}

async function inject(page, rows) {
  await page.evaluate(async data => {
    await new Promise((res, rej) => {
      const req = indexedDB.open('tabvaultpro', 1);
      req.onerror = () => rej(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ key: 'tab_groups', value: data });
        tx.oncomplete = () => {
          db.close();
          res();
        };
        tx.onerror = () => {
          db.close();
          rej(tx.error);
        };
      };
    });
  }, rows);
}

async function main() {
  const groups = makeGroups(GROUP_COUNT, TAB_COUNT);
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-perf03-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--lang=zh-CN',
    ],
  });

  try {
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await new Promise(r => setTimeout(r, 500));
    }
    if (!sw) throw new Error('15s 内未找到 service worker');
    const id = new URL(sw.url()).host;

    const seed = await ctx.newPage();
    await seed.goto(`chrome-extension://${id}/src/popup/index.html`);
    await inject(seed, groups);
    await seed.close();

    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    // 长任务观测必须在导航**之前**装上。
    await page.addInitScript(() => {
      window.__longTasks = [];
      try {
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            window.__longTasks.push(Math.round(entry.duration));
          }
        }).observe({ entryTypes: ['longtask'] });
      } catch {
        /* 环境不支持就算了 */
      }
    });
    await page.goto(`chrome-extension://${id}/src/popup/index.html`);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip
      .waitFor({ state: 'visible', timeout: 8000 })
      .then(() => skip.click())
      .catch(() => {});
    await page.waitForSelector('.session-list-stack, .session-grid', { timeout: 20000 });
    await page.waitForTimeout(2500);

    const measured = await page.evaluate(() => {
      const list = document.querySelector('.session-list-stack, .session-grid');
      const cards = document.querySelectorAll('.tab-group-card');
      const skeletons = document.querySelectorAll('[data-card-skeleton="true"]');
      const rows = document.querySelectorAll('.tab-item');
      // 逐段量一张**真卡**（近处那张）与一张**占位**：占位必须与真卡逐像素一致。
      const realCard = [...cards].find(c => !c.hasAttribute('data-card-skeleton'));
      const header = realCard?.querySelector('.tab-group-header');
      const track = realCard?.children[1];
      const container = realCard?.querySelector('.tab-group-tabs-container');
      const rect = el => (el ? Math.round(el.getBoundingClientRect().height * 100) / 100 : -1);
      const skeleton = skeletons[0];
      // 一张**远处**的卡（窗口化后是占位；未窗口化时是「行被占位替掉」的卡）
      const farCard = [...cards].filter(c => c !== realCard).pop();
      const farHeader = farCard?.querySelector('.tab-group-header');
      const farTrack = farCard?.children[1];
      const farContainer = farCard?.querySelector('.tab-group-tabs-container');
      const farPlaceholder = farCard?.querySelector('[data-lazy-placeholder="true"]');
      return {
        domNodes: document.querySelectorAll('*').length,
        cards: cards.length,
        skeletons: skeletons.length,
        tabRows: rows.length,
        listHeight: list ? Math.round(list.getBoundingClientRect().height) : -1,
        documentHeight: Math.round(document.documentElement.scrollHeight),
        longTasks: window.__longTasks ?? [],
        cardHeights: (() => {
          const hist = {};
          for (const c of cards) {
            const h = Math.round(c.getBoundingClientRect().height);
            hist[h] = (hist[h] ?? 0) + 1;
          }
          return hist;
        })(),
        cardTops: [...cards].slice(0, 6).map(c => Math.round(c.getBoundingClientRect().top + window.scrollY)),
        cardTopsLater: [...cards].filter((_, i) => i % 50 === 0).map(c => Math.round(c.getBoundingClientRect().top + window.scrollY)),
        lastCardTop: (() => {
          const last = cards[cards.length - 1];
          return last ? Math.round(last.getBoundingClientRect().top + window.scrollY) : -1;
        })(),
        // ── 精确性判据：占位必须与真卡**逐像素一致** ──────────────────────
        // 1) 远卡占位高 vs 近卡真高（差值应为 0）
        // 2) 相邻两张卡的间距（应处处相等 ⇒ 没有「忽然高一块/矮一块」）
        // 3) 列表总高 vs Σ(卡高) + (n-1)×gap（差值应为 0）
        skeletonVsRealDelta: (() => {
          const sk = skeletons[0];
          if (!sk || !realCard) return -1;
          return (
            Math.round(
              (sk.getBoundingClientRect().height - realCard.getBoundingClientRect().height) *
                100
            ) / 100
          );
        })(),
        pitchHistogram: (() => {
          const hist = {};
          for (let i = 1; i < cards.length; i++) {
            const gap = Math.round(
              (cards[i].getBoundingClientRect().top - cards[i - 1].getBoundingClientRect().bottom) *
                100
            ) / 100;
            hist[gap] = (hist[gap] ?? 0) + 1;
          }
          return hist;
        })(),
        expectedListHeight: (() => {
          let sum = 0;
          for (const c of cards) sum += c.getBoundingClientRect().height;
          const gap = parseFloat(getComputedStyle(list).gap) || 0;
          return Math.round(sum + gap * Math.max(0, cards.length - 1));
        })(),
        detail: {
          rows: [...(container?.querySelectorAll('.tab-item') ?? [])].map(el => ({
            h: rect(el),
            top: Math.round(el.getBoundingClientRect().top * 100) / 100,
            mb: getComputedStyle(el).marginBottom,
          })),
          containerGap: container ? getComputedStyle(container).gap : '-',
          containerRowGap: container ? getComputedStyle(container).rowGap : '-',
          containerDisplay: container ? getComputedStyle(container).display : '-',
          containerRect: rect(container),
          containerPadBottom: container ? getComputedStyle(container).paddingBottom : '-',
          tabItem: rect(document.querySelector('.tab-item')),
          tabItemChildren: [...(document.querySelector('.tab-item')?.children ?? [])].map(el => ({
            cls: el.className?.toString?.().slice(0, 40),
            h: rect(el),
          })),
          realCard: rect(realCard),
          header: rect(header),
          track: rect(track),
          tabsContainer: rect(container),
          skeleton: rect(skeleton),
          farCard: rect(farCard),
          farHeader: rect(farHeader),
          farTrack: rect(farTrack),
          farContainer: rect(farContainer),
          farPlaceholder: rect(farPlaceholder),
          farPlaceholderStyle: farPlaceholder?.getAttribute('style') ?? '-',
          cardBorderTop: realCard
            ? getComputedStyle(realCard).borderTopWidth
            : '-',
          cardPadding: realCard ? getComputedStyle(realCard).padding : '-',
          listGap: list ? getComputedStyle(list).gap : '-',
        },
      };
    });

    const report = {
      dist: DIST,
      groups: GROUP_COUNT,
      tabsPerGroup: TAB_COUNT,
      ...measured,
      longestTask: measured.longTasks.length ? Math.max(...measured.longTasks) : 0,
    };
    console.log(JSON.stringify(report, null, 2));
    if (OUT) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(resolve(process.cwd(), OUT), JSON.stringify(report, null, 2));
    }
    await page.close();
  } finally {
    await ctx.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
