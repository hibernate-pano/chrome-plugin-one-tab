// 可访问性实测 —— 每条都量出数字，不靠猜。
// 用法：pnpm build 之后 `node scripts/prod-a11y.mjs`

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/prod-a11y');
const now = Date.now();
const iso = ms => new Date(ms).toISOString();

function mkGroup(name, { locked = false, order, ageHours, tabs }) {
  const id = crypto.randomUUID();
  return {
    id, name, notes: '', isFavorite: false, isLocked: locked, isDeleted: false,
    tabs: tabs.map(([url, title]) => ({
      id: crypto.randomUUID(), url, title,
      favicon: `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`,
      createdAt: iso(now - ageHours * 3600e3), lastAccessed: iso(now - ageHours * 3600e3),
      group_id: id, pinned: false,
    })),
    createdAt: iso(now - ageHours * 3600e3), updatedAt: iso(now - (ageHours - 0.5) * 3600e3),
    version: 1, displayOrder: order, lastOp: { d: 'demo', s: order },
  };
}

const groups = [
  mkGroup('研究资料', { order: 1, ageHours: 2, tabs: [
    ['https://arxiv.org/abs/1706.03762', 'Attention Is All You Need'],
    ['https://arxiv.org/abs/1512.03385', 'ResNet'],
  ]}),
  mkGroup('锁定项目', { order: 2, ageHours: 40, locked: true, tabs: [
    ['https://example.com/roadmap', '产品路线图'],
  ]}),
];

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

/** 计算 WCAG 对比度 */
const CONTRAST_FN = `
function _lum(rgb) {
  const c = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function _ratio(fg, bg) {
  const l1 = _lum(fg), l2 = _lum(bg);
  const a = Math.max(l1, l2), b = Math.min(l1, l2);
  return (a + 0.05) / (b + 0.05);
}
function _parse(c) {
  const m = c.match(/[\\d.]+/g);
  if (!m) return null;
  const alpha = m.length > 3 ? parseFloat(m[3]) : 1;
  return [parseFloat(m[0]), parseFloat(m[1]), parseFloat(m[2]), alpha];
}
function _hasGradient(cs) {
  const bi = cs.backgroundImage;
  return !!(bi && bi !== 'none' && /gradient/i.test(bi));
}
// 2026-10-20 修两处测量错误：
//  ① 半透明底色必须**叠到父表面上**再算 —— 原实现直接拿 rgba 的 RGB 当实色用，
//     于是「rgba(148,163,184,0.12) 的徽章 + 同色文字」被算成 1:1（假的）。
//  ② 渐变底（linear-gradient）脚本解析不出真实底色 ⇒ 单独标成「需人工判断」，
//     不再混进「低于 AA」的清单里充数（creamy/prism 的 .tab-group-count 徽章
//     与 .btn-primary 就是这种，白字压橙底其实没问题）。
function _effectiveBg(el) {
  const stack = [];
  let n = el;
  let gradient = false;
  while (n && n !== document.documentElement) {
    const cs = getComputedStyle(n);
    if (_hasGradient(cs)) { gradient = true; break; }
    const p = _parse(cs.backgroundColor);
    // 2026-10-20 修：跳过条件原先是 (p[0]>0 || p[1]>0 || p[2]>0)，
    // 那是想排除「全透明」，但**不透明的纯黑**（apple 深色 body = #000000）
    // 也会被跳过 ⇒ 半透明的 .app-shell 只能叠到默认白底上，
    // 于是「#98989d 压 rgb(69,69,70) = 3.35:1」是**假的**（真实 6.54:1）。
    // 正确的判据只看 alpha：alpha=0 才算没有底色。
    if (p && p[3] > 0) {
      stack.push(p);
      if (p[3] >= 1) break;
    }
    n = n.parentElement;
  }
  if (gradient) return { rgb: null, gradient: true };
  let base = [255, 255, 255];
  for (let i = stack.length - 1; i >= 0; i--) {
    const s = stack[i];
    base = [
      s[0] * s[3] + base[0] * (1 - s[3]),
      s[1] * s[3] + base[1] * (1 - s[3]),
      s[2] * s[3] + base[2] * (1 - s[3]),
    ];
  }
  return { rgb: base, gradient: false };
}
function contrastOf(el) {
  const cs = getComputedStyle(el);
  const fg = _parse(cs.color);
  if (!fg) return null;
  const bg = _effectiveBg(el);
  if (bg.gradient || !bg.rgb) return { gradient: true, fg: cs.color, ratio: null, bg: '(渐变底，需人工判断)' };
  return { ratio: Math.round(_ratio(fg, bg.rgb) * 100) / 100, fg: cs.color, bg: 'rgb(' + bg.rgb.slice(0,3).map(v => Math.round(v)).join(',') + ')', gradient: false };
}
`;

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-a11y-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--lang=zh-CN'],
  });
  const out = {};
  try {
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) { sw = ctx.serviceWorkers()[0] ?? null; if (!sw) await new Promise(r => setTimeout(r, 500)); }
    const id = new URL(sw.url()).host;

    const page = await ctx.newPage();
    await page.setViewportSize({ width: 400, height: 600 });
    await page.goto(`chrome-extension://${id}/src/popup/index.html`);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
    await inject(page, groups);
    await page.reload();
    await page.waitForSelector('text=研究资料', { timeout: 15000 });
    await page.waitForTimeout(1200);

    // ══ 1. 焦点顺序：页头是否在 Tab 链首位 ══
    console.log('\n── 1. 焦点顺序 ──');
    await page.evaluate(() => document.body.focus());
    const chain = [];
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return { tag: 'BODY', label: '(body)' };
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          label: (el.getAttribute('aria-label') || el.textContent?.trim() || el.getAttribute('placeholder') || '').slice(0, 34),
          y: Math.round(r.top),
        };
      });
      chain.push(info);
    }
    out.focusChain = chain;
    chain.forEach((c, i) => console.log(`  ${String(i + 1).padStart(2)}. [y=${String(c.y).padStart(4)}] ${c.tag} "${c.label}"`));
    const headerIdx = chain.findIndex(c => c.label.includes('搜索会话') || c.label.includes('保存当前窗口') || c.label.includes('回到默认'));
    const listIdx = chain.findIndex(c => c.label.includes('打开标签页'));
    console.log(`  → 页头首个可聚焦元素在第 ${headerIdx + 1} 位；列表首个在第 ${listIdx + 1} 位`);
    out.focusOrderIssue = { headerIdx: headerIdx + 1, listIdx: listIdx + 1 };

    // ══ 2. 焦点可见性 ══
    console.log('\n── 2. 焦点可见性 ──');
    // ⚠️ 2026-10-20 修：这段原来用 `el.focus()`（程序化聚焦）。
    // 程序化聚焦**不触发 :focus-visible** ⇒ 读到的永远是浏览器默认的近黑焦点环
    // （rgb(17,24,39)），测到的根本不是本仓的焦点环规则。
    // 现在改用**真实键盘 Tab**（与上面焦点链同一手法），并等 transition 走完再读
    // （.input 有 transition-all duration-150，outline-color/width 会被过渡，
    //  读早了会拿到中间值）。
    await page.evaluate(() => { document.body.setAttribute('tabindex', '-1'); document.body.focus(); });
    let focusRing = null;
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      const hit = await page.evaluate(() => {
        const el = document.activeElement;
        return !!el && el !== document.body && (el.className || '').toString().includes('search-input');
      });
      if (!hit) continue;
      await page.waitForTimeout(500); // 等 transition-all 150ms 结束
      focusRing = await page.evaluate(() => {
        const el = document.activeElement;
        const cs = getComputedStyle(el);
        const parent = el.parentElement;
        const ps = getComputedStyle(parent);
        return {
          focusVisible: (() => { try { return el.matches(':focus-visible'); } catch { return null; } })(),
          outline: cs.outline, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor,
          outlineOffset: cs.outlineOffset,
          boxShadow: cs.boxShadow, parentShadow: ps.boxShadow, parentBorder: ps.borderColor,
          focusRingToken: getComputedStyle(document.documentElement).getPropertyValue('--color-focus-ring'),
        };
      });
      break;
    }
    if (!focusRing) {
      focusRing = { error: 'Tab 链里没找到 .search-input（焦点环无法测量）' };
    }
    console.log('  搜索框聚焦:', JSON.stringify(focusRing, null, 1));
    out.focusRing = focusRing;

    // ══ 3. 全部可交互元素的对比度（当前主题）══
    console.log('\n── 3. 对比度扫描（legacy 浅色）──');
    await page.evaluate(`(() => { ${CONTRAST_FN} window.__c = contrastOf; return true; })()`);
    const lowContrast = await page.evaluate(() => {
      const els = [...document.querySelectorAll('button, a, span, div, h3, p, label, input, summary')];
      const bad = [];
      const gradient = [];
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        // 只看直接含文本的元素
        const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('').trim();
        if (!own) continue;
        const c = window.__c(el);
        if (!c) continue;
        const size = parseFloat(cs.fontSize);
        const weight = parseInt(cs.fontWeight) || 400;
        const large = size >= 24 || (size >= 18.66 && weight >= 700);
        const min = large ? 3 : 4.5;
        const rec = { text: own.slice(0, 30), ratio: c.ratio, need: min, size, color: c.fg, bg: c.bg, cls: (el.className||'').toString().slice(0,45) };
        if (c.gradient) { gradient.push(rec); continue; }
        if (c.ratio < min) bad.push(rec);
      }
      return { bad, gradient };
    });
    console.log('  低于 WCAG AA 的文本:', lowContrast.bad.length);
    lowContrast.bad.forEach(b => console.log(`   ${b.ratio}:1 (需${b.need}) ${b.size}px "${b.text}" fg=${b.color} bg=${b.bg}`));
    if (lowContrast.gradient.length) {
      console.log('  渐变底（脚本解析不出真实底色，需人工判断）:', lowContrast.gradient.length);
      lowContrast.gradient.forEach(b => console.log(`   ? "${b.text}" fg=${b.color} cls=${b.cls}`));
    }
    out.contrastLegacyLight = lowContrast.bad;
    out.contrastLegacyLightGradient = lowContrast.gradient;

    // ══ 4. 切主题再扫 ══
    // 2026-10-20：主题列表补齐到 6 套（原先只有 claude/creamy/apple 三套，
    // chrome 与 prism 根本没被扫过 —— 改 token 之后不能只测三套就下结论）。
    const scanContrast = async () => {
      await page.evaluate(`(() => { ${CONTRAST_FN} window.__c = contrastOf; return true; })()`);
      return page.evaluate(() => {
        const els = [...document.querySelectorAll('button, a, span, div, h3, p, label, input, summary')];
        const bad = [];
        const gradient = [];
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const cs = getComputedStyle(el);
          const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('').trim();
          if (!own) continue;
          const c = window.__c(el);
          if (!c) continue;
          const size = parseFloat(cs.fontSize);
          const weight = parseInt(cs.fontWeight) || 400;
          const large = size >= 24 || (size >= 18.66 && weight >= 700);
          const min = large ? 3 : 4.5;
          const rec = { text: own.slice(0,24), ratio: c.ratio, need: min, size, color: c.fg, bg: c.bg, cls: (el.className||'').toString().slice(0,45) };
          if (c.gradient) { gradient.push(rec); continue; }
          if (c.ratio < min) bad.push(rec);
        }
        return { bad, gradient };
      });
    };
    const setTheme = async (theme, dark) => {
      await page.evaluate(([t, d]) => {
        document.documentElement.setAttribute('data-theme', t);
        document.documentElement.classList.toggle('dark', d);
      }, [theme, dark]);
      await page.waitForTimeout(600);
    };

    for (const theme of ['claude', 'creamy', 'apple', 'chrome', 'prism']) {
      await setTheme(theme, false);
      const { bad, gradient } = await scanContrast();
      console.log(`  [${theme}] 低对比文本: ${bad.length}` + (gradient.length ? `（另有 ${gradient.length} 处渐变底，需人工判断）` : ''));
      bad.slice(0, 8).forEach(b => console.log(`   ${b.ratio}:1 (需${b.need}) "${b.text}" fg=${b.color} bg=${b.bg}`));
      out[`contrast_${theme}`] = bad;
      out[`contrast_${theme}_gradient`] = gradient;
      await page.screenshot({ path: join(OUT_DIR, `theme-${theme}.png`) });
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'legacy'));

    // ══ 5. 暗色模式对比度 ══
    console.log('\n── 4. 暗色模式对比度 ──');
    // 2026-10-20：同样补齐到 6 套主题（原先只扫 legacy 深色）。
    for (const theme of ['legacy', 'claude', 'creamy', 'apple', 'chrome', 'prism']) {
      await setTheme(theme, true);
      const { bad: darkBad, gradient } = await scanContrast();
      console.log(`  [${theme}/dark] 低对比文本: ${darkBad.length}` + (gradient.length ? `（另有 ${gradient.length} 处渐变底，需人工判断）` : ''));
      darkBad.slice(0, 10).forEach(b => console.log(`   ${b.ratio}:1 (需${b.need}) "${b.text}" fg=${b.color} bg=${b.bg}`));
      out[theme === 'legacy' ? 'contrastLegacyDark' : `contrast_${theme}_dark`] = darkBad;
      out[`contrast_${theme}_dark_gradient`] = gradient;
      if (theme === 'legacy') await page.screenshot({ path: join(OUT_DIR, 'theme-legacy-dark.png') });
    }
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'legacy');
      document.documentElement.classList.remove('dark');
    });

    // ══ 6. ARIA 一致性 ══
    console.log('\n── 5. ARIA 一致性 ──');
    const aria = await page.evaluate(() => {
      const issues = [];
      // role=menu 但无 menuitem
      document.querySelectorAll('[role="menu"]').forEach(m => {
        const items = m.querySelectorAll('[role="menuitem"]').length;
        if (items === 0) issues.push({ kind: 'role=menu 无 menuitem', where: m.getAttribute('aria-label') || m.className.slice(0,40) });
      });
      // aria-expanded 与实际不符
      document.querySelectorAll('[aria-expanded]').forEach(el => {
        const exp = el.getAttribute('aria-expanded') === 'true';
        if (el.tagName === 'DETAILS') {
          const det = el.closest('details');
          if (det && det.open !== exp) issues.push({ kind: 'aria-expanded 与 details.open 不符', where: el.getAttribute('aria-label') });
        }
      });
      // 有 aria-label 但无可见文本的图标按钮（需要 title 兜底）
      document.querySelectorAll('button').forEach(b => {
        const label = b.getAttribute('aria-label');
        const title = b.getAttribute('title');
        const text = (b.textContent || '').trim();
        if (!text && !label && !title) issues.push({ kind: '按钮既无 aria-label 也无 title', where: b.className.slice(0,50) });
      });
      // 标题层级
      const h1 = document.querySelectorAll('h1').length;
      const h2 = document.querySelectorAll('h2').length;
      const h3 = document.querySelectorAll('h3').length;
      return { issues, headings: { h1, h2, h3 } };
    });
    console.log('  ARIA 问题:', aria.issues.length);
    aria.issues.forEach(i => console.log(`   ${i.kind}: ${i.where}`));
    console.log('  标题层级:', JSON.stringify(aria.headings));
    out.aria = aria;

    // ══ 7. 语言 / 标题 ══
    const doc = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      title: document.title,
      dir: document.documentElement.dir,
    }));
    console.log('  文档:', JSON.stringify(doc));
    out.doc = doc;

    // ══ 8. 设置页对比度 ══
    // 2026-10-20：设置页原先只扫了「当前主题」一档（legacy 浅色）。D-2 修的正是
    // 设置页的说明文字，而不同主题的底色不同 ⇒ 必须 6 套 × 明暗都扫。
    const opt = await ctx.newPage();
    await opt.setViewportSize({ width: 1280, height: 800 });
    await opt.goto(`chrome-extension://${id}/src/options/index.html`);
    await opt.waitForTimeout(1500);
    const scanOptions = async () => {
      await opt.evaluate(`(() => { ${CONTRAST_FN} window.__c = contrastOf; return true; })()`);
      return opt.evaluate(() => {
        const els = [...document.querySelectorAll('button, a, span, div, h2, h3, p, label, input, select')];
        const bad = [];
        const gradient = [];
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const cs = getComputedStyle(el);
          const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('').trim();
          if (!own) continue;
          const c = window.__c(el);
          if (!c) continue;
          const size = parseFloat(cs.fontSize);
          const weight = parseInt(cs.fontWeight) || 400;
          const large = size >= 24 || (size >= 18.66 && weight >= 700);
          const min = large ? 3 : 4.5;
          const rec = { text: own.slice(0,28), ratio: c.ratio, need: min, size, color: c.fg, bg: c.bg, cls: (el.className||'').toString().slice(0,50) };
          if (c.gradient) { gradient.push(rec); continue; }
          if (c.ratio < min) bad.push(rec);
        }
        return { bad, gradient };
      });
    };
    console.log('\n── 6. 设置页低对比 ──');
    const { bad: optBad, gradient: optGradient } = await scanOptions();
    console.log('  低对比文本:', optBad.length);
    optBad.slice(0, 12).forEach(b => console.log(`   ${b.ratio}:1 (需${b.need}) ${b.size}px "${b.text}" fg=${b.color} bg=${b.bg}`));
    out.contrastOptions = optBad;
    out.contrastOptionsGradient = optGradient;
    for (const theme of ['legacy', 'claude', 'creamy', 'apple', 'chrome', 'prism']) {
      for (const dark of [false, true]) {
        await opt.evaluate(([t, d]) => {
          document.documentElement.setAttribute('data-theme', t);
          document.documentElement.classList.toggle('dark', d);
        }, [theme, dark]);
        await opt.waitForTimeout(600);
        const { bad, gradient } = await scanOptions();
        console.log(`  [设置页 ${theme}/${dark ? 'dark' : 'light'}] 低对比文本: ${bad.length}` + (gradient.length ? `（另有 ${gradient.length} 处渐变底，需人工判断）` : ''));
        bad.slice(0, 8).forEach(b => console.log(`   ${b.ratio}:1 (需${b.need}) ${b.size}px "${b.text}" fg=${b.color} bg=${b.bg}`));
        out[`contrastOptions_${theme}${dark ? '_dark' : ''}`] = bad;
        out[`contrastOptions_${theme}${dark ? '_dark' : ''}_gradient`] = gradient;
      }
    }
  } finally {
    await ctx.close();
  }
  console.log('\n=== JSON ===\n' + JSON.stringify(out, null, 1).slice(0, 12000));
}

main().catch(err => { console.error(err); process.exit(1); });
