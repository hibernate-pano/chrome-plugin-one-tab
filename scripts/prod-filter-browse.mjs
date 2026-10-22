// 真机巡检：筛选浏览形态（2026-10-20 审计 A-14 的真机验收）。
//
// 为什么单独写一个脚本，而不是在 scripts/prod-inspect.mjs 里加一步：
// A-14 的验收判据是**「三种形态在真实 popup 尺寸下各自成立」** ——
//   list   —— 没有搜索词、也没有筛选条件 ⇒ 主列表
//   browse —— 没有搜索词、但有筛选条件 ⇒ 筛选浏览视图
//   search —— 有搜索词 ⇒ 搜索结果
// 每种形态要分别断言「看得见的东西对不对」，而且**筛选器本身要可达**
// （不输入搜索词就能用）—— 这是一个多步骤流程，混进通用巡检里不好读。
//
// 用法：`pnpm build` 之后 `node scripts/prod-filter-browse.mjs`
// 产物：outputs/prod-filter-browse/*.png
//
// ⚠️ 必须 headless: false —— 扩展的 service worker 在 headless 下不会启动。

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/prod-filter-browse');
const POPUP = { width: 400, height: 600 };

const now = Date.now();
const iso = ms => new Date(ms).toISOString();

function tab(groupId, url, title) {
  return {
    id: crypto.randomUUID(),
    url,
    title,
    createdAt: iso(now - 3600e3),
    lastAccessed: iso(now - 3600e3),
    group_id: groupId,
    pinned: false,
  };
}

function group(name, order, urls) {
  const id = crypto.randomUUID();
  return {
    id,
    name,
    notes: '',
    isFavorite: false,
    isLocked: false,
    isDeleted: false,
    tabs: urls.map(([url, title]) => tab(id, url, title)),
    createdAt: iso(now - order * 3600e3),
    updatedAt: iso(now - (order - 0.5) * 3600e3),
    version: 1,
    lastOp: { d: 'demo-device', s: order },
  };
}

// 三组会话，分别在不同域名下 —— 这样「按域名筛选」有东西可筛。
const groups = [
  group('GitHub 仓库', 1, [
    ['https://github.com/hibernate-pano/chrome-plugin-one-tab', 'chrome-plugin-one-tab'],
    ['https://github.com/facebook/react/releases', 'React Releases'],
  ]),
  group('Go 官方文档', 2, [
    ['https://go.dev/ref/mem', 'The Go Memory Model'],
    ['https://pkg.go.dev/runtime', 'runtime package'],
  ]),
  group('前端周刊', 3, [
    ['https://news.ycombinator.com/news', 'Hacker News'],
    ['https://www.v2ex.com/t/1080000', '大家都在用什么管理浏览器标签页？'],
  ]),
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

/** 量一量筛选相关的关键几何与可见性。 */
async function measure(page) {
  return page.evaluate(() => {
    const vis = el => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        x: Math.round(r.x), y: Math.round(r.y),
        w: Math.round(r.width), h: Math.round(r.height),
        visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
      };
    };
    const text = sel => document.querySelector(sel)?.textContent?.trim() ?? null;
    return {
      // 筛选入口（「显示筛选」按钮）
      filterToggle: [...document.querySelectorAll('button')]
        .find(b => /显示筛选|隐藏筛选/.test(b.textContent ?? ''))
        ? vis([...document.querySelectorAll('button')].find(b => /显示筛选|隐藏筛选/.test(b.textContent ?? '')))
        : null,
      // 维度 chip 行（2026-10-22：面板改成 chip 方案 —— 点哪个维度才展开哪个输入框）
      chipRow: vis(document.querySelector('[data-testid="search-filter-chip-row"]')),
      chipCount: document.querySelectorAll('[data-testid="search-filter-chip-row"] button').length,
      // 筛选面板本体（按 id 找：域名输入框）
      domainInput: vis(document.querySelector('#search-filter-domain')),
      groupNameInput: vis(document.querySelector('#search-filter-group-name')),
      savedWithinSelect: vis(document.querySelector('#search-filter-saved-within')),
      // 徽章 / 清空
      //
      // ⚠️ 不能用 `querySelector('.theme-accent-soft')` 取第一个：那个类
      // 顶栏的「上传」按钮也在用 ⇒ 取到的会是「上传」。
      // 这里按**文案**找（「N 个筛选」那个徽章）。
      activeBadge:
        [...document.querySelectorAll('.theme-accent-soft')]
          .map(el => (el.textContent || '').trim())
          .find(t => /^\d+ 个筛选$/.test(t)) ?? null,
      clearButton: [...document.querySelectorAll('button')]
        .some(b => /清空筛选/.test(b.textContent ?? '')),
      // 结果区标题
      resultTitle: [...document.querySelectorAll('h3, h4')]
        .map(e => e.textContent?.trim() ?? '')
        .find(t => /会话|筛选|匹配/.test(t)) ?? null,
      // 横向溢出
      overflowers: [...document.querySelectorAll('*')]
        .filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.right > document.documentElement.clientWidth + 1;
        })
        .slice(0, 10)
        .map(el => ({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().slice(0, 60),
          right: Math.round(el.getBoundingClientRect().right),
        })),
      docScrollW: document.documentElement.scrollWidth,
      docClientW: document.documentElement.clientWidth,
    };
  });
}

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-filter-browse-'));
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
    if (!sw) throw new Error('未找到 service worker');
    const id = new URL(sw.url()).host;
    console.log('扩展 ID:', id);

    const page = await ctx.newPage();
    await page.setViewportSize(POPUP);
    await page.goto(`chrome-extension://${id}/src/popup/index.html`);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
    await page.waitForTimeout(500);
    await injectGroups(page, groups);
    await page.reload();
    await page.waitForSelector('text=GitHub 仓库', { timeout: 15000 });
    await page.waitForTimeout(1000);

    // ── ① list 形态：主列表，筛选器可达但未展开 ──
    console.log('\n① list 形态（无搜索词、无筛选条件）');
    let m = await measure(page);
    await page.screenshot({ path: join(OUT_DIR, '01-list.png') });
    check('「显示筛选」入口可见（筛选器不依赖搜索词即可达）', m.filterToggle?.visible === true,
      `entry=${JSON.stringify(m.filterToggle)}`);
    check('筛选面板此刻未展开', m.domainInput?.visible !== true);
    check('主列表无横向溢出', m.overflowers.length === 0, JSON.stringify(m.overflowers));

    // ── ② 展开筛选面板（不输入任何关键词）──
    console.log('\n② 展开筛选面板（不输入任何关键词）');
    const toggle = page.locator('button', { hasText: /显示筛选|隐藏筛选/ }).first();
    await toggle.click();
    await page.waitForTimeout(500);
    m = await measure(page);
    await page.screenshot({ path: join(OUT_DIR, '02-panel-open.png') });
    // 面板现在是**一条 chip 行**（2026-10-22）：点哪个维度才展开那个输入框。
    // 所以「筛选器可达」的判据是「维度 chip 都在」，不是「三个输入框同时可见」。
    check('维度 chip 行可见（筛选器不依赖搜索词即可达）', m.chipRow?.visible === true,
      `chipRow=${JSON.stringify(m.chipRow)}`);
    check('三个筛选维度都有 chip', m.chipCount === 3, `chipCount=${m.chipCount}`);

    // ── ②之二 点开「域名」维度 ⇒ 域名输入框才出现 ──
    console.log('\n②之二 点开「域名」维度 chip');
    await page.locator('button[aria-controls="search-filter-domain-field"]').click();
    await page.waitForTimeout(300);
    m = await measure(page);
    await page.screenshot({ path: join(OUT_DIR, '02b-domain-dimension.png') });
    check('域名筛选框可见（点开维度后就能用）', m.domainInput?.visible === true,
      `domain=${JSON.stringify(m.domainInput)}`);
    check('筛选面板无横向溢出', m.overflowers.length === 0, JSON.stringify(m.overflowers));

    // ── ③ 输入域名条件 → browse 形态 ──
    console.log('\n③ 输入域名条件（go.dev）⇒ 筛选浏览形态');
    await page.fill('#search-filter-domain', 'go.dev');
    await page.waitForTimeout(900);
    m = await measure(page);
    await page.screenshot({ path: join(OUT_DIR, '03-browse-filtered.png') });
    check('结果区出现（筛选浏览视图）', /会话|筛选|匹配/.test(m.resultTitle ?? ''), `title=${m.resultTitle}`);
    check('有「N 个筛选」徽章（条件生效的可见证据）', /\d+ 个筛选/.test(m.activeBadge ?? ''), `badge=${m.activeBadge}`);
    check('有「清空筛选」入口', m.clearButton === true);
    const bodyText = await page.locator('body').innerText();
    check('结果里只剩 go.dev 的会话', bodyText.includes('Go 官方文档') && !bodyText.includes('GitHub 仓库'),
      `body 含 GitHub 仓库? ${bodyText.includes('GitHub 仓库')}`);
    check('browse 形态不得声称「搜索过」', !/没有找到与[“"「][^”"」]*[”"」]相关/.test(bodyText),
      `命中「与…相关」? ${/没有找到与[“"「][^”"」]*[”"」]相关/.test(bodyText)}`);

    // ── ④ 清空搜索词（本来就是空的）⇒ 条件仍在 ──
    console.log('\n④ 条件持久：搜索框保持空，条件仍在生效');
    const search = page.locator('input[type="text"], input[placeholder*="搜索"]').first();
    const searchValue = await search.inputValue();
    check('搜索框确实是空的（没偷偷写入关键词）', searchValue.trim() === '', `value=${JSON.stringify(searchValue)}`);
    check('筛选条件仍在生效（Go 会话仍在、前一个不在）',
      (await page.locator('body').innerText()).includes('Go 官方文档'));

    // ── ⑤ 搜一个词 ⇒ 搜索形态（既有行为不变）──
    console.log('\n⑤ 搜索形态（有搜索词）');
    await search.fill('GitHub');
    await page.waitForTimeout(900);
    m = await measure(page);
    await page.screenshot({ path: join(OUT_DIR, '04-search.png') });
    const bodyText2 = await page.locator('body').innerText();
    // 判据：搜索词与筛选条件**同时**生效 ⇒ 结果是两者���**交集**。
    // 这里搜索词 = 'GitHub'、域名条件 = 'go.dev' ⇒ 交集为空 ⇒
    // 两个会话都**不该**出现。若出现任意一个，说明两个条件没有同时生效
    // （「筛选条件被搜索词覆盖」或「搜索词被筛选条件覆盖」都是错的）。
    //
    // 【第一版判据写反了】我最初断言「含 GitHub 仓库、不含 Go 官方文档」——
    // 那是**只**校验了域名条件，没校验搜索条件 ⇒ 把「筛选条件把搜索结果
    // 整个盖掉」这种缺陷也判成通过了。交集判据才抓得住它。
    check('搜索词与筛选条件同时生效（结果应是交集：两者都不出现）',
      !bodyText2.includes('GitHub 仓库') && !bodyText2.includes('Go 官方文档'),
      `含 GitHub 仓库? ${bodyText2.includes('GitHub 仓库')}；含 Go 官方文档? ${bodyText2.includes('Go 官方文档')}`);

    // ── ⑥ 清空搜索词 ⇒ 条件必须还在（本次修复的核心）──
    console.log('\n⑥ 清空搜索词 ⇒ 筛选条件必须还在');
    await search.fill('');
    await page.waitForTimeout(900);
    const bodyText3 = await page.locator('body').innerText();
    m = await measure(page);
    await page.screenshot({ path: join(OUT_DIR, '05-after-clear.png') });
    check('清空搜索词后，域名条件仍在生效', bodyText3.includes('Go 官方文档'), `含 Go 官方文档? ${bodyText3.includes('Go 官方文档')}`);
    check('清空搜索词后，不再显示 GitHub 会话', !bodyText3.includes('GitHub 仓库'));
    check('「N 个筛选」徽章仍在', /\d+ 个筛选/.test(m.activeBadge ?? ''), `badge=${m.activeBadge}`);

    // ── ⑦ 点「清空筛选」⇒ 回到主列表 ──
    console.log('\n⑦ 点「清空筛选」⇒ 回到主列表');
    const clear = page.locator('button', { hasText: /清空筛选/ }).first();
    if (await clear.count()) {
      await clear.click();
      await page.waitForTimeout(700);
    }
    const bodyText4 = await page.locator('body').innerText();
    await page.screenshot({ path: join(OUT_DIR, '06-cleared.png') });
    check('清空筛选后主列表恢复（三组会话都在）',
      bodyText4.includes('GitHub 仓库') && bodyText4.includes('Go 官方文档') && bodyText4.includes('前端周刊'));

    // ── ⑧ 空白搜索词（只敲空格）⇒ 空态引导卡不该消失 ──
    console.log('\n⑧ 空白搜索词（只敲一个空格）');
    await search.fill(' ');
    await page.waitForTimeout(800);
    const bodyText5 = await page.locator('body').innerText();
    await page.screenshot({ path: join(OUT_DIR, '07-blank-query.png') });
    check('只敲空格时，主列表仍在（不是一片空白）',
      bodyText5.includes('GitHub 仓库') || bodyText5.includes('Go 官方文档'),
      `body 长度=${bodyText5.length}`);

    const failed = checks.filter(c => !c.ok);
    console.log(`\n真机判据: ${checks.length - failed.length}/${checks.length} 通过`);
    if (failed.length) {
      console.log('失败项：');
      for (const f of failed) console.log(`  · ${f.name} — ${f.detail}`);
      process.exitCode = 1;
    } else {
      console.log('✅ 筛选浏览形态真机验证通过');
    }
  } finally {
    await ctx.close();
  }
}

main().catch(err => {
  console.error('真机巡检失败:', err);
  process.exit(1);
});
