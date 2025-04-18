import React from 'react';

interface LayoutProps {
  children: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  return (
    <div className="h-full">
      <div className="min-h-full bg-background dark:bg-gray-900 text-on-background dark:text-gray-100 transition-material">
        <div className="container mx-auto px-2 py-2 max-w-5xl">
          {children}
        </div>
      </div>
    </div>
  );
};

export default Layout;