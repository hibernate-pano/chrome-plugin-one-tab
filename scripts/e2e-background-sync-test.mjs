// 真实环境验证：后台 60s 轮询（chrome.alarms）在 **popup 关闭** 时确实拉取了云端新数据。
//
// 为什么重写（原版测不到它声称的东西，见测试报告 §4.2）：
//   原断言是「重开 popup 后 UI 会话数变多」，但 AuthProvider 在 popup 每次挂载、只要
//   检测到已登录就会自动发一次 download → 不靠 alarm 也能满足断言；脚本里算出的
//   hasSession2 只打印、没参与判定。等价于「60s 轮询」从未被验证。
//
// 本版全程不挂载 popup，改用 **Service Worker 上下文**读存储（这是不会触发同步的唯一读法）：
//   正控① 等待期间 last_sync_time 前进（后台确实同步过）
//   正控② SW 侧存储里出现了 A 后上传的会话 2（云端数据确实被拉到本地）
//   正控③ pending_upload 已清（本地变更也上传过）
//
// 流程：A 注册 → 会话1 上传 → B 登录下载（UI 验收一次）→ B 关 popup
//      → A 上传会话2 → 等 90s（30s 上传 alarm + 60s 同步 alarm）→ SW 上下文验收

import { randomUUID } from 'node:crypto';
import {
  launchCtx, extId, readGroupsFromSW, readKvFromSW, kvValue,
  manualUpload, downloadUntil, login, startContentSite, openTabsInSameWindow,
} from './e2e-helpers.mjs';

const EMAIL = `e2e-bgsync-${randomUUID().slice(0, 6)}@test.tapstack.dev`;
const PWD = 'SyncTest#2026!';

let ok = true;
const fail = m => { console.log(m); ok = false; };
const activeTabs = g => (g ? g.tabs.filter(t => !t.isDeleted) : []);

const ctxA = await launchCtx('A');
const ctxB = await launchCtx('B');
const site = await startContentSite('BG-标签');
try {
  // ── A：注册 + 会话1（2 标签）上传 ───────────────────────────────
  await ctxA.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => {});
  const id = await extId(ctxA);
  const pageA = await ctxA.newPage();
  await pageA.goto(`chrome-extension://${id}/src/popup/index.html`);
  await login(pageA, EMAIL, PWD, { register: true });

  const openTabs = async n => {
    const urls = Array.from({ length: n }, (_, i) => `${site.base}/b${Date.now()}-${i}`);
    const pages = await openTabsInSameWindow(pageA, urls);
    for (const page of pages) await page.waitForSelector('h1');
    return pages;
  };
  let tabs = await openTabs(2);
  await pageA.locator('[aria-label="保存当前窗口中的所有标签页为会话"]').first().click();
  await pageA.waitForTimeout(2500);
  for (const p of tabs) await p.close();
  await manualUpload(pageA);
  const aGroups1 = await readGroupsFromSW(ctxA);
  const session1 = aGroups1.find(g => !g.isDeleted && activeTabs(g).length === 2);
  console.log(`✅ A: 会话1 "${session1?.name}" 已上云 (id=${session1?.id?.slice(0, 8)})`);

  // ── B：登录 + 下载（正控：本地确有会话1）───────────────────────
  await ctxB.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => {});
  const pageB = await ctxB.newPage();
  await pageB.goto(`chrome-extension://${id}/src/popup/index.html`);
  await login(pageB, EMAIL, PWD);
  const { groups: bInit } = await downloadUntil(
    pageB,
    gs => gs.some(g => g.id === session1?.id && !g.isDeleted),
    'B 本地出现会话 1'
  );
  if (!bInit.some(g => g.id === session1?.id && !g.isDeleted)) {
    fail('❌ 前置失败：B 未下载到会话 1');
    throw new Error('setup failed');
  }
  console.log('✅ 正控① 通过: B 手动下载后本地已有会话 1');

  // ── B 关闭 popup（关键：此后不得再挂载 popup，否则自动下载会污染判定）──
  const syncBefore = kvValue(await readKvFromSW(ctxB), 'last_sync_time');
  await pageB.close();
  console.log(`⏳ B popup 已关闭（last_sync_time 基线 ${syncBefore || '-'}），关闭期间不再打开任何 popup 页面`);

  // ── A：上传会话2（制造云端新数据）──────────────────────────────
  tabs = await openTabs(2);
  await pageA.locator('[aria-label="保存当前窗口中的所有标签页为会话"]').first().click();
  await pageA.waitForTimeout(2500);
  for (const p of tabs) await p.close();
  await manualUpload(pageA);
  const aGroups2 = await readGroupsFromSW(ctxA);
  const session2 = aGroups2.find(g => !g.isDeleted && g.id !== session1?.id && activeTabs(g).length === 2);
  console.log(`✅ A: 会话2 "${session2?.name}" 已上云 (id=${session2?.id?.slice(0, 8)})`);

  // ── 等 90s：30s 上传 alarm + 60s 同步 alarm 都应触发过 ──────────
  await pageA.waitForTimeout(90_000);

  // ── 在 SW 上下文验收（不挂载 popup）────────────────────────────
  const kvAfter = await readKvFromSW(ctxB);
  const syncAfter = kvValue(kvAfter, 'last_sync_time');
  const pendingAfter = kvValue(kvAfter, 'pending_upload');
  const finalGroups = await readGroupsFromSW(ctxB);
  const hasSession2 = finalGroups.some(g => g.id === session2?.id && !g.isDeleted);
  const activeCount = finalGroups.filter(g => !g.isDeleted).length;
  const didSync = Boolean(syncAfter) && syncAfter !== syncBefore;

  console.log(`📊 SW 侧验收: last_sync_time ${syncBefore || '-'} → ${syncAfter || '-'}`);
  console.log(`   活跃会话数=${activeCount} | 含会话2=${hasSession2} | pending_upload=${pendingAfter}`);

  if (!didSync) fail('❌ 正控① 失败：popup 关闭期间 last_sync_time 未前进 → 后台轮询没有真的同步');
  else console.log('✅ 正控① 通过：popup 关闭期间后台确实执行了同步');

  if (!hasSession2) fail('❌ 正控② 失败：本地没有拿到 A 在 popup 关闭期间上传的会话 2');
  else console.log('✅ 正控② 通过：云端新数据被后台轮询拉到本地（无需任何手动操作）');

  if (pendingAfter === true) fail('❌ 正控③ 失败：pending_upload 仍为 true（本地变更未上传）');
  else console.log('✅ 正控③ 通过：本地变更也已上传');

  console.log('\n' + '═'.repeat(62));
  console.log(`测试账号: ${EMAIL}`);
  console.log(`60s 后台轮询（popup 关闭期间）: ${ok ? '✅ 通过' : '❌ 失败'}`);
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
