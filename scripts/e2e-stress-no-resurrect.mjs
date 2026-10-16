// 高压力验证：连续本地移除 + 云端持续写入，后台轮询「先上传再下载」后本地意图不被覆盖。
//
// 原脚本为什么重写过一轮（测试报告 §4.3）：原断言只有一个负向检查，若 upload/download
// 全变成空操作，B 本地本来就停在删除后的状态，照样通过——「没被复活」与「根本没同步」
// 不可区分。这层正控保留。
//
// ── 2026-09-29 v1.22.0：墓碑体系废除（提交 bdad42d），删除即物理移除 ──
// 原判据是「3 个被点开的 tab 仍是 isDeleted 墓碑」——旧世界语义。新模型下点开标签
// 走 applyRemoveTab 物理移除（src/core/mutationOps.ts），本地写路径永不产墓碑；
// 跨端复活防线是组级 LWW 整组覆盖（src/core/opStampMerge.ts）——A 端那份 4-tab
// 的旧副本在 A 再上传时要么被预检剔出、要么输给 B 的新 stamp，赢不了。
//
// 现在检验的不变量：
//   正控① 每次点开后目标 tab 立即从整个 storage 物理消失（不是墓碑化）
//   正控② 后台同步确实跑过（SW 上下文读 last_sync_time 前进，且拉到 A 的新会话）
//   正控③ 本地变更确实上传过（pending_upload 已清）
//   负控  后台同步后该组只剩 1 个标签，3 个被移除的 URL 在整个 storage 里都不存在，
//          且没有任何 isDeleted 墓碑 tab / 空壳组被同步带回来
//
// 流程：A 保存 4-tab 会话并上传 → B 下载 → B 点开 3 个标签逐个移除
//      → A 再上传一个新会话（制造云端新数据）→ B 关 popup 并提前触发后台 alarm → 在 SW 上下文验收
//
// 运行：node scripts/e2e-stress-no-resurrect.mjs（需先 pnpm build）
// 需要 dufs 与 playwright。2026-10-16 账号体系删除后云盘改成本机 dufs + WebDAV：
// 配置/凭据直种解析层（e2e-helpers 的 WebDAV 段）。

import { rmSync } from 'node:fs';
import {
  launchCtx, extId, readLocalGroups, readGroupsFromSW, readKvFromSW, kvValue,
  manualUpload, downloadUntil, startContentSite, prepareDavDist, startDufs,
  seedWebDav, resyncAlarm, dismissOnboarding, nudgeSyncAlarm, pollUntil,
} from './e2e-helpers.mjs';
import { createGate } from './e2e-support.mjs';

const gate = createGate();

const urlsInStorage = (groups, url) => groups.flatMap(g => g.tabs || []).filter(t => t.url === url);
const tombstoneTabs = groups => groups.flatMap(g => g.tabs || []).filter(t => t.isDeleted === true);

const dav = await startDufs('st-dav');
const davDist = prepareDavDist();
const ctxA = await launchCtx('A', davDist);
const ctxB = await launchCtx('B', davDist);
const site = await startContentSite('ST-标签');
try {
  // ── A：配置本地 WebDAV + 保存 4-tab 会话 + 上传 ───────────────────
  await ctxA.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => {});
  const id = await extId(ctxA);
  const pageA = await ctxA.newPage();
  await pageA.goto(`chrome-extension://${id}/src/popup/index.html`);
  await dismissOnboarding(pageA);
  const seededA = await seedWebDav(pageA, { origin: dav.origin, autoSync: true });
  await resyncAlarm(pageA);
  gate.check(
    '前置：A 已种入 WebDAV 配置且已解锁（自动同步开启）',
    seededA.backend === 'webdav' && seededA.baseUrl === `${dav.origin}/` && seededA.unlocked && seededA.syncEnabled,
    JSON.stringify(seededA)
  );
  console.log(`✅ A 已配置本地 WebDAV（${dav.origin}）并解锁`);

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
  await pageA.locator('[aria-label="保存当前窗口中的所有标签页为会话，并关闭这些标签页"]').first().click();
  await pageA.waitForTimeout(2500);
  for (const p of tabs) await p.close();
  await manualUpload(pageA);
  console.log('✅ A: 4-tab 会话已上云');

  // ── B：配置同一云盘 + 下载（正控：拿到 4 个标签）─────────────────
  await ctxB.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => {});
  const pageB = await ctxB.newPage();
  await pageB.goto(`chrome-extension://${id}/src/popup/index.html`);
  await dismissOnboarding(pageB);
  const seededB = await seedWebDav(pageB, { origin: dav.origin, autoSync: true });
  await resyncAlarm(pageB);
  gate.check(
    '前置：B 已种入同一云盘配置且已解锁（自动同步开启）',
    seededB.backend === 'webdav' && seededB.baseUrl === `${dav.origin}/` && seededB.unlocked && seededB.syncEnabled,
    JSON.stringify(seededB)
  );
  const { groups: bInit } = await downloadUntil(
    pageB,
    gs => gs.some(g => g.tabs.length === 4),
    'B 本地出现 4-tab 会话'
  );
  const grp0 = bInit.find(g => g.tabs.length === 4);
  gate.check('前置：B 拿到 A 的 4-tab 会话', Boolean(grp0),
    `实际 ${bInit.map(g => `${g.name}=${g.tabs.length}`).join(', ')}`);
  if (!grp0) throw new Error('setup failed');
  const groupId = grp0.id;
  const victims = grp0.tabs.slice(0, 3); // 连续移除 3 个，保留 1 个让组继续存在
  console.log(`📊 B 本地 "${grp0.name}" 4 个标签；目标移除 ${victims.map(t => t.title).join(', ')}`);

  // ── B：逐个点开 3 个标签（打开即物理移除）──────────────────────
  for (const v of victims) {
    const card = pageB.locator('.tab-group-card').filter({ hasText: grp0.name }).first();
    const btn = card.locator(`a[aria-label^="打开标签页: ${v.title}"]`).first();
    if (!(await btn.count())) {
      gate.check(`正控①：点开「${v.title}」`, false, '找不到标签打开按钮');
      continue;
    }
    await btn.click({ timeout: 15000 });
    let gone = false;
    for (let i = 0; i < 6; i++) {
      const gs = await readLocalGroups(pageB);
      if (urlsInStorage(gs, v.url).length === 0) { gone = true; break; }
      await pageB.waitForTimeout(1000);
    }
    const now = await readLocalGroups(pageB);
    const left = now.find(g => g.id === groupId);
    gate.check(`正控①：点开「${v.title}」后本地物理消失（剩 ${left?.tabs.length ?? '-'} 个标签）`,
      gone, gone ? '' : `该 URL 仍在 storage 中（组内剩 ${left?.tabs.length ?? '-'} 个标签）`);
    // 点开会真实打开浏览器标签页，清掉以免干扰
    for (const pg of ctxB.pages()) {
      if (pg !== pageB && !pg.url().startsWith('chrome-extension://')) await pg.close().catch(() => {});
    }
  }

  // 先把 B 的本地移除结果明确上传一次。目的：upload() 成功会取消
  // scheduleUpload 留下的 SYNC_UPLOAD_ALARM，否则它会在我们等上传保护窗口期间
  // 自己发一次，把 last_upload_time 刷新 → 后台下载又被保护窗口跳过 →
  // 「后台拉取」永远测不到。随后验证的仍是后台 alarm 驱动的下载。
  await manualUpload(pageB);
  console.log('✅ B 已手动上传本地移除结果（接下来只验后台下载）');

  // ── A 再上传一个新会话（制造云端新数据）─────────────────────────
  tabs = await openTabs(2);
  await pageA.locator('[aria-label="保存当前窗口中的所有标签页为会话，并关闭这些标签页"]').first().click();
  await pageA.waitForTimeout(2500);
  for (const p of tabs) await p.close();
  await manualUpload(pageA);
  const aGroups = await readLocalGroups(pageA);
  const newGroup = aGroups.find(g => g.tabs.length === 2);
  gate.check('前置：A 追加并上传了一个 2-tab 新会话', Boolean(newGroup),
    `实际 ${aGroups.map(g => `${g.name}=${g.tabs.length}`).join(', ')}`);
  if (!newGroup) throw new Error('setup failed');
  console.log(`✅ A 追加新会话 "${newGroup.name}" 并上传（用于验证后台同步确实发生过）`);

  // ── B 关 popup；提前触发后台同步 alarm（档位最小 5 分钟，这里拨到约 30s）──
  const syncBefore = kvValue(await readKvFromSW(ctxB), 'last_sync_time');
  await pageB.close();
  const nudgePage = await ctxB.newPage();
  await nudgePage.goto(`chrome-extension://${id}/src/options/index.html`).catch(() => {});
  // 清掉 scheduleUpload 可能留下的上传 alarm：它会在等保护窗口期间自己发一次，
  // 把 last_upload_time 刷新 → 后台下载又被保护窗口跳过 → 正控② 永远测不到。
  await nudgePage.evaluate(() => chrome.alarms.clear('tapstack-scheduled-upload')).catch(() => {});
  // 用轮询而不是一次 sleep 越过 35s 上传保护窗口：期间若真发生上传，
  // 水位会被刷新，单次 sleep 会在「保护窗口其实还没过」时就 nudge。
  const guardAgeMs = async () => {
    const t = kvValue(await readKvFromSW(ctxB), 'last_upload_time');
    return t ? Date.now() - new Date(t).getTime() : Number.POSITIVE_INFINITY;
  };
  await pollUntil(guardAgeMs, age => age >= 40_000, { timeoutMs: 150_000, gapMs: 3000 });
  await nudgeSyncAlarm(nudgePage);
  // 完成后关掉 nudgePage；此后只靠 chrome.alarms 唤醒 SW（popup 全程关闭）。
  await nudgePage.close();
  console.log('⏳ B popup 已关闭；已提前触发后台同步 alarm（约 30s 后执行），轮询等到 A 的新会话落地...');
  // 轮询目标直接是「A 的新会话出现在 B 本地」而不是 last_sync_time：
  // last_sync_time 在上传路径也会前进，用它当判据会让「只是又上传了一次」
  // 冒充「下载合并成功」。
  const finalGroups = await pollUntil(
    () => readGroupsFromSW(ctxB),
    gs => gs.some(g => g.id === newGroup.id),
    { timeoutMs: 150_000, gapMs: 3000 }
  );
  const polledSync = kvValue(await readKvFromSW(ctxB), 'last_sync_time');
  console.log(`   ...轮询结果：last_sync_time ${syncBefore || '-'} → ${polledSync || '-'}` +
    `；A 新会话已到本地=${finalGroups.some(g => g.id === newGroup.id)}`);

  // ── 正控②③：在 SW 上下文验收（不挂载 popup）────────────────────
  const kvAfter = await readKvFromSW(ctxB);
  const syncAfter = kvValue(kvAfter, 'last_sync_time');
  const pendingAfter = kvValue(kvAfter, 'pending_upload');
  gate.check('正控：SW 侧本地数据非空（读失败/数据丢失一律判失败）', finalGroups.length > 0,
    `组数=${finalGroups.length}`);

  const didSync = Boolean(syncAfter) && syncAfter !== syncBefore;
  const sawNewSession = finalGroups.some(g => g.id === newGroup.id);
  console.log(`📊 SW 侧: last_sync_time ${syncBefore || '-'} → ${syncAfter || '-'}` +
    `（前进=${didSync}）| 看到 A 的新会话=${sawNewSession} | pending_upload=${pendingAfter}`);
  gate.check('正控②：后台执行过同步（last_sync_time 前进）', didSync,
    '后台没跑同步 → 负控无意义');
  gate.check('正控②：后台同步拉到 A 的新会话（云端→本地确实生效）', sawNewSession,
    `没看到 ${newGroup.id}`);
  gate.check('正控③：本地变更已上传（pending_upload 已清）', pendingAfter !== true,
    `pending_upload=${pendingAfter}`);

  // ── 负控：3 个被移除的标签没有被云端带回来 ──────────────────────
  const gFinal = finalGroups.find(g => g.id === groupId);
  const revived = victims.filter(v => urlsInStorage(finalGroups, v.url).length > 0);
  const tombs = tombstoneTabs(finalGroups);
  const shells = finalGroups.filter(g => !(g.tabs || []).length).length;
  console.log(`📊 负控: 复活 ${revived.length}/${victims.length}` +
    ` | 该组剩 ${gFinal?.tabs.length ?? '-'} 个标签 | 墓碑 tab ${tombs.length} | 空壳组 ${shells}`);
  gate.check(`负控：${victims.length} 个被移除的标签都没有复活`, revived.length === 0,
    `复活：${revived.map(v => v.title).join(', ')}`);
  gate.check('负控：该组只剩 1 个标签（组级 LWW 让 B 的新版本赢）', gFinal?.tabs.length === 1,
    `实际 ${gFinal?.tabs.length ?? '组不存在'}`);
  gate.check('负控：同步后 storage 里没有墓碑 tab（新模型不产生墓碑）', tombs.length === 0,
    `发现 ${tombs.length} 个`);
  gate.check('负控：同步后没有空壳组（删除不产生空会话卡）', shells === 0,
    `发现 ${shells} 个`);

  gate.report('高压力：云端持续写入下本地移除不被复活（v1.22.0 无墓碑模型）');
} catch (e) {
  console.error('\n💥 执行异常:', e.message);
  gate.check('脚本执行未抛异常', false, e.message);
  gate.report('高压力：云端持续写入下本地移除不被复活（v1.22.0 无墓碑模型）');
} finally {
  try { site.server.close(); } catch { /* 关不掉不影响判定 */ }
  try { await ctxA.close(); } catch { /* 同上 */ }
  try { await ctxB.close(); } catch { /* 同上 */ }
  const dufsGone = await dav.stop();
  try { rmSync(davDist, { recursive: true, force: true }); } catch { /* 同上 */ }
  console.log(`清理：dufs 已退出=${dufsGone}`);
  if (!dufsGone) process.exitCode = 1;
}
