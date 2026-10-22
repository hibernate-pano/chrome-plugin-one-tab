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
import { isBackendUnavailableError } from '@/core/backendUnavailable';

export interface AuthGuardDeps {
  isAuthenticated: () => boolean;
  restoreAuth: () => Promise<boolean>;
  /**
   * 当前生效的后端 id（读设置得到）。
   *
   * **为什么默认 'supabase' 而非必填**：调用方若忘了传，走既有语义（查账号）。
   * 对 WebDAV 用户而言，漏传的后果是「回到未登录」——即修掉的那个 bug。
   * 所以它可选但**每个生产调用点都必须显式传**，新增调用点也要传。
   *
   * `null` = **读不到设置，本轮无法回答**（2026-10-18 B 组）。它落在
   * 「不等于 webdav」这一侧 ⇒ 查 Supabase 账号。这是刻意的保守方向：
   * 查账号最多得到一句「未登录」，而放行会让不知道传向哪儿的一轮同步
   * 直接跑起来。**生产调用点必须在传进来之前就判掉 null 并中止本轮**
   * ——门禁这一层只能兜住症状（把它读成「未登录」）。
   */
  backendId?: 'supabase' | 'webdav' | null;
}

export async function ensureAuthenticated(deps: AuthGuardDeps): Promise<boolean> {
  // 自带存储：没有 Supabase 账号概念，放行到后端层再判定就绪与否。
  // 锁定 / 未配置时那里会抛出带下一步动作的错误（见 LockedWebDavBackend）。
  if (deps.backendId === 'webdav') return true;
  if (deps.isAuthenticated()) return true;
  try {
    return await deps.restoreAuth();
  } catch (err) {
    // ── 2026-10-22（402）：「云端整体不可用」**不许**被吞成「未登录」─────
    // 原先这里 `catch { return false; }` 把**所有**失败都读成「没登录」。
    // 而生产实测（Supabase 项目被封禁）：账号校验请求本身返回 402 ⇒
    // restoreAuth 失败 ⇒ 返回 false ⇒ 用户看到「用户未登录」。
    //
    // 那是一句**更重的谎话**：他明明登录着，界面却说没登录 ⇒ 他会去重新登录、
    // 重新输密码、甚至以为自己的账号被删了。而真正的原因是「我们的云端项目
    // 被限制」，用户做什么都没用。
    //
    // 所以这一类必须**原样上抛**，由调用方按「服务端不可用」说人话
    // （见 syncEngine.upload / downloadAndMerge 的 catch）。
    if (isBackendUnavailableError(err)) throw err;
    return false;
  }
}
