/**
 * 真机看**提示（toast）的位置**：右上角，不是正中间、也不是底部居中。
 *
 * 2026-10-26 产品定案：提示从「底部居中」挪回**右上角**（v1.24.1 之前的位置）。
 *
 * 为什么要探针：class 名写对了不等于**看起来**对。判据钉的是
 * 「容器必须是 `fixed right-4 top-4`」这个字面量 —— 但那只说明**锚在哪**，
 * 说明不了「它真的落在右上角、没被谁盖住、整条都在视口里」。
 * ⇒ 这里量**像素**：toast 的实际包围盒相对视口的位置。
 *
 * 用法：pnpm build 之后 node scripts/_probe-toast-anchor.mjs
 */
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT = '/tmp/_probe-toast-anchor';   // 探针产物别落进 store-assets（那是提交商店的素材目录）
const now = Date.now();
const iso = ms => new Date(ms).toISOString();

function tab(groupId, url, title) {
  return {
    id: crypto.randomUUID(), url, title, favicon: '',
    createdAt: iso(now - 3600e3), lastAccessed: iso(now - 3600e3),
    group_id: groupId, pinned: false,
  };
}

const id = crypto.randomUUID();
const groups = [{
  id, name: '工作台 · 同步架构评审', notes: '', isFavorite: false, isLocked: false, isDeleted: false,
  tabs: [
    ['https://github.com/a/b/pulls', 'Pull requests · a/b'],
    ['https://docs.google.com/document/d/1/edit', 'V2 执行计划评审 — Google 文档'],
  ].map(([url, title]) => tab(id, url, title)),
  createdAt: iso(now - 3600e3), updatedAt: iso(now - 1800e3),
  version: 1, displayOrder: 1, lastOp: { probe: 'probe', s: 1 },
}];

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-toast-'));
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
    if (!sw) throw new Error('15s 内未找到 service worker');
    const extId = new URL(sw.url()).host;

    const seed = await ctx.newPage();
    await seed.goto(`chrome-extension://${extId}/src/popup/index.html`);
    await seed.evaluate(async rows => {
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
    }, groups);
    await seed.close();

    // 弹窗的实际尺寸（宽 420 / 高 600 上下）。
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 420, height: 600 });
    await page.goto(`chrome-extension://${extId}/src/popup/index.html`);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
    await page.waitForSelector('text=工作台 · 同步架构评审', { timeout: 15000 });
    await page.mouse.move(2, 2);
    await page.waitForTimeout(400);

    // 触发提示：把会话名清空后回车 ⇒ 「会话名称不能为空」这条 warning 提示。
    // （锁定/解锁在 2026-10-25 之后是**静默**的 —— 那里没有提示可看。）
    const fireToast = async () => {
      await page.locator('h3[role="button"]').first().click();
      const input = page.locator('input[aria-label="编辑会话名称"]');
      await input.waitFor({ state: 'visible', timeout: 5000 });
      await input.fill('');
      await input.press('Enter');
    };
    await fireToast();
    const toast = page.locator('[role="status"], [role="alert"]').first();
    await toast.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(400);

    // 再来一条 ⇒ 顺便看**两条堆叠**（新的贴顶、旧的往下，互不遮挡）。
    await fireToast();
    await page.waitForTimeout(400);

    const box = await page.evaluate(() => {
      const vw = innerWidth;
      const vh = innerHeight;
      // ⚠️ 角色（role="status"）挂在**外层那个带 fixed 定位的 live region** 上
      //   ⇒ 它自己就是容器（不是某个子元素）。
      const hosts = [...document.querySelectorAll('[role="status"], [role="alert"]')];
      return {
        viewport: { w: vw, h: vh },
        toasts: hosts.map(el => {
          const hr = el.getBoundingClientRect();
          const card = el.querySelector('div');
          const cr = card.getBoundingClientRect();
          return {
            text: el.textContent.replace(/@keyframes[\s\S]*?\}/, '').trim().slice(0, 40),
            hostClass: el.className,
            hostPosition: getComputedStyle(el).position,
            hostMarginTop: getComputedStyle(el).marginTop,
            host: {
              left: Math.round(hr.left), top: Math.round(hr.top),
              right: Math.round(hr.right), bottom: Math.round(hr.bottom),
              w: Math.round(hr.width), h: Math.round(hr.height),
            },
            card: {
              left: Math.round(cr.left), top: Math.round(cr.top),
              right: Math.round(cr.right), bottom: Math.round(cr.bottom),
              w: Math.round(cr.width), h: Math.round(cr.height),
            },
          };
        }),
      };
    });
    console.log('toast 实测:', JSON.stringify(box, null, 2));

    await page.screenshot({ path: `${OUT}.png` });
    console.log(`\n截图: ${OUT}.png`);

    // 判据（像素级）：
    //   ① 锚在**顶边**（旧布局是底边）—— 与宽度无关，最硬的判据；
    //   ② 锚在**右边**（容器自己贴着视口右边）；
    //   ③ 不是「水平居中」—— 卡片左边缘必须**严格**在「居中位置」的右边；
    //   ④ 多条时**互不遮挡**，且**新的那条贴着顶边**。
    const vw = box.viewport.w;
    const vh = box.viewport.h;
    const cards = box.toasts.map(t => t.card);
    console.log('\n判据:');
    if (cards.length === 0) throw new Error('一条提示都没抓到 ⇒ 探针没打中');

    for (const [i, t] of box.toasts.entries()) {
      const c = t.card;
      const rightGap = vw - c.right;
      const hostRightGap = vw - t.host.right;
      const centredLeft = (vw - c.w) / 2;
      console.log(
        `  [${i}] 容器右边距 ${hostRightGap}px · 卡片 ${c.left}~${c.right}（顶 ${c.top}）` +
          ` · 居中位置应为 ${centredLeft}`
      );
      if (t.hostPosition !== 'fixed') {
        throw new Error(`提示容器不是 fixed 定位（${t.hostPosition}）⇒ 锚点不对`);
      }
      if (hostRightGap > 30) {
        throw new Error(`提示容器没贴住视口右边（右边距 ${hostRightGap}px）⇒ 不是右上角`);
      }
      if (c.left <= centredLeft + 4) {
        throw new Error(
          `卡片左边缘 ${c.left} 不在「居中位置 ${centredLeft}」的右边 ⇒ 还在水平居中`
        );
      }
      if (c.top < 0 || c.bottom > vh) throw new Error('提示被视口裁掉了');
    }

    // 新的那条（DOM 里最后一个 ⇒ 队列里最新）必须贴着顶边；
    // 更旧的那些**被推下去**（这是堆叠的正确方向，不是缺陷）。
    const newest = cards[cards.length - 1];
    const oldest = cards[0];
    if (newest.top > 40) {
      throw new Error(`最新的那条没贴住顶边（顶边距 ${newest.top}px）⇒ 锚点不对`);
    }
    if (cards.length > 1) {
      if (newest.top >= oldest.top) {
        throw new Error('新提示没有比旧提示更靠上 ⇒ 堆叠方向反了');
      }
      if (oldest.top < newest.bottom) {
        throw new Error(
          `两条提示重叠了（旧 ${oldest.top}~${oldest.bottom}，新 ${newest.top}~${newest.bottom}）` +
            ' ⇒ 用户读不到上面那条的结尾'
        );
      }
      console.log(`  两条互不重叠：旧 ${oldest.top}~${oldest.bottom} · 新 ${newest.top}~${newest.bottom}`);
    }
    console.log('  ✅ 右上角锚定成立');

    await page.close();
  } finally {
    await ctx.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
