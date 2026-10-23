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
import { accountScopeStore, authCache } from '@/utils/authCache';
import { errorHandler } from '@/utils/errorHandler';
import { logInfo, logWarn } from '@/utils/log';
import type { AccountSwitchNotice } from '@/core/accountScope';
import type { CloudPullOutcome } from '@/domain/tabGroup/cloudPullCopy';

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
 * 消费入口的**串行队列**（模块级）。
 *
 * 【为什么需要】消费提示是一次**读-改-写**（读出来 → 写回
 * `pendingNotice: null`）：两条通道同时消费同一条提示时，两个调用可能
 * **都**读到提示、都写回 null、都把它当成自己的 ⇒ 用户看到**两条一样
 * 的提示**。「消费即清空」只挡住了**先后**两次，挡不住**同时**两次
 * （React 18 StrictMode 的双 effect、挂载通道与登录兜底通道撞在一起）。
 *
 * 串行化之后：第二个调用排在第一个之后才去读 ⇒ 读到的 `pendingNotice`
 * 已经是 null ⇒ 拿不到提示 ⇒ 只发一次。
 *
 * 【为什么是模块级】同一个 popup 页面里共享一份就够了（页面挂载通道与
 * 登录兜底通道在同一 realm）。设置页是另一个 realm、另一份队列 ——
 * 「同时开着两个页面登录」那种跨 realm 的并发不在本模块职责内。
 */
let noticeConsumeQueue: Promise<unknown> = Promise.resolve();

/**
 * 消费「待告知的换账号提示」（2026-10-22 审计 DS-1）。
 *
 * 【为什么提示是持久的】它存在归属记录里（utils/authCache.ts 的独立键），
 * 而不是某个内存变量 ⇒ 用户在登录后立刻关掉弹窗、提示没来得及发出去，
 * 它也不会丢：下次还能取到（不许静默）。
 *
 * 【消费即清空】同一条提示只会被告知一次。
 *
 * 【给界面用的接口 · 现状：仓库里没有界面调用方】界面若要把这句并进
 * 自己的文案（例如「已从云端拉回 N 个会话」那句），可以调这个导出拿到
 * 提示对象 —— 文案由 core/accountScope 的 accountSwitchNotice 拼装
 * （纯函数，界面与守卫同源）。
 * 但**截至 2026-10-23（R-4 复核）没有任何界面调它**：提示目前只由本模块
 * 的两条通道发出（都在 deliverAccountSwitchNotice 里）：
 *   ① 登录后的 400ms 兜底（scheduleAccountSwitchNotice）；
 *   ② 页面挂载时的补发（AuthProvider 的初始化 effect）。
 * 也就是说：**谁消费谁负责告知** —— 消费（=清空）了却没告知，
 * 这条提示就永远没人知道了。
 */
export async function consumeAccountSwitchNotice(): Promise<AccountSwitchNotice | null> {
  const result = noticeConsumeQueue.then(() => consumeAccountSwitchNoticeOnce());
  // 队列本身不许被一次失败打断（后面的消费还得能排上队）。
  noticeConsumeQueue = result.catch(() => undefined);
  return result;
}

/**
 * 真正的一次消费（读 → 清空 → 交出提示）。
 *
 * 单独一个函数是为了让上面的串行队列包住**整段**读-改-写：
 * 队列的排队单位是「一次消费」，不是「一次读」。
 */
async function consumeAccountSwitchNoticeOnce(): Promise<AccountSwitchNotice | null> {
  try {
    const record = await accountScopeStore.read();
    if (!record?.pendingNotice) return null;
    await accountScopeStore.write({ ...record, pendingNotice: null });
    return record.pendingNotice;
  } catch (error) {
    // 读失败（存储故障）或记录形状损坏 ⇒ **fail-closed**：
    // 不显示任何提示（更不能显示半截/错的），提示留在原地，下次还能取。
    logWarn('[auth] 读取换账号提示失败:', error);
    return null;
  }
}

/**
 * 把换账号提示告诉用户（唯一的发出通道）。
 *
 * 为什么走 errorHandler 而不是 React 的 useToast：发出点不在组件里
 * （登录流程在 thunk 里，而页面挂载的补发在 AuthProvider 里），而
 * errorHandler 是仓库里唯一的**非组件** toast 通道（ToastContext 注册的
 * 回调），它的类型只允许 error/warning —— 换账号提示正好是 warning 级
 * （不是错误，但必须让用户看见）。
 *
 * 【导出给 AuthProvider 用 · 2026-10-23 审计 R-4】这条通道原先**只有**
 * restoreAfterLogin 的 finally 里那个 400ms setTimeout 一个消费者 ⇒ 用户在
 * 登录后 400ms 内关掉弹窗，提示就**永远没人告知**了（提示还在归属记录里，
 * 但没人去取）⇒ 违反「不许静默」。现在页面挂载时也会消费一次，两条通道
 * 争抢同一条提示（消费即清空 + 串行消费 ⇒ 只发一次）⇒ **保证一定有人发**。
 *
 * 【为什么要先判登录态 · 2026-10-23 R-4 复核】提示说的是
 * 「本机还有 N 个会话属于上一个账号，**不会**被上传到**当前账号**」——
 * 没登录时压根没有「当前账号」，这句话对用户没有意义；更要紧的是
 * **消费即清空**：没登录时消费 = 把这条事实吃掉，还没告诉任何人 ⇒
 * 提示就永远没人知道了（这正是 R-4 要消灭的那种静默）。
 * 判据用**本地登录缓存**（authCache）：它是「这台机器上登录着谁」这条
 * 事实的唯一持久来源（退出登录即被清掉），而且**不需要网络** ——
 * 离线也判得出来。
 */
export async function deliverAccountSwitchNotice(): Promise<void> {
  // ⚠️ 2026-10-23（第 50 轮）：缓存读是**三态**（known / absent / unreadable）。
  // 修复前 `getAuthState()` 读失败返回 null，与「没登录过」同形。
  // 这里读失败（unreadable）时**不消费**提示 —— 消费即清空，
  // 而「读不出来」时消费 = 把这条事实吃掉却没人知道 ⇒ 提示永远丢失。
  const cached = await authCache.getAuthState();
  if (cached.state !== 'known' || !cached.isAuthenticated) {
    // 没登录（或读不出来）⇒ 不消费（提示原封不动留在归属记录里，
    // 等用户登录后还会被告知）。
    logInfo('[auth] 当前未登录（或登录态读不出来），不消费换账号提示（提示留在原地，不会被吃掉）');
    return;
  }
  const notice = await consumeAccountSwitchNotice();
  if (!notice) return;
  errorHandler.handle(notice.text, { severity: 'medium', logToConsole: false });
  logWarn(`[auth] 换账号提示已告知用户：${notice.text}`);
}

/**
 * 安排一次换账号提示的发出（400ms 之后）。
 *
 * 【它现在的角色】它是登录链路上的**兜底**：登录成功后页面可能立刻被关掉，
 * 但只要页面还活着 400ms，提示就会发出去。
 *
 * 【它不再是唯一的出口】提示是**持久**的 ⇒ 页面挂载时还会再消费一次
 * （AuthProvider 的初始化 effect 调 deliverAccountSwitchNotice）⇒
 * 用户关掉弹窗也不丢（不许静默）。
 *
 * 【宽限期给谁】早期设计里 LoginForm 会在 restoreAfterLogin 之后的 .then
 * 里消费这条提示、并进自己那句文案（先到先得）。**仓库里现在没有这样的
 * 界面调用方** ⇒ 这 400ms 纯粹是「页面还活着就把提示发出去」的兜底延迟。
 */
function scheduleAccountSwitchNotice(): void {
  setTimeout(() => {
    void deliverAccountSwitchNotice();
  }, 400);
}

/**
 * 登录成功后拉一次云端会话。
 *
 * ── 为什么回的是「三种结果」而不是一个数字（2026-10-22 审计 SC-6）────────
 * 修复前它回 `number`，而**「拉回失败」与「云端本来就是空的」都回 0** ——
 * 两种 0 混成一种 ⇒ 调用方分不出「没拉到东西」与「拉失败了」，
 * 于是失败时**一句话都没有**（用户以为云端的数据没了）。
 *
 * ⇒ 现在回 `CloudPullOutcome`：拉到 N 个 / 云端为空 / 拉回失败，
 * 三种结果各有各的回执（见 components/auth/restoreFeedbackCopy.ts）。
 *
 * @returns 本次拉回的结果（三选一）
 */
export async function restoreAfterLogin(
  dispatch: AppDispatch,
  deps: RestoreAfterLoginDeps = defaultRestoreDeps
): Promise<CloudPullOutcome> {
  // 先占位，再发命令：两条路（显式登录 / AuthProvider 的 auto 下载）
  // 可能几乎同时到达，先占位才能保证只有一条真的发出去。
  markLoginRestoreTriggered();
  try {
    const res = await deps.download();
    if (!res.ok) {
      // 失败不抛：登录**已经成功了**，同步失败不该把用户踢回登录页。
      // 但**必须如实报成失败**（界面据此出声并给出路）——
      // 界面上的手动「从云端刷新数据」入口仍在，用户随时可以自己拉。
      return {
        kind: 'failed',
        reason: res.error ?? null,
        backendUnavailable: res.backendUnavailable === true,
      };
    }
    // 下载结果写进了 storage，必须重读才能让界面显示出来。
    await dispatch(loadGroups());
    return toRestoreOutcome(res);
  } catch {
    // 抛异常的那条路（协议超时、SW 无响应等）同样是「拉回失败」。
    return { kind: 'failed' };
  } finally {
    // 换账号提示在**最后**才安排发出（下载完成之后）：下载期间用户可能
    // 已经把弹窗关掉了，那就没必要再发一条「恢复完成」的提示。
    // 提示本身是持久的 ⇒ 就算这一轮没发出去（页面被关、或者用户还没
    // 登录），它也不会丢：下次页面挂载时还会被消费一次（不许静默）。
    deps.scheduleNotice();
  }
}

/**
 * 一次整库下载的回包（判据层只关心这三件事）。
 *
 * 为什么要单独定一个窄类型：判据层要能**注入**假的下载结果，
 * 而 `MutationResult` 的 payload 是 `unknown` ⇒ 注入方无从构造。
 */
export interface RestoreDownloadResult {
  ok: boolean;
  error?: string;
  payload?: unknown;
  /** 服务端不可用（402 之类）的机器标记 —— 界面据此选措辞。 */
  backendUnavailable?: boolean;
}

/**
 * 这条链路用到的**副作用**（可注入 ⇒ 判据层能直接喂三种结果）。
 *
 * 为什么注入：判据必须能验证「三种结果 ⇒ 三种回执」，
 * 而真跑一次下载要 SW + 存储 + 网络 —— 那是端到端的事，不是判据层的事。
 */
export interface RestoreAfterLoginDeps {
  /** 发一次整库下载。 */
  download: () => Promise<RestoreDownloadResult>;
  /** 安排换账号提示（延迟发出）。 */
  scheduleNotice: () => void;
}

/** 生产环境的副作用。 */
const defaultRestoreDeps: RestoreAfterLoginDeps = {
  download: () =>
    sendSyncCommand('download', {
      forceRemote: false,
      syncSettings: false,
    }),
  scheduleNotice: scheduleAccountSwitchNotice,
};

/**
 * 把下载回包翻译成「三种结果之一」（**纯函数**）。
 *
 * ── 为什么数的是「云端有多少个」而不是「合并后有多少个」 ──────────────────
 * `payload.groups` 是**合并后**的列表（本机 + 云端）。拿它当「拉回 N 个」
 * 会在本机本来就有会话时**夸大**（本机 30 个 + 云端 2 个 ⇒ 报「拉回 32 个」）。
 * ⇒ 优先用引擎如实上报的 `stats.cloudCount`（= 云端这一轮读到的会话数）。
 */
export function toRestoreOutcome(res: RestoreDownloadResult): CloudPullOutcome {
  if (!res.ok) {
    return {
      kind: 'failed',
      reason: res.error ?? null,
      backendUnavailable: res.backendUnavailable === true,
    };
  }
  const payload = res.payload as
    | { groups?: unknown[]; stats?: { cloudCount?: number } }
    | undefined;
  const count =
    typeof payload?.stats?.cloudCount === 'number'
      ? payload.stats.cloudCount
      : Array.isArray(payload?.groups)
        ? payload.groups.length
        : 0;
  return count > 0 ? { kind: 'pulled', count } : { kind: 'empty' };
}
