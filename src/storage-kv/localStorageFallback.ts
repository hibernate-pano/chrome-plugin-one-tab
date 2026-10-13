import type { StorageDriver } from './types';

/**
 * 本环境**根本没有** localStorage（MV3 service worker、Node 测试环境）。
 *
 * 与「有 localStorage 但用不了」是两件不同的事，必须分开：
 *   · 不存在  → 这个环境本来就不该有本地数据（SW 无 window，读不到是事实）
 *   · 不可用  → 存储存在但操作失败（配额满 / 隐私模式），这是**故障**
 * 把两者都当成 `return null` 就是 P0 的根因：上层分不出「没有数据」与
 * 「读失败」，于是把一次存储故障静默降级成「用户一个会话都没有」。
 */
function hasLocalStorage(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
  } catch {
    // 访问 window.localStorage 本身抛错（某些 SW 环境）＝ 不存在
    return false;
  }
}

function isLocalStorageAvailable(): boolean {
  if (!hasLocalStorage()) return false;
  try {
    const testKey = '__tv_test__';
    window.localStorage.setItem(testKey, '1');
    window.localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

export const localStorageDriver: StorageDriver = {
  async getItem<T>(key: string): Promise<T | null> {
    // ── 2026-10-12 P0：读失败必须 fail-closed，不得与「键不存在」同形 ────
    //
    // 修复前这里是 `if (!isLocalStorageAvailable()) return null`，而 null 与
    // 「键真的不存在」在上层完全同形：storage.ts 的 getGroups() 只把 null 判成
    // 「首次使用 → 返回 []」。于是「localStorage 整体不可用（配额满 / 隐私模式 /
    // 站点数据被清）」会被静默降级成「用户一个会话都没有」，而所有写路径都是
    // 本方法的读-改-写（getGroupsForWrite → applySaveGroup → setGroupsImmediate），
    // 下一次写入就把整组会话覆盖成刚保存的那一条，**并且回报成功**。
    // v1.22.0 起无回收站、无撤销 ⇒ 这是静默数据丢失。
    //
    // 【为什么这里也必须 fail-closed】indexedDbClient.getItem 早已按同一口径
    // 抛错，但不变式只做在了那一个驱动上，没有做在「驱动选择」上——
    // storageAdapter.pickBackend() 在无 indexedDB 时会降级到这里，于是这条
    // fail-open 路径一直可达。修驱动而不是修调用方：调用方有十几处，
    // 而「读失败长成「没有数据」」这件事只该在一个地方被拒绝。
    //
    // 【两种「拿不到」要分开】只有「存储存在却操作失败」才抛错；
    // 「本环境根本没有 localStorage」仍返回 null —— 那是事实而非故障，
    // MV3 service worker 正是在这个分支上工作（它没有 window，
    // 本地数据一律走 chrome.storage，不经这里）。
    if (!hasLocalStorage()) return null;
    if (!isLocalStorageAvailable()) {
      throw new Error(
        '本地存储（localStorage）不可用：无法读取，已中止本次读取。' +
          '（不按空列表处理，避免已有会话被误判为不存在后整组覆盖）'
      );
    }
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // 非 JSON 内容直接返回字符串
      return raw as unknown as T;
    }
  },

  async setItem<T>(key: string, value: T): Promise<void> {
    // 写侧同理：修复前是静默 return，调用方以为写成功了（谎报成功）。
    // 静默 no-op 与「已落盘」对上层完全同形，两者对用户的意义相反 ⇒ 抛错。
    if (!hasLocalStorage()) return;
    if (!isLocalStorageAvailable()) {
      throw new Error('本地存储（localStorage）不可用：无法写入，已中止本次写入。');
    }
    window.localStorage.setItem(key, JSON.stringify(value));
  },

  async removeItem(key: string): Promise<void> {
    if (!hasLocalStorage()) return;
    if (!isLocalStorageAvailable()) {
      throw new Error('本地存储（localStorage）不可用：无法删除，已中止本次操作。');
    }
    window.localStorage.removeItem(key);
  }
};

export { isLocalStorageAvailable, hasLocalStorage };
