import React, { useTransition } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { setReorderMode, saveSettings } from '@/store/slices/settingsSlice';
import { selectReorderMode } from '@/store/selectors/tabSelectors';
import { TabCounter } from './TabCounter';
import { SyncStatusInline } from './SyncStatusInline';
import { useDebouncedSearch } from '@/hooks/useDebouncedSearch';
import { useKeyboardShortcuts, COMMON_SHORTCUTS } from '@/hooks/useKeyboardShortcuts';
import { Tooltip } from '@/components/common/Tooltip';
import { TabStackLogo } from '@/components/common/TabStackIcon';

interface HeaderProps {
  onSearch: (query: string) => void;
  onOpenSettings: () => void;
}

// 图标组件
const LoadingIcon = () => (
  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
  </svg>
);

const CloseIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
  </svg>
);

const MenuIcon = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z" />
  </svg>
);

const SaveIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
  </svg>
);

export const Header: React.FC<HeaderProps> = ({ onSearch, onOpenSettings }) => {
  const dispatch = useAppDispatch();
  // 只订阅 reorderMode 字段 —— 旧实现 `state => state.settings` 订阅整个
  // settings slice，任何设置变更都会重渲染 Header。
  const reorderMode = useAppSelector(selectReorderMode);

  const { searchValue, debouncedValue, handleSearchChange, clearSearch, isSearching } = useDebouncedSearch();
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const [isSearchTransitionPending, startSearchTransition] = useTransition();

  const handleSaveAllTabs = async () => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const windowId = tabs[0]?.windowId;
    chrome.runtime.sendMessage({
      type: 'SAVE_ALL_TABS',
      data: { windowId },
    });
  };

  useKeyboardShortcuts([
    { ...COMMON_SHORTCUTS.SAVE_TABS, action: handleSaveAllTabs },
    { ...COMMON_SHORTCUTS.SEARCH, action: () => searchInputRef.current?.focus() },
    { ...COMMON_SHORTCUTS.CLEAR_SEARCH, action: () => { if (searchValue) clearSearch(); } },
  ]);

  React.useEffect(() => {
    startSearchTransition(() => {
      onSearch(debouncedValue);
    });
  }, [debouncedValue, onSearch]);

  const isSearchBusy = isSearching || isSearchTransitionPending;

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleSearchChange(e.target.value);
  };

  const handleClearSearch = () => {
    clearSearch();
  };

  const handleResetToDefaultView = () => {
    clearSearch();
    if (reorderMode) {
      // 先更新 Redux state
      dispatch(setReorderMode(false));

      // 然后保存到存储
      dispatch(saveSettings() as any);
    }
  };

  return (
    <header className="header rounded-xl shadow-sm">
      <div className="w-full py-4 px-4 sm:px-6 layout-double-width">
        <div className="flex items-center justify-between gap-1.5 sm:gap-4">
          {/* Logo 区域 */}
          <button
            onClick={handleResetToDefaultView}
            className="flex items-center gap-1.5 sm:gap-3 group flat-interaction flex-shrink-0"
            title="回到默认视图"
            aria-label="回到默认视图"
          >
            {/* 380px popup 下隐藏 "TabStack" 文字，仅保留图标，给搜索框腾出空间 */}
            <TabStackLogo size="sm" showIcon={true} className="font-bold [&>span]:hidden sm:[&>span]:inline" />
            <div className="block">
              <TabCounter />
            </div>
          </button>

          {/* 搜索框 */}
          <div className="flex-1 min-w-0 max-w-md mx-1 sm:mx-4">
            <div className="relative shadow-sm">
              {isSearchBusy && (
                <div className="absolute left-3 top-1/2 -translate-y-1/2 search-icon">
                  <LoadingIcon />
                </div>
              )}
              <input
                ref={searchInputRef}
                type="text"
                placeholder="搜索会话、备注或标签..."
                className={`input search-input w-full py-2 text-sm rounded-lg focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 ${isSearchBusy ? 'pl-10' : 'pl-3'}`}
                onChange={handleSearch}
                value={searchValue}
                aria-label="搜索会话、备注或标签页"
                role="searchbox"
                autoComplete="off"
                aria-busy={isSearchBusy}
              />
              {searchValue && (
                <button
                  onClick={handleClearSearch}
                  className="absolute right-3 top-1/2 -translate-y-1/2 search-clear-btn flat-interaction transition-colors hover:bg-secondary/20"
                  title="清空搜索"
                >
                  <CloseIcon />
                </button>
              )}
            </div>
          </div>

          {/* 操作按钮组 */}
          <div className="flex items-center gap-1 flex-shrink-0">
            {/* 保存按钮：popup 始终显示文字标签 */}
            <Tooltip content="保存当前窗口为会话" position="bottom">
              <button
                onClick={handleSaveAllTabs}
                className="btn btn-primary flat-interaction flex items-center gap-1 whitespace-nowrap px-2 sm:px-3 text-sm"
                aria-label="保存当前窗口中的所有标签页为会话"
              >
                <SaveIcon />
                <span>保存会话</span>
              </button>
            </Tooltip>

            {/* F10: 同步快捷入口（仅登录可见，自带拆分按钮 + popover） */}
            <SyncStatusInline onOpenSettings={onOpenSettings} />

            {/* Kebab 菜单 - 触发 SettingsTabs（在 MainApp 内 lazy 加载） */}
            <Tooltip content="设置" position="bottom">
              <button
                onClick={onOpenSettings}
                className="btn-icon flat-interaction hover:scale-105 focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2"
                aria-label="打开设置"
              >
                <MenuIcon />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    </header>
  );
};

export default Header;
