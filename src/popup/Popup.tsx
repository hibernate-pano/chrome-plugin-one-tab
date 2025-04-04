import React, { useEffect } from 'react';
import { Provider } from 'react-redux';
import { store } from '@/store';
import { loadSettings } from '@/store/slices/settingsSlice';
import Layout from '@/components/layout/Layout';
import Header from '@/components/layout/Header';
import TabList from '@/components/tabs/TabList';

const PopupContent: React.FC = () => {
  useEffect(() => {
    store.dispatch(loadSettings());
  }, []);

  return (
    <Layout>
      <Header />
      <TabList />
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