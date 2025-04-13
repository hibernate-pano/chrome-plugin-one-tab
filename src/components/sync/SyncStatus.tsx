import React from 'react';
import { useAppSelector } from '@/store/hooks';

interface SyncStatusProps {}

export const SyncStatus: React.FC<SyncStatusProps> = () => {
  const { syncStatus, lastSyncTime, backgroundSync } = useAppSelector(state => state.tabs);

  return (
    <div className="text-xs">
      <div className="flex items-center">
        {syncStatus === 'syncing' && !backgroundSync ? (
          <div className="text-blue-500 flex items-center">
            <span className="mr-1">
              <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            </span>
            正在同步数据...
          </div>
        ) : lastSyncTime ? (
          <div className="text-green-500 flex items-center">
            <span className="mr-1">✓</span>
            上次同步: {new Date(lastSyncTime).toLocaleString()}
          </div>
        ) : (
          <div className="text-gray-500">
            尚未同步数据
          </div>
        )}
      </div>
    </div>
  );
};
