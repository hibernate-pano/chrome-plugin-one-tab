// localStorage → IndexedDB 迁移「一次性」语义回归测试。
//
// 背景：migrateFromLocalStorage 与同文件的 migrateFromChromeStorage 语义不对称——
//   - chrome 版：读 migration_flags 里的 chromeStorageMigrated，已迁移则 return；
//     写回成功后置位标志 + chrome.storage.local.remove(keys) 清理源。
//   - localStorage 版：无标志位、无源清理，每次冷启动都把 localStorage 里的旧值
//     无条件覆盖回 IndexedDB。
// 而 ensureInitialized 在每次冷启动（popup 每次打开都调 initStorage，见
// AppContainer.tsx:16，且 popup 里 typeof window !== 'undefined'，SW 侧的守卫不生效）
// 都会重跑 localStorage 迁移。
//
// 后果：localStorage 里残留旧 tab_groups 的用户，每开一次 popup 列表就被无声回滚一次，
// 且 pending_upload 不在迁移键表内 —— 回滚后的状态不会被重新上传到云端。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const COLD_START = resolve(HERE, '_helpers', 'localStorageMigrationColdStart.ts');

let workDir = '';

interface State {
  localStorage: Record<string, string>;
  indexedDb: Record<string, unknown>;
  backend?: string | null;
}

/** 跑一次干净的「冷启动」：独立子进程 → 独立模块实例（无 initialized/cachedDb 残留）。 */
let coldStartCount = 0;
function coldStart(state: State): State {
  const file = join(workDir, `state-${coldStartCount++}.json`);
  writeFileSync(file, JSON.stringify(state, null, 2));
  execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', COLD_START, file],
    { stdio: 'pipe' }
  );
  return JSON.parse(readFileSync(file, 'utf8')) as State;
}

const NOW = '2026-09-23T08:00:00.000Z';

function makeGroup(id: string) {
  return {
    id,
    name: `group-${id}`,
    tabs: [],
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    version: 1,
  };
}

const LEGACY_GROUPS = [makeGroup('old-1'), makeGroup('old-2')];

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'tvp-migration-'));
});

after(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe('localStorage → IndexedDB 迁移只做一次', () => {
  it('第一次冷启动：残留数据迁入 IndexedDB、置位标志位、清理源键', () => {
    const out = coldStart({
      localStorage: { tab_groups: JSON.stringify(LEGACY_GROUPS) },
      indexedDb: {},
    });

    assert.equal(out.backend, 'indexeddb', '有 indexedDB 时后端应为 indexeddb');
    const migrated = (out.indexedDb.tab_groups as { value: unknown[] } | undefined)?.value;
    assert.deepEqual(
      (migrated as Array<{ id: string }>).map(x => x.id),
      ['old-1', 'old-2'],
      '第一次冷启动应把 localStorage 残留迁入 IndexedDB'
    );
    const flags = (out.indexedDb.migration_flags as { value: Record<string, boolean> } | undefined)
      ?.value;
    assert.equal(flags?.localStorageMigrated, true, '迁移成功后必须置位 localStorageMigrated');
    assert.equal(
      out.localStorage.tab_groups,
      undefined,
      '迁移成功后必须清理源键，否则下次冷启动会重放旧值'
    );
  });

  it('第二次冷启动：IndexedDB 里有更新的会话时，localStorage 残留不得覆盖（回归锁）', () => {
    // 第一次冷启动：用户带着旧构建残留的 localStorage 打开 popup
    const first = coldStart({
      localStorage: { tab_groups: JSON.stringify(LEGACY_GROUPS) },
      indexedDb: {},
    });

    // 用户随后正常使用了扩展：IndexedDB 里已经是三条更新的会话。
    // 同时 localStorage 里的旧值仍在（模拟源键清理失败 / 旧构建再次写入残留）。
    const current = [makeGroup('new-1'), makeGroup('new-2'), makeGroup('new-3')];
    const second = coldStart({
      localStorage: { tab_groups: JSON.stringify(LEGACY_GROUPS) },
      indexedDb: { ...first.indexedDb, tab_groups: { key: 'tab_groups', value: current } },
    });

    const stored = (second.indexedDb.tab_groups as { value: Array<{ id: string }> }).value;
    assert.deepEqual(
      stored.map(x => x.id),
      ['new-1', 'new-2', 'new-3'],
      '第二次冷启动必须被 localStorageMigrated 标志位挡住，不能回滚用户会话列表'
    );
  });

  it('第二次冷启动：标志位仍在时，新出现的迁移键也不再被搬回（只做一次的完整语义）', () => {
    const first = coldStart({
      localStorage: { tab_groups: JSON.stringify(LEGACY_GROUPS) },
      indexedDb: {},
    });

    const second = coldStart({
      // 迁移完成后用户又改了设置；localStorage 里冒出一个同名的旧 user_settings
      localStorage: { user_settings: JSON.stringify({ themeMode: 'light' }) },
      indexedDb: { ...first.indexedDb, user_settings: { key: 'user_settings', value: { themeMode: 'dark' } } },
    });

    const settings = (second.indexedDb.user_settings as { value: { themeMode: string } }).value;
    assert.equal(settings.themeMode, 'dark', '已迁移过就整体不再搬运任何键');
  });
});
