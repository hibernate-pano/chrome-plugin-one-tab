// 真实环境验证：后台定时 alarm（chrome.alarms）在 **popup 关闭** 时确实拉取了云端新数据。
//
// 为什么重写（原版测不到它声称的东西，见测试报告 §4.2）：
//   原断言是「重开 popup 后 UI 会话数变多」，但 AuthProvider 在 popup 每次挂载、只要
//   检测到已登录就会自动发一次 download → 不靠 alarm 也能满足断言；脚本里算出的
//   hasSession2 只打印、没参与判定。等价于「后台轮询」从未被验证。
//
// 2026-10-16 补充：账号体系删除、同步档位改为用户可选（最小 5 分钟），旧文案里的
//「60s」已不存在。本脚本仍然验同一个不变量：**popup 关闭时 alarm 驱动的同步管线
// 会把云端新数据拉下来**，只是触发手段改为把同名 alarm 的触发时间拨到最近。
//
// 本版全程不挂载 popup，改用 **Service Worker 上下文**读存储（这是不会触发同步的唯一读法）：
//   正控① 等待期间 last_sync_time 前进（后台确实同步过）
//   正控② SW 侧存储里出现了 A 后上传的会话 2（云端数据确实被拉到本地）
//   正控③ pending_upload 已清（本地变更也上传过）
//
// 流程：A 配置 → 会话1 上传 → B 配置下载（UI 验收一次）→ B 关 popup
//      → A 上传会话2 → 提前触发后台同步 alarm → SW 上下文验收
//
// 2026-10-16 账号体系删除后：云盘换成本机 dufs + WebDAV，配置/凭据直种解析层
// （e2e-helpers 的 WebDAV 段）；用户可选同步档位最小 5 分钟，不能再等 60s，
// 改为把同一个 alarm 的触发时间拨到最近（≈30s），验 onAlarm 处理链。

import { rmSync } from 'node:fs';
import {
  launchCtx, extId, readGroupsFromSW, readKvFromSW, kvValue,
  manualUpload, downloadUntil, startContentSite, prepareDavDist, startDufs,
  seedWebDav, resyncAlarm, dismissOnboarding, nudgeSyncAlarm, pollUntil,
} from './e2e-helpers.mjs';

let ok = true;
const fail = m => { console.log(m); ok = false; };
const activeTabs = g => (g ? g.tabs.filter(t => !t.isDeleted) : []);

const dav = await startDufs('bg-dav');
const davDist = prepareDavDist();
const ctxA = await launchCtx('A', davDist);
const ctxB = await launchCtx('B', davDist);
const site = await startContentSite('BG-标签');
try {
  // ── A：配置本地 WebDAV + 会话1（2 标签）上传 ─────────────────────
  await ctxA.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => {});
  const id = await extId(ctxA);
  const pageA = await ctxA.newPage();
  await pageA.goto(`chrome-extension://${id}/src/popup/index.html`);
  await dismissOnboarding(pageA);
  const seededA = await seedWebDav(pageA, { origin: dav.origin, autoSync: true });
  await resyncAlarm(pageA);
  if (!(seededA.backend === 'webdav' && seededA.baseUrl === `${dav.origin}/` && seededA.unlocked && seededA.syncEnabled)) {
    fail(`❌ 前置失败：A 未种入 WebDAV 配置/未解锁 → ${JSON.stringify(seededA)}`);
  }

  const openTabs = async n => {
    const ps = [];
    for (let i = 0; i < n; i++) {
      const p = await ctxA.newPage();
      await p.goto(`${site.base}/b${Date.now()}-${i}`);
      await p.waitForSelector('h1');
      ps.push(p);
    }
    return ps;
  };
  let tabs = await openTabs(2);
  await pageA.locator('[aria-label="保存当前窗口中的所有标签页为会话，并关闭这些标签页"]').first().click();
  await pageA.waitForTimeout(2500);
  for (const p of tabs) await p.close();
  await manualUpload(pageA);
  const aGroups1 = await readGroupsFromSW(ctxA);
  const session1 = aGroups1.find(g => !g.isDeleted && activeTabs(g).length === 2);
  console.log(`✅ A: 会话1 "${session1?.name}" 已上云 (id=${session1?.id?.slice(0, 8)})`);

  // ── B：配置同一云盘 + 下载（正控：本地确有会话1）───────────────
  await ctxB.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => {});
  const pageB = await ctxB.newPage();
  await pageB.goto(`chrome-extension://${id}/src/popup/index.html`);
  await dismissOnboarding(pageB);
  const seededB = await seedWebDav(pageB, { origin: dav.origin, autoSync: true });
  await resyncAlarm(pageB);
  if (!(seededB.backend === 'webdav' && seededB.baseUrl === `${dav.origin}/` && seededB.unlocked && seededB.syncEnabled)) {
    fail(`❌ 前置失败：B 未种入 WebDAV 配置/未解锁 → ${JSON.stringify(seededB)}`);
  }
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
  await pageA.locator('[aria-label="保存当前窗口中的所有标签页为会话，并关闭这些标签页"]').first().click();
  await pageA.waitForTimeout(2500);
  for (const p of tabs) await p.close();
  await manualUpload(pageA);
  const aGroups2 = await readGroupsFromSW(ctxA);
  const session2 = aGroups2.find(g => !g.isDeleted && g.id !== session1?.id && activeTabs(g).length === 2);
  console.log(`✅ A: 会话2 "${session2?.name}" 已上云 (id=${session2?.id?.slice(0, 8)})`);

  // ── 等后台同步把会话2 拉下来 ───────────────────────────────────
  // 2026-10-16 口径：用户可选档位最小 5 分钟，不再等「60s alarm」。这里主动把
  // 同名 alarm 的触发时间拨到最近（chrome.alarms 最小 0.5 分钟 ≈ 30s），
  // 验的是 onAlarm 处理链（无 popup 挂载时也能拉取），而不是 Chrome 的定时器。
  const nudgePage = await ctxB.newPage();
  await nudgePage.goto(`chrome-extension://${id}/src/options/index.html`).catch(() => {});
  // 清掉 scheduleUpload 可能留下的上传 alarm：它会把 last_upload_time 刷新，
  // 导致 decideDownloadPrecheck 又静默跳过下载。
  await nudgePage.evaluate(() => chrome.alarms.clear('tapstack-scheduled-upload')).catch(() => {});
  const guardAgeMs = async () => {
    const t = kvValue(await readKvFromSW(ctxB).catch(() => []), 'last_upload_time');
    return t ? Date.now() - new Date(t).getTime() : Number.POSITIVE_INFINITY;
  };
  await pollUntil(guardAgeMs, age => age >= 40_000, { timeoutMs: 150_000, gapMs: 3000 });
  await nudgeSyncAlarm(nudgePage);
  await nudgePage.close();
  console.log('⏳ B popup 已关闭；已提前触发后台同步 alarm（约 30s 后执行），轮询等待会话 2 落地...');
  // 目标直接是「会话2 出现在 B 本地」，不拿 last_sync_time 当判据：
  // 上传路径也写 last_sync_time，会让「又上传了一次」冒充「下载成功」。
  const finalGroups = await pollUntil(
    () => readGroupsFromSW(ctxB).catch(() => []),
    gs => gs.some(g => g.id === session2?.id && !g.isDeleted),
    { timeoutMs: 180_000, gapMs: 3000 }
  );
  console.log(`   ...轮询结果：会话2 已到本地=${finalGroups.some(g => g.id === session2?.id && !g.isDeleted)}`);

  // ── 在 SW 上下文验收（不挂载 popup）────────────────────────────
  const kvAfter = await readKvFromSW(ctxB);
  const syncAfter = kvValue(kvAfter, 'last_sync_time');
  const pendingAfter = kvValue(kvAfter, 'pending_upload');
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
  console.log('云盘: 本机 dufs（无需账号）');
  console.log(`后台 alarm 同步（popup 关闭期间）: ${ok ? '✅ 通过' : '❌ 失败'}`);
  console.log('═'.repeat(62));
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  console.error('\n💥 执行异常:', e.message);
  process.exitCode = 1;
} finally {
  try { site.server.close(); } catch {}
  try { await ctxA.close(); } catch {}
  try { await ctxB.close(); } catch {}
  const dufsGone = await dav.stop();
  try { rmSync(davDist, { recursive: true, force: true }); } catch {}
  console.log(`清理：dufs 已退出=${dufsGone}`);
  if (!dufsGone) process.exitCode = 1;
}
