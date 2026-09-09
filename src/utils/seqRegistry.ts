/**
 * 本设备 seq 单调计数器（规格 §4.1）：每次写入操作前 ++seq，落盘 chrome.storage。
 * SW 启动时修复：seq = max(持久化 seq, 实体印记中本设备最大 s) + 100，
 * 保证序号永不回退、跳号无害。
 *
 * 生产绑定由 mutationService.ts（SW 入口）调用 createSeqRegistry 并复用单例；
 * 本文件保持纯函数 + 依赖注入，便于 node:test。
 */
import type { TabGroup } from '@/types/tab';
import type { OpStamp } from '@/utils/opStamp';

const DEVICE_SEQ_KEY = 'device_seq';
const SEQ_GAP = 100; // 修复时留出的跳号空间，避免「刚修复完就 nextSeq 时撞号」

export interface SeqRegistryDeps {
  kvGet<T>(key: string): Promise<T | null>;
  kvSet(key: string, value: unknown): Promise<void>;
  getDeviceId(): Promise<string>;
  getGroups(): Promise<TabGroup[]>;
}

export interface SeqRegistry {
  nextSeq(): Promise<number>;
  getDeviceSeq(): Promise<number>;
  bumpSeqIfLower(candidate: number): Promise<number>;
}

/** 找出 groups 中本设备所有 lastOp.s 的最大值（含 tab 印记）。无任何本设备印记时返回 null。 */
function maxSeqForDevice(groups: TabGroup[], deviceId: string): number | null {
  let max = -1; // -1 哨兵：本设备无任何印记 → 返回 null
  for (const g of groups) {
    if (g.lastOp && g.lastOp.d === deviceId && g.lastOp.s > max) max = g.lastOp.s;
    for (const t of g.tabs ?? []) {
      const stamp = (t as { lastOp?: OpStamp }).lastOp;
      if (stamp && stamp.d === deviceId && stamp.s > max) max = stamp.s;
    }
  }
  return max === -1 ? null : max;
}

export function createSeqRegistry(deps: SeqRegistryDeps): SeqRegistry {
  let cached: number | null = null;

  async function read(): Promise<number> {
    if (cached !== null) return cached;
    const persisted = (await deps.kvGet<number>(DEVICE_SEQ_KEY)) ?? 0;
    const deviceId = await deps.getDeviceId();
    const groups = await deps.getGroups();
    const fromStamps = maxSeqForDevice(groups, deviceId);
    // 仅当存在本设备印记时才跳号 SEQ_GAP（§4.1：保证序号永不回退）。
    // 无印记的新设备不应无故跳到 100——保持 persisted 原值。
    const fixed = fromStamps === null
      ? persisted
      : Math.max(persisted, fromStamps + SEQ_GAP);
    if (fixed !== persisted) {
      await deps.kvSet(DEVICE_SEQ_KEY, fixed);
    }
    cached = fixed;
    return fixed;
  }

  async function persist(v: number): Promise<void> {
    cached = v;
    await deps.kvSet(DEVICE_SEQ_KEY, v);
  }

  return {
    async getDeviceSeq(): Promise<number> {
      return read();
    },
    async nextSeq(): Promise<number> {
      const cur = await read();
      const next = cur + 1;
      await persist(next);
      return next;
    },
    async bumpSeqIfLower(candidate: number): Promise<number> {
      const cur = await read();
      if (candidate > cur) {
        await persist(candidate);
        return candidate;
      }
      return cur;
    },
  };
}