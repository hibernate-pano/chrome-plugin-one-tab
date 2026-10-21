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
 */
import React from 'react';
import type { SearchFilters } from '@/utils/search';
import type { SearchFilterControls } from './searchFilterState';

/**
 * 筛选控件的 id 前缀：同一时刻只有一个筛选面板，固定前缀即可保证 label 唯一。
 */
export const FILTER_IDS = {
  pinned: 'search-filter-pinned',
  domain: 'search-filter-domain',
  groupName: 'search-filter-group-name',
  savedWithin: 'search-filter-saved-within',
} as const;

const FilterIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a2 0 01-.293.707l-6.414 6.414a2 0 00-.293.707V17l-4 4v-6.586a2 0 00-.293-.707L3.293 7.207A2 0 013 6.5V4z" />
);

interface SearchFilterPanelProps {
  controls: SearchFilterControls;
  /** 设置里的「保存固定标签页」是否开启（关闭时这个筛选项是死控件，不渲染）。 */
  collectPinnedTabs: boolean;
  /** 面板是否带左右外边距（结果视图里的面板要缩进，列表层的不要）。 */
  withOuterMargin?: boolean;
}

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

/**
 * 筛选面板本体：四个筛选控件。
 *
 * 【固定标签页筛选器只在「保存固定标签页」开启时才有意义】——
 * 关闭时存进会话的标签 `pinned` 恒为 false，这个筛选器形同虚设。
 * 摆在用户面前还占一行，就是「选项在骗用户」（见 searchFilterAvailability）。
 */
export const SearchFilterPanel: React.FC<SearchFilterPanelProps> = ({
  controls,
  collectPinnedTabs,
  withOuterMargin,
}) => {
  const { filters, updateFilters } = controls;

  return (
    <div className={`theme-well theme-radius-control p-3 sm:p-4 mb-3 ${withOuterMargin ? 'mx-2' : ''}`}>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
        {collectPinnedTabs && (
          <div>
            <label
              htmlFor={FILTER_IDS.pinned}
              className="block text-xs text-gray-600 dark:text-gray-300 mb-1"
            >
              固定标签页
            </label>
            <select
              id={FILTER_IDS.pinned}
              value={filters.pinned || 'all'}
              onChange={event => {
                const nextPinned = event.target.value as SearchFilters['pinned'];
                updateFilters(current => ({
                  ...current,
                  pinned: nextPinned === 'all' ? undefined : nextPinned,
                }));
              }}
              className="w-full text-sm border theme-border-default theme-radius-input-sm theme-focus theme-bg-elevated px-2 py-1 text-gray-900 dark:text-gray-100"
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
            className="block text-xs text-gray-600 dark:text-gray-300 mb-1"
          >
            域名
          </label>
          <input
            id={FILTER_IDS.domain}
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
            className="w-full text-sm border theme-border-default theme-radius-input-sm theme-focus theme-bg-elevated px-2 py-1 text-gray-900 dark:text-gray-100"
          />
        </div>

        <div>
          <label
            htmlFor={FILTER_IDS.groupName}
            className="block text-xs text-gray-600 dark:text-gray-300 mb-1"
          >
            会话名称
          </label>
          <input
            id={FILTER_IDS.groupName}
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
            className="w-full text-sm border theme-border-default theme-radius-input-sm theme-focus theme-bg-elevated px-2 py-1 text-gray-900 dark:text-gray-100"
          />
        </div>

        <div>
          <label
            htmlFor={FILTER_IDS.savedWithin}
            className="block text-xs text-gray-600 dark:text-gray-300 mb-1"
          >
            保存时间
          </label>
          <select
            id={FILTER_IDS.savedWithin}
            value={filters.savedWithin || ''}
            onChange={event => {
              const nextValue = event.target.value as SearchFilters['savedWithin'] | '';
              updateFilters(current => ({
                ...current,
                savedWithin: nextValue || undefined,
              }));
            }}
            className="w-full text-sm border theme-border-default theme-radius-input-sm theme-focus theme-bg-elevated px-2 py-1 text-gray-900 dark:text-gray-100"
          >
            <option value="">全部</option>
            <option value="24h">24 小时内</option>
            <option value="7d">7 天内</option>
            <option value="30d">30 天内</option>
            <option value="older">30 天前</option>
          </select>
        </div>
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
}

/**
 * 筛选区 = 工具条（标题 + 「N 个筛选」+ 「清空筛选」+ 「显示筛选」）+ 面板。
 *
 * 【徽章与「清空筛选」是「条件生效」的可见证据】
 * 筛选条件生效时用户**必须看得见** —— 「看不见但条件在生效」是本仓反复
 * 修过的那类隐形行为（见 searchFilterAvailability 的注释）。
 */
export const SearchFilterSection: React.FC<SearchFilterSectionProps> = ({
  controls,
  title,
  showTitle = true,
  collectPinnedTabs,
  variant,
}) => {
  const {
    activeFilterCount,
    isFilterPending,
    clearFilters,
    showFilters,
    toggleFilters,
  } = controls;
  const isInset = variant === 'inset';

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2 px-2">
        <div className="flex items-center gap-2">
          {showTitle && (
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">{title}</h3>
          )}
          {activeFilterCount > 0 && (
            <span className="theme-accent-soft theme-accent-text rounded-full px-2 py-0.5 text-[11px] font-medium">
              {activeFilterCount} 个筛选
            </span>
          )}
          {isFilterPending && (
            <span className="text-[11px] theme-text-muted">更新结果中...</span>
          )}
        </div>
        <div className="flex items-center gap-3">
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
            className="text-xs text-primary-600 dark:text-primary-400 hover:underline flex items-center flat-interaction"
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
        />
      )}
    </>
  );
};

export default SearchFilterPanel;
