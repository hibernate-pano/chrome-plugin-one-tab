import React, { useEffect, useState } from 'react';
import { Provider } from 'react-redux';
import { store } from '@/store';
import { loadSettings } from '@/store/slices/settingsSlice';
import { loadGroups } from '@/store/slices/tabSlice';
import Layout from '@/components/layout/Layout';
import Header from '@/components/layout/Header';
import TabList from '@/components/tabs/TabList';

const PopupContent: React.FC = () => {
  const [searchQuery, setSearchQuery] = useState('');
  useEffect(() => {
    store.dispatch(loadSettings());
    store.dispatch(loadGroups());

    // 解析URL参数
    const urlParams = new URLSearchParams(window.location.search);
    const savedTabs = urlParams.get('saved');
    if (savedTabs) {
      const tabs = JSON.parse(decodeURIComponent(savedTabs));
      // 显示保存成功的提示
      const message = `已保存 ${tabs.length} 个标签页`;
      console.log(message);
      // TODO: 添加UI提示和高亮效果
    }
  }, []);

  return (
    <Layout>
      <Header onSearch={setSearchQuery} />
      <TabList searchQuery={searchQuery} />
    </Layout>
  );
};

const Popup: React.FC = () => {
  return (
    <Provider store={store}>
      <PopupContent />
    </Provider>
  );
};

export default Popup;
