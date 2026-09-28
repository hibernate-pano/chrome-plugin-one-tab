// 端到端验证统一硬删除规则（2026-09-28）：
// 删掉某会话的最后一个标签 → 该会话从存储中物理消失，且不进回收站。
import { launchCtx, readGroupsFromSW, dismissOnboarding, openPopup } from './e2e-helpers.mjs';

const label = process.argv[2] || 'harddel';
const rid = () => Math.random().toString(36).slice(2, 10);
const now = () => new Date().toISOString();

const SEED = [
  { name: '单页会话', tabs: 1 },   // 删掉唯一标签 → 应彻底消失
  { name: '多页会话', tabs: 2 },   // 删掉一个标签 → 应保留
].map((s, i) => ({
  id: `seed-${rid()}`,
  name: s.name,
  tabs: Array.from({ length: s.tabs }, (_, j) => ({
    id: `t-${rid()}`, url: `https://s${i}p${j}.com`, title: `${s.name}-${j}`,
    createdAt: now(), lastAccessed: now(), pinned: false,
  })),
  createdAt: now(), updatedAt: now(), isLocked: false, version: 1,
}));

const ctx = await launchCtx(label);
try {
  if (!ctx.serviceWorkers()[0]) await new Promise(r => setTimeout(r, 3000));
  const sw = ctx.serviceWorkers()[0];
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
  }, SEED);

  const page = await openPopup(ctx, id);
  await dismissOnboarding(page);
  await page.waitForTimeout(2000);

  const before = await readGroupsFromSW(ctx);
  console.log(`初始: ${before.length} 组 ->`, before.map(g => `${g.name}(${(g.tabs||[]).length}tab)`).join(', '));

  // ⚠️ 必须等 SW 侧 storage 缓存过期（30s TTL）再发 mutation。
  // SW 启动时 runMigrations 会先读一次 tab_groups——那时本脚本还没注入数据，于是
  // 缓存里留下陈旧的 []。mutation 走 storage.getGroups() 命中这个空缓存，
  // applyRemoveTab 找不到组就原样返回 []，调用方 setGroups([]) 会把数据全抹了。
  // 这是测试注入方式造成的假象（生产里 SW 启动时库里已有数据），不是被测逻辑的问题。
  console.log('等待 SW storage 缓存 TTL 过期（30s）…');
  await page.waitForTimeout(31_000);

  // 走生产语义命令（SW 单写者路径）：删掉「单页会话」唯一的标签
  // 必须从 popup 上下文发：SW 内部自发自收会死锁（消息通道在响应前关闭）
  const singleGroup = before.find(g => g.name === '单页会话');
  const tabId = singleGroup.tabs[0].id;
  console.log(`发送 removeTab: group=${singleGroup.id} tab=${tabId}`);
  const res = await page.evaluate(async ({ groupId, tid }) => {
    return await chrome.runtime.sendMessage({
      type: 'MUTATE',
      data: { op: 'removeTab', groupId, tabId: tid },
    });
  }, { groupId: singleGroup.id, tid: tabId });
  console.log('SW 返回:', JSON.stringify(res));
  await page.waitForTimeout(3000);

  const after = await readGroupsFromSW(ctx);
  console.log(`删后: ${after.length} 组 ->`, after.map(g => `${g.name}(${(g.tabs||[]).length}tab${g.isDeleted ? ',墓碑' : ''})`).join(', '));

  // 云端 purge 队列：本地删了还不够，云端行必须登记待删
  const purge = await sw.evaluate(async () => new Promise((resolve, reject) => {
    const r = indexedDB.open('tabvaultpro', 1);
    r.onsuccess = () => {
      const db = r.result;
      const q = db.transaction('kv', 'readonly').objectStore('kv').getAll();
      q.onsuccess = () => {
        db.close();
        const e = (q.result || []).find(v => v?.key === 'pending_purge_ids');
        resolve(e ? e.value : null);
      };
      q.onerror = () => { db.close(); reject(new Error('read')); };
    };
    r.onerror = () => reject(new Error('open'));
  }));

  const single = after.find(g => g.name === '单页会话');
  const multi = after.find(g => g.name === '多页会话');

  console.log('\n判据:');
  console.log(`  单页会话彻底消失（不留墓碑）: ${!single ? 'PASS' : 'FAIL — 仍在存储 isDeleted=' + single.isDeleted}`);
  console.log(`  多页会话保留: ${multi ? 'PASS' : 'FAIL'}`);
  console.log(`  云端 purge 队列已登记: ${Array.isArray(purge) && purge.includes(singleGroup.id) ? 'PASS ' + JSON.stringify(purge) : 'FAIL ' + JSON.stringify(purge)}`);

  const cards = await page.locator('.tab-group-card').count();
  console.log(`  UI 卡片数: ${cards}（应为 1：只剩多页会话）`);
} finally {
  await ctx.close();
}
