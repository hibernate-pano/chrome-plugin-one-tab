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
 * Web 侧 stamp 铸造：归属本设备，序号严格大于两个下界的较大者 +1。
 *
 * 两个下界缺一不可：
 *   - `cloudSeq`——本行云端 last_op_seq。必须压过它，否则服务端 guard_tab_group_op_stamp
 *     的严格 LT 守卫（NEW < OLD 即 RETURN NULL）会静默拒收这次写。
 *   - `observedMaxSeq`——本账号在云端观察到的**全部**行 last_op_seq 的最大值，
 *     即 Lamport 时钟分量。少了这一项，Web 就会铸出一个可能输给其它设备的号。
 *
 * 为什么第二项不是可有可无（这正是 v1.22.0 之后 P1 缺陷的形态）：
 *   扩展端设备 E 离线时把某组推到 {E,12} 并**尚未上传**，云端行仍停在 8。
 *   用户此时在 Web 上改名或删该组 → Web 读 OLD=8、铸 {W,9} → E 恢复联网后
 *   core/opStampMerge.pickByStamp 判 {E,12} > {W,9}，本地组胜出、保留并整组覆盖回云端，
 *   用户在网页上做的删除被静默撤销，且 1.22.0 起没有回收站。
 *   扩展端 src/utils/supabase/upload.ts 的 markCloudGroupsAsDeleted 早已改用
 *   `Math.max(本机 Lamport 号, 云端 OLD+1)` + bumpSeqIfLower；Web 侧曾长期停在
 *   裸 OLD+1，同一个缺陷只修了一半。
 *
 * 诚实的边界：Lamport 只能压过「观察得到」的写入。扩展端完全离线、从未上传过的
 * 本地印记，Web 在原理上无从得知，那种情况是 LWW 模型固有的最后写入方全胜，
 * 属于 README 已声明的既定代价，不是选一个更大的数能修掉的。
 *
 * @param deviceId 本设备 ID（与扩展 getDeviceId 同源）
 * @param cloudSeq 本行云端 last_op_seq（null/缺失 = 迁移前数据 → 该下界按 0 算）
 * @param observedMaxSeq 本账号云端全部行 last_op_seq 的最大值；缺省 0（无观测）
 */
export function mintWebStamp(
  deviceId: string,
  cloudSeq: number | null | undefined,
  observedMaxSeq?: number | null
): { d: string; s: number } {
  const rowFloor = typeof cloudSeq === 'number' ? cloudSeq : 0;
  const observed = typeof observedMaxSeq === 'number' ? observedMaxSeq : 0;
  return { d: deviceId, s: Math.max(rowFloor, observed) + 1 };
}
