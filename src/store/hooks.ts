import { TypedUseSelectorHook, useDispatch, useSelector } from 'react-redux';
import type { RootState } from '@/types/tab';
import { store } from './index';

/**
 * 应用级 dispatch 类型。
 *
 * 导出它（而不只是内部用）是为了让**非组件**的模块也能拿到正确的 dispatch
 * 类型 —— 例如 components/auth/restoreAfterLogin.ts 里的「登录后拉一次
 * 云端会话」（2026-10-19 审计 F-6）。
 */
export type AppDispatch = typeof store.dispatch;

export const useAppDispatch = () => useDispatch<AppDispatch>();
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector; 