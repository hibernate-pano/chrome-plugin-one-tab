// 高压力验证：多次快速本地移除 + 云端持续写入，后台轮询「先上传再下载」后本地意图不被覆盖。
//
// 为什么重写（原版只有一个负向断言，功能全坏也会绿，见测试报告 §4.3）：
//   原断言是 `live.length === 1 && live[0].tabs.length === 1` —— 若 upload/download 全变成
//   空操作，B 本地本来就停在「1 会话 1 tab」→ 照样通过。「没被复活」与「根本没同步」不可区分。
//
// 本版三层保护：
//   正控① 每个被移除的 tab 在本地确实变成墓碑（按 tab id，逐个轮询）
//   正控② 后台同步确实跑过：在 **SW 上下文**读存储（不挂载 popup，避免被
//          AuthProvider 的挂载自动下载冒充），看到 A 后上传的新会话 + last_sync_time 前进
//   正控③ 本地变更确实上传过：pending_upload 已清
//   负控   90s 后所有被移除的 tab 仍是墓碑，且无常 URL 活跃副本
//
// 流程：A 保存 4-tab 会话并上传 → B 登录下载（正控）→ B 点开 3 个标签逐个移除（正控×3）
//      → A 再上传一个新会话（制造云端新数据）→ B 关 popup 等 90s → 在 SW 上下文验收

import { randomUUID } from 'node:crypto';
import {
  launchCtx, extId, readLocalGroups, readGroupsFromSW, readKvFromSW, kvValue,
  manualUpload, downloadUntil, login, startContentSite, swEval,
} from './e2e-helpers.mjs';

const EMAIL = `e2e-st-${randomUUID().slice(0, 6)}@test.tapstack.dev`;
const PWD = 'SyncTest#2026!';

let ok = true;
const fail = m => { console.log(m); ok = false; };
const activeTabs = g => (g ? g.tabs.filter(t => !t.isDeleted) : []);

const ctxA = await launchCtx('A');
const ctxB = await launchCtx('B');
const site = await startContentSite('ST-标签');
try {
  // ── A：注册 + 保存 4-tab 会话 + 上传 ─────────────────────────────
  await ctxA.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => {});
  const id = await extId(ctxA);
  const pageA = await ctxA.newPage();
  await pageA.goto(`chrome-extension://${id}/src/popup/index.html`);
  await login(pageA, EMAIL, PWD, { register: true });

  const openTabs = async n => {
    const ps = [];
    for (let i = 0; i < n; i++) {
      const p = await ctxA.newPage();
      await p.goto(`${site.base}/s${Date.now()}-${i}`);
      await p.waitForSelector('h1');
      ps.push(p);
    }
    return ps;
  };
  let tabs = await openTabs(4);
  await pageA.locator('[aria-label="保存当前窗口中的所有标签页为会话"]').first().click();
  await pageA.waitForTimeout(2500);
  for (const p of tabs) await p.close();
  await manualUpload(pageA);
  console.log('✅ A: 4-tab 会话已上云');

  // ── B：登录 + 下载（正控：拿到 4 个活跃标签）────────────────────
  await ctxB.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => {});
  const pageB = await ctxB.newPage();
  await pageB.goto(`chrome-extension://${id}/src/popup/index.html`);
  await login(pageB, EMAIL, PWD);
  const { groups: bInit } = await downloadUntil(
    pageB,
    gs => gs.some(g => !g.isDeleted && activeTabs(g).length === 4),
    'B 本地出现 4 活跃标签的会话'
  );
  const grp0 = bInit.find(g => !g.isDeleted && activeTabs(g).length === 4);
  if (!grp0) { fail('❌ 前置失败：B 未拿到 A 的 4-tab 会话'); throw new Error('setup failed'); }
  const groupId = grp0.id;
  const victims = activeTabs(grp0).slice(0, 3); // 连续移除 3 个
  console.log(`✅ 正控① 通过: B 本地 "${grp0.name}" 4 个活跃标签；目标移除 ${victims.map(t => t.title).join(', ')}`);

  // ── B：逐个点开移除 3 个标签（每次都要看到本地墓碑才算数）────────
  for (const v of victims) {
    const card = pageB.locator('.tab-group-card').filter({ hasText: grp0.name }).first();
    const btn = card.locator(`a[aria-label^="打开标签页: ${v.title}"]`).first();
    if (!(await btn.count())) { fail(`❌ 找不到标签打开按钮: ${v.title}`); continue; }
    await btn.click({ timeout: 15_000 });
    let tombstoned = false;
    for (let i = 0; i < 6; i++) {
      const gs = await readLocalGroups(pageB);
      const g = gs.find(x => x.id === groupId);
      if (g?.tabs.find(t => t.id === v.id)?.isDeleted === true) { tombstoned = true; break; }
      await pageB.waitForTimeout(1000);
    }
    if (!tombstoned) fail(`❌ 正控① 失败: 点开「${v.title}」后本地未墓碑化（后续断言无意义）`);
    else console.log(`   ✓ 正控①: 「${v.title}」已墓碑化（活跃 ${activeTabs((await readLocalGroups(pageB)).find(x => x.id === groupId)).length} tabs）`);
    // 点开会真实打开浏览器标签页，清掉以免干扰
    for (const pg of ctxB.pages()) {
      if (pg !== pageB && !pg.url().startsWith('chrome-extension://')) await pg.close().catch(() => {});
    }
  }

  // ── A 再上传一个新会话（制造云端新数据）─────────────────────────
  tabs = await openTabs(2);
  await pageA.locator('[aria-label="保存当前窗口中的所有标签页为会话"]').first().click();
  await pageA.waitForTimeout(2500);
  for (const p of tabs) await p.close();
  await manualUpload(pageA);
  const aGroups = await readLocalGroups(pageA);
  const newGroup = aGroups.find(g => !g.isDeleted && g.tabs.length === 2);
  console.log(`✅ A 追加新会话 "${newGroup?.name}" 并上传（用于验证后台同步确实发生过）`);

  // ── B 关 popup，等 90s（30s 上传 alarm + 60s 同步 alarm）─────────
  const syncBefore = kvValue(await readKvFromSW(ctxB), 'last_sync_time');
  await pageB.close();
  console.log('⏳ B popup 已关闭，等 90s…');
  await pageA.waitForTimeout(90_000);

  // ── 正控②③：在 SW 上下文验收（不挂载 popup）────────────────────
  const kvAfter = await readKvFromSW(ctxB);
  const syncAfter = kvValue(kvAfter, 'last_sync_time');
  const pendingAfter = kvValue(kvAfter, 'pending_upload');
  const finalGroups = await readGroupsFromSW(ctxB);
  if (!finalGroups.length) { fail('❌ 负控失败：SW 侧本地 groups 为空（数据丢失或读取失败）'); throw new Error('empty'); }

  const didSync = Boolean(syncAfter) && syncAfter !== syncBefore;
  const sawNewSession = finalGroups.some(g => g.id === newGroup?.id && !g.isDeleted);
  console.log(`📊 SW 侧: last_sync_time ${syncBefore || '-'} → ${syncAfter || '-'}（前进=${didSync}）| 看到 A 的新会话=${sawNewSession} | pending_upload=${pendingAfter}`);
  if (!didSync) fail('❌ 正控② 失败：90s 内后台没有执行过同步（last_sync_time 未前进）→ 断言无意义');
  else if (!sawNewSession) fail('❌ 正控② 失败：后台同步跑了但没拿到 A 的新会话（云端→本地未生效）');
  else console.log('✅ 正控② 通过：后台同步确实执行并拉到了云端新数据');
  if (pendingAfter === true) fail('❌ 正控③ 失败：本地变更仍未上传（pending_upload 始终为 true）');
  else console.log('✅ 正控③ 通过：本地变更已上传（pending_upload 已清）');

  // ── 负控：3 个被移除的标签全部仍是墓碑、无常 URL 活跃副本 ──────
  const gFinal = finalGroups.find(g => g.id === groupId);
  const stillTombstoned = victims.filter(v => gFinal?.tabs.find(t => t.id === v.id)?.isDeleted === true);
  const dupActive = gFinal ? activeTabs(gFinal).filter(t => victims.some(v => v.url === t.url)).length : -1;
  console.log(`📊 负控: 仍墓碑 ${stillTombstoned.length}/${victims.length} | 活跃 tab=${activeTabs(gFinal).length} | 同 URL 活跃副本=${dupActive}`);
  if (stillTombstoned.length !== victims.length) fail(`❌ 负控失败: ${victims.length - stillTombstoned.length} 个被移除标签被云端复活`);
  else if (dupActive > 0) fail(`❌ 负控失败: 出现 ${dupActive} 个同 URL 活跃副本（变体复活）`);
  else console.log('✅ 负控通过: 3 个本地移除意图均未被云端覆盖');

  console.log('\n' + '═'.repeat(62));
  console.log(`测试账号: ${EMAIL}`);
  console.log(`高压力（云端持续写入下本地移除不被复活）: ${ok ? '✅ 通过（含 3 项正控）' : '❌ 失败'}`);
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
