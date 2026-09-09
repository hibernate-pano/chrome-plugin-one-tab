/**
 * 本地 journal（write-ahead log，规格 §4.3）：SW 内任何语义命令执行前先 append
 * 一条 entry（含已自增的 seq）。SW 启动时若发现状态落后于 journal，重放规则
 * 与合并规则同一条（§4.3「天然幂等」）——阶段二 Task 9 实现重放入口。
 *
 * 上限 1000 条 FIFO：超出裁剪最早。journal 条目保留至被裁剪，仅用于崩溃恢复
 * 与调试视图（阶段三）。upload 成功后不裁剪——云端确认判定由 lastSyncedSeq
 * 单独维护（Task 7）。
 */
import type { MutationOp } from '@/shared/mutationProtocol';

export interface JournalEntry {
  d: string;
  s: number;
  ts: string;
  type: MutationOp['op'];
  groupId?: string;
  tabId?: string;
  payload?: unknown;
}

export interface JournalDeps {
  kvGet<T>(key: string): Promise<T | null>;
  kvSet(key: string, value: unknown): Promise<void>;
  getDeviceId(): Promise<string>;
  /** 原子自增 seq，返回新值。已在 Task 2 实现。 */
  nextSeq(): Promise<number>;
}

export interface Journal {
  appendEntry(partial: Omit<JournalEntry, 'd' | 's' | 'ts'> & { ts?: string }): Promise<JournalEntry>;
  read(): Promise<JournalEntry[]>;
  /** 上传成功后调用：标记 s ≤ maxSyncedSeq 的 条 已确认。返回剩余未确认数。 */
  markConfirmedUpTo(maxSyncedSeq: number): Promise<number>;
}

const JOURNAL_KEY = 'journal';
const JOURNAL_MAX = 1000;

export function createJournal(deps: JournalDeps): Journal {
  async function read(): Promise<JournalEntry[]> {
    return (await deps.kvGet<JournalEntry[]>(JOURNAL_KEY)) ?? [];
  }

  async function write(entries: JournalEntry[]): Promise<void> {
    await deps.kvSet(JOURNAL_KEY, entries);
  }

  return {
    async appendEntry(partial): Promise<JournalEntry> {
      const seq = await deps.nextSeq();
      const deviceId = await deps.getDeviceId();
      const entry: JournalEntry = {
        d: deviceId,
        s: seq,
        ts: partial.ts ?? new Date().toISOString(),
        type: partial.type,
        groupId: partial.groupId,
        tabId: partial.tabId,
        payload: partial.payload,
      };
      const current = await read();
      const next = [...current, entry];
      if (next.length > JOURNAL_MAX) next.splice(0, next.length - JOURNAL_MAX);
      await write(next);
      return entry;
    },
    async read(): Promise<JournalEntry[]> {
      return read();
    },
    async markConfirmedUpTo(maxSyncedSeq: number): Promise<number> {
      const entries = await read();
      // 不物理裁剪：保留至 FIFO 上限淘汰。仅记录未确认数供调试视图用。
      return entries.filter(e => e.s > maxSyncedSeq).length;
    },
  };
}