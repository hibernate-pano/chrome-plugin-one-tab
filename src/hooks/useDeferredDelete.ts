import { useState, useRef, useCallback, useEffect } from 'react';

/**
 * S3 §4: 延迟删除 Hook —— 把"立即删除"改为"通知 + 10s 撤销窗口"。
 *
 * 用法（TabGroup.handleDelete 简化）：
 *   const { requestDelete, cancel, pending } = useDeferredDelete({
 *     delayMs: 10000,
 *     onCommit: () => dispatch(deleteGroup(group.id)),
 *   });
 *   showToast({
 *     message: `已删除"${group.name}"`,
 *     action: { label: '撤销', onClick: cancel },
 *   });
 *   requestDelete();
 *
 * 行为：
 * - requestDelete：启动（或重置）定时器；如果已有 timer 还在等待，新调用会清掉旧 timer 再排队。
 *   达到 delayMs 后调用 onCommit，并把 pending 置回 false。
 * - cancel：撤销未触发的 commit；清掉 timer；pending 置回 false。
 * - pending：true 表示 timer 还在等待（可用于 UI 提示）。
 *
 * 设计选择：
 * - 用 useRef 持有 timer 句柄，避免每次 render 重建闭包。
 * - useState 暴露 pending，方便组件按需渲染提示（如"30 秒后可撤销"）。
 * - 卸载时 cleanup 防止 setState-after-unmount。
 * - 不依赖 Redux：commit 由组件传进回调，符合 S3 §4.2 "组件局部状态 + Redux 不变"原则。
 */

export interface UseDeferredDeleteOptions {
  /** 等待多久后真正 commit（毫秒）。默认 10000。 */
  delayMs?: number;
  /** 延迟到期后真正执行的动作（一般为 `dispatch(deleteGroup(id))`）。 */
  onCommit: () => void;
}

export interface UseDeferredDeleteResult {
  /** 启动 / 重置定时器。 */
  requestDelete: () => void;
  /** 撤销未触发的 commit（清掉 timer）。 */
  cancel: () => void;
  /** true 表示 timer 还在等待期。 */
  pending: boolean;
}

export function useDeferredDelete(
  opts: UseDeferredDeleteOptions
): UseDeferredDeleteResult {
  const { delayMs = 10000, onCommit } = opts;

  const [pending, setPending] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 保留最新 onCommit，避免父组件 onCommit 变化导致 hook 失效。
  const onCommitRef = useRef(onCommit);
  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const requestDelete = useCallback(() => {
    clearTimer();
    setPending(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setPending(false);
      onCommitRef.current();
    }, delayMs);
  }, [clearTimer, delayMs]);

  const cancel = useCallback(() => {
    clearTimer();
    setPending(false);
  }, [clearTimer]);

  // 卸载时清理 timer（防止 setState after unmount 警告）
  useEffect(() => {
    return () => clearTimer();
  }, [clearTimer]);

  return { requestDelete, cancel, pending };
}

export default useDeferredDelete;
