/**
 * 真机验「保存时间未知的会话不许被说成刚保存的」（2026-10-25，修复①）。
 *
 * ── 这个探针验的是**界面上真的发生了**，不是「函数返回了什么」 ──────────
 *
 * 三段：
 *   ① **种子数据**：一条刚存的、一条 30 天前存的、一条「导入的」
 *      （`createdAt` 是**现在**、`importedAt` 也是现在 ⇒ 旧实现会把它显示成
 *      「今天」、并让它霸占「最近保存」的榜首）。
 *      断言：卡片写「导入 · …」、它排在**最后**、普通会话照旧写相对时间。
 *   ② **保存时间筛选**：「24 小时内」里**不得**出现导入件；
 *      「时间未知」桶里**必须**能捞到它（不许被时间筛选静默藏起来）。
 *   ③ **真导入**：真的走一遍「⋮ → 导入 → OneTab 格式」的文件导入，
 *      断言新卡片写「导入 · …」且排在最后。
 *
 * ⚠️ 断言要**钉目标状态**：截图/打印「✅」只说明脚本跑完了。
 * 这里每一项都读 DOM 里的**具体文字**与**具体顺序**，读不到就红。
 *
 * 用法：pnpm build 之后 node scripts/_probe-imported-save-time.mjs
 */
import { chromium } from 'playwright';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const now = Date.now();
const iso = ms => new Date(ms).toISOString();
const days = n => n * 86400e3;

let failures = 0;
const check = (ok, label, detail) => {
  if (ok) {
    console.log(`  ✅ ${label}`);
  } else {
    failures += 1;
    console.log(`  ❌ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
};

const group = (name, createdMs, over = {}) => {
  const id = crypto.randomUUID();
  return {
    id,
    name,
    notes: '',
    isFavorite: false,
    isLocked: false,
    isDeleted: false,
    tabs: [
      {
        id: crypto.randomUUID(),
        url: `https://example.com/${encodeURIComponent(name)}`,
        title: `标签 ${name}`,
        favicon: '',
        createdAt: iso(createdMs),
        lastAccessed: iso(createdMs),
        group_id: id,
        pinned: false,
      },
    ],
    createdAt: iso(createdMs),
    updatedAt: iso(createdMs),
    version: 1,
    lastOp: { probe: 'probe', s: 1 },
    ...over,
  };
};

const SEED = [
  group('刚存的', now - 3600e3),
  group('三十天前存的', now - days(30)),
  group('导入的', now, { importedAt: iso(now) }),
];

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-imported-'));
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
    for (let i = 0; i < 30 && !sw; i += 1) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await new Promise(r => setTimeout(r, 500));
    }
    if (!sw) throw new Error('15s 内未找到 service worker');
    const extId = new URL(sw.url()).host;

    const seed = await ctx.newPage();
    await seed.goto(`chrome-extension://${extId}/src/popup/index.html`);
    await seed.evaluate(async ({ rows, settings }) => {
      const put = (key, value) =>
        new Promise((res, rej) => {
          const req = indexedDB.open('tabvaultpro', 1);
          req.onerror = () => rej(req.error);
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction('kv', 'readwrite');
            tx.objectStore('kv').put({ key, value });
            tx.oncomplete = () => {
              db.close();
              res();
            };
            tx.onerror = () => {
              db.close();
              rej(req.error);
            };
          };
        });
      await put('tab_groups', rows);
      await put('user_settings', settings);
      // 引导页会盖住整个界面（点击被它吃掉）⇒ 先标记「已看过」。
      await chrome.storage.local.set({
        onboarding_state: {
          hasCompletedOnboarding: true,
          lastOnboardingVersion: '1.28.7',
          completedAt: new Date().toISOString(),
        },
      });
    }, { rows: SEED, settings: { layoutMode: 'single', sessionSort: 'saved' } });
    await seed.close();

    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/src/popup/index.html`);
    await page.setViewportSize({ width: 900, height: 1200 });
    await page.waitForSelector('.tab-group-time', { timeout: 15000 });

    /** 读出每张卡片的「标题 + 时间位」，按 DOM 顺序。 */
    const readCards = async () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('.session-card, [data-session-id]')).map(card => ({
          name:
            card.querySelector('.tab-group-name, h3, .font-medium')?.textContent?.trim() ??
            card.textContent?.trim().slice(0, 20) ??
            '',
          time: card.querySelector('.tab-group-time')?.textContent?.trim() ?? '',
        }))
      );

    // 卡片的选择器可能对不上 ⇒ 退化到「按 .tab-group-time 元素逐个取最近的标题」。
    const readCardsFallback = async () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('.tab-group-time')).map(el => {
          const card = el.closest('div');
          const text = card?.textContent ?? '';
          return {
            name: text.replace(el.textContent ?? '', '').trim().slice(0, 30),
            time: el.textContent?.trim() ?? '',
          };
        })
      );

    let cards = await readCards();
    if (!cards.length || cards.every(c => !c.name)) cards = await readCardsFallback();

    console.log('\n【① 卡片时间位与排序】');
    console.log('   DOM 顺序：', JSON.stringify(cards, null, 0));
    const imported = cards.find(c => c.name.includes('导入的'));
    const fresh = cards.find(c => c.name.includes('刚存的'));
    const old = cards.find(c => c.name.includes('三十天前存的'));

    check(!!imported, '找到「导入的」那张卡');
    check(!!fresh, '找到「刚存的」那张卡');
    check(!!old, '找到「三十天前存的」那张卡');

    if (imported) {
      check(
        /^导入 · /.test(imported.time),
        '导入件的时间位写「导入 · …」（不是「今天」）',
        `实际写的是「${imported.time}」`
      );
    }
    if (fresh) {
      check(
        !/导入/.test(fresh.time),
        '普通会话的时间位不写「导入」',
        `实际写的是「${fresh.time}」`
      );
    }
    if (old) {
      check(
        !/导入/.test(old.time) && /天前|周前|月|日/.test(old.time),
        '30 天前存的会话写相对时间（不被「导入」污染）',
        `实际写的是「${old.time}」`
      );
    }

    const names = cards.map(c => c.name);
    const idxImported = names.findIndex(n => n.includes('导入的'));
    const idxFresh = names.findIndex(n => n.includes('刚存的'));
    const idxOld = names.findIndex(n => n.includes('三十天前存的'));
    check(
      idxImported > idxFresh && idxImported > idxOld,
      '「最近保存」排序下导入件排在已知保存时间的会话**之后**（哪怕它的 createdAt 更新）',
      `DOM 顺序 = ${JSON.stringify(names)}`
    );

    // ── ② 保存时间筛选 ──────────────────────────────────────────────────
    console.log('\n【② 保存时间筛选】');
    await page.getByRole('button', { name: '显示筛选' }).click();
    await page.waitForSelector('#search-filter-saved-within', { timeout: 10000 });

    /**
     * 列表页每张卡的**时间位**（按 DOM 顺序）。
     *
     * ⚠️ 页脚那个版本号（`TapStack v1.28.7`）**复用了同一个 class**
     * （`tab-group-time`，MainApp.tsx）⇒ 必须把它剔掉，
     * 否则「最后一条是不是导入件」会被页脚顶掉 ⇒ 断言永远红。
     */
    const readTimes = async () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('.tab-group-time'))
          .map(el => el.textContent?.trim() ?? '')
          .filter(t => !t.startsWith('TapStack '))
      );

    /**
     * 筛选浏览视图里的结果行：**会话名 + 摘要行**。
     *
     * ⚠️ 结果视图渲染的是 `SearchResultList`（`h4` = 会话名，
     * 旁边的 `<p>` = 「匹配 n/m 个标签 · 导入于/保存于 …」），
     * **不是**列表页那张卡（`.tab-group-time`）⇒ 读错了元素就会读到空集，
     * 然后把「筛选把结果全吃掉了」误判成「筛选生效了」。
     */
    const readResults = async () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('h4')).map(h => {
          // 摘要行 `<p>` 与 `h4` **不是**同父：h4 在「标题+锁标记」那一行里，
          // `<p>` 在它上面那层的 `min-w-0` 容器里。
          // ⇒ 从 h4 往上数两层再找 p；找不到就返回空串（**不假装读到了**）。
          const p = h.parentElement?.parentElement?.querySelector('p');
          return {
            name: h.textContent?.trim() ?? '',
            summary: p?.textContent?.trim() ?? '',
          };
        })
      );

    await page.selectOption('#search-filter-saved-within', '24h');
    await page.waitForTimeout(800);
    const in24h = await readResults();
    console.log('   「24 小时内」：', JSON.stringify(in24h));
    check(
      !in24h.some(n => n.name.includes('导入的')),
      '「24 小时内」里**没有**导入件（说它「24 小时内」是假的）',
      `实际 = ${JSON.stringify(in24h)}`
    );
    check(
      in24h.some(n => n.name.includes('刚存的')),
      '「24 小时内」里**有**真的刚存的会话（筛选没被整体打挂）',
      `实际 = ${JSON.stringify(in24h)}`
    );

    await page.selectOption('#search-filter-saved-within', 'unknown');
    await page.waitForTimeout(800);
    const inUnknown = await readResults();
    console.log('   「时间未知」：', JSON.stringify(inUnknown));
    check(
      inUnknown.some(n => n.name.includes('导入的')),
      '「时间未知」桶里**捞得到**导入件（不许被时间筛选静默藏起来）',
      `实际 = ${JSON.stringify(inUnknown)}`
    );
    check(
      !inUnknown.some(n => n.name.includes('刚存的')),
      '「时间未知」桶里**没有**普通会话',
      `实际 = ${JSON.stringify(inUnknown)}`
    );
    check(
      inUnknown.length > 0 && inUnknown.every(n => n.summary.includes('导入于')),
      '「时间未知」桶里的摘要行说「导入于 …」（不说「保存于」—— 那是在替未知的时间编一个值）',
      `实际 = ${JSON.stringify(inUnknown)}`
    );

    // ── ③ 真导入 ────────────────────────────────────────────────────────
    console.log('\n【③ 真走一遍 OneTab 文件导入】');
    await page.selectOption('#search-filter-saved-within', '');
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: '隐藏筛选' }).click().catch(() => {});

    const oneTabFile = join(tmpdir(), 'tapstack-probe-onetab.txt');
    writeFileSync(
      oneTabFile,
      [
        'https://imported-one.example.com/a | 甲',
        'https://imported-one.example.com/b | 乙',
        '',
        'https://imported-two.example.com/c | 丙',
        '',
      ].join('\n'),
      'utf8'
    );

    // 菜单触发钮在 Header.tsx（aria-label =「菜单」）；
    // 面板本身 role="menu" aria-label="应用菜单" ⇒ 用它把范围框住。
    await page.locator('button[aria-label="菜单"]').first().click();
    const menu = page.locator('[role="menu"]');
    await menu.getByRole('menuitem', { name: '导入数据' }).click();
    await page.setInputFiles('input[accept=".txt"]', oneTabFile);

    // ── ④ 两条提示不许互相遮挡（真机**几何**判据）────────────────────────
    //
    // 为什么要单独一段：导入会连着弹两条提示（「注意」= 格式披露，
    // 「完成」= 导入结果）。旧实现的偏移是**写死的 76px** ⇒ 下面那条只要
    // 比 76px 高，就会伸进上面那条的底部 ⇒ **上面那条的结尾被盖住**
    // （真机截图里被盖的正是「列表里显示为「导入 · …」」那半句）。
    //
    // 判据读的是**两条提示的矩形有没有交叠** —— 不是「文案在不在 DOM 里」
    // （被盖住时文案照样在 DOM 里 ⇒ 那种断言恒真 = 零检测力）。
    console.log('\n【④ 两条提示不许互相遮挡】');

    /**
     * 读出每条提示的几何（视口坐标）。
     *
     * 外层是 `role="status"` / `role="alert"` 的 fixed 容器，
     * 内层卡片是它的唯一可见子元素 ⇒ 容器矩形 = 卡片矩形。
     */
    const readToasts = async () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('[role="status"], [role="alert"]'))
          .map(el => {
            const r = el.getBoundingClientRect();
            return {
              role: el.getAttribute('role') ?? '',
              text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
              top: r.top,
              bottom: r.bottom,
              height: r.height,
            };
          })
          .filter(t => t.height > 0)
      );

    // 等两条提示都冒出来（导入是异步的）。
    let toasts = [];
    for (let i = 0; i < 25; i += 1) {
      toasts = await readToasts();
      if (toasts.length >= 2) break;
      await page.waitForTimeout(200);
    }
    console.log(
      '   提示：',
      JSON.stringify(toasts.map(t => ({ role: t.role, h: Math.round(t.height), text: t.text.slice(0, 40) })))
    );

    check(toasts.length >= 2, '导入后同时有两条提示', `实际 = ${toasts.length} 条`);

    // 从上到下排 ⇒ 上面那条的底边必须**不低于**下面那条的顶边。
    const sorted = [...toasts].sort((a, b) => a.top - b.top);
    let overlap = null;
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const upper = sorted[i];
      const lower = sorted[i + 1];
      if (upper.bottom > lower.top + 1) {
        overlap = { upper, lower, by: upper.bottom - lower.top };
        break;
      }
    }
    check(
      overlap === null,
      '两条提示**没有**交叠（下面那条不许盖住上面那条的结尾）',
      overlap
        ? `上面那条的底边 ${overlap.upper.bottom.toFixed(1)} 伸进了下面那条的顶边 ${overlap.lower.top.toFixed(1)}（重叠 ${overlap.by.toFixed(1)}px）`
        : ''
    );

    const notice = toasts.find(t => t.text.includes('OneTab'));
    check(
      !!notice,
      '披露那条提示在（OneTab 格式说明）',
      `实际 = ${JSON.stringify(toasts.map(t => t.text.slice(0, 30)))}`
    );
    if (notice) {
      check(
        notice.text.includes('列表里显示为') && notice.text.includes('时间未知'),
        '披露那句话**完整**在提示里（「保存时间未知」那半句没被截断）',
        `实际 = ${notice.text.slice(-80)}`
      );
    }

    await page.screenshot({ path: '/tmp/_probe-imported-save-time-toasts.png' });

    await page.waitForTimeout(3000);

    const times = await readTimes();
    console.log('   导入后时间位：', JSON.stringify(times));
    const importedOnes = times.filter(t => /^导入 · /.test(t));
    check(
      importedOnes.length >= 2,
      '真导入的会话写「导入 · …」（两批都算）',
      `实际 = ${JSON.stringify(times)}`
    );
    const lastIsImported = times.length > 0 && /^导入 · /.test(times[times.length - 1] ?? '');
    check(
      lastIsImported,
      '导入件排在列表**最后**（不霸占「最近保存」的榜首）',
      `实际顺序 = ${JSON.stringify(times)}`
    );
    const noBareToday = times.filter(t => t === '今天').length === 1;
    check(
      noBareToday,
      '只有那条「刚存的」写「今天」（导入件不冒充它）',
      `实际 = ${JSON.stringify(times)}`
    );

    await page.screenshot({ path: '/tmp/_probe-imported-save-time.png', fullPage: true });
  } finally {
    await ctx.close();
  }

  console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项未通过`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
