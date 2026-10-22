/**
 * 「恢复即消费」的撤销接线（2026-10-22 审计 P0-4）。
 *
 * ── 为什么抽成 hook ─────────────────────────────────────────────────────
 *
 * 撤销这条路径有**两个界面**（列表页 TabGroup / 搜索页 SearchResultList），
 * 而它们要做的事完全一样：
 *   ① 在成功提示上挂一个「撤销」按钮；
 *   ② 点它 → 派发 restoreConsumedAndSync → 成功/失败各出一句话。
 *
 * 两处各写一遍，第二遍就会漂 —— 而漂出来的是**行为**差异（一边能撤销、
 * 一边不能），不是文案差异。所以这里收成一处，两个界面共用。
 *
 * ── 撤销的是什么 ────────────────────────────────────────────────────────
 *
 * **记录，不是标签页。** 恢复动作已经把标签页开在浏览器里了；撤销把它们
 * 放回列表，不去关那些窗口（关掉会让用户更迷惑：标签页明明用着）。
 *
 * 语义与判据见 @/core/consumeUndo.ts。
 */
import { useCallback } from 'react';
import { useAppDispatch } from '@/store/hooks';
import { useEnhancedToast } from '@/utils/toastHelper';
import { restoreConsumedAndSync } from '@/store/slices/tabSlice';
import type { ConsumeUndoSpec } from '@/core/consumeUndo';
import type { ToastAction } from '@/components/common/Toast';
import {
  consumeUndoActionLabel,
  consumeUndoAlreadyRestoredMessage,
  consumeUndoAlreadyRestoredMessageMany,
  consumeUndoFailedMessage,
  consumeUndoSuccessMessage,
  consumeUndoSuccessMessageMany,
} from './consumeUndoCopy';

export interface ConsumeUndoApi {
  /**
   * 播报一次「消费」并给出撤销入口。
   *
   * @param message 成功提示正文（用 restoreFeedbackCopy 的统一措辞）
   * @param spec 撤销凭据。**省略 = 这次消费不可撤销**（例如锁定会话 ——
   *   锁定组从不被消费，没什么可撤）。这时只播报，不挂按钮。
   *   批量消费（一次动了好几个会话）传**数组** —— 每个会话一份凭据，
   *   撤销时逐个派发（互不影响：某个失败不影响其它）。
   * @param opts.type 提示类型。默认 'success'；'error' 用于「部分成功」
   *   （那次消费照样发生了，所以也要给退路）。
   */
  showConsumeToast: (
    message: string,
    spec?: ConsumeUndoSpec | ConsumeUndoSpec[],
    opts?: { type?: 'success' | 'error' }
  ) => void;
}

export function useConsumeUndo(): ConsumeUndoApi {
  const dispatch = useAppDispatch();
  const { showRestoreSuccessMessage, showRestoreError } = useEnhancedToast();

  const showConsumeToast = useCallback(
    (
      message: string,
      spec?: ConsumeUndoSpec | ConsumeUndoSpec[],
      opts?: { type?: 'success' | 'error' }
    ) => {
      const specs = spec === undefined ? [] : Array.isArray(spec) ? spec : [spec];
      const isError = opts?.type === 'error';
      // 「部分成功」的那条提示走错误通道，但**同样**要挂撤销 ——
      // 那次消费照样发生了（命中的标签已经从会话里移走）。
      const notify = (text: string, action?: ToastAction): void => {
        if (isError) showRestoreError(text, action);
        else showRestoreSuccessMessage(text, action);
      };
      if (specs.length === 0) {
        notify(message);
        return;
      }
      notify(message, {
        label: consumeUndoActionLabel,
        // 要不要把焦点交到这个按钮上：**要**，但只在安全的时候（判据见
        // toastPolicy.decideFocusClaim —— 键盘用户 + 不在输入框 + 没有对话框
        // 开着 才接管）。
        //
        // 为什么非抢不可：toast 挂在 body 末尾 ⇒ 它的按钮排在 Tab 序列的
        // **最后**。实测从「刚点完恢复」走到「撤销」要按十几次 Tab ——
        // 而那条提示 3 秒后就没了。抢焦点把这条退路变成**一次回车**。
        //
        // 为什么不是无脑抢：焦点一动，用户的下一次按键就落在别处了。
        // 鼠标用户点了「恢复」之后，若焦点被抢到「撤销」上，他下一次按空格
        // 就会**误触撤销**；而且焦点停在提示里 ⇒ 倒计时被暂停 ⇒ 提示赖着不走。
        autoFocus: true,
        onAction: () => {
          // 逐个派发、**串行**等前一个落地：并行会让两个 restoreConsumed
          // 同时读同一份 groups、同时写回 —— 后写的覆盖先写的（后写的那份
          // 快照里没有先写进去的那条）。
          void (async () => {
            let restoredCount = 0;
            for (const s of specs) {
              try {
                const payload = await dispatch(
                  restoreConsumedAndSync({
                    group: s.group,
                    consumedTabId: s.consumedTabId,
                    consumedIndex: s.consumedIndex,
                    consumedTabs: s.consumedTabs,
                  }),
                ).unwrap();
                if (payload.restored) restoredCount += 1;
              } catch (error: unknown) {
                // 失败必须出声且说清原因：用户点了撤销却什么都没发生，
                // 而事实是「那条记录仍然不在」—— 沉默会让他怀疑自己点错了。
                const reason =
                  error instanceof Error && error.message ? error.message : '未知原因';
                showRestoreError(consumeUndoFailedMessage(reason));
                return;
              }
            }
            if (restoredCount === 0) {
              notify(
                specs.length === 1
                  ? consumeUndoAlreadyRestoredMessage(specs[0].group.name)
                  : consumeUndoAlreadyRestoredMessageMany(specs.length),
              );
              return;
            }
            notify(
              specs.length === 1
                ? consumeUndoSuccessMessage(specs[0].group.name)
                : consumeUndoSuccessMessageMany(restoredCount),
            );
          })();
        },
      });
    },
    [dispatch, showRestoreError, showRestoreSuccessMessage],
  );

  return { showConsumeToast };
}
