/**
 * S2 存储 KV 收敛：运行环境探测单源。
 *
 * hasExtensionStorage / hasWebStorage 原先只活在 src/utils/supabase.ts（供
 * supabaseSharedStorage 用），storageAdapter 另写一套内联 chrome/window 判断。
 * 两处语义相同但文本分叉——改一处漏一处（网页版 session 丢失即前车之鉴）。
 * 本模块是唯一真相源：supabase session 层与 KV 迁移层同源引用，行为零变化。
 */

/** 扩展环境：有 chrome.storage.local（popup 与 MV3 SW 共享持久化）。 */
export const hasExtensionStorage = (): boolean =>
  typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);

/** 网页环境：有同步 localStorage（supabase-js 默认行为的等价回退）。 */
export const hasWebStorage = (): boolean => {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    // MV3 service worker 访问 localStorage 会抛错（未定义）
    return false;
  }
};
