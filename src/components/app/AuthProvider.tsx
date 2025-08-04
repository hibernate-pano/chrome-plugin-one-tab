import React, { useEffect, useState } from 'react';
import { useAppDispatch } from '@/store/hooks';
import { getCurrentUser } from '@/store/slices/authSlice';
import { auth as supabaseAuth } from '@/utils/supabase';
import { authCache } from '@/utils/authCache';

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
        console.log('开始初始化认证状态...');

        // 首先检查缓存的认证状态
        const cachedAuth = await authCache.getAuthState();
        if (cachedAuth && cachedAuth.isAuthenticated && cachedAuth.user) {
          console.log('发现缓存的认证状态，用户:', cachedAuth.user.email);
          // 这里可以设置用户状态，但不直接dispatch，让后续的会话检查来处理
        }

        // 标记认证初始化完成
        setInitialAuthLoaded(true);
        console.log('认证状态初始化完成');
      } catch (error) {
        console.error('初始化认证状态失败:', error);
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
        console.log('检查用户会话状态...');

        // 使用 getSession 而不是 getCurrentUser 来避免未登录用户的错误
        const { data } = await supabaseAuth.getSession();
        if (data.session) {
          console.log('发现活跃会话，获取用户信息...');
          // 只有确认有会话时才调用 getCurrentUser
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

  return <>{children}</>;
};
