import React, { useEffect, useState, useRef } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { getCurrentUser } from '@/store/slices/authSlice';
import { auth as supabaseAuth } from '@/utils/supabase';
import { authCache } from '@/utils/authCache';
import { smartSyncService } from '@/services/smartSyncService';

interface AuthProviderProps {
  children: React.ReactNode;
}

/**
 * 认证提供者组件
 * 负责处理用户认证状态的初始化和管理
 */
export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const dispatch = useAppDispatch();
  const isAuthenticated = useAppSelector(state => state.auth.isAuthenticated);
  const [initialAuthLoaded, setInitialAuthLoaded] = useState(false);
  const autoDownloadAttempted = useRef(false);

  // 初始化认证状态 + SmartSyncService
  useEffect(() => {
    const initializeAuth = async () => {
      try {
        console.log('开始初始化认证状态...');

        const cachedAuth = await authCache.getAuthState();
        if (cachedAuth && cachedAuth.isAuthenticated && cachedAuth.user) {
          console.log('发现缓存的认证状态，用户:', cachedAuth.user.email);
        }

        // 预热 SmartSyncService（加载 lastSyncTime）
        await smartSyncService.initialize();

        setInitialAuthLoaded(true);
        console.log('认证状态初始化完成');
      } catch (error) {
        console.error('初始化认证状态失败:', error);
        setInitialAuthLoaded(true);
      }
    };

    initializeAuth();
  }, []);

  // 检查实际的登录状态
  useEffect(() => {
    if (!initialAuthLoaded) return;

    const checkSession = async () => {
      try {
        console.log('检查用户会话状态...');

        const { data } = await supabaseAuth.getSession();
        if (data.session) {
          console.log('发现活跃会话，获取用户信息...');
          dispatch(getCurrentUser())
            .unwrap()
            .then(user => {
              if (user) {
                console.log('用户已自动登录:', user.email);
              }
            })
            .catch(() => {
              console.log('获取用户信息失败，但会话存在');
            });
        } else {
          console.log('没有活跃会话，用户未登录');
        }
      } catch (err) {
        console.log('检查会话状态时出错，假定用户未登录');
      }
    };

    checkSession();
  }, [dispatch, initialAuthLoaded]);

  // 重置自动下载标记当用户登出时
  useEffect(() => {
    if (!isAuthenticated) {
      autoDownloadAttempted.current = false;
    }
  }, [isAuthenticated]);

  // 登录态确认后，静默拉取云端最新数据（仅触发一次）
  useEffect(() => {
    if (!isAuthenticated || autoDownloadAttempted.current) return;

    autoDownloadAttempted.current = true;

    // 延迟 2 秒，确保本地数据先加载完毕，避免并发竞争
    const timer = setTimeout(() => {
      smartSyncService.maybeAutoDownload().catch(err => {
        console.warn('[AutoDownload] 自动下载失败（静默）:', err?.message || err);
      });
    }, 2000);

    return () => clearTimeout(timer);
  }, [isAuthenticated]);

  return <>{children}</>;
};
