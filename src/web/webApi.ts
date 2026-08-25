/**
 * TapStack 网页版 API 封装
 *
 * 复用扩展的纯逻辑层（auth + downloadTabGroups），这些模块不依赖 chrome.* API，
 * 因此可直接在浏览器 Web 环境中运行。本文件提供面向页面组件的薄接口。
 */
import { supabase, auth as supabaseAuth, supportsCloudTombstone } from '@/utils/supabase';
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
    const groupId = String(groupAny.id);
    const fallbackName = String(groupAny.name ?? '未命名会话');
    const fallbackCreatedAt = String(groupAny.created_at ?? '');
    const fallbackUpdatedAt = String(groupAny.updated_at ?? '');
    const fallbackIsLocked = Boolean(groupAny.is_locked ?? false);

    if (typeof groupAny.tabs_data === 'string') {
      try {
        const decrypted = await decryptData(groupAny.tabs_data, userId);
        const group = toTabGroupFromEncrypted(groupId, decrypted);
        if (group) {
          // 用 group 表字段补齐（加密对象常缺 name/时间戳）
          group.name = group.name || fallbackName;
          group.createdAt = group.createdAt || fallbackCreatedAt;
          group.updatedAt = group.updatedAt || fallbackUpdatedAt;
          group.isLocked = group.isLocked || fallbackIsLocked;
          tabGroups.push(group);
        } else {
          console.warn(`[fetchGroups] 组 ${groupAny.id} 解密结果无法解析`);
        }
      } catch (decryptError) {
        console.warn(`[fetchGroups] 组 ${groupAny.id} 解密失败:`, decryptError);
        // 最后回退：普通解析
        try {
          const parsed = JSON.parse(groupAny.tabs_data);
          if (Array.isArray(parsed)) {
            tabGroups.push({
              id: groupId, name: fallbackName, tabs: (parsed as unknown[]).filter(isValidTab),
              createdAt: fallbackCreatedAt, updatedAt: fallbackUpdatedAt, isLocked: fallbackIsLocked,
            });
          }
        } catch {
          // 忽略
        }
      }
    } else if (Array.isArray(groupAny.tabs_data)) {
      // tabs_data 已经是数组（明文）
      const g = toTabGroupFromEncrypted(groupId, groupAny.tabs_data) as TabGroup;
      g.name = g.name || fallbackName;
      g.createdAt = g.createdAt || fallbackCreatedAt;
      g.updatedAt = g.updatedAt || fallbackUpdatedAt;
      g.isLocked = g.isLocked || fallbackIsLocked;
      tabGroups.push(g);
    } else {
      // 无 tabs_data，仍显示组
      tabGroups.push({
        id: groupId, name: fallbackName, tabs: [],
        createdAt: fallbackCreatedAt, updatedAt: fallbackUpdatedAt, isLocked: fallbackIsLocked,
      });
    }
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

/** 删除标签组中的单个标签（保留原加密数据结构，仅移除目标标签后重加密回写） */
export async function deleteTab(groupId: string, tabId: string): Promise<void> {
  const userId = await requireUserId();

  // 读取当前行，获取旧加密数据
  const { data: row, error: getErr } = await supabase
    .from('tab_groups')
    .select('tabs_data, name, created_at, updated_at, is_locked')
    .eq('id', groupId)
    .eq('user_id', userId)
    .single();
  if (getErr) throw new Error(getErr.message);

  const groupAny = row as any;
  if (typeof groupAny.tabs_data !== 'string') {
    throw new Error('该标签组的存储数据格式不受支持');
  }

  // 解密 → 转成 TabGroup 结构 → 移除目标标签
  let decrypted: unknown;
  try {
    decrypted = await decryptData(groupAny.tabs_data, userId);
  } catch (e) {
    throw new Error('无法解密该标签组数据');
  }

  // 统一提取 tabs 数组
  const group: TabGroup | null = toTabGroupFromEncrypted(groupId, decrypted);
  if (!group) throw new Error('无法解析该标签组数据');
  // 补齐明文名
  group.name = group.name || String(groupAny.name ?? '未命名会话');
  group.createdAt = group.createdAt || String(groupAny.created_at ?? '');
  group.updatedAt = group.updatedAt || String(groupAny.updated_at ?? '');
  group.isLocked = group.isLocked || Boolean(groupAny.is_locked ?? false);

  group.tabs = group.tabs.filter((t) => t.id !== tabId);
  group.updatedAt = new Date().toISOString();

  // 回写：保持原始加密结构（对象则保留对象，数组则保留数组）
  const updated = (() => {
    if (decrypted !== null && typeof decrypted === 'object' && !Array.isArray(decrypted)) {
      // 原对象 {tabs, version, displayOrder, ...} → 改 tabs 后整体重加密
      const obj = decrypted as Record<string, unknown>;
      return { ...obj, tabs: group.tabs };
    }
    // 原数组 → 加密纯数组（Tab[]）
    return group.tabs;
  })();

  const newEncrypted = await encryptData(updated, userId);
  const { error } = await supabase
    .from('tab_groups')
    .update({ tabs_data: newEncrypted, updated_at: new Date().toISOString() })
    .eq('id', groupId)
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
}
