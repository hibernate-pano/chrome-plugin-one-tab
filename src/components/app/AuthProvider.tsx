import React, { useEffect } from 'react';
import { useAppDispatch } from '@/store/hooks';
import { setFromCache } from '@/store/slices/authSlice';
import { loadGroups } from '@/store/slices/tabSlice';
import { authCache } from '@/utils/authCache';
import { requestAuthStatus } from '@/utils/authStatusChannel';
import { sendSyncCommand } from '@/shared/mutationProtocol';
import {
  hasLoginRestoreTriggered,
  deliverAccountSwitchNotice,
} from '@/components/auth/restoreAfterLogin';
import { logError, logInfo, logWarn } from '../../utils/log';

interface AuthProviderProps {
  children: React.ReactNode;
}

/**
 * 认证提供者组件
 * 负责处理用户认证状态的初始化和管理
 *
 * ── 2026-10-23（第 47 轮）：**挂载时不再联网核登录态** ──────────────────
 *
 * 【原来在做什么】挂载后立刻 `loadSupabaseFacade()` → `getSession()` →
 * `getCurrentUser()`。那条路会把**整条 Supabase SDK** 拉下来
 * （SDK ≈58KB gzip + 门面 ≈16KB gzip ≈ **75KB**）——
 * 而用户点开弹窗只想看**本机会话列表**，这一下跟他要干的事毫无关系。
 * ⇒ **每次开弹窗都付一次 75KB**，而它只换来一个「你登录着吗」的答案。
 *
 * 【现在怎么做】把「核」这件事搬到 **service worker**：
 *   · 弹窗**本地读缓存**（`chrome.storage.local`，零延迟、零下载）⇒
 *     第一帧就是对的（R-12 那一版已经做了一半：缓存里有登录态就立刻 dispatch）；
 *   · **联网核**改由后台做（SW 侧的 SDK 是**静态依赖**，已经在扩展包里
 *     ⇒ **不产生任何下载**）⇒ 弹窗只发一条消息问「核完了吗」。
 *
 * 【核不到的时候怎么办】**不许**读成「没登录」——
 *   · 服务端整体不可用（生产实测 402）⇒ 用户**确实登录着**，只是确认不了；
 *   · 断网 / 通道断了 ⇒ 我们**不知道**。
 * 这两种都**保留本机缓存那份**登录态（判据见 `core/authStatus.ts`）。
 * ⚠️ 只有**明确核到「没有会话」**才归零 —— 那才是真的没登录。
 *
 * 【少掉的东西，一件都不少】挂载时那次核的**另一个作用**是
 * 「登录着就顺手把云端拉回来」（跨设备找回）。这条**保留**：
 * 由后台去拉（`download` 命令本来就发给后台），弹窗不参与下载。
 */
export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const dispatch = useAppDispatch();

  // 初始化认证状态
  useEffect(() => {
    const initializeAuth = async () => {
      try {
        logInfo('开始初始化认证状态...');

        // ── 2026-10-23 审计 R-4：页面挂载时消费一次「待告知的换账号提示」──
        //
        // 【为什么必须有这条通道】提示是**持久**的（存在归属记录里，
        // utils/authCache.ts 的独立键）⇒ 就算这次没发出去，它也不会丢。
        // 但它原先**只有**一个消费者：restoreAfterLogin 的 finally 里那个
        // 400ms setTimeout ⇒ 用户在登录后 400ms 内关掉弹窗 ⇒ 提示**永远
        // 没人告知**（提示还在那儿，但没人去取）⇒ 违反「不许静默」。
        //
        // 【为什么不会重复发两条】消费即清空（consumeAccountSwitchNotice
        // 读出来就写回 pendingNotice: null）⇒ 两条通道争抢**同一条**提示
        // ⇒ 谁先到谁发，**保证一定有人发，且只发一次**（消费本身在
        // restoreAfterLogin 里是串行的，同时抢也不会发出两条）。
        //
        // 【为什么放在最前面】这一条不许被「初始化失败」之类的分支跳过：
        // 它消费的是**持久**提示，而「登录态」由 deliverAccountSwitchNotice
        // 自己判（没登录就不消费，见 restoreAfterLogin 的注释）⇒
        // 放在最前面既不会误伤，也保证「提示迟早有人告知」。
        void deliverAccountSwitchNotice();

        // ── ① 本机缓存先行（本地读，零延迟、零下载）────────────────────
        const cachedAuth = await authCache.getAuthState();
        const cachedUser =
          cachedAuth?.isAuthenticated && cachedAuth.user ? cachedAuth.user : null;
        if (cachedUser) {
          logInfo('发现缓存的认证状态，用户:', cachedUser.email);
          // ── 2026-10-23 审计 R-12：缓存里明明有登录态，Redux 却还是 false ──
          //
          // 【为什么必须在这里就 dispatch】原来这一段**只打了一行日志**
          // （注释写的是「这里可以设置用户状态，但不直接dispatch」）⇒
          // 冷启动的第一帧，`state.auth.isAuthenticated` 恒为 false
          // （authSlice 的初值），登录态要等**网络回包**（getCurrentUser.fulfilled）
          // 才补上 ⇒ 换设备的老用户（他的会话在云端、本机是空的）
          // 在那一两秒里看到的是空态卡上的「**登录 TapStack 云端**」——
          // 而他明明登录着，点它会把他带去重新登录一遍。
          // 这正是 L-11（空态出口）最想服务的那个用户，却先看到了错的那一个。
          //
          // 【为什么这不算「谎报已登录」】缓存登录态是**暂定事实**，
          // 随后的会话检查会修正它：
          //   · 会话还在 ⇒ 核到 ⇒ 登录态维持；
          //   · 会话没了 ⇒ 核到「没登录」⇒ isAuthenticated 归零；
          //   · 服务端不可用（402）⇒ 按缓存保留登录态（见下面的 catch 分支）。
          // ⇒ 提前置真只是把「几毫秒后才知道的事」提前说，
          //   最坏情况是「先显示已登录、随后翻回未登录」，
          //   而不是「一直谎报」。
          dispatch(setFromCache({ user: cachedUser, isAuthenticated: true }));
        }

        // ── ② 联网核登录态 —— **交给 service worker** ──────────────────
        //
        // 弹窗**不加载** Supabase SDK（那 75KB 就是这么省掉的）：
        // 核在后台做，后台的 SDK 是静态依赖 ⇒ 零下载。
        let status;
        try {
          status = await requestAuthStatus();
        } catch (err) {
          // 通道断了（SW 正在重启 / 扩展刚更新）⇒ **不知道**，不等于「没登录」。
          // 保留缓存那份（上面已经 dispatch 过了）⇒ 这里什么都不用做。
          logWarn('[auth] 核登录态失败（不知道，不等于没登录）:', err);
          return;
        }

        if (status.kind === 'authenticated' && status.user) {
          dispatch(
            setFromCache({
              user: {
                id: status.user.id,
                email: status.user.email,
                lastLogin: cachedUser?.lastLogin ?? new Date().toISOString(),
              },
              isAuthenticated: true,
            })
          );
          // 核到登录着 ⇒ 顺手把云端拉回来（跨设备找回）。
          //
          // ⚠️ 下载**在后台做**（命令本来就发给后台）⇒ 弹窗不碰 SDK。
          //
          // 2026-10-19 审计 P1-4：若用户在本次页面会话里**已经登录过**，
          // 那次恢复已经由 restoreAfterLogin 触发过了（显式意图）——
          // 这里再发一次就是「登录一次跑两遍整库下载 + 两遍 merge 写盘」。
          // 判据：hasLoginRestoreTriggered()。
          if (hasLoginRestoreTriggered()) {
            logInfo('[AutoSync] 本次登录已触发过恢复，跳过重复下载');
            return;
          }
          // auto:true = 自动触发而非用户手点：SW 侧在已有 sync 任务在途时
          // 直接回 already_syncing（见 service-worker SYNC 分支的去重闸门），
          // 不再排第二条整库下载 —— 否则这条消息只能排队等满 30s 协议超时。
          sendSyncCommand('download', { auto: true })
            .then(res => {
              if (res.ok) {
                const payload = res.payload as { groups?: unknown[] } | undefined;
                logInfo(`[AutoSync] 自动下载合并完成: ${payload?.groups?.length ?? 0} 个组`);
                // 合并结果写进了 storage，需刷新 Redux 让 UI 更新
                dispatch(loadGroups());
              } else if (
                res.error &&
                res.error !== 'already_syncing' &&
                res.error !== 'recent_upload_guard' &&
                res.error !== 'pending_upload_failed' &&
                res.error !== 'auto_sync_disabled'
              ) {
                // ── 2026-10-11（1.23.0）：auto_sync_disabled 是稳态，不是故障 ──
                // 用户关了自动同步，SW 侧门禁拦下本轮自动下载。白名单静默它
                // （与 already_syncing 同待遇）：「关」是用户显式选择，
                // 每次打开页面弹一句 warn 等于为正常状态制造噪声。
                // 「数据可能过期」这层信息由菜单里的开关行与提示行承担，
                // 不在这里出声 —— 出声的位置必须离控制越近越好。
                logWarn('[AutoSync] 自动下载未成功:', res.error);
              }
            })
            .catch(err => logWarn('[AutoSync] 自动下载异常:', err));
        } else if (status.kind === 'not_authenticated') {
          // 明确核到「没有会话」⇒ 真的没登录 ⇒ 归零。
          // ⚠️ 只有这一档才归零：「服务端不可用」与「不知道」都保留缓存那份。
          dispatch(setFromCache({ user: null, isAuthenticated: false }));
          logInfo('后台核到：未登录');
        } else {
          // backend_unavailable / unknown ⇒ 保留缓存那份（**不许**说「没登录」）。
          logInfo(
            status.kind === 'backend_unavailable'
              ? '[auth] 云端项目不可用，按缓存保留登录态（不说「未登录」）'
              : '[auth] 登录态未知，按缓存保留登录态（不说「未登录」）'
          );
        }
      } catch (error) {
        logError('初始化认证状态失败:', error);
      }
    };

    initializeAuth();
  }, [dispatch]);

  return <>{children}</>;
};
