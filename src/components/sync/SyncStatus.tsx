import React, { useState, useEffect } from 'react';
import { useAppSelector } from '@/store/hooks';
import { CompressionStats } from '@/utils/compressionUtils';

interface SyncStatusProps {
  compressionStats?: CompressionStats | null;
}

export const SyncStatus: React.FC<SyncStatusProps> = ({ compressionStats }) => {
  const { syncStatus, lastSyncTime } = useAppSelector(state => state.tabs);
  const [showDetails, setShowDetails] = useState(false);
  
  // 自动隐藏详细信息
  useEffect(() => {
    if (showDetails) {
      const timer = setTimeout(() => {
        setShowDetails(false);
      }, 5000); // 5秒后自动隐藏
      
      return () => clearTimeout(timer);
    }
  }, [showDetails]);
  
  // 格式化压缩率
  const formatCompressionRatio = (stats?: CompressionStats | null) => {
    if (!stats) return null;
    
    const savingsPercent = (100 - stats.compressionRatio).toFixed(1);
    return `节省 ${savingsPercent}%`;
  };
  
  // 格式化数据大小
  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };
  
  return (
    <div className="text-xs">
      <div 
        className="flex items-center cursor-pointer" 
        onClick={() => compressionStats && setShowDetails(!showDetails)}
      >
        {syncStatus === 'syncing' ? (
          <div className="text-blue-500 flex items-center">
            <span className="mr-1">
              <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            </span>
            正在同步数据...
            {compressionStats && (
              <span className="ml-1 text-green-500">
                {formatCompressionRatio(compressionStats)}
              </span>
            )}
          </div>
        ) : lastSyncTime ? (
          <div className="text-green-500 flex items-center">
            <span className="mr-1">✓</span>
            上次同步: {new Date(lastSyncTime).toLocaleString()}
            {compressionStats && (
              <span className="ml-1 text-blue-500">
                {formatCompressionRatio(compressionStats)}
              </span>
            )}
          </div>
        ) : (
          <div className="text-gray-500">
            尚未同步数据
          </div>
        )}
      </div>
      
      {showDetails && compressionStats && (
        <div className="mt-1 p-2 bg-gray-100 rounded text-gray-700 text-xs">
          <div>原始大小: {formatSize(compressionStats.originalSize)}</div>
          <div>压缩后: {formatSize(compressionStats.compressedSize)}</div>
          <div>压缩率: {compressionStats.compressionRatio.toFixed(1)}%</div>
          <div>耗时: {compressionStats.compressionTime.toFixed(0)}ms</div>
        </div>
      )}
    </div>
  );
};
