/**
 * TapStack 网页版 API 封装
 *
 * 复用扩展的纯逻辑层（auth + downloadTabGroups），这些模块不依赖 chrome.* API，
 * 因此可直接在浏览器 Web 环境中运行。本文件提供面向页面组件的薄接口。
 */
import { supabase, auth as supabaseAuth, supportsCloudTombstone, supportsOpStamp, getDeviceId } from '@/utils/supabase';
import { applyWebRemoveTab, mintWebStamp } from '@/utils/webTombstone';
import { decryptData, encryptData } from '@/utils/encryptionUtils';
import { formatToOneTabFormat } from '@/utils/oneTabFormatParser';
import type { Tab, TabGroup } from '@/types/tab';

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

function isValidTab(tab: unknown): tab is Tab {
  const t = tab as Tab;
  return typeof t === 'object' && t !== null &&
    typeof t.url === 'string' && typeof t.title === 'string';
}

/**
 * 加密内容其实是 TabGroup（含 tabs/version/displayOrder 的数组），
 * 所以 tabs 数组元素是 camelCase 的 Tab，而非 TabData。
 * 直接从解密对象中还原出 TabGroup。
 */
function toTabGroupFromEncrypted(groupId: string, decrypted: unknown): TabGroup | null {
  if (Array.isArray(decrypted)) {
    // 纯数组 → 当作 Tab[]，用 group 表字段补充 name 等
    const tabs = decrypted.filter(isValidTab);
    return {
      id: groupId,
      name: '',
      tabs,
      createdAt: '',
      updatedAt: '',
      isLocked: false,
    };
  }

  if (decrypted && typeof decrypted === 'object') {
    const obj = decrypted as Record<string, unknown>;
    const rawTabs = Array.isArray(obj.tabs) ? obj.tabs.filter(isValidTab) : [];
    return {
      id: String(obj.id ?? groupId),
      name: String(obj.name ?? obj.title ?? '未命名会话'),
      tabs: rawTabs,
      createdAt: String(obj.createdAt ?? obj.created_at ?? ''),
      updatedAt: String(obj.updatedAt ?? obj.updated_at ?? ''),
      isLocked: Boolean(obj.isLocked ?? obj.is_locked ?? false),
      notes: typeof obj.notes === 'string' ? obj.notes : undefined,
      version: typeof obj.version === 'number' ? obj.version : undefined,
      displayOrder: typeof obj.displayOrder === 'number' ? obj.displayOrder : undefined,
    };
  }

  return null;
}

/**
 * 将一行 tab_groups 云端行解密为 TabGroup（与 fetchGroups 共用）。
 * 失败时返回 null（解密失败或格式不支持）。
 */
async function decryptRowToGroup(row: Record<string, unknown>, userId: string): Promise<TabGroup | null> {
  const groupAny = row as any;
  const groupId = String(groupAny.id);
  const fallbackName = String(groupAny.name ?? '未命名会话');
  const fallbackCreatedAt = String(groupAny.created_at ?? '');
  const fallbackUpdatedAt = String(groupAny.updated_at ?? '');
  const fallbackIsLocked = Boolean(groupAny.is_locked ?? false);

  if (typeof groupAny.tabs_data === 'string') {
    try {
      const decrypted = await decryptData(groupAny.tabs_data, userId);
      const group = toTabGroupFromEncrypted(groupId, decrypted);
      if (!group) {
        console.warn(`[decryptRowToGroup] 组 ${groupAny.id} 解密结果无法解析`);
        return null;
      }
      // 用 group 表字段补齐（加密对象常缺 name/时间戳）
      group.name = group.name || fallbackName;
      group.createdAt = group.createdAt || fallbackCreatedAt;
      group.updatedAt = group.updatedAt || fallbackUpdatedAt;
      group.isLocked = group.isLocked || fallbackIsLocked;
      return group;
    } catch (decryptError) {
      console.warn(`[decryptRowToGroup] 组 ${groupAny.id} 解密失败:`, decryptError);
      // 最后回退：普通解析
      try {
        const parsed = JSON.parse(groupAny.tabs_data);
        if (Array.isArray(parsed)) {
          return {
            id: groupId, name: fallbackName, tabs: (parsed as unknown[]).filter(isValidTab),
            createdAt: fallbackCreatedAt, updatedAt: fallbackUpdatedAt, isLocked: fallbackIsLocked,
          };
        }
      } catch {
        // 忽略
      }
      return null;
    }
  }

  if (Array.isArray(groupAny.tabs_data)) {
    // tabs_data 已经是数组（明文）
    const g = toTabGroupFromEncrypted(groupId, groupAny.tabs_data) as TabGroup;
    g.name = g.name || fallbackName;
    g.createdAt = g.createdAt || fallbackCreatedAt;
    g.updatedAt = g.updatedAt || fallbackUpdatedAt;
    g.isLocked = g.isLocked || fallbackIsLocked;
    return g;
  }

  // 无 tabs_data，仍显示组
  return {
    id: groupId, name: fallbackName, tabs: [],
    createdAt: fallbackCreatedAt, updatedAt: fallbackUpdatedAt, isLocked: fallbackIsLocked,
  };
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
    if (group) {
      // 标签级墓碑只用于同步删除意图：Web 列表与顶部统计都不计入（与扩展端 stripTombstonedTabs 同口径）
      if (group.tabs?.some(t => t.isDeleted)) {
        group.tabs = group.tabs.filter(t => !t.isDeleted);
      }
      tabGroups.push(group);
    }
  }

  return tabGroups;
}

/** 仅加载已软删（墓碑）的会话，供 Web 误删恢复视图使用 */
export async function fetchDeletedGroups(): Promise<TabGroup[]> {
  const current = await getCurrentUser();
  if (!current) {
    throw new WebAuthError('未登录');
  }
  const userId = current.id;
  const { data: rows, error } = await supabase
    .from('tab_groups')
    .select('*')
    .eq('user_id', userId)
    .eq('is_deleted', true)
    .order('updated_at', { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  const groups: TabGroup[] = [];
  for (const row of rows ?? []) {
    const group = await decryptRowToGroup(row as Record<string, unknown>, userId);
    if (group) {
      group.isDeleted = true;
      groups.push(group);
    }
  }
  return groups;
}

/**
 * 恢复已软删的会话（S5：与扩展 restoreGroup 同语义——复位活跃 + 组 stamp 提升，
 * 使恢复意图在跨端合并时盖过删除前的旧 stamp；无印记列时退化为 plain 复位）。
 */
export async function restoreGroup(groupId: string): Promise<void> {
  const userId = await requireUserId();
  const now = new Date().toISOString();
  if (await supportsOpStamp()) {
    // 读现 seq 铸新 stamp（OLD+1，归属本设备；读不到则从 1 起，仍盖过无印记旧行）
    let cloudSeq: number | null = null;
    try {
      const { data } = await supabase
        .from('tab_groups')
        .select('last_op_seq')
        .eq('id', groupId)
        .eq('user_id', userId)
        .single();
      if (data && typeof (data as Record<string, unknown>).last_op_seq === 'number') {
        cloudSeq = (data as Record<string, unknown>).last_op_seq as number;
      }
    } catch {
      // 读失败不断恢复流程：降级用基准 stamp（下文列缺失时还会再退 plain）
    }
    const stamp = mintWebStamp(await getDeviceId(), cloudSeq);
    const { error } = await supabase
      .from('tab_groups')
      .update({ is_deleted: false, updated_at: now, last_op_device: stamp.d, last_op_seq: stamp.s })
      .eq('id', groupId)
      .eq('user_id', userId);
    if (!error) return;
    // 列探测缓存与实际 schema 不一致（42703/PGRST204）→ 退 plain 复位，不中断恢复
    if (/42703|PGRST204|column/i.test(`${error.code ?? ''} ${error.message ?? ''}`)) {
      const { error: plainError } = await supabase
        .from('tab_groups')
        .update({ is_deleted: false, updated_at: now })
        .eq('id', groupId)
        .eq('user_id', userId);
      if (plainError) throw new Error(plainError.message);
      return;
    }
    throw new Error(error.message);
  }
  const { error } = await supabase
    .from('tab_groups')
    .update({ is_deleted: false, updated_at: now })
    .eq('id', groupId)
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
}

/**
 * 云端彻底删除（S5：与扩展 purgeGroup 门禁对齐——仅允许 purge 回收站中的墓碑组。
 * 活跃组直接物理移除会绕过墓碑广播，对端活跃副本下轮上传即幽灵复活；
 * 无 is_deleted 列的旧云端无法设门，沿用历史硬删行为。）
 */
export async function purgeGroupPermanent(groupId: string): Promise<void> {
  const userId = await requireUserId();
  if (await supportsCloudTombstone()) {
    const { data, error: getErr } = await supabase
      .from('tab_groups')
      .select('is_deleted')
      .eq('id', groupId)
      .eq('user_id', userId)
      .single();
    if (getErr) {
      if (getErr.code === 'PGRST116') throw new Error('未找到该标签组');
      throw new Error(getErr.message);
    }
    if (!(data as Record<string, unknown>)?.is_deleted) {
      throw new Error('仅允许彻底删除回收站中的已删除组（请先删除该组后再清空）');
    }
  }
  const { error } = await supabase
    .from('tab_groups')
    .delete()
    .eq('id', groupId)
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
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

/** 重命名标签组（name 为纯文本列，直接 UPDATE） */
export async function renameGroup(groupId: string, name: string): Promise<void> {
  const userId = await requireUserId();
  const { error } = await supabase
    .from('tab_groups')
    .update({ name, updated_at: new Date().toISOString() })
    .eq('id', groupId)
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
}

/** 删除标签组（双轨：云端有 is_deleted 列 → 软删墓碑；无列 → 回退硬删） */
export async function deleteGroup(groupId: string): Promise<void> {
  const userId = await requireUserId();

  if (await supportsCloudTombstone()) {
    // tombstone：保留行标记 is_deleted=true 并推新 updated_at，
    // 这样扩展端同步时能收到删除意图，不会"复活"已删组
    const { error } = await supabase
      .from('tab_groups')
      .update({ is_deleted: true, updated_at: new Date().toISOString() })
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
 * 删除标签组中的单个标签（S5：与扩展端同口径的墓碑命令，纯变换见 @/core/webTombstone）。
 * 旧行为「解密-过滤-重加密」物理移除 tab，跨端合并时扩展端无法识别删除意图而复活；
 * 现行为：墓碑 tab 保留在 tabs_data 内（isDeleted/is_deleted + stamp），组行 updated_at
 * 与组 stamp 同步提升；删后无活跃 tab 且未锁定则整行盖组级墓碑（与 applyRemoveTab 同语义）。
 * 加密/解密失败整批中止（不写任何列）；RLS 不变（全程 user_id 自带 + 同表同策略）。
 */
export async function deleteTab(groupId: string, tabId: string): Promise<void> {
  const userId = await requireUserId();

  // 读取当前行（含墓碑/印记列；列缺失时回退最小列，与 digest 探活同策略）
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
      // 列探测缓存与实际 schema 不一致 → 回退最小列（本次按 plain/无组墓碑执行）
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
  // 回退分支下强制关闭新列语义（本函数后续只读这两个布尔值的一次性快照）
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

  // 同一次删除只铸一个 stamp：墓碑 tab 与组行共用（P0-3 组级提升的 Web 侧实现）
  const stamp = mintWebStamp(
    await getDeviceId(),
    typeof groupAny.last_op_seq === 'number' ? (groupAny.last_op_seq as number) : null
  );
  const now = new Date().toISOString();
  const r = applyWebRemoveTab(decrypted, tabId, stamp, now, { isLocked: Boolean(groupAny.is_locked) });
  if (!r.found) throw new Error('未找到该标签页');
  if (r.alreadyTombstoned) return; // 幂等：已是墓碑，无需重写

  const stampCols = hasStampCol ? { last_op_device: stamp.d, last_op_seq: stamp.s } : {};

  if (r.autoDeleteGroup) {
    // 删后无活跃 tab 且未锁定 → 整行盖组级墓碑，不再回写 tabs_data
    if (!hasTombstoneCol) {
      // 无 is_deleted 列 → 硬删兜底（与 markCloudGroupsAsDeleted 同口径）
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
      .update({ is_deleted: true, updated_at: now, ...stampCols })
      .eq('id', groupId)
      .eq('user_id', userId);
    if (error) throw new Error(error.message);
    return;
  }

  // 墓碑载荷重加密回写（形状不变：数组仍数组，wrapper 保留其余键）
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
