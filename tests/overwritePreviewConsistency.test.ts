// 覆盖上传的**预览必须与实际结果一致**（2026-10-20 P1）。
//
// ── 这个文件在防什么 ─────────────────────────────────────────────────────
//
// 覆盖上传现在会跳过「云端有、这台设备读不出来、而本机又没有副本」的那几组
// （删了就是永久丢失 —— 无回收站）。这件事对用户是**可见的**：云端并没有
// 被完全替换成他本机的样子。
//
// 于是预览必须说出这件事，否则出现两种撒谎：
//   · 卡片说「直接替换云端现状」（实际有几行留了下来）；
//   · 风险文案说「预计删除 N 个会话」（N 与实际删掉的数对不上）。
//
// 仓库的纪律是「预览与实际同源」：预览算「会保留几行」用的判据，必须与
// 执行侧算的是**同一个函数**（core/overwriteUploadGuard.ts 的
// planOverwriteUpload）—— 两边各写一份，就一定会漂。
//
// ── 本文件钉的是**不变量**，不是字面量 ─────────────────────────────────────
//
//   1. 预览说保留 N 个 ⇒ 执行侧的判据算出来也是 N 个（同源）；
//   2. 有保留行时，风险文案必须说出来（不能还只说「直接替换现状」）；
//   3. 没有保留行时，风险文案逐字不变（用户依赖的那句风险提示）；
//   4. 合并模式 / 自带存储（并集型后端）⇒ 保留数恒为 0。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUploadPreviewSummary } from '@/utils/syncPreview';
import { describeOverwriteRisk } from '@/components/sync/syncPreviewView';
import { planOverwriteUpload } from '@/core/overwriteUploadGuard';
import type { Tab, TabGroup } from '@/types/tab';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');
const SYNC_BUTTON = 'src/components/sync/SyncButton.tsx';
// 2026-10-23（第 51 轮）：「读真值 + 读云端 + 算摘要」从组件搬进了
// services/syncPreviewLoader.ts —— 搬出来是为了让守卫能**真的调用**它
// （留在组件里时只能对着源码长相断言，而源码长相证明不了「清单真进了预览」）。
// 行为级的同源验证见 tests/guards/overwriteDownloadPreviewMatchesActual.test.ts。
const PREVIEW_LOADER = 'src/services/syncPreviewLoader.ts';

const mkTab = (id: string): Tab =>
  ({
    id,
    url: `https://example.com/${id}`,
    title: id,
    createdAt: '2026-10-20T00:00:00.000Z',
    lastAccessed: '2026-10-20T00:00:00.000Z',
  }) as Tab;

const mkGroup = (id: string, name: string): TabGroup =>
  ({
    id,
    name,
    tabs: [mkTab(id)],
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
  }) as TabGroup;

// 本机：两个会话。
const LOCAL = [mkGroup('local-1', '本机甲'), mkGroup('local-2', '本机乙')];
// 云端读得到：一个会话。
const READABLE = [mkGroup('remote-1', '云端甲')];
// 云端读不出来的两个（另一台设备写的，本机解不开）。
const UNREADABLE_IDS = ['remote-2', 'remote-3'];

describe('覆盖上传预览：保留数与执行侧同源', () => {
  it('预览算出的保留数 == 执行侧判据算出的保留数', () => {
    const summary = buildUploadPreviewSummary(LOCAL, READABLE, 'overwrite', {
      unrestorableRemoteIds: UNREADABLE_IDS,
    });
    const expected = planOverwriteUpload({
      cloudIds: [...READABLE.map(g => g.id), ...UNREADABLE_IDS],
      localIds: LOCAL.map(g => g.id),
      unrestorableIds: UNREADABLE_IDS,
    }).protectedIds.length;

    assert.equal(
      summary.preservedCount,
      expected,
      '预览的保留数必须与执行侧同一个判据算出来的一致（预览与实际同源）'
    );
    assert.equal(expected, 2, '两个读不出来的云端会话，本机都没有副本 ⇒ 两个都该保留');
  });

  it('读不出来、但**本机有副本**的那些不算保留（它们会被本机那份顶上去）', () => {
    const localWithCopy = [...LOCAL, mkGroup('remote-2', '本机也有')];
    const summary = buildUploadPreviewSummary(localWithCopy, READABLE, 'overwrite', {
      unrestorableRemoteIds: UNREADABLE_IDS,
    });
    assert.equal(
      summary.preservedCount,
      1,
      '本机有副本的那一行会被替换掉，不算「保留」'
    );
  });

  it('没有读不出来的行 ⇒ 保留数为 0（风险文案逐字不变）', () => {
    const summary = buildUploadPreviewSummary(LOCAL, READABLE, 'overwrite');
    assert.equal(summary.preservedCount, 0);
    assert.equal(
      describeOverwriteRisk(summary, '云端'),
      '覆盖模式会用本次数据直接替换云端现状：预计删除 1 个会话、更新 0 个会话，操作不可撤销。再点一次确认执行。'
    );
  });

  it('合并模式 ⇒ 保留数恒为 0（合并压根不删云端行）', () => {
    const summary = buildUploadPreviewSummary(LOCAL, READABLE, 'merge', {
      unrestorableRemoteIds: UNREADABLE_IDS,
    });
    assert.equal(summary.preservedCount, 0);
  });

  it('自带存储（并集型后端）⇒ 保留数恒为 0（那边一个都不删）', () => {
    const summary = buildUploadPreviewSummary(LOCAL, READABLE, 'overwrite', {
      preserveRemoteOnly: true,
      unrestorableRemoteIds: UNREADABLE_IDS,
    });
    assert.equal(summary.preservedCount, 0);
  });
});

describe('覆盖上传预览：有保留行时，风险文案必须说出来', () => {
  it('风险文案点明「有 N 个会话不会被删除或覆盖」', () => {
    const summary = buildUploadPreviewSummary(LOCAL, READABLE, 'overwrite', {
      unrestorableRemoteIds: UNREADABLE_IDS,
    });
    const text = describeOverwriteRisk(summary, '云端', summary.preservedCount);
    assert.ok(
      text.includes(String(summary.preservedCount)),
      `风险文案必须报出保留的会话数（实得：${text}）`
    );
    assert.match(
      text,
      /不会被删除或覆盖/,
      '风险文案必须说清「云端不是被完全替换」（预览不得预告与实际相反）'
    );
  });

  it('不传保留数时风险文案与既往逐字一致（默认 0 = 没有保留）', () => {
    const summary = buildUploadPreviewSummary(LOCAL, READABLE, 'overwrite');
    assert.equal(
      describeOverwriteRisk(summary, '云端'),
      describeOverwriteRisk(summary, '云端', 0)
    );
  });
});

describe('接线：预览拿到的跳过清单来自同一次下载（原子包装）', () => {
  // 数据装配在 services/syncPreviewLoader.ts（2026-10-23 第 51 轮搬出组件）。
  const loader = read(PREVIEW_LOADER);
  const source = read(SYNC_BUTTON);

  it('上传预览用的是「结果 + 跳过清单」同一次下载（downloadGroupsWithSkipped）', () => {
    // ⚠️ 2026-10-23（第 51 轮）：原子包装只有**一份**实现 ——
    // services/downloadWithSkippedGroups.ts 的 downloadGroupsWithSkipped()
    // （引擎与预览都走它）。之前还有第二份（tabGroupSyncService 里的
    // downloadTabGroupsWithSkips，不归一化、抛错不 fail-closed）⇒ 已删除。
    assert.match(
      loader,
      /downloadGroupsWithSkipped\(\)/,
      '必须用原子包装一次拿到「读到的」与「读不出来的」（分两次调用可能读到别的轮次）'
    );
    assert.doesNotMatch(
      loader,
      /downloadTabGroupsWithSkips/,
      '不得用那份不归一化、抛错不 fail-closed 的旧包装（两条路径迟早用错一条）'
    );
  });

  it('跳过清单**原样**用上（被丢掉 ⇒ 预览算不出保留数 = 谎报「全部替换」）', () => {
    assert.match(
      loader,
      /unrestorableRemoteIds: remote\.skippedIds/,
      '读不出来的那几组不在「读到的」里 ⇒ 必须单独传进预览'
    );
    // 清单不许在中间被换成空数组（那正是「把跳过清单丢掉」的形态）。
    assert.doesNotMatch(
      loader,
      /skippedIds:\s*\[\s*\]/,
      '不得把跳过清单替换成空数组（那会让预览算成「云端全部都会被替换」）'
    );
  });

  it('组件必须走这条装配路径（不许自己另算一份）', () => {
    assert.match(
      source,
      /loadUploadPreviewData\(/,
      '组件只负责渲染与状态，摘要由装配路径算（各算各的就会漂）'
    );
    assert.match(source, /loadDownloadPreviewData\(/);
  });

  it('风险文案用的保留数取自预览摘要自己算的那个数（不是另算一份）', () => {
    assert.match(
      source,
      /preservedCount: uploadPreview\?\.overwrite\?\.preservedCount/,
      '卡片与风险文案必须用同一个数（各算各的就会漂）'
    );
  });
});
