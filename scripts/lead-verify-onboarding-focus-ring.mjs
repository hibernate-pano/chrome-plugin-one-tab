// 真机验证：引导标题不许画焦点环（2026-10-23，第 49 轮）。
//
// ── 为什么必须真机 ────────────────────────────────────────────────────────
//
// 静态判据（tests/guards/onboardingTitleFocusRing.test.ts）算的是**特异度**，
// 它能证明「我们的规则在级联里赢」—— 但**赢**不等于**画面上那圈环没了**：
// · 别的样式表可能用 `!important` 硬压（特异度算不出来）；
// · 浏览器的最终层叠结果还受**层叠层（@layer）**、**样式表顺序**、
//   **UA 样式表**影响；
// · 还有些东西（比如 UA 的 `outline: auto`）根本不来自我们的样式表。
//
// 而这一版的缺陷恰恰是**「文件里写着 outline: none，画面上那圈蓝框照样在」**
// —— 静态判据第一次写得太轻（只钉字面量）就漏了它，真机一撞才发现。
// ⇒ 这里在**真 Chrome + 真扩展**里读**浏览器算出来的最终样式**。
//
// 产出：outputs/lead-verify-onboarding-focus-ring/*.png + report.json。
// 用法：先 pnpm build，再 node scripts/lead-verify-onboarding-focus-ring.mjs

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/lead-verify-onboarding-focus-ring');
mkdirSync(OUT_DIR, { recursive: true });

const problems = [];

/** 读「这个元素上**最终**画出来的焦点环」。 */
const readRing = () => ({
  outline: getComputedStyle(document.querySelector('.onboarding-title')).outline,
  outlineStyle: getComputedStyle(document.querySelector('.onboarding-title')).outlineStyle,
  outlineWidth: getComputedStyle(document.querySelector('.onboarding-title')).outlineWidth,
});

async function main() {
  const args = [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    '--no-first-run',
    '--lang=zh-CN',
  ];
  const opts = { headless: false, args, viewport: { width: 1440, height: 900 } };
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'tapstack-onb-')), opts);
  } catch (err) {
    if (!/Executable doesn't exist/i.test(String(err?.message ?? err))) throw err;
    ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'tapstack-onb-')), {
      ...opts,
      channel: 'chrome',
    });
  }

  const steps = [];
  try {
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await new Promise(r => setTimeout(r, 500));
    }
    const id = new URL(sw.url()).host;
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${id}/src/popup/index.html`);
    await page.waitForSelector('.onboarding-title', { timeout: 15000 });
    // 等卡片淡入动画结束 —— 否则截出来是半透明的（那是动画，不是缺陷）。
    await page.waitForTimeout(1200);

    // ① 逐步走完引导，每一步都读一次「标题上最终画出来的环」。
    let overlayRing = null;
    for (let step = 0; step < 7; step++) {
      const probe = await page.evaluate(() => {
        const title = document.querySelector('.onboarding-title');
        if (!title) return null;
        const cs = getComputedStyle(title);
        const active = document.activeElement;
        return {
          text: (title.textContent || '').slice(0, 20),
          outline: cs.outline,
          outlineStyle: cs.outlineStyle,
          outlineWidth: cs.outlineWidth,
          isFocused: active === title,
          matchesFocusVisible: title.matches(':focus-visible'),
        };
      });
      if (!probe) break;
      steps.push({ step, ...probe });

      // 环真的画出来了吗？（outline-style 为 solid 且宽度 > 0 ⇒ 画出来了）
      const painted = probe.outlineStyle !== 'none' && parseFloat(probe.outlineWidth) > 0;
      if (painted) {
        problems.push(
          `第 ${step} 步：引导标题上**画着焦点环**（outline: ${probe.outline}）—— ` +
            '第一屏那圈蓝框还在（全文「欢迎使用 TapStack」看起来像个输入框）。'
        );
      }
      // 焦点环拿掉了，但**焦点必须还在标题上** —— 那是读屏播报「新步骤」的钩子。
      if (!probe.isFocused) {
        problems.push(`第 ${step} 步：标题上**没有焦点** ⇒ 读屏用户听不到「现在到第几步了」。`);
      }

      await page.screenshot({ path: join(OUT_DIR, `step-${step}.png`) });

      // ② 遮罩层自己也是 tabIndex={-1}、开局被聚焦过一次 ——
      //    若它身上也画着一圈环，那是**贴着整个窗口**的一圈蓝框（同样在第一屏）。
      //    必须在**引导还在的时候**测（走完就没了）。
      if (step === 0) {
        overlayRing = await page.evaluate(() => {
          const overlay = document.querySelector('.onboarding-overlay');
          if (!overlay) return null;
          overlay.focus();
          const cs = getComputedStyle(overlay);
          return { outline: cs.outline, outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth };
        });
        if (overlayRing) {
          const painted =
            overlayRing.outlineStyle !== 'none' && parseFloat(overlayRing.outlineWidth) > 0;
          if (painted) {
            problems.push(
              `引导遮罩层聚焦时**画着一圈环**（outline: ${overlayRing.outline}）—— ` +
                '那是贴着整个窗口边缘的一圈蓝框。'
            );
          }
        }
      }

      const next = page.locator('button[aria-label="下一步"]').first();
      const last = page.locator('button[aria-label="开始使用"]').first();
      const target = (await next.isVisible().catch(() => false)) ? next : last;
      if (!(await target.isVisible().catch(() => false))) break;
      await target.click();
      await page.waitForTimeout(500);
    }

    // ② 遮罩层的环已经在第 0 步测过了（那时引导还在）。

    writeFileSync(
      join(OUT_DIR, 'report.json'),
      JSON.stringify({ problems, steps, overlayRing }, null, 2)
    );
    console.log(
      JSON.stringify(
        {
          problems,
          steps: steps.map(s => ({
            step: s.step,
            outline: s.outline,
            isFocused: s.isFocused,
          })),
          overlayRing,
        },
        null,
        2
      )
    );
    if (problems.length) process.exitCode = 1;
  } finally {
    await ctx.close();
  }
}

main().catch(err => {
  console.error('验证脚本失败：', err);
  process.exit(1);
});
