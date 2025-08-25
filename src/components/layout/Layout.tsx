import React from 'react';
import { SyncStatus } from '../sync/SyncStatus';
import { useAppSelector } from '@/app/store/hooks';

interface LayoutProps {
  children: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  const { syncEnabled, autoSyncEnabled } = useAppSelector(state => state.settings);

  return (
    <div className="h-full">
      <div className="min-h-full bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 transition-colors">
        <div className="w-full px-3 py-2 sm:px-4 md:px-6 lg:px-8">
          {children}
          {syncEnabled && autoSyncEnabled && <SyncStatus />}
        </div>
      </div>
    </div>
  );
};

export default Layout;