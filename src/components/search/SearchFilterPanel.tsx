/**
 * 筛选面板（**唯一一份**）与它的工具条。
 *
 * ── 为什么面板被提到这个独立组件 ────────────────────────────────────────
 *
 * 修复前筛选面板住在 `SearchResultList` 内部，而该组件只在**有搜索词**时
 * 才被渲染 ⇒ 筛选器不可达（2026-10-20 审计 A-14）。
 *
 * 现在面板由**列表层**持有状态、渲染面板；主列表与结果视图共用同一份：
 *   · 空搜索词时：面板就在主列表上方（用户从列表工具条的「显示筛选」进）；
 *   · 有搜索词时：面板在结果区里（与修复前同一位置、同一入口）。
 *
 * 「只渲染一份」的硬要求是**状态**只有一份（不是「代码只有一份」）：
 * 两处各存一份筛选条件 ⇒ 迟早出现「看不见但条件在生效」这种最坏的隐形行为。
 * 这里用同一个 `SearchFilterControls` 对象喂给所有渲染点，状态只有一处。
 *
 * ── 筛选条件的三个层级 ──────────────────────────────────────────────────
 *
 * 域名 / 固定标签是**标签级**判据，会话名 / 保存时间是**会话级**判据。
 * 空搜索词时结果集必须是全部标签（见 ./searchBrowseMode 的文件头），
 * 否则会话级筛选没有判据可作用。
 *
 * ── 2026-10-24：面板的长相回到 v1.25.1 ──────────────────────────────────
 *
 * 1.26.0（第 42 轮审计 U-08 / U-09）把面板从「四个字段的栅格」换成了
 * 「一条 chip 行 + 点开才展开的那一个编辑框」。
 * **那是长相，不是功能** ⇒ 按产品负责人 2026-10-24 的要求退掉：
 * 面板恢复成 v1.25.1 的字段栅格（标签在上、控件在下、四个字段同时可见、
 * 一次看完，不用逐个点开）。
 *
 * 【退掉的是长相，留住的是能力】
 *   · **退**：chip 行、逐维度展开/收起（`expandedDimension` /
 *     `onSelectDimension`）、面板内边距（p-3 sm:p-4）。
 *   · **留**：工具条上的「生效条件 chip」（条件在生效而用户看不见 =
 *     说谎，这是本仓反复修过的那类隐形行为）、排序控件（1.26.0 新增的
 *     **功能**）、排序的落盘与失败回滚、主题令牌化的类名（结构）、
 *     字号下限（可读性）。
 */
import React from 'react';
import type { SearchFilters } from '@/utils/search';
import type { SearchFilterControls } from './searchFilterState';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { dispatchSaveSettings, setSessionSort } from '@/store/slices/settingsSlice';
import { useToast } from '@/contexts/ToastContext';
import {
  SESSION_SORT_OPTIONS,
  resolveSortControlPlacement,
  sessionSortLabel,
  type SessionSortKey,
  type SortControlPlacement,
} from '@/core/sessionSort';

/**
 * 筛选控件的 id 前缀：同一时刻只有一个筛选面板，固定前缀即可保证 label 唯一。
 */
export const FILTER_IDS = {
  pinned: 'search-filter-pinned',
  domain: 'search-filter-domain',
  groupName: 'search-filter-group-name',
  savedWithin: 'search-filter-saved-within',
} as const;

/** 排序下拉的 id（与 L-10 的排序控件共用一份）。 */
export const SORT_CONTROL_ID = 'session-sort-control';

/**
 * 筛选维度：编辑器的键、条件的键 —— 同一个。
 */
export type FilterDimension = keyof typeof FILTER_IDS;

/** 每个维度的中文名（工具条上的生效条件 chip 用它）。 */
const DIMENSION_LABELS: Record<FilterDimension, string> = {
  pinned: '固定标签页',
  domain: '域名',
  groupName: '会话名称',
  savedWithin: '保存时间',
};

/** 「保存时间」的取值 → 人话（工具条上的生效条件 chip 用它）。 */
const SAVED_WITHIN_LABELS: Record<NonNullable<SearchFilters['savedWithin']>, string> = {
  '24h': '24 小时内',
  '7d': '7 天内',
  '30d': '30 天内',
  older: '30 天前',
};

/** 「固定标签页」的取值 → 人话。 */
const PINNED_LABELS: Record<'only' | 'exclude', string> = {
  only: '仅固定',
  exclude: '排除固定',
};

const FilterIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a2 0 01-.293.707l-6.414 6.414a2 0 00-.293.707V17l-4 4v-6.586a2 0 00-.293-.707L3.293 7.207A2 0 013 6.5V4z" />
);

/** 工具条上的「生效条件 chip」。 */
interface ActiveFilterChip {
  /** chip 点开时要编辑哪个维度。 */
  dimension: FilterDimension;
  /** 维度名（灰）与值（强调色）两段。 */
  label: string;
  /** 给人看的值。 */
  value: string;
  /**
   * chip 的 key = 「维度 + 当前生效值」。
   *
   * 【为什么 key 里要带值】key 相同 ⇒ React 认为是同一个 chip；值变了
   * 就是**另一个** chip（内容变了），key 跟着变才不会在两个不同内容之间
   * 复用同一个 DOM 节点。
   */
  key: string;
}

/**
 * 从**当前生效值**生成工具条上的「生效条件 chip」。
 *
 * 这条链路是「生效中的条件必须始终可见」那条契约的**唯一出口** ——
 * 条件变了、chip 的内容必须跟着变（守卫 `tests/guards/searchFilterPanel.test.ts`
 * 守的就是这件事：渲染处必须调用当前值，而不是写死一句字符串）。
 */
export const buildActiveFilterChips = (filters: SearchFilters): ActiveFilterChip[] => {
  const chips: ActiveFilterChip[] = [];
  const push = (dimension: FilterDimension, raw: string | undefined, display: string) => {
    const value = (raw ?? '').trim();
    if (!value) return;
    chips.push({
      dimension,
      label: DIMENSION_LABELS[dimension],
      value: display,
      key: `${dimension}:${value}`,
    });
  };

  push('domain', filters.domain, filters.domain?.trim() ?? '');
  push('groupName', filters.groupName, filters.groupName?.trim() ?? '');
  if (filters.savedWithin) {
    push('savedWithin', filters.savedWithin, SAVED_WITHIN_LABELS[filters.savedWithin]);
  }
  if (filters.pinned && filters.pinned !== 'all') {
    push('pinned', filters.pinned, PINNED_LABELS[filters.pinned]);
  }
  return chips;
};

/**
 * 排序下拉（L-10 的接线部分）。
 *
 * 摆法判据在 `src/core/sessionSort.ts`（`resolveSortControlPlacement`）：
 * 面板收起时它摆在工具条上、展开时进面板 —— **两种摆法下都可见**
 * （排序是列表管理的主入口，藏进「筛选」里用户第一屏就看不到它）。
 *
 * 【落盘与回滚】改了排序键必须**落盘**（否则刷新后回默认值 = 用户刚做的
 * 选择无声消失），而落盘是 fail-closed 的（`dispatchSaveSettings` 读不到真值
 * 就拒绝写）⇒ 写失败时必须**回滚**到旧值并把失败原因告诉用户，不能让下拉
 * 显示着一个其实没存进去的值。
 */
const SessionSortControl: React.FC<{ placement: SortControlPlacement }> = ({
  placement,
}) => {
  const dispatch = useAppDispatch();
  const sessionSort = useAppSelector(state => state.settings.sessionSort);
  const { showToast } = useToast();
  const inPanel = placement === 'panel';

  const handleChange = async (event: React.ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value as SessionSortKey;
    const previous = sessionSort;
    dispatch(setSessionSort(next));
    const saveError = await dispatchSaveSettings(dispatch);
    if (saveError) {
      dispatch(setSessionSort(previous));
      showToast(`${saveError}（排序已恢复为「${sessionSortLabel(previous)}」）`, 'error');
    }
  };

  const select = (
    <select
      id={SORT_CONTROL_ID}
      aria-label="排序方式"
      value={sessionSort}
      onChange={handleChange}
      className={`border theme-border-default theme-radius-input-sm theme-focus theme-bg-elevated px-2 py-1 theme-text-primary ${
        inPanel ? 'text-base w-full' : 'text-sm shrink-0 max-w-[11rem]'
      }`}
    >
      {SESSION_SORT_OPTIONS.map(option => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );

  // 摆在面板里时，它长得跟其它筛选字段**一模一样**（标签在上、控件在下）——
  // v1.25.1 的面板就是「一排字段」，排序只是其中一个字段。
  if (inPanel) {
    return (
      <div>
        <label
          htmlFor={SORT_CONTROL_ID}
          className="block text-sm theme-text-secondary mb-1"
        >
          排序
        </label>
        {select}
      </div>
    );
  }

  // 摆在工具条上时（面板收起）：与「清空筛选 / 显示筛选」同一排。
  return (
    <div className="flex items-center gap-1.5">
      <label
        htmlFor={SORT_CONTROL_ID}
        className="shrink-0 text-sm theme-text-secondary"
      >
        排序
      </label>
      {select}
    </div>
  );
};

/**
 * 筛选区放在哪里的两种语境。
 *
 * · `inset` —— 结果卡内部：工具条与面板都按修复前的缩进（px-2 / mx-2）。
 * · `flush` —— 主列表上方 / 结果卡的空态：工具条 px-2，面板不缩进
 *   （与修复前空态分支的形态一致）。
 *
 * 分成两种是为了**不改动既有的视觉**：修复前的两种分支本来的缩进就不同，
 * 统一成一种会让「有结果」与「没结果」两个界面长得不一样了。
 */
export type SearchFilterVariant = 'inset' | 'flush';

interface SearchFilterPanelProps {
  controls: SearchFilterControls;
  /** 设置里的「保存固定标签页」是否开启（关闭时这个筛选项是死控件，不渲染）。 */
  collectPinnedTabs: boolean;
  /** 面板是否带左右外边距（结果视图里的面板要缩进，列表层的不要）。 */
  withOuterMargin?: boolean;
  /** 面板展开时摆在面板里的排序控件（收起时同一个控件在工具条上）。 */
  sortControl?: React.ReactNode;
  /**
   * 面板打开后要把焦点送进哪个字段（工具条上的「生效条件 chip」点一下就会
   * 传一个维度进来）。null = 不送焦点。
   */
  focusDimension?: FilterDimension | null;
}

/**
 * 筛选面板本体：v1.25.1 的**字段栅格**。
 *
 * 【固定标签页筛选器只在「保存固定标签页」开启时才有意义】——
 * 关闭时存进会话的标签 `pinned` 恒为 false，这个筛选器形同虚设。
 * 摆在用户面前还占一行，就是「选项在骗用户」（见 searchFilterAvailability）。
 *
 * 【四个字段同时可见】这是 v1.25.1 的形态：标签在上、控件在下、一次看完，
 * 不用逐个点开才看见自己要填的那一格（1.26.0 的 chip 行已退掉）。
 */
export const SearchFilterPanel: React.FC<SearchFilterPanelProps> = ({
  controls,
  collectPinnedTabs,
  withOuterMargin,
  sortControl,
  focusDimension,
}) => {
  const { filters, updateFilters } = controls;

  /** 编辑框的 ref：工具条上的「生效条件 chip」点开后要把焦点送进去。 */
  const fieldRefs = React.useRef<Partial<Record<FilterDimension, HTMLElement | null>>>({});

  React.useEffect(() => {
    if (!focusDimension) return;
    const element = fieldRefs.current[focusDimension];
    if (element && typeof element.focus === 'function') element.focus();
  }, [focusDimension]);

  return (
    <div className={`theme-well theme-radius-control p-3 sm:p-4 mb-3 ${withOuterMargin ? 'mx-2' : ''}`}>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
        {collectPinnedTabs && (
          <div>
            <label
              htmlFor={FILTER_IDS.pinned}
              className="block text-sm theme-text-secondary mb-1"
            >
              固定标签页
            </label>
            <select
              id={FILTER_IDS.pinned}
              ref={element => {
                fieldRefs.current.pinned = element;
              }}
              value={filters.pinned || 'all'}
              onChange={event => {
                const nextPinned = event.target.value as SearchFilters['pinned'];
                updateFilters(current => ({
                  ...current,
                  pinned: nextPinned === 'all' ? undefined : nextPinned,
                }));
              }}
              className="w-full text-base border theme-border-default theme-radius-input-sm theme-focus theme-bg-elevated px-2 py-1 theme-text-primary"
            >
              <option value="all">全部</option>
              <option value="only">仅固定</option>
              <option value="exclude">排除固定</option>
            </select>
          </div>
        )}

        <div>
          <label
            htmlFor={FILTER_IDS.domain}
            className="block text-sm theme-text-secondary mb-1"
          >
            域名
          </label>
          <input
            id={FILTER_IDS.domain}
            ref={element => {
              fieldRefs.current.domain = element;
            }}
            type="text"
            placeholder="输入域名..."
            value={filters.domain || ''}
            onChange={event => {
              const nextDomain = event.target.value;
              updateFilters(current => ({
                ...current,
                domain: nextDomain || undefined,
              }));
            }}
            className="w-full text-base border theme-border-default theme-radius-input-sm theme-focus theme-bg-elevated px-2 py-1 theme-text-primary"
          />
        </div>

        <div>
          <label
            htmlFor={FILTER_IDS.groupName}
            className="block text-sm theme-text-secondary mb-1"
          >
            会话名称
          </label>
          <input
            id={FILTER_IDS.groupName}
            ref={element => {
              fieldRefs.current.groupName = element;
            }}
            type="text"
            placeholder="输入会话名称..."
            value={filters.groupName || ''}
            onChange={event => {
              const nextGroupName = event.target.value;
              updateFilters(current => ({
                ...current,
                groupName: nextGroupName || undefined,
              }));
            }}
            className="w-full text-base border theme-border-default theme-radius-input-sm theme-focus theme-bg-elevated px-2 py-1 theme-text-primary"
          />
        </div>

        <div>
          <label
            htmlFor={FILTER_IDS.savedWithin}
            className="block text-sm theme-text-secondary mb-1"
          >
            保存时间
          </label>
          <select
            id={FILTER_IDS.savedWithin}
            ref={element => {
              fieldRefs.current.savedWithin = element;
            }}
            value={filters.savedWithin || ''}
            onChange={event => {
              const nextValue = event.target.value as SearchFilters['savedWithin'] | '';
              updateFilters(current => ({
                ...current,
                savedWithin: nextValue || undefined,
              }));
            }}
            className="w-full text-base border theme-border-default theme-radius-input-sm theme-focus theme-bg-elevated px-2 py-1 theme-text-primary"
          >
            <option value="">全部</option>
            <option value="24h">24 小时内</option>
            <option value="7d">7 天内</option>
            <option value="30d">30 天内</option>
            <option value="older">30 天前</option>
          </select>
        </div>

        {/* 排序（1.26.0 新增的**功能**）：展开时进面板，长相与其它字段一致。 */}
        {sortControl}
      </div>
    </div>
  );
};

interface SearchFilterSectionProps {
  controls: SearchFilterControls;
  /** 左侧标题。 */
  title: string;
  /**
   * 是否显示左侧标题。
   *
   * browse（筛选浏览）形态下为 false —— 卡片头已经写着「符合条件的会话」，
   * 筛选区再写一遍「按条件筛选会话」就是同一句话在同一屏里出现两次，
   * 而且两行都长得像标题 ⇒ 视觉噪音。判据见 searchBrowseMode 的
   * `showFilterSectionTitle`（放在那里是为了与形态判定同源）。
   */
  showTitle?: boolean;
  /** 设置里的「保存固定标签页」是否开启。 */
  collectPinnedTabs: boolean;
  /** 面板在哪个语境里渲染（见 SearchFilterVariant）。 */
  variant: SearchFilterVariant;
  /**
   * 是否摆出「排序方式」下拉（默认 true）。
   *
   * ── 为什么需要这个开关（2026-10-23 审计 R-6）────────────────────────────
   *
   * 排序下拉**只在真的按它排序的视图里**才有意义。
   * 而 `SearchFilterSection` 有**两个**渲染点：
   *   · `TabList.tsx` —— 主列表视图（**会**按 `sortSessions` 排）；
   *   · `SearchResultList.tsx` —— 搜索结果 / 筛选浏览视图
   *     （**不按** `sessionSort` 排：搜索视图按相关度，
   *       浏览视图按会话更新时间）。
   *
   * 修复前两个渲染点都摆了这个下拉 ⇒ 在结果视图里选「按名称」，
   * 顺序**一动不动** ⇒ 一个「能选、选了没反应」的控件在骗人。
   *
   * ⇒ 不排序的视图**不摆**这个控件（不是「摆着 + 文案解释它不生效」——
   *   那是把缺陷写进界面）。
   *
   * 【判据放在 prop 上而不是各组件自己判】这样「摆不摆」与
   * 「这个视图排不排序」由**调用方**一句话说清，
   * 不会两个渲染点各判一遍然后漂移。
   */
  showSortControl?: boolean;
}

/**
 * 筛选区 = 工具条（标题 + 「N 个筛选」+ 生效条件 chip + 「清空筛选」+ 「显示筛选」）
 * + 面板。
 *
 * 【徽章与「清空筛选」是「条件生效」的可见证据】
 * 筛选条件生效时用户**必须看得见** —— 「看不见但条件在生效」是本仓反复
 * 修过的那类隐形行为（见 searchFilterAvailability 的注释）。
 *
 * 【生效条件 chip 是「条件是什么」的可见证据】
 * 徽章只说「有 1 个筛选」，不说**是哪一个** —— 条件一旦生效而用户不知道
 * 是哪一个，界面上就出现了「看不见但条件在生效」。所以工具条上再挂一排
 * chip，把**当前生效的值**写出来（域名 github.com），点它直接去改那个维度。
 */
export const SearchFilterSection: React.FC<SearchFilterSectionProps> = ({
  controls,
  title,
  showTitle = true,
  collectPinnedTabs,
  variant,
  showSortControl = true,
}) => {
  const {
    effectiveFilters,
    activeFilterCount,
    isFilterPending,
    clearFilters,
    showFilters,
    toggleFilters,
  } = controls;
  const isInset = variant === 'inset';
  // 排序控件摆在哪（工具条 / 面板）由「面板是否展开」决定；
  // 「摆不摆」由「这个视图排不排序」决定（见 showSortControl 的注释）。
  const sortPlacement = resolveSortControlPlacement(showFilters);
  const toolbarSortControl =
    showSortControl && sortPlacement === 'toolbar' ? (
      <SessionSortControl placement="toolbar" />
    ) : undefined;
  const panelSortControl =
    showSortControl && sortPlacement === 'panel' ? (
      <SessionSortControl placement="panel" />
    ) : undefined;

  /** 生效条件 chip（从**当前生效值**渲染，不是写死的字符串）。 */
  const activeChips = React.useMemo(
    () => buildActiveFilterChips(effectiveFilters),
    [effectiveFilters]
  );

  /** 面板打开后要把焦点送进哪个字段（null = 不送）。 */
  const [focusDimension, setFocusDimension] = React.useState<FilterDimension | null>(null);

  // 面板收起时把「送焦点」的请求作废：否则用户下次自己打开面板时，
  // 焦点会莫名其妙地跳回上一个 chip 指的字段。
  React.useEffect(() => {
    if (!showFilters) setFocusDimension(null);
  }, [showFilters]);

  /**
   * 点工具条上的「生效条件 chip」：**去改那个维度**。
   *
   * 面板是 v1.25.1 的「四个字段同时可见」形态 ⇒ 点 chip 的动作是
   * 「把面板打开 + 焦点送到那个字段」，不是「切这一格的展开状态」。
   */
  const handleEditDimension = React.useCallback(
    (dimension: FilterDimension) => {
      setFocusDimension(dimension);
      if (!showFilters) toggleFilters();
    },
    [showFilters, toggleFilters]
  );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2 px-2">
        <div className="flex flex-wrap items-center gap-2">
          {showTitle && (
            <h3 className="text-sm font-medium theme-text-secondary">{title}</h3>
          )}
          {activeFilterCount > 0 && (
            <span className="theme-accent-soft theme-accent-text rounded-full px-2 py-0.5 text-[11px] font-medium">
              {activeFilterCount} 个筛选
            </span>
          )}
          {activeChips.map(chip => (
            <button
              key={chip.key}
              type="button"
              onClick={() => handleEditDimension(chip.dimension)}
              aria-label={`编辑筛选条件：${chip.label} ${chip.value}`}
              className="inline-flex items-center gap-1 theme-radius-input-sm border theme-border-default theme-bg-elevated px-2 py-0.5 text-xs hover:theme-btn-hover"
            >
              <span className="theme-text-secondary">{chip.label}</span>
              <span className="theme-accent-text font-medium">{chip.value}</span>
            </button>
          ))}
          {isFilterPending && (
            <span className="text-[11px] theme-text-muted">更新结果中...</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {toolbarSortControl}
          {activeFilterCount > 0 && (
            <button
              onClick={clearFilters}
              className="text-xs theme-text-muted hover:theme-text-secondary flat-interaction"
            >
              清空筛选
            </button>
          )}
          <button
            onClick={toggleFilters}
            /* ── 2026-10-23 审计 V-4：命中区必须 ≥ 36px ─────────────────────
             *
             * 原先这个按钮没有任何内边距 / 最小尺寸 ⇒ 实测只有 **68.3 × 20px**
             * （320 / 360 / 390 / 768 / 1280 / 1920px 六个宽度全一样）。
             * 高度 20px 低于 WCAG 2.2 SC 2.5.8 的 24px AA，也低于本仓自订的
             * MIN_HIT_TARGET_PX = 36（见 components/layout/hitTarget.ts）——
             * 它是**全站唯一一个**低于 24px 的可见元素。
             *
             * 320px 下它还会折成两行（实测 67.1 × 40px），`<svg>` 图标孤零零
             * 落在两行文字中间。`whitespace-nowrap` 一并解掉折行，
             * `shrink-0` 保证窄屏下它不被压扁。
             *
             * ⚠️ 这段命中区**不许**跟着 2026-10-24 的界面回退一起退掉：
             * 守卫 `tests/guards/audit20261023UiVisual.test.ts`（V-4）钉着它，
             * 而且它是可达性（WCAG），不是长相。
             */
            className="text-sm theme-accent-text font-medium hover:underline flex items-center gap-1 min-h-9 min-w-9 px-2 shrink-0 whitespace-nowrap flat-interaction"
          >
            <FilterIcon />
            {showFilters ? '隐藏筛选' : '显示筛选'}
          </button>
        </div>
      </div>

      {showFilters && (
        <SearchFilterPanel
          controls={controls}
          collectPinnedTabs={collectPinnedTabs}
          withOuterMargin={isInset}
          sortControl={panelSortControl}
          focusDimension={focusDimension}
        />
      )}
    </>
  );
};

export default SearchFilterPanel;
