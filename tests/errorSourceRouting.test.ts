// errorSource 来源标注：QA 独立回归（1.22.12）。
//
// 背景：state.error 是共享字段，loadGroups.rejected 与列表内写操作 rejected 都写它。
// 不标来源时 TabList 一律打「加载会话列表失败」——线上一次 removeTab 30s 超时被
// 误报成加载失败，排障方向被带偏。修复 = tabSlice 12 处写点配对标注 + TabList 按
// errorSource 分三种日志前缀。
//
// 本文件补三个工程师用例之外的缺口（QA Round 1）：
//  1) 结构层：tabSlice 全部 error 写点**逐个**配对 errorSource（含清空点），
//     防止将来新增写点漏标（12 是当下的数，断言的是配对性不是数字）；
//  2) 消费层：TabList 的三分支前缀映射 —— 工程师测了 reducer 写，没人测读侧消费，
//     读侧写错同样会打出误导前缀；
//  3) 行为层：工程师未覆盖的 rejected 分支（deleteGroup / deleteAllGroups /
//     cleanDuplicateTabs）也必须标 action。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

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
  await register(LOADER_PATH);
});

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 读源码并剥注释（避免注释里的字段名/文案造成误判，沿用 syncBusyGate 惯例）。 */
function code(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ── 1) 结构层：tabSlice 写点逐个配对 ─────────────────────────────────────

describe('tabSlice：error 写点全部配对 errorSource（结构层审计）', () => {
  it('每一处 state.error = 都在随后 3 行内写 state.errorSource =（含清空点）', () => {
    const lines = code('src/store/slices/tabSlice.ts').split('\n');
    const writeLines: number[] = [];
    lines.forEach((line, i) => {
      if (/^\s*state\.error\s*=/.test(line)) writeLines.push(i);
    });
    assert.ok(writeLines.length >= 12, `至少应有 12 处 error 写点，实际 ${writeLines.length}`);
    const unpaired = writeLines.filter(i => {
      const next3 = lines.slice(i + 1, i + 4).join('\n');
      return !/state\.errorSource\s*=/.test(next3);
    });
    assert.deepStrictEqual(
      unpaired,
      [],
      `以下 error 写点未配对 errorSource（TabList 将退化到「来源未标注」分支）: ` +
        unpaired.map(i => `L${i + 1}: ${lines[i].trim()}`).join(' | ')
    );
  });

  it('初始状态与类型定义都带 errorSource', () => {
    const src = code('src/store/slices/tabSlice.ts');
    assert.match(src, /errorSource:\s*null/, 'initialTabState 必须初始化 errorSource');
    const typ = code('src/types/tab.ts');
    assert.match(
      typ,
      /errorSource\?:\s*'load'\s*\|\s*'action'\s*\|\s*null/,
      'TabState.errorSource 类型必须是 load/action/null 三态'
    );
  });
});

// ── 2) 消费层：TabList 按 errorSource 选日志前缀 ─────────────────────────

describe('TabList：日志前缀按 errorSource 分流（结构层）', () => {
  const src = () => code('src/components/tabs/TabList.tsx');

  it("errorSource==='load' → 打「加载会话列表失败」", () => {
    const s = src();
    const at = s.indexOf("errorSource === 'load'");
    assert.ok(at !== -1, '必须存在 load 分支');
    const branch = s.slice(at, at + 200);
    assert.match(branch, /logError\('加载会话列表失败:'/, 'load 分支必须打加载前缀');
  });

  it("errorSource==='action' → 打「列表内操作失败（非加载）」而非加载前缀", () => {
    const s = src();
    const at = s.indexOf("errorSource === 'action'");
    assert.ok(at !== -1, '必须存在 action 分支（removeTab 超时走这里）');
    const branch = s.slice(at, at + 250);
    assert.match(branch, /logError\('列表内操作失败/, 'action 分支必须打操作前缀');
    assert.ok(
      !branch.includes('加载会话列表失败'),
      'action 分支绝不能打「加载会话列表失败」—— 那正是线上误导前缀'
    );
  });

  it('未标注来源 → 有独立兜底前缀（暴露漏标而不是静默）', () => {
    const s = src();
    assert.match(s, /logError\('会话列表状态错误（来源未标注）:'/, '兜底分支必须能暴露漏标');
  });

  it('effect 依赖数组同时含 error 与 errorSource（来源变化也要重打日志）', () => {
    const s = src();
    assert.match(s, /\[error,\s*errorSource\]/, '依赖数组必须含 errorSource');
  });
});

// ── 3) 行为层：工程师未覆盖的 rejected 分支 ──────────────────────────────

describe('errorSource：其余 rejected 分支全部标 action（行为层补充）', () => {
  async function makeStore() {
    const { configureStore } = await import('@reduxjs/toolkit');
    const { default: tabReducer } = await import('@/store/slices/tabSlice');
    return configureStore({ reducer: { tabs: tabReducer } });
  }
  const slice = () => import('@/store/slices/tabSlice');

  it('deleteGroup.rejected → action', async () => {
    const { deleteGroup } = await slice();
    const store = await makeStore();
    store.dispatch(deleteGroup.rejected(new Error('超时：deleteGroup'), 'R1', 'g'));
    assert.equal(store.getState().tabs.errorSource, 'action');
  });

  it('deleteAllGroups.rejected → action', async () => {
    const { deleteAllGroups } = await slice();
    const store = await makeStore();
    store.dispatch(deleteAllGroups.rejected(new Error('超时：deleteAllGroups'), 'R1', undefined));
    assert.equal(store.getState().tabs.errorSource, 'action');
  });

  it('cleanDuplicateTabs.rejected → action', async () => {
    const { cleanDuplicateTabs } = await slice();
    const store = await makeStore();
    store.dispatch(
      cleanDuplicateTabs.rejected(new Error('超时：cleanDuplicates'), 'R1', undefined as never)
    );
    assert.equal(store.getState().tabs.errorSource, 'action');
  });

  it('loadGroups.pending 在上一轮 action 错误之后也把来源一并清空', async () => {
    const { loadGroups, deleteGroup } = await slice();
    const store = await makeStore();
    store.dispatch(deleteGroup.rejected(new Error('写失败'), 'R1', 'g'));
    assert.equal(store.getState().tabs.errorSource, 'action');
    store.dispatch(loadGroups.pending('R2', undefined));
    assert.equal(store.getState().tabs.error, null);
    assert.equal(store.getState().tabs.errorSource, null, '新一轮加载必须清空来源，避免残留 action');
  });
});
