// 第 43 轮 · 视觉 / 可访问性真机验证（2026-10-23 审计 V-1 / V-2 / V-4 / V-5）
//
// 为什么必须真机：Chrome 扩展的 popup 无法直接预览，光改源码 + 跑 build
// **证明不了任何事**。本脚本用真实 Chromium 载入 dist 扩展，验证四件
// 只能在真实渲染里测的事：
//
//   ① claude 主题下引导页主按钮的**计算样式**不再是紫蓝渐变
//      （getComputedStyle 读 background / backgroundImage，必须等于
//       该主题的 --color-accent）
//   ② apple 深色主题下弹窗焦点环的计算色 == 该主题的 --color-focus-ring
//      （且对弹窗底色的对比度 ≥ 3:1，WCAG 2.2 非文本对比）
//   ③ 320px 视口下「显示筛选」按钮高度 ≥ 36px（仓内口径 MIN_HIT_TARGET_PX）
//   ④ 320px 视口下品牌按钮宽度 ≥ 36px
//
// 外加：六套主题 × 明暗的引导页主按钮底色**各不相同**（证明真的跟主题走了，
// 而不是「六套主题碰巧一样」）。
//
// 用法：先 `pnpm build`，再 `node scripts/_v43-probe-ui-visual.mjs`
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/v43');

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

// ── 颜色解析（支持 #rgb / #rrggbb / #rrggbbaa / rgb() / rgba() / rgb 空格语法）──
function parseColor(value) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (v.startsWith('#')) {
    let h = v.slice(1);
    if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = i => parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return { r: n(0), g: n(1), b: n(2), a: h.length === 8 ? n(3) / 255 : 1 };
  }
  const m = v.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(/[,\s/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const num = p => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p));
    return {
      r: num(parts[0]),
      g: num(parts[1]),
      b: num(parts[2]),
      a: parts[3] === undefined ? 1 : (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])),
    };
  }
  return null;
}

/** 同一个 rgb 值在 1 与 2 的容差内视为相等（避免小数舍入误差）。 */
function sameColor(a, b, tol = 2) {
  if (!a || !b) return false;
  return Math.abs(a.r - b.r) < tol && Math.abs(a.g - b.g) < tol && Math.abs(a.b - b.b) < tol;
}

/** 把半透明前景合成到不透明底色上（prism 的 --color-bg-elevated 是 rgba(...)）。 */
function composite(fg, bg) {
  if (!fg) return null;
  if (fg.a === undefined || fg.a >= 1) return { r: fg.r, g: fg.g, b: fg.b, a: 1 };
  const under = bg ?? { r: 255, g: 255, b: 255, a: 1 };
  const a = fg.a;
  return {
    r: fg.r * a + under.r * (1 - a),
    g: fg.g * a + under.g * (1 - a),
    b: fg.b * a + under.b * (1 - a),
    a: 1,
  };
}

function luminance({ r, g, b }) {
  const f = v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  if (!a || !b) return NaN;
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES = ['legacy', 'creamy', 'prism', 'claude', 'apple', 'chrome'];

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-v43-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    // 用 Playwright 自带的 Chromium（Chrome for Testing）——
    // 系统 Chrome 137+ 已经不再允许 --load-extension 载入未打包扩展。
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
    if (!sw) throw new Error('15s 内未找到扩展 service worker');
    const id = new URL(sw.url()).host;
    console.log('扩展 ID:', id);

    const page = await ctx.newPage();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(String(e)));

    const popupUrl = `chrome-extension://${id}/src/popup/index.html`;

    /**
     * 强制切主题。
     *
     * 坑：应用自己在 ThemeContext 里 `document.documentElement.dataset.theme = themeStyle`，
     * 而那个 effect 的依赖是 `[themeStyle, settingsReady]` —— settingsReady 会在
     * 设置从 storage 读回来之后才翻 true ⇒ **它会在我们设完主题之后把主题改回去**。
     * 冷启动时这个 effect 尤其晚（第一版探针就在这里读到了 data-theme=legacy）。
     *
     * ⇒ 做法：先等应用的主题**稳定**（连续 700ms 不再变），再设我们的；
     * 设完等 250ms 的主题过渡跑完，再**回读**确认没被抢回去；被抢了就重来。
     */
    async function applyTheme(p, theme, dark) {
      // ① 等应用自己稳定下来
      let last = null;
      let stableSince = Date.now();
      for (let i = 0; i < 60; i++) {
        const cur = await p.evaluate(() => document.documentElement.dataset.theme || '');
        if (cur && cur === last) {
          if (Date.now() - stableSince >= 700) break;
        } else {
          last = cur;
          stableSince = Date.now();
        }
        await p.waitForTimeout(100);
      }
      // ② 设我们的主题 + 等过渡跑完 + 回读
      for (let attempt = 0; attempt < 6; attempt++) {
        await p.evaluate(({ theme, dark }) => {
          const root = document.documentElement;
          if (root.dataset.theme !== theme) root.dataset.theme = theme;
          root.classList.toggle('dark', dark);
        }, { theme, dark });
        // 主题切换有 250ms 的颜色过渡（--theme-transition-duration）⇒
        // 设完必须**等过渡跑完**再读计算样式，否则读到的是动画中间值
        // （第一版探针就在这里读到 rgb(190,96,68) 而不是 claude 的 #c2603f）。
        await p.waitForTimeout(450);
        const current = await p.evaluate(() => ({
          theme: document.documentElement.dataset.theme,
          dark: document.documentElement.classList.contains('dark'),
        }));
        if (current.theme === theme && current.dark === dark) return true;
      }
      return false;
    }

    /** 读当前页面 <html> 上的主题令牌（令牌定义在 html[data-theme] / html.dark 上）。 */
    async function readTokens(p) {
      return p.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const pick = n => root.getPropertyValue(n).trim();
        return {
          dataTheme: document.documentElement.dataset.theme || '',
          dark: document.documentElement.classList.contains('dark'),
          accent: pick('--color-accent'),
          accentFg: pick('--color-accent-fg'),
          focusRing: pick('--color-focus-ring'),
          bgElevated: pick('--color-bg-elevated'),
          bgPrimary: pick('--color-bg-primary'),
          bgSecondary: pick('--color-bg-secondary'),
        };
      });
    }

    // ────────────────────────────────────────────────────────────────────
    // ① claude 主题的引导页主按钮：计算样式必须是 --color-accent
    // ────────────────────────────────────────────────────────────────────
    await page.goto(popupUrl);
    await page.waitForSelector('#root', { timeout: 15000 });

    // 引导的闸门是 chrome.storage.local 里的 onboarding_state（见
    // src/utils/onboardingStorage.ts）—— localStorage 里没有 ⇒ 之前那句
    // localStorage.removeItem 是无效的，必须写 storage.local。
    async function setOnboardingState(force) {
      await page.evaluate(async (force) => {
        if (force) {
          await chrome.storage.local.remove('onboarding_state');
          await chrome.storage.local.set({
            onboarding_trigger: { reason: 'install', previousVersion: '1.25.0' },
          });
        } else {
          await chrome.storage.local.set({
            onboarding_state: {
              hasCompletedOnboarding: true,
              lastOnboardingVersion: '1.26.0',
              completedAt: new Date().toISOString(),
            },
          });
          await chrome.storage.local.remove('onboarding_trigger');
        }
      }, force);
    }

    async function openOnboarding(theme, dark) {
      await setOnboardingState(true);
      await page.reload();
      await page.waitForSelector('#root', { timeout: 15000 });
      await page.waitForSelector('.onboarding-btn-primary', { timeout: 8000 }).catch(() => null);
      // 有头模式下**系统真实光标**会在窗口上产生 hover ⇒ 按钮会读到
      // `--color-accent-hover` 而不是 `--color-accent`（第一版探针就踩了这个：
      // 六套主题全部读成 hover 色）。把鼠标挪走再量。
      await page.mouse.move(0, 0);
      await applyTheme(page, theme, dark);
      await page.mouse.move(0, 0);
      await page.waitForTimeout(120);
      return page.locator('.onboarding-btn-primary').count();
    }

    const claudeBtn = await openOnboarding('claude', false);
    check('① claude 主题下引导页出现', claudeBtn > 0, `找到 ${claudeBtn} 个主按钮`);

    const claudeProbe = await page.evaluate(() => {
      const btn = document.querySelector('.onboarding-btn-primary');
      if (!btn) return null;
      const cs = getComputedStyle(btn);
      const root = getComputedStyle(document.documentElement);
      return {
        dataTheme: document.documentElement.dataset.theme,
        background: cs.backgroundColor,
        backgroundImage: cs.backgroundImage,
        color: cs.color,
        hovered: btn.matches(':hover'),
        accent: root.getPropertyValue('--color-accent').trim(),
        accentFg: root.getPropertyValue('--color-accent-fg').trim(),
      };
    });
    console.log('   claude 主按钮计算样式:', JSON.stringify(claudeProbe, null, 2));

    const claudeAccent = parseColor(claudeProbe?.accent ?? '');
    const claudeBtnBg = parseColor(claudeProbe?.background ?? '');
    check(
      '① claude 引导主按钮底色 == --color-accent（不再是紫蓝渐变）',
      claudeProbe?.hovered !== true && sameColor(claudeBtnBg, claudeAccent),
      `按钮 ${claudeProbe?.background} vs accent ${claudeProbe?.accent}（当前 data-theme=${claudeProbe?.dataTheme}）`,
    );
    check(
      '① claude 引导主按钮没有 backgroundImage 渐变',
      claudeProbe?.backgroundImage === 'none',
      `backgroundImage = ${claudeProbe?.backgroundImage}`,
    );
    const accentFg = parseColor(claudeProbe?.accentFg ?? '');
    const btnFg = parseColor(claudeProbe?.color ?? '');
    check(
      '① claude 引导主按钮文字色 == --color-accent-fg（墨色随主题）',
      sameColor(btnFg, accentFg),
      `按钮 color = ${claudeProbe?.color}，--color-accent-fg = ${claudeProbe?.accentFg}`,
    );

    // 六套主题的引导主按钮底色**各不相同** ⇒ 证明真的跟主题走了
    const perTheme = [];
    for (const theme of THEMES) {
      await openOnboarding(theme, false);
      const c = await page.evaluate(() => {
        const btn = document.querySelector('.onboarding-btn-primary');
        if (!btn) return null;
        const cs = getComputedStyle(btn);
        const root = getComputedStyle(document.documentElement);
        return {
          dataTheme: document.documentElement.dataset.theme,
          bg: cs.backgroundColor,
          accent: root.getPropertyValue('--color-accent').trim(),
          accentHover: root.getPropertyValue('--color-accent-hover').trim(),
          hovered: btn.matches(':hover'),
          img: cs.backgroundImage,
        };
      });
      if (c) perTheme.push({ theme, ...c });
    }
    const uniqueBg = new Set(perTheme.map(t => t.bg));
    console.log('   六套主题引导主按钮底色:', perTheme.map(t => `${t.theme}=${t.bg}`).join('  '));
    check(
      '① 六套主题的引导主按钮底色各不相同（真的跟主题走）',
      uniqueBg.size >= 5,
      `${uniqueBg.size} 个不同底色 / ${perTheme.length} 套主题`,
    );
    check(
      '① 六套主题的引导主按钮都没有 backgroundImage 渐变',
      perTheme.every(t => t.img === 'none'),
      perTheme.filter(t => t.img !== 'none').map(t => `${t.theme}:${t.img}`).join(' | ') || '全部为 none',
    );
    check(
      '① 六套主题的引导主按钮底色 == 各自 --color-accent',
      perTheme.every(t => t.hovered !== true && sameColor(parseColor(t.bg), parseColor(t.accent))),
      perTheme.filter(t => !sameColor(parseColor(t.bg), parseColor(t.accent)))
        .map(t => `${t.theme}:${t.bg}≠${t.accent}`).join(' | ') || '全部相等',
    );
    writeFileSync(join(OUT_DIR, 'probe-onboarding-per-theme.json'), JSON.stringify(perTheme, null, 2));

    // ────────────────────────────────────────────────────────────────────
    // ② apple 深色主题：弹窗焦点环的计算色 == --color-focus-ring
    // ────────────────────────────────────────────────────────────────────
    const opt = await ctx.newPage();
    await opt.setViewportSize({ width: 1280, height: 900 });
    await opt.goto(`chrome-extension://${id}/src/options/index.html`);
    await opt.waitForSelector('#root', { timeout: 15000 });
    await opt.waitForTimeout(1500);
    await applyTheme(opt, 'apple', true);

    // 用**真键盘** Tab 让 :focus-visible 真的匹配上（程序化 .focus() 不算）。
    await opt.keyboard.press('Tab');
    await opt.keyboard.press('Tab');
    const ringProbe = await opt.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const root = getComputedStyle(document.documentElement);
      return {
        focusRingToken: root.getPropertyValue('--color-focus-ring').trim(),
        outlineColor: cs.outlineColor,
        outlineStyle: cs.outlineStyle,
        outlineWidth: cs.outlineWidth,
        outlineOffset: cs.outlineOffset,
        matchesFocusVisible: el.matches(':focus-visible'),
        tag: el.tagName,
        btnLabel: (el.textContent || '').trim().slice(0, 20),
      };
    });
    console.log('   apple 深色焦点环:', JSON.stringify(ringProbe, null, 2));

    const ringTokenRgb = parseColor(ringProbe?.focusRingToken ?? '');
    const ringActual = parseColor(ringProbe?.outlineColor ?? '');
    check(
      '② apple 深色弹窗焦点环的计算色 == --color-focus-ring',
      sameColor(ringActual, ringTokenRgb),
      `outline-color = ${ringProbe?.outlineColor}，令牌 = ${ringProbe?.focusRingToken}（:focus-visible=${ringProbe?.matchesFocusVisible}）`,
    );
    check(
      '② apple 深色焦点环是 2px 实线 + 2px offset',
      ringProbe?.outlineStyle === 'solid' &&
        parseFloat(ringProbe?.outlineWidth ?? '0') >= 2 &&
        parseFloat(ringProbe?.outlineOffset ?? '0') >= 2,
      `style=${ringProbe?.outlineStyle} width=${ringProbe?.outlineWidth} offset=${ringProbe?.outlineOffset}`,
    );
    check(
      '② 焦点确实落在 :focus-visible 上（否则上面的读数没有意义）',
      ringProbe?.matchesFocusVisible === true,
      `activeElement = ${ringProbe?.tag} ${ringProbe?.btnLabel}`,
    );

    // 焦点环 vs 弹窗底色的对比度（WCAG 2.2 非文本对比 ≥ 3:1）
    const panelRing = await readTokens(opt);
    const elevatedRaw = parseColor(panelRing.bgElevated);
    const primaryRaw = parseColor(panelRing.bgPrimary);
    // 弹层底是半透明的（prism 是 rgba(...)）⇒ 合成到页面底上才是真实观感
    const elevated = composite(elevatedRaw, primaryRaw);
    const ringVsElevated = contrast(ringTokenRgb, elevated);
    const ringVsPrimary = contrast(ringTokenRgb, primaryRaw);
    console.log(
      `   apple 深色：焦点环 vs 弹层底 = ${ringVsElevated.toFixed(2)}:1；vs 页面底 = ${ringVsPrimary.toFixed(2)}:1`,
    );
    check(
      '② apple 深色焦点环对弹层底色 ≥ 3:1（WCAG 2.2 非文本对比）',
      ringVsElevated >= 3,
      `${ringVsElevated.toFixed(2)}:1`,
    );
    check(
      '② apple 深色焦点环对页面底色 ≥ 3:1',
      ringVsPrimary >= 3,
      `${ringVsPrimary.toFixed(2)}:1`,
    );
    writeFileSync(join(OUT_DIR, 'probe-focus-ring-apple-dark.json'), JSON.stringify({ ringProbe, panelRing, ringVsElevated, ringVsPrimary }, null, 2));

    // 六套主题 × 明暗的焦点环对「弹层底」的对比度复测
    const ringTable = [];
    for (const theme of THEMES) {
      for (const dark of [false, true]) {
        await applyTheme(opt, theme, dark);
        const t = await readTokens(opt);
        ringTable.push({ theme, dark, ...t });
      }
    }
    const ringRows = ringTable.map(r => {
      const prim = parseColor(r.bgPrimary);
      const elev = composite(parseColor(r.bgElevated), prim);
      return {
        ...r,
        vsElevated: Number(contrast(parseColor(r.focusRing), elev).toFixed(2)),
        vsPrimary: Number(contrast(parseColor(r.focusRing), prim).toFixed(2)),
      };
    });
    console.log('\n   焦点环对比度复测（12 组）：');
    for (const r of ringRows) {
      console.log(
        `     ${r.theme.padEnd(7)} ${r.dark ? 'dark ' : 'light'} 环=${r.focusRing.padEnd(8)} vs 弹层底 ${String(r.vsElevated).padStart(5)}:1  vs 页面底 ${String(r.vsPrimary).padStart(5)}:1`,
      );
    }
    const worstElevated = Math.min(...ringRows.map(r => r.vsElevated));
    const worstPrimary = Math.min(...ringRows.map(r => r.vsPrimary));
    check(
      '② 12 组焦点环对弹层底全部 ≥ 3:1',
      worstElevated >= 3,
      `最差 ${worstElevated}:1`,
    );
    check(
      '② 12 组焦点环对页面底全部 ≥ 3:1',
      worstPrimary >= 3,
      `最差 ${worstPrimary}:1`,
    );
    writeFileSync(join(OUT_DIR, 'probe-focus-ring-matrix.json'), JSON.stringify(ringRows, null, 2));

    // ────────────────────────────────────────────────────────────────────
    // ③ 320px 视口：「显示筛选」按钮高度 ≥ 36px
    // ────────────────────────────────────────────────────────────────────
    // 引导会盖住整个 popup ⇒ 先把「已看过引导」写上再进 popup。
    await page.goto(popupUrl);
    await page.waitForSelector('#root', { timeout: 15000 });
    await setOnboardingState(false);
    // 「显示筛选」这一条工具条只在**有会话**时渲染（TabList 在
    // `filteredGroups.length === 0 && viewMode === 'list'` 时先返回空态，
    // 见 src/components/tabs/TabList.tsx:371）⇒ 种一条最小会话。
    //
    // 注意：会话存在 **IndexedDB** 里（storage-kv 的 driver 是 indexeddb，
    // 见 src/storage-kv/storageAdapter.ts:283），不是 chrome.storage.local ⇒
    // 写 chrome.storage.local 是不生效的（第一版探针就踩了这个坑）。
    await page.evaluate(async () => {
      const now = new Date().toISOString();
      const value = [
        {
          id: 'v43-probe-group',
          name: '探针会话',
          tabs: [
            {
              id: 'v43-probe-tab',
              title: '探针标签',
              url: 'https://example.com/',
              favicon: '',
              lastAccessed: now,
              createdAt: now,
              pinned: false,
            },
          ],
          createdAt: now,
          updatedAt: now,
          isLocked: false,
        },
      ];
      await new Promise((resolve, reject) => {
        const req = indexedDB.open('tabvaultpro', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
        };
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put({ key: 'tab_groups', value });
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => { db.close(); reject(tx.error); };
        };
      });
    });
    await page.setViewportSize({ width: 320, height: 640 });
    await page.reload();
    await page.waitForSelector('#root', { timeout: 15000 });
    await page.waitForTimeout(1500);

    const filterProbe = await page.evaluate(() => {
      const all = [...document.querySelectorAll('button')];
      const btn = all.find(b => /筛选/.test(b.textContent || ''));
      if (!btn) return { found: false, buttons: all.map(b => (b.textContent || '').trim()).slice(0, 20) };
      const r = btn.getBoundingClientRect();
      const cs = getComputedStyle(btn);
      return {
        found: true,
        text: (btn.textContent || '').trim(),
        width: Number(r.width.toFixed(1)),
        height: Number(r.height.toFixed(1)),
        whiteSpace: cs.whiteSpace,
        minHeight: cs.minHeight,
      };
    });
    console.log('   320px「显示筛选」:', JSON.stringify(filterProbe, null, 2));
    check(
      '③ 320px 下「显示筛选」按钮高度 ≥ 36px',
      filterProbe?.found === true && filterProbe.height >= 36,
      filterProbe?.found ? `${filterProbe.width}×${filterProbe.height}（min-height=${filterProbe.minHeight}）` : '没找到按钮',
    );
    check(
      '③ 320px 下「显示筛选」按钮不折行（whitespace-nowrap）',
      filterProbe?.found === true && filterProbe.whiteSpace === 'nowrap',
      `white-space = ${filterProbe?.whiteSpace}`,
    );
    writeFileSync(join(OUT_DIR, 'probe-filter-320.json'), JSON.stringify(filterProbe, null, 2));

    // ────────────────────────────────────────────────────────────────────
    // ④ 320px 视口：品牌按钮宽度 ≥ 36px
    // ────────────────────────────────────────────────────────────────────
    const brandProbe = await page.evaluate(() => {
      const el = document.querySelector('.app-header-brand');
      if (!el) return { found: false };
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        found: true,
        width: Number(r.width.toFixed(1)),
        height: Number(r.height.toFixed(1)),
        minWidth: cs.minWidth,
        justifyContent: cs.justifyContent,
      };
    });
    console.log('   320px 品牌按钮:', JSON.stringify(brandProbe, null, 2));
    check(
      '④ 320px 下品牌按钮宽度 ≥ 36px',
      brandProbe?.found === true && brandProbe.width >= 36,
      `${brandProbe?.width}×${brandProbe?.height}（min-width=${brandProbe?.minWidth}）`,
    );
    check(
      '④ 320px 下品牌按钮居中（退化成一个图标按钮）',
      brandProbe?.justifyContent === 'center',
      `justify-content = ${brandProbe?.justifyContent}`,
    );
    writeFileSync(join(OUT_DIR, 'probe-brand-320.json'), JSON.stringify(brandProbe, null, 2));
    await page.screenshot({ path: join(OUT_DIR, 'popup-320px.png') });

    // ────────────────────────────────────────────────────────────────────
    // ⑤ V-3：HeaderDropdown 菜单里的文字色跟主题走
    // ────────────────────────────────────────────────────────────────────
    const menuProbe = await page.evaluate(async () => {
      const trigger = [...document.querySelectorAll('button')].find(b =>
        /菜单|menu|更多|设置/i.test(b.getAttribute('aria-label') || b.title || ''),
      );
      if (!trigger) return { found: false };
      trigger.click();
      await new Promise(r => setTimeout(r, 300));
      const row = document.querySelector('.ts-panel');
      if (!row) return { found: false, clicked: true };
      const cs = getComputedStyle(row);
      const root = getComputedStyle(document.documentElement);
      return {
        found: true,
        text: (row.textContent || '').trim().slice(0, 40),
        color: cs.color,
        textPrimary: root.getPropertyValue('--color-text-primary').trim(),
        bg: cs.backgroundColor,
        bgElevated: root.getPropertyValue('--color-bg-elevated').trim(),
        border: cs.borderColor,
      };
    });
    console.log('   菜单文字色:', JSON.stringify(menuProbe, null, 2));
    if (menuProbe?.found) {
      check(
        '⑤ 菜单文字色 == --color-text-primary（V-3）',
        sameColor(parseColor(menuProbe.color), parseColor(menuProbe.textPrimary)),
        `菜单 color = ${menuProbe.color}，令牌 = ${menuProbe.textPrimary}`,
      );
    } else {
      check('⑤ 菜单文字色 == --color-text-primary（V-3）', false, '没找到菜单');
    }
    writeFileSync(join(OUT_DIR, 'probe-menu-text.json'), JSON.stringify(menuProbe, null, 2));

    console.log('\n页面错误:', errors.length ? errors.slice(0, 5).join('\n') : '（无）');

    const passed = results.filter(r => r.pass).length;
    const failed = results.length - passed;
    console.log(`\n═══ 结果：${passed}/${results.length} 通过 ═══`);
    if (failed) {
      console.log('未通过：');
      for (const r of results.filter(x => !x.pass)) console.log(`  ❌ ${r.name} — ${r.detail}`);
    }
    writeFileSync(
      join(OUT_DIR, 'probe-ui-visual.json'),
      JSON.stringify({ results, passed, failed, errors }, null, 2),
    );
    process.exitCode = failed ? 1 : 0;
  } finally {
    await ctx.close();
  }
}

main().catch(err => {
  console.error('探针失败:', err);
  process.exitCode = 2;
});
