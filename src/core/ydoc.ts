/**
 * V2 影子双写 · Y.Doc 定义与持久化（MV3 SW 可杀安全）。
 *
 * Y-Schema（doc 名 'tapstack-y-v2'）：
 * - groups: Y.Map<YGroupRec>   // 组级记录（含版本/墓碑/印记）
 * - tabs:   Y.Map<YTabRec>     // tab 镜像，key = `${groupId}:${tabId}`（供查询）
 * - order:  Y.Array<string>    // 组排序（快照顺序重建）
 *
 * MV3 约束：
 * - Y.Doc 不常驻内存：每次影子写经 withYDoc() 打开 → 载入持久化 → 单事务
 *   应用 plans → 取 update → 销毁。SW 被杀只丢本次影子写，主同步（blob）不受影响。
 * - 持久化双轨：y-indexeddb（best-effort，大 doc 恢复）+ 本文件不直接写 KV，
 *   update 由调用方（yShadow.ts）落 KV 日志（FIFO + compact 阈值）。
 * - 本期 Y-update 存明文；E2EE 是 V3 范畴。加密插槽见 encryptUpdateSlot
 *   （默认透传，V3 替换为 WebCrypto AES-GCM 实现即可，调用点零改）。
 *
 * 依赖隔离：yjs / y-indexeddb 仅在函数内动态 import（vite code-split 为异步
 * chunk，主 SW 入口体积零增长）；本模块顶层无静态依赖，node:test 可加载。
 */
import type { Doc as YDocType } from 'yjs';
import type { YGroupRec, YPlan, YTabRec, YStateLike } from '@/core/yTranslate';
import { applyYPlans } from '@/core/yTranslate';

/** Y.Doc 名（IndexedDB 库名共用） */
export const Y_DOC_NAME = 'tapstack-y-v2';

export const Y_ROOT_KEYS = {
  GROUPS: 'groups',
  TABS: 'tabs',
  ORDER: 'order',
} as const;

/** V3 加密插槽：本期透传（明文）。V3 替换为 WebCrypto 实现，调用点不变。 */
export type UpdateEncryptor = (update: Uint8Array) => Promise<Uint8Array>;
export const passthroughEncryptor: UpdateEncryptor = async update => update;
/** 显式插槽位：V3 E2EE 在此接入（如 aesGcmEncryptor），影子写路径已预留调用点 */
export const cryptoSlot: { encryptor: UpdateEncryptor } = { encryptor: passthroughEncryptor };

/** Y root 的最小结构约束（真实 Y.Doc / 测试替身共用） */
export interface YRoots {
  getMap<T>(key: string): {
    get(k: string): T | undefined;
    set(k: string, v: T): void;
    delete(k: string): void;
    keys(): IterableIterator<string>;
  };
  getArray(key: string): {
    length: number;
    toArray(): string[];
    delete(i: number, len: number): void;
    push(items: string[]): void;
  };
}

/** 把真实 Y.Doc 适配为 YStateLike（单事务内快照读 + 计划写，恒产生 ≤1 个 update） */
export function plansToDoc(doc: YDocType, plans: YPlan[], stamp: { d: string; s: number }): void {
  doc.transact(() => {
    const groups = doc.getMap<YGroupRec>(Y_ROOT_KEYS.GROUPS);
    const tabs = doc.getMap<YTabRec>(Y_ROOT_KEYS.TABS);
    const order = doc.getArray<string>(Y_ROOT_KEYS.ORDER);
    const like: YStateLike = {
      groups: {
        get: (k: string) => groups.get(k),
        set: (k: string, v: YGroupRec) => void groups.set(k, v),
        delete: (k: string) => void groups.delete(k),
        keys: () => groups.keys(),
      } as unknown as Map<string, YGroupRec>,
      tabs: {
        get: (k: string) => tabs.get(k),
        set: (k: string, v: YTabRec) => void tabs.set(k, v),
        delete: (k: string) => void tabs.delete(k),
        keys: () => tabs.keys(),
      } as unknown as Map<string, YTabRec>,
      order: order.toArray(),
    };
    // 注：applyYPlans 迭代 keys() 前已 [...快照]，边迭代边删安全。
    applyYPlans(like, plans, stamp);
    order.delete(0, order.length);
    if (like.order.length > 0) order.push(like.order);
  });
}

/**
 * 短命 Doc 会话：建 doc → y-indexeddb 载入 → 回调（单事务写）→ 捕获 update → 销毁。
 * 返回捕获到的增量 update（transact 内 exactly 一次 update 事件；无变更时为空数组）。
 * indexedDB 不可用（node/隐私模式）时跳过持久化，内存 Doc 照常工作。
 */
export async function withYDoc<T>(
  fn: (doc: YDocType) => T,
  opts: { loadPersisted?: boolean } = {}
): Promise<{ result: T; update: Uint8Array }> {
  const { Doc } = await import('yjs');
  const doc: YDocType = new Doc();
  const updates: Uint8Array[] = [];
  const onUpdate = (u: Uint8Array) => {
    updates.push(u);
  };
  doc.on('update', onUpdate);
  let persistence: { destroy(): Promise<void> } | null = null;
  try {
    if (opts.loadPersisted !== false && typeof indexedDB !== 'undefined') {
      try {
        const { IndexeddbPersistence } = await import('y-indexeddb');
        const p = new IndexeddbPersistence(Y_DOC_NAME, doc);
        persistence = p as unknown as { destroy(): Promise<void> };
        await p.whenSynced;
      } catch {
        // 持久化失败不阻断：内存 Doc 继续（本次 update 仍进 KV 日志）
      }
    }
    // fn 自行管理事务（plansToDoc 内 single transact）；此处不另包 transact，
    // 避免嵌套事务产生多个 update 事件。
    const result: T = fn(doc);
    const merged = mergeUpdates(updates);
    // 加密插槽（本期透传）
    const out = await cryptoSlot.encryptor(merged);
    return { result, update: out };
  } finally {
    doc.off('update', onUpdate);
    try {
      await persistence?.destroy();
    } catch {
      /* ignore */
    }
    doc.destroy();
  }
}

function mergeUpdates(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 0) return new Uint8Array(0);
  if (parts.length === 1) return parts[0];
  // 兜底：单事务路径下 updates.length 恒 ≤ 1；多分片在此简单拼接后由
  // Y.applyUpdate 逐段应用时仍可逐个解析（调用方按切分应用，不直接整体 apply）。
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 读快照（物化 / 调试用）：Y.Doc → plain */
export function readDocSnapshot(doc: YDocType): {
  groups: Record<string, YGroupRec>;
  tabs: Record<string, YTabRec>;
  order: string[];
} {
  const groups: Record<string, YGroupRec> = {};
  const tabs: Record<string, YTabRec> = {};
  doc
    .getMap<YGroupRec>(Y_ROOT_KEYS.GROUPS)
    .forEach((v, k) => {
      groups[k] = v;
    });
  doc
    .getMap<YTabRec>(Y_ROOT_KEYS.TABS)
    .forEach((v, k) => {
      tabs[k] = v;
    });
  return { groups, tabs, order: doc.getArray<string>(Y_ROOT_KEYS.ORDER).toArray() };
}
