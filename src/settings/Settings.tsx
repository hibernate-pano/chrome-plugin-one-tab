import React, { useEffect } from 'react';
import { Provider } from 'react-redux';
import { store } from '@/store';
import { loadSettings } from '@/store/slices/settingsSlice';
import SettingsLayout from '@/components/settings/SettingsLayout';
import SettingsPanel from '@/components/settings/SettingsPanel';

const SettingsContent: React.FC = () => {
  useEffect(() => {
    store.dispatch(loadSettings());
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