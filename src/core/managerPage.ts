/**
 * 管理页（会话列表页）的入口路径 —— **单一真相源**（2026-10-20 第二轮审计）。
 *
 * ── 为什么需要这个模块 ────────────────────────────────────────────────────
 *
 * 管理页的 URL 此前**手抄在三处**：
 *   ① `src/background/TabManager.ts` 的 `getExtensionUrl()`
 *   ② `src/popup/redirect.js` 的跳转（`window.location.href = 'src/popup/index.html'`）
 *   ③ 即将新增的设置页「回到 TapStack」出口
 *
 * 三处各自手抄字符串，早晚会漂。而漂了之后的症状是**极难查**的：
 * 漂成 `popup.html` 时不会报错 —— `popup.html` 是 vite 的多页入口壳，
 * 里面只有一行 `src/popup/redirect.js` 做跳转。用户看到的是
 * 「先白一下再跳到管理页」，而不是「打不开」。
 *
 * ⚠️ 注意 `popup.html` 与 `src/popup/index.html` 的区别：
 * 前者是 vite 的**入口壳**（为 `manifest` 之外的历史用途保留），
 * 后者才是管理页的**真身**（`rollupOptions.input` 与 `manifest.json` 都指它）。
 *
 * 用哪一个：全部用 `src/popup/index.html` —— 它直接就是管理页，
 * 没有中间跳转，没有白屏。
 *
 * 为什么放在 `src/core/`：这是**跨上下文共享**的常量
 * （background 与 options 两个执行上下文都要读），
 * `src/core/` 正是本仓放跨层共享逻辑的地方。
 */

/**
 * 管理页相对扩展根的路径。
 *
 * ⚠️ 这是**相对**路径，调用方要自己用 `chrome.runtime.getURL()` 转成绝对 URL。
 * 存相对路径而不是绝对 URL 的原因：绝对 URL 里嵌着扩展 ID，
 * 而扩展 ID 在不同安装环境（开发/商店）里不同 —— 存进代码就成了死字符串。
 */
export const MANAGER_PAGE_PATH = 'src/popup/index.html';
