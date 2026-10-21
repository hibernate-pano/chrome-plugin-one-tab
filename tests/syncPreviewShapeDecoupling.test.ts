// 内容指纹必须与「两条后端解出来的形状差异」脱钩（2026-10-20 审计 A-10 续）。
//
// ── 缺陷形态（修复前）─────────────────────────────────────────────────────
// `src/utils/syncPreview.ts` 的内容指纹里含 `version`：
//   · Supabase 侧解出来的会话**带** `version`（`download.ts` 回读数据库列）
//   · WebDAV 侧解出来的会话**不带**（文件后端给不出这个概念 —— `layout.ts`
//     的 `encodeGroup`/`decodeGroup` 里 `version` 出现 0 次）
// 同一个会话、两条后端 ⇒ 指纹必然不等 ⇒ 覆盖预览报「将更新」，
// 而**实际内容一个字节都没变**。用户据此做的覆盖决策建立在假信息上。
//
// 同一类病还有第二个实例：**时间戳的写法**。
//   · 本地 `updatedAt` 来自 `new Date().toISOString()` ⇒ `…T10:00:00.000Z`
//   · 云端 `updated_at` 是 Postgres 的 `timestamptz`
//     ⇒ PostgREST 回读是 `…T10:00:00+00:00`（老 `tabs` 表回填甚至是
//     `2026-10-20 10:00:00+00` 文本格式）
// 三个字符串是**同一个时刻**，按字符串比就不相等 ⇒ 同样误报「将更新」。
//
// ── 本文件钉的是**行为**，不是字面量 ───────────────────────────────────
//   ① 同一个组、两条后端口径 ⇒ 指纹相等 ⇒ 预览 `updates=0` / `unchanged=1`
//   ② 同一时刻的两种写法 ⇒ 同样判「未变化」
//   ③ 真改名 / 真改标签 ⇒ 仍然必须报「将更新」（不许把真变化一起吃掉）
//
// 「指纹里不许出现 version 这个键」是**字面量**断言：它会因为别人加一句
// 解释性注释而变红，也因为有人把字段换个名字复活而失效。
// 这里钉的是**可判定的事实**：同一份内容在两种口径下必须判为「没变」。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDownloadPreviewSummary,
  buildUploadPreviewSummary,
  getComparableFingerprint,
} from '@/utils/syncPreview';
import { decodeGroup, encodeGroup } from '@/sync-backend/webdav/layout';
import {
  backendOnlyKeys,
  supabaseDecodedGroupKeys,
  SUPABASE_ONLY_NEUTRAL_VALUES,
  webdavDecodedGroupKeys,
} from './_helpers/backendShapes.ts';
import type { Tab, TabGroup } from '@/types/tab';

const OLD = '2026-10-19T10:00:00.000Z';

const mkTab = (id: string, over: Partial<Tab> = {}): Tab => ({
  id,
  url: `https://example.com/${id}`,
  title: id,
  createdAt: OLD,
  lastAccessed: OLD,
  pinned: false,
  ...over,
});

const mkGroup = (id: string, over: Partial<TabGroup> = {}): TabGroup => ({
  id,
  name: `会话-${id}`,
  tabs: [mkTab(`${id}-t1`)],
  createdAt: OLD,
  updatedAt: OLD,
  isLocked: false,
  version: 1,
  ...over,
});

/** WebDAV 口径：真的跑一遍 `encodeGroup` → `decodeGroup`。 */
const webdavDialect = (group: TabGroup): TabGroup => {
  const back = decodeGroup(encodeGroup(group));
  assert.ok(back, 'WebDAV 侧必须能解出这条会话');
  return back;
};

/**
 * Supabase 口径：**同一个组**加上「只有 Supabase 侧会解出来」的那些键。
 *
 * 那份清单是**从生产源码派生**的（`supabaseDecodedGroupKeys`），
 * 不是手写的 —— 生产代码改了会话形状，这张表就盖不住了，
 * 测试当场变红（而不是默默少覆盖一个键）。
 */
const supabaseDialect = (group: TabGroup): TabGroup => {
  const derived = backendOnlyKeys(
    supabaseDecodedGroupKeys(),
    webdavDecodedGroupKeys(group)
  );
  const neutral = SUPABASE_ONLY_NEUTRAL_VALUES;
  assert.deepEqual(
    Object.keys(neutral).sort(),
    derived,
    'Supabase 口径的样本必须盖住派生出来的全部「只有一边有」的键 —— ' +
      '生产代码改了会话形状，样本要跟着改（值也要一起改）'
  );
  return { ...group, ...neutral } as TabGroup;
};

// ════════════════════════════════════════════════════════════════════════
// ① 同一个组、两条后端口径 ⇒ 必须判「没变」
// ════════════════════════════════════════════════════════════════════════

describe('内容指纹与两条后端的形状差异脱钩', () => {
  it('同一个组：Supabase 口径 vs WebDAV 口径 ⇒ 指纹相等', () => {
    const webdav = webdavDialect(mkGroup('g1'));
    const supabase = supabaseDialect(webdav);

    // 前提：这确实是一份「形状不同」的数据（否则下面的相等毫无意义）。
    assert.notDeepEqual(
      Object.keys(supabase).sort(),
      Object.keys(webdav).sort(),
      '样本必须真的存在形状差异，否则这条断言是空转'
    );

    assert.equal(
      getComparableFingerprint(supabase),
      getComparableFingerprint(webdav),
      '同一份内容在两种后端口径下必须得到同一个指纹'
    );
  });

  it('同一个组：Supabase 口径 vs WebDAV 口径 ⇒ 覆盖预览判「未变化」', () => {
    const webdav = webdavDialect(mkGroup('g1'));
    const supabase = supabaseDialect(webdav);

    const summary = buildUploadPreviewSummary([supabase], [webdav], 'overwrite');

    assert.equal(summary.updates, 0, '没变过的会话不得被报成「将更新」');
    assert.equal(summary.unchanged, 1, '没变过的会话必须判为 unchanged');
    assert.deepEqual(summary.updatedNames, [], '不得凭空点出一个「将更新」的会话');
  });

  it('同一个组：本地带版本号、云端（WebDAV）没有版本号 ⇒ 仍然判「未变化」', () => {
    // 缺陷形态的直接复现：本地会话带 `version`（本机计数器），
    // 云端是 WebDAV 分片（根本没有这个键）⇒ 修复前指纹必然不等。
    const local = mkGroup('g1', { version: 7 });
    const remote = webdavDialect(mkGroup('g1'));

    const summary = buildUploadPreviewSummary([local], [remote], 'overwrite');

    assert.equal(summary.updates, 0, '版本号不同 ≠ 内容变了');
    assert.equal(summary.unchanged, 1, '版本号不同 ≠ 内容变了');
  });

  it('同一个组：两边都带版本号但数值不同 ⇒ 仍然判「未变化」', () => {
    // 换设备后本地计数器与云端计数器本来就不可比（`version` 是每台设备
    // 各自的本地计数），所以数值不同也不等于内容变了。
    const local = mkGroup('g1', { version: 1 });
    const remote = mkGroup('g1', { version: 99 });

    const summary = buildUploadPreviewSummary([local], [remote], 'overwrite');

    assert.equal(summary.updates, 0, '版本号不可比，不得当成内容变化');
    assert.equal(summary.unchanged, 1, '版本号不可比，不得当成内容变化');
  });

  it('下载合并：云端靠印记赢了但内容一模一样 ⇒ 判「未变化」', () => {
    // 合并胜负由 op-stamp 全序决定（`core/opStamp.ts` 的 `compareStamps`），
    // 赢家的 `version` 可能与本地不同 —— 但内容没变 ⇒ 预览不该说「将更新」。
    const local = mkGroup('g1', { version: 1, lastOp: { d: 'dev-a', s: 1 } });
    const remote = mkGroup('g1', { version: 9, lastOp: { d: 'dev-b', s: 5 } });

    const summary = buildDownloadPreviewSummary([local], [remote], 'merge');

    assert.equal(summary.updates, 0, '内容没变就不该报「将更新」');
    assert.equal(summary.unchanged, 1, '内容没变就必须判为 unchanged');
  });
});

// ════════════════════════════════════════════════════════════════════════
// ② 同一时刻的两种写法 ⇒ 同样判「未变化」
// ════════════════════════════════════════════════════════════════════════

describe('时间戳的写法差异不得被当成内容变化', () => {
  it('JS ISO 写法 vs Postgres timestamptz 写法（同一时刻）⇒ 判「未变化」', () => {
    const local = mkGroup('g1', { updatedAt: '2026-10-20T10:00:00.000Z' });
    const remote = mkGroup('g1', { updatedAt: '2026-10-20T10:00:00+00:00' });

    assert.equal(
      getComparableFingerprint(local),
      getComparableFingerprint(remote),
      '同一个时刻的两种写法必须得到同一个指纹'
    );

    const summary = buildUploadPreviewSummary([local], [remote], 'overwrite');
    assert.equal(summary.updates, 0, '写法差异不得被报成「将更新」');
    assert.equal(summary.unchanged, 1, '写法差异不得被报成「将更新」');
  });

  it('Postgres 文本格式（老 tabs 表回填路径）⇒ 同样判「未变化」', () => {
    const local = mkGroup('g1', { updatedAt: '2026-10-20T10:00:00.000Z' });
    const remote = mkGroup('g1', { updatedAt: '2026-10-20 10:00:00+00' });

    assert.equal(
      getComparableFingerprint(local),
      getComparableFingerprint(remote),
      'Postgres 文本格式与 JS ISO 是同一时刻'
    );
  });

  it('真正不同的时刻（哪怕只差 1 毫秒）⇒ 必须判为「将更新」', () => {
    const local = mkGroup('g1', { updatedAt: '2026-10-20T10:00:00.000Z' });
    const remote = mkGroup('g1', { updatedAt: '2026-10-20T10:00:00.001Z' });

    const summary = buildUploadPreviewSummary([local], [remote], 'overwrite');
    assert.equal(summary.updates, 1, '时刻不同就是内容变了，不能被吃掉');
    assert.equal(summary.unchanged, 0, '时刻不同就是内容变了，不能被吃掉');
  });
});

// ════════════════════════════════════════════════════════════════════════
// ③ 真变化必须仍然被检出（不许把真变化一起吃掉）
// ════════════════════════════════════════════════════════════════════════

describe('真实的内容变化仍然必须被检出', () => {
  it('改了名字 ⇒ 报「将更新」', () => {
    const local = mkGroup('g1', { name: '改过的名字' });
    const remote = webdavDialect(mkGroup('g1'));

    const summary = buildUploadPreviewSummary([local], [remote], 'overwrite');
    assert.equal(summary.updates, 1, '真改名必须被检出');
    assert.equal(summary.unchanged, 0, '真改名必须被检出');
    assert.deepEqual(summary.updatedNames, ['改过的名字']);
  });

  it('改了标签的 URL ⇒ 报「将更新」', () => {
    const local = mkGroup('g1', { tabs: [mkTab('g1-t1', { url: 'https://example.com/别的' })] });
    const remote = webdavDialect(mkGroup('g1'));

    const summary = buildUploadPreviewSummary([local], [remote], 'overwrite');
    assert.equal(summary.updates, 1, '真改标签必须被检出');
    assert.equal(summary.unchanged, 0, '真改标签必须被检出');
  });

  it('加了一个标签 ⇒ 报「将更新」', () => {
    const local = mkGroup('g1', { tabs: [mkTab('g1-t1'), mkTab('g1-t2')] });
    const remote = webdavDialect(mkGroup('g1'));

    const summary = buildUploadPreviewSummary([local], [remote], 'overwrite');
    assert.equal(summary.updates, 1, '标签数量变化必须被检出');
    assert.equal(summary.unchanged, 0, '标签数量变化必须被检出');
  });

  it('改了标签标题 ⇒ 报「将更新」', () => {
    const local = mkGroup('g1', { tabs: [mkTab('g1-t1', { title: '新标题' })] });
    const remote = webdavDialect(mkGroup('g1'));

    const summary = buildUploadPreviewSummary([local], [remote], 'overwrite');
    assert.equal(summary.updates, 1, '标题变化必须被检出');
    assert.equal(summary.unchanged, 0, '标题变化必须被检出');
  });

  it('锁了会话（isLocked）⇒ 报「将更新」', () => {
    const local = mkGroup('g1', { isLocked: true });
    const remote = webdavDialect(mkGroup('g1'));

    const summary = buildUploadPreviewSummary([local], [remote], 'overwrite');
    assert.equal(summary.updates, 1, '锁定状态变化必须被检出');
    assert.equal(summary.unchanged, 0, '锁定状态变化必须被检出');
  });
});
