/**
 * 标签组「变化了」事件总线（groups changed bus）。
 *
 * 【为什么需要这个模块（2026-09-30 修 P0）】
 * 组数据早已从 chrome.storage.local 迁到 IndexedDB（见 ./storageAdapter，
 * db=tabvaultpro / store=kv / key=tab_groups）。但 UI 侧唯一的刷新信号
 * onGroupsChanged（@/utils/storage）一直只监听 chrome.storage.onChanged
 * —— 那个事件**在生产写路径上永远不会再触发**，因为 kvSet 写的是 IndexedDB。
 * 结果：Service Worker 在后台保存标签、导入、同步下载合并之后，已打开的管理页
 * 列表永不刷新（30s 缓存也不会被失效，列表一直显示旧快照）。
 *
 * 修复取「驱动源」：事件从**写入口**发出，而不是从某个存储后端事件反推。
 * 本模块只提供两件事：
 *   1. notifyGroupsChanged()：写方在 groups 落盘后调用；
 *   2. subscribeGroupsChanged()：读方（管理页）订阅，收到即失效缓存 + 重新加载。
 *
 * 【为什么还要跨进程广播】
 * chrome 里 groups 有多个写入上下文：popup 进程（迁移/导入兜底）与 MV3
 * Service Worker（所有 mutation、TabManager 保存、同步合并）。同进程订阅
 * 只能覆盖自己那次写；SW 写完必须让 popup 进程知道，否则 bug 原样存在。
 * 扩展内的跨上下文通知只有 chrome.runtime 消息这一条通道（IndexedDB 没有
 * 变更通知）。因此 notify 时同时做两件事：本地 emit + runtime.sendMessage 广播。
 *
 * 【为什么收到广播后不再广播】
 * 消息触发的路径只 emit、不再发消息，否则 SW ↔ popup 会互相触发、无限消息风暴。
 * 这也是本模块与「谁收到谁转发」写法唯一的区别，请勿改动。
 *
 * 【不变量】
 * - 通知是**尽力而为**的提示，不是数据通道：丢了通知最坏结果是列表晚一次刷新
 *   （用户下次交互/重新打开 popup 会看到真值），绝不影响写入本身的结果。
 * - 绝不在本模块里 await/阻塞写路径：sendMessage 的 reject 一律吞掉。
 */

import { logWarn } from '../utils/log';

/** 跨上下文广播用的消息类型。改它要同步改 onGroupsChanged 的订阅侧（本文件内）。 */
const GROUPS_CHANGED_MESSAGE = 'TABSTACK_GROUPS_CHANGED';

/**
 * 订阅回调会收到 originId：发起这次写入的上下文身份（UI 语义命令会带）。
 * 订阅方自己决定要不要响应——维护乐观状态的订阅方（列表）应忽略自己的回声，
 * 而只失效缓存 / 读存储真值的订阅方则照常处理。总线不做过滤，避免把
 * 「缓存该失效」也一并吞掉。
 */
type Listener = (originId?: string) => void;

const listeners = new Set<Listener>();
let runtimeListenerRegistered = false;

function canSendRuntimeMessage(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.runtime?.sendMessage === 'function';
}

/** 同进程派发：逐个调用订阅者，单个订阅者抛错不影响其余订阅者。 */
function emitLocally(originId?: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(originId);
    } catch (error) {
      logWarn('[groupsChangedBus] 订阅者抛错（已忽略）:', error);
    }
  }
}

/** 跨上下文广播。没有接收方时 sendMessage 会 reject —— 那正是「没人要听」，吞掉。 */
function broadcast(originId?: string): void {
  if (!canSendRuntimeMessage()) return;
  try {
    const maybePromise = chrome.runtime.sendMessage({ type: GROUPS_CHANGED_MESSAGE, originId });
    if (maybePromise && typeof maybePromise.catch === 'function') {
      maybePromise.catch(() => undefined);
    }
  } catch {
    /* 广播失败不影响写入结果 */
  }
}

function ensureRuntimeListener(): void {
  if (runtimeListenerRegistered) return;
  if (typeof chrome === 'undefined' || typeof chrome.runtime?.onMessage?.addListener !== 'function') return;
  runtimeListenerRegistered = true;
  chrome.runtime.onMessage.addListener((message: { type?: string; originId?: string }) => {
    // 只 emit，不转发（见文件头「为什么收到广播后不再广播」）
    if (message?.type === GROUPS_CHANGED_MESSAGE) emitLocally(message.originId);
  });
}

/**
 * 写方在 groups 落盘（且本进程 30s 缓存已更新）之后调用。
 * 同进程订阅者立即收到；其它扩展上下文经 runtime 消息收到。
 *
 * originId：发起写入的上下文身份（UI 语义命令会带上），原样交给订阅方。
 * 缺省表示「非 UI 发起」（SW 自身写入）；两类都会广播，过滤判定在订阅方。
 */
export function notifyGroupsChanged(originId?: string): void {
  emitLocally(originId);
  broadcast(originId);
}

/**
 * 读方订阅。返回取消订阅函数。
 * 首次订阅时才注册 runtime 消息监听（懒注册：写方从不订阅，不该为它付出唤醒代价）。
 */
export function subscribeGroupsChanged(cb: Listener): () => void {
  listeners.add(cb);
  ensureRuntimeListener();
  return () => {
    listeners.delete(cb);
  };
}

/** 仅供测试：清空订阅者与 runtime 监听注册标记。 */
export function __resetGroupsChangedBusForTests(): void {
  listeners.clear();
  runtimeListenerRegistered = false;
}
