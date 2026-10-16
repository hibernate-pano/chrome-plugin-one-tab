import { TypedUseSelectorHook, useDispatch, useSelector } from 'react-redux';
// 2026-10-16：原先 import 的是 `@/types/tab` 里那个手写的 RootState 接口。
// 它列了 `auth: AuthState`，而账号体系删除后 store 里已经没有 auth 分片——
// 手写副本一旦与 store 的真实形状漂移，错误只会在某一处冒出来
// （本例：TabCounter 的 groups 变成 any，reduce 参数全丢类型）。
// 改为直接从 store 取推导类型：**唯一真相源**，不可能漂移。
import type { RootState } from './index';
import { store } from './index';

type AppDispatch = typeof store.dispatch;

export const useAppDispatch = () => useDispatch<AppDispatch>();
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector; 