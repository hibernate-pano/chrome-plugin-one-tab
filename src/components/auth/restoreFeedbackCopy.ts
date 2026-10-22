/**
 * 「登录成功 → 把云端的会话拉回本机」这条链路的**用户可见回执**（纯函数）。
 *
 * ── 缺陷本体（2026-10-22 审计 SC-6）───────────────────────────────────────
 *
 * 这条链路原本只回一个**数字**（`restoreAfterLogin` 返回 `number`），
 * 而「拉回失败」与「云端本来就是空的」都回 **0** ⇒ 两种 0 混成一种：
 *
 *   · 调用方 `if (count > 0) showToast(…)` ⇒ **count === 0 时一句话都没有**；
 *   · 注册后的自动登录更是 `void restoreAfterLogin(dispatch)` ⇒ 永远零反馈。
 *
 * ⇒ 用户登录成功、弹窗关闭、界面显示「已登录」，但**云端的会话一个都没回来**，
 * 而且**一句解释都没有**。用户会以为「云端的数据没了」。
 *
 * ── 修法：把「结果」与「文案」分开 ──────────────────────────────────────────
 *
 *   · `CloudPullOutcome`（domain 层）：**三种**结果 ——
 *     拉到 N 个 / 云端本来就是空的 / 拉回失败；
 *   · 本模块：三种结果 → **三种不同**的回执（含语气）。
 *
 * 判据层直接断言这三个出口：结果不同 ⇒ 话必须不同；
 * 失败**必须**出声（不许静默）。
 */
import {
  cloudPullEmptyMessage,
  cloudPullSuccessMessage,
  type CloudPullOutcome,
} from '@/domain/tabGroup/cloudPullCopy';
import { resolveSyncFailureCopy } from '@/components/sync/syncPreviewView';

/** 一条回执的语气（对应 toast 的类型）。 */
export type LoginRestoreTone = 'success' | 'info' | 'error';

/** 一次「登录后拉回」要给用户看的那句话。 */
export interface LoginRestoreFeedback {
  /** 语气：拉到东西=成功；云端为空=提示（不是失败！）；失败=错误。 */
  tone: LoginRestoreTone;
  /** 完整句子。 */
  text: string;
}

/**
 * 结果 → 回执（**单源**）。
 *
 * 三种结果必须是**三句不同的话**：
 *   · 拉到 N 个 → 「已从云端拉回 N 个会话」（与空态出口同一句，见 cloudPullCopy）；
 *   · 云端为空 → 「云端没有会话可拉回」（不是失败，别用错误语气）；
 *   · 拉回失败 → 说清「登录**成功了**，但没拉回来」并给出路
 *     （右上角菜单里的「从云端刷新数据」）。
 */
export const loginRestoreFeedback = (outcome: CloudPullOutcome): LoginRestoreFeedback => {
  switch (outcome.kind) {
    case 'pulled':
      return { tone: 'success', text: cloudPullSuccessMessage(outcome.count) };
    case 'empty':
      return { tone: 'info', text: cloudPullEmptyMessage() };
    case 'failed': {
      // 失败原因用机器码 → 中文文案的统一映射（syncPreviewView），
      // 不要把裸枚举弹给用户，也不要自己另写一份映射。
      const reason = resolveSyncFailureCopy({
        reason: outcome.reason,
        fallbackMessage: '没能连上云端',
        backendUnavailable: outcome.backendUnavailable === true,
        direction: 'download',
      });
      return {
        tone: 'error',
        text:
          `登录成功，但没能把云端的会话拉回来：${reason}。` +
          '可以在右上角菜单里点「从云端刷新数据」再试一次。',
      };
    }
  }
};
