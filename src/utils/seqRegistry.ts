/**
 * 本设备 seq 单调计数器（规格 §4.1，Lamport 修订）。
 *
 * 关键不变式：**本设备发出的序号必须大于它观察到的任何设备的任何印记**。
 * 每次写入操作前取号，落盘 chrome.storage 作为「不回退的下限」。
 *
 * 为什么是「观察到的所有设备」而不是「本设备」：
 *   序号只在同一设备内单调，跨设备裸比数值毫无意义。旧实现只看本设备印记，
 *   于是新设备（持久化序号 0、无自身印记）第一笔编辑发出 s=1，对上老设备的
 *   s=几百 → 客户端合并输给云端（本地编辑被回滚）、服务端触发器也按更旧印记
 *   拒收（NEW < OLD）→ 换机/重装/清数据的用户「改什么都存不住」。
 *   取全局观察最大值再 +1 是 Lamport 时钟：只要本设备见过对方的写入，
 *   后续写入就必然胜过它；因果正确，且不依赖墙钟（不受设备时间偏差影响）。
 *
 * 不做 memo：下载合并在 SW 存活期间会把云端（可能远大于本设备）的印记写进
 * storage，缓存住的旧基线会让本设备继续发小号 → 上传被吞、本地被覆盖。
 * deps.getGroups 走 storage 内存缓存，成本可忽略。
 *
 * 生产绑定由 mutationService.ts（SW 入口）调用 createSeqRegistry；
 * 本文件保持纯函数 + 依赖注入，便于 node:test。
 */
import type { TabGroup } from '@/types/tab';
import type { OpStamp } from '@/core/opStamp';
// 2026-10-09 架构 P2-2：键名改引用权威表，不再手抄（详见 journal.ts 同项注释）。
import { STORAGE_KEYS } from '@/storage-kv/keys';

const DEVICE_SEQ_KEY = STORAGE_KEYS.DEVICE_SEQ;

export interface SeqRegistryDeps {
  kvGet<T>(key: string): Promise<T | null>;
  kvSet(key: string, value: unknown): Promise<void>;
  getGroups(): Promise<TabGroup[]>;
}

export interface SeqRegistry {
  nextSeq(): Promise<number>;
  getDeviceSeq(): Promise<number>;
  /**
   * **只读**地看当前号位，不把修复后的下限写回。
   *
   * 与 getDeviceSeq 的区别只有一处，但那一处是硬要求：getDeviceSeq 走 current()，
   * 而 current() 在「观察到的全网最大印记 > 持久化值」时会 `kvSet` 把下限**写回**。
   * 于是「我只是看一眼计数器」这个纯读意图，会在磁盘上留下一次持久化副作用 ——
   * 提前把 device_seq 钉到观察最大值。
   *
   * 2026-10-11 实测的后果：增量上传水位为做「seq 时钟是否回退」的自洽性校验而
   * 调了 getDeviceSeq()，结果每次上传都提前钉一次下限，令紧随其后的墓碑取号
   * 多跳一级（tests/overwriteTombstoneDoubleWrite 的见证用例从 6 变 7）。
   * 语义上不算错（Lamport 只要求单调），但它让「观测」变成了「变更」，
   * 而一个只需要读数的调用方没有资格改计数器 —— 故拆出这个 peek。
   */
  peekDeviceSeq(): Promise<number>;
  bumpSeqIfLower(candidate: number): Promise<number>;
}

/**
 * groups 中**所有设备**印记的最大 s（含 tab 印记）；无任何印记时返回 null。
 * 注意：不过滤 deviceId——跨设备可比性正来自「观察全网最大值」。
 */
export function maxObservedSeq(groups: TabGroup[]): number | null {
  let max = -1; // -1 哨兵：无任何印记 → 返回 null
  for (const g of groups) {
    if (g.lastOp && typeof g.lastOp.s === 'number' && g.lastOp.s > max) max = g.lastOp.s;
    for (const t of g.tabs ?? []) {
      const stamp = (t as { lastOp?: OpStamp }).lastOp;
      if (stamp && typeof stamp.s === 'number' && stamp.s > max) max = stamp.s;
    }
  }
  return max === -1 ? null : max;
}

export function createSeqRegistry(deps: SeqRegistryDeps): SeqRegistry {
  /**
   * 当前号位下限 = max(持久化值, 观察到的全网最大印记)。
   * 持久化值是防回退的地板（本地印记被合并覆盖后仍不倒退）；
   * 观察值是 Lamport 分量（保证跨设备可比）。
   */
  async function current(): Promise<number> {
    const persisted = (await deps.kvGet<number>(DEVICE_SEQ_KEY)) ?? 0;
    const observed = maxObservedSeq(await deps.getGroups());
    const base = observed === null ? persisted : Math.max(persisted, observed);
    if (base !== persisted) {
      await deps.kvSet(DEVICE_SEQ_KEY, base);
    }
    return base;
  }

  async function persist(v: number): Promise<void> {
    await deps.kvSet(DEVICE_SEQ_KEY, v);
  }

  return {
    async getDeviceSeq(): Promise<number> {
      return current();
    },
    async peekDeviceSeq(): Promise<number> {
      const persisted = (await deps.kvGet<number>(DEVICE_SEQ_KEY)) ?? 0;
      const observed = maxObservedSeq(await deps.getGroups());
      return observed === null ? persisted : Math.max(persisted, observed);
    },
    async nextSeq(): Promise<number> {
      const next = (await current()) + 1;
      await persist(next);
      return next;
    },
    async bumpSeqIfLower(candidate: number): Promise<number> {
      const cur = await current();
      if (candidate > cur) {
        await persist(candidate);
        return candidate;
      }
      return cur;
    },
  };
}
