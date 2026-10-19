// 核心闭环真机验证（无云端 / 无账号）：
//   保存当前窗口标签页 → 列表里真的多出可列出的会话 → 恢复整个会话后浏览器真的打开了这些标签
//
// 与既有 e2e 脚本的区别：既有脚本大多需要 Supabase 账号 / 连云端才跑得起来，
// 于是「产品最核心、也是唯一必须有的一条链路」长期没有真机证据。这个脚本
// 刻意只登录=不登录、不碰任何后端，全部走产品自身的入口。
//
// 为什么用有头模式（headless: false）：本机实测 headless 不注册 MV3 service
// worker（waitForEvent('serviceworker') 30s 超时），沿用 scripts/e2e-helpers.mjs
// 的 launchCtx 约定。不改用 headless 假装通过。
import { launchCtx, readGroupsFromSW, openPopup, dismissOnboarding, startContentSite } from './e2e-helpers.mjs';
import { createGate } from './e2e-support.mjs';

const label = process.argv[2] || 'coreloop';
const gate = createGate();
const rid = () => Math.random().toString(36).slice(2, 10);
const now = () => new Date().toISOString();

const ctx = await launchCtx(label);
const site = await startContentSite('核心闭环');
let failed = false;
try {
  if (!ctx.serviceWorkers()[0]) await new Promise(r => setTimeout(r, 3000));
  const sw = ctx.serviceWorkers()[0];
  if (!sw) throw new Error('未找到扩展 service worker');
  const id = sw.url().split('/')[2];

  // ── (a) 直接写 IndexedDB 造 2 个种子会话（与生产 storage.setGroups 同键同形状）──
  // 只造 1 个含标签的会话：另 1 个用来验证「计数变化」可被观测（+1 而不是 +2）。
  const probeUrls = [`${site.base}/a`, `${site.base}/b`, `${site.base}/c`];
  const seed = [
    {
      id: `seed-${rid()}`,
      name: '种子会话（可恢复）',
      tabs: probeUrls.map((u, i) => ({
        id: `t-${rid()}`, url: u, title: `探针-${i}`, favicon: '',
        createdAt: now(), lastAccessed: now(), pinned: false,
      })),
      createdAt: now(), updatedAt: now(), isLocked: false, version: 1,
    },
  ];

  await sw.evaluate(async (groups) => {
    const r = indexedDB.open('tabvaultpro', 1);
    await new Promise((res, rej) => { r.onsuccess = res; r.onerror = () => rej(new Error('IDB open')); });
    const db = r.result;
    await new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ key: 'tab_groups', value: groups });
      tx.oncomplete = res; tx.onerror = () => rej(new Error('IDB write'));
    });
    db.close();
  }, seed);

  // ── 让「当前窗口」里真的有几个 http 标签（保存动作的对象）──
  const probePages = [];
  for (const u of probeUrls) probePages.push(await ctx.newPage().then(async p => { await p.goto(u); return p; }));
  const savedUrls = probePages.map(p => new URL(p.url()).href.replace(/\/$/, ''));
  await probePages[0].bringToFront();

  const page = await openPopup(ctx, id, { waitMs: 2500 });
  await dismissOnboarding(page);
  await page.waitForTimeout(1500);

  const countText = () => page.locator('text=/\\d+\\s*会话/').first().innerText();
  const beforeCount = await countText();
  const beforeStored = await readGroupsFromSW(ctx);
  gate.check('种子数据已落盘且只有 1 个会话', beforeStored.length === 1, `实际 ${beforeStored.length}`);
  await page.screenshot({ path: process.env.SHOT_PREFIX ? `${process.env.SHOT_PREFIX}-before.png` : undefined });

  // ── (c) 点顶栏「保存会话」——
  await page.click('button[aria-label="把当前窗口的标签页保存为一个工作会话，并关闭这些标签页（删除不可撤销）"]', { timeout: 20_000 });
  await page.waitForFunction(
    // 2026-10-19 审计 I-3：保存按钮的 aria-label 改用共享常量
    // saveAndCloseDescription（可见文案也变成「保存并关闭标签」）。
    // 这里用 aria-label 的**前缀**匹配，避免把整句写死（它会随文案变）。
    () => !!document.querySelector('button[aria-label^="把当前窗口的标签页保存为一个工作会话"]')?.textContent?.includes('已保存'),
    undefined, { timeout: 20_000 }
  );
  await page.waitForTimeout(2000);

  const afterCount = await countText();
  gate.check('保存后列表计数 +1', parseInt(afterCount) === parseInt(beforeCount) + 1,
    `之前 ${beforeCount} / 之后 ${afterCount}`);

  // 从 SW 侧读回存储（不只看 UI 显示）
  const afterStored = await readGroupsFromSW(ctx);
  const newGroup = afterStored.find(g => !seed.some(s => s.id === g.id));
  gate.check('SW 侧存储里真的多出一个会话', Boolean(newGroup), `存储共 ${afterStored.length} 个`);
  gate.check('新会话的标签 URL 与保存前窗口里的标签一致（数量一致）',
    newGroup && newGroup.tabs.length === savedUrls.length,
    `新会话 ${newGroup?.tabs.length} 个标签，窗口里有 ${savedUrls.length} 个`);
  const storedUrls = (newGroup?.tabs || []).map(t => t.url.replace(/\/$/, ''));
  gate.check('新会话的标签 URL 逐个对得上',
    savedUrls.every(u => storedUrls.includes(u)),
    `期望 ${savedUrls.join(',')} / 实际 ${storedUrls.join(',')}`);
  await page.screenshot({ path: process.env.SHOT_PREFIX ? `${process.env.SHOT_PREFIX}-saved.png` : undefined });

  // ── (d) 点「恢复整个会话」，验证浏览器真的打开了对应 URL ──
  const pagesBefore = ctx.pages().length;
  await page.click(`button[aria-label^="在新窗口恢复整个会话，共 ${savedUrls.length} 个标签页"]`, { timeout: 20_000 });
  // 等新标签被创建出来（POPUP 页不在这些 URL 上，所以按 URL 集合判定）
  let opened = [];
  for (let i = 0; i < 40; i++) {
    opened = ctx.pages().map(p => { try { return new URL(p.url()).href.replace(/\/$/, ''); } catch { return ''; } });
    if (savedUrls.every(u => opened.includes(u))) break;
    await page.waitForTimeout(500);
  }
  gate.check('浏览器真的新增了对应 URL 的标签页',
    savedUrls.every(u => opened.includes(u)),
    `期望 ${savedUrls.join(',')} / 实际新窗口 ${opened.join(',')}`);
  gate.check('确实新增了标签页（数量变多）', ctx.pages().length > pagesBefore,
    `之前 ${pagesBefore} 页 / 之后 ${ctx.pages().length} 页`);

  // 未锁定会话的既有语义：恢复成功后从列表移除
  for (let i = 0; i < 30; i++) {
    const n = (await readGroupsFromSW(ctx)).length;
    if (n === 1) break;
    await page.waitForTimeout(500);
  }
  const afterRestore = await readGroupsFromSW(ctx);
  gate.check('未锁定会话恢复后从存储中移除（回到只剩种子前的 1 个）',
    afterRestore.length === 1 && afterRestore[0].id === seed[0].id,
    `实际 ${afterRestore.map(g => g.name).join(',')}`);
  await page.screenshot({ path: process.env.SHOT_PREFIX ? `${process.env.SHOT_PREFIX}-restored.png` : undefined });

  // ── 连跑第二次：种子里那个会话也要能被恢复（证明上一次的恢复没有污染存储）──
  const seedGroup = afterRestore[0];
  const seedUrls = seedGroup.tabs.map(t => t.url.replace(/\/$/, ''));
  const pagesBefore2 = ctx.pages().length;
  await page.click(`button[aria-label^="在新窗口恢复整个会话，共 ${seedUrls.length} 个标签页"]`, { timeout: 20_000 });
  let opened2 = [];
  for (let i = 0; i < 40; i++) {
    opened2 = ctx.pages().map(p => { try { return new URL(p.url()).href.replace(/\/$/, ''); } catch { return ''; } });
    if (seedUrls.every(u => opened2.includes(u))) break;
    await page.waitForTimeout(500);
  }
  gate.check('第二次恢复同样真的打开了对应 URL（结果可重复）',
    seedUrls.every(u => opened2.includes(u)),
    `期望 ${seedUrls.join(',')} / 实际 ${opened2.join(',')}`);
  gate.check('第二次恢复也新增了标签页', ctx.pages().length > pagesBefore2, '');

  for (let i = 0; i < 30; i++) {
    if ((await readGroupsFromSW(ctx)).length === 0) break;
    await page.waitForTimeout(500);
  }
  const afterRestore2 = await readGroupsFromSW(ctx);
  gate.check('第二次恢复后会话同样被消费，且没有留下重复条目',
    afterRestore2.length === 0, `实际剩余 ${afterRestore2.length} 个`);
  await page.screenshot({ path: process.env.SHOT_PREFIX ? `${process.env.SHOT_PREFIX}-restored2.png` : undefined });
} catch (error) {
  failed = true;
  console.error('   ❌ 异常:', error?.stack || error);
} finally {
  site.server.close();
  await ctx.close().catch(() => {});
}

const ok = gate.report('核心闭环判据');
if (!ok || failed) process.exit(1);
console.log('✅ 核心闭环真机验证通过');
