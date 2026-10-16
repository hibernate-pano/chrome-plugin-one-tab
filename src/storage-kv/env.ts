/**
 * S2 存储 KV 收敛：运行环境探测单源。
 *
 * hasExtensionStorage / hasWebStorage 原先只活在一个已删除的 session 层里，
 * storageAdapter 另写了一套内联 chrome/window 判断。两处语义相同但文本分叉
 * ——改一处漏一处。本模块是唯一真相源：任何需要判断「有没有持久化存储」的
 * 地方都从这里引用，行为零变化。
 */

/** 扩展环境：有 chrome.storage.local（popup 与 MV3 SW 共享持久化）。 */
export const hasExtensionStorage = (): boolean =>
  typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);

/** 网页环境：有同步 localStorage（等价回退）。 */
export const hasWebStorage = (): boolean => {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    // MV3 service worker 访问 localStorage 会抛错（未定义）
    return false;
  }
};
