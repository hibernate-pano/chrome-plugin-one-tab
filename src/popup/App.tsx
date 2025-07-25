import React from 'react';
import { AppContainer } from '@/components/app/AppContainer';

/**
 * 应用根组件
 * 简化为只负责渲染AppContainer
 */
const App: React.FC = () => {
  return <AppContainer />;
};

export default App;
