import React from 'react';

interface LayoutProps {
  children: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  return (
    <div className="h-full">
      <div className="min-h-full bg-background text-on-background transition-material">
        <div className="container mx-auto px-4 py-4 max-w-4xl">
          {children}
        </div>
      </div>
    </div>
  );
};

export default Layout;