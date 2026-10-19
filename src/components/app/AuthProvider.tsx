import React, { useEffect, useState } from 'react';
import { useAppDispatch } from '@/store/hooks';
import { getCurrentUser } from '@/store/slices/authSlice';
import { loadGroups } from '@/store/slices/tabSlice';
import { auth as supabaseAuth } from '@/utils/supabaseFacade';
import { authCache } from '@/utils/authCache';
import { sendSyncCommand } from '@/shared/mutationProtocol';
import { hasLoginRestoreTriggered } from '@/components/auth/restoreAfterLogin';
import { logError, logInfo, logWarn } from '../../utils/log';

interface AuthProviderProps {
  children: React.ReactNode;
}

/**
 * 认证提供者组件
 * 负责处理用户认证状态的初始化和管理
 */
export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const dispatch = useAppDispatch();
  const [initialAuthLoaded, setInitialAuthLoaded] = useState(false);

  // 初始化认证状态
  useEffect(() => {
    const initializeAuth = async () => {
      try {
        logInfo('开始初始化认证状态...');

        // 首先检查缓存的认证状态
        const cachedAuth = await authCache.getAuthState();
        if (cachedAuth && cachedAuth.isAuthenticated && cachedAuth.user) {
          logInfo('发现缓存的认证状态，用户:', cachedAuth.user.email);
          // 这里可以设置用户状态，但不直接dispatch，让后续的会话检查来处理
        }

        // 标记认证初始化完成
        setInitialAuthLoaded(true);
        logInfo('认证状态初始化完成');
      } catch (error) {
        logError('初始化认证状态失败:', error);
        setInitialAuthLoaded(true); // 即使失败也要标记完成，避免阻塞应用
      }
    };

    initializeAuth();
  }, []);

  // 检查实际的登录状态
  useEffect(() => {
    if (!initialAuthLoaded) return;

    const checkSession = async () => {
      try {
        logInfo('检查用户会话状态...');

        // 使用 getSession 而不是 getCurrentUser 来避免未登录用户的错误
        const { data } = await supabaseAuth.getSession();
        if (data.session) {
          logInfo('发现活跃会话，获取用户信息...');
          // 只有确认有会话时才调用 getCurrentUser
          dispatch(getCurrentUser())
            .unwrap()
            .then(user => {
              if (user) {
                logInfo('用户已自动登录:', user.email);
                // 登录后自动从云端合并到本地（跨设备找回。失败不阻塞，静默处理）
                //
                // 2026-10-19 审计 P1-4：若用户在本次页面会话里**已经登录过**，
                // 那次恢复已经由 restoreAfterLogin 触发过了（显式意图）——
                // 这里再发一次就是「登录一次跑两遍整库下载 + 两遍 merge 写盘」。
                // 判据：hasLoginRestoreTriggered()。
                if (hasLoginRestoreTriggered()) {
                  logInfo('[AutoSync] 本次登录已触发过恢复，跳过重复下载');
                } else {
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
                  } else if (res.error && res.error !== 'already_syncing' && res.error !== 'recent_upload_guard' && res.error !== 'pending_upload_failed' && res.error !== 'auto_sync_disabled') {
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
                }
              }
            })
            .catch(() => {
              logInfo('获取用户信息失败，但会话存在');
            });
        } else {
          logInfo('没有活跃会话，用户未登录');
        }
      } catch (err) {
        logInfo('检查会话状态时出错，假定用户未登录');
      }
    };

    checkSession();
  }, [dispatch, initialAuthLoaded]);

  return <>{children}</>;
};
