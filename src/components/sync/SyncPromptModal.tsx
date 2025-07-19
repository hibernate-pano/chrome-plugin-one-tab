import React from 'react';
import { useAppDispatch } from '@/app/store/hooks';
// 使用新版同步服务
import { downloadFromCloud } from '@/features/sync/store/syncSlice';
import { syncService } from '@/services/syncService';

interface SyncPromptModalProps {
  onClose: () => void;
  hasCloudData: boolean;
}

const SyncPromptModal: React.FC<SyncPromptModalProps> = ({ onClose, hasCloudData }) => {
  const dispatch = useAppDispatch();

  const handleSync = async () => {
    try {
      // 使用新版同步服务从云端下载数据
      const result = await syncService.downloadFromCloud(false, true);
      if (result.success) {
        console.log('从云端同步数据成功');
      } else {
        console.error('从云端同步数据失败:', result.error);
      }
      onClose();
    } catch (error) {
      console.error('从云端同步数据失败:', error);
      onClose();
    }
  };

  const handleSkip = () => {
    console.log('用户选择跳过同步');
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
        <h2 className="text-xl font-semibold text-gray-800 mb-4">同步云端数据</h2>
        
        <div className="mb-6">
          {hasCloudData ? (
            <p className="text-gray-600">
              检测到您的云端账户中有标签数据。是否要同步这些数据到当前设备？
            </p>
          ) : (
            <p className="text-gray-600">
              您已登录云端账户。是否要从云端同步数据？
            </p>
          )}
        </div>
        
        <div className="flex justify-end space-x-3">
          <button
            onClick={handleSkip}
            className="px-4 py-2 border border-gray-300 rounded text-gray-700 hover:bg-gray-100 transition-colors"
          >
            稍后再说
          </button>
          <button
            onClick={handleSync}
            className="px-4 py-2 bg-primary-600 text-white rounded hover:bg-primary-700 transition-colors"
          >
            立即同步
          </button>
        </div>
      </div>
    </div>
  );
};

export default SyncPromptModal;
