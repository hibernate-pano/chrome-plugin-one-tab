import React, { useEffect, useState } from 'react';
import { Provider } from 'react-redux';
import { useAppSelector } from '@/app/store/hooks';
import { store } from '@/app/store';
import { loadSettings } from '@/store/slices/settingsSlice';
import { loadGroups } from '@/features/tabs/store/tabGroupsSlice';
import Layout from '@/components/layout/Layout';
import Header from '@/components/layout/Header';
import TabList from '@/components/tabs/TabList';
import { TabListDndKit } from '@/components/tabs/TabListDndKit';
import { LoadingOverlay } from '@/components/common/LoadingOverlay';
// DndProvider is handled internally by TabListDndKit

const SyncLoadingOverlay: React.FC = () => {
  const { status: syncStatus, backgroundSync } = useAppSelector(state => state.sync);
  const isSyncing = syncStatus === 'syncing';

  return (
    <LoadingOverlay
      isVisible={isSyncing && !backgroundSync}
      message="正在同步数据..."
    />
  );
};

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

  // 使用新的 dnd-kit 实现
  const useDndKit = true;

  return (
    <Layout>
      <Header onSearch={setSearchQuery} />
      {useDndKit ? (
        <TabListDndKit searchQuery={searchQuery} />
      ) : (
        <TabList searchQuery={searchQuery} />
      )}
    </Layout>
  );
};

const Popup: React.FC = () => {
  return (
    <Provider store={store}>
      <SyncLoadingOverlay />
      <PopupContent />
    </Provider>
  );
};

export default Popup;
