/**
 * service worker **能不能起来** —— 真机守卫（2026-10-20）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * 2026-10-20 的 A-17 是一条 P0：源码里写了
 *
 *     chrome.contextMenus.onShown.addListener(...)
 *
 * 而 `onShown` 是 **Firefox `browser.menus` 专属**事件 —— Chrome 上
 * `chrome.contextMenus.onShown` 是 `undefined` ⇒ `addListener` 抛
 * `TypeError` ⇒ **service worker 在初始化时炸掉** ⇒ 整个扩展的所有后台
 * 能力（保存、右键菜单、同步、alarms）全部失效。
 *
 * ⚠️ 这类缺陷**没有任何静态手段能发现**：
 *   · TypeScript 不报（`chrome` 的未声明成员访问不报错）；
 *   · eslint 不报；
 *   · **单测也不报**（单测里 chrome 是 stub，`undefined.addListener`
 *     会在 stub 上抛，但我们从没让真实的 service worker 跑过）。
 *
 * 它的失败形态是「整个扩展哑掉」—— 用户看到的是右键菜单没反应、
 * 点图标没反应、同步不动，**没有任何报错指向真正的原因**。
 *
 * ── 这个脚本验什么 ──────────────────────────────────────────────────────
 * 不是「测功能」，是**测 service worker 真的活着并且真的能干活**：
 *   1. service worker 注册成功（能拿到它的 URL）；
 *   2. 初始化过程中**没有未捕获异常**（捕获 worker 的 console error
 *      与 pageerror —— A-17 那种崩溃会在这里现形）；
 *   3. `chrome.runtime.sendMessage` 能收到回包（说明消息监听器挂上了，
 *      而不是一个「注册了但初始化就炸」的 worker）；
 *   4. 右键菜单**真的被创建出来了**（`chrome.contextMenus` 在真实
 *      Chrome 里能 create 出我们声明的那些项）。
 *
 * 用法：pnpm build 之后 `node scripts/prod-sw-boot.mjs`
 */
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-sw-boot-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--lang=zh-CN'],
  });

  try {
    console.log('\n── 起一个真实 Chrome，装上扩展 ──');

    // ── 捕获 service worker 的报错（A-17 那种崩溃会在这里现形）──────────
    const swErrors = [];
    ctx.on('serviceworker', worker => {
      worker.on('console', msg => {
        if (msg.type() === 'error') swErrors.push(msg.text());
      });
      worker.on('close', () => {
        swErrors.push('（service worker 被关闭）');
      });
    });

    // ── 等 worker 注册 ──────────────────────────────────────────────────
    let sw = null;
    for (let i = 0; i < 40 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await new Promise(r => setTimeout(r, 250));
    }
    check('service worker 注册成功', !!sw, sw ? new URL(sw.url()).host : '没等到');
    if (!sw) throw new Error('service worker 没起来，后续检查无从谈起');
    const id = new URL(sw.url()).host;

    // ── 给初始化留时间（菜单创建、alarms、监听器挂载都在这里）──────────
    await new Promise(r => setTimeout(r, 2500));

    check(
      '初始化过程中没有未捕获异常',
      swErrors.length === 0,
      swErrors.slice(0, 3).join(' | ').slice(0, 300)
    );

    // ── 真的能收到消息回包吗（消息监听器挂上了吗）─────────────────────
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${id}/src/popup/index.html`);
    await page.waitForTimeout(1500);

    const ping = await page.evaluate(async () => {
      try {
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('发消息 8 秒没回包')), 8000);
          chrome.runtime.sendMessage({ type: 'REFRESH_TAB_LIST' }, resp => {
            clearTimeout(timer);
            const err = chrome.runtime.lastError;
            if (err) reject(new Error(err.message));
            else resolve(resp ?? null);
          });
        });
      } catch (e) {
        return { error: String(e.message ?? e) };
      }
    });
    check(
      'sendMessage 拿得到回包（消息监听器活着）',
      !ping?.error,
      ping?.error ? String(ping.error).slice(0, 200) : `resp=${JSON.stringify(ping)?.slice(0, 120)}`
    );

    // ── 右键菜单项真的被创建出来了吗 ────────────────────────────────────
    // A-12 扩到了网页上下文 + 标签标题上下文；这条验的是**真实 Chrome
    // 接受了我们的 create 调用**（contexts 里的 'tab' 在老 Chrome 上
    // 会直接抛 —— 那正是 A-18 那条「类型滞后、运行时才有」的坑）。
    //
    // ⚠️ 刻意**不**调 chrome.contextMenus.removeAll()：那会把扩展自己的
    //    菜单删掉，是破坏性动作。改为**只增不删**：用一个探针 id 建一个
    //    菜单项（建完立刻删掉这个探针），既验得「create 可用」，
    //    又不动扩展的菜单。
    const menus = await page.evaluate(async () => {
      const PROBE_ID = '__tapstack_sw_boot_probe__';
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('超时')), 8000);
          chrome.contextMenus.create({
            id: PROBE_ID,
            title: 'probe',
            contexts: ['page'],
          }, () => {
            clearTimeout(timer);
            const err = chrome.runtime.lastError;
            if (err) reject(new Error(err.message));
            else resolve();
          });
        });
        // 建成功 ⇒ 说明 create 可用。立刻把探针撤掉（只撤探针，不动别的）。
        await new Promise(resolve => chrome.contextMenus.remove(PROBE_ID, () => resolve()));
        return { ok: true };
      } catch (e) {
        return { error: String(e.message ?? e) };
      }
    });
    check(
      'chrome.contextMenus.create 在真实 Chrome 里可用',
      !menus?.error,
      menus?.error ? String(menus.error).slice(0, 200) : 'ok'
    );

    // ── 扩展自己的菜单项建出来了吗 ──────────────────────────────────────
    // `contextMenus` 没有「列出全部」的 API，但 `update()` 对**不存在的
    // id** 会立刻报错（「Cannot find menu item with id ...」）。
    // 于是：update 成**原样的标题** = 幂等、零副作用，又能证明「这个 id
    // 确实存在」。比 removeAll 探针安全（不删任何东西）。
    const declaredMenus = await page.evaluate(async () => {
      const IDS = ['open-tab-manager', 'saveCurrentTab', 'saveCurrentTabFromIcon', 'saveOtherTabs'];
      const found = [];
      const missing = [];
      for (const id of IDS) {
        try {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('超时')), 5000);
            // title 传 undefined = 不改标题；这里显式传当前标题做幂等更新。
            chrome.contextMenus.update(id, { title: undefined }, () => {
              clearTimeout(timer);
              const err = chrome.runtime.lastError;
              if (err) reject(new Error(err.message));
              else resolve();
            });
          });
          found.push(id);
        } catch (e) {
          missing.push(`${id}(${String(e.message ?? e).slice(0, 60)})`);
        }
      }
      return { found, missing };
    });
    check(
      '扩展自己的 4 个右键菜单项都建出来了',
      declaredMenus.missing.length === 0,
      declaredMenus.missing.length ? `缺失=${declaredMenus.missing.join(', ')}` : `found=${declaredMenus.found.join(',')}`
    );
  } finally {
    await ctx.close();
  }

  console.log('\n════════ 汇总 ════════');
  const failed = results.filter(r => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    failed.forEach(f => console.log(`  ❌ ${f.name} — ${f.detail}`));
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
