// 真机测量：**页面「看不见了」时，浏览器到底报什么信号。**
//
// ── 它守的是什么 ────────────────────────────────────────────────────────
// 「撤销提示在页面看不见时暂停倒计时」那一半（暂停时限）能不能只靠
// `document.hidden` 判断？本脚本给出**决定性答案**，并把它钉成断言：
//
//   · 后台**标签**（同窗口，另一个标签在前台）
//       ⇒ document.hidden = true，visibilitychange 会触发
//   · 后台**窗口里的活动标签**（本窗口的活动标签就是本页，窗口本身在后台）
//       ⇒ document.hidden = **false**，visibilitychange **不触发**
//       （!hasFocus() 倒是会变 false）
//
// ⇒ **只用 document.hidden 的话，「整组恢复到新窗口」这条路径根本不会被覆盖**：
//    管理页仍是它自己窗口的活动标签，只是那个窗口在后台。
//
// ── 为什么必须绕开 Playwright ──────────────────────────────────────────
// Playwright 默认开着 `Emulation.setFocusEmulationEnabled`
// （见 playwright-core/lib/coreBundle.js）⇒ 页面被「模拟成永远在前台」
// ⇒ `document.hidden` / `visibilityState` / `visibilitychange` 全部失真。
// 用它下结论会把「Playwright 的假象」当成「Chrome 的行为」。
//
// 这里直接用裸 CDP（Node 内置 WebSocket）驱动一个**自己启动的 Chrome**。
//
// ── 断言 ────────────────────────────────────────────────────────────────
// ① 后台标签 ⇒ hidden === true
// ② 后台窗口里的活动标签 ⇒ hidden === false（**这条是最容易被想当然的**）
// 任一条不成立 ⇒ 退出码 1（平台行为变了 ⇒ 依赖它的实现必须重新核对）。
//
// 用法：node scripts/lead-verify-page-visibility.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  join(homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  join(homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const CHROME = CHROME_CANDIDATES.find(p => existsSync(p));
if (!CHROME) {
  console.error('找不到可用的 Chrome/Chrome for Testing —— 本脚本需要真实浏览器来测可见性信号。');
  process.exit(2);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const DATA_URL = 'data:text/html,<title>manager-like-page</title><body>probe</body>';

/** 起一个干净的 Chrome，返回 { chrome, cdp, page, targets, kill }。 */
async function boot(port) {
  const profile = mkdtempSync(join(tmpdir(), `tapstack-vis-${port}-`));
  const chrome = spawn(CHROME, [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check',
    DATA_URL,
  ], { stdio: 'ignore' });

  const httpJson = async (p) => {
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}${p}`);
        if (res.ok) return await res.json();
      } catch {}
      await sleep(250);
    }
    throw new Error('CDP 没起来');
  };

  const list = await httpJson('/json/list');
  const page = list.find(t => t.type === 'page');
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await sleep(1500);

  return {
    cdp, page,
    targets: async () => (await httpJson('/json/list'))
      .filter(t => t.type === 'page')
      .map(t => ({ id: t.id, url: t.url.slice(0, 48) })),
    // 杀浏览器之后**等它把 profile 写完**再删 —— 立刻删会撞上 ENOTEMPTY
    // （Chrome 还在落盘）。删不掉也不该让整轮测量失败 ⇒ 吞掉。
    kill: async () => {
      chrome.kill('SIGKILL');
      await sleep(500);
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch { /* 临时目录留着也无妨 */ }
    },
  };
}

/** 一个最小的 CDP 客户端。 */
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new Cdp(ws);
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { resolve, reject } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

const readSignals = (cdp) => cdp.send('Runtime.evaluate', {
  expression: `({ hidden: document.hidden, vis: document.visibilityState, hasFocus: document.hasFocus(), vc: window.__vc ?? -1 })`,
  returnByValue: true,
}).then(r => r.result.value);

const installCounter = (cdp) => cdp.send('Runtime.evaluate', {
  expression: `window.__vc = 0; document.addEventListener('visibilitychange', () => { window.__vc++; }); true;`,
  returnByValue: true,
});

const problems = [];

// ── 场景 1：后台**标签**（同窗口，另一个标签在前台）────────────────────
{
  const b = await boot(9351);
  try {
    await installCounter(b.cdp);
    const base = await readSignals(b.cdp);
    const other = await b.cdp.send('Target.createTarget', { url: 'data:text/html,<title>tab2</title>' });
    await b.cdp.send('Target.activateTarget', { targetId: other.targetId });
    await sleep(1500);
    const after = await readSignals(b.cdp);
    console.log('【场景 1】后台标签（同窗口，另一个标签在前台）');
    console.log('   基线:', JSON.stringify(base));
    console.log('   之后:', JSON.stringify(after));
    console.log('   页面清单:', JSON.stringify(await b.targets()));
    if (after.hidden !== true) {
      problems.push('后台标签时 document.hidden 不是 true ⇒ 以它为判据的「隐藏时暂停」在「整组→当前窗口」路径上不成立');
    }
    if (after.vc <= base.vc) {
      problems.push('后台标签时 visibilitychange 没有触发 ⇒ 靠事件驱动暂停的实现不会启动');
    }
  } finally {
    await b.kill();
  }
  await sleep(500);
}

// ── 场景 2：后台**窗口里的活动标签**（本窗口的活动标签就是本页）────────
{
  const c = await boot(9352);
  try {
    await installCounter(c.cdp);
    const base = await readSignals(c.cdp);
    const win2 = await c.cdp.send('Target.createTarget', { url: 'data:text/html,<title>win2</title>', newWindow: true });
    await c.cdp.send('Target.activateTarget', { targetId: win2.targetId });
    await sleep(1800);
    const after = await readSignals(c.cdp);
    console.log('\n【场景 2】后台窗口里的活动标签（=「整组恢复到新窗口」后管理页的精确状态）');
    console.log('   基线:', JSON.stringify(base));
    console.log('   之后:', JSON.stringify(after));
    console.log('   页面清单:', JSON.stringify(await c.targets()));
    if (after.hidden !== false) {
      problems.push('后台窗口里的活动标签，document.hidden 不再是 false ⇒ 「恢复→新窗口」这条路径也会被 hidden 覆盖（判据要重新算）');
    }
    if (after.hasFocus !== false) {
      problems.push('后台窗口里的活动标签，document.hasFocus() 不是 false ⇒ !hasFocus() 也覆盖不了「恢复→新窗口」这条路径');
    }
    // 切回前台应当可逆
    await c.cdp.send('Target.activateTarget', { targetId: c.page.id });
    await sleep(1500);
    const back = await readSignals(c.cdp);
    console.log('   切回本页:', JSON.stringify(back));
    if (back.hidden !== false) {
      problems.push('切回前台后 document.hidden 仍是 true ⇒ 可见性信号不跟着窗口焦点走，判据不可用');
    }
  } finally {
    await c.kill();
  }
  await sleep(500);
}

console.log('\n===== 结论 =====');
console.log('document.hidden 只认「后台**标签**」，不认「后台**窗口里的活动标签**」。');
console.log('⇒ 「整组恢复到当前窗口」那条路径，hidden 判据成立；');
console.log('⇒ 「整组恢复到新窗口」那条路径，hidden 判据**不成立**（要加 !hasFocus() 才成立）。');

if (problems.length > 0) {
  console.log('\n❌ 断言不成立：');
  for (const p of problems) console.log('   ✗', p);
  process.exitCode = 1;
} else {
  console.log('\n✅ 全部断言成立（页面不可见信号的行为与上面写的一致）。');
}
