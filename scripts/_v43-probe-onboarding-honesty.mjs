// 第 43 轮 H-1 / H-7 / H-13 真机验证（2026-10-23 审计）
//
// 为什么必须真机：
//   · H-1 的判据是**命中区**（getBoundingClientRect 的高/宽）—— 源码里
//     只能算出「理论值」，真实盒模型受行高、字体缩放、flex 布局影响。
//   · H-7 的判据是「引导的聚光灯选择器能不能解析到真实元素」——
//     必须是真 DOM + 真 CSS。
//   · H-13 的判据是「引导的 6 步文本到底写了什么」—— 只能从渲染结果读。
//
// 用法：node scripts/_v43-probe-onboarding-honesty.mjs
//   （先 `pnpm build`；若别的 agent 正在用 dist/，可设 DIST_PATH 指向另一份构建）
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.env.DIST_PATH || join(process.cwd(), 'dist'));
const OUT_DIR = resolve(process.cwd(), 'outputs/v43-honesty');

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-v43h-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
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
    await page.goto(popupUrl);
    await page.waitForSelector('#root', { timeout: 15000 });
    await page.waitForTimeout(2000);

    // ────────────────────────────────────────────────────────────────────
    // 引导：六步文本 + 聚光灯是否解析得到
    // ────────────────────────────────────────────────────────────────────
    // unpacked 每次启动都重装 ⇒ onInstalled('install') 每次触发 ⇒
    // 首次打开页面引导就会自己出来（这正是我们要验的东西）。
    await page.waitForSelector('.onboarding-overlay', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);

    const stepTexts = [];
    const spotlightStates = [];
    for (let i = 0; i < 8; i++) {
      const txt = await page.evaluate(() => {
        const card = document.querySelector('.onboarding-card-inner');
        if (!card) return '(没有 .onboarding-card-inner)';
        return card.innerText.replace(/\n{3,}/g, '\n\n').trim();
      });
      stepTexts.push(txt);

      // 聚光灯：Spotlight 组件的高亮框（.onboarding-spotlight-ring）
      //
      // 判据不能靠「有个环」也不能靠 elementFromPoint：
      //   · 环是 box-shadow 挖出来的**视觉**洞，命中测试走的还是遮罩 ⇒
      //     elementFromPoint 永远返回 .onboarding-overlay，是假判据；
      //   · 只看「有环」也不够 —— 选择器写错时组件会 warn 并**整个不渲染环**
      //     （那是「环消失」，不是「环盖错地方」）。
      //
      // ⇒ 正确的判据是**几何比对**：环 = 目标元素的位置向外扩 padding(8px)。
      //   这里复刻 Spotlight.tsx 的 firstVisibleMatch（按候选链顺序取第一个
      //   宽高都 > 0 的元素），把环的矩形与该元素的矩形对上。
      const spot = await page.evaluate(() => {
        const ring = document.querySelector('.onboarding-spotlight-ring');
        if (!ring) return { found: false, reason: '没有高亮环（选择器没命中 → 组件整个不渲染）' };
        const r = ring.getBoundingClientRect();
        // 复刻 splitSelectorChain：只按**顶层 ASCII 逗号**拆，引号内不拆
        const splitChain = (s) => {
          const out = []; let cur = '', inQ = false;
          for (const ch of s) {
            if (ch === '"' || ch === "'") inQ = !inQ;
            if (ch === ',' && !inQ) { out.push(cur); cur = ''; } else cur += ch;
          }
          out.push(cur); return out;
        };
        const firstVisible = (chain) => {
          for (const sel of splitChain(chain)) {
            for (const el of document.querySelectorAll(sel.trim())) {
              const rr = el.getBoundingClientRect();
              if (rr.width > 0 && rr.height > 0) return { el, sel: sel.trim(), rect: rr };
            }
          }
          return null;
        };
        // 这一步教的是搜索 ⇒ 它的目标就是搜索框
        const target = firstVisible('[aria-label="搜索会话名、标签标题或 URL"]');
        if (!target) return { found: true, matched: false, reason: '搜索框选择器没命中任何可见元素' };
        // padding 从 OnboardingGuide.tsx 的 <Spotlight padding={10}> 读出来
        // （写死一个数就会与实现漂移 —— 那样这个判据只是在验自己的常量）。
        const PAD = 10;
        const dw = Math.abs(r.width - (target.rect.width + PAD * 2));
        const dh = Math.abs(r.height - (target.rect.height + PAD * 2));
        const dx = Math.abs(r.left - (target.rect.left - PAD));
        const dy = Math.abs(r.top - (target.rect.top - PAD));
        return {
          found: true,
          matched: true,
          ring: { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) },
          target: { w: Math.round(target.rect.width), h: Math.round(target.rect.height) },
          label: target.el.getAttribute('aria-label'),
          // 允许 1px 的亚像素误差
          ok: dw <= 1 && dh <= 1 && dx <= 1 && dy <= 1,
          delta: { dw: Math.round(dw), dh: Math.round(dh), dx: Math.round(dx), dy: Math.round(dy) },
        };
      });
      spotlightStates.push(spot);
      await page.screenshot({ path: join(OUT_DIR, `step-${i + 1}.png`) }).catch(() => {});

      const advanced = await page.evaluate(() => {
        const btn = document.querySelector('.onboarding-btn-primary');
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!advanced) break;
      await page.waitForTimeout(900);
    }

    writeFileSync(join(OUT_DIR, 'onboarding-steps.txt'), stepTexts.join('\n\n========== NEXT STEP ==========\n\n'));
    console.log('\n--- 引导文本 dump ---\n' + stepTexts.join('\n\n===== STEP =====\n\n'));

    // ────────────────────────────────────────────────────────────────────
    // 文案判据（在渲染出的文本里查）
    // ────────────────────────────────────────────────────────────────────
    const all = stepTexts.join('\n');
    check('H-2 引导说了固定标签页默认不保存', /默认不保存/.test(all));
    check('H-2 引导说了开关位置（设置里打开）', /设置/.test(all) && /固定标签页/.test(all));
    check('H-3 引导说了定时拉取默认关闭', /定时拉取默认关闭/.test(all));
    check('H-4 引导说了拉回是合并', /合并/.test(all));
    check('H-5 引导教了「在当前窗口打开整个会话」', /当前窗口/.test(all));
    check('H-8 引导教了锁定（恢复后仍留在列表里）', /锁定/.test(all) && /恢复后仍留在列表里/.test(all));
    check('H-9 引导教了顶栏上传/下载', /上传/.test(all) && /下载/.test(all));
    check('H-10/H-11 引导里没有英文 Pinned', !/\bPinned\b/i.test(all));
    check('H-12 引导说了关闭时的例外', /留在原处/.test(all));
    check('H-13 引导教了排序', /排序/.test(all));
    check('H-14 引导说了 OneTab 不带会话名', /OneTab/.test(all) && /不带会话名/.test(all));
    check('H-11 引导说了固定标签页（中文）', /固定标签页/.test(all));

    // 聚光灯：第 3 步（搜索）必须真的解析到搜索框
    const searchStep = spotlightStates[2];
    check('H-7 搜索那一步有高亮环', !!searchStep?.found, searchStep?.found ? `环 ${searchStep.ring?.w}×${searchStep.ring?.h}` : (searchStep?.reason || '没找到'));
    check('H-7 高亮环正好套在搜索框上（选择器没写错）', !!searchStep?.ok,
      searchStep?.matched ? `环 ${searchStep.ring.w}×${searchStep.ring.h} vs 目标 ${searchStep.target.w}×${searchStep.target.h}（差 ${JSON.stringify(searchStep.delta)}）` : (searchStep?.reason || ''));
    const anySpot = spotlightStates.filter(s => s.found).length;
    check('H-7 聚光灯在多步都能解析（选择器没写错）', anySpot >= 2, `${anySpot}/${spotlightStates.length} 步有高亮环`);
    console.log('   各步聚光灯:', JSON.stringify(spotlightStates.map(s => ({ found: s.found, ok: s.ok, ring: s.ring ? `${s.ring.w}×${s.ring.h}` : null, target: s.target ? `${s.target.w}×${s.target.h}` : null }))));

    // 关掉引导（走它自己的「跳过」按钮，不删 React 节点）
    await page.evaluate(() => {
      const skip = document.querySelector('.onboarding-btn-skip');
      if (skip) skip.click();
    });
    await page.waitForTimeout(900);

    // ────────────────────────────────────────────────────────────────────
    // H-1：⋯菜单里的「去登录」命中区
    // ────────────────────────────────────────────────────────────────────
    await page.click('button[aria-label="菜单"]');
    await page.waitForTimeout(800);

    const loginBox = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button[role="menuitem"]'));
      const target = btns.find(b => (b.textContent || '').trim() === '去登录');
      if (!target) return { found: false, menuitems: btns.map(b => (b.textContent || '').trim()) };
      const r = target.getBoundingClientRect();
      const cs = getComputedStyle(target);
      const rows = btns
        .filter(b => b !== target)
        .map(b => {
          const rr = b.getBoundingClientRect();
          return { text: (b.textContent || '').trim().slice(0, 16), w: Math.round(rr.width), h: Math.round(rr.height) };
        });
      return {
        found: true,
        w: Math.round(r.width),
        h: Math.round(r.height),
        fontSize: cs.fontSize,
        lineHeight: cs.lineHeight,
        padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
        textDecoration: cs.textDecorationLine,
        role: target.getAttribute('role'),
        rows,
      };
    });

    check('H-1 菜单里有「去登录」入口', loginBox.found, loginBox.found ? '' : JSON.stringify(loginBox.menuitems));
    if (loginBox.found) {
      console.log('   去登录命中区:', `${loginBox.w}×${loginBox.h}`, '| font', loginBox.fontSize, '| lh', loginBox.lineHeight, '| pad', loginBox.padding, '| deco', loginBox.textDecoration);
      console.log('   同菜单其它行:', JSON.stringify(loginBox.rows));
      check('H-1 命中区高度 ≥ 28px', loginBox.h >= 28, `实测 ${loginBox.h}px`);
      check('H-1 命中区高度 ≥ WCAG 2.2 AA 24px', loginBox.h >= 24, `实测 ${loginBox.h}px`);
      check('H-1 保留 role="menuitem"', loginBox.role === 'menuitem', `实测 role=${loginBox.role}`);
      check('H-1 保留下划线（“这是可点的文字”的线索）', loginBox.textDecoration.includes('underline'), `实测 ${loginBox.textDecoration}`);
      const minOther = Math.min(...loginBox.rows.map(r => r.h));
      check('H-1 不再是菜单里最矮的一行', loginBox.h >= minOther, `去登录 ${loginBox.h}px vs 其它行最小 ${minOther}px`);
    }

    // ────────────────────────────────────────────────────────────────────
    // H-7：搜索框的 placeholder / aria-label 真的提到了 URL
    // ────────────────────────────────────────────────────────────────────
    const search = await page.evaluate(() => {
      const el = document.querySelector('input[aria-label*="搜索"]');
      if (!el) return { found: false, labels: Array.from(document.querySelectorAll('input')).map(i => i.getAttribute('aria-label')) };
      return { found: true, placeholder: el.getAttribute('placeholder'), ariaLabel: el.getAttribute('aria-label') };
    });
    check('H-7 搜索框存在', search.found);
    if (search.found) {
      console.log('   placeholder:', search.placeholder, '| aria-label:', search.ariaLabel);
      check('H-7 placeholder 提到 URL', /URL/i.test(search.placeholder || ''), search.placeholder || '');
      check('H-7 aria-label 提到 URL', /URL/i.test(search.ariaLabel || ''), search.ariaLabel || '');
    }

    if (errors.length) console.log('\n控制台错误:', errors.slice(0, 5));
  } finally {
    await ctx.close();
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n===== 汇总：${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) {
    console.log('失败项:');
    for (const f of failed) console.log('  ❌', f.name, f.detail);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
