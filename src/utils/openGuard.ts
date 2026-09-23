/**
 * 复活（恢复标签/会话）操作的在途去重守卫——纯模块，无 IO，可被 node:test 直测。
 *
 * 背景：恢复是“先开浏览器标签，再删本地项”两路并行；mutation 回包前重复点击
 * 会打开多个重复浏览器标签。守卫以 tabId / group.id 为 key 做去重：
 *
 * - OpenGuard：单 tab 恢复。未锁定组冷却 OPEN_COOLDOWN_MS（mutation 回包 + 肉眼
 *   可见的删除延迟内防重开）；已锁定组不删本地项、恢复立即可见，只需防双击
 *   OPEN_COOLDOWN_LOCKED_MS。dispatch 失败时调用方必须 release，否则失败的 tab
 *   会被“记住”一整个冷却窗口、用户点重试无反应。
 * - OpenAllGuard：整组恢复的同类在途锁，按 group.id 互斥；恢复流程结束（或失败）
 *   时调用方必须 release。
 *
 * Map/Set 膨胀控制：OpenGuard 命中过期条目即删；OpenAllGuard 的 key 只在
 * 在途期间存在，release 即删，不留长期条目。
 */

/** 未锁定组：单 tab 恢复冷却（覆盖 mutation 回包 + 列表刷新延迟） */
export const OPEN_COOLDOWN_MS = 3000;
/** 已锁定组：仅防双击 */
export const OPEN_COOLDOWN_LOCKED_MS = 500;

export function openCooldownMs(isLocked: boolean): number {
  return isLocked ? OPEN_COOLDOWN_LOCKED_MS : OPEN_COOLDOWN_MS;
}

export class OpenGuard {
  private lastOpen = new Map<string, number>();

  /** 待测/调试：当前记住的 tab 数 */
  get size(): number {
    return this.lastOpen.size;
  }

  /**
   * 尝试获得一次打开许可。返回 false 表示在冷却/在途期内，应直接忽略本次点击。
   * @param now 注入时钟，便于测试；生产调用默认 Date.now()
   */
  tryAcquire(tabId: string, isLocked: boolean, now: number = Date.now()): boolean {
    const last = this.lastOpen.get(tabId);
    if (last !== undefined) {
      if (now - last < openCooldownMs(isLocked)) return false;
      // 命中过期条目即删，避免 Map 随使用无限增长
      this.lastOpen.delete(tabId);
    }
    this.lastOpen.set(tabId, now);
    return true;
  }

  /** 恢复失败时清除记录，允许用户立即重试 */
  release(tabId: string): void {
    this.lastOpen.delete(tabId);
  }
}

export class OpenAllGuard {
  private inFlight = new Set<string>();

  get size(): number {
    return this.inFlight.size;
  }

  /** 同一 group 的恢复已在途时返回 false，调用方直接忽略 */
  tryAcquire(groupId: string): boolean {
    if (this.inFlight.has(groupId)) return false;
    this.inFlight.add(groupId);
    return true;
  }

  release(groupId: string): void {
    this.inFlight.delete(groupId);
  }
}
