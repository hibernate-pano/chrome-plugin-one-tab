/**
 * TapStack 网页版 API 封装
 *
 * 复用扩展的纯逻辑层（auth + downloadTabGroups），这些模块不依赖 chrome.* API，
 * 因此可直接在浏览器 Web 环境中运行。本文件提供面向页面组件的薄接口。
 */
import { supabase, auth as supabaseAuth, supportsCloudTombstone, supportsOpStamp, getDeviceId } from '@/utils/supabaseFacade';
// 门面未转发 supportsDeletedAt（src/utils/supabaseFacade.ts 属扩展门面文件），直连同源模块
import { supportsDeletedAt } from '@/utils/supabase/probe';
import { applyWebRemoveTab, mintWebStamp } from '@/core/webTombstone';
import { decryptData, encryptData, isEncrypted } from '@/utils/encryptionUtils';
import { sanitizeTabUrl } from '@/utils/inputValidation';
import { normalizeTabsData } from '@/core/normalizeTabsData';
import { formatToOneTabFormat } from '@/core/oneTabFormatParser';
import { stripTombstonedTabs } from '../store/slices/tabSliceHelpers';
import type { Tab, TabGroup } from '@/types/tab';
import { logError, logWarn } from '../utils/log';

export interface WebUser {
  id: string;
  email: string;
}

export class WebAuthError extends Error {}

/** 登录（邮箱 + 密码） */
export async function signIn(email: string, password: string): Promise<WebUser> {
  const { data, error } = await supabaseAuth.signIn(email, password);
  if (error) {
    const message = typeof error === 'object' && error !== null && 'message' in error
      ? (error as { message: string }).message
      : '登录失败';
    throw new WebAuthError(message);
  }
  if (!data.user) {
    throw new WebAuthError('登录失败');
  }
  return { id: data.user.id, email: data.user.email ?? '' };
}

/** 登出 */
export async function signOut(): Promise<void> {
  await supabaseAuth.signOut();
}

/** 获取当前登录用户（无会话返回 null，不抛错） */
export async function getCurrentUser(): Promise<WebUser | null> {
  const result = await supabaseAuth.getCurrentUser();
  if (result.error || !result.data?.user) {
    return null;
  }
  const user = result.data.user as { id: string; email?: string };
  return { id: user.id, email: user.email ?? '' };
}

/** 单条云端标签的 camelCase / snake_case 双拼写取串（两种上云方言都认，见 toTabFromCloud） */
function pickStr(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (typeof c === 'string' && c) return c;
  }
  return '';
}

/**
 * 单条云端标签 → Tab。
 *
 * 安全过滤与扩展端 tabDataCodec.deserializeTab 同口径：URL 必须过共享协议白名单
 * （sanitizeTabUrl），javascript: / data: / file: / blob: 等危险协议整条丢弃，
 * 绝不进 <a href>——React 18 不拦 javascript:，只发一条 warning，等于没拦。
 * 网页端原先只有 typeof 检查，src/web/ 全目录零消毒，是个可注入的缺口。
 *
 * 字段同时认两种上云方言：扩展写的 snake_case TabData（serializeTab 产物）与
 * Web/旧客户端写的 camelCase Tab（wrapper 内），任一端写的数据在另一端都显示完整。
 */
function toTabFromCloud(raw: unknown, groupId: string): Tab | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const url = sanitizeTabUrl(r.url);
  if (!url) return null;
  if (typeof r.title !== 'string') return null;

  const lastOp =
    typeof r.lastOp === 'object' && r.lastOp !== null
      ? (r.lastOp as { d?: unknown; s?: unknown })
      : typeof r.last_op_seq === 'number' && r.last_op_device
        ? { d: r.last_op_device, s: r.last_op_seq as number }
        : null;

  return {
    id: String(r.id ?? ''),
    url,
    title: r.title,
    favicon: pickStr(r.favicon) || undefined,
    createdAt: pickStr(r.createdAt, r.created_at),
    lastAccessed: pickStr(r.lastAccessed, r.last_accessed),
    group_id: pickStr(r.group_id) || groupId,
    pinned: r.pinned === true,
    isDeleted: r.isDeleted === true || r.is_deleted === true ? true : undefined,
    deletedAt: pickStr(r.deletedAt, r.deleted_at) || undefined,
    lastOp:
      lastOp && typeof lastOp.s === 'number' && typeof lastOp.d === 'string'
        ? { d: lastOp.d, s: lastOp.s }
        : undefined,
  };
}

/**
 * 解密结果 → TabGroup（组元数据以 tab_groups 表列为准，加密对象里带的同名字段优先）。
 * @param tabsData 已由 normalizeTabsData 归一化出来的标签数组（形状与 metadata 分开拿）
 */
function toTabGroupFromEncrypted(groupId: string, decrypted: unknown, tabsData: unknown[]): TabGroup {
  const meta =
    decrypted !== null && typeof decrypted === 'object' && !Array.isArray(decrypted)
      ? (decrypted as Record<string, unknown>)
      : null;

  return {
    // 行 id 权威：密文内嵌 id 可能是旧值，用它会让删除/改名打到不存在的组上
    id: groupId,
    name: meta ? String(meta.name ?? meta.title ?? '未命名会话') : '',
    tabs: tabsData.map(t => toTabFromCloud(t, groupId)).filter((t): t is Tab => t !== null),
    createdAt: meta ? String(meta.createdAt ?? meta.created_at ?? '') : '',
    updatedAt: meta ? String(meta.updatedAt ?? meta.updated_at ?? '') : '',
    isLocked: Boolean(meta?.isLocked ?? meta?.is_locked ?? false),
    notes: typeof meta?.notes === 'string' ? meta.notes : undefined,
    version: typeof meta?.version === 'number' ? meta.version : undefined,
    displayOrder: typeof meta?.displayOrder === 'number' ? meta.displayOrder : undefined,
  };
}

/**
 * 原始 tabs_data 是否「看起来有内容」（判据与扩展端 download.ts 一致）：
 * 归一化后为空数组、而原始值非空 = 内容存在但读不出来，不是空组。
 */
function rawLooksLikeContent(rawData: unknown): boolean {
  if (typeof rawData === 'string') return rawData.length > 2;
  if (rawData !== null && typeof rawData === 'object') {
    return Object.keys(rawData as object).length > 0;
  }
  return rawData != null;
}

/**
 * 将一行 tab_groups 云端行解密为 TabGroup（与 fetchGroups 共用）。
 * 返回 null = 这一行读不出来（解密失败且明文回退也失败 / JSONB 形状不可恢复），
 * 调用方必须整行跳过，绝不产出「零标签的空组」。
 *
 * 【读不出来 ≠ 是空的】（与扩展端 download.ts 同口径）：读不出来时降级成空组，
 * 等于把用户仅存于云端的那份数据伪装成"空会话"——下游会把它当空壳处理并登记
 * purge，等于把读不出来的真实数据删掉。原则：读不出来就不碰，整行跳过，云端行
 * 原封保留，等问题修好后自然重新出现。
 */
async function decryptRowToGroup(row: Record<string, unknown>, userId: string): Promise<TabGroup | null> {
  const groupAny = row as Record<string, any>;
  const groupId = String(groupAny.id);
  const rawData = groupAny.tabs_data;

  let decrypted: unknown;
  if (typeof rawData === 'string') {
    let failed = false;
    try {
      // decryptData 内部 JSON.parse 后 as T，无形状校验，必须在这里归一化
      decrypted = await decryptData(rawData, userId);
    } catch (decryptError) {
      logWarn(`[decryptRowToGroup] 组 ${groupId} 解密失败:`, decryptError);
      // 旧客户端可能把明文 JSON 写进 tabs_data：只在非密文时再回退一次普通解析
      if (!isEncrypted(rawData)) {
        try {
          decrypted = JSON.parse(rawData);
        } catch (parseError) {
          logWarn(`[decryptRowToGroup] 组 ${groupId} 明文解析失败:`, parseError);
          failed = true;
        }
      } else {
        failed = true;
      }
    }
    if (failed) {
      if (rawData.length > 2) {
        logError(
          `[decryptRowToGroup] 组 ${groupId} 的内容无法读取（解密与明文解析均失败），` +
            '已跳过该组以保护云端数据不被误删'
        );
        return null;
      }
      // 空串 / 极短垃圾：确实没有内容，按空组处理（与扩展端判据一致）
      decrypted = [];
    }
  } else {
    decrypted = rawData;
  }

  const tabsData = normalizeTabsData(decrypted, groupId);
  // 非字符串（JSONB 数组 / wrapper / 脏数据）：归一化成空数组且原始值非空 = 形状不可恢复
  if (typeof rawData !== 'string' && tabsData.length === 0 && rawLooksLikeContent(rawData)) {
    logError(
      `[decryptRowToGroup] 组 ${groupId} 的 tabs_data 形状无法恢复且原始值非空，` +
        '已跳过该组以保护云端数据不被误删'
    );
    return null;
  }

  const group = toTabGroupFromEncrypted(groupId, decrypted, tabsData);
  // 用 tab_groups 表字段补齐（加密对象常缺 name/时间戳）
  group.name = group.name || String(groupAny.name ?? '未命名会话');
  group.createdAt = group.createdAt || String(groupAny.created_at ?? '');
  group.updatedAt = group.updatedAt || String(groupAny.updated_at ?? '');
  group.isLocked = group.isLocked || Boolean(groupAny.is_locked ?? false);
  return group;
}

/** 下载当前用户的会话数据（解密结果可能是 TabGroup 对象或数组，均做防护） */
export async function fetchGroups(): Promise<TabGroup[]> {
  const current = await getCurrentUser();
  if (!current) {
    throw new WebAuthError('未登录');
  }
  const userId = current.id;
  const { data: rows, error } = await supabase
    .from('tab_groups')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  const tabGroups: TabGroup[] = [];

  for (const row of rows ?? []) {
    const groupAny = row as any;
    // 云端墓碑行（is_deleted=true）不展示在 Web 列表
    if (groupAny.is_deleted) {
      continue;
    }
    const group = await decryptRowToGroup(row as Record<string, unknown>, userId);
    if (!group) {
      // 读不出来 ≠ 是空的：整行跳过，绝不把读不出的内容降级成零标签空组
      continue;
    }
    // 标签级墓碑只用于同步删除意图：Web 列表与顶部统计都不计入
    // （与扩展端 stripTombstonedTabs 同一条实现，不再就地 mutate 返回对象）
    tabGroups.push(stripTombstonedTabs(group));
  }

  return tabGroups;
}

export { supabase };

/** 导出为插件 JSON 备份格式（与扩展端 storage.exportData 结构一致） */
export async function exportJsonBackup(): Promise<{ filename: string; content: string }> {
  const groups = await fetchGroups();
  const payload = {
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    data: { groups },
  };
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return {
    filename: `tapstack-backup-${y}-${m}-${day}.json`,
    content: JSON.stringify(payload, null, 2),
  };
}

/** 导出为 OneTab 格式 */
export async function exportOneTab(): Promise<{ filename: string; content: string }> {
  const groups = await fetchGroups();
  const text = formatToOneTabFormat(groups);
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return {
    filename: `tapstack-onetab-${y}-${m}-${day}.txt`,
    content: text,
  };
}

// ── 写操作 ──────────────────────────────────────────────

/** 读取一行明文（未加密的 tabs_data 字符串），供加密回写 */
async function requireUserId(): Promise<string> {
  const current = await getCurrentUser();
  if (!current) throw new WebAuthError('未登录');
  return current.id;
}

/**
 * 本账号在云端**全部** tab_groups 行上观察到的 last_op_seq 最大值（Lamport 下限）。
 *
 * 没有这个下限，Web 铸出的号可能输给别的设备：扩展设备离线把某组推到 {E,12} 且尚未
 * 上传时，云端行仍是 8，Web 铸 {W,9}，对端恢复联网后 pickByStamp 判 {E,12} 胜出、
 * 把用户的改名/删除撤销。取全表最大值做下界，与扩展端 upload.ts 里
 * `Math.max(本机 Lamport 号, 云端 OLD+1)` 是同一条原则。
 *
 * 读失败返回 0（退化成裸 OLD+1，与修复前同口径）而不是抛错：这是一次「抬高序号」
 * 的优化，读不到就少抬高，不该因此让用户的改名/删除整个失败。
 */
async function observedMaxCloudSeq(userId: string): Promise<number> {
  const { data, error } = await supabase
    .from('tab_groups')
    .select('last_op_seq')
    .eq('user_id', userId)
    .limit(500);
  if (error || !Array.isArray(data)) return 0;
  let max = 0;
  for (const row of data as Array<{ last_op_seq?: unknown }>) {
    if (typeof row.last_op_seq === 'number' && row.last_op_seq > max) max = row.last_op_seq;
  }
  return max;
}

/**
 * 为组行写操作铸造「本设备 + 严格压过已观测最大印记 +1」的操作印记。
 *
 * 为什么改名/删组也必须盖印记：云端行的 stamp 不推进，对端合并时就会判它的本地
 * 副本赢（core/opStampMerge.pickByStamp 用 compareStamps 定全序，seq 大者胜、
 * seq 相同按 deviceId 字典序——不是固定判本地赢），对端保留旧副本，下一次上传又
 * 把云端改回去，用户在网页上做的改名/删除被静默撤销，全程无报错。
 *
 * 序号取 max(本行 OLD, 全表观测最大值) + 1，既满足服务端严格 LT 守卫的放行条件，
 * 又在客户端全序里压得住对端（细节与残余边界见 core/webTombstone.mintWebStamp）。
 *
 * 云端没有印记列（或探测缓存与实际 schema 不一致）→ 返回 {}，本次写入不带印记，
 * 与 deleteTab 的 stampCols 降级同口径。读本行失败（非列缺失）→ 直接抛错：
 * 宁可让用户看到「操作失败」，也不写一条注定被对端合并撤销的改名/删除。
 */
async function nextStampColumns(groupId: string, userId: string): Promise<Record<string, unknown>> {
  if (!(await supportsOpStamp())) return {};

  const { data, error } = await supabase
    .from('tab_groups')
    .select('id, last_op_seq')
    .eq('id', groupId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    // 列刚被删（探测缓存仍是 true）→ 按无印记处理，绝不写不存在的列
    if (/42703|PGRST204|column/i.test(`${error.code ?? ''} ${error.message ?? ''}`)) return {};
    throw new Error(error.message);
  }

  const cloudSeq = (data as { last_op_seq?: unknown } | null)?.last_op_seq;
  const stamp = mintWebStamp(
    await getDeviceId(),
    typeof cloudSeq === 'number' ? cloudSeq : null,
    await observedMaxCloudSeq(userId)
  );
  return { last_op_device: stamp.d, last_op_seq: stamp.s };
}

/**
 * 组级删除的 deleted_at 补丁：purgeExpiredCloudTombstones 以 deleted_at 为龄期基准，
 * 漏写（timestamptz NULL 无默认值，NULL < cutoff 恒为 false）会让墓碑行永远不会被清理。
 * 时刻与 updated_at 取同一个 now；云端无该列时整列省略（写不存在的列 → 42703 → 整次写失败）。
 */
async function deletedAtPatch(now: string): Promise<Record<string, unknown>> {
  return (await supportsDeletedAt()) ? { deleted_at: now } : {};
}

/** 重命名标签组（name 为纯文本列，直接 UPDATE） */
export async function renameGroup(groupId: string, name: string): Promise<void> {
  const userId = await requireUserId();
  // 改名同样是对组的一次写：不盖 stamp 就会被扩展端合并撤销（见 nextStampColumns）
  const stampCols = await nextStampColumns(groupId, userId);
  const { error } = await supabase
    .from('tab_groups')
    .update({ name, updated_at: new Date().toISOString(), ...stampCols })
    .eq('id', groupId)
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
}

/**
 * 删除标签组：UPDATE is_deleted=true（行保留 = 跨设备删除广播载体）。
 * 写入必须盖组 stamp（OLD+1）+ deleted_at，否则删除意图既会被扩展端合并撤销，
 * 也永远等不到龄期清理。无 is_deleted 列的旧云端 → 回退硬删。
 */
export async function deleteGroup(groupId: string): Promise<void> {
  const userId = await requireUserId();

  if (await supportsCloudTombstone()) {
    const now = new Date().toISOString();
    const [stampCols, deletedAtCols] = await Promise.all([
      nextStampColumns(groupId, userId),
      deletedAtPatch(now),
    ]);
    const { error } = await supabase
      .from('tab_groups')
      .update({ is_deleted: true, updated_at: now, ...deletedAtCols, ...stampCols })
      .eq('id', groupId)
      .eq('user_id', userId);
    if (error) throw new Error(error.message);
    return;
  }

  // 降级：硬删（旧行为）
  const { error } = await supabase
    .from('tab_groups')
    .delete()
    .eq('id', groupId)
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
}

/**
 * 删除标签组中的单个标签（无墓碑模型：物理移除 + 组级 LWW 广播）。
 * 流程：解密 → 按 id 物理剔除 → 组 stamp 提升（OLD+1）→ 重加密整组回写。
 * 对端下次合并按组 stamp 整组覆盖，删除随整组行广播（见 @/core/opStampMerge）。
 * 删后无 tab 且未锁定 → 整行盖删除广播（is_deleted=true），与扩展端
 * applyRemoveTab 拿空组的语义一致。
 * 加密/解密失败整批中止（不写任何列）；RLS 不变（全程 user_id 自带 + 同表同策略）。
 */
export async function deleteTab(groupId: string, tabId: string): Promise<void> {
  const userId = await requireUserId();

  // 读取当前行（含印记/删除列；列缺失时回退最小列，与 digest 探活同策略）
  const tombstoneSupported = await supportsCloudTombstone();
  const stampSupported = await supportsOpStamp();
  let columns = 'tabs_data, name, created_at, updated_at, is_locked';
  if (tombstoneSupported) columns += ', is_deleted';
  if (stampSupported) columns += ', last_op_seq';
  let groupAny: Record<string, unknown>;
  {
    const { data: row, error: getErr } = await supabase
      .from('tab_groups')
      .select(columns)
      .eq('id', groupId)
      .eq('user_id', userId)
      .single();
    if (!getErr) {
      groupAny = row as unknown as Record<string, unknown>;
    } else if (
      columns !== 'tabs_data, name, created_at, updated_at, is_locked' &&
      /42703|PGRST204|column/i.test(`${getErr.code ?? ''} ${getErr.message ?? ''}`)
    ) {
      // 列探测缓存与实际 schema 不一致 → 回退最小列
      const fallback = await supabase
        .from('tab_groups')
        .select('tabs_data, name, created_at, updated_at, is_locked')
        .eq('id', groupId)
        .eq('user_id', userId)
        .single();
      if (fallback.error) throw new Error(fallback.error.message);
      groupAny = fallback.data as unknown as Record<string, unknown>;
    } else {
      throw new Error(getErr.message);
    }
  }
  const hasTombstoneCol = tombstoneSupported && 'is_deleted' in groupAny;
  const hasStampCol = stampSupported && 'last_op_seq' in groupAny;

  if (typeof groupAny.tabs_data !== 'string') {
    throw new Error('该标签组的存储数据格式不受支持');
  }

  let decrypted: unknown;
  try {
    decrypted = await decryptData(groupAny.tabs_data, userId);
  } catch {
    throw new Error('无法解密该标签组数据');
  }

  // 同一次删除铸一个 stamp：取 max(本行 OLD, 全表观测最大值) + 1，
  // 对端整组覆盖时用它决胜——裸 OLD+1 会输给对端已上传的更高印记（见 mintWebStamp）
  const stamp = mintWebStamp(
    await getDeviceId(),
    typeof groupAny.last_op_seq === 'number' ? (groupAny.last_op_seq as number) : null,
    await observedMaxCloudSeq(userId)
  );
  const now = new Date().toISOString();
  const r = applyWebRemoveTab(decrypted, tabId, { isLocked: Boolean(groupAny.is_locked) });
  if (!r.found) throw new Error('未找到该标签页');

  const stampCols = hasStampCol ? { last_op_device: stamp.d, last_op_seq: stamp.s } : {};

  if (r.autoDeleteGroup) {
    // 删后无 tab 且未锁定 → 整行删除广播，不再回写 tabs_data
    if (!hasTombstoneCol) {
      // 无 is_deleted 列 → 硬删兜底（与 deleteGroup 降级同口径）
      const { error } = await supabase
        .from('tab_groups')
        .delete()
        .eq('id', groupId)
        .eq('user_id', userId);
      if (error) throw new Error(error.message);
      return;
    }
    const { error } = await supabase
      .from('tab_groups')
      .update({ is_deleted: true, updated_at: now, ...(await deletedAtPatch(now)), ...stampCols })
      .eq('id', groupId)
      .eq('user_id', userId);
    if (error) throw new Error(error.message);
    return;
  }

  // 物理移除后的载荷重加密回写（形状不变：数组仍数组，wrapper 保留其余键）
  let newEncrypted: string;
  try {
    newEncrypted = await encryptData(r.updated, userId);
  } catch {
    throw new Error('加密标签组数据失败，已中止写入');
  }
  const { error } = await supabase
    .from('tab_groups')
    .update({ tabs_data: newEncrypted, updated_at: now, ...stampCols })
    .eq('id', groupId)
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
}
