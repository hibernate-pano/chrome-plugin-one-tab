/**
 * 冲突提示「有了」事件总线（conflict notice bus）。
 *
 * ── 为什么需要这个模块（2026-11-14 P0-1 的收尾）──────────────────────────
 *
 * 冲突提示的写方是 **Service Worker**（backgroundSync 在后台合并后落
 * pending_conflict_notice），读方是 **popup** 的 SyncConflictNotifier。
 * KV 层落在 IndexedDB ⇒ chrome.storage.onChanged 永不触发（见
 * settingsChangedBus 头注释的同一论证）⇒ 若 popup **已经开着**，只靠
 * 「挂载时读一次」，本轮新落的提示要等用户下次打开 popup 才能看到 ——
 * 对「手动点同步」的场景（popup 开着等结果）这是肉眼可见的迟到。
 *
 * 形状照抄 groupsChangedBus / settingsChangedBus（同仓已有的正确范式）：
 * · 本地 emit + chrome.runtime 广播（IndexedDB 没有变更通知，扩展内跨上下文
 *   只有 runtime 消息这一条通道）；
 * · 收到广播后只 emit、不再广播（防 realm 间消息风暴）；
 * · 通知是尽力而为的提示，不是数据通道：丢了通知最坏结果是提示晚一次展示
 *   （用户下次打开 popup 时挂载读取仍会兜底），绝不影响落盘本身；
 * · 绝不 await/阻塞写路径：sendMessage 的 reject 一律吞掉
 *   （SW 自身的 onMessage 路由对未知 type 会回「未知消息类型」，同样无害）。
 *
 * 与那两个总线唯一的语义差异：订阅方收到的是「存储里**可能**有一条新提示」，
 * 要**自己重读**（consumePendingNotice），总线不携带数据 —— 提示内容只在
 * chrome.storage（KV 层）里有一份真值，避免「总线数据 vs 落盘数据」两份漂移。
 */

import { logWarn } from '../utils/log';

/** 跨上下文广播用的消息类型。改它要同步改订阅侧（本文件内）。 */
const CONFLICT_NOTICE_CHANGED_MESSAGE = 'TABSTACK_CONFLICT_NOTICE_CHANGED';

type Listener = () => void;

const listeners = new Set<Listener>();
let runtimeListenerRegistered = false;

function canSendRuntimeMessage(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.runtime?.sendMessage === 'function';
}

/** 同进程派发：逐个调用订阅者，单个订阅者抛错不影响其余订阅者。 */
function emitLocally(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      logWarn('[conflictNoticeBus] 订阅者抛错（已忽略）:', error);
    }
  }
}

/** 跨上下文广播。没有接收方时 sendMessage 会 reject —— 那正是「没人要听」，吞掉。 */
function broadcast(): void {
  if (!canSendRuntimeMessage()) return;
  try {
    const maybePromise = chrome.runtime.sendMessage({ type: CONFLICT_NOTICE_CHANGED_MESSAGE });
    if (maybePromise && typeof maybePromise.catch === 'function') {
      maybePromise.catch(() => undefined);
    }
  } catch {
    /* 广播失败不影响落盘结果 */
  }
}

function ensureRuntimeListener(): void {
  if (runtimeListenerRegistered) return;
  if (typeof chrome === 'undefined' || typeof chrome.runtime?.onMessage?.addListener !== 'function') return;
  runtimeListenerRegistered = true;
  chrome.runtime.onMessage.addListener((message: { type?: string }) => {
    // 只 emit，不再广播（见文件头「防消息风暴」）
    if (message?.type === CONFLICT_NOTICE_CHANGED_MESSAGE) emitLocally();
  });
}

/**
 * 写方（backgroundSync）在 pending_conflict_notice 落盘成功之后调用。
 * 同进程订阅者立即收到；其它扩展上下文经 runtime 消息收到。
 */
export function notifyConflictNoticeChanged(): void {
  emitLocally();
  broadcast();
}

/**
 * 读方订阅（SyncConflictNotifier）。返回取消订阅函数。
 * 首次订阅时才注册 runtime 消息监听（懒注册）。
 */
export function subscribeConflictNoticeChanged(cb: Listener): () => void {
  listeners.add(cb);
  ensureRuntimeListener();
  return () => {
    listeners.delete(cb);
  };
}

/** 仅供测试：清空订阅者与 runtime 监听注册标记。 */
export function __resetConflictNoticeBusForTests(): void {
  listeners.clear();
  runtimeListenerRegistered = false;
}
