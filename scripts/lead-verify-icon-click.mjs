// 真机验证：「点扩展图标 = 把**点的那一个窗口**存成会话并关掉它」（2026-10-24）。
//
// ── 为什么必须真机 ───────────────────────────────────────────────────────
//
// 产品负责人的原话：「在单独的 Chrome APP 实例中点击后，标签页和标签管理器
// 并未成功展示」。这不是「代码写错了」能解释的那一类 —— 单测里的 chrome mock
// **由我们自己写**，它对「`chrome.tabs.create({windowId})` 到底开在哪个窗口」
// 「`chrome.tabs.query({windowId})` 到底筛不筛窗口」没有任何发言权
// （本仓同类教训见 memory「假服务器的自证式盲区」：假实现只会吐自家解析器
// 认得的形状）。
//
// ⇒ 这条链路的**三个真实语义**只能在真 Chrome 里验：
//   ① `chrome.action.onClicked` 收得到的那个 `tab.windowId` 是不是「点的那一个」；
//   ② `chrome.tabs.query({windowId})` 是不是真的只回那个窗口的标签；
//   ③ `chrome.tabs.create({url, windowId})` 是不是真的开在那个窗口里
//      （关标签前的占位新标签靠的就是它 —— 不带 windowId 会开在
//      「最后被聚焦的窗口」，用户点的那一边窗口会整个消失）。
//
// ── 怎么「真的点图标」 ───────────────────────────────────────────────────
//
// Chrome **没有**供脚本调用的「派发 action 点击」API。但扩展事件对象在
// Chromium 实现里带 `dispatch()` ⇒ 可以把一个**合成的 tab**（带 windowId）
// 投给**真实的** `chrome.action.onClicked` 监听器 ⇒ 走的是生产代码那条路，
// 不是「我写的探针按我写的预期跑」。
// ⚠️ 若某个 Chrome 版本没有 `dispatch` ⇒ 脚本**直接失败**（不许静默降级成
// 「验了别的东西」）—— 探针必须真的落在目标状态上。
//
// ── 断言的五件事 ─────────────────────────────────────────────────────────
//
//   ① **窗口 B 的标签真的被关了**（只关了 B 的，没关 A 的）
//   ② **占位新标签开在 B 里**（A 里不许多出空白页）
//   ③ **管理器页开在 B 里**（A 里不许有 —— 这正是「点了像没点」的来源）
//   ④ **确实存成了会话**（读工具栏徽标：保存回执写着存了几个）
//   ⑤ **A 窗口的标签一个没动**

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/lead-verify-icon-click');

const problems = [];
const log = [];

function check(ok, message, detail = '') {
  if (!ok) problems.push(`${message}${detail ? ` —— ${detail}` : ''}`);
  return ok;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 在扩展的 service worker 上下文里列出全部标签（连窗口号）。 */
async function inventory(sw) {
  return sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.map(t => ({
      id: t.id,
      url: t.url ?? '',
      windowId: t.windowId,
      title: t.title ?? '',
    }));
  });
}

/** 读工具栏徽标（保存回执：写着「刚刚存了 N 个」）。 */
async function readBadge(sw) {
  return sw.evaluate(async () => chrome.action.getBadgeText({}));
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-icon-click-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--lang=zh-CN',
    ],
    viewport: { width: 1280, height: 800 },
  });

  try {
    // ── 0. 找到扩展的 service worker ────────────────────────────────────
    let sw = null;
    for (let i = 0; i < 40 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await sleep(500);
    }
    if (!sw) throw new Error('扩展的 service worker 没有起来');
    const extId = new URL(sw.url()).host;
    log.push({ step: '扩展已启动', extId });

    // ── 1. 造两个窗口，各放两个可保存的标签 ──────────────────────────────
    // 窗口 A：Playwright 启动时的那个窗口。
    const pageA = ctx.pages()[0] ?? (await ctx.newPage());
    await pageA.goto('https://example.com/a-0');
    const pageA2 = await ctx.newPage();
    await pageA2.goto('https://example.com/a-1');

    // 窗口 B：真正的**另一个窗口**（newWindow: true）。
    const session = await ctx.newCDPSession(pageA);
    await session.send('Target.createTarget', {
      url: 'https://example.com/b-0',
      newWindow: true,
    });
    await sleep(1200);
    const pageB = ctx.pages().find(p => p.url().includes('/b-0'));
    if (!pageB) throw new Error('没造出第二个窗口');
    const pageB2 = await ctx.newPage();
    await pageB2.goto('https://example.com/b-1');
    await sleep(1500);

    // 关掉遗留的空白页（about:blank / chrome://newtab），只留我们造的。
    for (const p of ctx.pages()) {
      const u = p.url();
      if (u === 'about:blank' || u === 'chrome://newtab/' || u === '') {
        await p.close().catch(() => {});
      }
    }
    await sleep(500);

    // ── 2. 认出两个窗口的 windowId（从扩展的视角读，不靠猜）──────────────
    const before = await inventory(sw);
    const windowA = before.find(t => t.url.includes('/a-0'))?.windowId;
    const windowB = before.find(t => t.url.includes('/b-0'))?.windowId;
    if (windowA === undefined || windowB === undefined) {
      throw new Error(`认不出两个窗口：A=${windowA} B=${windowB}（读到 ${JSON.stringify(before)}）`);
    }
    if (windowA === windowB) throw new Error('两个窗口的 windowId 一样 ⇒ 这轮验证没有意义');
    const tabsA = before.filter(t => t.windowId === windowA);
    const tabsB = before.filter(t => t.windowId === windowB);
    log.push({
      step: '两个窗口',
      windowA,
      windowB,
      tabsA: tabsA.map(t => t.url),
      tabsB: tabsB.map(t => t.url),
    });
    check(tabsA.length >= 2, '窗口 A 至少要有两个标签', `实际 ${tabsA.length}`);
    check(tabsB.length >= 2, '窗口 B 至少要有两个标签', `实际 ${tabsB.length}`);

    // ── 3. 触发**真实的**图标点击处理（合成 tab，指向窗口 B）────────────
    const dispatch = await sw.evaluate(async windowId => {
      const evt = chrome.action.onClicked;
      if (!evt || typeof evt.dispatch !== 'function') {
        return { ok: false, reason: '这个 Chrome 的 action.onClicked 没有 dispatch()' };
      }
      await evt.dispatch({ id: -1, windowId, url: 'https://example.com/b-0' });
      return { ok: true };
    }, windowB);
    if (!check(dispatch.ok, '没能把点击投给真实的 onClicked 监听器', dispatch.reason ?? '')) {
      throw new Error('触发失败 ⇒ 这轮验证作废（不许降级成验别的东西）');
    }
    await sleep(2500);

    // ── 4. 读结果 ────────────────────────────────────────────────────────
    const after = await inventory(sw);
    const badge = await readBadge(sw);
    log.push({ step: '点击后', after, badge });

    const managerPrefix = `chrome-extension://${extId}/src/popup/index.html`;
    const afterA = after.filter(t => t.windowId === windowA);
    const afterB = after.filter(t => t.windowId === windowB);
    const managerInA = afterA.filter(t => t.url.startsWith(managerPrefix));
    const managerInB = afterB.filter(t => t.url.startsWith(managerPrefix));
    const newtabInA = afterA.filter(t => t.url.startsWith('chrome://newtab'));
    const newtabInB = afterB.filter(t => t.url.startsWith('chrome://newtab'));
    const survivingA = afterA.filter(t => t.url.includes('/a-') || t.url.includes('/a-1'));
    const survivingB = afterB.filter(t => t.url.includes('/b-'));

    // ① B 的标签被关了、A 的没被关
    check(
      survivingB.length === 0,
      '窗口 B 的标签应当被关掉（保存即关闭）',
      `还剩 ${JSON.stringify(survivingB.map(t => t.url))}`
    );
    check(
      survivingA.length >= 2,
      '窗口 A 的标签一个都不该被动（只操作点的那一个窗口）',
      `剩 ${JSON.stringify(survivingA.map(t => t.url))}`
    );

    // ② 占位新标签开在 B 里（不在 A 里）
    check(
      newtabInB.length >= 1,
      '窗口 B 里应当有一个占位新标签（否则 Chrome 会把空窗口整个关掉）',
      `B 里 ${newtabInB.length} 个，A 里 ${newtabInA.length} 个`
    );
    check(
      newtabInA.length === 0,
      '窗口 A 里不该凭空多出空白页（占位标签必须带 windowId）',
      `A 里 ${newtabInA.length} 个`
    );

    // ③ 管理器页开在 B 里
    check(
      managerInB.length >= 1,
      '会话管理器应当开在点的那一个窗口（B）里',
      `B 里 ${managerInB.length} 个，A 里 ${managerInA.length} 个`
    );
    check(
      managerInA.length === 0,
      '窗口 A 里不该被塞进一个管理器页（那是「点了像没点」的来源）',
      `A 里 ${managerInA.length} 个`
    );

    // ④ 确实存成了会话（徽标回执写着存了几个）
    check(
      /^\d+$/.test(badge.trim()) && Number(badge.trim()) > 0,
      '工具栏徽标应当显示「刚刚存了 N 个」⇒ 证明真的存成了',
      `徽标 = ${JSON.stringify(badge)}`
    );

    // ⑤ A 的标签一个没动
    const aIdsBefore = tabsA.map(t => t.id).sort((a, b) => a - b);
    const aIdsAfter = afterA.map(t => t.id).sort((a, b) => a - b);
    check(
      aIdsBefore.join(',') === aIdsAfter.join(','),
      '窗口 A 的标签 id 应当一个不少、一个不多',
      `前 ${aIdsBefore.join(',')} / 后 ${aIdsAfter.join(',')}`
    );
  } finally {
    await ctx.close().catch(() => {});
  }

  const result = {
    ok: problems.length === 0,
    problems,
    log,
  };
  writeFileSync(join(OUT_DIR, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (problems.length > 0) {
    console.error(`\n❌ 真机验证失败：${problems.length} 条问题`);
    process.exit(1);
  }
  console.log('\n✅ 真机验证通过：点图标只动「点的那一个窗口」，管理器也开在那儿');
}

main().catch(err => {
  console.error('真机验证脚本崩了：', err);
  process.exit(1);
});
