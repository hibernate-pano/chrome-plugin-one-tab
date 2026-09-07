/**
 * 语义命令协议（规格 §3.1/§3.2）：popup/Web 不再自己写 storage，
 * 通过 MUTATE/SYNC 消息把命令交给 SW 的 mutationService 执行。
 * sender 可注入，node:test 无 chrome 环境可测。
 */
import type { TabGroup } from '@/types/tab';

export type MutationOp =
  | { op: 'saveGroup'; group: TabGroup }
  | { op: 'removeTab'; groupId: string; tabId: string }          // 点开=移出、显式删除，同语义
  | { op: 'deleteGroup'; groupId: string }
  | { op: 'deleteAllGroups' }
  | { op: 'restoreGroup'; groupId: string }
  | { op: 'purgeGroup'; groupId: string }
  | { op: 'importGroups'; groups: TabGroup[] }
  | { op: 'renameGroup'; groupId: string; name: string }
  | { op: 'toggleGroupLock'; groupId: string }
  | { op: 'moveGroup'; dragIndex: number; hoverIndex: number }
  | { op: 'moveTab'; sourceGroupId: string; sourceIndex: number; targetGroupId: string; targetIndex: number; updateSourceInDrag?: boolean }
  | { op: 'cleanDuplicates' };

export interface MutationResult<P = unknown> {
  ok: boolean;
  error?: string;
  payload?: P;
}

export type MessageSender = (msg: unknown) => Promise<unknown>;

function defaultSender(msg: unknown): Promise<unknown> {
  return chrome.runtime.sendMessage(msg);
}

export async function sendMutation<P = unknown>(
  cmd: MutationOp,
  sender: MessageSender = defaultSender
): Promise<MutationResult<P>> {
  try {
    const res = (await sender({ type: 'MUTATE', data: cmd })) as MutationResult<P> | undefined;
    if (!res) return { ok: false, error: 'SW 无响应' };
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type SyncOp = 'upload' | 'download' | 'scheduleUpload';

export async function sendSyncCommand(
  op: SyncOp,
  extra: Record<string, unknown> = {},
  sender: MessageSender = defaultSender
): Promise<MutationResult> {
  try {
    const res = (await sender({ type: 'SYNC', data: { op, ...extra } })) as MutationResult | undefined;
    if (!res) return { ok: false, error: 'SW 无响应' };
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
