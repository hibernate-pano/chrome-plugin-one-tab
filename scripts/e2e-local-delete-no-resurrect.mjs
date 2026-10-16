// 真实场景验证：本地「删除会话 / 点开标签（打开即移除）」的意图不会被后台同步反向覆盖。
//
// 原脚本为什么重写过一轮（测试报告 §4.3）：IDB 读失败被吞成 [] 会假绿、用 tabs.length
// 认组导致「会话被复活」是死代码、没有正控导致「动作没发生」与「没被复活」不可区分。
// 这些坑本脚本保留修复成果（按 g.id 定位、正控齐全、数据缺失一律判失败）。
//
// ── 2026-09-29 v1.22.0：墓碑体系废除（提交 bdad42d），删除即物理移除 ──
// 原断言②写的是「会话 1 删除后应成为 isDeleted 墓碑」、断言③写的是「点开的标签应墓碑化」——
// 旧世界语义。新模型下（src/core/mutationOps.ts）：
//   删除会话 → 本地物理删 + pendingDeleteIds 队列；上传时 markCloudGroupsAsDeleted
//              广播删除（WebDAV 后端把 isDeleted 墓碑写进分片；旧云端后端 UPDATE 行），
//              读回确认后清队。对端下载合并时按 stamp 决胜服从删除
//              （src/core/opStampMerge.ts）。
//   点开标签 → 物理移除该 tab + 组 stamp 提升，整组行上传覆盖。
// 因此现在检验的不变量是：
//   ① 会话 1 在 B 本地物理消失，且 id 进入 pending_delete_ids（删除广播确实被登记）
//   ② 被点开的标签在 B 本地物理消失（不是墓碑化）
//   ③ B 上传后 pending_delete_ids 被清空 —— 清队只发生在 markCloudGroupsAsDeleted
//      读回确认成功之后（src/services/syncEngine.ts），所以「队列空了」= 云端确实标上了
//   ④ 负控：90s 后台同步 + 重开 popup，会话 1 与被点开的标签都没有回来
//
// 运行：node scripts/e2e-local-delete-no-resurrect.mjs（需先 pnpm build）
// 需要 dufs 与 playwright。2026-10-16 账号体系删除后云盘改成本机 dufs + WebDAV：
// 配置/凭据直种解析层（e2e-helpers 的 WebDAV 段）。

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  launchCtx, extId, readLocalGroups, readKvAll, readKvFromSW, kvValue,
  manualUpload, manualDownload, downloadUntil, waitOutUploadGuard,
  startContentSite, prepareDavDist, startDufs, seedWebDav, resyncAlarm,
  dismissOnboarding, nudgeSyncAlarm, pollUntil,
} from './e2e-helpers.mjs';
import { createGate } from './e2e-support.mjs';

const gate = createGate();

const urlsInStorage = (groups, url) => groups.flatMap(g => g.tabs || []).filter(t => t.url === url);
const idsInStorage = (groups, id) => groups.filter(g => g.id === id);
/**
 * 云端 manifest 里是否已有该 id 的墓碑。
 *
 * 为什么要读它而不是只看 pending_delete_ids：本地删除会先登记队列，随后
 * scheduleUpload 的 1.5~3s 快路径就把墓碑写上云并**清空队列**。本地 dufs 比
 * 旧版云端快，脚本读队列时可能刚好落在「已广播、已清队」之后 —— 此时队列为空
 * 不代表删除意图没登记，而是已经完成。只看队列 = 拿时间竞态当断言。
 * manifest 是明文（适配器设计如此，探活需要），可直接判定。
 */
const cloudHasTombstone = id => {
  try {
    const manifest = JSON.parse(readFileSync(join(dav.dir, 'TapStack', 'manifest.json'), 'utf8'));
    return (manifest.shards || []).some(s => s.id === id && s.isDeleted === true);
  } catch {
    return false; // 还没写过 manifest = 未广播
  }
};

const dav = await startDufs('nr-dav');
const davDist = prepareDavDist();
const ctxA = await launchCtx('A', davDist);
const ctxB = await launchCtx('B', davDist);
const site = await startContentSite('NR-标签');
try {
  // ── A：配置本地 WebDAV + 保存 2 个会话（各 2 个标签）+ 上传 ────────
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
  for (let s = 0; s < 2; s++) {
    const pages = await mkTabs(2);
    await pageA.locator('[aria-label="保存当前窗口中的所有标签页为会话，并关闭这些标签页"]').first().click();
    await pageA.waitForTimeout(2500);
    for (const p of pages) await p.close();
  }
  await manualUpload(pageA);
  console.log('✅ A 保存并上传 2 个会话');

  // ── B：配置同一云盘 + 下载（正控①：真的拿到 2 个双标签活跃会话）──
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
  const { groups: bInit, downloaded } = await downloadUntil(
    pageB,
    gs => gs.filter(g => g.tabs.length === 2).length >= 2,
    'B 本地出现 2 个双标签会话'
  );
  const ready = bInit
    .filter(g => g.tabs.length === 2)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  gate.check('正控①：B 下载后有 2 个双标签会话', ready.length >= 2,
    `下载执行=${downloaded}，实际 ${bInit.map(g => `${g.name}=${g.tabs.length}`).join(', ')}`);
  if (ready.length < 2) throw new Error('setup failed');
  const [session1, session2] = ready; // 会话1 = 先创建的那个
  // 锚点从本地数据动态取（不写死标题，造数据方式变了也不失效）
  const anchor1 = session1.tabs[0].title;
  const anchor2 = session2.tabs[0].title;
  const victimTab = session2.tabs[0];
  console.log(`   锚点: 会话1「${anchor1}」/ 会话2「${anchor2}」，目标标签=${victimTab.title}`);

  // ── B 删除「会话 1」（TabGroup 删除按钮 → showConfirm → deleteGroup）──
  const card1 = pageB.locator('.tab-group-card').filter({ hasText: anchor1 }).first();
  if (!(await card1.count())) {
    gate.check('前置：找到会话 1 的卡片', false, `卡片数=${await pageB.locator('.tab-group-card').count()}`);
    throw new Error('card1 not found');
  }
  await card1.locator('button[aria-label="删除会话"]').first().click({ timeout: 15000 });
  await pageB.waitForTimeout(800);
  const confirm = pageB.locator('.fixed button:has-text("确认"), .fixed button:has-text("删除")').last();
  if (await confirm.count()) await confirm.click({ timeout: 8000 }).catch(() => {});
  await pageB.waitForTimeout(2500);

  // 判据②：会话 1 物理消失 + 删除意图已被登记或已广播上云
  const afterDelete = await readLocalGroups(pageB);
  const stillThere = idsInStorage(afterDelete, session1.id);
  const pendingDeletes = kvValue(await readKvFromSW(ctxB), 'pending_delete_ids') || [];
  const broadcasted = cloudHasTombstone(session1.id);
  console.log(`📊 判据② 会话 1 本地残留=${stillThere.length}，pending_delete_ids=${JSON.stringify(pendingDeletes)}，云端墓碑=${broadcasted}`);
  gate.check('判据②：已删除的会话 1 在 B 本地物理消失（不进回收站）', stillThere.length === 0,
    `仍存在于 storage：${stillThere.map(g => g.name).join(', ')}`);
  gate.check('判据②：删除意图已登记（pending_delete_ids）或已广播上云（云端墓碑）',
    (Array.isArray(pendingDeletes) && pendingDeletes.includes(session1.id)) || broadcasted,
    `队列=${JSON.stringify(pendingDeletes)}，云端墓碑=${broadcasted}，目标=${session1.id}`);

  // ── B 点开「会话 2」的第一个标签（打开即移除）───────────────────
  const card2 = pageB.locator('.tab-group-card').filter({ hasText: anchor2 }).first();
  if (!(await card2.count())) {
    gate.check('前置：找到会话 2 的卡片', false, `卡片数=${await pageB.locator('.tab-group-card').count()}`);
    throw new Error('card2 not found');
  }
  await card2.locator(`a[aria-label^="打开标签页: ${victimTab.title}"]`).first().click({ timeout: 15000 });

  // 判据③：被点开的标签物理消失（轮询，不用固定 sleep）
  let g2AfterOpen = null;
  for (let i = 0; i < 6; i++) {
    const gs = await readLocalGroups(pageB);
    g2AfterOpen = gs.find(g => g.id === session2.id);
    const gone = urlsInStorage(gs, victimTab.url).length === 0;
    if (gone && g2AfterOpen?.tabs.length === 1) break;
    await pageB.waitForTimeout(1200);
  }
  const g2Leftover = urlsInStorage(await readLocalGroups(pageB), victimTab.url);
  console.log(`📊 判据③ 会话 2 剩 ${g2AfterOpen?.tabs.length ?? '-'} 个标签，目标标签残留=${g2Leftover.length}`);
  gate.check('判据③：点开的标签在本地物理消失（会话 2 剩 1 个标签）',
    g2Leftover.length === 0 && g2AfterOpen?.tabs.length === 1,
    `残留=${g2Leftover.length}，会话2 标签数=${g2AfterOpen?.tabs.length ?? '组不存在'}`);

  // ── B 手动上传：把两条删除意图广播到云端 ────────────────────────
  await manualUpload(pageB);
  await pageB.waitForTimeout(2000);
  const pendingAfterUpload = kvValue(await readKvFromSW(ctxB), 'pending_delete_ids') || [];
  console.log(`📊 判据④ 上传后 pending_delete_ids=${JSON.stringify(pendingAfterUpload)}`);
  gate.check('判据④：上传后删除队列已清空（= 云端墓碑已写入并读回确认）',
    !pendingAfterUpload.includes(session1.id),
    `队列仍含目标 id：${JSON.stringify(pendingAfterUpload)}`);

  // ── 判据⑤：完全不知情的一端（A）下载后必须服从云端墓碑 ──
  // 这是组删除在新模型下的核心防线：A 本地还留着会话 1 的活跃副本，只有云端那行
  // isDeleted 墓碑 + 更大的 stamp 能让它在合并时消失（opStampMerge 的「云端墓碑 vs
  // 本地活跃」分支）。没有这一步，这个脚本只测了删除端自己。
  const aSyncBefore = kvValue(await readKvAll(pageA), 'last_sync_time');
  // A 的上次上传在脚本开头，间隔未必够 35s：窗口内的下载会被
  // decideDownloadPrecheck 静默 skip（syncDecision.UPLOAD_GUARD_MS），
  // 判据⑤ 就会变成在测"下载没跑"。先等出窗口（e2e-helpers 约定 3）。
  await waitOutUploadGuard(pageA);
  await manualDownload(pageA);
  const aSyncAfter = kvValue(await readKvAll(pageA), 'last_sync_time');
  const aAfter = await readLocalGroups(pageA);
  const aHasS1 = idsInStorage(aAfter, session1.id);
  const aVictimLeft = urlsInStorage(aAfter, victimTab.url);
  const aS2 = aAfter.find(g => g.id === session2.id);
  console.log(`📊 判据⑤ A 端: 会话1 残留=${aHasS1.length}，目标标签残留=${aVictimLeft.length}` +
    `，会话2 标签数=${aS2?.tabs.length ?? '-'}`);
  gate.check('正控③：A 的下载确实执行过（last_sync_time 前进）',
    Boolean(aSyncAfter) && aSyncAfter !== aSyncBefore, '下载没跑起来 → 判据⑤无意义');
  gate.check('判据⑤：A 端服从云端删除（会话 1 未复活）', aHasS1.length === 0,
    `复活了 ${aHasS1.length} 个`);
  gate.check('判据⑤：A 端被点开的标签未复活', aVictimLeft.length === 0,
    `复活了 ${aVictimLeft.length} 个`);
  gate.check('判据⑤：A 端会话 2 剩 1 个标签（其余数据没被误删）', aS2?.tabs.length === 1,
    `实际 ${aS2?.tabs.length ?? '组不存在'}`);

  // ── 关闭 B popup；提前触发后台同步 alarm ──────────────────────
  // 2026-10-16 口径：自动同步档位最小 5 分钟，不能等「30s 上传 alarm + 60s 同步
  // alarm」那种旧节奏。改为在 popup 关闭后主动把同一个 alarm 的触发时间拨到最近
  // （chrome.alarms 最小 0.5 分钟 ≈ 30s），验的是 onAlarm 处理链确实跑完
  //「先上传本地意图，再下载合并」；档位本身由设置与单测负责。
  const syncBefore = kvValue(await readKvFromSW(ctxB), 'last_sync_time');
  await pageB.close();
  const nudgePage = await ctxB.newPage();
  await nudgePage.goto(`chrome-extension://${id}/src/options/index.html`).catch(() => {});
  // 先越过 35s 上传保护窗口：否则 decideDownloadPrecheck 会因「刚上传过」静默
  // 跳过下载（负控会因为「下载没跑」而假绿，这比失败更坏）。
  await waitOutUploadGuard(nudgePage);
  await nudgeSyncAlarm(nudgePage);
  await nudgePage.close();
  console.log('⏳ B popup 已关闭；已提前触发后台同步 alarm（约 30s 后执行），轮询等待...');
  const polledSync = await pollUntil(
    async () => kvValue(await readKvFromSW(ctxB), 'last_sync_time'),
    v => Boolean(v) && v !== syncBefore,
    { timeoutMs: 90_000, gapMs: 3000 }
  );
  console.log(`   ...轮询到后台同步：last_sync_time ${syncBefore || '-'} → ${polledSync || '-'}`);

  // ── 负控：重开 popup，两条意图都不该被云端覆盖回来 ──────────────
  const pageB2 = await ctxB.newPage();
  await pageB2.goto(`chrome-extension://${id}/src/popup/index.html`);
  await pageB2.waitForTimeout(6000); // 等挂载自动下载合并完成
  const finalGroups = await readLocalGroups(pageB2);
  gate.check('正控④：重开后本地数据非空（读失败/数据丢失一律判失败）', finalGroups.length > 0,
    `storage 组数=${finalGroups.length}`);

  const syncAfter = kvValue(await readKvFromSW(ctxB), 'last_sync_time');
  const didSync = Boolean(syncAfter) && syncAfter !== syncBefore;
  const f1 = idsInStorage(finalGroups, session1.id);
  const f2 = finalGroups.find(g => g.id === session2.id);
  const victimLeft = urlsInStorage(finalGroups, victimTab.url);
  console.log(`📊 90s 后: last_sync_time ${syncBefore || '-'} → ${syncAfter || '-'}` +
    ` | 会话1 残留=${f1.length} | 会话2 标签数=${f2?.tabs.length ?? '-'} | 目标标签残留=${victimLeft.length}`);

  gate.check('正控④：后台同步确实执行过（last_sync_time 前进）', didSync,
    '后台没跑同步 → 负控无意义');
  gate.check('负控①：已删除的会话 1 未被云端复活', f1.length === 0,
    `复活了 ${f1.length} 个`);
  gate.check('负控②：被点开的标签未被云端复活', victimLeft.length === 0,
    `复活了 ${victimLeft.length} 个`);
  gate.check('负控③：会话 2 仍保留 1 个标签（其余数据没被误删）', f2?.tabs.length === 1,
    `实际 ${f2?.tabs.length ?? '组不存在'}`);

  // ── 终检：再走一轮 A 上传 → B 下载，确认无复活（组级 LWW 幂等）──
  await manualUpload(pageA);
  await waitOutUploadGuard(pageB2);
  await manualDownload(pageB2);
  const round2 = await readLocalGroups(pageB2);
  const r2S1 = idsInStorage(round2, session1.id);
  const r2Victim = urlsInStorage(round2, victimTab.url);
  const r2S2 = round2.find(g => g.id === session2.id);
  console.log(`📊 终检（二次同步后）: 会话1 残留=${r2S1.length} | 目标标签残留=${r2Victim.length}` +
    ` | 会话2 标签数=${r2S2?.tabs.length ?? '-'}`);
  gate.check('终检：二次同步后已删除的会话 1 仍未复活', r2S1.length === 0,
    `复活了 ${r2S1.length} 个`);
  gate.check('终检：二次同步后被点开的标签仍未复活', r2Victim.length === 0,
    `复活了 ${r2Victim.length} 个`);
  gate.check('终检：二次同步后会话 2 仍剩 1 个标签', r2S2?.tabs.length === 1,
    `实际 ${r2S2?.tabs.length ?? '组不存在'}`);

  gate.report('本地删除/点开 不被后台同步覆盖（v1.22.0 无墓碑模型）');
} catch (e) {
  console.error('\n💥 执行异常:', e.message);
  gate.check('脚本执行未抛异常', false, e.message);
  gate.report('本地删除/点开 不被后台同步覆盖（v1.22.0 无墓碑模型）');
} finally {
  try { site.server.close(); } catch { /* 关不掉不影响判定 */ }
  try { await ctxA.close(); } catch { /* 同上 */ }
  try { await ctxB.close(); } catch { /* 同上 */ }
  const dufsGone = await dav.stop();
  try { rmSync(davDist, { recursive: true, force: true }); } catch { /* 同上 */ }
  console.log(`清理：dufs 已退出=${dufsGone}`);
  if (!dufsGone) process.exitCode = 1;
}
