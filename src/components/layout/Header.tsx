import React, { useState, useTransition } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import {
  toggleLayoutMode,
  dispatchSaveSettings,
  updateSettings,
} from '@/store/slices/settingsSlice';
import { cleanDuplicateTabs, deleteBroadcastWarn } from '@/store/slices/tabSlice';
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
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { cleanDuplicatesConfirmMessage, cleanDuplicatesResultMessage } from './cleanDuplicatesMessage';
import { saveAndCloseDescription, saveAndCloseLabel, saveAndCloseShortLabel } from './saveActionCopy';
import { planCleanDuplicates } from '@/core/mutationOps';
import { storage } from '@/utils/storage';
import { logError, logWarn } from '../../utils/log';

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
  const groups = useAppSelector(state => state.tabs.groups);
  // 清理重复标签的进行中标志：只用来禁点 + 转圈，不阻塞界面。
  const [isCleaningDuplicates, setIsCleaningDuplicates] = React.useState(false);

  const { searchValue, debouncedValue, handleSearchChange, clearSearch, isSearching } = useDebouncedSearch();
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const [isSearchTransitionPending, startSearchTransition] = useTransition();

  const handleCleanDuplicateTabs = async () => {
    if (isCleaningDuplicates) return;
    // ── 2026-10-19：确认前算真实波及范围 ─────────────────────────────────
    // 五个破坏性动作里，只有清理重复标签此前是「不告诉你会删掉多少」就让你点确认。
    // 而 1.22.0 起删除即物理清除、无回收站 —— 同意的那一刻看不到范围。
    //
    // 计数用 planCleanDuplicates（纯函数）：SW 执行时用的是**同一份**判据
    // （mutationHandlers → applyCleanDuplicates → planCleanDuplicates），
    // 所以这里的数字就是真实会发生的，不是估算。
    //
    // 输入取 storage 真值而不是 Redux：Redux 可能落后于磁盘（外部写入 /
    // 尚未回环），而确认框报错数字比不报更糟。读失败时退回 Redux 现值 ——
    // 至少还有一份可用的快照，且确认文案会如实反映它。
    let localGroups = groups;
    try {
      localGroups = await storage.getGroupsForWrite();
    } catch (error) {
      logWarn('[Header] 清理前读取真实会话失败，改用界面当前快照计算清理范围:', error);
    }
    const plan = planCleanDuplicates(localGroups);

    // 没东西可清时不该摆一道「确认清理」的破坏性弹窗：让用户点一次「确认清理」
    // 才告诉他其实什么都没删，与「点了没反应」同类。直接说清即可。
    if (plan.removedTabsCount === 0 && plan.removedGroupsCount === 0) {
      showToast(cleanDuplicatesConfirmMessage(0, 0), 'info', 4000);
      return;
    }

    showConfirm({
      title: '确认清理重复标签和空会话',
      message: cleanDuplicatesConfirmMessage(plan.removedTabsCount, plan.removedGroupsCount),
      // ── 2026-10-19 审计 V-5：这个动作是不可撤销的删除，确认按钮必须是 danger ──
      // 确认文案里已经明写「此操作无法撤销」，而按钮却是 warning 琥珀色
      // （bg-amber-700）—— 与「删除所有会话」的 rose 红不是同一套语言。
      // 用户会把琥珀读成「提醒一下」而不是「要真删」。
      // 破坏性动作的按钮语言必须与它的后果一致：不可撤销 ⇒ danger。
      type: 'danger',
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
                result.value.plan.removedTabsCount,
                result.value.plan.removedGroupsCount,
              ),
              'success',
              4000,
            );
            // 清理会物理移除整组（空会话）。本地已删干净，但若云端删除广播
            // 登记失败，这些会话会在其它设备上复活——必须如实告知，不能让
            // 「清理成功」的成功提示盖过去。
            const warn = deleteBroadcastWarn(result);
            if (warn) {
              showAlert({
                title: '清理未完全同步',
                message: warn,
                type: 'warning',
                onClose: () => { },
              });
            }
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

  // async：末尾要 await 保存结果并出声（React 对事件处理器返回 Promise 无要求）
  const handleToggleLayout = async () => {
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
    
    // 然后保存到存储；失败必须出声（否则开关保持新状态、刷新后回退，全程无声）
    const saveError = await dispatchSaveSettings(dispatch);
    if (saveError) showToast(saveError, 'error');
  };

  const handleSaveAllTabs = async () => {
    // 2026-10-07 专家团体检 P1-3：原先只 sendMessage 不 await、不处理回包，
    // 于是整个保存主流程在页内零反馈 —— 用户点了之后眼前一空（当前窗口标签被
    // 全部关掉、另开一个标签页），无法判断是保存了、崩了、还是页面跳转了。
    // 唯一的反馈是一条系统通知，而通知在部分系统上会被专注助手吞掉。
    //
    // 项目自己的原则是「用户按了键没反应必须有一句话解释」，这条正是它的反例。
    // 现在：await 回包 + 按钮 inline 反馈 + 失败时明确出声。
    if (isSaving) return;
    setIsSaving(true);
    setSaveFeedback(null);
    try {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const windowId = tabs[0]?.windowId;
      const response = await chrome.runtime.sendMessage({
        type: 'SAVE_ALL_TABS',
        data: { windowId },
      });
      if (response?.success) {
        setSaveFeedback({ kind: 'success', text: '已保存' });
      } else {
        setSaveFeedback({
          kind: 'error',
          text: response?.error || '保存失败，请重试',
        });
      }
    } catch (error) {
      // sendMessage 在 SW 被回收 / 扩展重载时可能整体 reject
      logError('保存会话失败:', error);
      setSaveFeedback({ kind: 'error', text: '保存失败，请重试' });
    } finally {
      setIsSaving(false);
    }
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

  // 保存按钮的 in-flight 与结果反馈（2026-10-07 P1-3）。
  // 保存是本页唯一会「摧毁用户当前工作现场」的动作（关掉整个窗口的标签），
  // 必须让用户看得见结果 —— 哪怕标签已经关掉了。
  // 成功轻提示 3s 自动退场，失败常驻到下次操作（与 TabList 空态 CTA 同口径）。
  const [isSaving, setIsSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(
    null
  );
  // 账号弹窗是应用级关注点：挂在 Header 上、portal 到 body，
  // 不随菜单开关而卸载（菜单点完就关，弹窗独立存活）。
  const [authModal, setAuthModal] = useState<AuthTab | null>(null);

  // 成功是轻提示：3 秒后自动退场；失败常驻到下次保存（与空态 CTA 同口径）
  React.useEffect(() => {
    if (saveFeedback?.kind !== 'success') return;
    const timer = setTimeout(() => setSaveFeedback(null), 3000);
    return () => clearTimeout(timer);
  }, [saveFeedback]);

  return (
    <header className="header">
      <div className={`w-full py-2.5 sm:py-3 px-3 sm:px-6 ${getContainerWidthClass()}`}>
        <div className="app-header-grid">
          {/* Logo 区域 */}
          <button
            onClick={handleResetToDefaultView}
            className="app-header-brand flex items-center gap-2 sm:gap-3 group flat-interaction min-w-0"
            title="回到默认视图"
            aria-label="回到默认视图"
          >
            <span className="flex-shrink-0">
              <TapStackLogo size="sm" showIcon={true} nameClassName="app-header-brand-name" />
            </span>
            <div className="app-header-brand-meta hidden sm:block">
              <TabCounter />
            </div>
          </button>

          {/* 搜索框：图标位常驻占位，spinner 原位替换，避免输入中 pl-3→pl-10 整行跳动 */}
          <div className="app-header-search">
            <div className="relative" role="search">
              <div className="absolute left-3 top-1/2 -translate-y-1/2 search-icon" aria-hidden="true">
                {isSearchBusy ? <LoadingIcon /> : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                )}
              </div>
              <input
                ref={searchInputRef}
                type="text"
                placeholder="搜索会话或标签..."
                className="input search-input theme-focus w-full py-2 pl-10 text-sm"
                onChange={handleSearch}
                value={searchValue}
                aria-label="搜索会话或标签页"
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
          <nav className="app-header-actions" aria-label="会话操作">
            {/* 布局切换。窄屏收进菜单：顶栏宽度优先给搜索，
                布局切换是低频偏好设置，不值得占掉信息获取入口的位置。 */}
            <div className="hidden sm:block">
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
            </div>

            {/* 清理重复。同上：低频、破坏性，收进菜单更合适。 */}
            <div className="hidden sm:block">
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
            </div>

            {/* 主题切换 */}
            <SimpleThemeToggle />

            {/* 同步按钮 */}
            <SyncButton />

            {/* 保存按钮。
                **可见文字本身就带「关闭」**（2026-10-19 审计 I-3）：原先可见文字
                只有「保存会话」，「并关闭这些标签页」只写在 hover 300ms 才出现的
                tooltip 和 aria-label 里 —— 鼠标快速点击、触屏、窄屏用户全程
                看不到，而点下去当前窗口就被清空了。
                现在可见文案 = saveAndCloseLabel（与空态 CTA 逐字同源，
                见 components/layout/saveActionCopy.ts），文案与行为不可能漂移。

                ── 2026-10-19 审计 I-1：空态时降为次级按钮 ──────────────────
                新用户第一屏上，顶栏「保存并关闭标签」与空态卡里的主 CTA
                做的是**同一件事**（同一个 SAVE_ALL_TABS + 关闭标签），却是两个
                同色主按钮 —— 用户要在两个蓝色按钮之间猜哪一个是真的。
                空态时顶栏这一颗降为次级样式（.btn-secondary），让空态卡的
                CTA 成为**唯一**的主操作；有会话之后（空态卡不渲染）顶栏恢复
                主按钮样式。 */}
            <Tooltip content={saveAndCloseDescription} position="bottom">
              <button
                onClick={handleSaveAllTabs}
                disabled={isSaving}
                className={`btn ${groups.length === 0 ? 'btn-secondary' : 'btn-primary'} flat-interaction whitespace-nowrap shrink-0 px-3 sm:px-4 disabled:opacity-60 disabled:cursor-not-allowed`}
                aria-label={saveAndCloseDescription}
                aria-busy={isSaving}
              >
                {isSaving ? <LoadingSpinner size="sm" className="text-current" /> : <SaveIcon />}
                <span className="hidden sm:inline whitespace-nowrap">
                  {isSaving
                    ? '保存中…'
                    : saveFeedback?.kind === 'error'
                      ? saveFeedback.text
                      : saveFeedback?.kind === 'success'
                        ? saveFeedback.text
                        : saveAndCloseLabel}
                </span>
                <span className="sm:hidden" aria-hidden="true">
                  {isSaving ? '保存中' : saveFeedback?.kind === 'success' ? '已保存' : saveAndCloseShortLabel}
                </span>
              </button>
            </Tooltip>

            {/* 更多菜单。aria-expanded/haspopup 是菜单按钮的最低契约：
                读屏要能播报「已折叠/已展开，菜单按钮」，
                引导第 5 步的聚光灯也锚在这个 aria-label 上。
                2026-10-18 round 38：data-menu-trigger 给菜单的「外部点击关闭」
                一个可跳过本按钮的判据 —— 同一个 click 里 onClick 先开菜单、
                事件继续冒泡到 document，不跳过就会把刚打开的菜单立刻关掉。 */}
            <div className="relative">
              <button
                onClick={() => setShowDropdown(!showDropdown)}
                className="btn-icon flat-interaction"
                aria-label="菜单"
                aria-haspopup="menu"
                aria-expanded={showDropdown}
                data-menu-trigger
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
                  onToggleLayout={() => {
                    void handleToggleLayout();
                  }}
                  onRequestCleanDuplicates={() => {
                    handleCleanDuplicateTabs();
                  }}
                />
              )}
            </div>
          </nav>
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
