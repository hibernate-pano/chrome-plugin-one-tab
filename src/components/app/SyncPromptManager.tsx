import React, { useEffect, useState, lazy, Suspense } from 'react';
import { useAppSelector } from '@/store/hooks';
import { hasSyncPromptShown, markSyncPromptShown } from '@/utils/syncPromptUtils';
import { checkCloudData } from '@/utils/cloudDataUtils';

// 使用动态导入懒加载同步提示对话框
const SyncPromptModal = lazy(() => import('@/components/sync/SyncPromptModal'));

interface SyncPromptManagerProps {
  children: React.ReactNode;
}

/**
 * 同步提示管理组件
 * 负责管理同步提示对话框的显示逻辑
 */
export const SyncPromptManager: React.FC<SyncPromptManagerProps> = ({ children }) => {
  const { isAuthenticated, user } = useAppSelector(state => state.auth);
  const [showSyncPrompt, setShowSyncPrompt] = useState(false);
  const [hasCloudData, setHasCloudData] = useState(false);

  // 检查是否需要显示同步提示
  useEffect(() => {
    const checkSyncPrompt = async () => {
      // 只有在用户已登录且认证状态稳定后才检查
      if (!isAuthenticated || !user) {
        return;
      }

      try {
        // 检查是否已经显示过同步提示
        const hasShown = await hasSyncPromptShown(user.id);
        if (hasShown) {
          console.log('同步提示已显示过，跳过');
          return;
        }

        // 检查云端是否有数据
        console.log('检查云端数据...');
        const cloudDataExists = await checkCloudData();

        if (cloudDataExists) {
          console.log('发现云端数据，显示同步提示');
          setHasCloudData(true);
          setShowSyncPrompt(true);
        } else {
          console.log('云端无数据，标记同步提示已显示');
          // 如果云端没有数据，直接标记为已显示，避免重复检查
          await markSyncPromptShown(user.id);
        }
      } catch (error) {
        console.error('检查同步提示失败:', error);
        // 出错时也标记为已显示，避免重复尝试
        await markSyncPromptShown(user.id);
      }
    };

    // 延迟检查，确保认证状态稳定
    const timer = setTimeout(checkSyncPrompt, 1000);
    return () => clearTimeout(timer);
  }, [isAuthenticated, user]);

  // 处理同步提示关闭
  const handleCloseSyncPrompt = async () => {
    try {
      setShowSyncPrompt(false);
      // 标记同步提示已显示
      if (user) {
        await markSyncPromptShown(user.id);
      }
      console.log('同步提示已关闭并标记');
    } catch (error) {
      console.error('关闭同步提示失败:', error);
    }
  };

  return (
    <>
      {children}

      {/* 同步提示对话框 */}
      {showSyncPrompt && (
        <Suspense
          fallback={
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
              <div className="bg-white dark:bg-gray-800 rounded-lg p-4">
                加载中...
              </div>
            </div>
          }
        >
          <SyncPromptModal
            onClose={handleCloseSyncPrompt}
            hasCloudData={hasCloudData}
          />
        </Suspense>
      )}
    </>
  );
};
