// 商店截图生成器：加载 **dist 里真实构建的扩展** → 注入演示会话 → 截 5 张原始 UI →
// 按已裁定的品牌化构图（蓝渐变 + 标题/副标 + 整窗 + 标注气泡）合成 1280×800 商店图。
//
// 产物（CWS 要求 1280×800，最多 5 张）：
//   store-assets/screenshot-1-main.png         ① 主界面
//   store-assets/screenshot-2-save-close.png   ② 保存即关闭（真实点一次按钮后的回执）
//   store-assets/screenshot-3-search.png       ③ 搜索
//   store-assets/screenshot-4-restore-lock.png ④ 恢复与锁定（滚到锁定会话那一屏）
//   store-assets/screenshot-5-theme.png        ⑤ 主题（Claude 深色）
//
// ⚠️ 约定（复用 e2e-helpers 的踩坑结论）：
// 1. 引导遮罩必须点「跳过引导」让 React 自己收，绝不 el.remove()（React patch 会炸成错误边界）。
// 2. 数据真相源是 IndexedDB tabvaultpro / kv（keyPath='key'）/ tab_groups，先开一次页面让 app 建
//    schema，再注入，再 reload —— 顺序反了会自己建出缺列的 store。
// 3. 用独立临时 profile，不碰开发者本机的浏览器数据。
//
// 用法：pnpm build 之后跑 `node scripts/make-store-screenshots.mjs`
//
// ── 版本号（2026-11-28 L-15 重拍）────────────────────────────────────────
// 页脚「TapStack vX.Y.Z」由 MainApp 从 `chrome.runtime.getManifest().version`
// **动态渲染** ⇒ 图里的版本号只取决于「跑的是哪次构建」。本脚本在截图前
// 断言每张原图的页脚文本 == 当前 dist 的 manifest 版本，合成后再断言
// 成品是 1280×800 —— 「构建成功」不等于「产物对」，判据落在产物上。
//
// 【为什么每张都要页脚】商店图是二进制产物，改版本号时它不会自己更新。
// 守卫（tests/guards/storeAssetsMatchCurrentVersion.test.ts）查文档陈述，
// 人眼也要在图里读得到同一个版本号。演示数据按「能露出页脚」的量给：
// 内容超一屏会把页脚顶下去（这正是 1.32.1 主图缺页脚的根因）。

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'store-assets');
const VIEWPORT = { width: 1280, height: 800 };

// ── 构图常量（2026-11-27 已裁定的五张共用规则，照做不重新设计）──────────
const CANVAS = { width: 1280, height: 800 };
const WINDOW = { left: 160, top: 180, width: 960, height: 600 };
/** 原图 1280 宽 → 窗口内 960 宽 = 0.75 缩放。 */
const UI_SCALE = WINDOW.width / VIEWPORT.width;
/** 原图像素坐标 → 合成画布坐标。 */
const toCanvas = (x, y) => ({
  x: WINDOW.left + x * UI_SCALE,
  y: WINDOW.top + y * UI_SCALE,
});

const now = Date.now();
const iso = ms => new Date(ms).toISOString();

const DIST_VERSION = (() => {
  const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
  return manifest.version;
})();

// ── 演示数据 ────────────────────────────────────────────────────────────
// 目标用户（重度浏览器使用者）的真实一天。
// 1.22.13 起「收藏」与「会话备注」已下线（负责人决定：非核心功能做减法），
// 演示数据里不再注入这两项——否则重拍的商店截图会出现已不存在的 UI。
/** 造一组演示标签（favicon 走 Google s2 服务，SafeFavicon 白名单只放行 https，够用） */
function tab(groupId, url, title, ageHours) {
  const domain = new URL(url).hostname;
  return {
    id: crypto.randomUUID(),
    url,
    title,
    favicon: `https://www.google.com/s2/favicons?domain=${domain}&sz=32`,
    createdAt: iso(now - ageHours * 3600e3),
    lastAccessed: iso(now - ageHours * 3600e3),
    group_id: groupId,
    pinned: false,
  };
}

function group(name, { locked = false, order, ageHours, updatedHours, tabs }) {
  const id = crypto.randomUUID();
  return {
    id,
    name,
    isLocked: locked,
    tabs: tabs.map(([url, title, age]) => tab(id, url, title, age ?? ageHours)),
    createdAt: iso(now - ageHours * 3600e3),
    updatedAt: iso(now - (updatedHours ?? ageHours - 0.5) * 3600e3),
    isDeleted: false,
    version: 1,
    displayOrder: order,
    lastOp: { d: 'demo-device', s: order },
  };
}

const demoV2 = order =>
  group('V2 同步架构评审', {
    order,
    ageHours: 2,
    tabs: [
      ['https://github.com/hibernate-pano/chrome-plugin-one-tab/pulls', 'Pull requests · hibernate-pano/chrome-plugin-one-tab'],
      ['https://docs.google.com/document/d/1v2-plan-review/edit', 'V2 执行计划评审 — Google 文档'],
      ['https://github.com/hibernate-pano/chrome-plugin-one-tab/actions', 'Actions · chrome-plugin-one-tab', 5],
      ['https://news.ycombinator.com/item?id=39011223', 'CRDTs and the cost of consistency | Hacker News', 8],
    ],
  });

const demoReact = (order, count = 3, ageHours = 6, updatedHours) =>
  group('React 19 升级 PR', {
    order,
    ageHours,
    updatedHours,
    tabs: [
      ['https://github.com/facebook/react/releases', 'React Releases · facebook/react'],
      ['https://react.dev/reference/react/useActionState', 'useActionState – React'],
      ['https://react.dev/blog/react-19-upgrade-guide', 'Upgrading to React 19 – React Blog', 12],
      ['https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Frameworks_libraries/React_getting_started', 'Getting started with React - Learn web development | MDN', 20],
    ].slice(0, count),
  });

const demoGo = (order, count = 3) =>
  group('Go 官方文档深潜', {
    order,
    ageHours: 26,
    tabs: [
      ['https://go.dev/ref/mem', 'The Go Memory Model - The Go Programming Language'],
      ['https://pkg.go.dev/runtime', 'runtime package - runtime - pkg.go.dev'],
      ['https://go.dev/blog/race-detector', 'Introducing the Go Race Detector - The Go Blog', 30],
    ].slice(0, count),
  });

const demoInterview = order =>
  group('面试准备（进行中）', {
    locked: true,
    order,
    ageHours: 40,
    tabs: [
      ['https://github.com/system-design-primer', 'donnemartin/system-design-primer: Learn how to design large-scale systems'],
      ['https://martinfowler.com/articles/patterns-of-distributed-systems/', 'Patterns of Distributed Systems', 60],
    ],
  });

const demoWeekly = order =>
  group('周报素材收集', {
    order,
    ageHours: 52,
    tabs: [
      ['https://news.ycombinator.com/news', 'Hacker News'],
      ['https://www.v2ex.com/t/1080000', '大家都在用什么管理浏览器标签页？ - V2EX', 70],
      ['https://juejin.cn/post/2026-react-ecosystem', '2026 前端年度报告：React 生态盘点 - 掘金', 90],
    ],
  });

const demoChecklist = order =>
  group('上线检查清单', {
    order,
    ageHours: 30,
    tabs: [
      ['https://developer.chrome.com/docs/webstore/review-process', 'Review process - Chrome Web Store'],
    ],
  });

const demoLearn = order =>
  group('React 学习路线', {
    order,
    ageHours: 18,
    tabs: [
      ['https://react.dev/learn', 'Quick Start – React'],
      ['https://react.dev/learn/thinking-in-react', 'Thinking in React – React'],
    ],
  });

const LIGHT_SETTINGS = { themeStyle: 'legacy', themeMode: 'light' };
const DARK_THEME_SETTINGS = { themeStyle: 'claude', themeMode: 'dark' };

// 每张图的数据量都按「页脚必须露出来」裁过：内容超一屏会把页脚顶下去。
const SCENARIOS = [
  {
    name: 'screenshot-1-main',
    groups: [demoV2(1), demoReact(2), demoGo(3), demoChecklist(4)],
    settings: LIGHT_SETTINGS,
    title: '关掉窗口，现场还在',
    subtitle: '保存并关闭：整窗标签存成一个会话，下次整组打开。',
    pills: [
      {
        text: '一次保存 = 一张会话卡',
        left: 300,
        top: 234,
        anchor: 'first-card',
      },
    ],
  },
  {
    name: 'screenshot-2-save-close',
    groups: [demoReact(1, 2), demoGo(2, 2), demoChecklist(3)],
    settings: LIGHT_SETTINGS,
    // 真实点一次「保存并关闭」：先在这一窗打开 5 个网页，点按钮，等回执。
    saveAndClose: [
      'https://github.com/vercel/next.js',
      'https://developer.chrome.com/docs/extensions/reference/api/tabs',
      'https://web.dev/articles/bfcache',
      'https://www.typescriptlang.org/docs/handbook/2/narrowing.html',
      'https://vite.dev/guide/',
    ],
    title: '一按，整窗变成会话',
    subtitle: '整窗标签存成一个会话、标签随即关闭；要用时整组打开。',
    pills: [
      {
        text: '刚关掉的那些标签，都在这张卡里',
        left: 300,
        top: 234,
        anchor: 'first-card',
      },
    ],
  },
  {
    name: 'screenshot-3-search',
    // 标题说「三个月前那组」⇒ 被搜的这组必须是三个月前保存的（2026-11-28）。
    // 只在这一张改年龄：其余四张沿用默认 6 小时，顺序与落点都不动。
    // updatedHours 单独给：搜索结果同分时按会话 updatedAt 倒序收敛
    // （src/utils/search.ts 的 buildSessionSearchResults）—— 三个月前保存、
    // 最近还动过，这组才排第一位，引线才落在它自己的「恢复整个会话」按钮上。
    groups: [
      demoReact(1, 4, 90 * 24, 0.5),
      demoLearn(2),
      demoInterview(3),
      demoWeekly(4),
    ],
    settings: LIGHT_SETTINGS,
    search: 'React',
    title: '三个月前那组，3 秒找回来',
    subtitle: '按关键词、网站或时间筛选；命中到具体标签页，整组一键恢复。',
    pills: [
      {
        text: '按关键词 / 网站 / 时间搜',
        left: 368,
        top: 240,
        anchor: 'search-input',
      },
      {
        text: '整组一键恢复',
        left: 782,
        top: 304,
        anchor: 'search-restore',
      },
    ],
  },
  {
    name: 'screenshot-4-restore-lock',
    groups: [demoV2(1), demoReact(2, 2), demoChecklist(3), demoInterview(4)],
    settings: LIGHT_SETTINGS,
    title: '想反复用？先锁定',
    subtitle: '锁定的会话恢复后仍留在列表；未锁定的会话，恢复一次即从列表移除。',
    pills: [
      {
        text: '整组恢复：当前窗口 / 新窗口',
        left: 685,
        top: 596,
        anchor: 'locked-restore',
      },
    ],
  },
  {
    name: 'screenshot-5-theme',
    groups: [demoV2(1), demoReact(2), demoGo(3), demoChecklist(4)],
    settings: DARK_THEME_SETTINGS,
    title: '同一个工具，六种样子',
    subtitle: '6 套主题风格，各有明暗两色；换主题，界面立刻跟着变。',
    pills: [
      {
        text: '6 套主题 · 明暗各一',
        // 620 而非 660：右缘 ≈779，离「排序」约 56px；引线从右缘往右上走到
        // 月亮按钮的**右框线**（rect.right ≈ 813），骑边不盖月亮
        // （2026-11-28 UI/UX 第 2 轮验收点）。
        left: 620,
        top: 240,
        anchor: 'theme-toggle',
      },
    ],
  },
];

// ── 运行时 ──────────────────────────────────────────────────────────────

/** 往扩展 IDB 写 tab_groups / user_settings（schema 由 app 首次打开时建好） */
async function injectData(page, { rows, settings }) {
  await page.evaluate(
    async ({ rows, settings }) => {
      await new Promise((res, rej) => {
        const req = indexedDB.open('tabvaultpro', 1);
        req.onerror = () => rej(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put({ key: 'tab_groups', value: rows });
          if (settings) tx.objectStore('kv').put({ key: 'user_settings', value: settings });
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
    },
    { rows, settings }
  );
}

/**
 * 等页面上**所有 favicon 图片真正解码完成**再截图。
 *
 * ── 为什么不能用固定等待 ────────────────────────────────────────────────
 * 原来用的是 `waitForTimeout(1500)`（"等 favicon / 布局稳定"）。
 * 那个 1.5 秒是**猜**的：favicon 来自 `google.com/s2/favicons`，
 * 而它会 **301 跳到 `t1.gstatic.com`** —— 多一次往返，且这两个服务都偶发慢。
 * 猜早了 ⇒ 截出来的商店图里 favicon 是一片空白方块。
 *
 * 实测踩到过：同一份代码两次生成截图，一次有图标、一次没有 ——
 * 因为「有没有图标」取决于那一刻网络抖动，**不可复现**。
 *
 * ── 为什么不用 networkidle ──────────────────────────────────────────────
 * 扩展页面里可能有长连的请求（alarms / sync），networkidle 未必达成，
 * 会让脚本**超时失败**而不是「等久一点」。
 *
 * 【判据】等到「页面上每一个 <img> 都 complete」：
 *   · complete=true  且 naturalWidth>0 ⇒ 加载成功；
 *   · complete=true  且 naturalWidth=0 ⇒ 加载**失败**（回退图标已渲染，
 *     等下去也不会变好）—— 这种情况**不阻塞**，直接返回。
 * ⇒ 只有「还在加载中」的才继续等，且有上限（15s）。
 */
async function waitForFavicons(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pending = await page.evaluate(() =>
      Array.from(document.images).filter(img => !img.complete).length
    );
    if (pending === 0) return;
    if (Date.now() > deadline) {
      console.warn(`⚠️ 仍有 ${pending} 张图片未加载完（已等 ${timeoutMs}ms），继续截图`);
      return;
    }
    await page.waitForTimeout(250);
  }
}

async function skipOnboarding(page) {
  const skip = page.locator('button[aria-label="跳过引导"]');
  await skip
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => skip.click())
    .catch(() => {});
  const overlay = page.locator('.onboarding-overlay');
  if (await overlay.count()) {
    const skipBtn = page.locator('button[aria-label="跳过引导"]');
    await skipBtn.click({ timeout: 5000 }).catch(() => page.keyboard.press('Escape'));
    await overlay.waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
  }
}

/** 读一个元素的「原图 CSS 坐标」矩形。 */
async function rectOf(page, selector) {
  return page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, selector);
}

async function anchorOf(page, kind) {
  switch (kind) {
    case 'first-card': {
      const r = await rectOf(page, '.tab-group-card');
      if (!r) throw new Error('找不到第一张会话卡');
      return toCanvas(r.x + 20, r.y + 16);
    }
    case 'search-input': {
      const r = await rectOf(page, 'input[placeholder*="搜索"]');
      if (!r) throw new Error('找不到搜索框');
      return toCanvas(r.x + r.width / 2, r.y + r.height / 2);
    }
    case 'search-restore': {
      const r = await rectOf(page, '[data-testid^="search-restore-session-"]');
      if (!r) throw new Error('找不到搜索结果的「恢复整个会话」按钮');
      // 圆点骑在**左框线**上、垂直居中（2026-11-28 第 2 轮返工）：
      // 落按钮中心会压在「整」字上 —— 白点不许盖住它指的东西。
      return toCanvas(r.x, r.y + r.height / 2);
    }
    case 'locked-restore': {
      const r = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('.tab-group-card')];
        const locked = cards.find(c => c.querySelector('.tab-group-lock-icon'));
        if (!locked) return null;
        const btn = locked.querySelector('button[aria-label^="在当前窗口打开整个会话"]');
        if (!btn) return null;
        const b = btn.getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      });
      if (!r) throw new Error('找不到锁定会话的「在当前窗口打开」按钮');
      // 圆点骑在**左框线**上、垂直居中：落图标中心会把 ⊕ 整个盖掉
      // （2026-11-28 第 2 轮返工）。glyph 在左内边距之后，完整可见。
      return toCanvas(r.x, r.y + r.height / 2);
    }
    case 'theme-toggle': {
      const r = await rectOf(page, 'button[aria-label^="切换到"]');
      if (!r) throw new Error('找不到主题切换按钮');
      // 圆点骑在**右框线**上、垂直居中（2026-11-28 第 2 轮返工）：落月亮中心只剩
      // 一道弧。与 ③④ 骑左框线同一条规则 —— 圆心落在框线上。
      // 实测按钮右缘 813.6（裁定写的「约 813」），月亮 glyph 右缘 806.5；
      // 白点半径 4.5 + 描边 1 ⇒ 环左缘 808.1，完整让开月亮、只贴边不盖。
      return toCanvas(r.x + r.width, r.y + r.height / 2);
    }
    default:
      throw new Error(`未知锚点：${kind}`);
  }
}

/** 打开这一窗里的真实网页标签，等标题加载完（保存后这些标签会被关掉）。 */
async function openRealTabs(ctx, page, urls) {
  for (const url of urls) {
    const p = await ctx.newPage();
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(err => {
      console.warn(`⚠️ 演示标签加载失败（${url}）：${err.message}`);
    });
  }
  await page.bringToFront();
  // 等真实标题（保存时会写进会话卡；标题为空会让卡片显示成裸 URL）
  const deadline = Date.now() + 15000;
  for (;;) {
    const ready = await page.evaluate(async count => {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const web = tabs.filter(t => /^https?:/.test(t.url || ''));
      // 后台标签的 status 不一定会变成 complete，判据落在**标题**上：
      // 有真实标题（且不是裸 URL）就说明页面已经给出了可读的 title。
      return (
        web.length >= count &&
        web.every(t => {
          const title = t.title || '';
          return title.length > 8 && !title.startsWith('http');
        })
      );
    }, urls.length);
    if (ready) return;
    if (Date.now() > deadline) {
      console.warn('⚠️ 演示标签未全部加载完，仍继续（标题可能不完整）');
      return;
    }
    await page.waitForTimeout(300);
  }
}

/** 读页脚文本（版本号由 MainApp 从 manifest 动态渲染）。 */
async function footerText(page) {
  return page.evaluate(() => {
    const footer = document.querySelector('footer');
    return footer ? footer.textContent.replace(/\s+/g, ' ').trim() : '';
  });
}

async function captureRaw(ctx, id, scenario, rawDir) {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/src/popup/index.html`);
  await skipOnboarding(page);
  await injectData(page, { rows: scenario.groups, settings: scenario.settings });
  await page.reload();
  await page.waitForSelector('.tab-group-card', { timeout: 15000 });
  await skipOnboarding(page);
  // 基础列表的图标先等齐：搜索 / 保存会重渲染行，提前等一轮能把
  // 「首屏图标还在飞、立刻又切状态」的空白方块挡在截图之外。
  await waitForFavicons(page);

  if (scenario.search) {
    const input = page.locator('input[placeholder*="搜索"]');
    await input.fill(scenario.search);
    await page.waitForSelector('text=匹配结果', { timeout: 8000 });
    // 让高亮/结果渲染稳定
    await page.waitForTimeout(400);
  }

  if (scenario.saveAndClose) {
    await openRealTabs(ctx, page, scenario.saveAndClose);
    const saveBtn = page.locator('button[aria-label^="把当前窗口的标签页保存为一个工作会话"]');
    await saveBtn.click();
    await page.waitForSelector('button:has-text("已保存")', { timeout: 20000 });
    await page.waitForTimeout(1200);
    // 鼠标移开：hover 300ms 后的 tooltip 会盖住右侧「显示筛选」，进图就成了脏点
    await page.mouse.move(4, 792);
    await page.waitForTimeout(700);
  }

  await waitForFavicons(page);
  await page.waitForTimeout(500);

  const text = await footerText(page);
  const expected = `TapStack v${DIST_VERSION}`;
  if (!text.endsWith(expected)) {
    throw new Error(`${scenario.name}: 页脚读作「${text}」，期望以「${expected}」结尾 —— 构建或截图不对`);
  }
  // 页脚必须真的**在视口里**：文本在 DOM 里不等于它进了图。
  // 演示数据一旦超过一屏，页脚会被顶到 800px 以下（1.32.1 主图缺页脚就是这么来的）。
  const footerBox = await page.evaluate(() => {
    const r = document.querySelector('footer').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, viewport: window.innerHeight };
  });
  if (footerBox.top < 0 || footerBox.bottom > footerBox.viewport) {
    throw new Error(
      `${scenario.name}: 页脚不在视口内（top=${footerBox.top} bottom=${footerBox.bottom} 视口=${footerBox.viewport}）` +
        ' —— 演示数据把页脚顶下去了，减少会话或标签'
    );
  }

  const rawPath = join(rawDir, `${scenario.name}.raw.png`);
  await page.screenshot({ path: rawPath });
  const anchors = {};
  for (const pill of scenario.pills) {
    anchors[pill.anchor] = await anchorOf(page, pill.anchor);
  }
  await page.close();
  console.log(`📸 原图 ${scenario.name}（页脚：${text}）`);
  return { rawPath, anchors };
}

// ── 合成（品牌化构图）──────────────────────────────────────────────────
// 规则来源：/Users/panbo/Code/Demos/tapstack-store-drafts/README.md
// · 渐变 linear-gradient(130deg,#3B82F6,#1D4ED8) + 左上光斑 + 右下压暗
// · 标题 56/700 纯白，左 160 顶 44；副标 20/500 白 88%，间距 12
// · 整窗 960×600 @ (160,180)，圆角 16，描边 1px rgba(255,255,255,.22)，
//   双层投影；统一 0.75 缩放（页脚 12px → 9px，仍是可读下限）
// · 气泡深蓝 #0B1B33，白字 14/600，内边距 11×16，圆角 999，引线 1.6px
//   rgba(11,27,51,.72)，端点 9px 白底深描圆点
// · 硬规则：气泡只落在界面空白处，不遮任何文字、按钮、图标
function composeHtml({ title, subtitle, imageDataUrl, pills }) {
  const pillNodes = pills
    .map(
      p =>
        `<div class="pill" data-ax="${p.anchor.x.toFixed(1)}" data-ay="${p.anchor.y.toFixed(
          1
        )}" style="left:${p.left}px;top:${p.top}px;">${p.text}</div>`
    )
    .join('');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:1280px; height:800px; overflow:hidden; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
                 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif;
    background: linear-gradient(130deg, #3B82F6 0%, #1D4ED8 100%);
    position: relative;
  }
  body::before {
    content:''; position:absolute; inset:0;
    background: radial-gradient(circle at 18% 8%, rgba(255,255,255,.22) 0%, rgba(255,255,255,0) 75%);
  }
  body::after {
    content:''; position:absolute; inset:0;
    background: radial-gradient(circle at 88% 96%, rgba(6,20,64,.26) 0%, rgba(6,20,64,0) 55%);
  }
  .copy { position:absolute; left:160px; top:44px; width:1000px; z-index:3; }
  h1 { font-size:56px; line-height:1.15; font-weight:700; color:#fff; letter-spacing:-.5px; }
  .sub { margin-top:12px; font-size:20px; line-height:1.5; font-weight:500; color:rgba(255,255,255,.88); }
  .win {
    position:absolute; left:${WINDOW.left}px; top:${WINDOW.top}px;
    width:${WINDOW.width}px; height:${WINDOW.height}px;
    border-radius:16px; overflow:hidden; z-index:2; background:#fff;
    box-shadow: 0 36px 90px rgba(6,22,70,.45), 0 8px 24px rgba(6,22,70,.30);
    outline:1px solid rgba(255,255,255,.22);
  }
  .win img { display:block; width:${WINDOW.width}px; }
  .pill {
    position:absolute; z-index:6;
    background:#0B1B33; color:#fff; font-size:14px; font-weight:600; line-height:1;
    padding:11px 16px; border-radius:999px; white-space:nowrap;
    box-shadow: 0 10px 24px rgba(6,22,70,.35), 0 0 0 1px rgba(255,255,255,.22);
  }
  svg.leaders { position:absolute; left:0; top:0; z-index:5; overflow:visible; pointer-events:none; }
</style></head>
<body>
  <div class="copy"><h1>${title}</h1><div class="sub">${subtitle}</div></div>
  <div class="win"><img src="${imageDataUrl}"></div>
  ${pillNodes}
  <svg class="leaders" width="1280" height="800"></svg>
</body></html>`;
}

/**
 * 在合成页上画引线与端点圆点；由 `page.evaluate(drawLeaderLines)` 调用。
 *
 * 【为什么不写成 setContent 里的内联 <script>】
 * 2026-11-28 UI/UX 终审发现 ②③④⑤ 四张只有气泡、没有引线和白点，① 正常。
 * 根因：五张图复用同一个 page，`setContent()` 换内容时 Chromium 对**内联
 * script 只在第一次执行** ⇒ 第 2–5 张静默少画了引线，而成品尺寸、页脚版本
 * 都照常正确，任何既有判据都发现不了。⇒ 画线改为显式 evaluate 调用，
 * 与 setContent 的执行细节解耦；并且每张图用新页面（见 composeAll）。
 */
function drawLeaderLines() {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svg = document.querySelector('svg.leaders');
  const drawn = [];
  for (const el of document.querySelectorAll('.pill')) {
    const r = el.getBoundingClientRect();
    const ax = +el.dataset.ax;
    const ay = +el.dataset.ay;
    // 从离锚点最近的一条边出发
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = ax - cx;
    const dy = ay - cy;
    let sx, sy;
    if (Math.abs(dx) > Math.abs(dy)) {
      sx = dx > 0 ? r.right : r.left;
      sy = cy;
    } else {
      sx = cx;
      sy = dy > 0 ? r.bottom : r.top;
    }
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', sx);
    line.setAttribute('y1', sy);
    line.setAttribute('x2', ax);
    line.setAttribute('y2', ay);
    line.setAttribute('stroke', '#0B1B33');
    line.setAttribute('stroke-width', '1.6');
    line.setAttribute('opacity', '.72');
    svg.appendChild(line);
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', ax);
    dot.setAttribute('cy', ay);
    dot.setAttribute('r', '4.5');
    dot.setAttribute('fill', '#fff');
    dot.setAttribute('stroke', '#0B1B33');
    dot.setAttribute('stroke-width', '2');
    svg.appendChild(dot);
    // 回传实测落点（回执要贴；也用于人工核对 UI/UX 的验收点）
    drawn.push({
      text: el.textContent,
      anchor: { x: ax, y: ay },
      start: { x: sx, y: sy },
      pill: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    });
  }
  return drawn;
}

/** 读 PNG IHDR 里的宽高（产物自证，不靠外部工具）。 */
function pngSize(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function composeAll(entries) {
  // 合成用独立浏览器（1x 设备像素）：成品就是 1280×800，
  // 不做二次缩放；原图本身是 2x，嵌到 960px 窗口由浏览器高质量降采样。
  //
  // ⚠️ **每张图一个新页面**：复用同一 page 时，第二次 setContent 的内联
  // script 不会执行（Chromium 只在文档首次加载时跑内联脚本）⇒ 只有第一张
  // 画出引线。同时画线改由 evaluate 驱动，不依赖内联脚本。
  const browser = await chromium.launch({ headless: true });
  try {
    for (const entry of entries) {
      const page = await browser.newPage({ viewport: CANVAS, deviceScaleFactor: 1 });
      try {
        const imageDataUrl = `data:image/png;base64,${readFileSync(entry.rawPath).toString('base64')}`;
        const html = composeHtml({
          title: entry.title,
          subtitle: entry.subtitle,
          imageDataUrl,
          pills: entry.pills.map(p => ({ ...p, anchor: entry.anchors[p.anchor] })),
        });
        await page.setContent(html, { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);
        // 等图片解码完再截（和原图那条 favicon 判据同一个道理）
        await page.waitForFunction(() => {
          const img = document.querySelector('.win img');
          return !!img && img.complete && img.naturalWidth > 0;
        });
        const leaders = await page.evaluate(drawLeaderLines);

        // ── 产物自证：白点数必须等于气泡数 ──────────────────────────────
        // 这次的事故就是「引线静默没画出来」混进了最终套：成品照样 1280×800、
        // 页脚照样 v1.33.0，只有肉眼能发现。⇒ 判据必须落在合成结果上，
        // 不许只信「脚本跑完了」。
        const dots = await page.evaluate(
          () => document.querySelectorAll('svg.leaders circle').length
        );
        if (dots !== entry.pills.length) {
          throw new Error(
            `${entry.name}: 合成后引线端点圆点 ${dots} 个 ≠ 气泡 ${entry.pills.length} 个` +
              ' —— 引线没画出来，这张图不许出'
          );
        }
        // 白点还必须落在气泡**之外**：被气泡盖住的白点等于没画（图上看不见，
        // 但 DOM 里数得到 —— 只数个数发现不了这一类）。
        for (const l of leaders) {
          const covered =
            l.anchor.x > l.pill.left &&
            l.anchor.x < l.pill.right &&
            l.anchor.y > l.pill.top &&
            l.anchor.y < l.pill.bottom;
          if (covered) {
            throw new Error(
              `${entry.name}: 白点 (${l.anchor.x.toFixed(1)}, ${l.anchor.y.toFixed(1)})` +
                ` 落在气泡「${l.text}」内部 —— 会被气泡盖住`
            );
          }
        }

        await page.waitForTimeout(200);
        const outPath = join(OUT_DIR, `${entry.name}.png`);
        await page.screenshot({ path: outPath });
        const { width, height } = pngSize(readFileSync(outPath));
        if (width !== 1280 || height !== 800) {
          throw new Error(`${entry.name}.png 成品是 ${width}×${height}，CWS 要求 1280×800`);
        }
        console.log(`✅ ${entry.name}.png（1280×800，白点 ${dots}/${entry.pills.length}）`);
        for (const l of leaders) {
          console.log(
            `   · 「${l.text}」白点 (${l.anchor.x.toFixed(1)}, ${l.anchor.y.toFixed(1)})` +
              ` ← 引线起点 (${l.start.x.toFixed(1)}, ${l.start.y.toFixed(1)})`
          );
        }
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const rawDir = mkdtempSync(join(tmpdir(), 'tapstack-store-raw-'));
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-shot-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: VIEWPORT,
    // 原图 2x：放进 0.75 窗口后 UI 文字仍由足够像素降采样，页脚 9px 才读得清
    deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--lang=zh-CN'],
  });

  const entries = [];
  try {
    // SW 是异步注册的，轮询等它出现（冷启动可能要几秒）
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await new Promise(r => setTimeout(r, 500));
    }
    if (!sw) throw new Error('15s 内未找到扩展 service worker');
    const id = new URL(sw.url()).host;

    for (const scenario of SCENARIOS) {
      const { rawPath, anchors } = await captureRaw(ctx, id, scenario, rawDir);
      entries.push({ ...scenario, rawPath, anchors });
    }
  } finally {
    await ctx.close();
  }

  await composeAll(entries);
  console.log(`\n完成：${entries.length} 张 → ${OUT_DIR}（dist manifest version = ${DIST_VERSION}）`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
