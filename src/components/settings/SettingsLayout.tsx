import React from 'react';
import Layout from '../layout/Layout';

interface SettingsLayoutProps {
  children: React.ReactNode;
}

export const SettingsLayout: React.FC<SettingsLayoutProps> = ({ children }) => {
  return (
    <Layout>
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">设置</h1>
          <button
            onClick={() => {
              // 使用 chrome.runtime.getURL 获取正确的路径
              const popupUrl = chrome.runtime.getURL('src/popup/index.html');
              window.location.href = popupUrl;
            }}
            className="
              px-4 py-2 rounded-lg
              text-gray-600 dark:text-gray-300
              hover:bg-gray-100 dark:hover:bg-gray-700
              transition duration-200
              cursor-pointer
            "
          >
            返回
          </button>
        </div>
        {children}
      </div>
    </Layout>
  );
};

export default SettingsLayout;