/**
 * 语义命令协议（规格 §3.1/§3.2）：popup/Web 不再自己写 storage，
 * 通过 MUTATE/SYNC 消息把命令交给 SW 的 mutationService 执行。
 * sender 可注入，node:test 无 chrome 环境可测。
 */
import type { TabGroup } from '../types/tab';
import { getContextOrigin } from './contextOrigin';

export type MutationOp =
  | { op: 'saveGroup'; group: TabGroup }
  | { op: 'removeTab'; groupId: string; tabId: string }          // 点开=移出、显式删除，同语义
  | { op: 'deleteGroup'; groupId: string }
  | { op: 'deleteAllGroups' }
  | { op: 'importGroups'; groups: TabGroup[] }
  | { op: 'renameGroup'; groupId: string; name: string }
  | { op: 'toggleGroupLock'; groupId: string }
  | { op: 'updateGroupFields'; groupId: string; fields: { isFavorite?: boolean; notes?: string } }
  | { op: 'moveTab'; sourceGroupId: string; sourceIndex: number; targetGroupId: string; targetIndex: number; updateSourceInDrag?: boolean }
  | { op: 'cleanDuplicates' };

export interface MutationResult<P = unknown> {
  ok: boolean;
  error?: string;
  payload?: P;
  /**
   * 「本地已生效，但有后续步骤没做成」的如实告知（2026-10-05）。
   *
   * 用于无墓碑模型的删除广播：本地物理移除已经成功（不可回滚，UI 的乐观
   * 更新是对的），但把 id 登记进 pendingDeleteIds 失败 ⇒ 云端行不会被标
   * is_deleted ⇒ 对端下次合并会把它当 remote-only 复活。
   *
   * 为什么不是 `ok: false`：本地确实删掉了，报「失败」会让 UI 显示成
   * 「删除失败」，而列表里那一组确实已经不见了 —— 那才是真的误导。
   * 为什么不能只 logWarn：用户看到「删除成功」就不会再检查第二遍，
   * 而实际结果是「本机删了、其它设备会复活」。
   *
   * 语义：**非空 ⇒ 调用方应当向用户表面提示**，但不得因此回滚本地状态。
   */
  broadcastWarn?: string;
}

export type MessageSender = (msg: unknown) => Promise<unknown>;

/**
 * 默认等待上限（1.22.11）。
 *
 * 【为什么必须有上限】SW 侧没有一处超时：supabase client 没配 AbortSignal、
 * 队列任务没有任务级上限、消息协议本身也只是裸 await。于是一旦 SW 忙（整库上传
 * / 逐组加解密）或已被浏览器回收，popup 这边就是**无限期转圈**：没有任何信号告诉
 * 用户「刚才那次点击没生效」，他只会以为界面死了。而 Chrome 的 popup 一失去焦点
 * 就销毁——用户点别处的那一刻，所有在途 sendMessage 的 Promise 会以同一句
 * "A listener indicated an asynchronous response by returning true, but the message
 * channel closed before a response was received" 一起 reject，实测表现为三条不同
 * 操作同时报这句错（自动下载 / 加载列表 / 清理重复）。
 *
 * 超时把「无限静默」换成「有界的、可归因的失败」：调用方拿到明确 reason，
 * 界面能给出「操作耗时过长，后台可能仍在继续」的文案，而不是通用兜底。
 *
 * 【为什么给到 30s】手动整库同步几百会话实测在秒级，但弱网 + 大库会明显更久；
 * 取值要能覆盖「慢但正常」，只在真正挂死时才触发。
 * 【超时不等于回滚】SW 侧的任务会继续跑完（这里只是不等了）。所以文案必须说
 * 「可能仍在继续」而不是「已取消」——对幂等的读/删除无所谓，对写操作若用户重试，
 * 底层 mutation 本身就是幂等的（见 core/mutationOps）。
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** 超时 reason 的稳定前缀：界面文案与测试都按它识别，不依赖具体耗时数字。 */
export const TIMEOUT_REASON_PREFIX = '操作超时';

/**
 * 给 sender 的 Promise 套一层上限。
 * 注意 Promise.race 不取消底层任务——这里要的就是「不等了」，不是「中止」。
 */
async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${TIMEOUT_REASON_PREFIX}（超过 ${Math.round(ms / 1000)} 秒无响应）：${label}`)),
          ms
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function defaultSender(msg: unknown): Promise<unknown> {
  return chrome.runtime.sendMessage(msg);
}

export async function sendMutation<P = unknown>(
  cmd: MutationOp,
  sender: MessageSender = defaultSender,
  opts?: { timeoutMs?: number }
): Promise<MutationResult<P>> {
  try {
    // originId：写方身份。SW 落盘广播时会带回它，本上下文据此忽略自己的回声
    //（避免「自己写 → 广播 → 自己全量重载」把拖拽中的列表整页刷掉）。
    const res = (await withTimeout(
      sender({
        type: 'MUTATE',
        data: cmd,
        originId: getContextOrigin(),
      }),
      opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      cmd.op
    )) as MutationResult<P> | undefined;
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
  sender: MessageSender = defaultSender,
  opts?: { timeoutMs?: number }
): Promise<MutationResult> {
  try {
    const res = (await withTimeout(
      sender({ type: 'SYNC', data: { op, ...extra } }),
      opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      op
    )) as MutationResult | undefined;
    if (!res) return { ok: false, error: 'SW 无响应' };
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
