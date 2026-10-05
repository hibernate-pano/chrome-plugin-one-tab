import React, { useState, useTransition } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import {
  toggleLayoutMode,
  saveSettings,
  updateSettings,
} from '@/store/slices/settingsSlice';
import { cleanDuplicateTabs } from '@/store/slices/tabSlice';
import { HeaderDropdown } from './HeaderDropdown';
import { AuthModal, AuthTab } from '@/components/auth/AuthModal';
import { useToast } from '@/contexts/ToastContext';
import { TabCounter } from './TabCounter';
import SyncButton from '@/components/sync/SyncButton';
import { SimpleThemeToggle } from './SimpleThemeToggle';
import { LayoutMode } from '@/types/tab';
import { useDebouncedSearch } from '@/hooks/useDebouncedSearch';
import { Tooltip } from '@/components/common/Tooltip';
import { TapStackLogo } from '@/components/common/TapStackIcon';
import { cleanDuplicatesResultMessage } from './cleanDuplicatesMessage';
import { logError } from '../../utils/log';

interface HeaderProps {
  onSearch: (query: string) => void;
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

// 单栏：一个整框（换掉旧的三横线——和菜单图标撞形）
const LayoutSingleIcon = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <rect x="3.75" y="5.25" width="16.5" height="13.5" rx="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// 双栏：整框 + 中缝
const LayoutDoubleIcon = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <rect x="3.75" y="5.25" width="16.5" height="13.5" rx="1.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12 5.25v13.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const CleanIcon = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
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

export const Header: React.FC<HeaderProps> = ({ onSearch }) => {
  const dispatch = useAppDispatch();
  const { showConfirm, showAlert, showToast } = useToast();
  const settings = useAppSelector(state => state.settings);
  // 清理重复标签的进行中标志：只用来禁点 + 转圈，不阻塞界面。
  const [isCleaningDuplicates, setIsCleaningDuplicates] = React.useState(false);

  const { searchValue, debouncedValue, handleSearchChange, clearSearch, isSearching } = useDebouncedSearch();
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const [isSearchTransitionPending, startSearchTransition] = useTransition();

  const handleCleanDuplicateTabs = () => {
    if (isCleaningDuplicates) return;
    showConfirm({
      title: '确认清理重复标签和空会话',
      message:
        '将清理所有会话中 URL 相同的重复标签页（每个 URL 只保留最新的一个），并删除没有任何标签页的空会话（锁定的会话除外）。\n此操作无法撤销。',
      type: 'warning',
      confirmText: '确认清理',
      cancelText: '取消',
      // 不要在确认弹窗里等清理跑完：大批量去重 + 成百上千条删除广播登记会有可见
      // 耗时，挂着弹窗转圈就是用户说的「卡住」。确认即关窗，清理在后台进行，
      // 完成时列表由 Redux 自然更新并报出清理结果；失败再弹提示。
      onConfirm: () => {
        void (async () => {
          setIsCleaningDuplicates(true);
          try {
            const result = await dispatch(cleanDuplicateTabs()).unwrap();
            // 清理是有成效的操作，结果必须让用户看见——静默会让「点了一下没反应」
            // 与「真的没东西可清」无法区分。
            //
            // 计数取自 SW 回传的权威计划，而不是本地乐观算出的那份：popup 的
            // state.groups 可能陈旧，本地计数会与实际落盘结果不符（见 tabSlice
            // 的 cleanDuplicateTabs 注释）。列表更新在 pending 阶段就已经发生了。
            showToast(
              cleanDuplicatesResultMessage(
                result.plan.removedTabsCount,
                result.plan.removedGroupsCount,
              ),
              'success',
              4000,
            );
          } catch (error) {
            logError('清理重复标签失败:', error);
            showAlert({
              title: '清理失败',
              message: '清理重复标签失败，请重试',
              type: 'error',
              onClose: () => { },
            });
          } finally {
            setIsCleaningDuplicates(false);
          }
        })();
      },
      onCancel: () => { },
    });
  };

  const handleToggleLayout = () => {
    dispatch(toggleLayoutMode());

    let nextLayoutMode: LayoutMode;
    switch (settings.layoutMode) {
      case 'single':
        nextLayoutMode = 'double';
        break;
      case 'double':
        nextLayoutMode = 'single';
        break;
      default:
        nextLayoutMode = 'single';
    }

    // 先更新 Redux state
    dispatch(updateSettings({
      layoutMode: nextLayoutMode,
    }));
    
    // 然后保存到存储
    dispatch(saveSettings() as any);
  };

  const handleSaveAllTabs = async () => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const windowId = tabs[0]?.windowId;
    chrome.runtime.sendMessage({
      type: 'SAVE_ALL_TABS',
      data: { windowId },
    });
  };

  const getContainerWidthClass = () => {
    // 统一使用相同宽度，单栏和双栏布局保持一致
    return 'layout-double-width';
  };

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
  };

  const [showDropdown, setShowDropdown] = useState(false);
  // 账号弹窗是应用级关注点：挂在 Header 上、portal 到 body，
  // 不随菜单开关而卸载（菜单点完就关，弹窗独立存活）。
  const [authModal, setAuthModal] = useState<AuthTab | null>(null);

  return (
    <header className="header">
      <div className={`w-full py-3 px-4 sm:px-6 ${getContainerWidthClass()}`}>
        <div className="flex items-center justify-between gap-4">
          {/* Logo 区域 */}
          <button
            onClick={handleResetToDefaultView}
            className="flex items-center gap-3 group flat-interaction"
            title="回到默认视图"
            aria-label="回到默认视图"
          >
            <TapStackLogo size="sm" showIcon={true} />
            <div className="hidden sm:block">
              <TabCounter />
            </div>
          </button>

          {/* 搜索框 */}
          <div className="flex-1 max-w-md mx-4">
            <div className="relative">
              {isSearchBusy && (
                <div className="absolute left-3 top-1/2 -translate-y-1/2 search-icon">
                  <LoadingIcon />
                </div>
              )}
              <input
                ref={searchInputRef}
                type="text"
                placeholder="搜索会话、备注或标签..."
                className={`input search-input theme-focus w-full py-2 text-sm ${isSearchBusy ? 'pl-10' : 'pl-3'}`}
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
                  className="absolute right-3 top-1/2 -translate-y-1/2 search-clear-btn flat-interaction transition-colors"
                  title="清空搜索"
                  aria-label="清空搜索"
                >
                  <CloseIcon />
                </button>
              )}
            </div>
          </div>

          {/* 操作按钮组 */}
          <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
            {/* 布局切换 */}
            <Tooltip
              content={settings.layoutMode === 'single' ? '切换双栏布局' : '切换单栏布局'}
              position="bottom"
            >
              <button
                onClick={handleToggleLayout}
                className="btn-icon flat-interaction"
                aria-label={settings.layoutMode === 'single' ? '切换为双栏布局' : '切换为单栏布局'}
              >
                {settings.layoutMode === 'single' ? <LayoutSingleIcon /> : <LayoutDoubleIcon />}
              </button>
            </Tooltip>

            {/* 清理重复 */}
            <Tooltip content="清理重复标签" position="bottom">
              <button
                onClick={handleCleanDuplicateTabs}
                disabled={isCleaningDuplicates}
                className="btn-icon flat-interaction"
                aria-label="清理重复标签页"
                aria-busy={isCleaningDuplicates}
              >
                {isCleaningDuplicates ? <LoadingIcon /> : <CleanIcon />}
              </button>
            </Tooltip>

            {/* 主题切换 */}
            <SimpleThemeToggle />

            {/* 同步按钮 */}
            <SyncButton />

            {/* 保存按钮 */}
            <Tooltip content="保存当前窗口为会话" position="bottom">
              <button
                onClick={handleSaveAllTabs}
                className="btn btn-primary flat-interaction hidden sm:flex whitespace-nowrap"
                aria-label="保存当前窗口中的所有标签页为会话"
              >
                <SaveIcon />
                <span>保存会话</span>
              </button>
              <button
                onClick={handleSaveAllTabs}
                className="btn btn-primary flat-interaction sm:hidden p-2"
                aria-label="保存当前窗口中的所有标签页为会话"
              >
                <SaveIcon />
              </button>
            </Tooltip>

            {/* 更多菜单。aria-expanded/haspopup 是菜单按钮的最低契约：
                读屏要能播报「已折叠/已展开，菜单按钮」，
                引导第 5 步的聚光灯也锚在这个 aria-label 上。 */}
            <div className="relative">
              <button
                onClick={() => setShowDropdown(!showDropdown)}
                className="btn-icon flat-interaction"
                aria-label="菜单"
                aria-haspopup="menu"
                aria-expanded={showDropdown}
              >
                <MenuIcon />
              </button>
              {showDropdown && (
                <HeaderDropdown
                  onClose={() => setShowDropdown(false)}
                  onOpenAuth={(tab) => {
                    setShowDropdown(false);
                    setAuthModal(tab);
                  }}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      <AuthModal
        visible={authModal !== null}
        initialTab={authModal ?? 'login'}
        onClose={() => setAuthModal(null)}
      />
    </header>
  );
};

export default Header;
