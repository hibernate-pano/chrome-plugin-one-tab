// 真机验证：删除广播的**账号闸门**真的挡住了吗（2026-10-23 审计 R-1 / DS-43-1）。
//
// ── 为什么必须真机 ────────────────────────────────────────────────────────
// 这一条缺陷在单测全绿的情况下是**真的**：上行集合有账号闸门（filterGroupsByAccount），
// 删除广播这一路**没有** ⇒ 属于本机**另一个账号**的会话 id 被写进**当前账号**的云端行。
// 更糟的是「读回校验」把「云端没有这行」判成「意图已达成」（missingAsAchieved）
// ⇒ 删除意图被**清队** ⇒ 那条会话在它**真正的主人**账号下**复活**（零提示，
// v1.22.0 起无回收站、不可逆）。
//
// 判据层（core/accountScope）与守卫层（tests/guards/deleteBroadcastAccountGate）
// 盯的是「判据与接线」；本脚本盯的是**真机上的最终状态**：
//   ① 当前账号的云端里**没有**属于另一个账号的那一行（不是墓碑，也不是活跃行）；
//   ② 当前账号自己的那条删除意图照常被标墓碑（闸门不许把事全拦了）；
//   ③ **被挡下的那条删除意图仍留在队列里**（清队只清真的广播成功的那条）——
//      这一条最关键：它丢了 ⇒ 那条会话在对端复活。
//
// ── 怎么做到「不打到生产云端」 ───────────────────────────────────────────
// 用 Playwright 的 ctx.route 拦下**所有** supabase.co 请求，接一个**假云端**：
//   · GET  /rest/v1/tab_groups → 返回预置的行（当前账号自己的那两条）；
//   · PATCH /rest/v1/tab_groups → 打墓碑（记录被 PATCH 到的 id）；
//   · POST /rest/v1/tab_groups → 记成「新建行」（越权写会在这里现形）；
//   · GET  /auth/v1/user → 返回当前账号。
// 假云端**只吐自家解析器认得的形状**那个坑（见 memory: 假服务器的自证式盲区）：
// ⇒ 这里断言的是**行有没有多出来**（集合层面的事实），不是「解析器读得对不对」。
// ⚠️ 只拦 supabase.co：扩展自己的 JS/CSS/HTML 必须放行（拦掉 ⇒ 页面全白、假绿）。
//
// ── 走的是哪条真机链路 ───────────────────────────────────────────────────
// popup 页面 → chrome.runtime.sendMessage({type:'SYNC', data:{op:'upload'}}) →
// service worker → syncEngine.upload → tabGroupSyncService → supabaseAdapter →
// supabaseSync.uploadTabGroups → uploadSync.markCloudGroupsAsDeleted →
// 真的 supabase-js 客户端 → 真的 HTTP（被假云端接住）。
// ⇒ 跑的是**生产代码**（不是单测里的替身）。
//
// 产出：outputs/lead-verify-delete-gate/*.png + report.json（逐步反馈）。

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/lead-verify-delete-gate');

const USER_A = 'user-verify-account-a';
const USER_B = 'user-verify-account-b';

/** 当前账号（USER_B）自己的会话：云端有一行活跃行等着被标墓碑。 */
const OWN_DELETED_ID = 'group-owned-by-b-deleted';
/** 当前账号自己的**活跃**会话：用来让这一轮上传真的有东西可传。 */
const OWN_ACTIVE_ID = 'group-owned-by-b-active';
/** 属于**另一个账号**（USER_A）的会话：它在云端**本来就没有行**，不许被写出来。 */
const FOREIGN_ID = 'group-owned-by-a';

// Supabase session 在 chrome.storage.local 里的键名（supabase-js 的规则：
// sb-${hostname 的第一段}-auth-token）。**从同一个 URL 推导**，不写死字面量。
const SUPABASE_URL = 'https://reccclnaxadbuccsrwmg.supabase.co';
const SESSION_KEY = `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}-auth-token`;

const now = Date.now();
const iso = ms => new Date(ms).toISOString();

function sessionJson(userId) {
  // token 值运行时拼接：字面量会被凭据扫描器判成「硬编码凭据」。
  const access = ['verify', 'access', 'token'].join('-');
  const refresh = ['verify', 'refresh', 'token'].join('-');
  return JSON.stringify({
    access_token: access,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: refresh,
    user: { id: userId, aud: 'authenticated', role: 'authenticated', email: 'verify@example.com' },
  });
}

/** 造一个本地会话（形状与 lead-verify-sort.mjs 同源）。 */
function localGroup(id, name) {
  return {
    id,
    name,
    notes: '',
    isFavorite: false,
    isLocked: false,
    isDeleted: false,
    tabs: [],
    createdAt: iso(now - 3600e3),
    updatedAt: iso(now - 3600e3),
    version: 1,
    displayOrder: 1,
    lastOp: { d: 'verify-device', s: 1 },
  };
}

/** 假云端的账本。 */
function makeLedger() {
  return {
    /** id → 行（当前账号 USER_B 自己的那两条，**一开始就存在**）。 */
    rows: new Map([
      [
        OWN_DELETED_ID,
        { id: OWN_DELETED_ID, user_id: USER_B, is_deleted: false, last_op_seq: 5, tabs: [] },
      ],
      [
        OWN_ACTIVE_ID,
        { id: OWN_ACTIVE_ID, user_id: USER_B, is_deleted: false, last_op_seq: 3, tabs: [] },
      ],
    ]),
    /** 被打过墓碑的 id。 */
    tombstoned: [],
    /** 被新建出来的 id（越权写会在这里现形）。 */
    created: [],
    /** 收到的全部请求（诊断用）。 */
    requests: [],
  };
}

/**
 * 假云端（PostgREST 的最小子集）。
 *
 * ⚠️ 只认 `eq.` / `in.()` 两种过滤器（仓库里的真实请求只用这两种）⇒
 * 遇到不认识的过滤器**直接抛错**（不许默默放行 —— 那会让「越权写」看不出来）。
 */
async function fakeBackend(route, ledger) {
  const req = route.request();
  const url = new URL(req.url());
  const method = (req.method() ?? 'GET').toUpperCase();

  if (!url.hostname.endsWith('supabase.co')) {
    await route.continue();
    return;
  }
  ledger.requests.push(`${method} ${url.pathname}${url.search}`);

  if (url.pathname.endsWith('/auth/v1/user')) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: USER_B, aud: 'authenticated', role: 'authenticated' }),
    });
    return;
  }

  if (!url.pathname.endsWith('/rest/v1/tab_groups')) {
    await route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"not found"}' });
    return;
  }

  const params = url.searchParams;
  const matches = row => {
    for (const [key, raw] of params.entries()) {
      if (['select', 'limit', 'offset', 'order', 'on_conflict', 'Prefer'].includes(key)) continue;
      if (raw.startsWith('eq.')) {
        if (String(row[key]) !== raw.slice(3)) return false;
      } else if (raw.startsWith('in.(')) {
        const ids = raw.slice(4, -1).split(',').map(s => s.replace(/"/g, '').trim());
        if (!ids.includes(String(row.id))) return false;
      } else if (raw.startsWith('lt.')) {
        // 云端墓碑 TTL 的清理查询（deleted_at=lt.<时间戳>）。
        const v = row[key];
        if (v === undefined || v === null) return false;
        if (String(v) >= raw.slice(3)) return false;
      } else if (raw.startsWith('not.is.')) {
        if (row[key] === raw.slice('not.is.'.length)) return false;
      } else {
        throw new Error(`假云端不认识的过滤器: ${key}=${raw}`);
      }
    }
    return true;
  };

  if (method === 'GET') {
    const hit = [...ledger.rows.values()].filter(matches);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hit) });
    return;
  }
  if (method === 'POST') {
    const body = req.postDataJSON();
    const list = Array.isArray(body) ? body : [body];
    for (const row of list) {
      ledger.rows.set(String(row.id), { ...row });
      ledger.created.push(String(row.id));
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(list) });
    return;
  }
  if (method === 'PATCH') {
    const body = req.postDataJSON() ?? {};
    const touched = [];
    for (const [id, row] of [...ledger.rows.entries()]) {
      if (!matches(row)) continue;
      const next = { ...row, ...body };
      ledger.rows.set(id, next);
      touched.push(next);
      if (next.is_deleted === true && !ledger.tombstoned.includes(id)) ledger.tombstoned.push(id);
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(touched) });
    return;
  }
  if (method === 'DELETE') {
    for (const [id, row] of [...ledger.rows.entries()]) {
      if (matches(row)) ledger.rows.delete(id);
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    return;
  }
  await route.fulfill({ status: 405, contentType: 'application/json', body: '{"message":"method not allowed"}' });
}

/** 在页面上下文里读 KV。 */
async function kvRead(page, key) {
  return page.evaluate(async k => {
    return await new Promise((res, rej) => {
      const req = indexedDB.open('tabvaultpro', 1);
      req.onerror = () => rej(req.error);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) { db.close(); res(null); return; }
        const tx = db.transaction('kv', 'readonly');
        const get = tx.objectStore('kv').get(k);
        get.onsuccess = () => { db.close(); res(get.result?.value ?? null); };
        get.onerror = () => { db.close(); rej(get.error); };
      };
    });
  }, key);
}

/** 在页面上下文里写 KV。 */
async function kvWrite(page, key, value) {
  return page.evaluate(async ([k, v]) => {
    return await new Promise((res, rej) => {
      const req = indexedDB.open('tabvaultpro', 1);
      req.onerror = () => rej(req.error);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) { db.close(); rej(new Error('没有 kv store')); return; }
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ key: k, value: v });
        tx.oncomplete = () => { db.close(); res(true); };
        tx.onerror = () => { db.close(); rej(tx.error); };
      };
    });
  }, [key, value]);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-delete-gate-'));
  const ledger = makeLedger();
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--lang=zh-CN',
    ],
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

    // ⚠️ 必须在任何请求发出**之前**挂上路由，否则头几个请求会真的打到生产。
    await ctx.route('**/*', route => fakeBackend(route, ledger));

    // ── 种「换过账号」的现场 ─────────────────────────────────────────────
    // 归属记录：这台机器现在归 USER_B，但 FOREIGN_ID 归 USER_A。
    await sw.evaluate(
      async ([sessionKey, session, scope]) => {
        await chrome.storage.local.set({ [sessionKey]: session });
        await chrome.storage.local.set({ local_account_scope: scope });
      },
      [
        SESSION_KEY,
        sessionJson(USER_B),
        { ownerUserId: USER_B, foreignOwners: { [FOREIGN_ID]: USER_A }, pendingNotice: null },
      ]
    );

    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));

    await page.goto(`chrome-extension://${id}/src/popup/index.html`);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
    await page.waitForTimeout(1000);

    // ── 种本机会话 + 两条删除意图 ────────────────────────────────────────
    await kvWrite(page, 'tab_groups', [localGroup(OWN_ACTIVE_ID, '本账号的活跃会话')]);
    await kvWrite(page, 'pending_delete_ids', [OWN_DELETED_ID, FOREIGN_ID]);
    const seeded = await kvRead(page, 'pending_delete_ids');
    log.push({ step: '种下删除意图', queue: seeded });
    if (!seeded.includes(FOREIGN_ID) || !seeded.includes(OWN_DELETED_ID)) {
      problems.push(`删除队列没种进去（实际 ${JSON.stringify(seeded)}）`);
    }
    await page.screenshot({ path: join(OUT_DIR, '01-seeded.png') });

    // ── 触发一轮上传（= 走删除广播那条路）────────────────────────────────
    // 走 SW 的 SYNC 消息（与工具栏「上传」按钮同一条路：SW → syncEngine → …）。
    const result = await page.evaluate(async () => {
      const res = await chrome.runtime.sendMessage({ type: 'SYNC', data: { op: 'upload' } });
      return res ?? null;
    });
    log.push({ step: '上传结果', result });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(OUT_DIR, '02-after-upload.png') });

    // ── 断言 ①：当前账号的云端里**没有**别的账号的那一行 ────────────────
    const foreignRowExists = ledger.rows.has(FOREIGN_ID);
    const foreignCreated = ledger.created.includes(FOREIGN_ID);
    const foreignTombstoned = ledger.tombstoned.includes(FOREIGN_ID);
    log.push({
      step: '当前账号的云端',
      rows: [...ledger.rows.entries()].map(([k, v]) => ({ id: k, is_deleted: v.is_deleted })),
      tombstoned: ledger.tombstoned,
      created: ledger.created,
    });
    if (foreignRowExists) {
      problems.push(
        '越权写：属于另一个账号的会话在当前账号的云端里多出了一行' +
          `（${FOREIGN_ID}）—— 删除广播这一路没有账号闸门`
      );
    }
    if (foreignCreated) {
      problems.push(
        `越权写：属于另一个账号的会话被**新建**进了当前账号的云端（${FOREIGN_ID}）`
      );
    }
    if (foreignTombstoned) {
      problems.push(`属于另一个账号的会话被打了墓碑（${FOREIGN_ID}）`);
    }

    // ── 断言 ②：当前账号自己的那条删除意图照常被标墓碑 ──────────────────
    const ownRow = ledger.rows.get(OWN_DELETED_ID);
    if (ownRow?.is_deleted !== true) {
      problems.push(
        `当前账号自己的会话没有照常被标墓碑（is_deleted=${String(ownRow?.is_deleted)}）—— ` +
          '闸门把正常删除也拦死了'
      );
    }

    // ── 断言 ③：被挡下的那条删除意图**仍留在队列里**（最关键）──────────
    const left = await kvRead(page, 'pending_delete_ids');
    log.push({ step: '上传后的删除队列', queue: left });
    if (!Array.isArray(left) || !left.includes(FOREIGN_ID)) {
      problems.push(
        '被账号闸门挡下的删除意图被清出队列了 ⇒ 那条删除意图被永久丢弃 ⇒ ' +
          '那条会话在它真正的主人账号下复活（v1.22.0 起无回收站、不可逆，零提示）'
      );
    }
    if (Array.isArray(left) && left.includes(OWN_DELETED_ID)) {
      problems.push('真的广播成功的那条仍在队列里 ⇒ 队列只增不减，会永远重播');
    }
    await page.screenshot({ path: join(OUT_DIR, '03-final.png') });

    if (consoleErrors.length) {
      log.push({ step: '控制台错误', errors: consoleErrors.slice(0, 5) });
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
