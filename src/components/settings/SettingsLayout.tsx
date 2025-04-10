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
          <a
            href="popup.html"
            className="
              px-4 py-2 rounded-lg
              text-gray-600
              hover:bg-gray-100
              transition duration-200
            "
          >
            返回
          </a>
        </div>
        {children}
      </div>
    </Layout>
  );
};

export default SettingsLayout;