/**
 * S5 删除语义统一 · Web 墓碑纯函数（无 IO，可被 node:test 直测）。
 *
 * 背景：Web deleteTab 曾走「解密-过滤-重加密」回写（物理移除 tab），扩展端走
 * 「盖墓碑 + stamp」（applyRemoveTab）。物理移除的云端行在扩展端合并时被当成
 * 「从未见过该 tab」→ 对端活跃副本重新并集合并 = 跨端复活。本模块把 Web 删除
 * 改成与扩展同口径的墓碑命令，Web 无 SW/mutationQueue，直调 supabase 经由
 * webApi，本文件只负责「解密载荷 → 墓碑载荷」的纯变换。
 *
 * ── 墓碑形状（与扩展端 serializeTab/applyRemoveTab 同口径）──
 * - 标签级墓碑：tab 保留在 tabs 数组内，`isDeleted=true`（camelCase Tab 键）与
 *   `is_deleted=true`（snake_case TabData 键）双写；`lastOp={d,s}` 与
 *   `last_op_device/last_op_seq` 双写；`lastAccessed/last_accessed=now` 双写。
 *   双写原因：解密载荷可能是扩展写入的 TabData[]（snake_case），也可能是
 *   Web/旧客户端写入的 Tab[] 或 wrapper 对象（camelCase）；扩展下载侧
 *   normalizeTabsData + deserializeTab 只认 snake_case，Web 回读
 *   toTabGroupFromEncrypted 只认 camelCase，双写保证任一形状往返都不丢意图。
 * - 组级墓碑（删后无活跃 tab 且未锁定）：调用方置行 `is_deleted=true` 并推新
 *   `updated_at` + 组 stamp（见 stamp 规则），与 applyDeleteGroup 同语义；
 *   tabs 载荷不再改写（applyRemoveTab 整组软删分支同样保留原 tabs）。
 *
 * ── stamp 规则（与 markCloudGroupsAsDeleted 同源）──
 * - mintWebStamp(deviceId, cloudSeq)：s = (cloudSeq ?? 0) + 1，即 OLD+1 严格递增，
 *   归属写者本设备（不冒用原设备），保证守卫放行且合并时盖过删除前的旧 stamp。
 * - 同一次删除只铸一个 stamp：被墓碑 tab 与组行（last_op_device/seq 列）共用
 *   同一 stamp = P0-3「标签级删除同步提升组级印记」的 Web 侧实现；组 stamp
 *   不动会让删 tab 在探活指纹（单调 seq 主信号）与合并决胜中不可见。
 * - 云端无印记列（supportsOpStamp=false）时组行省略 stamp 列（plain 墓碑），
 *   但加密载荷内的 tab 级 stamp 照写（载荷内字段与列探测无关，扩展上传侧同理）。
 * - 幂等：目标已是墓碑时不改写、不 bump（version/updated_at 语义由调用方行更新承载）。
 */
import type { OpStamp } from './opStamp';

/** wrapper 对象上可能携带标签数组的字段名（与 normalizeTabsData 同优先级子集） */
const TAB_ARRAY_KEYS = ['tabs', 'tabs_data', 'tabsData'] as const;

export interface WebRemoveTabResult {
  /** 重加密前的新解密载荷（与输入同形状：数组仍是数组，wrapper 保留其余键） */
  updated: unknown;
  /** 是否命中目标 tab（false = 无此 id，调用方应抛错） */
  found: boolean;
  /** 幂等命中：目标已是墓碑，本次未做任何改写（调用方可直接返回） */
  alreadyTombstoned: boolean;
  /**
   * 删后组内无活跃 tab 且组未锁定 → 调用方应对整行盖组级墓碑
   * （is_deleted=true + updated_at/组 stamp），不再回写 tabs_data。
   * 与 applyRemoveTab 的 shouldAutoDeleteAfterTabRemoval 分支同语义。
   */
  autoDeleteGroup: boolean;
}

/**
 * Web 侧 stamp 铸造：OLD+1 严格递增，归属本设备。
 * @param deviceId 本设备 ID（与扩展 getDeviceId 同源）
 * @param cloudSeq 云端行 last_op_seq（null/缺失 = 迁移前数据 → 从 1 起）
 */
export function mintWebStamp(deviceId: string, cloudSeq: number | null | undefined): OpStamp {
  return { d: deviceId, s: (typeof cloudSeq === 'number' ? cloudSeq : 0) + 1 };
}

function isTombstonedRecord(t: Record<string, unknown>): boolean {
  return t.isDeleted === true || t.is_deleted === true;
}

/** 在一条解密 tab 记录上盖墓碑（camelCase + snake_case 双写，见模块注释） */
function stampTabRecord(t: Record<string, unknown>, stamp: OpStamp, now: string): void {
  t.isDeleted = true;
  t.is_deleted = true;
  t.lastOp = { d: stamp.d, s: stamp.s };
  t.last_op_device = stamp.d;
  t.last_op_seq = stamp.s;
  t.lastAccessed = now;
  t.last_accessed = now;
}

/** 统计载荷中的活跃（非墓碑）tab 数（调用时目标已盖墓碑，直接全量计数） */
function countActive(tabs: unknown[]): number {
  let n = 0;
  for (const raw of tabs) {
    if (!raw || typeof raw !== 'object') continue;
    if (isTombstonedRecord(raw as Record<string, unknown>)) continue;
    n++;
  }
  return n;
}

/**
 * 对解密载荷执行「盖墓碑」删除（Web 版 applyRemoveTab，不含组行写，纯函数）。
 * @param decrypted decryptData 结果：Tab[] / TabData[] / wrapper 对象
 * @param opts.isLocked 组锁定态（锁定组永不整组自动删除，与扩展端一致）
 */
export function applyWebRemoveTab(
  decrypted: unknown,
  tabId: string,
  stamp: OpStamp,
  now: string,
  opts: { isLocked?: boolean } = {}
): WebRemoveTabResult {
  let tabsRef: unknown[] | null = null;
  if (Array.isArray(decrypted)) {
    tabsRef = decrypted;
  } else if (decrypted !== null && typeof decrypted === 'object') {
    const obj = decrypted as Record<string, unknown>;
    for (const key of TAB_ARRAY_KEYS) {
      if (Array.isArray(obj[key])) {
        tabsRef = obj[key] as unknown[];
        break;
      }
    }
  }

  if (!tabsRef) {
    return { updated: decrypted, found: false, alreadyTombstoned: false, autoDeleteGroup: false };
  }

  const idx = tabsRef.findIndex(
    raw => raw !== null && typeof raw === 'object' && String((raw as { id?: unknown }).id) === tabId
  );
  if (idx === -1) {
    return { updated: decrypted, found: false, alreadyTombstoned: false, autoDeleteGroup: false };
  }

  const target = tabsRef[idx] as Record<string, unknown>;
  if (isTombstonedRecord(target)) {
    return { updated: decrypted, found: true, alreadyTombstoned: true, autoDeleteGroup: false };
  }

  // 浅拷贝后盖墓碑：不污染调用方传入的解密对象
  const nextTabs = [...tabsRef];
  const nextTarget: Record<string, unknown> = { ...target };
  stampTabRecord(nextTarget, stamp, now);
  nextTabs[idx] = nextTarget;

  const autoDeleteGroup = countActive(nextTabs) === 0 && !opts.isLocked;

  if (Array.isArray(decrypted)) {
    return { updated: nextTabs, found: true, alreadyTombstoned: false, autoDeleteGroup };
  }
  const key = findTabsKey(decrypted as Record<string, unknown>);
  // tabsRef 非空蕴含 key 非空；防御性兜底原样返回
  if (!key) {
    return { updated: decrypted, found: true, alreadyTombstoned: false, autoDeleteGroup };
  }
  return {
    updated: { ...(decrypted as Record<string, unknown>), [key]: nextTabs },
    found: true,
    alreadyTombstoned: false,
    autoDeleteGroup,
  };
}

function findTabsKey(obj: Record<string, unknown>): string | null {
  for (const key of TAB_ARRAY_KEYS) {
    if (Array.isArray(obj[key])) return key;
  }
  return null;
}
