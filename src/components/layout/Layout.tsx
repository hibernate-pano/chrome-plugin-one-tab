import React from 'react';
import { useAppSelector } from '@/store/hooks';

interface LayoutProps {
  children: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  const theme = useAppSelector(state => state.settings.theme);
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const currentTheme = theme === 'system' ? systemTheme : theme;

  return (
    <div className={`${currentTheme} h-full`}>
      <div className={`
        min-h-full
        bg-white dark:bg-gray-900
        text-gray-900 dark:text-gray-100
        transition-colors duration-200
      `}>
        <div className="container mx-auto px-4 py-4 max-w-4xl">
          {children}
        </div>
      </div>
    </div>
  );
};

export default Layout; 