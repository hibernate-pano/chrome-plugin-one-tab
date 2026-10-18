// 上传覆盖的预览必须按后端分流（2026-10-18 round 26）。
//
// 【要防的回归类别】预览的删除数用的是「替换」口径：`afterGroups = 本地活跃组`
// ⇒ `deletions` = 云端独有会话数。这对 Supabase 成立（覆盖上传先 DELETE 再 upsert）。
// 但自带存储（WebDAV）的覆盖是**全量上行 + 清单并集**（`webdav/adapter.ts` 的
// uploadGroups 写清单时以最新 base 为底，只覆盖本批写过的条目）⇒ 云端独有会话
// 一个都不会删。于是同一个后端给出两套说法：
//   · 预览卡片：`覆盖模式会用本次数据直接替换云端现状：预计删除 N 个会话…不可撤销`
//   · 设置页推送结果：`…云端独有会话未被删除`
// 用户在破坏性操作的确认闸门前被一个不存在的删除数吓住（也可能因此不敢用覆盖）。
//
// 本守卫钉三件事：① 预览数学（Supabase 替换口径不变 / WebDAV 并集口径不报删除）；
// ② 风险文案在「一个都不删」时不得说成「直接替换现状：预计删除 0 个会话」；
// ③ 接线：判据来自 `settings.syncBackend` 真值，不是写死。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUploadPreviewSummary } from '@/utils/syncPreview';
import { describeOverwriteRisk } from '@/components/sync/syncPreviewView';
import type { Tab, TabGroup } from '@/types/tab';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
const SYNC_BUTTON = 'src/components/sync/SyncButton.tsx';

const mkTab = (id: string): Tab =>
  ({ id, url: `https://example.com/${id}`, title: id, createdAt: '2026-10-18T00:00:00.000Z', lastAccessed: '2026-10-18T00:00:00.000Z' }) as Tab;

const mkGroup = (id: string, name: string, tabId = id): TabGroup =>
  ({
    id,
    name,
    tabs: [mkTab(tabId)],
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T00:00:00.000Z',
    displayOrder: 0,
  }) as TabGroup;

// 云端有 A、B；本机只有 C ⇒ 云端独有 = 2 个（旧口径会报「预计删除 2 个会话」）
const LOCAL = [mkGroup('c', '本机会话')];
const REMOTE = [mkGroup('a', '云端会话甲'), mkGroup('b', '云端会话乙')];

describe('Supabase（替换型后端）：口径不变', () => {
  it('覆盖上传照旧把云端独有会话算成删除', () => {
    const summary = buildUploadPreviewSummary(LOCAL, REMOTE, 'overwrite');
    assert.equal(summary.deletions, 2);
    assert.equal(summary.additions, 1);
    assert.equal(summary.beforeCount, 2);
    assert.equal(summary.afterCount, 1, '替换后云端只剩本机这一组');
  });
});

describe('WebDAV（并集型后端）：不得谎报删除', () => {
  it('覆盖上传：云端独有会话一个都不删', () => {
    const summary = buildUploadPreviewSummary(LOCAL, REMOTE, 'overwrite', { preserveRemoteOnly: true });
    assert.equal(summary.deletions, 0);
    assert.deepEqual(summary.deletedNames, []);
    assert.equal(summary.additions, 1);
    assert.equal(summary.unchanged, 2, '云端独有会话原样保留 ⇒ 算保持不变');
  });

  it('覆盖上传：云端会话数如实变成并集（2 → 3，而不是 2 → 1）', () => {
    const summary = buildUploadPreviewSummary(LOCAL, REMOTE, 'overwrite', { preserveRemoteOnly: true });
    assert.equal(summary.beforeCount, 2);
    assert.equal(summary.afterCount, 3);
  });

  it('覆盖上传与合并上传的落点一致（同一后端的两种模式都只增不减）', () => {
    const overwrite = buildUploadPreviewSummary(LOCAL, REMOTE, 'overwrite', { preserveRemoteOnly: true });
    const merge = buildUploadPreviewSummary(LOCAL, REMOTE, 'merge');
    assert.equal(overwrite.afterCount, merge.afterCount);
    assert.equal(overwrite.deletions, merge.deletions);
  });

  it('合并模式不受该开关影响（本来就是并集）', () => {
    const withFlag = buildUploadPreviewSummary(LOCAL, REMOTE, 'merge', { preserveRemoteOnly: true });
    const without = buildUploadPreviewSummary(LOCAL, REMOTE, 'merge');
    assert.deepEqual(withFlag, without);
  });

  it('同 id 冲突仍算「更新」（并集不等于「什么都不做」）', () => {
    const changed = [{ ...mkGroup('a', '云端会话甲'), updatedAt: '2026-10-18T01:00:00.000Z' } as TabGroup];
    const summary = buildUploadPreviewSummary(changed, REMOTE, 'overwrite', { preserveRemoteOnly: true });
    assert.equal(summary.updates, 1);
    assert.equal(summary.deletions, 0);
  });
});

describe('风险文案：一个都不删时不能说成「直接替换现状」', () => {
  it('删除数为 0 → 明说不会删除任何会话，且不出现「预计删除 0 个会话」', () => {
    const summary = buildUploadPreviewSummary(LOCAL, REMOTE, 'overwrite', { preserveRemoteOnly: true });
    const text = describeOverwriteRisk(summary, '云端');
    assert.ok(!text.includes('预计删除 0'), text);
    assert.ok(text.includes('不会删除云端上的任何会话'), text);
    assert.ok(text.includes(`更新 ${summary.updates} 个会话`), text);
    assert.ok(text.includes('再点一次确认执行'), text);
  });

  it('删除数 > 0 → 原文案逐字不变（用户依赖的那句风险提示）', () => {
    const summary = buildUploadPreviewSummary(LOCAL, REMOTE, 'overwrite');
    assert.equal(
      describeOverwriteRisk(summary, '云端'),
      '覆盖模式会用本次数据直接替换云端现状：预计删除 2 个会话、更新 0 个会话，操作不可撤销。再点一次确认执行。'
    );
  });
});

describe('接线：判据来自设置里的后端真值', () => {
  const source = read(SYNC_BUTTON);

  it('上传覆盖预览带上 preserveRemoteOnly', () => {
    assert.ok(
      /buildUploadPreviewSummary\(localGroups, remoteGroups, 'overwrite', \{\s*preserveRemoteOnly: uploadOverwritePreservesRemote,?\s*\}\)/.test(
        source
      ),
      '上传覆盖预览必须按后端分流'
    );
  });

  it('该判据就是 settings.syncBackend === webdav（不是写死）', () => {
    assert.ok(
      /const uploadOverwritePreservesRemote = settings\.syncBackend === 'webdav';/.test(source),
      '判据必须读设置真值'
    );
  });

  it('卡片说明在自带存储下不再说「直接替换云端现状」', () => {
    assert.ok(source.includes('云端独有会话保留，同 id 冲突按版本新旧裁决。'), '缺 WebDAV 口径的卡片说明');
    assert.ok(source.includes("'用当前本地会话直接替换云端现状。'"), 'Supabase 口径的说明不该被删掉');
  });

  it('下载方向的预览不动（本地确实会被替换成云端镜像）', () => {
    assert.ok(
      /buildDownloadPreviewSummary\(localGroups, remoteGroups, 'overwrite'\)/.test(source),
      '下载覆盖不接该开关'
    );
  });
});
