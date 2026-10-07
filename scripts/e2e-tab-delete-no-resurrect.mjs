// 双实例 E2E：单个标签删除的跨设备传播（v1.22.0 无墓碑模型的回归防线）
//
// 修复前的 bug（1.21.x 墓碑模型）：B 物理移除某个 tab → 上传后云端整组行少了这个 tab
//   → A 下载合并时把它当作 local-only 副本带回来（复活）→ 再经 A 上传传回 B。
//
// ── 2026-09-29 v1.22.0：墓碑体系废除（提交 bdad42d），删除即物理移除 ──
// 本脚本原先断言「B 本地留下 isDeleted=true 的 tab 墓碑、A 端墓碑传播」，那是旧世界：
// 新模型下写路径永不产墓碑（src/core/mutationOps.ts 的 applyRemoveTab 物理 filter），
// 跨设备删除意图的**唯一**载体是整组行的 op-stamp + 组级 LWW 覆盖
// （src/core/opStampMerge.ts）。断言照抄旧模型 = 必挂的假防线。
//
// 现在检验的新不变量（三条判据，全部围绕「删掉的东西不能被同步带回来」）：
//   ① B 删除后本地立即物理消失：目标 tab 的 id 与 url 在**整个 storage** 里都不存在，
//      且 storage 里不存在任何 isDeleted===true 的 tab（写路径不产墓碑）
//   ② B 上传 → A 下载后 A 端不复活：目标 url 在 A 整个 storage 里不存在；
//      同时 last_sync_time 前进（正控：下载确实执行过，而不是什么都没发生）
//   ③ A 上传 → B 下载后仍不复活（组级 LWW 幂等，无回弹）
//
// 运行：node scripts/e2e-tab-delete-no-resurrect.mjs（需先 pnpm build）

import { randomUUID } from 'node:crypto';
import {
  launchCtx, extId, readLocalGroups, readKvAll, kvValue,
  manualUpload, manualDownload, downloadUntil, waitOutUploadGuard,
  login, startContentSite,
} from './e2e-helpers.mjs';
import { accountMarker, createGate } from './e2e-support.mjs';

const EMAIL = `e2e-tb-${randomUUID().slice(0, 6)}@test.tapstack.dev`;
const PWD = 'SyncTest#2026!';
console.log(accountMarker(EMAIL)); // 供 run-e2e 收尾统一清理

const gate = createGate();

/** 整个 storage 里是否还有带该 url 的 tab（跨组：删除意图被复活时可能落在别的组里） */
const urlsInStorage = (groups, url) =>
  groups.flatMap(g => g.tabs || []).filter(t => t.url === url);

/** 整个 storage 里是否还有任何墓碑 tab（新模型写路径不该产出，读到就是回归） */
const tombstonesInStorage = groups =>
  groups.flatMap(g => g.tabs || []).filter(t => t.isDeleted === true);

const ctxA = await launchCtx('A');
const ctxB = await launchCtx('B');
const site = await startContentSite('TB-标签');
try {
  // ── A：注册 + 保存 3-tab 会话 + 上传 ─────────────────────────────
  await ctxA.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => {});
  const id = await extId(ctxA);
  const pageA = await ctxA.newPage();
  await pageA.goto(`chrome-extension://${id}/src/popup/index.html`);
  await login(pageA, EMAIL, PWD, { register: true });
  console.log('✅ A 注册并登录');

  const opened = [];
  for (let i = 0; i < 3; i++) {
    const p = await ctxA.newPage();
    await p.goto(`${site.base}/p${Date.now()}-${i}`);
    await p.waitForSelector('h1');
    opened.push(p);
  }
  await pageA.locator('[aria-label="保存当前窗口中的所有标签页为会话，并关闭这些标签页"]').first().click();
  await pageA.waitForTimeout(2500);
  for (const p of opened) await p.close(); // 关掉内容页，避免后续保存/打开被干扰
  await manualUpload(pageA);

  const aGroups0 = await readLocalGroups(pageA);
  const aSession = aGroups0.find(g => g.tabs.length === 3);
  if (!aSession) {
    gate.check('前置：A 本地保存出 3-tab 会话', false,
      `实际 ${aGroups0.map(g => `${g.name}=${g.tabs.length}`).join(', ')}`);
    throw new Error('setup failed');
  }
  console.log(`📊 A 保存的会话: ${aSession.name} (${aSession.tabs.length} tabs)`);

  // ── B：登录 + 下载（正控：真的拿到了 3 个标签）────────────────────
  await ctxB.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => {});
  const pageB = await ctxB.newPage();
  await pageB.goto(`chrome-extension://${id}/src/popup/index.html`);
  await login(pageB, EMAIL, PWD);
  const { groups: bInit, downloaded } = await downloadUntil(
    pageB,
    gs => gs.some(g => g.tabs.length === 3),
    'B 本地出现 3-tab 会话'
  );
  const bSession = bInit.find(g => g.tabs.length === 3);
  gate.check('正控：B 下载后拿到 3-tab 会话', Boolean(bSession),
    `下载执行=${downloaded}，实际 ${bInit.map(g => `${g.name}=${g.tabs.length}`).join(', ')}`);
  if (!bSession) throw new Error('setup failed');
  console.log(`📊 B 下载后: "${bSession.name}" 3 个标签`);

  // 目标：第 2 个标签（删中间那个，剩下两个仍非空 → 组保留，单独考验 tab 级删除）
  const victim = bSession.tabs[1];
  console.log(`🎯 目标删除标签: "${victim.title}" (${victim.url})`);

  // ── B：UI 删除该标签（真实路径：TabGroup 删除按钮 → deleteTabAndSync）──
  // 先展开所有折叠卡片
  const expanders = pageB.locator('button[aria-label="展开会话"]');
  for (let i = 0; i < 10 && (await expanders.count()) > 0; i++) {
    await expanders.first().click().catch(() => {});
    await pageB.waitForTimeout(300);
  }
  const card = pageB.locator('.tab-group-card').filter({ hasText: victim.title }).first();
  if (!(await card.count())) {
    gate.check('前置：找到含目标标签的卡片', false,
      `页面卡片数=${await pageB.locator('.tab-group-card').count()}`);
    throw new Error('card not found');
  }
  await card.locator(`button[aria-label="删除标签页: ${victim.title}"]`).first().click({ timeout: 15000 });
  await pageB.waitForTimeout(800);
  const confirmBtn = pageB.locator('.fixed button:has-text("确认"), .fixed button:has-text("删除")').last();
  if (await confirmBtn.count()) await confirmBtn.click({ timeout: 8000 }).catch(() => {});
  await pageB.waitForTimeout(2500); // 等 mutation 落盘

  // ── 判据①：B 本地立即物理移除 + 写路径不产墓碑 ────────────────────
  const bAfterDel = await readLocalGroups(pageB);
  const bSess1 = bAfterDel.find(g => g.id === bSession.id);
  const bLeftover = urlsInStorage(bAfterDel, victim.url);
  console.log(`📊 判据① B 删除后: 该组剩 ${bSess1?.tabs.length ?? '-'} 个标签，` +
    `全 storage 内同 url 残留 ${bLeftover.length} 个，墓碑 tab ${tombstonesInStorage(bAfterDel).length} 个`);
  gate.check('判据①：删除后 B 本地该组剩 2 个标签', bSess1?.tabs.length === 2,
    `实际 ${bSess1?.tabs.length ?? '组不存在'}`);
  gate.check('判据①：目标标签在 B 整个 storage 里物理消失（无墓碑残留）', bLeftover.length === 0,
    `仍存在 ${bLeftover.length} 个`);
  gate.check('判据①：B 写路径不产出任何 isDeleted 墓碑 tab', tombstonesInStorage(bAfterDel).length === 0,
    `发现 ${tombstonesInStorage(bAfterDel).length} 个`);

  // ── B 上传 → A 下载（模拟 A 的后台轮询拉取结果）─────────────────
  await manualUpload(pageB);
  console.log('✅ B uploaded（整组行覆盖上传）');
  // A 上次上传在 B 登录/下载之前，间隔未必够 35s：decideDownloadPrecheck 的上传保护
  // 窗口会把窗口内的下载**静默 skip** 掉（syncDecision.UPLOAD_GUARD_MS），判据就会
  // 因为"下载没跑"而假失败。先等出窗口（e2e-helpers 约定 3），再断言 last_sync_time。
  await waitOutUploadGuard(pageA);
  const syncBefore = kvValue(await readKvAll(pageA), 'last_sync_time');
  await manualDownload(pageA);
  const syncAfter = kvValue(await readKvAll(pageA), 'last_sync_time');
  console.log('✅ A downloaded');

  // ── 判据②：A 端不复活 ───────────────────────────────────────────
  const aAfter = await readLocalGroups(pageA);
  const aSess = aAfter.find(g => g.id === bSession.id);
  const aLeftover = urlsInStorage(aAfter, victim.url);
  const didSync = Boolean(syncAfter) && syncAfter !== syncBefore;
  console.log(`📊 判据② A 合并后: 该组 ${aSess?.tabs.length ?? '-'} 个标签，` +
    `全 storage 内同 url 残留 ${aLeftover.length} 个，last_sync_time ${syncBefore || '-'} → ${syncAfter || '-'}`);
  gate.check('正控：A 的下载确实执行过（last_sync_time 前进）', didSync,
    '下载没跑起来 → 后面两条判据无意义');
  gate.check('判据②：A 端该组收到 B 的 2-tab 覆盖（组级 LWW 整组赢）', aSess?.tabs.length === 2,
    `实际 ${aSess?.tabs.length ?? '组不存在'}`);
  gate.check('判据②：目标标签在 A 整个 storage 里不存在（跨设备不复活）', aLeftover.length === 0,
    `仍存在 ${aLeftover.length} 个`);

  // ── A 上传 → B 下载（反向回路，验证无回弹）─────────────────────
  await manualUpload(pageA);
  // B 刚上传过（判据①之后），A 这一轮上传又只隔十几秒：窗口内的下载会被
  // decideDownloadPrecheck 静默 skip，判据③就变成在测"下载没跑"。先等出窗口。
  await waitOutUploadGuard(pageB);
  await manualDownload(pageB);

  const bFinal = await readLocalGroups(pageB);
  const bSessF = bFinal.find(g => g.id === bSession.id);
  const bLeftoverFinal = urlsInStorage(bFinal, victim.url);
  console.log(`📊 判据③ B 二次下载后: 该组 ${bSessF?.tabs.length ?? '-'} 个标签，同 url 残留 ${bLeftoverFinal.length} 个`);
  gate.check('判据③：反向同步回路无回弹（B 端仍 2 个标签）', bSessF?.tabs.length === 2,
    `实际 ${bSessF?.tabs.length ?? '组不存在'}`);
  gate.check('判据③：目标标签未被云端带回', bLeftoverFinal.length === 0,
    `仍存在 ${bLeftoverFinal.length} 个`);

  gate.report('单标签删除跨设备传播（v1.22.0 无墓碑模型）');
} catch (e) {
  console.error('\n💥 测试执行异常:', e.message);
  gate.check('脚本执行未抛异常', false, e.message);
  gate.report('单标签删除跨设备传播（v1.22.0 无墓碑模型）');
} finally {
  try { site.server.close(); } catch { /* 关不掉不影响判定 */ }
  try { await ctxA.close(); } catch { /* 同上 */ }
  try { await ctxB.close(); } catch { /* 同上 */ }
}
