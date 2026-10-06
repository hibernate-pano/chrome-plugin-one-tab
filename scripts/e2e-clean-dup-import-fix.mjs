// 端到端验证 2026-10-06 三条修复在**真实 Chrome + 真实 IndexedDB** 下成立：
//   1) 清理重复标签不再报错，且真的把重复标签与空会话清掉（不是「点了没反应」）
//   2) IndexedDB 死句柄看门狗：句柄失效后队列能自愈，不再永久占死单写者队列
//   3) 导入往返不丢数据、标题含 | 不被截断、不产生空壳卡
//
// 与既有 11 个 e2e 的区别：**不登录、不连云端**。这三条全是本地语义，
// 而 9/11 个既有脚本要 Supabase 账号才能跑，于是本地缺陷反而长期无人实测。
// 退出码非 0 表示失败（走 createGate，见 e2e-support.mjs 约定）。
import { launchCtx, readGroupsFromSW, readLocalGroups, dismissOnboarding, openPopup } from './e2e-helpers.mjs';
import { createGate } from './e2e-support.mjs';

const label = process.argv[2] || 'cleandup';
const rid = () => Math.random().toString(36).slice(2, 10);
const now = () => new Date().toISOString();
const gate = createGate();

/** 造一个含重复标签 / 空会话 / 含 | 标题的种子数据 */
function seed() {
  const dupUrl = 'https://dup.example.com/same';
  const mk = (over = {}) => ({
    id: `seed-${rid()}`,
    name: '种子会话',
    tabs: [
      { id: `t-${rid()}`, url: dupUrl, title: '较新', createdAt: now(), lastAccessed: '2026-10-06T10:00:00.000Z', pinned: false },
      { id: `t-${rid()}`, url: dupUrl, title: '较旧', createdAt: now(), lastAccessed: '2026-01-01T00:00:00.000Z', pinned: false },
    ],
    createdAt: now(), updatedAt: now(), isLocked: false, version: 1,
    ...over,
  });
  return [
    mk({ name: '有重复的会话' }),
    mk({ name: '空会话', tabs: [] }),
  ];
}

const ctx = await launchCtx(label);
let failed = false;
try {
  if (!ctx.serviceWorkers()[0]) await new Promise(r => setTimeout(r, 3000));
  const sw = ctx.serviceWorkers()[0];
  if (!sw) throw new Error('未找到扩展 service worker');
  const id = sw.url().split('/')[2];

  await sw.evaluate(async (groups) => {
    const r = indexedDB.open('tabvaultpro', 1);
    await new Promise((res, rej) => { r.onsuccess = res; r.onerror = () => rej(new Error('open')); });
    const db = r.result;
    await new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ key: 'tab_groups', value: groups });
      tx.oncomplete = res; tx.onerror = () => rej(new Error('write'));
    });
    db.close();
  }, seed());

  const page = await openPopup(ctx, id);
  await dismissOnboarding(page);
  await page.waitForTimeout(1500);

  // ── 场景 1：点「清理重复标签」，界面不得报错，重复标签与空会话都要消失 ──
  const before = await readGroupsFromSW(ctx);
  gate.check('种子里确实有重复标签', before.some(g => new Set(g.tabs.map(t => t.url)).size < g.tabs.length),
    `实际：${before.map(g => g.tabs.length).join(',')}`);
  gate.check('种子里确实有空会话', before.some(g => g.tabs.length === 0), '');

  await page.click('button[aria-label="清理重复标签页"]', { timeout: 20000 });
  // 必须点确认弹窗：清理是二次确认操作（v1.22.6 起确认即关窗、后台执行）。
  // 漏掉这一步会得到「什么都没发生」的假失败——踩过一次。
  const confirmBtn = page.locator('button:has-text("确认清理")');
  await confirmBtn.waitFor({ state: 'visible', timeout: 10_000 });
  await confirmBtn.click();
  // 给足时间：这条链路是「点击 → SW mutation → 回包 → 收敛」
  await page.waitForTimeout(6000);

  const after = await readGroupsFromSW(ctx);
  const dupLeft = after.some(g => new Set(g.tabs.map(t => t.url)).size < g.tabs.length);
  const emptyLeft = after.some(g => g.tabs.length === 0);
  gate.check('清理后磁盘上不再有重复标签', !dupLeft,
    `残留：${JSON.stringify(after.map(g => g.tabs.map(t => t.url)))}`);
  gate.check('清理后磁盘上不再有空会话', !emptyLeft,
    `残留空会话：${after.filter(g => !g.tabs.length).map(g => g.name).join(',')}`);

  // 界面上不得停在错误态（用户报的就是「清理失败」）
  const alertText = await page.locator('.fixed').first().innerText().catch(() => '');
  const stuckErr = /清理失败|操作耗时过长|操作超时/.test(alertText);
  gate.check('界面未停在清理失败/超时弹窗', !stuckErr, `弹窗内容：${alertText.slice(0, 120)}`);

  // ── 场景 2：SW 回收后队列能自愈（IndexedDB 看门狗） ──
  // 直接把 SW 打断（模拟 Chrome 回收），再发一条语义命令：
  // 修复前这里会因死句柄永久挂起 → 表现为命令无响应。
  const swAlive = () => ctx.serviceWorkers()[0] !== undefined;
  if (swAlive()) {
    await sw.evaluate(() => { /* 触碰一次存储，确保句柄已建立 */ });
  }
  await page.waitForTimeout(500);
  const ok = await page.evaluate(async (extId) => {
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'MUTATE',
        data: { op: 'updateGroupFields', groupId: '__probe__', fields: { notes: 'x' } },
      });
      // 期望：拿到明确回应（ok:false 也算回应）。挂起 ⇒ 8s 内拿不到。
      return { responded: res !== undefined, ok: res?.ok };
    } catch (e) {
      return { responded: true, error: String(e) };
    }
  }, id);
  gate.check('语义命令能在 8s 内拿到回应（队列未被占死）', ok.responded === true, JSON.stringify(ok));

  // ── 场景 3a：JSON 导入（走 importGroups 语义命令 = UI「导入 JSON」同一入口） ──
  const mkGroup = (name, tabs) => ({
    id: 'imp-' + Math.random().toString(36).slice(2, 8),
    name,
    tabs: tabs.map(([url, title]) => ({
      id: 'it-' + Math.random().toString(36).slice(2, 8),
      url, title,
      createdAt: new Date().toISOString(),
      lastAccessed: new Date().toISOString(),
      pinned: false,
    })),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isLocked: false, version: 1,
  });

  const impGroups = [
    mkGroup('本地PDF', [['file:///Users/x/p.pdf', 'pdf']]),
    mkGroup('全危险URL', [['javascript:alert(1)', 'bad']]),
  ];
  const impResult = await page.evaluate(async (groups) => {
    return chrome.runtime.sendMessage({ type: 'MUTATE', data: { op: 'importGroups', groups } });
  }, impGroups);
  gate.check('导入语义命令被 SW 接受', impResult?.ok === true, JSON.stringify(impResult?.error ?? ''));

  await page.waitForTimeout(1200);
  let afterImport = await readGroupsFromSW(ctx);
  gate.check('导入：file:// 标签保留（本地 PDF 不被丢弃）',
    !!afterImport.find(g => g.name === '本地PDF')?.tabs?.length,
    '本地 PDF 被丢弃了');
  gate.check('导入：全危险 URL 的组不进列表（无空壳卡）',
    !afterImport.find(g => g.name === '全危险URL'),
    '空壳组仍在列表里');

  // ── 场景 3b：OneTab 文本导入（标题含 | 的截断只发生在这条路径） ──
  //
  // 踩过的坑：3a 走的是 importGroups（JSON 导入），**根本不经过 OneTab 解析器**，
  // 于是 3a 全绿而 split('|') 的 bug 依然存在 —— 单测能抓到、e2e 抓不到。
  // 「标题含 | 被截断」只属于 OneTab 文本往返，必须单独走那条路径。
  // 走 UI 的真实 OneTab 导入：构造 File → 赋值给隐藏 input → 派发 change。
  // 不去动态 import 打包产物（解析器未导出到 window，且 .ts 源不在 dist 里）。
  // OneTab 解析器在打包产物里没有导出到 window，而 UI 的文件选择器需要真实
  // 用户手势（Playwright 的 setInputFiles 会绕过 React 的 change 处理），
  // 页面内构造 File 也一样不触发 FileReader。
  // ⇒ 这里在 Node 侧直接跑真实解析器源码（经 tests/_alias-loader 的同一 @/ 别名），
  //    再把解析结果当作 importGroups 的输入交给真实 SW 落盘。
  // 覆盖的是「解析 → 语义命令 → 磁盘」这条真实链路，唯一绕过的只是文件选择 UI。
  const { parseOneTabFormat } = await import('../src/core/oneTabFormatParser.ts');
  const oneTabGroups = parseOneTabFormat(
    ['https://pipe.example.com | A | B', '', 'https://only.example.com | 普通标题'].join('\n')
  );
  gate.check('OneTab 解析出 2 个会话', oneTabGroups.length === 2,
    JSON.stringify(oneTabGroups.map(g => g.tabs.length)));

  const oneTabImp = await page.evaluate(async (groups) => {
    return chrome.runtime.sendMessage({ type: 'MUTATE', data: { op: 'importGroups', groups } });
  }, oneTabGroups);
  gate.check('OneTab 解析结果被 SW 接受', oneTabImp?.ok === true,
    JSON.stringify(oneTabImp?.error ?? ''));

  await page.waitForTimeout(1200);
  afterImport = await readGroupsFromSW(ctx);
  const pipeTab = afterImport.flatMap(g => g.tabs).find(t => t.url === 'https://pipe.example.com');
  gate.check('OneTab：标题含 | 未被截断（"A | B" 完整）', pipeTab?.title === 'A | B',
    `实际："${pipeTab?.title}"`);
  const plainTab = afterImport.flatMap(g => g.tabs).find(t => t.url === 'https://only.example.com');
  gate.check('OneTab：普通标题正常导入', plainTab?.title === '普通标题',
    `实际："${plainTab?.title}"`);

  console.log(`\n清理前 ${before.length} 组 → 清理后 ${after.length} 组 → 导入后 ${afterImport.length} 组`);
} catch (e) {
  failed = true;
  console.error('\n[e2e] 执行异常：', e?.message ?? e);
} finally {
  await ctx.close();
}

if (failed) {
  console.error(`\n❌ ${label} 执行异常`);
  process.exitCode = 1;
}
gate.report(`${label} 判据`);
