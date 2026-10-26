/** 只测一件事：断网 + 未登录时，顶栏「上传」「下载」这两个按钮到底有没有反应。 */
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT = '/tmp/_probe-offline';

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-offline4-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`,
      '--no-first-run', '--lang=zh-CN',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--dns-over-https-mode=off',
    ],
  });
  await ctx.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith('http://127.0.0.1') || u.startsWith('chrome-extension://')) return route.continue();
    return route.abort('internetdisconnected');
  });
  try {
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) { sw = ctx.serviceWorkers()[0] ?? null; if (!sw) await new Promise(r => setTimeout(r, 500)); }
    const extId = new URL(sw.url()).host;
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`chrome-extension://${extId}/src/popup/index.html`);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
    await page.waitForTimeout(1500);

    const buttons = await page.evaluate(() =>
      [...document.querySelectorAll('button')]
        .map(b => ({ aria: b.getAttribute('aria-label'), text: (b.innerText || '').trim().slice(0, 20) }))
        .filter(x => (x.aria || '').includes('上传') || (x.aria || '').includes('下载')));
    console.log('候选按钮：', JSON.stringify(buttons, null, 1));

    const target = page.locator('button[aria-label="上传本地会话到云端"]').first();
    console.log('目标按钮数量：', await page.locator('button[aria-label="上传本地会话到云端"]').count());
    await target.click();
    for (const ms of [400, 1500, 3000, 6000]) {
      await page.waitForTimeout(ms === 400 ? 400 : ms - (ms === 1500 ? 400 : ms === 3000 ? 1500 : 3000));
      const snap = await page.evaluate(() => {
        const all = [...document.querySelectorAll('body *')]
          .filter(el => {
            const t = (el.innerText || '').trim();
            if (!t || t.length > 120) return false;
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return false;
            return /上传|失败|登录|网络|不可用|未登录|需要|请先/.test(t);
          })
          .map(el => `${el.tagName}.${(el.className || '').toString().slice(0, 30)}: ${(el.innerText || '').replace(/\s+/g, ' ').slice(0, 90)}`);
        return [...new Set(all)].slice(0, 12);
      });
      console.log(`\n点击后 ${ms}ms，界面上与「上传/失败/登录」相关的可见文本：`);
      console.log(snap.length ? snap.join('\n') : '（什么都没出现）');
      await page.screenshot({ path: `${OUT}-upload-${ms}.png` });
    }
    await page.close();
  } finally { await ctx.close(); }
}
main().catch(e => { console.error(e); process.exit(1); });
