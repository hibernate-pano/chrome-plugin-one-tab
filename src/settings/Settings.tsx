import React, { useEffect } from 'react';
import { Provider } from 'react-redux';
import { store } from '@/store';
import { loadSettings } from '@/store/slices/settingsSlice';
import { getCurrentUser } from '@/store/slices/authSlice';
import SettingsLayout from '@/components/settings/SettingsLayout';
import SettingsPanel from '@/components/settings/SettingsPanel';

const SettingsContent: React.FC = () => {
  useEffect(() => {
    store.dispatch(loadSettings());

    // 检查是否有已登录的用户会话，实现自动登录
    store.dispatch(getCurrentUser());
  }, []);

  return (
    <SettingsLayout>
      <SettingsPanel />
    </SettingsLayout>
  );
};

const Settings: React.FC = () => {
  return (
    <Provider store={store}>
      <SettingsContent />
    </Provider>
  );
};

export default Settings;