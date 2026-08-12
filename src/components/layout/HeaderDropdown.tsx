import React, { useState, useRef, useEffect } from 'react';
import { useAppSelector, useAppDispatch } from '@/store/hooks';
import { signOut } from '@/store/slices/authSlice';
import { cleanDuplicateTabs, deleteAllGroups } from '@/store/slices/tabSlice';
import {
  toggleShowNotifications,
  toggleConfirmBeforeDelete,
  toggleCollectPinnedTabs,
  toggleLayoutMode,
  saveSettings,
} from '@/store/slices/settingsSlice';
import { syncService } from '@/services/syncService';
import { storage } from '@/utils/storage';
import { useToast } from '@/contexts/ToastContext';
import { LoginForm } from '../auth/LoginForm';
import { RegisterForm } from '../auth/RegisterForm';
import { ThemeStyleSelector } from './ThemeStyleSelector';
import { ModalFrame } from '@/components/common/ModalFrame';
import { trackProductEvent } from '@/utils/productEvents';

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
  const [openSubmenu, setOpenSubmenu] = useState<'export' | 'import' | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const jsonImportRef = useRef<HTMLInputElement>(null);
  const oneTabImportRef = useRef<HTMLInputElement>(null);
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

  // 清理重复标签
  const handleCleanDuplicateTabs = async () => {
    onClose();
    try {
      const result = await dispatch(cleanDuplicateTabs() as any).unwrap();
      const removed = result?.removedCount ?? 0;
      showAlert({
        title: '清理完成',
        message: removed > 0 ? `已清理 ${removed} 个重复标签` : '没有发现重复标签',
        type: 'success',
        onClose: () => {},
      });
    } catch (error) {
      showAlert({
        title: '清理失败',
        message: '清理重复标签失败，请重试',
        type: 'error',
        onClose: () => {},
      });
    }
  };

  // 清空所有会话
  const handleDeleteAllGroups = () => {
    const runDeleteAll = () => {
      onClose();

      dispatch(deleteAllGroups())
        .then((result: any) => {
          const count = result.payload?.count || 0;

          if (isAuthenticated) {
            syncService.uploadToCloud(true, true)
              .then(() => console.log('删除操作已同步到云端'))
              .catch(error => console.error('同步到云端失败:', error));
          }

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

  // 导出数据为 JSON 格式
  const handleExportData = async () => {
    try {
      setOpenSubmenu(null);
      const exportData = await storage.exportData();
      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: 'application/json',
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const date = new Date();
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      a.download = `tabstack-backup-${year}-${month}-${day}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      onClose();
    } catch (error) {
      console.error('导出数据失败:', error);
      showAlert({
        title: '导出失败',
        message: '导出数据失败，请重试',
        type: 'error',
        onClose: () => {},
      });
    }
  };

  // 导出数据为 OneTab 格式
  const handleExportOneTabFormat = async () => {
    try {
      setOpenSubmenu(null);
      const oneTabText = await storage.exportToOneTabFormat();
      const blob = new Blob([oneTabText], { type: 'text/plain' });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const date = new Date();
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      a.download = `tabstack-export-${year}-${month}-${day}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      onClose();
    } catch (error) {
      console.error('导出 OneTab 格式数据失败:', error);
      showAlert({
        title: '导出失败',
        message: '导出 OneTab 格式数据失败，请重试',
        type: 'error',
        onClose: () => {},
      });
    }
  };

  // 导入 JSON
  const handleImportJson = (file: File) => {
    const reader = new FileReader();
    reader.onload = async event => {
      try {
        const data = JSON.parse(event.target?.result as string);
        const success = await storage.importData(data);
        if (success) {
          showAlert({
            title: '导入成功',
            message: '数据导入成功',
            type: 'success',
            onClose: () => {
              window.location.reload();
            },
          });
        } else {
          showAlert({
            title: '导入失败',
            message: '数据导入失败',
            type: 'error',
            onClose: () => {},
          });
        }
      } catch (error) {
        console.error('解析导入文件失败:', error);
        showAlert({
          title: '导入失败',
          message: '解析导入文件失败，请确保文件格式正确',
          type: 'error',
          onClose: () => {},
        });
      }
    };
    reader.readAsText(file);
  };

  // 导入 OneTab
  const handleImportOneTab = (file: File) => {
    const reader = new FileReader();
    reader.onload = async event => {
      try {
        const text = event.target?.result as string;
        const success = await storage.importFromOneTabFormat(text);
        if (success) {
          void trackProductEvent('onetab_import_completed', {
            importSource: 'onetab',
            importedSessions: text.split('\n\n').filter(Boolean).length,
          });
          showAlert({
            title: '导入成功',
            message: 'OneTab 数据导入成功',
            type: 'success',
            onClose: () => {
              window.location.reload();
            },
          });
        } else {
          showAlert({
            title: '导入失败',
            message: 'OneTab 数据导入失败',
            type: 'error',
            onClose: () => {},
          });
        }
      } catch (error) {
        console.error('解析 OneTab 导入文件失败:', error);
        showAlert({
          title: '导入失败',
          message: '解析 OneTab 导入文件失败，请确保文件格式正确',
          type: 'error',
          onClose: () => {},
        });
      }
    };
    reader.readAsText(file);
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

        <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>

        {/* 外观：主题 + 布局 */}
        <div className="px-4 py-2">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2">外观</p>
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
        </div>

        <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>

        {/* 工具 */}
        <div className="px-4 py-2">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2">工具</p>
          <button
            onClick={handleCleanDuplicateTabs}
            className="w-full text-left px-2 py-1.5 text-sm text-gray-700 dark:text-gray-300 flat-interaction rounded hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center"
            type="button"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            清理重复标签
          </button>
          <button
            onClick={() => setOpenSubmenu(current => (current === 'export' ? null : 'export'))}
            className="w-full text-left px-2 py-1.5 text-sm text-gray-700 dark:text-gray-300 flat-interaction rounded hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-between"
            aria-expanded={openSubmenu === 'export'}
            aria-haspopup="menu"
            type="button"
          >
            <div className="flex items-center">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              导出数据
            </div>
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
          {openSubmenu === 'export' && (
            <div className="pl-6">
              <button
                onClick={handleExportData}
                className="w-full text-left px-2 py-1.5 text-sm text-gray-700 dark:text-gray-300 flat-interaction rounded hover:bg-gray-100 dark:hover:bg-gray-700"
                type="button"
              >
                JSON 备份
              </button>
              <button
                onClick={handleExportOneTabFormat}
                className="w-full text-left px-2 py-1.5 text-sm text-gray-700 dark:text-gray-300 flat-interaction rounded hover:bg-gray-100 dark:hover:bg-gray-700"
                type="button"
              >
                OneTab 格式
              </button>
            </div>
          )}
          <button
            onClick={() => setOpenSubmenu(current => (current === 'import' ? null : 'import'))}
            className="w-full text-left px-2 py-1.5 text-sm text-gray-700 dark:text-gray-300 flat-interaction rounded hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-between"
            aria-expanded={openSubmenu === 'import'}
            aria-haspopup="menu"
            type="button"
          >
            <div className="flex items-center">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L5 8m4-4v12" />
              </svg>
              导入数据
            </div>
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
          {openSubmenu === 'import' && (
            <div className="pl-6">
              <button
                onClick={() => jsonImportRef.current?.click()}
                className="w-full text-left px-2 py-1.5 text-sm text-gray-700 dark:text-gray-300 flat-interaction rounded hover:bg-gray-100 dark:hover:bg-gray-700"
                type="button"
              >
                JSON 备份
              </button>
              <button
                onClick={() => oneTabImportRef.current?.click()}
                className="w-full text-left px-2 py-1.5 text-sm text-gray-700 dark:text-gray-300 flat-interaction rounded hover:bg-gray-100 dark:hover:bg-gray-700"
                type="button"
              >
                OneTab 格式
              </button>
            </div>
          )}
        </div>

        <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>

        {/* 通用设置 */}
        <div className="px-4 py-2">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">设置</p>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-sm text-gray-700 dark:text-gray-300">通知提醒</span>
            <button
              onClick={handleToggleNotifications}
              className={`relative inline-flex h-5 w-10 items-center rounded-full flat-interaction transition-colors ${
                settings.showNotifications ? 'bg-primary-600' : 'bg-gray-200 dark:bg-gray-600'
              }`}
              aria-label="通知提醒"
              type="button"
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  settings.showNotifications ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-sm text-gray-700 dark:text-gray-300">删除前确认</span>
            <button
              onClick={handleToggleConfirmDelete}
              className={`relative inline-flex h-5 w-10 items-center rounded-full flat-interaction transition-colors ${
                settings.confirmBeforeDelete ? 'bg-primary-600' : 'bg-gray-200 dark:bg-gray-600'
              }`}
              aria-label="删除前确认"
              type="button"
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  settings.confirmBeforeDelete ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-sm text-gray-700 dark:text-gray-300">保存固定标签页</span>
            <button
              onClick={handleToggleCollectPinnedTabs}
              className={`relative inline-flex h-5 w-10 items-center rounded-full flat-interaction transition-colors ${
                settings.collectPinnedTabs ? 'bg-primary-600' : 'bg-gray-200 dark:bg-gray-600'
              }`}
              aria-label="保存固定标签页"
              type="button"
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  settings.collectPinnedTabs ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        </div>

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

      {/* 隐藏的 file input */}
      <input
        ref={jsonImportRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) handleImportJson(file);
          e.target.value = '';
        }}
      />
      <input
        ref={oneTabImportRef}
        type="file"
        accept=".txt,text/plain"
        className="hidden"
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) handleImportOneTab(file);
          e.target.value = '';
        }}
      />

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
