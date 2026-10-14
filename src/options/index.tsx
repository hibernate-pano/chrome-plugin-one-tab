/**
 * 选项页（options page）入口 —— 2026-10-14。
 *
 * 【为什么需要一个独立页面，而不是把设置塞进 popup 菜单】
 * popup 宽度上限只有 256px（`w-64`），而设置项里有 WebDAV 表单
 * （6 个输入框 + 加密单选组 + 4 个按钮）。把它展开进下拉菜单后，
 * 菜单变成「在一个 256px 宽的瞬态下拉里滚一个多字段表单」：
 *   · 宽度不够 —— 按钮行要横向滚动才看得全；
 *   · 菜单是**瞬态**的，点别处就消失，而这里要填 URL、账号、
 *     应用密码、加密口令，全是需要回看和斟酌的长文本；
 *   · 菜单里已经挤着七八行设置，再塞一个表单没有可用空间。
 * Chrome 早就为这件事提供了 `options_ui`：独立窗口、独立生命周期、
 * 状态在关闭时保留、用户在扩展详情页就能找到入口。
 *
 * 【与 popup 的关系】
 * options 页有自己的入口 html 与 store 实例，但**共用同一份
 * `chrome.storage.local`**（见 utils/storage.ts），所以：
 *   · 这里改设置，popup 下次打开读到的就是新值；
 *   · 不需要 `chrome.storage.onChanged` 做跨窗口同步 ——
 *     popup 每次打开都会重新 `loadSettings()`，而它在关闭期间不会显示
 *     任何东西，不存在「开着两个窗口互相覆盖」的问题。
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from '../store';
import { OptionsPage } from './OptionsPage';
import '../styles/global.css';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

root.render(
  <React.StrictMode>
    <Provider store={store}>
      <OptionsPage />
    </Provider>
  </React.StrictMode>
);