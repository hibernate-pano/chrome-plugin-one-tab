// 「清理旧会话」六档真机回归（2026-11-04，纯本地 / 不登录 / 不连云端）。
//
// ── 这个脚本要防的具体事故 ────────────────────────────────────────────────
//
// 2026-11-03 的 UI 版（e1ad80f）在 `handleCleanupTier` 开头同步调用了
// `setOpenSubmenu(null)`。被点的行就在这个子菜单里 ⇒ 同一个 click 的 React
// discrete flush 先把按钮从 DOM 卸载；click 继续冒泡到 document 的
// 「点外面关闭菜单」处理器时，target 已脱离文档、`contains(target)` 为 false
// ⇒ 整个下拉菜单被卸载 ⇒ await 磁盘读回来时 mountedRef=false ⇒ 确认框永远
// 不弹。真机表现：点时间档 / 「保留锁定」，菜单一关，什么都没发生。
//
// 源码层守卫（tests/guards/cleanupMenu.test.ts）只能证明代码里写了
// getGroupsForWrite / deleteGroups，抓不到事件顺序与卸载。⇒ 这条真机脚本
// 逐个点六个档位，判据是**确认框真的出现**，取消后数据不变，确认后只删该删的。
//
// 运行：pnpm build 后 `node scripts/e2e-cleanup-menu.mjs`（有头 Chrome；本机
// headless 不注册 MV3 SW，沿用 e2e-helpers 的 launchCtx 约定）。
import {
  dismissOnboarding,
  extId,
  launchCtx,
  openPopup,
  readGroupsFromSW,
} from './e2e-helpers.mjs';
import { createGate } from './e2e-support.mjs';

const label = process.argv[2] || 'cleanup-menu';
const gate = createGate();
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const iso = ms => new Date(ms).toISOString();
const rid = () => Math.random().toString(36).slice(2, 8);

/** 一个会话：年龄按天算，标签数固定 1（确认框里的标签页数可预期）。 */
function seedGroup({ id, name, ageDays, isLocked = false }) {
  const at = iso(now - ageDays * DAY);
  return {
    id,
    name,
    notes: '',
    isFavorite: false,
    isLocked,
    isDeleted: false,
    tabs: [{
      id: `${id}-tab`,
      url: `https://${id}.example.com/`,
      title: `${name} 标签`,
      createdAt: at,
      lastAccessed: at,
      pinned: false,
    }],
    createdAt: at,
    updatedAt: at,
    version: 1,
    displayOrder: 0,
    lastOp: { d: 'e2e', s: 1 },
  };
}

// 六档的预期：时间档只数未锁定且够旧的；「保留锁定」留 1 个锁定；「含锁定」全删。
const SEED = [
  seedGroup({ id: `old1-${rid()}`, name: '一个月前-未锁定', ageDays: 40 }),
  seedGroup({ id: `old3-${rid()}`, name: '三个月前-未锁定', ageDays: 100 }),
  seedGroup({ id: `old6-${rid()}`, name: '六个月前-未锁定', ageDays: 200 }),
  seedGroup({ id: `old12-${rid()}`, name: '一年前-未锁定', ageDays: 400 }),
  seedGroup({ id: `locked-${rid()}`, name: '旧会话-已锁定', ageDays: 40, isLocked: true }),
  seedGroup({ id: `recent-${rid()}`, name: '最近-未锁定', ageDays: 1 }),
];

const TIERS = [
  { row: /一个月前的会话/, title: /清理 4 个会话/, confirm: '清理' },
  { row: /三个月前的会话/, title: /清理 3 个会话/, confirm: '清理' },
  { row: /六个月前的会话/, title: /清理 2 个会话/, confirm: '清理' },
  { row: /一年前的会话/, title: /清理 1 个会话/, confirm: '清理' },
  { row: /删除所有会话（保留 1 个锁定）/, title: /删除 5 个会话/, confirm: '清理' },
  { row: /删除所有会话（含 1 个锁定）/, title: /删除全部 6 个会话/, confirm: '全部删除' },
];

const ctx = await launchCtx(label);
let failed = false;
try {
  // 冷启动时 SW 可能还没注册（本机实测 >1s）；与 e2e-core-loop 同一处理。
  for (let i = 0; i < 60 && !ctx.serviceWorkers()[0]; i += 1) {
    await new Promise(r => setTimeout(r, 500));
  }
  const id = await extId(ctx);

  // ── 造种子：直接写 IndexedDB（与生产 storage 同键同形状）──
  const sw = ctx.serviceWorkers()[0];
  await sw.evaluate(async groups => {
    const r = indexedDB.open('tabvaultpro', 1);
    await new Promise((res, rej) => { r.onsuccess = res; r.onerror = () => rej(new Error('IDB open')); });
    const db = r.result;
    await new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ key: 'tab_groups', value: groups });
      tx.oncomplete = res;
      tx.onerror = () => rej(new Error('IDB write'));
    });
    db.close();
  }, SEED);

  const page = await openPopup(ctx, id, { waitMs: 2500 });
  await dismissOnboarding(page);
  await page.waitForTimeout(800);

  const groupsNow = async () => (await readGroupsFromSW(ctx)).map(g => g.id).sort();
  const expectedIds = SEED.map(g => g.id).sort();

  /** 打开菜单 → 展开「清理旧会话」子菜单（cancel 后菜单可能已被外点关闭）。 */
  const openCleanup = async () => {
    const trigger = page.locator('[data-menu-trigger]');
    if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
      await trigger.click();
    }
    const parent = page.getByRole('menuitem', { name: '清理旧会话' });
    if ((await parent.getAttribute('aria-expanded')) !== 'true') {
      await parent.click();
    }
    // 「含锁定」那一行恒在（它是「删除所有会话」这个动作本身）——
    // 拿它当子菜单已展开的哨兵，避免依赖此时还剩哪些时间档。
    await page.getByRole('menuitem', { name: /删除所有会话（含/ }).waitFor({ state: 'visible', timeout: 5000 });
  };

  const readDialog = async () => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });
    return dialog.innerText();
  };

  // ── ① 六档都必须真的弹出确认框；取消后一个会话都不许少 ────────────────
  for (const tier of TIERS) {
    await openCleanup();
    await page.getByRole('menuitem', { name: tier.row }).click();
    const text = await readDialog();
    gate.check(`「${tier.row.source.replace(/[（）]/g, '')}」弹出确认框`, tier.title.test(text), text.split('\n')[0]);
    gate.check(`「${tier.row.source}」确认框声明不可撤销`, (text.includes('没有回收站') || text.includes('无法恢复')), text.slice(0, 120));
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('[role="dialog"]').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    gate.check(`取消「${tier.row.source}」后数据不变`, JSON.stringify(await groupsNow()) === JSON.stringify(expectedIds));
  }

  // ── ② 确认「一个月前」：只删那 1 个未锁定的旧会话 ─────────────────────
  const removedBy1m = SEED.slice(0, 4).map(g => g.id);
  await openCleanup();
  await page.getByRole('menuitem', { name: TIERS[0].row }).click();
  await readDialog();
  await page.getByRole('button', { name: '清理', exact: true }).click();
  await page.locator('[role="dialog"]').waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
  let after = await groupsNow();
  gate.check('确认「一个月前」后删掉 4 个够旧的未锁定会话',
    removedBy1m.every(id => !after.includes(id)) && after.length === SEED.length - 4,
    `剩余 ${after.length} 个`);
  gate.check('「一个月前」不误删锁定会话', after.includes(SEED[4].id));
  gate.check('「一个月前」不误删最近会话', after.includes(SEED[5].id));

  // ── ③ 确认「保留锁定」：未锁定的全清，锁定的那 1 个留下 ────────────────
  await openCleanup();
  await page.getByRole('menuitem', { name: /删除所有会话（保留 1 个锁定）/ }).click();
  await readDialog();
  await page.getByRole('button', { name: '清理', exact: true }).click();
  await page.locator('[role="dialog"]').waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
  after = await groupsNow();
  gate.check('「保留锁定」后只剩那 1 个锁定会话', after.length === 1 && after[0] === SEED[4].id,
    `实际 ${after.length} 个`);

  // ── ④ 存储侧真值：删掉的 id 不得复活 ─────────────────────────────────
  const stored = await readGroupsFromSW(ctx);
  gate.check('磁盘真值与界面一致（只剩锁定会话）', stored.length === 1 && stored[0].id === SEED[4].id);
} catch (error) {
  failed = true;
  console.error('❌ e2e-cleanup-menu 异常:', error);
} finally {
  const ok = gate.report('清理旧会话六档');
  await ctx.close();
  if (failed || !ok) process.exitCode = 1;
}
