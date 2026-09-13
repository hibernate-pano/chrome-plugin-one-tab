// 真实场景验证：本地「删除会话 / 点开标签（移除）」的意图不会被后台同步反向覆盖。
//
// 为什么重写（原版有 3 个致命弱点，详见测试报告 §4.3）：
//   ① 断言用 `tabs.length` 认组而不是 g.id，且 `find(g => g.tabs.length === 2 && !session2)`
//      的 `!session2` 恒为 false → 「会话被复活」这条检查是**死代码**，永远判通过；
//   ② IDB 读失败被吞成 [] → 数据全丢也会走"未被复活"分支 → 假绿；
//   ③ 没有正控：不验证"删除/点开动作其实生效了"，于是"动作没发生"与"没被复活"不可区分。
//
// 本版：按 g.id + 原始标题快照定位 → 正控（本地墓碑确实写入）→ 负控（90s 后台同步后仍是墓碑），
// 且数据缺失/读取失败一律判失败（不允许静默通过）。
//
// 流程：
// 1. A 注册 → 保存 2 个会话（会话1=NR-1/NR-2，会话2=NR-3/NR-4）→ 上传
// 2. B 登录 → 下载（正控：本地确实拿到 2 个活跃会话）
// 3. B 删除「会话 1」（正控：本地该组 isDeleted=true）
// 4. B 点开「会话 2」的第 1 个标签（正控：该 tab 本地变为墓碑）
// 5. B 关闭 popup → 等 90s（30s 上传 alarm + 60s 同步 alarm）
// 6. B 重开 → 负控：会话 1 仍不活跃、被点开的 tab 仍是墓碑

import { randomUUID } from 'node:crypto';
import {
  launchCtx, extId, dismissOnboarding, readLocalGroups,
  manualUpload, manualDownload, downloadUntil, login, startContentSite,
} from './e2e-helpers.mjs';

const EMAIL = `e2e-nr-${randomUUID().slice(0, 6)}@test.tapstack.dev`;
const PWD = 'SyncTest#2026!';

let ok = true;
const fail = m => { console.log(m); ok = false; };
const activeTabs = g => (g ? g.tabs.filter(t => !t.isDeleted) : []);

const ctxA = await launchCtx('A');
const ctxB = await launchCtx('B');
const site = await startContentSite('NR-标签');
try {
  // ── A：注册 + 保存 2 个会话 + 上传 ─────────────────────────────
  await ctxA.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => {});
  const id = await extId(ctxA);
  const pageA = await ctxA.newPage();
  await pageA.goto(`chrome-extension://${id}/src/popup/index.html`);
  await login(pageA, EMAIL, PWD, { register: true });
  console.log('✅ A 注册并登录');

  const mkTabs = async n => {
    const pages = [];
    for (let i = 0; i < n; i++) {
      const pg = await ctxA.newPage();
      await pg.goto(`${site.base}/t${Date.now()}-${i}`);
      await pg.waitForSelector('h1');
      pages.push(pg);
    }
    return pages;
  };
  let tabs = await mkTabs(2);
  await pageA.locator('[aria-label="保存当前窗口中的所有标签页为会话"]').first().click();
  await pageA.waitForTimeout(2500);
  for (const p of tabs) await p.close();
  tabs = await mkTabs(2);
  await pageA.locator('[aria-label="保存当前窗口中的所有标签页为会话"]').first().click();
  await pageA.waitForTimeout(2500);
  for (const p of tabs) await p.close();
  await manualUpload(pageA);
  console.log('✅ A 保存并上传 2 个会话');

  // ── B：登录 + 下载（正控：真的拿到数据）───────────────────────
  await ctxB.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => {});
  const pageB = await ctxB.newPage();
  await pageB.goto(`chrome-extension://${id}/src/popup/index.html`);
  await login(pageB, EMAIL, PWD);
  const { groups: bInit, downloaded } = await downloadUntil(
    pageB,
    gs => gs.filter(g => !g.isDeleted && g.tabs.filter(t => !t.isDeleted).length === 2).length >= 2,
    'B 本地出现 2 个双标签活跃会话'
  );
  const active = bInit
    .filter(g => !g.isDeleted && activeTabs(g).length === 2)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()); // 会话1 先创建
  if (active.length < 2) {
    fail(`❌ 前置失败：B 下载后应有 2 个活跃会话，实际 ${active.length}（下载执行=${downloaded}）`);
    throw new Error('setup failed');
  }
  const [session1, session2] = active;
  if (session1.id === session2.id) { fail('❌ 前置失败：两个会话 id 相同'); throw new Error('setup failed'); }
  // 锚点从本地数据动态取（不写死标题，避免造数据方式一变就失效）
  const anchor1 = activeTabs(session1)[0].title;
  const anchor2 = activeTabs(session2)[0].title;
  const victimTab = activeTabs(session2).find(t => t.title === anchor2);
  console.log(`   锚点: 会话1「${anchor1}」/ 会话2「${anchor2}」`);
  console.log(`✅ 正控① 通过：B 本地 2 个活跃会话（会话1=${session1.id.slice(0, 8)} 会话2=${session2.id.slice(0, 8)}，目标标签=${victimTab.title}）`);

  // ── B 删除「会话 1」（按标题锚定位卡片，不靠 .first()）──────────
  const card1 = pageB.locator('.tab-group-card').filter({ hasText: anchor1 }).first();
  if (!(await card1.count())) { fail('❌ 找不到会话 1 的卡片'); throw new Error('card1 not found'); }
  await card1.locator('button[aria-label="删除会话"]').first().click({ timeout: 15_000 });
  await pageB.waitForTimeout(800);
  const confirm = pageB.locator('.fixed button:has-text("确认"), .fixed button:has-text("删除")').last();
  if (await confirm.count()) await confirm.click({ timeout: 8000 }).catch(() => {});
  await pageB.waitForTimeout(2500);

  // 正控②：会话 1 在本地确实成为墓碑
  const afterDelete = await readLocalGroups(pageB);
  const g1After = afterDelete.find(g => g.id === session1.id);
  if (!g1After) fail('❌ 正控② 失败：会话 1 从本地彻底消失（应为「墓碑保留」）');
  else if (g1After.isDeleted !== true) fail(`❌ 正控② 失败：会话 1 删除未生效（isDeleted=${g1After.isDeleted}）`);
  else console.log('✅ 正控② 通过：会话 1 已在本地成为墓碑');

  // ── B 点开「会话 2」的第 1 个标签（应把它从会话移除）───────────
  const card2 = pageB.locator('.tab-group-card').filter({ hasText: anchor2 }).first();
  if (!(await card2.count())) { fail('❌ 找不到会话 2 的卡片'); throw new Error('card2 not found'); }
  await card2.locator(`a[aria-label^="打开标签页: ${victimTab.title}"]`).first().click({ timeout: 15_000 });

  // 正控③：该 tab 在本地确实变成墓碑（轮询，不用固定 sleep）
  let g2AfterOpen = null;
  for (let i = 0; i < 6; i++) {
    const gs = await readLocalGroups(pageB);
    g2AfterOpen = gs.find(g => g.id === session2.id);
    if (g2AfterOpen?.tabs.find(t => t.id === victimTab.id)?.isDeleted === true) break;
    await pageB.waitForTimeout(1200);
  }
  const victimAfterOpen = g2AfterOpen?.tabs.find(t => t.id === victimTab.id);
  if (victimAfterOpen?.isDeleted !== true) {
    fail(`❌ 正控③ 失败：点开标签后本地未墓碑化（isDeleted=${victimAfterOpen?.isDeleted}）→ 后续"未复活"无意义`);
  } else {
    console.log(`✅ 正控③ 通过：被点开的标签已在本地墓碑化（印记 ${JSON.stringify(victimAfterOpen.lastOp)}）`);
  }

  // ── 关闭 B popup，等 90s（30s 上传 alarm + 60s 同步 alarm）──────
  await pageB.close();
  console.log('⏳ B popup 已关闭，等 90s 让后台 alarm 跑完（先上传本地意图，再下载合并）');
  await pageA.waitForTimeout(90_000);

  // ── B 重开 → 负控：两项意图都不应被云端覆盖 ────────────────────
  const pageB2 = await ctxB.newPage();
  await pageB2.goto(`chrome-extension://${id}/src/popup/index.html`);
  await pageB2.waitForTimeout(6000); // 等挂载自动下载合并完成
  const finalGroups = await readLocalGroups(pageB2);
  if (!finalGroups.length) {
    fail('❌ 负控失败：重开后本地 groups 为空（读取失败或数据丢失，不能算通过）');
    throw new Error('empty local groups');
  }
  const f1 = finalGroups.find(g => g.id === session1.id);
  const f2 = finalGroups.find(g => g.id === session2.id);
  const f1Active = Boolean(f1 && !f1.isDeleted);
  const victimFinal = f2?.tabs.find(t => t.id === victimTab.id);
  console.log(`📊 90s 后: 会话1 活跃=${f1Active}(isDeleted=${f1?.isDeleted}) 会话2 活跃tab=${activeTabs(f2).length} 目标标签墓碑=${victimFinal?.isDeleted}`);

  if (f1Active) fail('❌ 负控① 失败：已删除的会话 1 被云端复活到活跃状态');
  else console.log('✅ 负控① 通过：会话 1 未被复活');
  if (!victimFinal) fail('❌ 负控② 失败：被点开的标签从本地消失（无法判定，视为失败）');
  else if (victimFinal.isDeleted !== true) fail('❌ 负控② 失败：被点开的标签被云端复活');
  else console.log('✅ 负控② 通过：被点开的标签未被复活');

  console.log('\n' + '═'.repeat(62));
  console.log(`测试账号: ${EMAIL}`);
  console.log(`本地删除/点开 不被后台同步覆盖: ${ok ? '✅ 通过（含 3 项正控）' : '❌ 失败'}`);
  console.log('═'.repeat(62));
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  console.error('\n💥 执行异常:', e.message);
  process.exitCode = 1;
} finally {
  try { site.server.close(); } catch {}
  try { await ctxA.close(); } catch {}
  try { await ctxB.close(); } catch {}
}
