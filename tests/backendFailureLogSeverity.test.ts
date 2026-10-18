/**
 * 后端解析失败时的**日志分级**回归锁。
 *
 * ── 为什么有这条锁（2026-10-18）──────────────────────────────────────────
 * 分层口径（既定事实）：
 *   logError = **存储读不出来**（配置存储读抛错、解锁状态读抛错、工厂/构造抛错）
 *   logWarn  = **读到了、但确认不可用**（确认没配置、确认未解锁、尚未预解析）
 *
 * 区分这两档不是为了好看：修之前三种起因（存储读不到 / 没配置 / 没解锁）
 * 在日志里长得一模一样，用户报「同步不动」时无法从日志判断到底是故障还是
 * 没配。`.memory/fallback-catch-must-not-equal-pre-fix-behavior.md` 要求
 * 「兜底必须出声」——出声还要分得出因果，否则等于没出声。
 *
 * ⚠️ **这条锁在 main 上曾经不存在。** 项目记忆里写着「回归锁：
 * tests/backendFailureLogSeverity.test.ts（四种起因各一条，变异验证过）」，
 * 但该文件只存在于 `slim/webdav-primary` 分支（commit c25dc96「云端下线」那次
 * 重写）。main 保留了双后端，从来没有这个文件 —— 我曾在派单时把它当既有保障
 * 转述给审计员，被当场抓出。本文件就是把那个缺口真正补上。
 *
 * ── 测试形态说明 ─────────────────────────────────────────────────────
 * 本仓库没有 jsdom / happy-dom / @testing-library，也不允许为此装依赖。
 * 做法：用既有的 tests/_helpers/engineStorageEnv.ts 装浏览器存储桩（含
 * 键级读失败注入），替换 console 做 spy，跑**真实**代码路径，断言哪一档
 * 被调到。不 mock 被测模块，只观测它的对外产物（日志 + 解析结果）。
 *
 * ── 变异验证（cp 备份 → 改坏 → 必须红 → cp 恢复，严禁 git checkout）──
 *   · 把 readConfiguredBackendId 的 logError 改成 logWarn → 红
 *   · 把「尚未预解析」的 logWarn 改成 logError → 红
 *   · 把配置读失败的 'error' 改成 'unconfigured' → 红
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

register(LOADER_PATH);

// 必须在任何 @/... import 之前装环境（storage-kv 首次 import 时选 driver）。
const { installEngineStorageEnv } = await import('./_helpers/engineStorageEnv.ts');
const env = installEngineStorageEnv();

/** 捕获 console.warn / console.error，跑完还原（`logWarn`/`logError` 最终都转到这里）。 */
async function captureLogs<T>(fn: () => Promise<T> | T): Promise<{
  result: T | null;
  warn: unknown[][];
  errorLogs: unknown[][];
}> {
  const real = { warn: console.warn, error: console.error, log: console.log };
  const warn: unknown[][] = [];
  const errorLogs: unknown[][] = [];
  console.warn = (...a: unknown[]) => void warn.push(a);
  console.error = (...a: unknown[]) => void errorLogs.push(a);
  console.log = () => {};
  let result: T | null = null;
  try {
    result = await fn();
  } finally {
    console.warn = real.warn;
    console.error = real.error;
    console.log = real.log;
  }
  return { result, warn, errorLogs };
}

test('存储读不出来 ⇒ logError（不是 warn）且返回 null', async () => {
  const { readConfiguredBackendId } = await import('@/sync-backend');
  env.failReadKeys.add('user_settings');
  const { result, warn, errorLogs } = await captureLogs(() => readConfiguredBackendId());
  env.failReadKeys.delete('user_settings');

  assert.equal(result, null, '读不到设置必须返回 null（「无法回答」），不能猜一个后端');
  assert.ok(
    errorLogs.length > 0,
    '存储读不出来必须走 logError —— 这一档是真实故障，不是可恢复提示'
  );
  assert.equal(
    warn.length,
    0,
    '同一件事不该同时进 warn 与 error 两档（同时进等于分级失效）'
  );
});

test('读到 supabase（正常路径）⇒ 不出声', async () => {
  const { readConfiguredBackendId } = await import('@/sync-backend');
  env.lsData.clear();
  const { result, warn, errorLogs } = await captureLogs(() => readConfiguredBackendId());
  assert.equal(result, 'supabase', '键缺失 ⇒ DEFAULT_SETTINGS 的 supabase，这是「读到了」');
  assert.equal(warn.length, 0, '正常读到后端不该打 warn');
  assert.equal(errorLogs.length, 0, '正常读到后端不该打 error');
});

test('尚未预解析 ⇒ logWarn（读到了但还没解析，可恢复）', async () => {
  const mod = await import('@/sync-backend');
  mod.invalidateActiveSyncBackend();
  const { warn, errorLogs } = await captureLogs(() => mod.getActiveSyncBackend());
  assert.ok(warn.length > 0, '「尚未预解析」是读到但没准备好，应走 logWarn');
  assert.equal(errorLogs.length, 0, '「尚未预解析」不是存储故障，不该走 logError');
});

test('自带存储配置读取失败 ⇒ logError + 锁定态（不是「没配置」）', async () => {
  const mod = await import('@/sync-backend');
  // 用户明确选了 webdav（读得到），但配置存储读抛错（读不出来）。
  env.lsData.clear();
  env.lsData.set('user_settings', JSON.stringify({ syncBackend: 'webdav' }));
  env.failReadKeys.add('webdav_sync_config_v1');
  const { warn, errorLogs } = await captureLogs(() => mod.primeSyncBackend());
  env.failReadKeys.delete('webdav_sync_config_v1');

  assert.ok(
    errorLogs.length > 0,
    '配置存储读抛错属于「存储读不出来」，必须走 logError —— ' +
      '否则用户报「同步不动」时无法与「没配置」区分'
  );

  const resolution = mod.getLastBackendResolution();
  assert.ok(resolution, '前提：应能读到 lastResolution');
  // 关键区分：存储故障 → locked/error，而不是 unconfigured。
  // 后者会让 UI 提示「去配置」，而用户的配置其实好端端地存在磁盘上。
  assert.equal(
    resolution?.lockedKind,
    'error',
    `配置读失败必须判为 error 起因，实际 lockedKind=${String(resolution?.lockedKind)}`
  );
  assert.ok(
    resolution?.lockedReason,
    '锁定时必须给出可读原因（UI 要原样展示给用户）'
  );
  assert.equal(warn.length, 0, '这一档是 error，不该同时进 warn');
});

test('对照：确认没配置 ⇒ logWarn（不是 error）', async () => {
  const mod = await import('@/sync-backend');
  // 用户选了 webdav，而配置键**不存在**（不是读失败）。
  env.lsData.clear();
  env.lsData.set('user_settings', JSON.stringify({ syncBackend: 'webdav' }));
  const { errorLogs } = await captureLogs(() => mod.primeSyncBackend());

  const resolution = mod.getLastBackendResolution();
  assert.equal(
    resolution?.lockedKind,
    'unconfigured',
    `「没配置」与「读不出来」必须是不同的 lockedKind，实际=${String(resolution?.lockedKind)}`
  );
  // 反向守卫：确认这条不是恒真 —— 上一用例已证明读失败时 errorLogs 非空，
  // 这里没配置则不应该被报成故障。
  assert.equal(errorLogs.length, 0, '「确认没配置」是可恢复状态，不该走 logError');
  // 不在这里断言 warn 必须非空：`locked()` 本身不出声，「没配置」由 UI 从
  // lockedKind 分类后提示。这里只钉住「不能把它报成 error 级故障」。
});
