/**
 * 「最近使用」说明行（v1.33）—— 文案逐字 + **只在选中那一档时出现**。
 *
 * ── 为什么需要这一行 ──────────────────────────────────────────────────────
 *
 * 「最近使用」依赖一份**只在本机存在**的记录（打开过会话才写），而这份记录
 * 在界面上不可见。不说清两件事，用户会把它当成「最近修改」的另一种叫法：
 *   ① 按**什么**排（在这台设备上打开会话的时间；没记录的排最后）；
 *   ② 这个时间**只在本机**，不同步到其他设备。
 *
 * ── 为什么守卫要做渲染层 ──────────────────────────────────────────────────
 *
 * 文案对了但没挂到界面上（或挂在别的档位下）是零收益。这里真的把筛选区
 * 渲染一遍：选中「最近使用」⇒ 说明行在场；任何其它档位 ⇒ 不在场。
 * 两份文案的分界是「本机有没有任何一条记录」——一条都没有时（刚上线必然
 * 如此），说「没有记录的排在最后」没有意义（那时所有会话都没有记录）。
 *
 * 【反向检测】渲染断言的 fixture 必须在「有记录 / 无记录」之间**可分辨**：
 * 两份文案本身不同，测试分别种记录后断言**另一份不出现**。
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  RECENT_USED_NOTE_WITH_RECORDS,
  RECENT_USED_NOTE_WITHOUT_RECORDS,
  SESSION_SORT_NOTE_TESTID,
  recentUsedSortNote,
} from '../src/components/search/sortNoteCopy.ts';

// ─────────────────────────────────────────────────────────────────────────
// 1. 文案本身
// ─────────────────────────────────────────────────────────────────────────

describe('说明行文案 · 两份分界是「本机有没有记录」', () => {
  it('有记录的那份逐字正确', () => {
    assert.equal(
      RECENT_USED_NOTE_WITH_RECORDS,
      '按你在这台设备上打开会话的时间排序；没有记录的排在最后。这个时间只记在本机，不同步到其他设备。'
    );
  });

  it('没有记录的那份逐字正确', () => {
    assert.equal(
      RECENT_USED_NOTE_WITHOUT_RECORDS,
      '还没有使用记录。打开任意会话后，这里会按最近使用的时间排序。'
    );
  });

  it('recentUsedSortNote 按 hasRecords 分流', () => {
    assert.equal(recentUsedSortNote(true), RECENT_USED_NOTE_WITH_RECORDS);
    assert.equal(recentUsedSortNote(false), RECENT_USED_NOTE_WITHOUT_RECORDS);
  });

  it('两份文案都**必须**说清「只在本机」或「还没记录」，不许含糊', () => {
    assert.match(RECENT_USED_NOTE_WITH_RECORDS, /只记在本机/);
    assert.match(RECENT_USED_NOTE_WITH_RECORDS, /不同步到其他设备/);
    assert.match(RECENT_USED_NOTE_WITHOUT_RECORDS, /还没有使用记录/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 渲染层：只在「最近使用」档位出现
// ─────────────────────────────────────────────────────────────────────────

// react-dom/server 依赖 window/localStorage 的一小撮 API（只是桩，不是 DOM）。
const lsData = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    get length(): number {
      return lsData.size;
    },
    key: (index: number): string | null => [...lsData.keys()][index] ?? null,
    getItem: (key: string): string | null => lsData.get(key) ?? null,
    setItem: (key: string, value: string): void => void lsData.set(key, String(value)),
    removeItem: (key: string): void => void lsData.delete(key),
    clear: (): void => void lsData.clear(),
  },
  matchMedia: () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }),
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true,
};
(globalThis as Record<string, unknown>).localStorage = (
  globalThis as unknown as { window: { localStorage: unknown } }
).window.localStorage;
(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    },
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
  runtime: { getManifest: () => ({ version: 'test' }), sendMessage: async () => ({}) },
};

interface ControlsStub {
  filters: Record<string, unknown>;
  effectiveFilters: Record<string, unknown>;
  activeFilterCount: number;
  showFilters: boolean;
  isFilterPending: boolean;
  updateFilters: () => void;
  clearFilters: () => void;
  toggleFilters: () => void;
}

const controlsWith = (over: Partial<ControlsStub>): ControlsStub => ({
  filters: {},
  effectiveFilters: {},
  activeFilterCount: 0,
  showFilters: false,
  isFilterPending: false,
  updateFilters: () => undefined,
  clearFilters: () => undefined,
  toggleFilters: () => undefined,
  ...over,
});

const lastUsedAtStore = { module: null as null | typeof import('@/storage-kv/lastUsedAtStore') };

before(async () => {
  lastUsedAtStore.module = await import('@/storage-kv/lastUsedAtStore');
});

beforeEach(() => {
  lastUsedAtStore.module?.__resetLastUsedAtForTests();
});

/** 从渲染结果里取出说明行的可见文字（没有 = null）。 */
const noteTextOf = (html: string): string | null => {
  const match = html.match(
    new RegExp(`<p[^>]*data-testid="${SESSION_SORT_NOTE_TESTID}"[^>]*>([\\s\\S]*?)</p>`)
  );
  if (!match) return null;
  return match[1].replace(/<[^>]*>/g, '').trim();
};

/** 真的把筛选区渲染一遍。 */
const renderFilterSection = async (options: {
  sessionSort: 'saved' | 'recentUsed' | 'accessed' | 'name' | 'size';
  showFilters?: boolean;
  showSortControl?: boolean;
  withRecords?: boolean;
}): Promise<string> => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Provider } = await import('react-redux');
  const { createStore, store: defaultStore } = await import('@/store');
  const { ToastProvider } = await import('@/contexts/ToastContext');
  const { SearchFilterSection } = await import('@/components/search/SearchFilterPanel');

  const baseSettings = defaultStore.getState().settings;
  const store = createStore({
    settings: { ...baseSettings, sessionSort: options.sessionSort },
  });

  if (options.withRecords) {
    lastUsedAtStore.module?.__seedLastUsedAtForTests({
      g1: '2026-11-01T00:00:00.000Z',
    });
  }

  return renderToStaticMarkup(
    React.createElement(
      Provider,
      { store } as never,
      React.createElement(
        ToastProvider,
        null,
        React.createElement(SearchFilterSection, {
          controls: controlsWith({ showFilters: options.showFilters ?? false }) as never,
          title: '筛选会话',
          collectPinnedTabs: false,
          variant: 'flush',
          showSortControl: options.showSortControl ?? true,
        } as never)
      )
    )
  );
};

describe('渲染层 · 说明行只在「最近使用」出现', () => {
  it('下拉框的选项顺序与文案逐字：最近保存 / 最近使用 / 最近修改 / 名称 / 会话大小（标签数）', async () => {
    const html = await renderFilterSection({ sessionSort: 'saved' });
    const optionLabels = [...html.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map(match =>
      match[1].trim()
    );
    assert.deepEqual(optionLabels, [
      '最近保存',
      '最近使用',
      '最近修改',
      '名称',
      '会话大小（标签数）',
    ]);
    assert.equal(
      html.includes('最近活动'),
      false,
      '「最近活动」已被改名「最近修改」—— 界面上不许再出现旧名字'
    );
  });

  for (const sort of ['saved', 'accessed', 'name', 'size'] as const) {
    it(`${sort} ⇒ 不出现说明行（不占每一屏的一行）`, async () => {
      const html = await renderFilterSection({ sessionSort: sort, withRecords: true });
      assert.equal(noteTextOf(html), null, `选中 ${sort} 时不该有说明行`);
    });
  }

  it('最近使用 + 有记录 ⇒ 出现「有记录」那份，且另一份不出现', async () => {
    const html = await renderFilterSection({ sessionSort: 'recentUsed', withRecords: true });
    assert.equal(noteTextOf(html), RECENT_USED_NOTE_WITH_RECORDS);
    assert.equal(html.includes(RECENT_USED_NOTE_WITHOUT_RECORDS), false);
  });

  it('最近使用 + 一条记录都没有 ⇒ 出现「还没记录」那份，且另一份不出现', async () => {
    const html = await renderFilterSection({ sessionSort: 'recentUsed', withRecords: false });
    assert.equal(noteTextOf(html), RECENT_USED_NOTE_WITHOUT_RECORDS);
    assert.equal(html.includes(RECENT_USED_NOTE_WITH_RECORDS), false);
  });

  it('工具栏摆法（面板收起）时说明行紧跟在工具条下方', async () => {
    const html = await renderFilterSection({
      sessionSort: 'recentUsed',
      showFilters: false,
      withRecords: true,
    });
    assert.equal(noteTextOf(html), RECENT_USED_NOTE_WITH_RECORDS);
  });

  it('面板摆法（面板展开）时说明行跟着面板走（仍然只有一条）', async () => {
    const html = await renderFilterSection({
      sessionSort: 'recentUsed',
      showFilters: true,
      withRecords: true,
    });
    const occurrences = html.split(`data-testid="${SESSION_SORT_NOTE_TESTID}"`).length - 1;
    assert.equal(occurrences, 1, '两种摆法只能出现一份说明（不能重复渲染）');
    assert.equal(noteTextOf(html), RECENT_USED_NOTE_WITH_RECORDS);
  });

  it('这个视图根本不摆排序控件 ⇒ 也不摆说明（说明解释的是控件）', async () => {
    const html = await renderFilterSection({
      sessionSort: 'recentUsed',
      showSortControl: false,
      withRecords: true,
    });
    assert.equal(noteTextOf(html), null);
  });
});
