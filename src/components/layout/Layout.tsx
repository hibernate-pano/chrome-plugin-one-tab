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
        <div className="container mx-auto px-2 py-2 max-w-5xl">
          {children}
          {syncEnabled && autoSyncEnabled && <SyncStatus />}
        </div>
      </div>
    </div>
  );
};

export default Layout;