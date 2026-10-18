// JSON 导入后必须重读设置（2026-10-18 round 31）。
//
// 【本文件要防的回归类别】`storage.importDetailed` 会把备份里的 settings 合并进存储
// （用户从另一台机器带回来的主题/布局/命名模板等），但那是**存储层**的写入 ——
// popup 自己的 Redux settings 不会因此变新。后果与覆盖下载完全同构：
//   ① 界面继续显示旧主题 / 旧布局，用户以为「设置没导进来」；
//   ② `saveSettings` 是**整份 state 盲写**（不是读-改-写）：用户导入后随手改一项
//      （连点几下布局都会）就把这份旧设置整份写回存储，刚导入的那批值被静默回滚。
// 修法：JSON 导入成功后，本上下文「先失效设置缓存、再 loadSettings 重读」，
// 与同步按钮 / 设置页「以云端为准」同一口径（`dispatchReloadSettings`）。
//
// 为什么只有 JSON 这条路需要：OneTab 文本格式里根本没有 settings（下方有守卫）。
// 若哪天它也开始合并设置，这条守卫会失败 —— 那时必须把重读一起接上。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function code(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('JSON 导入后重读设置', () => {
  const dropdown = code('src/components/layout/HeaderDropdown.tsx');
  const jsonImportAt = dropdown.indexOf('await storage.importDetailed(data)');
  const oneTabImportAt = dropdown.indexOf('await storage.importFromOneTabFormat(text)');

  it('两个导入入口都在（切片锚点没漂）', () => {
    assert.ok(jsonImportAt > -1, '找不到 JSON 导入调用点');
    assert.ok(oneTabImportAt > jsonImportAt, '找不到 OneTab 导入调用点，或顺序变了');
  });

  it('JSON 导入成功分支接上了 dispatchReloadSettings', () => {
    const branch = dropdown.slice(jsonImportAt, oneTabImportAt);
    const okAt = branch.indexOf('if (result.ok)');
    const reloadAt = branch.indexOf('dispatchReloadSettings(dispatch)');
    assert.ok(okAt > -1, 'JSON 导入分支里找不到 if (result.ok)');
    assert.ok(reloadAt > okAt, '重读没有排在「导入成功」判定之后（失败分支不该重读设置）');
  });

  it('重读失败必须出声，且说清「先别改设置」', () => {
    const branch = dropdown.slice(jsonImportAt, oneTabImportAt);
    assert.match(branch, /if \(reloadError\)/, '重读失败被静默丢弃');
    assert.match(
      branch,
      /没能重新读取设置/,
      '重读失败没有给用户可读的提示（要说清界面可能还是旧值）'
    );
  });
});

describe('只有 JSON 备份带设置', () => {
  const storage = code('src/utils/storage.ts');
  const oneTabFnAt = storage.indexOf('async importFromOneTabFormat');
  const clearFnAt = storage.indexOf('async clear()', oneTabFnAt);
  const detailedFnAt = storage.indexOf('async importDetailed');

  it('切片锚点没漂', () => {
    assert.ok(detailedFnAt > -1 && oneTabFnAt > detailedFnAt && clearFnAt > oneTabFnAt);
  });

  it('importDetailed 确实会合并设置（所以重读是必要的）', () => {
    const body = storage.slice(detailedFnAt, oneTabFnAt);
    assert.match(body, /this\.setSettings\(/, 'importDetailed 不再合并设置？那重读可以撤掉');
  });

  it('importFromOneTabFormat 不碰设置（所以那条路不需要重读）', () => {
    const body = storage.slice(oneTabFnAt, clearFnAt);
    assert.ok(
      !/setSettings/.test(body),
      'OneTab 导入开始合并设置了：必须同步给它的成功分支接上 dispatchReloadSettings'
    );
  });
});
