// 真机巡检：六套主题 × 明暗下，「标签行」在**屏幕上真实呈现的颜色**。
//
// ── 为什么必须看像素，而不是 getComputedStyle ────────────────────────────
//
// `getComputedStyle(el).backgroundColor` 只是**这一层**声明的值：
//   · 卡片底是**渐变**时，它报 `rgba(0,0,0,0)`（真色在 backgroundImage 里）；
//   · 半透明底（如 prism 的玻璃卡）报的是**未合成**的 rgba；
//   · 底色写 `transparent` 时，报的是 `rgba(0,0,0,0)` —— 而用户看到的是
//     **祖先链上第一个不透明底色**。
//
// ⇒ 三种情况都会让「读计算样式」得出错误结论。
// ⇒ 本脚本**截真图 + 取真实像素**（ImageMagick）⇒ 地面真相。
//
// ── 这个脚本要防的回归类别 ────────────────────────────────────────────────
//
// 标签行底色有三处可以决定：
//   ① `src/styles/drag-drop.css`（MainApp.tsx 单独 import ⇒ **后加载**）
//   ② `src/styles/themes/*.css` 的 `html[data-theme=x] .tab-item`
//   ③ `src/styles/global.css` 的 `.tab-item`
//
// 之前 ① 把底色写死成 `white`（深色态 `#1f2937`），
// 而 legacy / creamy / prism 三套主题的 `.tab-item` 规则**只覆盖了
// border / padding / hover，没覆盖底色** ⇒ 底色落回 ①
// ⇒ 那三套主题的标签行是**一整块写死色**，而不是卡片底透出来的颜色。
//
// 判据：**标签行的实际像素**必须与**它左右紧邻的卡片像素**一致
// （容差 8/255）—— 不一致 ⇒ 那一行是「贴上去的一块异色」。
//
// 用法：`pnpm build` 之后 `node scripts/prod-theme-consistency.mjs`
// 产物：outputs/prod-theme-consistency/*.png
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/prod-theme-consistency');
const POPUP = { width: 400, height: 600 };

/** 像素容差：8/255 ≈ 3%。抗压缩噪点。 */
const TOLERANCE = 8;

const now = Date.now();
const iso = ms => new Date(ms).toISOString();
const GROUPS = [
  {
    id: 'g1',
    name: '示例会话',
    notes: '',
    isFavorite: false,
    isLocked: false,
    isDeleted: false,
    tabs: [
      { id: 't1', url: 'https://github.com/x', title: 'GitHub 示例', createdAt: iso(now), lastAccessed: iso(now), group_id: 'g1', pinned: false },
      { id: 't2', url: 'https://example.com/y', title: '另一个标签', createdAt: iso(now), lastAccessed: iso(now), group_id: 'g1', pinned: false },
    ],
    createdAt: iso(now),
    updatedAt: iso(now),
    version: 1,
  },
];

const THEMES = ['legacy', 'creamy', 'prism', 'claude', 'apple', 'chrome'];

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/**
 * 从 PNG 的 (x,y) 取真实像素。用 ImageMagick，避免引入图像依赖。
 *
 * 【为什么要读像素而不是 getComputedStyle】
 * 渐变底 / 半透明底 / transparent 三种情况下，计算样式报的值都**不是**
 * 用户看到的颜色。像素是地面真相。
 *
 * magick 的 txt 输出有两种形状：
 *   `0,0: (255,255,255)  #FFFFFF  white`   ← 带颜色名
 *   `0,0: (255,255,255)  #FFFFFF`           ← 无颜色名（灰度等）
 * 十六进制那一份两种形状都有 ⇒ 用它解析。
 */
const pixelAt = (file, x, y) => {
  const out = execFileSync(
    'magick',
    [file, '-crop', `1x1+${x}+${y}`, '+repage', '-depth', '8', 'txt:-'],
    { encoding: 'utf8' }
  );
  const m = out.match(/#([0-9a-f]{6})/i);
  if (!m) return null;
  const hex = m[1];
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
};

const diff = (a, b) =>
  a && b ? Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b)) : 255;

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-theme-'));
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

    const page = await ctx.newPage();
    await page.setViewportSize(POPUP);
    await page.goto(`chrome-extension://${id}/src/popup/index.html`);
    await page.waitForTimeout(1500);

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
    }, GROUPS);
    await page.reload();
    await page.waitForTimeout(1500);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 4000 }).then(() => skip.click()).catch(() => {});
    await page.waitForTimeout(500);

    check('页面里存在 .tab-item（量测前提）', (await page.locator('.tab-item').count()) > 0);

    const summary = [];
    for (const dark of [false, true]) {
      for (const theme of THEMES) {
        await page.evaluate(([t, d]) => {
          document.documentElement.dataset.theme = t;
          document.documentElement.classList.toggle('dark', d);
        }, [theme, dark]);
        await page.waitForTimeout(350);

        // 找一条标签行，以及它**左右紧邻的卡片底**（同一 y、x 偏一点）
        const geom = await page.evaluate(() => {
          const item = document.querySelector('.tab-item');
          if (!item) return null;
          const card = item.closest('.tab-group-card');
          const r = item.getBoundingClientRect();
          const cr = card?.getBoundingClientRect();
          return {
            item: { x: r.x, y: r.y, w: r.width, h: r.height },
            card: cr ? { x: cr.x, y: cr.y, w: cr.width, h: cr.height } : null,
            marginLeft: getComputedStyle(item).marginLeft,
            marginRight: getComputedStyle(item).marginRight,
            bg: getComputedStyle(item).backgroundColor,
            cardBg: card ? getComputedStyle(card).backgroundColor : 'n/a',
            cardImg: card ? getComputedStyle(card).backgroundImage : 'n/a',
          };
        });
        if (!geom) {
          check(`${dark ? '深色' : '浅色'}/${theme}：找到标签行`, false);
          continue;
        }

        const file = join(OUT_DIR, `${dark ? 'dark' : 'light'}-${theme}.png`);
        await page.screenshot({ path: file });

        // ── 采样点必须落在**不同**的两块像素上 ──────────────────────────
        //
        // 【踩过的坑】第一版取「行的左侧 margin 区域」当卡片底。
        // 但 `.tab-item` **没有左右 margin**（只有 margin-bottom: 4px）⇒
        // 采样点 x = item.x - 0 ⇒ **落在标签行自己身上** ⇒ 采到同一块像素
        // ⇒ 色差必然 0 ⇒ **假绿**（prism 浅/深色都被判成通过，而它其实有问题）。
        //
        // ⇒ 改为：标签行取「行内靠右的一个点」（避开文字与删除按钮），
        //   卡片取「**卡片底部**同一列的像素」—— 那儿一定是卡片底，不含标签行。
        const y = Math.round(geom.item.y + geom.item.h / 2);
        const itemX = Math.round(geom.item.x + geom.item.w - 30);
        const cardY = Math.round(geom.card.y + geom.card.h - 3);
        const cardX = itemX;

        const pItem = pixelAt(file, itemX, y);
        const pCard = pixelAt(file, cardX, cardY);
        const d = diff(pItem, pCard);

        summary.push({
          state: dark ? '深色' : '浅色',
          theme,
          itemBg: geom.bg,
          cardBg: geom.cardBg,
          cardImg: geom.cardImg === 'none' ? '' : '渐变',
          item: pItem,
          card: pCard,
          diff: d,
        });

        check(
          `${dark ? '深色' : '浅色'}/${theme}：标签行像素与相邻卡片底一致`,
          d <= TOLERANCE,
          `行 ${JSON.stringify(pItem)} vs 卡 ${JSON.stringify(pCard)}，色差 ${d}（声明底色 ${geom.bg}）`
        );
      }
    }

    console.log('\n【像素量测汇总】');
    for (const s of summary) {
      console.log(
        `${s.state}/${s.theme.padEnd(8)} 声明 ${String(s.itemBg).padEnd(22)} 卡片底 ${String(s.cardBg).padEnd(26)}` +
          `像素差 ${String(s.diff).padStart(3)}  ${s.diff <= TOLERANCE ? '✅' : '❌'}`
      );
    }

    const failed = checks.filter(c => !c.ok);
    console.log(`\n真机判据: ${checks.length - failed.length}/${checks.length} 通过`);
    if (failed.length) {
      for (const f of failed) console.log(`  · ${f.name} — ${f.detail}`);
      process.exitCode = 1;
    } else {
      console.log('✅ 六套主题 × 明暗：标签行都与卡片底融为一体');
    }
  } finally {
    await ctx.close();
  }
}

main().catch(err => {
  console.error('真机巡检失败:', err);
  process.exit(1);
});
