/**
 * Web 删除纯函数（无 IO，可被 node:test 直测）。
 *
 * ── 2026-09-29 无墓碑重写 ──
 * 旧实现给 tab 盖墓碑（isDeleted/is_deleted 双写 + stamp），让扩展端并集合并
 * 感知删除意图。墓碑废除后合并改为组级 LWW 整组覆盖：Web 直接**物理移除**目标
 * tab，组行 stamp 提升（OLD+1，归属本设备）+ 重加密回写，对端下次合并整组覆盖，
 * 删除随整组行广播。见 @/core/opStampMerge 头注释。
 *
 * 载荷形状兼容：解密结果可能是扩展写入的 TabData[]（snake_case）、Web/旧客户端
 * 写入的 Tab[] 或 wrapper 对象（camelCase）；本文件按 id 定位后原样剔除该元素，
 * 其余键/形状保持不变（数组仍是数组，wrapper 保留其余键）。
 */

/** wrapper 对象上可能携带标签数组的字段名（与 normalizeTabsData 同优先级子集） */
const TAB_ARRAY_KEYS = ['tabs', 'tabs_data', 'tabsData'] as const;

export interface WebRemoveTabResult {
  /** 重加密前的新解密载荷（与输入同形状：数组仍是数组，wrapper 保留其余键） */
  updated: unknown;
  /** 是否命中目标 tab（false = 无此 id，调用方应抛错） */
  found: boolean;
  /**
   * 删后组内无 tab → 调用方应对整行执行组删除广播
   * （UPDATE is_deleted=true + updated_at/组 stamp，与扩展 applyRemoveTab 拿空
   * 组的物理移除语义一致；锁定组由调用方按 isLocked 豁免）。
   */
  autoDeleteGroup: boolean;
}

function findTabsArray(decrypted: unknown): { key: string | null; tabs: unknown[] | null } {
  if (Array.isArray(decrypted)) return { key: null, tabs: decrypted };
  if (decrypted !== null && typeof decrypted === 'object') {
    const obj = decrypted as Record<string, unknown>;
    for (const key of TAB_ARRAY_KEYS) {
      if (Array.isArray(obj[key])) return { key, tabs: obj[key] as unknown[] };
    }
  }
  return { key: null, tabs: null };
}

/**
 * 对解密载荷执行「物理移除」删除（Web 版 applyRemoveTab，不含组行写，纯函数）。
 * @param decrypted decryptData 结果：Tab[] / TabData[] / wrapper 对象
 * @param opts.isLocked 组锁定态（锁定组不整组自动删除，与扩展端一致；
 *        锁定组允许删到 0 个标签——用户显式保护的是组的存在性）
 */
export function applyWebRemoveTab(
  decrypted: unknown,
  tabId: string,
  opts: { isLocked?: boolean } = {}
): WebRemoveTabResult {
  const { key, tabs } = findTabsArray(decrypted);
  if (!tabs) {
    return { updated: decrypted, found: false, autoDeleteGroup: false };
  }

  const idx = tabs.findIndex(
    raw => raw !== null && typeof raw === 'object' && String((raw as { id?: unknown }).id) === tabId
  );
  if (idx === -1) {
    return { updated: decrypted, found: false, autoDeleteGroup: false };
  }

  const nextTabs = tabs.filter((_, i) => i !== idx);
  const autoDeleteGroup = nextTabs.length === 0 && !opts.isLocked;

  if (key === null) {
    return { updated: nextTabs, found: true, autoDeleteGroup };
  }
  return {
    updated: { ...(decrypted as Record<string, unknown>), [key]: nextTabs },
    found: true,
    autoDeleteGroup,
  };
}

/**
 * Web 侧 stamp 铸造：OLD+1 严格递增，归属本设备。
 * @param deviceId 本设备 ID（与扩展 getDeviceId 同源）
 * @param cloudSeq 云端行 last_op_seq（null/缺失 = 迁移前数据 → 从 1 起）
 */
export function mintWebStamp(
  deviceId: string,
  cloudSeq: number | null | undefined
): { d: string; s: number } {
  return { d: deviceId, s: (typeof cloudSeq === 'number' ? cloudSeq : 0) + 1 };
}
