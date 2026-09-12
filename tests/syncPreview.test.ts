// 下载预览必须与「实际下载合并」同源（mergeOpStamped）：
// 旧实现用 mergeTabGroups（version + 时间戳 LWW），会预告一个与实际结果相反的胜者，
// 用户按预览做的决策（要不要覆盖下载）就建立在错误信息上。
//
// 文件样板与 tests/mutationOps.test.ts 一致：@/ 别名需在 register(loader) 之后动态 import。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

before(async () => {
  register(LOADER_PATH);
});

const OLD_T = '2026-01-01T00:00:00.000Z';
const NEW_T = '2026-06-01T00:00:00.000Z';

const group = (over: Record<string, unknown>) => ({
  id: 'g1',
  name: 'g',
  tabs: [],
  createdAt: OLD_T,
  updatedAt: OLD_T,
  isDeleted: false,
  isLocked: false,
  version: 1,
  ...over,
});

describe('buildDownloadPreviewSummary: 与实际合并同源', () => {
  // ★ 判别性用例：本地 version 更高但印记更旧（另一台设备后写），
  // 旧 LWW 预览会报「本地名」，实际合并结果却是「云端名」。
  it('胜者由 OpStamp 决定，不由 version 决定', async () => {
    const { buildDownloadPreviewSummary } = await import('@/utils/syncPreview');
    const local = group({ name: '本地名', version: 9, lastOp: { d: 'devA', s: 10 } });
    const remote = group({ name: '云端名', version: 2, updatedAt: NEW_T, lastOp: { d: 'devA', s: 50 } });

    const summary = buildDownloadPreviewSummary([local as any], [remote as any], 'merge');

    assert.deepEqual(
      summary.updatedNames,
      ['云端名'],
      '预览必须预告印记更高的一方胜出，否则预览与实际结果相反'
    );
  });

  it('预览的活跃结果与 mergeOpStamped 完全一致', async () => {
    const { buildDownloadPreviewSummary } = await import('@/utils/syncPreview');
    const [{ mergeOpStamped }, { EMPTY_STAMP }] = await Promise.all([
      import('@/utils/opStampMerge'),
      import('@/utils/opStamp'),
    ]);

    const local = [
      group({ id: 'keep-local', name: '只有本地', version: 1, lastOp: { d: 'devA', s: 5 } }),
      group({ id: 'conflict', name: '本地版', version: 7, lastOp: { d: 'devA', s: 5 } }),
      group({ id: 'stale-local', name: '本地旧版', version: 7, lastOp: { d: 'devA', s: 5 } }),
    ];
    const remote = [
      group({ id: 'keep-remote', name: '只有云端', lastOp: { d: 'devB', s: 5 } }),
      group({ id: 'conflict', name: '云端版', version: 1, lastOp: { d: 'devB', s: 60 } }),
      group({ id: 'stale-local', name: '云端新版', version: 1, lastOp: { d: 'devB', s: 60 } }),
    ];

    const summary = buildDownloadPreviewSummary(local as any, remote as any, 'merge');
    const merged = mergeOpStamped(local as any, remote as any, { mergeStamp: EMPTY_STAMP });

    assert.equal(summary.afterCount, merged.filter(g => !g.isDeleted).length);
    assert.equal(summary.additions, 1, '云端独有的组应计为新增');
    assert.equal(summary.unchanged, 1, '只有本地存在的组应计入 unchanged');
    assert.ok(summary.updatedNames.includes('云端版') && summary.updatedNames.includes('云端新版'));
  });

  it('云端墓碑不计入活跃预览（不会预告一个将被删掉的组）', async () => {
    const { buildDownloadPreviewSummary } = await import('@/utils/syncPreview');
    const local = [group({ id: 'gone', name: '云端已删' })];
    const remote = [group({ id: 'gone', name: '云端已删', isDeleted: true, lastOp: { d: 'devB', s: 60 } })];

    const summary = buildDownloadPreviewSummary(local as any, remote as any, 'merge');

    assert.equal(summary.afterCount, 0);
    assert.deepEqual(summary.deletedNames, ['云端已删']);
  });
});
