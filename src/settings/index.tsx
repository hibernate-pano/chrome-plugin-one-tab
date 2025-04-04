import React from 'react';
import ReactDOM from 'react-dom/client';
import Settings from './Settings';
import '../styles/global.css';
import { Provider } from 'react-redux';
import { store } from '../store';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

root.render(
  <React.StrictMode>
    <Provider store={store}>
      <Settings />
    </Provider>
  </React.StrictMode>
); 