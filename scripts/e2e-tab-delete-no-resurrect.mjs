// 双实例 E2E：单个标签删除的跨设备传播（tab 级墓碑回归测试）
//
// 修复前的 bug：B 设备删除会话中的单个标签（物理移除无墓碑）→ 上传后云端
// 无该标签 → A 设备后台轮询下载合并时把它当作 local-only 并回来（复活），
// 再经 A 上传传回 B——删除意图彻底丢失。
//
// 修复后的不变量（本脚本三重断言）：
//   ① B 删除后，B 本地 storage 中该 tab 为墓碑（isDeleted=true），活跃数减少
//   ② A 下载合并后，该 tab 在 A 端不复活（活跃数一致，墓碑已传播）
//   ③ A 再上传 → B 再下载后，B 端不回弹（墓碑双向幂等）
//
// 运行：node scripts/e2e-tab-delete-no-resurrect.mjs

import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const DIST = resolve(process.cwd(), 'dist');
const EMAIL = `e2e-tb-${randomUUID().slice(0, 6)}@test.tapstack.dev`;
const PWD = 'SyncTest#2026!';

function launchCtx(label) {
  const dir = mkdtempSync(join(tmpdir(), `tapstack-${label}-`));
  return chromium.launchPersistentContext(dir, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
  });
}
async function extId(ctx) { return new URL(ctx.serviceWorkers()[0].url()).host; }
async function ensureNoOverlay(page) {
  await page.evaluate(() =>
    document.querySelectorAll('.onboarding-overlay, [role=dialog][aria-label="用户引导"]').forEach(el => el.remove())
  ).catch(() => {});
}

/** 直读 IndexedDB（db=tabvaultpro, store=kv）取本地 groups 全量（含墓碑） */
function makeReadLocalGroups() {
  return page => page.evaluate(async () => {
    return new Promise((resolve) => {
      const r = indexedDB.open('tabvaultpro', 1);
      r.onerror = () => resolve([]);
      r.onsuccess = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('kv')) { db.close(); resolve([]); return; }
        const tx = db.transaction('kv', 'readonly');
        const all = tx.objectStore('kv').getAll();
        all.onsuccess = () => {
          db.close();
          const rec = all.result || [];
          const entry = rec.find(v => v?.key === 'tab_groups');
          resolve(entry?.value || []);
        };
        all.onerror = () => { db.close(); resolve([]); };
      };
    });
  });
}
const readLocalGroups = makeReadLocalGroups();

async function manualUpload(page) {
  await page.click('button[title="手动上传本地会话到云端"]');
  await page.waitForSelector('.fixed h3:has-text("上传到云端")');
  await page.locator('.fixed h4:has-text("合并模式"), .fixed h4:has-text("覆盖模式")').first().click();
  await page.waitForTimeout(4000);
}
async function manualDownload(page) {
  await page.click('button[title="手动从云端下载会话到本地"]');
  await page.waitForSelector('.fixed h3:has-text("下载到本地")');
  await page.locator('.fixed h4:has-text("合并模式"), .fixed h4:has-text("覆盖模式")').first().click();
  await page.waitForTimeout(4000);
}

/** 下载并轮询 storage 直到出现活跃组（规避登录初始化竞态），最多 attempts 次 */
async function downloadUntilData(page, readFn, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    await manualDownload(page);
    const groups = await readFn(page);
    if (groups.some(g => !g.isDeleted && g.tabs.length > 0)) return groups;
    console.log(`   ...第 ${i + 1} 次下载后无活跃组，重试`);
    await page.waitForTimeout(2000);
  }
  return readFn(page);
}

let ok = true;
const ctxA = await launchCtx('A');
const ctxB = await launchCtx('B');
let server;
try {
  let n = 0;
  server = createServer((req, res) => {
    n++;
    const t = `TB-${n}-标签`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${t}</title><h1>${t}</h1>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // ── A: 注册 + 保存 1 个会话（3 个标签）+ 上传 ────────────────────
  await ctxA.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => {});
  const id = await extId(ctxA);
  const pageA = await ctxA.newPage();
  await pageA.goto(`chrome-extension://${id}/src/popup/index.html`);
  await pageA.waitForTimeout(1500);
  await ensureNoOverlay(pageA);
  await pageA.click('button[aria-label="菜单"]');
  await pageA.click('button:has-text("登录 / 注册")');
  await pageA.click('.fixed button:has-text("注册")');
  await pageA.fill('input[placeholder="请输入您的邮箱"]', EMAIL);
  await pageA.fill('input[placeholder="请输入密码"]', PWD);
  await pageA.fill('input[placeholder="请再次输入密码"]', PWD);
  await pageA.click('button[type="submit"]');
  await pageA.waitForSelector('button[title="手动上传本地会话到云端"]', { timeout: 25000 });
  console.log('✅ A registered');

  for (const p of ['/p1', '/p2', '/p3']) {
    const pg = await ctxA.newPage(); await pg.goto(`${base}${p}`); await pg.waitForSelector('h1');
  }
  await pageA.locator('[aria-label="保存当前窗口中的所有标签页为会话"]').first().click();
  await pageA.waitForTimeout(2500);
  // 关闭 3 个内容页，只留扩展页，避免后续干扰
  for (const pg of ctxA.pages()) {
    if (pg !== pageA && !pg.url().startsWith('chrome-extension://')) await pg.close().catch(() => {});
  }
  await manualUpload(pageA);

  const aGroups0 = await readLocalGroups(pageA);
  const aSession = aGroups0.find(g => !g.isDeleted && g.tabs.length === 3);
  console.log(`📊 A 保存的会话: ${aSession?.name} (${aSession?.tabs.length} tabs)`);

  // ── B: 登录 + 下载 ────────────────────────────────────────────────
  await ctxB.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => {});
  const pageB = await ctxB.newPage();
  await pageB.goto(`chrome-extension://${id}/src/popup/index.html`);
  await pageB.waitForTimeout(1500);
  await ensureNoOverlay(pageB);
  await pageB.click('button[aria-label="菜单"]');
  await pageB.click('button:has-text("登录 / 注册")');
  await pageB.fill('input[placeholder="请输入您的邮箱"]', EMAIL);
  await pageB.fill('input[placeholder="请输入您的密码"]', PWD);
  await pageB.click('button[type="submit"]');
  await pageB.waitForSelector('button[title="手动上传本地会话到云端"]', { timeout: 25000 });
  await pageB.waitForTimeout(2000); // 等登录初始化（AuthProvider 自动流程）稳定

  const bGroups0 = await downloadUntilData(pageB, readLocalGroups);
  const bSession = bGroups0.find(g => !g.isDeleted && g.tabs.length >= 2);
  if (!bSession || bSession.tabs.length !== 3) {
    console.log(`❌ B 下载后会话应有 3 个标签，实际: ${bGroups0.map(g => `${g.name}=${g.tabs.length}`).join(', ')}`);
    ok = false;
    throw new Error('setup failed');
  }
  console.log(`📊 B 下载后: "${bSession.name}" 3 个活跃标签`);
  const victimTitle = bSession.tabs[1].title; // 删第 2 个标签
  const victimUrl = bSession.tabs[1].url;
  const victimId = bSession.tabs[1].id;
  console.log(`🎯 目标删除标签: "${victimTitle}" (${victimUrl})`);

  // ── B: UI 删除第 2 个标签（真实路径: handleDeleteTab → updateGroup(filter)）──
  const card = pageB.locator('.tab-group-card').first();
  // 若会话卡片处于折叠态先展开
  const expandBtn = card.locator('button[aria-label="展开会话"]');
  if (await expandBtn.count()) { await expandBtn.first().click().catch(() => {}); await pageB.waitForTimeout(500); }

  const delBtn = card.locator(`button[aria-label="删除标签页: ${victimTitle}"]`).first();
  await delBtn.click();
  await pageB.waitForTimeout(800);
  // 兼容确认对话框（confirmBeforeDelete）
  const confirmBtn = pageB.locator('.fixed button:has-text("确认"), .fixed button:has-text("删除")').last();
  if (await confirmBtn.count()) { await confirmBtn.click().catch(() => {}); }
  await pageB.waitForTimeout(2000); // 等 updateGroup thunk 写 storage

  // ── 断言①: B 本地 storage 出现墓碑，活跃数 = 2 ──────────────────
  const bAfterDel = await readLocalGroups(pageB);
  const bSess1 = bAfterDel.find(g => g.id === bSession.id);
  const bTomb = bSess1?.tabs.find(t => t.id === victimId);
  const bActive1 = bSess1 ? bSess1.tabs.filter(t => !t.isDeleted).length : -1;
  console.log(`📊 断言① B 删除后: 活跃=${bActive1}, 墓碑标记=${bTomb?.isDeleted}`);
  if (!bTomb || bTomb.isDeleted !== true) {
    console.log('❌ 断言①失败: 被删标签未以墓碑形式保留在 storage');
    ok = false;
  } else if (bActive1 !== 2) {
    console.log(`❌ 断言①失败: 活跃标签应为 2，实际 ${bActive1}`);
    ok = false;
  } else {
    console.log('✅ 断言①通过: B 端墓碑写入正确');
  }

  // ── B 上传 → A 下载（模拟 A 的后台轮询拉取结果） ────────────────
  await manualUpload(pageB);
  console.log('✅ B uploaded (含墓碑)');
  await manualDownload(pageA);
  console.log('✅ A downloaded');

  // ── 断言②: A 端不复活 ───────────────────────────────────────────
  const aAfter = await readLocalGroups(pageA);
  const aSess = aAfter.find(g => g.id === bSession.id);
  const aVictim = aSess?.tabs.find(t => t.url === victimUrl);
  const aActive = aSess ? aSess.tabs.filter(t => !t.isDeleted).length : -1;
  console.log(`📊 断言② A 合并后: 活跃=${aActive}, 该URL标签状态=${aVictim ? (aVictim.isDeleted ? '墓碑' : '活跃') : '不存在'}`);
  if (!aSess) {
    console.log('❌ 断言②失败: A 端找不到目标会话');
    ok = false;
  } else if (aActive !== 2) {
    console.log(`❌ 断言②失败: A 端活跃标签应为 2，实际 ${aActive}（跨设备复活！）`);
    ok = false;
  } else if (aVictim && aVictim.isDeleted !== true) {
    console.log('❌ 断言②失败: A 端被删标签为活跃状态（复活变体）');
    ok = false;
  } else {
    console.log('✅ 断言②通过: 删除意图跨设备传播，A 端未复活');
  }

  // ── A 上传 → B 下载（反向轮询回路，验证不回弹） ─────────────────
  await manualUpload(pageA);
  await manualDownload(pageB);

  // ── 断言③: B 端不回弹 ───────────────────────────────────────────
  const bFinal = await readLocalGroups(pageB);
  const bSessF = bFinal.find(g => g.id === bSession.id);
  const bFinalActive = bSessF ? bSessF.tabs.filter(t => !t.isDeleted).length : -1;
  console.log(`📊 断言③ B 二次下载后: 活跃=${bFinalActive}`);
  if (bFinalActive !== 2) {
    console.log(`❌ 断言③失败: B 端活跃标签应为 2，实际 ${bFinalActive}（回弹复活！）`);
    ok = false;
  } else {
    console.log('✅ 断言③通过: 反向同步回路无回弹');
  }

  if (ok) {
    console.log('\n✅✅ 双因子验证全部通过：单标签删除经「墓碑写入 → 云端传播 → 反向回路」均不复活');
    process.exitCode = 0;
  } else {
    console.log('\n❌ 双因子验证失败');
    process.exitCode = 1;
  }
} catch (e) {
  console.error('\n💥 测试执行异常:', e.message);
  process.exitCode = 1;
} finally {
  try { server?.close(); } catch {}
  try { await ctxA.close(); } catch {}
  try { await ctxB.close(); } catch {}
}
