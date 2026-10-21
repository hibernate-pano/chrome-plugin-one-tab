// 产品负责人亲自做交互 —— 不是量几何，是**真的用**。
//
// 走一遍真实用户会做的动作，每一步都问「用户此刻看到了什么、会不会困惑」。
// 产出：outputs/prod-interact/*.png + 一份观察记录。
//
// 用法：pnpm build 之后 `node scripts/prod-interact.mjs`

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/prod-interact');
const now = Date.now();
const iso = ms => new Date(ms).toISOString();
const POPUP = { width: 400, height: 600 };

function mkTab(groupId, url, title, ageHours) {
  return {
    id: crypto.randomUUID(),
    url,
    title,
    favicon: `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`,
    createdAt: iso(now - ageHours * 3600e3),
    lastAccessed: iso(now - ageHours * 3600e3),
    group_id: groupId,
    pinned: false,
  };
}

function mkGroup(name, { locked = false, order, ageHours, tabs, notes }) {
  const id = crypto.randomUUID();
  return {
    id, name, notes, isFavorite: false, isLocked: locked, isDeleted: false,
    tabs: tabs.map(([url, title, age]) => mkTab(id, url, title, age ?? ageHours)),
    createdAt: iso(now - ageHours * 3600e3),
    updatedAt: iso(now - (ageHours - 0.5) * 3600e3),
    version: 1, displayOrder: order,
    lastOp: { d: 'demo-device', s: order },
  };
}

const groups = [
  mkGroup('研究资料', { order: 1, ageHours: 2, tabs: [
    ['https://arxiv.org/abs/1706.03762', 'Attention Is All You Need', 1],
    ['https://arxiv.org/abs/1512.03385', 'ResNet', 2],
    ['https://arxiv.org/abs/2005.14165', 'GPT-3', 3],
  ]}),
  mkGroup('购物车', { order: 2, ageHours: 6, tabs: [
    ['https://example.com/cart', '购物车 - 示例商城', 6],
  ]}),
  mkGroup('被锁定的长期项目', { order: 3, ageHours: 40, locked: true, tabs: [
    ['https://example.com/roadmap', '产品路线图', 40],
  ]}),
];

const observations = [];
const obs = (step, what, verdict) => {
  observations.push({ step, what, verdict });
  console.log(`  [${step}] ${what}`);
};

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

async function newPage(ctx, id, vp = POPUP) {
  const page = await ctx.newPage();
  await page.setViewportSize(vp);
  await page.goto(`chrome-extension://${id}/src/popup/index.html`);
  const skip = page.locator('button[aria-label="跳过引导"]');
  await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
  await page.waitForTimeout(600);
  return page;
}

/** 读真实磁盘上的会话 */
const readGroups = page => page.evaluate(async () => new Promise((resolve, reject) => {
  const r = indexedDB.open('tabvaultpro', 1);
  r.onerror = () => reject(new Error('open fail'));
  r.onsuccess = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains('kv')) { db.close(); reject(new Error('no kv')); return; }
    const all = db.transaction('kv', 'readonly').objectStore('kv').getAll();
    all.onsuccess = () => {
      db.close();
      const e = (all.result || []).find(v => v?.key === 'tab_groups');
      resolve(e ? (e.value || []) : []);
    };
    all.onerror = () => { db.close(); reject(new Error('read fail')); };
  };
}));

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-prod-interact-'));
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
    const id = new URL(sw.url()).host;

    const page = await newPage(ctx, id);
    await inject(page, groups);
    await page.reload();
    await page.waitForSelector('text=研究资料', { timeout: 15000 });
    await page.waitForTimeout(1000);

    // ══ 场景 1：折叠/展开会话卡 ══
    console.log('\n── 场景 1：折叠/展开 ──');
    // 折叠按钮的 aria-label 是「折叠会话：{会话名}」（2026-10-20 起带会话名 ——
    // 多张卡的按钮都叫「折叠会话」时，读屏用户按按钮列表分不清是哪一张）。
    //
    // 这里用**前缀匹配**而不是等值：等值会在标签后面加了会话名的那次改动后
    // 直接失配，而失配的表现是「脚本超时」—— 一个看不出原因的红灯。
    const collapseBtn = page.locator('button[aria-label^="折叠会话"]').first();
    await collapseBtn.click();
    await page.waitForTimeout(600);
    const collapsedTabs = await page.locator('.tab-group-card').first().locator('[class*="tab-item"]').count();
    await page.screenshot({ path: join(OUT_DIR, '01-collapsed.png') });
    obs('折叠', `折叠后可见标签行=${collapsedTabs}`, '折叠态下还剩什么信息');

    await page.locator('button[aria-label^="展开会话"]').first().click();
    await page.waitForTimeout(600);
    obs('展开', '重新展开', '展开后信息完整吗');

    // 点标题 = 进入重命名（这是设计如此）
    await page.locator('.tab-group-title').first().click();
    await page.waitForTimeout(500);
    const editing = await page.locator('input[aria-label="编辑会话名称"]').count();
    obs('点标题', `进入重命名=${editing > 0}`, '用户想折叠却点了标题会怎样');
    await page.screenshot({ path: join(OUT_DIR, '01b-renaming.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const stillEditing = await page.locator('input[aria-label="编辑会话名称"]').count();
    obs('Esc 取消重命名', `仍在编辑=${stillEditing > 0}`, 'Esc 能不能退出编辑态');
    if (stillEditing > 0) { await page.locator('input[aria-label="编辑会话名称"]').blur(); await page.waitForTimeout(300); }

    // ══ 场景 2：会话卡头部能看到什么 ══
    console.log('\n── 场景 2：卡片头信息量 ──');
    const cardInfo = await page.evaluate(() => {
      const card = document.querySelector('.tab-group-card');
      if (!card) return null;
      const header = card.querySelector('header, [class*="header"]') || card;
      const text = (header.textContent || '').trim();
      const buttons = [...header.querySelectorAll('button')].map(b => ({
        label: b.getAttribute('aria-label') || b.title || b.textContent?.trim().slice(0, 12),
        w: Math.round(b.getBoundingClientRect().width),
        h: Math.round(b.getBoundingClientRect().height),
      }));
      return { text: text.slice(0, 160), buttons };
    });
    console.log('  卡片头:', JSON.stringify(cardInfo, null, 1));
    obs('卡片头', `可见文字=${JSON.stringify(cardInfo?.text)} 按钮数=${cardInfo?.buttons.length}`, '按钮是否有 tooltip 文字提示');

    // 悬停第一个按钮看 tooltip
    if (cardInfo?.buttons.length) {
      const btn = page.locator('.tab-group-card button').first();
      await btn.hover();
      await page.waitForTimeout(700);
      const tip = await page.evaluate(() => {
        const el = document.querySelector('[class*="tooltip"]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { text: el.textContent?.trim(), w: Math.round(r.width), right: Math.round(r.right), visible: r.height > 0 };
      });
      console.log('  tooltip:', JSON.stringify(tip));
      obs('tooltip', JSON.stringify(tip), '窄屏下 tooltip 是否越界');
      await page.screenshot({ path: join(OUT_DIR, '02-tooltip.png') });
    }

    // ══ 场景 3：整组恢复 ══
    console.log('\n── 场景 3：恢复整个会话 ──');
    const before = await readGroups(page);
    console.log('  恢复前磁盘会话数:', before.length);
    // 找到「购物车」组的恢复按钮
    const restoreBtn = page.locator('.tab-group-card', { hasText: '购物车' }).locator('button[aria-label*="恢复"], button[aria-label*="打开"]').first();
    const hasRestore = await restoreBtn.count();
    console.log('  找到恢复按钮:', hasRestore > 0, hasRestore ? await restoreBtn.getAttribute('aria-label') : '');
    if (hasRestore > 0) {
      await restoreBtn.click();
      await page.waitForTimeout(2500);
      const after = await readGroups(page);
      console.log('  恢复后磁盘会话数:', after.length);
      obs('恢复整组', `磁盘会话 ${before.length} → ${after.length}`, '恢复后是否从列表消失（消费语义）');
      const stillVisible = await page.locator('text=购物车').count();
      console.log('  列表里还有「购物车」吗:', stillVisible);
      obs('恢复后可见性', stillVisible ? '仍可见' : '已消失', '用户能否理解这个行为');
      await page.screenshot({ path: join(OUT_DIR, '03-after-restore.png') });
    }

    // ══ 场景 4：点开单个标签（消费语义）══
    console.log('\n── 场景 4：点开单个标签 ──');
    const before4 = await readGroups(page);
    const singleTab = page.locator('.tab-group-card', { hasText: '研究资料' }).locator('[class*="tab-item"], [class*="tab-row"]').first();
    const hasSingle = await singleTab.count();
    console.log('  找到单标签行:', hasSingle);
    if (hasSingle) {
      // 点标题（非 ✕ 非链接）
      const titleEl = singleTab.locator('span, div').first();
      await titleEl.click();
      await page.waitForTimeout(2500);
      const after4 = await readGroups(page);
      const g = after4.find(x => x.name === '研究资料');
      console.log('  研究资料 标签数:', g?.tabs.length);
      obs('点开单标签', `标签数 ${before4.find(x=>x.name==='研究资料')?.tabs.length} → ${g?.tabs.length}`, '点开即消费，用户知道吗');
      await page.screenshot({ path: join(OUT_DIR, '04-after-open-tab.png') });
    }

    // ══ 场景 5：锁定会话的交互差异 ══
    console.log('\n── 场景 5：锁定会话 ──');
    const lockedCard = page.locator('.tab-group-card', { hasText: '被锁定的长期项目' });
    const lockedButtons = await lockedCard.locator('button').evaluateAll(btns =>
      btns.map(b => b.getAttribute('aria-label') || b.title || b.textContent?.trim().slice(0, 10)));
    const unlockedCard = page.locator('.tab-group-card', { hasText: '研究资料' });
    const unlockedButtons = await unlockedCard.locator('button').evaluateAll(btns =>
      btns.map(b => b.getAttribute('aria-label') || b.title || b.textContent?.trim().slice(0, 10)));
    console.log('  锁定组按钮:', JSON.stringify(lockedButtons));
    console.log('  普通组按钮:', JSON.stringify(unlockedButtons));
    obs('锁定组按钮', JSON.stringify(lockedButtons), '锁定态的差异对用户可见吗');
    obs('普通组按钮', JSON.stringify(unlockedButtons), '');

    // ══ 场景 6：键盘可达性 ══
    console.log('\n── 场景 6：键盘导航 ──');
    await page.keyboard.press('Tab');
    const focusChain = [];
    for (let i = 0; i < 22; i++) {
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return null;
        return {
          tag: el.tagName.toLowerCase(),
          label: el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 20) || el.getAttribute('placeholder') || '',
          cls: (el.className || '').toString().slice(0, 50),
        };
      });
      focusChain.push(info);
      await page.keyboard.press('Tab');
    }
    console.log('  Tab 焦点链:');
    focusChain.forEach((f, i) => console.log(`   ${String(i + 1).padStart(2)}. ${f?.tag} "${f?.label}"`));
    obs('键盘焦点链', `Tab ${22} 次`, '能否只靠键盘完成核心任务');

    // ══ 场景 7：Escape / 弹层行为 ══
    console.log('\n── 场景 7：菜单与弹层 ──');
    await page.keyboard.press('Escape');
    await page.click('button[aria-label="菜单"]');
    await page.waitForTimeout(500);
    const menuInfo = await page.evaluate(() => {
      const el = document.querySelector('[role="menu"], [data-menu]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), right: Math.round(r.right), bottom: Math.round(r.bottom) };
    });
    console.log('  菜单几何:', JSON.stringify(menuInfo));
    // 菜单能否用方向键
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(200);
    const focusAfterArrow = await page.evaluate(() => document.activeElement?.textContent?.trim().slice(0, 20));
    console.log('  ArrowDown 后焦点:', focusAfterArrow);
    obs('菜单方向键', `焦点=${focusAfterArrow}`, '菜单是否支持方向键');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const menuGone = await page.evaluate(() => !document.querySelector('[role="menu"], [data-menu]'));
    obs('Esc 关闭菜单', menuGone ? '已关闭' : '未关闭', '');

    // ══ 场景 8：底部页脚 ══
    console.log('\n── 场景 8：页脚与滚动 ══');
    const footer = await page.evaluate(() => {
      const el = document.querySelector('footer');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { text: el.textContent?.trim(), h: Math.round(r.height), y: Math.round(r.y) };
    });
    console.log('  页脚:', JSON.stringify(footer));
    await page.evaluate(() => document.querySelector('main')?.scrollTo(0, 99999));
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(OUT_DIR, '05-scrolled-bottom.png') });
    const afterScroll = await page.evaluate(() => {
      const el = document.querySelector('footer');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { y: Math.round(r.y), h: Math.round(r.height), visible: r.y < window.innerHeight && r.bottom > 0 };
    });
    console.log('  滚动后页脚:', JSON.stringify(afterScroll));
    obs('页脚滚动', JSON.stringify(afterScroll), '滚动后页脚位置合理吗');
  } finally {
    await ctx.close();
  }

  console.log('\n════════ 观察记录 ════════');
  observations.forEach(o => console.log(`[${o.step}] ${o.what}\n    → ${o.verdict}`));
}

main().catch(err => { console.error(err); process.exit(1); });
