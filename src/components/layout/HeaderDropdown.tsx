import React, { useState, useRef, useEffect } from 'react';
import { useAppSelector, useAppDispatch } from '@/store/hooks';
import { signOut } from '@/store/slices/authSlice';
import { deleteAllGroups } from '@/store/slices/tabSlice';
import {
  toggleShowNotifications,
  toggleConfirmBeforeDelete,
  toggleCollectPinnedTabs,
  toggleLayoutMode,
  saveSettings,
} from '@/store/slices/settingsSlice';
import { useToast } from '@/contexts/ToastContext';
import { LoginForm } from '../auth/LoginForm';
import { RegisterForm } from '../auth/RegisterForm';
import { ThemeStyleSelector } from './ThemeStyleSelector';
import { ModalFrame } from '@/components/common/ModalFrame';
import { MenuSection } from './MenuSection';
import { MenuToggleRow } from './MenuToggleRow';
import { ExportImportMenu } from './ExportImportMenu';

interface HeaderDropdownProps {
  onClose: () => void;
}

/** 轻量菜单 —— 只放用户高频需要的操作：账户、外观、数据备份。 */
export const HeaderDropdown: React.FC<HeaderDropdownProps> = ({ onClose }) => {
  const dispatch = useAppDispatch();
  const { isAuthenticated, user } = useAppSelector(state => state.auth);
  const settings = useAppSelector(state => state.settings);
  const [activeTab, setActiveTab] = useState<'login' | 'register'>('login');
  const [showAuthModal, setShowAuthModal] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { showConfirm, showAlert } = useToast();

  // 处理通知开关
  const handleToggleNotifications = async () => {
    dispatch(toggleShowNotifications());
    await dispatch(saveSettings() as any);
  };

  // 处理删除确认开关
  const handleToggleConfirmDelete = async () => {
    dispatch(toggleConfirmBeforeDelete());
    await dispatch(saveSettings() as any);
  };

  // 处理"收集固定页"开关
  const handleToggleCollectPinnedTabs = async () => {
    dispatch(toggleCollectPinnedTabs());
    await new Promise(resolve => setTimeout(resolve, 0));
    await dispatch(saveSettings() as any);
  };

  // 处理点击外部关闭下拉菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  const handleSignOut = () => {
    onClose();
    dispatch(signOut())
      .then(() => console.log('登出成功'))
      .catch(error => console.error('登出失败:', error));
  };

  // 清空所有会话
  const handleDeleteAllGroups = () => {
    const runDeleteAll = () => {
      onClose();

      dispatch(deleteAllGroups())
        .then((result: any) => {
          const count = result.payload?.count || 0;

          showAlert({
            title: '删除成功',
            message: `成功删除了 ${count} 个会话`,
            type: 'success',
            onClose: () => {},
          });
        })
        .catch(error => {
          console.error('删除所有标签组失败:', error);
          showAlert({
            title: '删除失败',
            message: '删除所有会话失败',
            type: 'error',
            onClose: () => {},
          });
        });
    };

    if (!settings.confirmBeforeDelete) {
      runDeleteAll();
      return;
    }

    showConfirm({
      title: '删除确认',
      message: '确定要删除所有会话吗？此操作无法撤销。',
      type: 'danger',
      confirmText: '删除',
      cancelText: '取消',
      onConfirm: runDeleteAll,
      onCancel: () => {},
    });
  };

  return (
    <div
      ref={dropdownRef}
      className="absolute right-0 top-full mt-2 w-64 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-20 max-h-[calc(100vh-8rem)] overflow-y-auto"
    >
      <div className="py-2">
        {isAuthenticated && user ? (
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{user.email}</p>
            <button
              onClick={handleSignOut}
              className="mt-2 w-full text-left px-2 py-1.5 text-sm text-gray-600 dark:text-gray-300 flat-interaction rounded hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center"
              type="button"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              退出登录
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowAuthModal(true)}
            className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 flat-interaction flex items-center"
            type="button"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
            </svg>
            登录 / 注册
          </button>
        )}

        {/* 外观：主题 + 布局 */}
        <MenuSection title="外观">
          <button
            onClick={() => {
              onClose();
              dispatch(toggleLayoutMode() as any);
              dispatch(saveSettings() as any);
            }}
            className="w-full text-left px-2 py-1.5 text-sm text-gray-700 dark:text-gray-300 flat-interaction rounded hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center"
            type="button"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 5a1 1 0 011-1h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM8 21V3" />
            </svg>
            {settings.layoutMode === 'single' ? '切换到双栏布局' : '切换到单栏布局'}
          </button>
          <ThemeStyleSelector />
        </MenuSection>

        {/* 工具：清理重复 + 导入导出 */}
        <ExportImportMenu onClose={onClose} />

        {/* 通用设置 */}
        <MenuSection title="设置">
          <MenuToggleRow
            label="通知提醒"
            checked={settings.showNotifications}
            onChange={handleToggleNotifications}
            ariaLabel="通知提醒"
          />
          <MenuToggleRow
            label="删除前确认"
            checked={settings.confirmBeforeDelete}
            onChange={handleToggleConfirmDelete}
            ariaLabel="删除前确认"
          />
          <MenuToggleRow
            label="保存固定标签页"
            checked={settings.collectPinnedTabs}
            onChange={handleToggleCollectPinnedTabs}
            ariaLabel="保存固定标签页"
          />
        </MenuSection>

        <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>

        {/* 危险操作 */}
        <button
          onClick={handleDeleteAllGroups}
          className="w-full text-left px-4 py-2 text-sm text-rose-600 dark:text-rose-400 flat-interaction flex items-center hover:bg-rose-50 dark:hover:bg-rose-900/20"
          type="button"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          清空所有会话
        </button>
      </div>

      {/* 登录/注册弹窗 */}
      {showAuthModal && (
        <ModalFrame
          visible={showAuthModal}
          onClose={() => setShowAuthModal(false)}
          title={activeTab === 'login' ? '登录' : '注册'}
        >
          <div className="mb-4 flex gap-2">
            <button
              onClick={() => setActiveTab('login')}
              className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                activeTab === 'login'
                  ? 'bg-primary-600 text-white'
                  : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
              }`}
              type="button"
            >
              登录
            </button>
            <button
              onClick={() => setActiveTab('register')}
              className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                activeTab === 'register'
                  ? 'bg-primary-600 text-white'
                  : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
              }`}
              type="button"
            >
              注册
            </button>
          </div>
          {activeTab === 'login' ? (
            <LoginForm
              onSuccess={() => {
                setShowAuthModal(false);
                onClose();
              }}
            />
          ) : (
            <RegisterForm
              onSuccess={() => {
                setShowAuthModal(false);
                onClose();
              }}
            />
          )}
        </ModalFrame>
      )}
    </div>
  );
};

export default HeaderDropdown;
