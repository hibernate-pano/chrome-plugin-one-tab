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
 * 【与 popup / 管理页的关系（这段曾写错，2026-10-24 审计 GAP1-1 更正）】
 * options 页有自己的入口 html 与 store 实例，但**共用同一份设置存储**
 * （设置在 KV 层 = IndexedDB，见 utils/storage.ts）。
 *
 * 原注释说「popup 每次打开都重新 loadSettings()，不存在两个窗口互相覆盖的
 * 窗口期」—— **那是错的**：管理页（会话管理器）是一个**常驻标签页**，
 * 可以开着不关；本页也是独立标签页 ⇒ 两个 realm **真的同时存在**，
 * 各自持一份挂载时的设置快照。
 *
 * ⇒ 由此产生的两条纪律（都已落地）：
 *   ① 设置在 IndexedDB 里 ⇒ `chrome.storage.onChanged` 根本不触发
 *      ⇒ 跨 realm 的失效通道是自建的（storage-kv/settingsChangedBus）；
 *   ② 写设置必须**按字段**落盘：只写「本 realm 的用户动过的字段」，
 *      别人的改动原样保留（store/slices/settingsSlice.ts 的 pendingIntent）。
 *      否则常驻的管理页动一下开关，就会把本页刚改的设置静默盖回去。
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