/**
 * 用户引导（onboarding）的**真机**守卫（2026-10-20 审计 B-1 / B-2）。
 *
 * ── 为什么单测不够 ────────────────────────────────────────────────────────
 * 引导是「装扩展 → 第一次打开管理页」才会出现的东西。它的触发条件跨越
 * **两个执行上下文**：
 *
 *   · service worker 的 `chrome.runtime.onInstalled` **写** `onboarding_trigger`；
 *   · 管理页（另一个 tab、另一份模块实例）**读**它并决定要不要挂引导。
 *
 * 单测里两边都在同一个进程里、chrome 是 stub，**读不到**「SW 真的写了、
 * 页面真的读到了」这条链。而这条链一旦断掉，症状是
 * **用户永远看不到首次引导** —— 没有报错、没有红字，只是什么都没发生。
 *
 * 另外，2026-10-20 抓到的两个真实缺陷也只有真机能复现：
 *   ① install 触发被 update 触发无条件覆写 ⇒ 「装完没打开过页面就升级」
 *      的用户永远看不到引导；
 *   ② 引导被跳过后**回不去**（没有重看入口）。
 *
 * ── 这个脚本验什么 ────────────────────────────────────────────────────────
 *   1. 首次安装 ⇒ 打开管理页 ⇒ 引导真的出现；
 *   2. 引导的 6 步能真的走完（点「下一步」会前进，不是死按钮）；
 *   3. 跳过后引导**不再**自动出现（一次性语义成立）；
 *   4. 菜单里有「使用引导」⇒ 点了引导**真的重放**（用户回得去）；
 *   5. 走完引导后 ⇒ 引导不再自动出现；
 *   6. **装完没打开过页面就重启** ⇒ 引导仍然出现；
 *   7. **看完 / 跳过后 ⇒ 引导不再回来**（跨浏览器重启），
 *      但仍能通过菜单「使用引导」手动重看（缺陷 ③ 的真机复现）。
 *
 * 第 7 条抓的是一条**真机上才暴露**的缺陷：`hasCompletedOnboarding`
 * 被写了却**从来没有被读过** ⇒ 触发信息一被重新写上，引导就又回来了。
 * unpacked 扩展每次启动浏览器都会重装（`onInstalled('install')` 每次触发），
 * 于是用户跳过了引导也停不下来 —— 每次重启它都回来。
 *
 * ── 这个脚本**验不到**的东西（诚实记下来，别假装覆盖了）────────────────
 * **「install 触发压过 update 触发」这条不变量在真机上验不了。**
 * unpacked 扩展（`--load-extension`）**每次启动浏览器都会被重装** ⇒
 * Chrome 每次都发 `onInstalled('install')`，**从不发** `'update'`。
 * 实测过两条可能的绕法，都不通：
 *   · `chrome.runtime.reload()` ⇒ 它会把整个浏览器上下文一起拆掉，
 *     Playwright 的 page 全部关闭，后续断言无从谈起；
 *   · 改 manifest 的 version 再用同 profile 重启 ⇒ Chrome **仍然**发
 *     `'install'`（因为它认的是「这个 unpacked 扩展被重新加载」，
 *     不是「版本号变了」）。实测第二次启动的触发信息是
 *     `{reason:'install', version:'<新版本号>'}`。
 * 装成 .crx 再升级才是真正的 `'update'`，但那需要打包 + 签名，
 * Playwright 装不了。
 * ⇒ 这条不变量由 **单测** 覆盖（合并逻辑是纯 IO，`tests/onboardingTrigger.test.ts`
 * 的 B1/B3/B3b/B4 用例）。本脚本只负责**真机那半边**：
 * 「触发信息确实被写进了真实的 chrome.storage」「引导确实在真实浏览器里出现/
 * 不出现」「菜单项确实能重放」。
 *
 * 用法：pnpm build 之后 `node scripts/prod-onboarding.mjs`
 * 结果：每条打印 ✅/❌，任一 ❌ ⇒ exit 1。
 */
import { chromium } from 'playwright';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const results = [];
const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? '✅' : '❌'}${name}${detail ? ` — ${detail}` : ''}`);
    return ok;
};

/** 等引导遮罩出现（首次安装是异步读存储后才挂载的）。 */
async function waitForOverlay(page, timeout = 8000) {
    const overlay = page.locator('.onboarding-overlay');
    try {
        await overlay.waitFor({ state: 'visible', timeout });
        return true;
    } catch {
        return false;
    }
}

async function main() {
    const profile = mkdtempSync(join(tmpdir(), 'tapstack-onboarding-'));
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
        console.log('\n── 起一个真实 Chrome，装上扩展 ──');

        let sw = null;
        for (let i = 0; i < 40 && !sw; i++) {
            sw = ctx.serviceWorkers()[0] ?? null;
            if (!sw) await new Promise(r => setTimeout(r, 500));
        }
        if (!sw) throw new Error('service worker 没起来 —— 扩展没加载');
        const id = new URL(sw.url()).host;
        const managerUrl = `chrome-extension://${id}/src/popup/index.html`;
        console.log(`  扩展 ID: ${id}`);

        // ── ① 首次安装 ⇒ 引导真的出现 ──────────────────────────────────
        const page = await ctx.newPage();
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(managerUrl);
        await page.waitForTimeout(1500);

        const appeared = await waitForOverlay(page);
        check('① 首次安装后打开管理页 ⇒ 引导真的出现', appeared);

        if (!appeared) {
            // 诊断：把触发信息打出来，便于判断是「SW 没写」还是「页面没读」
            const trigger = await page.evaluate(async () => {
                const r = await chrome.storage.local.get('onboarding_trigger');
                return r.onboarding_trigger ?? null;
            });
            check(
                '① 诊断：onboarding_trigger 的内容',
                true,
                JSON.stringify(trigger)
            );
        } else {
            // ── ② 6 步能真的走完 ──────────────────────────────────────
            const skipBtn = page.locator('button[aria-label="跳过引导"]');
            check('② 引导有「跳过」按钮', (await skipBtn.count()) === 1);

            // 逐步点「下一步」，每一步标题都要变（证明它不是死按钮）
            const titles = [];
            for (let step = 0; step < 5; step++) {
                const nextBtn = page.locator('button[aria-label="下一步"]');
                if ((await nextBtn.count()) === 0) break;
                const before = await page.locator('.onboarding-title').first().textContent();
                titles.push((before ?? '').trim());
                await nextBtn.click();
                await page.waitForTimeout(350);
            }
            const after = await page.locator('.onboarding-title').first().textContent();
            titles.push((after ?? '').trim());

            const unique = new Set(titles);
            check(
                '② 点「下一步」会真的前进（标题在变）',
                unique.size > 1,
                `走过 ${titles.length} 步，${unique.size} 个不同标题`
            );

            // 最后一步的按钮应变成「开始使用」
            const startBtn = page.locator('button[aria-label="开始使用"]');
            check('② 走到最后一步 ⇒ 按钮变成「开始使用」', (await startBtn.count()) === 1);
            if ((await startBtn.count()) === 1) {
                await startBtn.click();
                await page.waitForTimeout(800);
            }
            const closed = (await page.locator('.onboarding-overlay').count()) === 0;
            check('② 点「开始使用」⇒ 引导关闭', closed);
        }

        // ── ③ 关掉/跳过后 ⇒ 不再自动出现（一次性语义） ─────────────────
        const page2 = await ctx.newPage();
        await page2.goto(managerUrl);
        await page2.waitForTimeout(1800);
        const reopened = await waitForOverlay(page2, 2500);
        check('③ 看完引导后重开管理页 ⇒ 不再自动出现', !reopened);

        // ── ④ 菜单里有「使用引导」⇒ 点了真的重放 ─────────────────────
        const menuBtn = page2.getByRole('button', { name: '菜单' });
        check('④ 顶栏有「菜单」按钮', (await menuBtn.count()) === 1);

        if ((await menuBtn.count()) === 1) {
            await menuBtn.click();
            await page2.waitForTimeout(600);

            const replayItem = page2.getByRole('menuitem', { name: '使用引导' });
            const itemCount = await replayItem.count();
            check('④ 菜单里有「使用引导」这一项', itemCount === 1, `count=${itemCount}`);

            if (itemCount === 1) {
                await replayItem.click();
                await page2.waitForTimeout(1000);
                const replayed = await waitForOverlay(page2, 3000);
                check('④ 点「使用引导」⇒ 引导真的重放（用户回得去）', replayed);
            }
        }

        // ── ⑤ 走完重放的引导 ⇒ 之后不再自动出现 ───────────────────────
        if (await page2.locator('.onboarding-overlay').count()) {
            const skip2 = page2.locator('button[aria-label="跳过引导"]');
            if ((await skip2.count()) === 1) {
                await skip2.click();
                await page2.waitForTimeout(700);
            }
        }
        const page3 = await ctx.newPage();
        await page3.goto(managerUrl);
        await page3.waitForTimeout(1800);
        const notAgain = (await waitForOverlay(page3, 2500)) === false;
        check('⑤ 重放并跳过后 ⇒ 引导不再自动出现', notAgain);
    } finally {
        await ctx.close();
    }

    // ══════════════════════════════════════════════════════════════════
    // ⑥ 装完没打开过页面就升级 ⇒ 引导仍然出现
    //
    // 这是缺陷 ① 的真机复现，也是**唯一**能在真机上触发 `onInstalled('update')`
    // 的路径：把 manifest 的 version 改掉，用**同一个 profile** 重启 Chrome
    // —— Chrome 会把它当成一次升级。
    //
    // `chrome.runtime.reload()` 做不到这件事：它会把整个浏览器上下文一起
    // 拆掉，Playwright 的 page 全部关闭，后续断言无从谈起（实测过）。
    // ══════════════════════════════════════════════════════════════════
    await checkUpgradeKeepsInstallTrigger();
    await checkCompletedOnboardingStaysGone();

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 通过`);
    if (failed.length) {
        console.log('失败项：');
        for (const f of failed) console.log(`  · ${f.name}  ${f.detail}`);
        process.exitCode = 1;
    }
}

/**
 * 看完 / 跳过后，引导**不能再回来** —— 跨浏览器重启也不行。
 *
 * 为什么这条要在真机上验：单测里 chrome.storage 是内存桩，
 * 「SW 重新写触发信息」这一步根本不存在。
 *
 * 真机上会重现的原因：unpacked 扩展（`--load-extension`）**每次启动浏览器
 * 都会重装** ⇒ `onInstalled('install')` 每次触发 ⇒ 触发信息被反复写上。
 * 没有「已完成」这道闸门时，用户跳过了引导也停不下来 —— 每次重启都回来。
 */
async function checkCompletedOnboardingStaysGone() {
    console.log('\n── ⑦ 看完 / 跳过后 ⇒ 引导不再回来（跨浏览器重启）──');

    const profile = mkdtempSync(join(tmpdir(), 'tapstack-onb-persist-'));

    /** 起浏览器、开管理页、等引导稳定，返回上下文。 */
    const open = async () => {
        const ctx = await chromium.launchPersistentContext(profile, {
            headless: false,
            args: [
                `--disable-extensions-except=${DIST}`,
                `--load-extension=${DIST}`,
                '--no-first-run',
                '--lang=zh-CN',
            ],
        });
        let sw = null;
        for (let i = 0; i < 40 && !sw; i++) {
            sw = ctx.serviceWorkers()[0] ?? null;
            if (!sw) await new Promise(r => setTimeout(r, 500));
        }
        if (!sw) {
            await ctx.close();
            throw new Error('service worker 没起来 —— 扩展没加载');
        }
        const id = new URL(sw.url()).host;
        const page = await ctx.newPage();
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(`chrome-extension://${id}/src/popup/index.html`);
        await page.waitForTimeout(2200);
        return { ctx, page };
    };

    let session = null;
    try {
        // ── 第一次：走完引导 ──────────────────────────────────────────
        session = await open();
        const appeared = await waitForOverlay(session.page, 6000);
        check('⑦ 首次安装 ⇒ 引导出现', appeared);

        if (appeared) {
            for (let i = 0; i < 5; i++) {
                const next = session.page.locator('button[aria-label="下一步"]');
                if ((await next.count()) === 0) break;
                await next.click();
                await session.page.waitForTimeout(250);
            }
            const start = session.page.locator('button[aria-label="开始使用"]');
            if ((await start.count()) === 1) {
                await start.click();
                await session.page.waitForTimeout(1200);
            }
        }
        await session.ctx.close();
        session = null;

        // ── 第二次：重启浏览器 ⇒ 引导不该再出现 ───────────────────────
        session = await open();
        const cameBack = await waitForOverlay(session.page, 3000);
        check(
            '⑦ 看完引导后重启浏览器 ⇒ 引导不再出现',
            !cameBack,
            '用户跳过了也停不下来 —— 每次重启都回来'
        );

        // ── 但仍然能主动重看 ──────────────────────────────────────────
        const menu = session.page.getByRole('button', { name: '菜单' });
        if ((await menu.count()) === 1) {
            await menu.click();
            await session.page.waitForTimeout(600);
            const item = session.page.getByRole('menuitem', { name: '使用引导' });
            if ((await item.count()) === 1) {
                await item.click();
                await session.page.waitForTimeout(1000);
                const replayed = await waitForOverlay(session.page, 3000);
                check('⑦ 看完之后仍能通过菜单主动重看', replayed);
            } else {
                check('⑦ 菜单里有「使用引导」（看完之后仍可重看）', false, '菜单项不见了');
            }
        }
    } finally {
        if (session) await session.ctx.close();
    }
}

/**
 * 「装完没打开过管理页 → 商店升级」这条路径下，引导必须仍然会出现。
 *
 * 做法：全新 profile 装一次（拿到 install 触发）⇒ **不打开管理页** ⇒
 * 改 manifest 版本号 ⇒ 同一 profile 重启 ⇒ 打开管理页 ⇒ 引导应当出现。
 */
async function checkUpgradeKeepsInstallTrigger() {
    console.log('\n── ⑥ 装完没打开过页面就重启 ⇒ 引导必须仍然出现 ──');

    const profile = mkdtempSync(join(tmpdir(), 'tapstack-onb-upg-'));
    const manifestPath = join(DIST, 'manifest.json');
    const originalManifest = readFileSync(manifestPath, 'utf8');
    const originalVersion = JSON.parse(originalManifest).version;

    /** 起一个装了扩展的浏览器，等 service worker 起来，返回上下文与扩展 ID。 */
    const launch = async () => {
        const ctx = await chromium.launchPersistentContext(profile, {
            headless: false,
            args: [
                `--disable-extensions-except=${DIST}`,
                `--load-extension=${DIST}`,
                '--no-first-run',
                '--lang=zh-CN',
            ],
        });
        let sw = null;
        for (let i = 0; i < 40 && !sw; i++) {
            sw = ctx.serviceWorkers()[0] ?? null;
            if (!sw) await new Promise(r => setTimeout(r, 500));
        }
        if (!sw) {
            await ctx.close();
            throw new Error('service worker 没起来 —— 扩展没加载');
        }
        return { ctx, id: new URL(sw.url()).host };
    };

    let ctx = null;
    try {
        // ── 第一次：全新安装，**不打开管理页** ──────────────────────────
        const first = await launch();
        ctx = first.ctx;
        // 只等 SW 起来就行 —— 就是不打开管理页（用户还没用过扩展）
        await new Promise(r => setTimeout(r, 1200));

        // 装完应当已经写下了 install 触发（证明「装」这条路是通的）
        const afterInstall = await readTrigger(ctx);
        check(
            '⑥ 装完（还没打开过管理页）⇒ 已写下 install 触发',
            afterInstall?.reason === 'install',
            JSON.stringify(afterInstall)
        );
        await ctx.close();
        ctx = null;

        // ── 改版本号 = 模拟一次版本推进 ────────────────────────────────
        const bumped = JSON.parse(originalManifest);
        bumped.version = bumpPatch(originalVersion);
        writeFileSync(manifestPath, JSON.stringify(bumped, null, 2));

        // ── 第二次：同一个 profile 重启（用户依然没打开过管理页）───────
        const second = await launch();
        ctx = second.ctx;

        const trigger = await readTrigger(ctx);
        check(
            '⑥ 版本推进 + 重启后触发信息仍是 install（没被冲掉）',
            trigger?.reason === 'install',
            JSON.stringify(trigger)
        );

        const page = await ctx.newPage();
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(`chrome-extension://${second.id}/src/popup/index.html`);
        await page.waitForTimeout(2200);
        const appeared = await waitForOverlay(page, 5000);
        check(
            '⑥ 装完没打开过管理页就重启 ⇒ 引导仍然出现',
            appeared,
            '这个用户会永远看不到首次引导'
        );
    } finally {
        if (ctx) await ctx.close();
        // manifest 必须还原 —— 否则后续构建/测试全被带偏
        writeFileSync(manifestPath, originalManifest);
    }
}

/** 读当前的触发信息（用页面上下文读 chrome.storage）。 */
async function readTrigger(ctx) {
    const page = await ctx.newPage();
    try {
        const sw = ctx.serviceWorkers()[0];
        if (!sw) return null;
        const id = new URL(sw.url()).host;
        await page.goto(`chrome-extension://${id}/src/popup/index.html`);
        await page.waitForTimeout(800);
        return await page.evaluate(async () => {
            const r = await chrome.storage.local.get('onboarding_trigger');
            return r.onboarding_trigger ?? null;
        });
    } finally {
        await page.close();
    }
}

/** 把版本号的 patch 段 +1（模拟一次不引入新功能的修复版本升级）。 */
function bumpPatch(version) {
    const parts = String(version).split('.');
    const patch = Number.parseInt(parts[2] ?? '0', 10);
    parts[2] = String((Number.isFinite(patch) ? patch : 0) + 1);
    return parts.join('.');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
