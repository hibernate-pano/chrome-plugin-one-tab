/**
 * 「问后台核登录态」这条通道的**页面一侧**（IO 层）。
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────────────
 * 判据在 `src/core/authStatus.ts`（纯函数）；这里只做 IO：把一条消息发给
 * service worker，拿回判定结果。**页面侧不许自己核** ——
 * 一旦页面自己核，就得加载整条 Supabase SDK（≈75KB gzip），
 * 而那正是这次要消掉的每开一次弹窗就付一次的下载。
 *
 * ⚠️ service worker 里 `import()` 被 Chrome 禁止 ⇒ SW 侧走静态注册；
 * 页面侧这条路只发消息，不 import 任何后端模块。
 */

import type { AuthStatus } from '@/core/authStatus';

/** 发消息的函数（可注入，便于测试）。 */
export type AuthStatusSender = (message: { type: string }) => Promise<unknown>;

/** 默认发法：走 `chrome.runtime`。 */
const defaultSender: AuthStatusSender = async message => {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    throw new Error('当前环境没有 chrome.runtime（不是扩展页面）');
  }
  return await chrome.runtime.sendMessage(message);
};

/**
 * 问后台核一次登录态。
 *
 * ⚠️ **失败不许被当成「没登录」**：这条通道断了（SW 正在重启、扩展刚更新）
 * 时，调用方**必须**保留本机缓存那份登录态 —— 否则用户会在弹窗一打开的
 * 瞬间被说成「没登录」。
 * ⇒ 这里**抛错**，由调用方按「不知道」处理（判据见 `decideAuthStatus`）。
 */
export async function requestAuthStatus(
  sender: AuthStatusSender = defaultSender
): Promise<AuthStatus> {
  const res = (await sender({ type: 'AUTH_STATUS' })) as
    | { ok?: boolean; status?: AuthStatus; error?: string }
    | undefined;
  if (!res) throw new Error('后台没有回包（登录态核不了）');
  if (res.ok !== true || !res.status) {
    throw new Error(res.error || '后台没有给出登录态');
  }
  return res.status;
}
