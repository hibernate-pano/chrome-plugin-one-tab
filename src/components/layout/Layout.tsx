import React from 'react';

interface LayoutProps {
  children: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  return (
    <div className="h-full">
      <div className="min-h-full bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 transition-colors">
        <div className="w-full px-3 py-2 sm:px-4 md:px-6 lg:px-8">
          {children}
        </div>
      </div>
    </div>
  );
};

export default Layout;