/**
 * 「登录成功 → 拉回云端会话」这条链路（2026-10-19 审计 F-6）。
 *
 * 【为什么这是 P1 而不是「按需手动」】修复前登录成功只关掉弹窗，什么都不拉：
 *   · popup 打开时的自动下载被 `syncEnabled` 门禁拦下（默认 false），
 *     而 AuthProvider 把它列进静默白名单 ⇒ 用户完全不知道有这回事；
 *   · AuthProvider 的 effect 依赖是 `[dispatch, initialAuthLoaded]`，
 *     登录**不会**让它重跑 ⇒ 连「重开页面自动拉一次」也要等用户手动刷新；
 *   · 引导文案却写着「保存后会自动备份到云端，新设备登录即恢复」。
 *
 * 结果：新设备上登录成功，列表仍然是空的 —— 用户以为云端数据丢了。
 *
 * 【为什么登录不受 syncEnabled 约束】`syncEnabled` 管的是「**后台定时**拉取」
 * （每 5/10/30/60 分钟一次，消耗流量与电量）。而登录是一个**显式意图**：
 * 用户刚敲了账号密码，动机就是「我要看到我另一台设备上的会话」。
 * 用「后台轮询的开关」去拦「显式意图」，是拿错判据。
 *
 * 【与既有自动下载的关系】本模块发的下载**不带 auto:true**，因此不会被
 * SW 的 auto 门禁拦（那个门禁只管 auto 位，见 service-worker.ts 的
 * `data.op === 'download' && data.auto === true` 分支）。
 */

import { sendSyncCommand } from '@/shared/mutationProtocol';
import { loadGroups } from '@/store/slices/tabSlice';
import type { AppDispatch } from '@/store/hooks';

/**
 * 本次页面会话里「登录已触发过一次恢复」的标志（2026-10-19 审计 P1-4）。
 *
 * 【为什么需要】登录成功后有**两条路**会发下载：
 *   ① restoreAfterLogin（本模块）—— 显式意图；
 *   ② AuthProvider 的 `getCurrentUser().then(...)` —— 它只在页面挂载时跑一次，
 *      但登录成功后 `getCurrentUser` 会被再次 dispatch，于是那条 auto 下载
 *      也跟着发出去。
 * 结果：登录一次 = 两次整库下载 + 两次 merge 写盘。
 *
 * 标志放在**模块级**（与 AuthProvider 同realm）—— 同一个 popup 页面里共享。
 * 用模块级而不是 context：这两个模块本来就没有共享的 React 上下文，
 * 而「本次页面会话」正是模块级变量的自然生命周期。
 */
let loginRestoreTriggered = false;

/**
 * 本次页面会话里登录恢复是否已经触发过。
 *
 * 供 AuthProvider 判据：已经触发过就不再发那次 auto 下载。
 */
export const hasLoginRestoreTriggered = (): boolean => loginRestoreTriggered;

/**
 * 标记「登录恢复已触发」。
 *
 * 单独导出（而不是让 restoreAfterLogin 内部隐式设置）是为了让调用方
 * 在**发命令之前**就能先占位 —— 否则两条路可能同时通过检查。
 */
export const markLoginRestoreTriggered = (): void => {
  loginRestoreTriggered = true;
};

/**
 * 登录成功后拉一次云端会话。
 *
 * @returns 拉回多少个会话（失败时 0）
 */
export async function restoreAfterLogin(dispatch: AppDispatch): Promise<number> {
  // 先占位，再发命令：两条路（显式登录 / AuthProvider 的 auto 下载）
  // 可能几乎同时到达，先占位才能保证只有一条真的发出去。
  markLoginRestoreTriggered();
  try {
    const res = await sendSyncCommand('download', {
      forceRemote: false,
      syncSettings: false,
    });
    if (!res.ok) {
      // 失败不抛：登录**已经成功了**，同步失败不该把用户踢回登录页。
      // 界面上的手动「下载」入口仍在，用户随时可以自己拉。
      return 0;
    }
    // 下载结果写进了 storage，必须重读才能让界面显示出来。
    await dispatch(loadGroups());
    const payload = res.payload as { groups?: unknown[] } | undefined;
    return Array.isArray(payload?.groups) ? payload.groups.length : 0;
  } catch {
    return 0;
  }
}
