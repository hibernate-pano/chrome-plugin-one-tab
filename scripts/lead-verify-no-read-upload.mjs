// 真机验证：读设置**不该**排上传（2026-10-22 审计 P0）。
//
// ── 为什么必须真机 ─────────────────────────────────────────────────────
//
// 这一条在单测里是绿的也算数（守卫确实钉住了判据），但真机才答得上
// 「用户真的打开管理器页时，SW 到底排没排上传」——
// 单测看不见 SW 收到消息后发生的事，也看不见 alarm 与 pending_upload 标志。
//
// 同仓教训：memory「假服务器的自证式盲区」「截图/探针要断言目标状态」。
// 所以本脚本**不打印 ✅ 了事**：它断言两个**目标状态**，并且带一个
// **正向对照**（改设置 ⇒ 必须排上传）—— 没有正向对照的探针，
// 「什么都没发生」和「探针瞎了」长得一模一样。
//
// 产出：outputs/lead-verify-no-read-upload/*.png + report.json。
//
// 用法：pnpm build 之后 node scripts/lead-verify-no-read-upload.mjs

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/lead-verify-no-read-upload');

/** syncEngine 排上传时建的兜底 alarm 名（scheduleUpload → chrome.alarms.create）。 */
const UPLOAD_ALARM = 'tapstack-scheduled-upload';
/** storage 层的「本地有未上传变更」标志键（storage-kv/keys.ts）。 */
const PENDING_UPLOAD_KEY = 'pending_upload';

/** SW 里现存的 alarm 名。 */
async function alarmNames(sw) {
  return await sw.evaluate(async () => {
    const alarms = await chrome.alarms.getAll();
    return alarms.map(a => a.name);
  });
}

/**
 * SW 存储里的 pending_upload 标志（跨 SW 重启仍在，所以它是「排过上传」的
 * 持久痕迹，不是瞬时状态 —— 拿它当判据比拿 timer 可靠）。
 */
async function pendingUploadFlag(sw) {
  return await sw.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('tabvaultpro', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('indexedDB open blocked'));
    });
    try {
      if (!db.objectStoreNames.contains('kv')) return null;
      const row = await new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readonly');
        const getReq = tx.objectStore('kv').get('pending_upload');
        getReq.onsuccess = () => resolve(getReq.result);
        getReq.onerror = () => reject(getReq.error);
      });
      return row ? row.value : null;
    } finally {
      db.close();
    }
  });
}

/** 一次「有没有排过上传」的完整快照。 */
async function snapshot(sw) {
  const names = await alarmNames(sw);
  return {
    alarms: names,
    hasUploadAlarm: names.includes(UPLOAD_ALARM),
    pendingUpload: await pendingUploadFlag(sw),
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-noread-'));
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

    // ── 0. 基线：扩展刚起来时不该有任何上传意图 ──────────────────────────
    const baseline = await snapshot(sw);
    log.push({ step: '基线（扩展刚起来）', ...baseline });
    if (baseline.hasUploadAlarm || baseline.pendingUpload === true) {
      problems.push('基线就不干净：还没做任何操作就已经有上传意图了，探针的判据不可信');
    }

    // ── 1. 打开管理器页（这一步会读设置）⇒ 不该排上传 ────────────────────
    const manager = await ctx.newPage();
    const managerErrors = [];
    manager.on('pageerror', e => managerErrors.push(`pageerror: ${e.message}`));
    await manager.goto(`chrome-extension://${id}/src/popup/index.html`);
    const skip = manager.locator('button[aria-label="跳过引导"]');
    await skip
      .waitFor({ state: 'visible', timeout: 8000 })
      .then(() => skip.click())
      .catch(() => {});
    // 等过 loadSettings 的 pending/fulfilled 都落地（IndexedDB 冷读可能慢）
    await manager.waitForTimeout(2500);
    await manager.screenshot({ path: join(OUT_DIR, '01-manager-page.png') });
    const afterRead = await snapshot(sw);
    log.push({ step: '打开管理器页（读设置）', ...afterRead });
    if (afterRead.hasUploadAlarm) {
      problems.push(
        '打开管理器页就排了一次上传 —— 读设置被当成了「设置变了」' +
          `（alarm ${UPLOAD_ALARM} 已存在）`
      );
    }
    if (afterRead.pendingUpload === true) {
      problems.push(
        '打开管理器页就置位了 pending_upload —— 读设置被当成了「设置变了」' +
          '（本地出现了「有未上传变更」的事实）'
      );
    }
    if (managerErrors.length) {
      problems.push(`管理器页报错 ${managerErrors.length} 条：${managerErrors.slice(0, 2).join(' | ')}`);
    }

    // ── 2. 改一个设置 ⇒ **必须**排上传（正向对照）─────────────────────────
    // 没有这一步，步骤 1 的「什么都没发生」和「探针瞎了」分不开。
    const options = await ctx.newPage();
    const optionsErrors = [];
    options.on('pageerror', e => optionsErrors.push(`pageerror: ${e.message}`));
    await options.goto(`chrome-extension://${id}/src/options/index.html`);
    const faviconToggle = options.locator('button[role="switch"][aria-label="显示网站图标"]');
    await faviconToggle.waitFor({ state: 'visible', timeout: 15000 });
    await faviconToggle.click();
    // 等 3 秒去抖窗口之前就看：alarm 是同步建的，pending_upload 是异步写的
    await options.waitForTimeout(1200);
    await options.screenshot({ path: join(OUT_DIR, '02-options-toggled.png') });
    const afterChange = await snapshot(sw);
    log.push({ step: '改设置（显示网站图标）', ...afterChange });
    if (!afterChange.hasUploadAlarm && afterChange.pendingUpload !== true) {
      problems.push(
        '改了设置却**没有**排上传 —— 探针的正向对照失败：' +
          '这一版探针分辨不出「排了」与「没排」，步骤 1 的结论不可信'
      );
    }
    if (optionsErrors.length) {
      problems.push(`设置页报错 ${optionsErrors.length} 条：${optionsErrors.slice(0, 2).join(' | ')}`);
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
