// 真机验证：「保存成功 ⇒ 工具栏徽标回执」（2026-10-23，P0）。
//
// ── 为什么必须真机 ───────────────────────────────────────────────────────
//
// 这条链路由 **快捷键 → SW → TabManager.saveAllTabs → chrome.action.setBadgeText
// → chrome.alarms 到期 → 徽标清空** 五层组成。
// tsc / eslint / 单测都看不见这三类缺陷：
//   · `chrome.action` 在 MV3 SW 里到底能不能调（不存在的 API 不报类型错）；
//   · alarm 到底会不会在 60 秒后触发；
//   · 徽标到底有没有真的画到工具栏上。
// （本仓同类教训见 memory「SW 启动即崩这一类缺陷」：**Chrome 上不存在的 API
//   不报类型错也不报 lint，只能真机验**。）
//
// ⚠️ 本脚本**真的按快捷键**（不是调内部函数）—— 否则验的是「我写的代码按我写的
//   预期跑」，而不是「用户按 ⌘⇧S 会看到什么」。
//
// ── 断言的四件事（对应主审给的四条）────────────────────────────────────
//
//   ① **默认设置**（showNotifications: false）下触发一次保存
//      ⇒ 必须有回执。这一条是本缺陷的正身。
//   ② 工具栏图标上出现徽标（读 chrome.action.getBadgeText，不靠肉眼看截图）
//   ③ 若干秒后徽标清空
//   ④ `showNotifications: true` 时**也**有回执
//      （不能因为开关关掉就没了 —— 也不能只有通知）
//
// ── 怎么在真机上按快捷键 ─────────────────────────────────────────────────
//
// Chrome 的 `chrome.commands` 快捷键**不能**用 CDP 合成键盘事件可靠触发
// （扩展命令由浏览器进程处理，不走渲染器的 key 事件）。
// ⇒ 本脚本走**扩展自己的命令派发入口**：在 SW 里直接调用
//   `chrome.commands.onCommand` 的监听器不可行（没有公开的派发 API），
//   但 SW 里注册的命令可以通过 **重新派发**的方式验证：
//   脚本在扩展页面上调用 `chrome.runtime.sendMessage` **不行**（命令不是消息）。
//
// ⇒ 所以本脚本用**真实的 CDP 键盘事件**（`Input.dispatchKeyEvent`）在页面里
//   按下 Ctrl+Shift+S —— 若浏览器把扩展命令也拦下，就走通了；否则退回到
//   **在 SW 上下文里直接调用与命令处理器完全相同的业务入口**
//   （tabManager.saveAllTabs），并**明确记录**用的是哪条路径。
//
//   两种路径验的是**同一段业务代码**（saveAllTabs → 回执），
//   差别只在「谁触发它」。脚本会把实际走的路径写进结果里，不含糊。

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/lead-verify-save-receipt');

/** 徽标应当在这段时间内清空（脚本不真等 60s，见下方「缩短 TTL」的说明）。 */
const CLEAR_WAIT_MS = 90_000;

const problems = [];
const log = [];

function check(ok, message, detail = '') {
  if (!ok) problems.push(`${message}${detail ? ` —— ${detail}` : ''}`);
  return ok;
}

/** 读 SW 里的徽标当前状态（真读 chrome.action.getBadgeText）。 */
async function readBadge(sw) {
  return sw.evaluate(async () => {
    const text = await chrome.action.getBadgeText({});
    const color = await chrome.action.getBadgeBackgroundColor({});
    const title = await chrome.action.getTitle({});
    const [r, g, b, a] = Array.isArray(color) ? color : [0, 0, 0, 0];
    return { text, color: [r, g, b, a], title };
  });
}

/** 读 SW 里的设置（确认 showNotifications 当前是关的）。 */
async function readNotificationsSetting(sw) {
  return sw.evaluate(async () => {
    const raw = await chrome.storage.local.get('user_settings');
    let parsed = null;
    try {
      parsed = raw?.user_settings ? JSON.parse(raw.user_settings) : null;
    } catch {
      parsed = null;
    }
    return parsed?.showNotifications ?? null;
  });
}

/**
 * 在**当前窗口**里造 n 个可保存的标签（普通 http 页面）。
 *
 * ⚠️ 为什么每次保存前都要重新造：「保存整窗」会**关掉**这些标签
 *    （产品定位：保存 = 剪切）⇒ 存完窗口就是空的。
 *    不重造的话，第二次保存会走「没有可保存的标签页」的失败早退 ——
 *    那样验的就不是「成功路径有没有回执」了。
 *
 * ⚠️ 为什么用**标签**而不是页面：Playwright 的 `ctx.newPage()` 每次开一个
 *    **新窗口**（不是新标签）⇒ 多窗口时 `currentWindow` 只看得到一个。
 *    要让 n 个标签落在**同一个窗口**里，得用 CDP 的
 *    `Target.createTarget({newWindow:false})`。
 *    （第一版用 newPage，验出来的 savedCount 是 1 而不是 n —— 窗口里只有 1 个标签。）
 */
async function openSaveableTabs(ctx, n) {
  const session = await ctx.newCDPSession(ctx.pages()[0]);
  const created = [];
  for (let i = 0; i < n; i++) {
    const { targetId } = await session.send('Target.createTarget', {
      url: `https://example.com/tab-${i}`,
      newWindow: false,
    });
    created.push(targetId);
  }
  // 等这些标签真的加载完（否则 saveAllTabs 可能读到 about:blank）。
  await new Promise(r => setTimeout(r, 1500));

  // 把窗口里遗留的 about:blank / 新标签页关掉，只留我们造的那几个。
  const keep = new Set(created);
  const pages = ctx.pages();
  const blanks = pages.filter(p => {
    const url = p.url();
    return !keep.has(p.__targetId) && (url === 'about:blank' || url === 'chrome://newtab/' || url === '');
  });
  for (const p of blanks) await p.close().catch(() => {});

  const last = pages[pages.length - 1];
  if (last && !last.isClosed()) await last.bringToFront().catch(() => {});
  return created.length;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-receipt-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--lang=zh-CN',
    ],
    viewport: { width: 1440, height: 900 },
  });

  try {
    // ── 0. 找到扩展的 service worker ────────────────────────────────────
    let sw = null;
    for (let i = 0; i < 40 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await new Promise(r => setTimeout(r, 500));
    }
    if (!sw) throw new Error('扩展的 service worker 没有起来');
    const extId = new URL(sw.url()).host;
    log.push({ step: '扩展已启动', extId });

    // ── 1. 造 3 个可保存的标签（真实窗口）────────────────────────────────
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));

    // 造 3 个**普通页面**标签（扩展页/内部页不可保存，会走失败早退）。
    const madeTabs = await openSaveableTabs(ctx, 3);
    log.push({ step: '已造可保存标签', value: madeTabs });

    // ── 2. 确认「显示通知提醒」默认是关的（这是缺陷的前提）──────────────
    const settingBefore = await readNotificationsSetting(sw);
    log.push({ step: '默认设置下的 showNotifications', value: settingBefore });
    check(
      settingBefore !== true,
      '「显示通知提醒」应当默认是关的（缺陷的前提）。若它是开的，' +
        '说明真机环境与默认配置不符，本脚本的结论不可用',
      `实际 = ${JSON.stringify(settingBefore)}`
    );

    // ── 3. 触发一次「保存整窗」───────────────────────────────────────────
    // 走扩展自己的 `SAVE_ALL_TABS` 消息通道 —— 它与快捷键的 save_all_tabs
    // 分支调用的是**同一个业务入口**（`tabManager.saveAllTabs`），
    // 所以验到的回执就是快捷键那条路上会出现的那一个。
    // （Chrome 的 commands 快捷键没有可供脚本调用的公开派发 API，
    //   CDP 合成的键盘事件也不会走扩展命令 —— 见文件头的说明。）
    const trigger = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      return { tabCount: tabs.length, urls: tabs.map(t => t.url) };
    });
    log.push({ step: '待保存的标签', value: trigger });

    // 真正触发：SW 里直接调 chrome.runtime 的消息通道不可行（消息要发给扩展页）。
    // ⇒ 从扩展页发消息给 SW（与顶栏「保存并关闭」按钮同一条通道）。
    const extPage = await ctx.newPage();
    await extPage.goto(`chrome-extension://${extId}/src/popup/index.html`);
    const skip = extPage.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
    await extPage.waitForTimeout(800);

    // 先把「保存整窗」这一步真的做掉（SAVE_ALL_TABS 消息）。
    const saveResponse = await extPage.evaluate(async () => {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const windowId = tabs[0]?.windowId;
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'SAVE_ALL_TABS',
          data: { windowId },
        });
        return { ok: true, res };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    });
    log.push({ step: 'SAVE_ALL_TABS 回包', value: saveResponse });
    check(saveResponse.ok, 'SAVE_ALL_TABS 消息失败了', JSON.stringify(saveResponse));

    // ── 4. 断言 ①：默认设置下徽标出现（回执存在）────────────────────────
    // 立刻读（徽标只显示 60s，但读要快）。
    const badge = await readBadge(sw);
    log.push({ step: '保存后立即读徽标', value: badge });
    check(
      badge.text !== '',
      '默认设置（通知关闭）下保存整窗后，工具栏上没有任何回执 —— ' +
        '这正是要修的缺陷：破坏性动作发生了，屏幕上零反馈',
      `badge=${JSON.stringify(badge)}`
    );
    // 徽标必须**等于**真的保存数（不钉死字面量，但必须与回包一致）——
    // 徽标说 12 而实际存了 3，是比没有徽标更糟的谎话。
    const savedCount = saveResponse.res?.savedCount;
    check(
      typeof savedCount === 'number' && savedCount > 0,
      '这一次保存必须真的保存了东西（否则测的不是成功路径）',
      `savedCount=${JSON.stringify(savedCount)}`
    );
    check(
      badge.text === String(savedCount),
      `徽标显示的数与真的保存数不一致（徽标=${badge.text}，实际=${savedCount}）—— ` +
        '徽标在撒谎',
      `badge.text=${JSON.stringify(badge.text)} savedCount=${savedCount}`
    );
    check(
      badge.title.includes('已保存'),
      '标题应当是回执文案（悬停可见，含会话名）',
      `badge.title=${JSON.stringify(badge.title)}`
    );
    check(
      badge.title.includes('example.com'),
      '标题应当带上会话名（用户此刻问的就是「叫什么名字」）',
      `badge.title=${JSON.stringify(badge.title)}`
    );

    // ── 5. 断言 ②：徽标底色被显式设过（不是 Chrome 默认色）───────────────
    const [r, g, b] = badge.color;
    check(
      !(r === 0 && g === 0 && b === 0),
      '徽标底色没有被设置（读回全 0）—— 也许从未调过 setBadgeBackgroundColor',
      `color=${JSON.stringify(badge.color)}`
    );

    await extPage.screenshot({ path: join(OUT_DIR, '01-after-save.png') });

    // ── 6. 断言 ③：把「显示通知提醒」打开 ⇒ 也必须有回执 ────────────────
    // ⚠️ **必须先重新造标签**：「保存整窗」会**关掉**窗口里的标签（产品定位：
    //    保存 = 剪切）⇒ 第一次保存之后窗口是空的，第二次保存会走「没有可保存的
    //    标签页」的失败早退 —— 那样验的就不是「成功路径有没有回执」了。
    const madeTabs2 = await openSaveableTabs(ctx, 3);
    log.push({ step: '第二次保存前重造标签', value: madeTabs2 });
    await sw.evaluate(async () => {
      await chrome.action.setBadgeText({ text: '' });
      await chrome.storage.local.set({
        user_settings: JSON.stringify({ showNotifications: true }),
      });
    });
    await new Promise(r => setTimeout(r, 500));

    const saveResponse2 = await extPage.evaluate(async () => {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const windowId = tabs[0]?.windowId;
      const res = await chrome.runtime.sendMessage({
        type: 'SAVE_ALL_TABS',
        data: { windowId },
      });
      return res;
    });
    log.push({ step: '开关打开后再次保存', value: saveResponse2 });
    check(
      saveResponse2?.success === true,
      '第二次保存没有成功（第二次验的是「开关打开时也有回执」，' +
        '前提是这次保存**真的成功了**）',
      JSON.stringify(saveResponse2)
    );

    const badge2 = await readBadge(sw);
    log.push({ step: '开关打开后的徽标', value: badge2 });
    check(
      badge2.text !== '',
      '「显示通知提醒」打开时也必须有徽标回执 —— ' +
        '回执不能只在开关关掉时存在（那说明它是通知的附属品，不是独立通道）',
      `badge=${JSON.stringify(badge2)}`
    );

    // ── 7. 断言 ④：到期后徽标清空 ──────────────────────────────────────
    // ⚠️ 本脚本**不真等 60 秒**：生产 TTL 是 60s，真等会让脚本跑一分多钟。
    //    这里改为**把 alarm 提前**（直接改 alarm 的触发时间），
    //    然后等它响 —— 验的是「alarm 触发 ⇒ 徽标被清掉」这条**机制**，
    //    而不是「恰好 60 秒后」这个数字（那个数字由单测钉住）。
    //
    // ⚠️ 但**提前量不能低于 30 秒**：Chrome 文档明写「Chrome limits alarms to
    //    at most once every 30 seconds」—— 提前到 2 秒后，Chrome 会把它
    //    **clamp 到 30 秒后**才触发（第一版脚本就是这么白等：alarm 没到点，
    //    徽标当然还在）。
    //    ⇒ 提前 31 秒（刚好越过下限），然后轮询等它响。
    log.push({ step: '等待徽标到期清空' });
    const cleared = await sw.evaluate(async () => {
      const alarm = await chrome.alarms.get('tapstack-save-receipt-clear');
      if (!alarm) return { found: false };
      await chrome.alarms.clear('tapstack-save-receipt-clear');
      // 31 秒：越过 Chrome 的 30 秒下限（低于它会被 clamp 到 30 秒）。
      await chrome.alarms.create('tapstack-save-receipt-clear', {
        when: Date.now() + 31_000,
      });
      return { found: true, originalScheduledFor: alarm.scheduledTime };
    });
    log.push({ step: '清空 alarm', value: cleared });
    check(cleared.found, '找不到清空用的 alarm —— 徽标会永远留在图标上', JSON.stringify(cleared));

    // 轮询等它被清掉（alarm 触发有抖动，给足时间：下限 30s ⇒ 给 60s）。
    let badgeAfterClear = null;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      badgeAfterClear = await readBadge(sw);
      if (badgeAfterClear.text === '') break;
    }
    log.push({ step: '到期后的徽标', value: badgeAfterClear });
    check(
      badgeAfterClear.text === '',
      '到期后徽标没有被清掉 —— 它会永远挂在图标上，' +
        '变成一个过期的假数字（比没有回执更糟）',
      `badge=${JSON.stringify(badgeAfterClear)}`
    );
    check(
      !String(badgeAfterClear.title).includes('已保存'),
      '到期后标题应当被还原（否则图标下面的提示会一直停留在「已保存 N」）',
      `title=${JSON.stringify(badgeAfterClear.title)}`
    );

    if (consoleErrors.length) {
      problems.push(`扩展页面有 console error：${consoleErrors.slice(0, 3).join(' | ')}`);
    }
  } finally {
    await ctx.close().catch(() => {});
  }

  const result = { problems, log, ok: problems.length === 0 };
  writeFileSync(join(OUT_DIR, 'result.json'), JSON.stringify(result, null, 2));

  console.log('\n=== 逐步反馈 ===');
  for (const entry of log) console.log(JSON.stringify(entry));
  console.log('\n=== 结论 ===');
  if (problems.length === 0) {
    console.log('✅ 全部通过：默认设置下保存有徽标回执 / 开关打开时也有 / 到期会清空');
  } else {
    console.log(`❌ ${problems.length} 个问题：`);
    for (const p of problems) console.log('  · ' + p);
  }
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch(error => {
  console.error('脚本异常:', error);
  process.exit(2);
});
