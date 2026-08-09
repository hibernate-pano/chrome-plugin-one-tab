import type { Middleware } from '@reduxjs/toolkit';
import { createAction } from '@reduxjs/toolkit';

/**
 * 占位 action —— 由 moveTabAndSync 等 thunk dispatch。
 *
 * 设计动机：DnD hover 期间会高频 dispatch 同一个"该持久化了"信号。
 * 真正的 storage.setGroups 副作用由 `debouncedPersistMiddleware` 监听本 action
 * 后做 200ms trailing 合并，只产生一次写盘往返。
 */
export const persistGroupsDebounced = createAction('tabs/persistGroupsDebounced');

export interface DebouncedPersistOptions {
  /**
   * 延迟窗口结束时实际执行的副作用。
   * 通常 = dispatch(persistGroupsThunk())，由调用方在 factory 里闭包注入。
   */
  persistFn: () => void;
  /** trailing 延迟毫秒数；默认 200ms。 */
  delayMs?: number;
}

/**
 * 合并高频 `persistGroupsDebounced` action 到一次延迟 persist。
 *
 * 行为契约：
 * - 每次收到 `persistGroupsDebounced` 都重置 timer（trailing 语义）。
 * - 在 `delayMs` 静默期之后**恰好**调用一次 `persistFn`。
 * - 其他 action 一律放行（`next(action)` 后直接返回），不参与计时。
 * - `persistFn` 执行本身如果抛错会冒泡到调用方；timer 在调用结束后清空，
 *   下一次 persist 重新开始计时。
 */
export function debouncedPersistMiddleware(
  opts: DebouncedPersistOptions
): Middleware {
  const delay = opts.delayMs ?? 200;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => next => action => {
    const result = next(action);
    if ((action as { type?: string }).type !== persistGroupsDebounced.type) {
      return result;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      opts.persistFn();
    }, delay);
    return result;
  };
}
