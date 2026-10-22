/**
 * 渲染 `TabList` 的测试 harness（服务端渲染，无 DOM）。
 *
 * ── 为什么要有它 ──────────────────────────────────────────────────────────
 * 本仓反复栽在同一个坑上：**判据层做完了、守卫全绿，而界面根本没接上**。
 *   · L-10（排序）：下拉能选，列表顺序一动不动 —— 接线缺失；
 *   · R-6（排序控件）：控件摆在**不排序**的视图里，选了没反应；
 *   · R-11（双栏）：排好的顺序又被按标签数重分两栏 ⇒ DOM 序 ≠ 排序序。
 *
 * 这三条都**只能**从渲染产物上看出来：读源码能看见「排了序」，
 * 看不见「界面按这个顺序摆了」。
 *
 * ── 为什么用 SSR 而不是 DOM ──────────────────────────────────────────────
 * 本仓没有 jsdom / happy-dom / @testing-library（见 `package.json`），
 * `react-dom/server` 的 `renderToStaticMarkup` 不需要 DOM
 * （与 `tests/guards/filterBrowseRender.test.ts`、
 *   `tests/guards/blankSearchQueryKeepsEmptyState.test.ts` 同一套做法）。
 *
 * 代价：SSR **不跑 effect**，也**点不了按钮** ⇒
 *   · 能读「渲染成了什么、什么顺序」；
 *   · 不能读「点了会发生什么」（那部分由纯函数判据层 + 接线守卫覆盖）。
 */
import type { LayoutMode, TabGroup } from '@/types/tab';
import type { SessionSortKey } from '@/core/sessionSort';
import type { SearchFilters } from '@/utils/search';
import { parseHtml, findAll, textContent, type HtmlElement } from './htmlTree.ts';

/** 会话卡标题元素的 id 前缀（DOM 事实，仓库里的真机脚本也用它定位）。 */
export const GROUP_TITLE_ID_PREFIX = 'tab-group-title-';

/** 空态出口按钮的机器可读身份前缀（不是文案）。 */
export const EMPTY_EXIT_TESTID_PREFIX = 'empty-state-action-';

/** 一个会话的最小构造参数。 */
export interface GroupSpec {
  id: string;
  name: string;
  /** 标签条数（影响「会话大小」这个排序键，也影响旧实现的分栏均衡）。 */
  tabCount: number;
  createdAt: string;
  updatedAt?: string;
  /** 标签标题前缀（默认 'page'）—— 故意与会话名不同，免得名字出现在多处。 */
  tabTitlePrefix?: string;
}

/** 造一批会话（`TabGroup`）。 */
export function makeGroups(specs: GroupSpec[]): TabGroup[] {
  return specs.map(spec => ({
    id: spec.id,
    name: spec.name,
    tabs: Array.from({ length: spec.tabCount }, (_, index) => ({
      id: `${spec.id}-t${index}`,
      url: `https://example.com/${spec.id}/${index}`,
      title: `${spec.tabTitlePrefix ?? 'page'} ${spec.id} ${index}`,
      createdAt: spec.createdAt,
      lastAccessed: spec.updatedAt ?? spec.createdAt,
      pinned: false,
    })),
    createdAt: spec.createdAt,
    updatedAt: spec.updatedAt ?? spec.createdAt,
    isLocked: false,
  }));
}

/** 渲染选项。 */
export interface RenderOptions {
  /** 会话列表（默认空 = 空态）。 */
  groups?: TabGroup[];
  /** 搜索词。 */
  searchQuery?: string;
  /** 筛选条件（有生效条件且没有搜索词 ⇒ 筛选浏览视图）。 */
  filters?: SearchFilters;
  /** 布局模式。 */
  layoutMode?: LayoutMode;
  /** 排序键。 */
  sessionSort?: SessionSortKey;
  /** 同步后端。 */
  syncBackend?: 'supabase' | 'webdav';
  /** 是否已登录云端。 */
  isAuthenticated?: boolean;
  /** 登录弹窗回调（不传 = 宿主没接上这个能力）。 */
  onOpenAuth?: (tab: 'login') => void;
}

/** 渲染结果。 */
export interface RenderResult {
  /** 渲染出来的 HTML。 */
  html: string;
  /** HTML 树。 */
  tree: HtmlElement;
  /** 会话卡标题在 DOM 中的出现顺序（会话 id）—— 列表视图才有。 */
  groupIdOrder: string[];
  /** 会话在 DOM 中的顺序（会话名）—— 列表视图与结果视图统一口径。 */
  sessionNameOrder: string[];
  /** 排序控件在不在。 */
  hasSortControl: boolean;
  /** 空态出口的种类（按 data-testid 读出来的，不是文案）。 */
  exitActions: string[];
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

/** 判断一个元素的 id 是不是「会话卡标题」（排除同前缀的辅助说明元素）。 */
function isGroupTitleId(id: string | undefined): id is string {
  if (!id) return false;
  if (!id.startsWith(GROUP_TITLE_ID_PREFIX)) return false;
  return !id.slice(GROUP_TITLE_ID_PREFIX.length).includes('hint');
}

/**
 * 真的把列表渲染一遍，返回可断言的结构。
 *
 * @param options 渲染选项
 */
export async function renderTabList(options: RenderOptions = {}): Promise<RenderResult> {
  installBrowserStubs();

  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Provider } = await import('react-redux');
  const { createStore, store: defaultStore } = await import('@/store');
  const { TabList } = await import('@/components/tabs/TabList');
  const { ToastProvider } = await import('@/contexts/ToastContext');
  const { resolveActiveFilterState } = await import('@/components/search/searchBrowseMode');
  const { SORT_CONTROL_ID } = await import('@/components/search/SearchFilterPanel');

  const base = defaultStore.getState();
  const groups = options.groups ?? [];
  const filters = options.filters ?? {};
  const { effectiveFilters, activeFilterCount } = resolveActiveFilterState(
    filters,
    base.settings.collectPinnedTabs
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
      layoutMode: options.layoutMode ?? base.settings.layoutMode,
      sessionSort: options.sessionSort ?? base.settings.sessionSort,
      syncBackend: options.syncBackend ?? base.settings.syncBackend,
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
        React.createElement(TabList, {
          searchQuery: options.searchQuery ?? '',
          filterControls,
          ...(options.onOpenAuth ? { onOpenAuth: options.onOpenAuth } : {}),
        } as never)
      )
    )
  );

  const tree = parseHtml(html);
  const titleNodes = findAll(tree, element => isGroupTitleId(element.attrs['id']));
  const groupIdOrder = titleNodes.map(element =>
    (element.attrs['id'] as string).slice(GROUP_TITLE_ID_PREFIX.length)
  );

  const nameById = new Map(groups.map(group => [group.id, group.name]));
  const headingNames = findAll(tree, element => element.tag === 'h4').map(element =>
    textContent(element).trim()
  );
  const sessionNameOrder =
    groupIdOrder.length > 0
      ? groupIdOrder.map(id => nameById.get(id) ?? id)
      : headingNames;

  const exitActions = findAll(tree, element =>
    (element.attrs['data-testid'] ?? '').startsWith(EMPTY_EXIT_TESTID_PREFIX)
  ).map(element => (element.attrs['data-testid'] as string).slice(EMPTY_EXIT_TESTID_PREFIX.length));

  return {
    html,
    tree,
    groupIdOrder,
    sessionNameOrder,
    hasSortControl: html.includes(SORT_CONTROL_ID),
    exitActions,
  };
}
