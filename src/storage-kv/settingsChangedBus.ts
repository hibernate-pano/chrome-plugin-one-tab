/**
 * 设置「变化了」事件总线（settings changed bus）。
 *
 * ── 为什么需要这个模块（2026-10-24 审计 GAP1-1）─────────────────────────
 *
 * 设置落在 **IndexedDB**（KV 层），而 `chrome.storage.onChanged` **只盯着
 * chrome.storage** ⇒ 它**根本不触发** ⇒ 用它做跨上下文失效是行不通的。
 *
 * 而设置写方在**多个执行上下文**里（管理页标签、设置页标签、MV3 Service
 * Worker），每个 realm 各持一份**挂载时的快照**；修复前写设置还是**整份 state
 * 盲写** ⇒ 任何一个 realm 动一下开关，就把**整份**旧快照写回存储，把别的 realm
 * 刚写的值静默盖掉。（写侧已改成按字段落盘，见 settingsSlice 的 pendingIntent；
 * 本模块负责的是**读侧**：让别的 realm 的界面不再停在旧值上。）
 *
 * 实测的两个方向（真机可复现）：
 *   · 设置页把后端切成「自带存储（WebDAV）」⇒ 管理页点一次「切换到深色主题」
 *     ⇒ 磁盘上的 `syncBackend` 被静默改回 `supabase`，界面**仍显示** WebDAV
 *     选中 ⇒ 而真正决定同步去向的 `sync-backend/index.ts` 直读 `user_settings`
 *     ⇒ **界面显示 WebDAV、实际同步打向 TapStack 云端**，WebDAV 用户的同步静默失效；
 *   · 设置页挂着一个 60s 前的旧快照，用户随便拨一下「显示网站图标」⇒ 磁盘上
 *     刚被管理页改成深色的 `themeMode` 回到浅色，零提示。
 *
 * ⇒ 本模块提供**失效通道**（不是数据通道）：
 *   1. `notifySettingsChanged()`：写方在设置落盘后调用；
 *   2. `subscribeSettingsChanged()`：读方订阅，收到即失效缓存 + 重读。
 *
 * ── 它**不能**替代「字段级读-改-写」 ────────────────────────────────────
 *
 * 总线是**事后**通知：写方已经写下去了，别人已经写下的值可能已经被盖掉。
 * ⇒ 治本的那一半在写路径（`store/slices/settingsSlice.ts` 的 saveSettings：
 * 以磁盘真值为基准，只覆盖本次真正改动的字段）。总线负责的是**读侧**：
 * 让别的 realm 的界面不再停在旧值上。
 *
 * ── 形状照抄 groupsChangedBus（同一个仓库里已有的正确范式）────────────
 *
 * · 本地 emit + `chrome.runtime` 广播（IndexedDB 没有变更通知，扩展内跨上下文
 *   只有 runtime 消息这一条通道）；
 * · **收到广播后只 emit、不再广播**（否则 realm 之间互相触发 ⇒ 消息风暴）；
 * · 通知是**尽力而为**的提示，不是数据通道：丢了通知最坏结果是界面晚一次刷新，
 *   绝不影响写入本身的结果；
 * · 绝不在本模块里 await/阻塞写路径：`sendMessage` 的 reject 一律吞掉。
 */

import { logWarn } from '../utils/log';

/** 跨上下文广播用的消息类型。改它要同步改订阅侧（本文件内）。 */
const SETTINGS_CHANGED_MESSAGE = 'TABSTACK_SETTINGS_CHANGED';

/**
 * 订阅回调会收到 originId：发起这次写入的上下文身份。
 *
 * 订阅方自己决定要不要响应 —— 总线不做过滤（把「缓存该失效」一并吞掉是错的：
 * 那正是本模块存在的意义）。
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
      logWarn('[settingsChangedBus] 订阅者抛错（已忽略）:', error);
    }
  }
}

/** 跨上下文广播。没有接收方时 sendMessage 会 reject —— 那正是「没人要听」，吞掉。 */
function broadcast(originId?: string): void {
  if (!canSendRuntimeMessage()) return;
  try {
    const maybePromise = chrome.runtime.sendMessage({ type: SETTINGS_CHANGED_MESSAGE, originId });
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
    if (message?.type === SETTINGS_CHANGED_MESSAGE) emitLocally(message.originId);
  });
}

/**
 * 写方在设置落盘之后调用。
 *
 * 同进程订阅者立即收到；其它扩展上下文经 runtime 消息收到。
 */
export function notifySettingsChanged(originId?: string): void {
  emitLocally(originId);
  broadcast(originId);
}

/**
 * 读方订阅。返回取消订阅函数。
 * 首次订阅时才注册 runtime 消息监听（懒注册：写方从不订阅，不该为它付出唤醒代价）。
 */
export function subscribeSettingsChanged(cb: Listener): () => void {
  listeners.add(cb);
  ensureRuntimeListener();
  return () => {
    listeners.delete(cb);
  };
}

/** 仅供测试：清空订阅者与 runtime 监听注册标记。 */
export function __resetSettingsChangedBusForTests(): void {
  listeners.clear();
  runtimeListenerRegistered = false;
}
