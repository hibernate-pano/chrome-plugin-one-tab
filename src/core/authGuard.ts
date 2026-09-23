/**
 * SW 登录态恢复守卫（2026-09-12 审计修复）：SW 是事件驱动的独立执行上下文，
 * 每次冷启动 Redux store 都是未认证初始态；popup 发起的 upload/download
 * 消息因此曾在冷 SW 上一律 not_authenticated（upload 已有懒恢复，download 没有）。
 * 统一走本守卫：store 已认证直接放行（不碰网络），否则尝试从持久化 session
 * 恢复一次，恢复失败/异常都返回 false 而不抛出。
 */
export interface AuthGuardDeps {
  isAuthenticated: () => boolean;
  restoreAuth: () => Promise<boolean>;
}

export async function ensureAuthenticated(deps: AuthGuardDeps): Promise<boolean> {
  if (deps.isAuthenticated()) return true;
  try {
    return await deps.restoreAuth();
  } catch {
    return false;
  }
}
