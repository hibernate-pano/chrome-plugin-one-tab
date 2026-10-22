/**
 * 渲染 `SearchResultList` 的测试 harness（服务端渲染，无 DOM）。
 *
 * ── 为什么要有它 ──────────────────────────────────────────────────────────
 * 本仓反复栽在同一个坑上：**判据层做完了、守卫全绿，而界面根本没接上**
 * （L-10 排序：下拉能选、列表顺序一动不动）。
 *
 * 「零结果页到底给不给出口」「恢复按钮的提示按不按锁定态分流」
 * 这两件事**只能**从渲染产物上看出来：读源码能看见「写了判据」，
 * 看不见「界面按这个判据摆了」。
 *
 * ── 为什么用 SSR 而不是 DOM ──────────────────────────────────────────────
 * 本仓没有 jsdom / happy-dom / @testing-library（见 `package.json`），
 * `react-dom/server` 的 `renderToStaticMarkup` 不需要 DOM
 * （与 `tests/_helpers/tabListHarness.ts`、
 *   `tests/guards/filterBrowseRender.test.ts` 同一套做法）。
 *
 * 代价：SSR **不跑 effect**，也**点不了按钮** ⇒
 *   · 能读「渲染成了什么、每个出口的机器可读身份是什么」；
 *   · 「点了会发生什么」由纯函数判据层（`runSearchEmptyStateExit`）
 *     与接线守卫覆盖。
 */
import type { TabGroup } from '@/types/tab';
import type { SearchFilters } from '@/utils/search';
import { parseHtml, findAll, textContent, type HtmlElement } from './htmlTree.ts';

/** 空态出口按钮的机器可读身份前缀（不是文案）。 */
export const EMPTY_EXIT_TESTID_PREFIX = 'empty-state-action-';

/** 「恢复整个会话」按钮的机器可读身份前缀（后面接会话 id）。 */
export const RESTORE_SESSION_TESTID_PREFIX = 'search-restore-session-';

/** 一个会话的最小构造参数。 */
export interface SearchGroupSpec {
  id: string;
  name: string;
  /** 标签条数。 */
  tabCount: number;
  /** 会话是否被锁定（锁定 ⇒ 恢复不消费、批量删除跳过）。 */
  isLocked?: boolean;
  /** 标签标题前缀。 */
  tabTitlePrefix?: string;
}

/** 造一批会话（`TabGroup`）。 */
export function makeSearchGroups(specs: SearchGroupSpec[]): TabGroup[] {
  return specs.map(spec => ({
    id: spec.id,
    name: spec.name,
    tabs: Array.from({ length: spec.tabCount }, (_, index) => ({
      id: `${spec.id}-t${index}`,
      url: `https://example.com/${spec.id}/${index}`,
      title: `${spec.tabTitlePrefix ?? 'page'} ${spec.id} ${index}`,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastAccessed: '2026-01-01T00:00:00.000Z',
      pinned: false,
    })),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    isLocked: spec.isLocked ?? false,
  }));
}

/** 渲染选项。 */
export interface SearchRenderOptions {
  /** 会话列表。 */
  groups?: TabGroup[];
  /** 搜索词。 */
  searchQuery?: string;
  /** 筛选条件（有生效条件且没有搜索词 ⇒ 筛选浏览视图）。 */
  filters?: SearchFilters;
  /** 同步后端。 */
  syncBackend?: 'supabase' | 'webdav';
  /** 是否已登录云端。 */
  isAuthenticated?: boolean;
  /** 设置里「保存时收集固定标签页」是否开着（决定筛选器存不存在）。 */
  collectPinnedTabs?: boolean;
  /** 登录弹窗回调（不传 = 宿主没接上这个能力）。 */
  onOpenAuth?: (tab: 'login') => void;
}

/** 一个渲染出来的空态出口。 */
export interface RenderedExit {
  /** 出口的种类（login / download / options / import）。 */
  action: string;
  /** 是不是一个可点的按钮（不是 disabled 的 button 才算「可点」）。 */
  clickable: boolean;
  /** 可见文字。 */
  label: string;
  /** title（补充说明）。 */
  title: string;
  /** aria-label。 */
  ariaLabel: string;
}

/** 一个渲染出来的「恢复整个会话」按钮。 */
export interface RenderedRestoreButton {
  /** 会话 id。 */
  groupId: string;
  /** 可访问名（aria-label）。 */
  ariaLabel: string;
  /** 可见文字。 */
  label: string;
}

/** 渲染结果。 */
export interface SearchRenderResult {
  html: string;
  tree: HtmlElement;
  /** 渲染出来的空态出口（按 DOM 序）。 */
  exits: RenderedExit[];
  /** 渲染出来的「恢复整个会话」按钮（会话 id → 按钮）。 */
  restoreButtons: RenderedRestoreButton[];
  /** 整页的可见文字。 */
  text: string;
}

let browserStubsInstalled = false;

/** 装一份够用的浏览器环境桩（只要能让 SSR 跑起来）。 */
function installBrowserStubs(): void {
  if (browserStubsInstalled) return;
  browserStubsInstalled = true;

  const lsData = new Map<string, string>();
  const localStorageStub = {
    get length(): number {
      return lsData.size;
    },
    key: (index: number): string | null => [...lsData.keys()][index] ?? null,
    getItem: (key: string): string | null => (lsData.has(key) ? (lsData.get(key) as string) : null),
    setItem: (key: string, value: string): void => {
      lsData.set(key, String(value));
    },
    removeItem: (key: string): void => {
      lsData.delete(key);
    },
    clear: (): void => {
      lsData.clear();
    },
  };

  const globalRef = globalThis as Record<string, unknown>;
  globalRef['window'] = {
    localStorage: localStorageStub,
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
  globalRef['localStorage'] = localStorageStub;
  globalRef['chrome'] = {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => undefined,
        remove: async () => undefined,
      },
      onChanged: { addListener: () => undefined, removeListener: () => undefined },
    },
    runtime: {
      getManifest: () => ({ version: 'test' }),
      sendMessage: async () => ({}),
      openOptionsPage: () => undefined,
      onMessage: { addListener: () => undefined, removeListener: () => undefined },
    },
    tabs: { query: async () => [] },
  };
}

/**
 * 真的把搜索结果视图渲染一遍，返回可断言的结构。
 *
 * @param options 渲染选项
 */
export async function renderSearchResultList(
  options: SearchRenderOptions = {}
): Promise<SearchRenderResult> {
  installBrowserStubs();

  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Provider } = await import('react-redux');
  const { createStore, store: defaultStore } = await import('@/store');
  const { SearchResultList } = await import('@/components/search/SearchResultList');
  const { ToastProvider } = await import('@/contexts/ToastContext');
  const { resolveActiveFilterState } = await import('@/components/search/searchBrowseMode');

  const base = defaultStore.getState();
  const groups = options.groups ?? [];
  const filters = options.filters ?? {};
  const collectPinnedTabs = options.collectPinnedTabs ?? base.settings.collectPinnedTabs;
  const { effectiveFilters, activeFilterCount } = resolveActiveFilterState(
    filters,
    collectPinnedTabs
  );
  const filterControls = {
    filters,
    effectiveFilters,
    activeFilterCount,
    showFilters: false,
    isFilterPending: false,
    updateFilters: () => undefined,
    clearFilters: () => undefined,
    toggleFilters: () => undefined,
  };

  const store = createStore({
    tabs: { ...base.tabs, groups, isLoading: false, error: null, errorSource: null },
    settings: {
      ...base.settings,
      syncBackend: options.syncBackend ?? base.settings.syncBackend,
      collectPinnedTabs,
    },
    auth: { ...base.auth, user: null, isAuthenticated: options.isAuthenticated ?? false },
  });

  const html = renderToStaticMarkup(
    React.createElement(
      Provider,
      { store } as never,
      React.createElement(
        ToastProvider,
        null,
        React.createElement(SearchResultList, {
          searchQuery: options.searchQuery ?? '',
          filterControls,
          ...(options.onOpenAuth ? { onOpenAuth: options.onOpenAuth } : {}),
        } as never)
      )
    )
  );

  const tree = parseHtml(html);

  const exits: RenderedExit[] = findAll(tree, element =>
    (element.attrs['data-testid'] ?? '').startsWith(EMPTY_EXIT_TESTID_PREFIX)
  ).map(element => ({
    action: (element.attrs['data-testid'] as string).slice(EMPTY_EXIT_TESTID_PREFIX.length),
    // 「可点」= 是一个 button 且没有被 disabled。
    clickable: element.tag === 'button' && element.attrs['disabled'] === undefined,
    label: textContent(element).trim(),
    title: element.attrs['title'] ?? '',
    ariaLabel: element.attrs['aria-label'] ?? '',
  }));

  const restoreButtons: RenderedRestoreButton[] = findAll(tree, element =>
    (element.attrs['data-testid'] ?? '').startsWith(RESTORE_SESSION_TESTID_PREFIX)
  ).map(element => ({
    groupId: (element.attrs['data-testid'] as string).slice(RESTORE_SESSION_TESTID_PREFIX.length),
    ariaLabel: element.attrs['aria-label'] ?? '',
    label: textContent(element).trim(),
  }));

  return {
    html,
    tree,
    exits,
    restoreButtons,
    text: textContent(tree).trim(),
  };
}
