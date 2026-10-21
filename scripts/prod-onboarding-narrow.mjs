// 真机巡检：用户引导在**真实 popup 尺寸**（400×600）下的排版。
//
// 为什么单独写：scripts/prod-onboarding.mjs 用的是 1280×800 ——
// 那是网页版管理页的尺寸，而**扩展的默认面板是 400×600**。
// 引导是「装扩展 → 第一次打开」就会出现的东西，它的第一印象发生在
// 400 宽的窄屏里，而这一档此前**没有人量过**。
//
// 关注两件事：
//   ① 特性卡片的说明文字会不会溢出/被裁（文案变长就会）。
//   ② 说明文字的对比度够不够（引导页的 CSS 里有自己的颜色，不跟 Tailwind 走）。
//
// 用法：`pnpm build` 之后 `node scripts/prod-onboarding-narrow.mjs`
// 产物：outputs/prod-onboarding-narrow/*.png

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/prod-onboarding-narrow');
const POPUP = { width: 400, height: 600 };

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** 量引导层里所有文本元素的几何，以及有没有横向/纵向溢出。 */
async function measure(page) {
  return page.evaluate(() => {
    // 引导层：优先用带 onboarding-overlay / onboarding-modal 的容器；
    // 找不到就用 body（那样 overflowers 判定仍以视口为界）。
    const root =
      document.querySelector('[class*="onboarding-overlay"], [class*="onboarding-modal"], [class*="onboarding-panel"]') ??
      document.querySelector('.onboarding-content')?.parentElement ??
      document.body;
    const scope = root;
    const items = [...scope.querySelectorAll('.onboarding-feature-card, .onboarding-feature-desc, .onboarding-feature-title, .onboarding-content')]
      .map(el => {
        const r = el.getBoundingClientRect();
        return {
          cls: el.className.toString().slice(0, 60),
          w: Math.round(r.width),
          h: Math.round(r.height),
          scrollH: el.scrollHeight,
          clientH: el.clientHeight,
          // 文字是否被裁：scrollHeight 明显大于 clientHeight
          clipped: el.scrollHeight > el.clientHeight + 1,
          text: (el.textContent ?? '').trim().slice(0, 40),
        };
      });
    return {
      items,
      docScrollW: document.documentElement.scrollWidth,
      docClientW: document.documentElement.clientWidth,
      // 引导层里所有元素有没有超出视口右边界
      overflowers: [...scope.querySelectorAll('*')]
        .filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.right > document.documentElement.clientWidth + 1;
        })
        .slice(0, 8)
        .map(el => ({
          cls: (el.className || '').toString().slice(0, 60),
          right: Math.round(el.getBoundingClientRect().right),
          text: (el.textContent ?? '').trim().slice(0, 30),
        })),
      // 说明文字的实际颜色（引导页 CSS 自己的颜色，不跟 Tailwind 走）
      descColors: [...document.querySelectorAll('.onboarding-feature-desc')]
        .map(el => getComputedStyle(el).color)
        .filter((v, i, a) => a.indexOf(v) === i),
      descFontSize: (() => {
        const el = document.querySelector('.onboarding-feature-desc');
        return el ? getComputedStyle(el).fontSize : null;
      })(),
    };
  });
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-onboarding-narrow-'));
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
    await page.waitForTimeout(1800);

    // 引导必须真的出现。与 scripts/prod-onboarding.mjs 同一套触发方式：
    // 直接往 chrome.storage.local 写下 onboarding_trigger（模拟首次安装），
    // 然后重载页面 —— 管理页读到它就会挂引导。
    //
    // 【为什么不走菜单「使用引导」】那条路依赖菜单展开 + 菜单项命中，
    // 而本脚本要量的是**引导层本身的排版** —— 触发方式越直接越好，
    // 少一个可能失败的中间环节。
    await page.evaluate(async () => {
      await chrome.storage.local.set({
        onboarding_trigger: { reason: 'install', version: '1.25.1' },
        onboarding_seen: undefined,
      });
    });
    await page.reload();
    await page.waitForTimeout(1500);
    const overlay = page.locator('.onboarding-overlay');
    const appeared = await overlay
      .waitFor({ state: 'visible', timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    check('引导层真的出现', appeared);
    if (!appeared) {
      console.log('  诊断 trigger =', JSON.stringify(await page.evaluate(
        async () => (await chrome.storage.local.get('onboarding_trigger')).onboarding_trigger ?? null
      )));
    }

    // 走到**搜索那一步**（第 3 步，index 2）——
    // 「按时间过滤 / 按域名过滤」两张能力卡片在 SearchStep 里。
    const next = page.locator('button', { hasText: /^下一步$/ }).first();
    for (let i = 0; i < 3 && (await page.locator('text=按域名过滤').count()) === 0; i++) {
      if (await next.count()) {
        await next.click().catch(() => {});
        await page.waitForTimeout(600);
      }
    }

    // 找到「按域名过滤」那张卡 ⇒ 说明当前在搜索那一步
    const target = page.locator('text=按域名过滤').first();
    const found = await target.count();
    check('引导的搜索步骤可达（找到「按域名过滤」卡片）', found > 0);
    if (found > 0) {
      await target.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(400);
    }
    await page.screenshot({ path: join(OUT_DIR, '01-narrow-onboarding.png') });

    const m = await measure(page);
    console.log('  量测:', JSON.stringify(m, null, 1).slice(0, 1600));

    check('引导层无横向溢出', m.overflowers.length === 0, JSON.stringify(m.overflowers));
    check('说明文字没有被裁（scrollHeight ≈ clientHeight）',
      m.items.filter(i => i.clipped).length === 0,
      JSON.stringify(m.items.filter(i => i.clipped)));

    const descs = m.items.filter(i => i.cls.includes('onboarding-feature-desc'));
    check('两张「按时间/按域名」说明卡片都量到了', descs.length >= 2, `量到 ${descs.length} 张`);

    // 对比度：引导页 CSS 用的是固定颜色 #9ca3af（gray-400）
    console.log(`  说明文字颜色: ${m.descColors.join(', ')}  字号: ${m.descFontSize}`);
    check('说明文字字号不小于 10px（10px 在 400 宽下已经偏小）',
      parseFloat(m.descFontSize ?? '0') >= 10, `实际 ${m.descFontSize}`);

    const failed = checks.filter(c => !c.ok);
    console.log(`\n真机判据: ${checks.length - failed.length}/${checks.length} 通过`);
    if (failed.length) {
      for (const f of failed) console.log(`  · ${f.name} — ${f.detail}`);
      process.exitCode = 1;
    } else {
      console.log('✅ 引导窄屏排版真机验证通过');
    }
  } finally {
    await ctx.close();
  }
}

main().catch(err => {
  console.error('真机巡检失败:', err);
  process.exit(1);
});
