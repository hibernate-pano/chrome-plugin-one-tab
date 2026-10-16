/**
 * 本地命令轨迹（2026-10-05 从「WAL」降级重写）。
 *
 * ── 为什么不再叫 WAL ──────────────────────────────────────────────────
 * 原实现的文件头写着「write-ahead log：SW 启动时若发现状态落后于 journal，
 * 重放规则与合并规则同一条（§4.3 天然幂等）——阶段二 Task 9 实现重放入口」。
 * 我核实了：**那个重放入口从未实现，且永远不会实现**。
 *   - `read()` 在 src/ 内零调用方（只有本文件自己）；
 *   - `markConfirmedUpTo()` 同样零调用方；
 *   - 而单写者队列 + 每步直写落盘（journal → apply* → setGroups）已经保证
 *     不会留下「需要重放」的中间态：任何一步抛错，数据都在盘上的一致状态，
 *     不存在「journal 有、状态没有」的窗口。
 *
 * 也就是说这个「WAL」**从来没有恢复过任何东西**，却每次用户点击都要：
 *   全量读 1000 条数组 → push 一条 → 全量写回 1000 条数组。
 * 体检实测这是单次 mutation 固定 I/O 链里的一环（1000 条数组的两次序列化）。
 *
 * ── 那它现在还有什么用 ────────────────────────────────────────────────
 * 一件事：**OpStamp 来源**。mutationHandlers 的每条语义命令在 apply* 之前
 * 先 appendEntry 一次，取回条目上的 d（设备）与 s（seq）作为本次写的盖印记；
 * 盖印记是全仓库的唯一写序事实来源（见 @/core/opStamp）。此外它还留一条
 * 最近命令的环形轨迹（只写不读，200 条上限）。
 *
 * 保留这个能力，但不再假装自己是 WAL：
 *   - 定长环形缓冲（默认 200 条，从 1000 降下来：200 条足够作盖印记，
 *     而 1000 条的每次全量读写是纯开销）；
 *   - append 时若新旧无关，**只写一次**（原实现也是一次，但数组更大）；
 *   - 删掉 markConfirmedUpTo()（零调用方）：留着它就是「看起来有个恢复机制
 *     其实没有」，比没有更危险。read() 保留：appendEntry 取环形缓冲现值要用，
 *     tests/journal.test.ts 也仍用它读回轨迹做断言；它依然**不是重放入口**。
 *
 * 取号职责已完全由 utils/seqRegistry.ts 承担（Lamport 时钟 + 持久化下限），
 * 本模块不再参与 stamp 生成。
 */
import type { MutationOp } from '@/shared/mutationProtocol';

/** 单条命令轨迹。d/s 是盖印记；groupId/tabId/payload 等字段保留在类型里是因为历史数据可能带它们。 */
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
  /** 原子自增 seq，返回新值。由 seqRegistry 提供（Lamport 时钟）。 */
  nextSeq(): Promise<number>;
}

export interface Journal {
  /** 记一条命令轨迹，返回落盘的条目（mutationHandlers 取它的 d/s 当 OpStamp）。 */
  appendEntry(partial: Omit<JournalEntry, 'd' | 's' | 'ts'> & { ts?: string }): Promise<JournalEntry>;
  /**
   * 读回轨迹。**不是重放入口**：读到的条目不代表「需要恢复的状态」，
   * 只代表「最近发生过这些命令」。
   */
  read(): Promise<JournalEntry[]>;
}

// 2026-10-09 架构 P2-2：原先手抄 'journal'，与权威表 STORAGE_KEYS.JOURNAL
// 各留一份。值当前一致，但改键名时会分叉（旧数据读不到，且这类分叉不报错）。
// 键名只在一处定义（@/storage-kv/keys 是唯一真相源）。
import { STORAGE_KEYS } from '@/storage-kv/keys';

const JOURNAL_KEY = STORAGE_KEYS.JOURNAL;
/**
 * 环形缓冲上限。
 *
 * 从原实现的 1000 降下来：journal 每条命令写一次，200 条足够作盖印记，
 * 而 1000 条的每次全量读写是纯开销。
 * 200 条 × 单条约 120B ≈ 24KB，一次序列化成本可忽略。
 */
const JOURNAL_MAX = 200;

export function createJournal(deps: JournalDeps): Journal {
  async function read(): Promise<JournalEntry[]> {
    return (await deps.kvGet<JournalEntry[]>(JOURNAL_KEY)) ?? [];
  }

  return {
    async appendEntry(partial): Promise<JournalEntry> {
      const [seq, deviceId, current] = await Promise.all([
        deps.nextSeq(),
        deps.getDeviceId(),
        read(),
      ]);
      const entry: JournalEntry = {
        d: deviceId,
        s: seq,
        ts: partial.ts ?? new Date().toISOString(),
        type: partial.type,
        groupId: partial.groupId,
        tabId: partial.tabId,
        payload: partial.payload,
      };
      // 环形：满了就砍掉最旧的（保持数组长度恒定，序列化成本不随时间增长）
      const next = current.length >= JOURNAL_MAX
        ? [...current.slice(current.length - JOURNAL_MAX + 1), entry]
        : [...current, entry];
      await deps.kvSet(JOURNAL_KEY, next);
      return entry;
    },
    async read(): Promise<JournalEntry[]> {
      return read();
    },
  };
}
