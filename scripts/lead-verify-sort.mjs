// 真机验证：会话排序真的接线了吗（L-10 收口）。
//
// 为什么要真机：这一条**曾经**在单测全绿的情况下是假的 ——
// 判据层（core/sessionSort.ts）、设置层、持久化层全都做完了，守卫也全绿，
// 但**列表侧根本没接线**：下拉里能选「最近活动 / 名称 / 会话大小」，
// 列表顺序一动不动。
//
// tsc / eslint / 单测都看不见这一类缺陷（「控件存在」与「控件生效」是
// 两件事）—— 本仓同类教训见 memory: 守卫钉死字面量会让正确的修法变红。
//
// 产出：outputs/lead-verify-sort/*.png + 一份逐步反馈 JSON。

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/lead-verify-sort');
const now = Date.now();
const iso = ms => new Date(ms).toISOString();

function tab(groupId, url, title) {
  return {
    id: crypto.randomUUID(),
    url,
    title,
    favicon: '',
    createdAt: iso(now - 3600e3),
    lastAccessed: iso(now - 3600e3),
    group_id: groupId,
    pinned: false,
  };
}

/** 造一个会话：name + 标签条数 + 创建时间（三个排序键各用得着）。 */
function group(name, tabCount, ageHours) {
  const id = crypto.randomUUID();
  return {
    id,
    name,
    notes: '',
    isFavorite: false,
    isLocked: false,
    isDeleted: false,
    tabs: Array.from({ length: tabCount }, (_, i) =>
      tab(id, `https://example.com/${encodeURIComponent(name)}/${i}`, `${name} 页面 ${i + 1}`)
    ),
    createdAt: iso(now - ageHours * 3600e3),
    updatedAt: iso(now - ageHours * 3600e3),
    version: 1,
    displayOrder: 1,
    lastOp: { d: 'verify-device', s: 1 },
  };
}

// 三个会话：名字顺序、保存时间顺序、标签数顺序**互不相同** ⇒
// 换一次排序键，列表顺序必须真的变（三条都变才算接线成功）。
const groups = [
  group('Charlie 组', 1, 1), // 最新保存
  group('Bravo 组', 3, 2),
  group('Alpha 组', 2, 3), // 最旧保存
];

async function injectGroups(page, data) {
  await page.evaluate(async rows => {
    await new Promise((res, rej) => {
      const req = indexedDB.open('tabvaultpro', 1);
      req.onerror = () => rej(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ key: 'tab_groups', value: rows });
        tx.oncomplete = () => { db.close(); res(); };
        tx.onerror = () => { db.close(); rej(req.error); };
      };
    });
  }, data);
}

/** 列表页当前可见的会话名（按卡片标题 h3 的 id 定位，顺序即渲染顺序）。 */
async function visibleGroupNames(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('h3[id^="tab-group-title-"]')].map(el =>
      (el.textContent || '').trim()
    )
  );
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-sort-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--lang=zh-CN'],
    viewport: { width: 1440, height: 900 },
  });
  const log = [];
  const problems = [];
  try {
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await new Promise(r => setTimeout(r, 500));
    }
    if (!sw) throw new Error('扩展的 service worker 没有起来');
    const id = new URL(sw.url()).host;

    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));

    await page.goto(`chrome-extension://${id}/src/popup/index.html`);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
    await injectGroups(page, groups);
    await page.reload();
    await page.waitForSelector('text=Alpha 组', { timeout: 15000 });
    await page.waitForTimeout(1200);

    // ── 1. 默认排序（最近保存）──
    const defaultOrder = await visibleGroupNames(page);
    log.push({ step: '默认（最近保存）', order: defaultOrder });
    await page.screenshot({ path: join(OUT_DIR, '01-default.png') });
    if (defaultOrder.length !== 3) {
      problems.push(`列表里没有看到 3 个会话（实际 ${defaultOrder.length} 个）`);
    }
    if (defaultOrder[0] !== 'Charlie 组') {
      problems.push(`默认顺序不对：最新保存的「Charlie 组」不在第一位（实际 ${defaultOrder.join('、')}）`);
    }

    // ── 2. 排序下拉必须存在（且可操作）──
    const sortSelect = page.locator('select[aria-label="排序方式"]');
    if (!(await sortSelect.isVisible().catch(() => false))) {
      problems.push('页面上看不到「排序方式」下拉');
      throw new Error('没有排序控件，后续步骤无从验证');
    }

    // ── 3. 切到「名称」⇒ 列表必须变成按名称升序 ──
    await sortSelect.selectOption('name');
    await page.waitForTimeout(900);
    const nameOrder = await visibleGroupNames(page);
    log.push({ step: '按名称', order: nameOrder });
    await page.screenshot({ path: join(OUT_DIR, '02-by-name.png') });
    const expectedByName = ['Alpha 组', 'Bravo 组', 'Charlie 组'];
    if (JSON.stringify(nameOrder) !== JSON.stringify(expectedByName)) {
      problems.push(
        `选了「名称」但列表顺序没变成按名称升序（实际 ${nameOrder.join('、')}，期望 ${expectedByName.join('、')}）` +
          ' —— 排序控件没有接到列表上'
      );
    }

    // ── 4. 切到「会话大小（标签数）」⇒ 标签多的在前 ──
    await sortSelect.selectOption('size');
    await page.waitForTimeout(900);
    const sizeOrder = await visibleGroupNames(page);
    log.push({ step: '按会话大小', order: sizeOrder });
    await page.screenshot({ path: join(OUT_DIR, '03-by-size.png') });
    const expectedBySize = ['Bravo 组', 'Alpha 组', 'Charlie 组'];
    if (JSON.stringify(sizeOrder) !== JSON.stringify(expectedBySize)) {
      problems.push(
        `选了「会话大小」但列表顺序不对（实际 ${sizeOrder.join('、')}，期望 ${expectedBySize.join('、')}）`
      );
    }

    // ── 5. 切回「最近保存」⇒ 必须回到默认顺序（默认口径 = 旧版写死的顺序）──
    await sortSelect.selectOption('saved');
    await page.waitForTimeout(900);
    const backOrder = await visibleGroupNames(page);
    log.push({ step: '切回最近保存', order: backOrder });
    if (JSON.stringify(backOrder) !== JSON.stringify(defaultOrder)) {
      problems.push(
        `切回「最近保存」没有回到默认顺序（实际 ${backOrder.join('、')}，默认 ${defaultOrder.join('、')}）`
      );
    }

    // ── 6. 刷新后排序选择必须还在（落盘）──
    await sortSelect.selectOption('name');
    await page.waitForTimeout(800);
    await page.reload();
    await page.waitForSelector('text=Alpha 组', { timeout: 15000 });
    await page.waitForTimeout(1200);
    const afterReload = await visibleGroupNames(page);
    log.push({ step: '刷新后（选了名称）', order: afterReload });
    await page.screenshot({ path: join(OUT_DIR, '04-after-reload.png') });
    if (JSON.stringify(afterReload) !== JSON.stringify(expectedByName)) {
      problems.push(
        `刷新后排序选择没保住（实际 ${afterReload.join('、')}，期望 ${expectedByName.join('、')}）` +
          ' —— 排序设置没落盘'
      );
    }

    if (consoleErrors.length) {
      problems.push(`控制台报错 ${consoleErrors.length} 条：${consoleErrors.slice(0, 3).join(' | ')}`);
    }
  } catch (error) {
    problems.push(`脚本自身出错：${error.message}`);
  } finally {
    await ctx.close().catch(() => {});
  }

  const report = { problems, steps: log };
  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (problems.length) process.exitCode = 1;
}

main();
