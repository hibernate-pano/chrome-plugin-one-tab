/**
 * 账号闸门与上传对账的接缝（2026-10-22 DS-1 收口）。
 *
 * ── 这条接缝上出过什么问题 ──────────────────────────────────────────────
 * 账号闸门（`utils/supabase/upload.ts`）把「属于别的账号」的会话挡在上行
 * 集合之外 —— 硬底线，挡住了跨账号泄露。但**上游的对账**不知道这件事：
 * `syncEngine` 把「本轮交给适配器的清单」当成「本轮真的提交了什么」，
 * 于是被挡下的那批被算成「已裁决」：
 *   ① 用户看不到「还有 N 个会话没同步」；
 *   ② 「本轮是全量」被误判成 true ⇒ 漏登记的那批改动被当成已补上
 *      ⇒ 可能永远补不回来。
 *
 * ── 这道守卫盯的三件事 ───────────────────────────────────────────────────
 * ① 纯函数层：属于别的账号的会话**不计入未同步**（它不是「没传上去」，
 *    是「不该传给这个账号」）—— 否则 pending_upload 永远清不掉、
 *    每轮重试一个注定失败的上传。
 * ② 结构层：syncEngine 真的把被挡下的 id 从「已提交」里剔出去了。
 * ③ 结构层：syncEngine 真的把被挡下的 id 传给了对账函数。
 *
 * 【为什么①②③都要】只做①（纯函数支持了）而接线没接上 ⇒ 判据成了摆设；
 * 只做②③（接线接了）而纯函数不支持 ⇒ TypeScript 直接报错。所以实际上
 * ②③被①约束着，但**接线**是最容易漏的那一环，必须单独钉住。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8');

const ENGINE = 'src/services/syncEngine.ts';
const ADAPTER = 'src/sync-backend/supabaseAdapter.ts';
const SERVICE = 'src/services/tabGroupSyncService.ts';
const SUPABASE_UPLOAD = 'src/utils/supabase/upload.ts';

test('对账：属于别的账号的会话不计入「未同步」', async () => {
  const { reconcileUploadCoverage } = await import('@/core/uploadCoverage');

  const coverage = reconcileUploadCoverage({
    registeredIds: ['mine-1', 'foreign-1'],
    submittedIds: ['mine-1'],
    uploadPerformed: true,
    // 闸门挡下的那批：它们没进上行集合，也不该算「没传上去」。
    notThisAccountIds: ['foreign-1'],
  });

  assert.equal(
    coverage.unsyncedCount,
    0,
    '属于别的账号的会话不是「没传上去」，不许算作未同步（否则 pending_upload 永远清不掉）'
  );
  assert.equal(coverage.canClearPending, true, '本账号的会话都传上去了 ⇒ 可以清 pending_upload');
  assert.equal(coverage.cannotConfirmAllSynced, false);
});

test('对账：不传 notThisAccountIds 时，被挡下的那批仍算未同步（不得偷偷放行）', async () => {
  const { reconcileUploadCoverage } = await import('@/core/uploadCoverage');

  const coverage = reconcileUploadCoverage({
    registeredIds: ['mine-1', 'foreign-1'],
    submittedIds: ['mine-1'],
    uploadPerformed: true,
  });

  assert.equal(
    coverage.unsyncedCount,
    1,
    '没告知「这批属于别的账号」时，必须按「没传上去」算（保守方向）'
  );
  assert.equal(coverage.canClearPending, false);
});

/**
 * 判据：`submittedGroupIds` 那一行**本身**有没有把被挡下的会话剔掉。
 *
 * ⚠️ 不能只判「文件里出现过 `blockedByAccountScope.has(`」—— 那个串在
 * 「本轮是不是全量」的判断里也有 ⇒ 接线漏了也照样命中 ⇒ 判据零检测力。
 * 这里只看**赋值语句那一段**。
 *
 * 做成纯函数（吃源码文本）⇒ 下面那条「自证检测力」可以直接喂它一段
 * 「接线被摘掉」的源码，断言它**看得见**这个破口 —— 比「改文件→跑→
 * 改回来」可靠，也不会在失败时留下半改的工作区。
 */
function detectsSubmittedFilter(source: string): boolean {
  const at = source.indexOf('submittedGroupIds =');
  if (at < 0) return false;
  const end = source.indexOf(';', at);
  const segment = source.slice(at, end < 0 ? undefined : end);
  return segment.includes('blockedByAccountScope');
}

test('接线：syncEngine 把被挡下的会话从「已提交」里剔出去', () => {
  const engine = read(ENGINE);
  assert.ok(
    /blockedAccountIds/.test(engine),
    `${ENGINE} 必须读上传结果里的 blockedAccountIds（被账号闸门挡下的那批）`
  );
  assert.ok(
    /blockedByAccountScope\.has\(/.test(engine),
    `${ENGINE} 必须用 blockedByAccountScope 把它们从「已提交」里过滤掉`
  );
});

test('接线：syncEngine 把被挡下的会话告诉对账函数', () => {
  const engine = read(ENGINE);
  assert.ok(
    /notThisAccountIds:/.test(engine),
    `${ENGINE} 必须把被挡下的会话传进对账函数（notThisAccountIds）—— 不传的话它们会被算成「未同步」`
  );
});

test('接线：被挡下的会话不参与「本轮是不是全量」的判断', () => {
  const engine = read(ENGINE);
  // 判据：算「全量」时那行必须把不属于当前账号的会话排除掉。
  assert.ok(
    /filter\(id => !blockedByAccountScope\.has\(id\)\)/.test(engine),
    `${ENGINE} 判「本轮覆盖了全部活跃会话」时必须排除不属于当前账号的会话` +
      '（否则这个缺口永远关不上 ⇒ pending_upload 永远清不掉）'
  );
});

test('接线：被挡下的 id 一路透传到 syncEngine（适配器与门面不许吞）', () => {
  assert.ok(
    /blockedAccountIds/.test(read(SUPABASE_UPLOAD)),
    `${SUPABASE_UPLOAD} 必须把闸门挡下的 id 放进返回值`
  );
  assert.ok(
    /blockedAccountIds/.test(read(ADAPTER)),
    `${ADAPTER} 必须把 blockedAccountIds 转发出去（不许在适配器这一层被吞掉）`
  );
  assert.ok(
    /blockedAccountIds/.test(read(SERVICE)),
    `${SERVICE} 必须把 blockedAccountIds 转发出去（不许在门面这一层被吞掉）`
  );
});

test('自证检测力：把「从已提交里剔出去」这一步去掉，守卫必须看得见', () => {
  const original = read(ENGINE);
  assert.equal(
    detectsSubmittedFilter(original),
    true,
    '前提没成立：当前源码里找不到这一步（判据需要更强的信号）'
  );

  // 破口：接线被摘掉（判据层都做完了、上游忘了剔 —— 就是本条缺陷的实况）
  const unwired = original.replace(
    /\.filter\(id => !blockedByAccountScope\.has\(id\)\)/,
    ''
  );
  assert.notEqual(unwired, original, '本用例前提没成立：源码里找不到可摘掉的那一步');
  assert.equal(
    detectsSubmittedFilter(unwired),
    false,
    '判据失效：接线被摘掉后仍应识别出「没剔」'
  );
});
