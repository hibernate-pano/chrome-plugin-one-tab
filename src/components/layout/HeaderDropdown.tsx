import React, { useState, useRef, useEffect } from 'react';
import { useAppSelector, useAppDispatch } from '@/store/hooks';
import { signOut } from '@/store/slices/authSlice';
import { deleteAllGroups } from '@/store/slices/tabSlice';
import { syncService } from '@/services/syncService';
import { storage } from '@/utils/storage';
import { LoginForm } from '../auth/LoginForm';
import { RegisterForm } from '../auth/RegisterForm';
import { useToast } from '@/contexts/ToastContext';
import { 
  toggleShowNotifications, 
  toggleConfirmBeforeDelete,
  saveSettings 
} from '@/store/slices/settingsSlice';
import { ThemeStyleSelector } from './ThemeStyleSelector';

interface HeaderDropdownProps {
  onClose: () => void;
}

export const HeaderDropdown: React.FC<HeaderDropdownProps> = ({ onClose }) => {
  const dispatch = useAppDispatch();
  const { isAuthenticated, user } = useAppSelector(state => state.auth);
  const { lastSyncTime } = useAppSelector(state => state.tabs);
  const settings = useAppSelector(state => state.settings);
  const [activeTab, setActiveTab] = useState<'login' | 'register'>('login');
  const [showAuthModal, setShowAuthModal] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { showConfirm, showAlert } = useToast();

  // 处理通知开关
  const handleToggleNotifications = async () => {
    dispatch(toggleShowNotifications());
    await dispatch(saveSettings({
      ...settings,
      showNotifications: !settings.showNotifications
    }));
  };

  // 处理删除确认开关
  const handleToggleConfirmDelete = async () => {
    dispatch(toggleConfirmBeforeDelete());
    await dispatch(saveSettings({
      ...settings,
      confirmBeforeDelete: !settings.confirmBeforeDelete
    }));
  };

  // 处理快速刷新（从云端下载并合并）
  const handleQuickRefresh = async () => {
    if (!isAuthenticated) {
      showAlert({
        title: '未登录',
        message: '请先登录以使用同步功能',
        type: 'warning',
        onClose: () => {}
      });
      return;
    }

    try {
      console.log('[HeaderDropdown] 开始快速刷新...');
      const result = await syncService.downloadAndRefresh(false); // overwriteLocal=false，合并模式
      
      if (result.success) {
        showAlert({
          title: '刷新成功',
          message: '已从云端获取最新数据',
          type: 'success',
          onClose: () => {}
        });
      } else {
        showAlert({
          title: '刷新失败',
          message: result.error || '无法从云端获取数据',
          type: 'error',
          onClose: () => {}
        });
      }
    } catch (error) {
      console.error('[HeaderDropdown] 快速刷新失败:', error);
      showAlert({
        title: '刷新失败',
        message: '网络连接失败，请稍后重试',
        type: 'error',
        onClose: () => {}
      });
    }
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
    // 先关闭下拉菜单，提高用户体验
    onClose();

    // 异步登出，不阻塞用户界面
    dispatch(signOut())
      .then(() => {
        console.log('登出成功');
      })
      .catch(error => {
        console.error('登出失败:', error);
      });
  };

  // 移除同步功能，简化逻辑

  const handleDeleteAllGroups = () => {
    // 显示确认对话框
    showConfirm({
      title: '删除确认',
      message: '确定要删除所有标签组吗？此操作无法撤销。',
      type: 'danger',
      confirmText: '删除',
      cancelText: '取消',
      onConfirm: () => {
        // 先关闭下拉菜单，提高用户体验
        onClose();

        // 异步删除所有标签组，不阻塞用户界面
        dispatch(deleteAllGroups())
          .then((result: any) => {
            const count = result.payload?.count || 0;

            // 删除成功后，异步同步到云端
            if (isAuthenticated) {
              // 同步删除操作
              syncService.uploadToCloud(true, true) // background=true, overwriteCloud=true
                .then(() => {
                  console.log('删除操作已同步到云端');
                })
                .catch(error => {
                  console.error('同步到云端失败:', error);
                });
            } else {
              console.log('用户未登录，跳过同步到云端');
            }

            showAlert({
              title: '删除成功',
              message: `成功删除了 ${count} 个标签组`,
              type: 'success',
              onClose: () => { }
            });
          })
          .catch(error => {
            console.error('删除所有标签组失败:', error);
            showAlert({
              title: '删除失败',
              message: '删除所有标签组失败',
              type: 'error',
              onClose: () => { }
            });
          });
      },
      onCancel: () => { }
    });
  };

  // 导出数据为 JSON 格式
  const handleExportData = async () => {
    try {
      const exportData = await storage.exportData();
      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: 'application/json'
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // 安全地处理日期格式化
      const date = new Date();
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      a.download = `onetab-backup-${year}-${month}-${day}.json`;
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
        onClose: () => { }
      });
    }
  };

  // 导出数据为 OneTab 格式
  const handleExportOneTabFormat = async () => {
    try {
      const oneTabText = await storage.exportToOneTabFormat();
      const blob = new Blob([oneTabText], {
        type: 'text/plain'
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // 安全地处理日期格式化
      const date = new Date();
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      a.download = `onetab-export-${year}-${month}-${day}.txt`;
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
        onClose: () => { }
      });
    }
  };

  return (
    <div ref={dropdownRef} className="absolute right-0 mt-2 w-64 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-20">
      <div className="py-2">
        {isAuthenticated && user && (
          <>
            <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{user.email}</p>
                <button
                  onClick={handleQuickRefresh}
                  className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                  title="从云端刷新数据"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </button>
              </div>
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-500 dark:text-gray-400 flex items-center">
                  <span className="inline-block w-2 h-2 rounded-full bg-green-500 mr-1"></span>
                  已登录
                </p>
                {lastSyncTime && (
                  <p className="text-xs text-gray-400 dark:text-gray-500" title={`上次同步: ${new Date(lastSyncTime).toLocaleString()}`}>
                    {(() => {
                      const now = new Date();
                      const syncDate = new Date(lastSyncTime);
                      const diffMs = now.getTime() - syncDate.getTime();
                      const diffMins = Math.floor(diffMs / 60000);
                      
                      if (diffMins < 1) return '刚刚同步';
                      if (diffMins < 60) return `${diffMins}分钟前`;
                      const diffHours = Math.floor(diffMins / 60);
                      if (diffHours < 24) return `${diffHours}小时前`;
                      const diffDays = Math.floor(diffHours / 24);
                      return `${diffDays}天前`;
                    })()}
                  </p>
                )}
              </div>
            </div>
          </>
        )}

        {!isAuthenticated && (
          <button
            onClick={() => setShowAuthModal(true)}
            className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
            </svg>
            登录 / 注册
          </button>
        )}

        <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>

        {/* 设置区域 */}
        <div className="px-4 py-2">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2">设置</p>
          
          {/* 通知开关 */}
          <div className="flex items-center justify-between py-2">
            <div className="flex items-center">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
              <span className="text-sm text-gray-700 dark:text-gray-300">通知提醒</span>
            </div>
            <button
              onClick={handleToggleNotifications}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                settings.showNotifications ? 'bg-primary-600' : 'bg-gray-200 dark:bg-gray-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  settings.showNotifications ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* 删除确认开关 */}
          <div className="flex items-center justify-between py-2">
            <div className="flex items-center">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span className="text-sm text-gray-700 dark:text-gray-300">删除前确认</span>
            </div>
            <button
              onClick={handleToggleConfirmDelete}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                settings.confirmBeforeDelete ? 'bg-primary-600' : 'bg-gray-200 dark:bg-gray-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  settings.confirmBeforeDelete ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
        </div>

        <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>

        {/* 主题风格选择 */}
        <ThemeStyleSelector />

        <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>

        <div className="relative group">
          <button
            className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-between"
          >
            <div className="flex items-center">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              导出数据
            </div>
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <div className="absolute left-full top-0 ml-1 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 w-48 hidden group-hover:block">
            <button
              onClick={handleExportData}
              className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              JSON 格式
            </button>
            <button
              onClick={handleExportOneTabFormat}
              className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              OneTab 格式
            </button>
          </div>
        </div>

        <div className="relative group">
          <button
            className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-between"
          >
            <div className="flex items-center">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              导入数据
            </div>
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <div className="absolute left-full top-0 ml-1 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 w-48 hidden group-hover:block">
            <label
              className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center cursor-pointer"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              JSON 格式
              <input
                type="file"
                accept=".json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    const reader = new FileReader();
                    reader.onload = async (event) => {
                      try {
                        const data = JSON.parse(event.target?.result as string);
                        const success = await storage.importData(data);
                        if (success) {
                          showAlert({
                            title: '导入成功',
                            message: '数据导入成功',
                            type: 'success',
                            onClose: () => {
                              // 刷新页面
                              window.location.reload();
                            }
                          });
                        } else {
                          showAlert({
                            title: '导入失败',
                            message: '数据导入失败',
                            type: 'error',
                            onClose: () => { }
                          });
                        }
                      } catch (error) {
                        console.error('解析导入文件失败:', error);
                        showAlert({
                          title: '导入失败',
                          message: '解析导入文件失败，请确保文件格式正确',
                          type: 'error',
                          onClose: () => { }
                        });
                      }
                      onClose();
                    };
                    reader.readAsText(file);
                  }
                }}
              />
            </label>
            <label
              className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center cursor-pointer"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              OneTab 格式
              <input
                type="file"
                accept=".txt"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    const reader = new FileReader();
                    reader.onload = async (event) => {
                      try {
                        const text = event.target?.result as string;
                        const success = await storage.importFromOneTabFormat(text);
                        if (success) {
                          showAlert({
                            title: '导入成功',
                            message: 'OneTab 数据导入成功',
                            type: 'success',
                            onClose: () => {
                              // 刷新页面
                              window.location.reload();
                            }
                          });
                        } else {
                          showAlert({
                            title: '导入失败',
                            message: 'OneTab 数据导入失败',
                            type: 'error',
                            onClose: () => { }
                          });
                        }
                      } catch (error) {
                        console.error('解析 OneTab 导入文件失败:', error);
                        showAlert({
                          title: '导入失败',
                          message: '解析 OneTab 导入文件失败，请确保文件格式正确',
                          type: 'error',
                          onClose: () => { }
                        });
                      }
                      onClose();
                    };
                    reader.readAsText(file);
                  }
                }}
              />
            </label>
          </div>
        </div>

        <button
          onClick={handleDeleteAllGroups}
          className="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900 dark:hover:bg-opacity-20 flex items-center"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          删除所有标签
        </button>



        {isAuthenticated && (
          <>
            <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>
            <button
              onClick={handleSignOut}
              className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              退出登录
            </button>
          </>
        )}
      </div>

      {showAuthModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-md mx-4">
            <div className="flex border-b border-gray-300 dark:border-gray-700">
              <button
                className={`flex-1 py-3 transition-all font-medium ${activeTab === 'login' ? 'text-primary-600 border-b-2 border-primary-600' : 'text-gray-600 dark:text-gray-300 hover:text-primary-600 dark:hover:text-primary-400'}`}
                onClick={() => setActiveTab('login')}
              >
                登录
              </button>
              <button
                className={`flex-1 py-3 transition-all font-medium ${activeTab === 'register' ? 'text-primary-600 border-b-2 border-primary-600' : 'text-gray-600 dark:text-gray-300 hover:text-primary-600 dark:hover:text-primary-400'}`}
                onClick={() => setActiveTab('register')}
              >
                注册
              </button>
              <button
                className="p-3 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                onClick={() => setShowAuthModal(false)}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-6">
              {activeTab === 'login' ? (
                <LoginForm onSuccess={() => {
                  setShowAuthModal(false);
                  onClose();
                }} />
              ) : (
                <RegisterForm onSuccess={() => {
                  setShowAuthModal(false);
                  onClose();
                }} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
