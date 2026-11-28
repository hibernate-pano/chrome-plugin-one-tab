/**
 * 读「最近使用」本机记录的 React 入口。
 *
 * 为什么要有这一层：`storage-kv/lastUsedAtStore` 是纯数据模块（不 import React），
 * 而组件需要「读到 + 跟着变」。两者拆开之后：
 *   · 存储模块可以在 Node 测试里直接跑（无需 React）；
 *   · 组件只依赖这一个 hook，不关心 KV/订阅细节。
 *
 * ⚠️ SSR（本仓测试用 `renderToStaticMarkup`）不跑 effect ⇒ 不会触发磁盘读取；
 * `useSyncExternalStore` 的 server snapshot 用当前内存快照（测试可用
 * `__seedLastUsedAtForTests` 预置）。生产环境每次挂载时读一次磁盘。
 */
import { useEffect, useSyncExternalStore } from 'react';
import {
  getLastUsedAtSnapshot,
  loadLastUsedAt,
  subscribeLastUsedAt,
  type LastUsedAtMap,
} from '@/storage-kv/lastUsedAtStore';

export function useLastUsedAtMap(): LastUsedAtMap {
  const map = useSyncExternalStore(
    subscribeLastUsedAt,
    getLastUsedAtSnapshot,
    getLastUsedAtSnapshot
  );
  useEffect(() => {
    void loadLastUsedAt();
  }, []);
  return map;
}
