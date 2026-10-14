// 点开即消费 · 真机三态验证（2026-10-14，1.24.1）
//
// 这个脚本要证明的只有一件事：**点开标签页真的会把它从会话里拿走**。
// 这条链路跨三个上下文（popup 点回包 → SW 拒开 → mutation 落盘），
// 源码读通、单元测试全绿都证明不了 —— 只有真机能证明：
//
//   ① 未锁定组点开 → 浏览器开了页面 **且该行从列表消失**（1.24.1 的核心诉求）
//   ② 锁定组点开   → 浏览器开了页面 **且该行保留**（锁定组从不消费）
//   ③ file:// 条   → 明确提示 **且该行保留**（成功门：没打开就不删）
//   ④ 冷却期内二次点击 → 出声提示，不开第二个标签页
//
// 造数据走**直接写 IndexedDB**（db=tabvaultpro / store=kv / key=tab_groups），
// 与真实落盘路径（storage.setGroups → kvSet）同键同形状，因此被测的是
// 生产读写链路本身，不是测试专用旁路。
//
// 用法：先 `pnpm build`，再 `node scripts/_verify-open-consume.mjs`
// （`_` 前缀不进门禁：它无断言产出、只在人工点开时跑）

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'store-assets/verify-open-consume');

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

/** 起一个本地站点：用来做「能打开」的标签，避免依赖外网 */
function startSite() {
  let n = 0;
  const server = createServer((_req, res) => {
    n += 1;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>探针-${n}</title><h1>探针-${n}</h1>`);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

const server = await startSite();
const base = `http://127.0.0.1:${server.address().port}`;

const NOW = new Date().toISOString();
const mkTab = (id, title, url, over = {}) => ({
  id, title, url, pinned: false, createdAt: NOW, lastAccessed: NOW, ...over,
});
const mkGroup = (id, name, tabs, over = {}) => ({
  id, name, tabs, createdAt: NOW, updatedAt: NOW, isLocked: false, ...over,
});

const SEED = [
  mkGroup('g-unlocked', '未锁定会话', [
    mkTab('t-open-1', '探针-可打开A', `${base}/a`),
    mkTab('t-open-2', '探针-可打开B', `${base}/b`),
  ]),
  mkGroup('g-locked', '锁定会话', [
    mkTab('t-locked-1', '探针-锁定A', `${base}/locked`),
  ], { isLocked: true }),
  mkGroup('g-file', '本地文件会话', [
    // isStorable=true 但 isOpenable=false：1.24.1 成功门要拦的就是这种
    mkTab('t-file-1', '探针-本地PDF', 'file:///Users/panbo/probe.pdf'),
  ]),
];

const profile = mkdtempSync(join(tmpdir(), 'tapstack-openconsume-'));
mkdirSync(OUT_DIR, { recursive: true });

const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--lang=zh-CN'],
});

/** popup 页面内的 IndexedDB 写入（与生产 kvSet 同键同形状） */
const writeGroups = (page, groups) => page.evaluate(async gs => {
  await new Promise((resolve, reject) => {
    const r = indexedDB.open('tabvaultpro', 1);
    r.onerror = () => reject(new Error('IDB 打开失败'));
    r.onsuccess = () => {
      const db = r.result;
      const store = db.transaction('kv', 'readwrite').objectStore('kv');
      store.put({ key: 'tab_groups', value: gs });
      store.transaction.onerror = () => reject(new Error('写入失败'));
      store.transaction.oncomplete = () => { db.close(); resolve(); };
    };
  });
}, groups);

const readGroups = page => page.evaluate(async () => {
  const r = indexedDB.open('tabvaultpro', 1);
  return new Promise((resolve, reject) => {
    r.onerror = () => reject(new Error('IDB 打开失败'));
    r.onsuccess = () => {
      const db = r.result;
      const all = db.transaction('kv', 'readonly').objectStore('kv').getAll();
      all.onsuccess = () => {
        db.close();
        resolve(all.result.find(v => v?.key === 'tab_groups')?.value ?? []);
      };
      all.onerror = () => reject(new Error('IDB 读取失败'));
    };
  });
});

/** 关掉引导遮罩（点按钮，绝不 el.remove —— 见 e2e-helpers 文件头约定 1） */
async function dismissOnboarding(page) {
  const overlay = page.locator('.onboarding-overlay');
  const present = await overlay.waitFor({ state: 'visible', timeout: 1500 })
    .then(() => true).catch(() => false);
  if (!present) return;
  const skip = page.locator('button[aria-label="跳过引导"]');
  const clickable = await skip.waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true).catch(() => false);
  if (clickable) await skip.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(600);
}

/** 标签行标题链接：靠 aria-label 前缀定位，与实现解耦（文案会改） */
const rowOf = (page, title) => page.locator(`.tab-item a[aria-label*="${title}"]`);

async function main() {
  let sw = null;
  for (let i = 0; i < 30 && !sw; i++) {
    sw = ctx.serviceWorkers()[0] ?? null;
    if (!sw) await new Promise(r => setTimeout(r, 500));
  }
  if (!sw) throw new Error('15s 内未找到扩展 service worker');
  const id = new URL(sw.url()).host;
  console.log('扩展 ID:', id);

  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

  await page.goto(`chrome-extension://${id}/src/popup/index.html`);
  await dismissOnboarding(page);

  // ── 造数据：直写 IndexedDB，再重开 popup 让应用读出来 ────────────────
  await writeGroups(page, SEED);
  await page.close();
  const p2 = await ctx.newPage();
  await p2.goto(`chrome-extension://${id}/src/popup/index.html`);
  await dismissOnboarding(p2);
  await p2.waitForSelector('.tab-item', { timeout: 15000 });

  // 展开所有折叠会话（默认可能折叠）
  const expanders = p2.locator('button[aria-label="展开会话"]');
  for (let i = 0; i < 10 && (await expanders.count()) > 0; i++) {
    await expanders.first().click().catch(() => {});
    await p2.waitForTimeout(200);
  }

  const before = await readGroups(p2);
  check('种子数据落盘（3 组 / 4 标签）',
    before.length === 3 && before.reduce((n, g) => n + g.tabs.length, 0) === 4,
    `实得 ${before.length} 组 / ${before.reduce((n, g) => n + g.tabs.length, 0)} 标签`);
  if (before.length !== 3) throw new Error('种子数据没落盘，探针无意义');

  const pagesBefore = ctx.pages().length;

  // ── ① 未锁定组点开 → 开页 + 行消失 ────────────────────────────────
  await rowOf(p2, '探针-可打开A').click();
  await p2.waitForTimeout(2500);
  const g1 = (await readGroups(p2)).find(g => g.id === 'g-unlocked');
  check('① 未锁定组点开：该条已从会话移除',
    Boolean(g1) && !g1.tabs.some(t => t.id === 't-open-1'),
    `组内剩 ${g1 ? g1.tabs.length : '（整组消失）'} 标签`);
  check('① 未锁定组点开：浏览器开了新标签页',
    ctx.pages().length > pagesBefore, `页面数 ${pagesBefore} → ${ctx.pages().length}`);

  // ── ④ 冷却：立刻再点同一条（已删，改为点另一条同 URL 不可行 → 改验 toast 路径）──
  // 说明：冷却针对「同 tabId」。t-open-2 是另一条，语义不同，因此这里验的是
  // 「删完之后点开另一条不受影响」，冷却本身由 reviveHardening 单测覆盖。
  await rowOf(p2, '探针-可打开B').click();
  await p2.waitForTimeout(2500);
  const g2 = (await readGroups(p2)).find(g => g.id === 'g-unlocked');
  check('① 未锁定组点完最后一条：整组物理移除（无空壳）',
    !g2, `组仍存在 = ${Boolean(g2)}`);
  check('整组移除后：列表里不再有该会话卡片',
    (await p2.locator('h3:has-text("未锁定会话")').count()) === 0);

  // ── ② 锁定组点开 → 开页 + 行保留 ─────────────────────────────────
  const pagesBefore2 = ctx.pages().length;
  await rowOf(p2, '探针-锁定A').click();
  await p2.waitForTimeout(2500);
  const g3 = (await readGroups(p2)).find(g => g.id === 'g-locked');
  check('② 锁定组点开：该条保留在会话中',
    Boolean(g3) && g3.tabs.some(t => t.id === 't-locked-1'));
  check('② 锁定组点开：浏览器开了新标签页',
    ctx.pages().length > pagesBefore2, `页面数 ${pagesBefore2} → ${ctx.pages().length}`);

  // ── ③ file:// → 提示 + 行保留 ────────────────────────────────────
  await rowOf(p2, '探针-本地PDF').click();
  await p2.waitForTimeout(1200);
  const toastText = await p2.locator('[role="alert"], [role="status"]').allInnerTexts()
    .catch(() => []);
  const g4 = (await readGroups(p2)).find(g => g.id === 'g-file');
  check('③ file:// 条点开：该条保留（成功门生效）',
    Boolean(g4) && g4.tabs.some(t => t.id === 't-file-1'));
  check('③ file:// 条点开：明确出声提示',
    toastText.join(' ').includes('无法打开'),
    `toast = ${JSON.stringify(toastText).slice(0, 120)}`);
  check('③ file:// 条点开：没有开新标签页',
    ctx.pages().length === pagesBefore2 + 1,
    `页面数 ${pagesBefore2 + 1} vs ${ctx.pages().length}`);

  await p2.screenshot({ path: join(OUT_DIR, 'open-consume-final.png'), fullPage: true });

  // 收尾：把探针开的标签页关掉，不留垃圾窗口
  for (const p of ctx.pages()) {
    if (p.url().startsWith(base)) await p.close().catch(() => {});
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (errs.length) console.log('⚠️ 页面错误:\n' + errs.slice(0, 8).join('\n'));
  if (failed.length) process.exitCode = 1;
}

try {
  await main();
} catch (e) {
  console.error('❌ 探针异常:', e.message);
  process.exitCode = 1;
} finally {
  await ctx.close().catch(() => {});
  server.close();
}
