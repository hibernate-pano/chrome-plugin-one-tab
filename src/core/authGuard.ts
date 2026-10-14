/**
 * 同步前置条件守卫（2026-09-12 起；2026-10-14 为 WebDAV 重构）。
 *
 * ── 演进：它原来只管 Supabase，现在管「这个后端需要什么前置条件」──────
 * 原实现只有一件事：SW 冷启动时 Redux store 是未认证初始态，popup 发起的
 * upload/download 会一律 not_authenticated。所以它问的是「你有没有 Supabase 账号」。
 *
 * WebDAV 后端没有账号体系。门禁继续问那个问题，结果是 **WebDAV 用户点同步
 * 一律得到「用户未登录」** —— 一句指向 Supabase 的话，而他的数据在自己盘上。
 * 这不是文案问题：门禁直接 return 了，锁定后端抛的「去重新解锁」永远到不了用户。
 * （2026-10-14 真机 E2E 抓到的，单测因为直接构造「已登录」态而全绿。）
 *
 * 因此判断标准改为：**这个后端就绪了吗**，而不是「你有没有某个账号」。
 *   · Supabase：没有账号 ⇒ 不可用（既有语义，逐字保留）
 *   · WebDAV：账号由用户自带 ⇒ 不查 Supabase；不可用时由锁定后端抛可读错
 * 这样「是否可同步」只有一个答案来源：后端自己。
 */
export interface AuthGuardDeps {
  isAuthenticated: () => boolean;
  restoreAuth: () => Promise<boolean>;
  /**
   * 当前生效的后端 id（读设置得到）。
   *
   * **为什么默认 'supabase' 而非必填**：调用方若忘了传，走既有语义（查账号）。
   * 对 WebDAV 用户而言，漏传的后果是「回到未登录」——即修掉的那个 bug。
   * 所以它可选但**每个生产调用点都必须显式传**，新增调用点也要传。
   */
  backendId?: 'supabase' | 'webdav';
}

export async function ensureAuthenticated(deps: AuthGuardDeps): Promise<boolean> {
  // 自带存储：没有 Supabase 账号概念，放行到后端层再判定就绪与否。
  // 锁定 / 未配置时那里会抛出带下一步动作的错误（见 LockedWebDavBackend）。
  if (deps.backendId === 'webdav') return true;
  if (deps.isAuthenticated()) return true;
  try {
    return await deps.restoreAuth();
  } catch {
    return false;
  }
}
