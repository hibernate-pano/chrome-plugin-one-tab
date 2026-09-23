/**
 * S3 拆分 · download：下行链路（全量下载/设置下载，含解密归一化）。
 * 方法体为原 `sync` 对象对应成员逐字搬运（含缩进），仅对象壳更名；行为零变化。
 */
import type { TabGroup, TabData } from '@/types/tab';
import { decryptData, isEncrypted } from '../encryptionUtils';
import { sanitizeTabUrl } from '../inputValidation';
import { normalizeTabsData } from '../normalizeTabsData';
import { deserializeTab } from '../tabDataCodec';
import { supabase, checkSupabaseConfig } from './client';
import { supportsOpStamp } from './probe';

export const downloadSync = {
  // 下载标签组
  async downloadTabGroups() {
    checkSupabaseConfig();
    // 先检查会话是否有效
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();

    if (sessionError) {
      console.error('获取会话失败:', sessionError);
      throw new Error(`获取会话失败: ${sessionError.message}`);
    }

    if (!sessionData.session) {
      console.error('用户未登录或会话已过期');
      throw new Error('用户未登录或会话已过期，请重新登录');
    }

    // 获取用户信息
    const { data: { user }, error: userError } = await supabase.auth.getUser();

    if (userError) {
      console.error('获取用户信息失败:', userError);
      throw new Error(`获取用户信息失败: ${userError.message}`);
    }

    if (!user) {
      console.error('用户未登录');
      throw new Error('用户未登录');
    }

    if (!user.id) {
      console.error('用户ID无效');
      throw new Error('用户ID无效');
    }

    try {

      // 确保用户已登录并且会话有效
      const { data: sessionCheck } = await supabase.auth.getSession();
      if (!sessionCheck.session) {
        console.error('会话已过期，无法下载数据');
        throw new Error('会话已过期，请重新登录');
      }

      // 记录详细的会话信息
      console.log('会话信息:', {
        userID: user.id,
        sessionUserID: sessionCheck.session.user.id,
        isSessionValid: !!sessionCheck.session
      });

      // 确保用户ID匹配会话用户ID
      if (user.id !== sessionCheck.session.user.id) {
        console.warn('用户ID与会话用户ID不匹配，使用会话用户ID');
        user.id = sessionCheck.session.user.id;
      }

      // 获取用户的所有标签组，包含 tabs_data JSONB 字段，按创建时间倒序排列
      // 阶段二：显式 select stamp 列与 version 列（老客户端/存量行可能为空，nullable 处理）。
      // 云端没跑迁移时必须回退 `*`：带上不存在的列会让 PostgREST 报 42703 → **整次下载失败**（比上传失败更严重）。
      const selectColumns = (await supportsOpStamp())
        ? '*, last_op_device, last_op_seq, version'
        : '*';
      const { data: groups, error } = await supabase
        .from('tab_groups')
        .select(selectColumns)
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('获取标签组失败:', error);
        console.error('错误详情:', {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint
        });
        throw error;
      }

      console.log(`从云端获取到 ${groups.length} 个标签组`);

      // 记录每个云端标签组的基本信息
      groups.forEach((group: any, index) => {
        const tabsData = (group.tabs_data || []) as TabData[];
        console.log(`云端标签组 ${index + 1}/${groups.length}:`, {
          id: group.id,
          name: group.name,
          tabCount: tabsData.length,
          deviceId: group.device_id,
          updatedAt: group.updated_at,
          lastSync: group.last_sync
        });
      });

      // 将数据转换为应用格式
      const tabGroups: TabGroup[] = [];

      for (const group of groups) {
        // 单行容错：一个坏组（形状异常/字段缺失）不应让整次下载/合并失败，
        // 跳过该组并告警，其余组继续处理
        try {
        // 从 JSONB 字段获取标签数据
        let tabsData: TabData[] = [];
        const groupAny = group as any;

        // 检查是否是加密数据
        if (typeof groupAny.tabs_data === 'string') {
          try {
            // 尝试解密数据
            const decrypted = await decryptData<unknown>(groupAny.tabs_data as string, user.id);
            // decryptData 内部 JSON.parse 后 as T，无形状校验，必须在这里归一化
            tabsData = normalizeTabsData(decrypted, String(groupAny.id));
            console.log(`标签组 ${groupAny.id} 的数据已成功解密`);
          } catch (error) {
            console.error(`解密标签组 ${groupAny.id} 的数据失败:`, error);
            // 如果解密失败，尝试直接解析（可能是旧的未加密数据）
            try {
              if (typeof groupAny.tabs_data === 'string' && !isEncrypted(groupAny.tabs_data)) {
                // 旧版本可能把非数组数据明文写入云端，解析后同样必须归一化
                tabsData = normalizeTabsData(JSON.parse(groupAny.tabs_data), String(groupAny.id));
                console.log(`标签组 ${groupAny.id} 的数据是旧的未加密格式，已成功解析`);
              }
            } catch (jsonError) {
              console.error(`解析标签组 ${groupAny.id} 的JSON数据失败:`, jsonError);
              // 保持空数组
            }
          }
        } else {
          // 非字符串（可能是 JSONB 对象/数组/其他脏数据）：统一归一化，
          // 数组直通，wrapper 对象尝试恢复，其余降级为空数组
          tabsData = normalizeTabsData(groupAny.tabs_data, String(groupAny.id));
        }

        // 处理标签组数据

        // 将 TabData 转换为 Tab 格式（还原 tab 级 op-stamp；sanitize 防线在 codec 内）
        const formattedTabs = tabsData
          .map((tab: TabData) => deserializeTab(tab, String(groupAny.id)))
          .filter((t): t is NonNullable<typeof t> => t !== null);

        tabGroups.push({
          id: String(groupAny.id),
          name: String(groupAny.name),
          tabs: formattedTabs,
          createdAt: String(groupAny.created_at),
          updatedAt: String(groupAny.updated_at),
          isLocked: Boolean(groupAny.is_locked),
          // 云端 tombstone：is_deleted 列存在时才有值；无列时 undefined → 视为未删除
          isDeleted: Boolean(groupAny.is_deleted),
          // 阶段二·§6.1：操作印记。NULL 视为最小值（迁移前 / 老客户端）。
          // 仅当两侧都有值时构造对象，否则留 undefined → mergeOpStamped 走 EMPTY_STAMP。
          lastOp:
            typeof groupAny.last_op_seq === 'number' && groupAny.last_op_device
              ? { d: String(groupAny.last_op_device), s: groupAny.last_op_seq }
              : undefined,
          // 保留兼容（§11 version 冻结）；不再用于判定。
          version: typeof groupAny.version === 'number' ? groupAny.version : undefined,
        });
        } catch (groupError) {
          // 单组处理失败（如字段形状异常）不影响其他组的下载与合并
          console.error(
            `处理标签组 ${(group as any)?.id} 失败，已跳过该组:`,
            groupError
          );
        }
      }

      // 兼容性处理：如果标签组没有 tabs_data，尝试从 tabs 表获取
      for (const group of tabGroups) {
        if (group.tabs.length === 0) {
          try {
            const { data: tabs, error: tabError } = await supabase
              .from('tabs')
              .select('*')
              .eq('group_id', group.id as string);

            if (!tabError && tabs && tabs.length > 0) {
              // 同上：拒绝危险 URL
              const safeTabs: typeof group.tabs = [];
              for (const tab of tabs as any[]) {
                const safeUrl = sanitizeTabUrl(String(tab.url));
                if (!safeUrl) continue;
                safeTabs.push({
                  id: String(tab.id),
                  url: safeUrl,
                  title: String(tab.title),
                  favicon: tab.favicon ? String(tab.favicon) : undefined,
                  createdAt: String(tab.created_at),
                  lastAccessed: String(tab.last_accessed),
                  group_id: tab.group_id ? String(tab.group_id) : undefined,
                  pinned: tab.pinned ?? false,
                });
              }
              group.tabs = safeTabs;
            }
          } catch (e) {
            console.warn(`从 tabs 表获取标签失败，忽略错误:`, e);
          }
        }
      }

      return tabGroups;
    } catch (error) {
      console.error('下载标签组失败:', error);
      throw error;
    }
  },
  // 下载用户设置
  async downloadSettings() {
    checkSupabaseConfig();
    // 先检查会话是否有效
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();

    if (sessionError) {
      console.error('获取会话失败:', sessionError);
      throw new Error(`获取会话失败: ${sessionError.message}`);
    }

    if (!sessionData.session) {
      console.error('用户未登录或会话已过期');
      throw new Error('用户未登录或会话已过期，请重新登录');
    }

    // 获取用户信息
    const { data: { user }, error: userError } = await supabase.auth.getUser();

    if (userError) {
      console.error('获取用户信息失败:', userError);
      throw new Error(`获取用户信息失败: ${userError.message}`);
    }

    if (!user) {
      console.error('用户未登录');
      throw new Error('用户未登录');
    }

    if (!user.id) {
      console.error('用户ID无效');
      throw new Error('用户ID无效');
    }

    // 确保用户ID匹配会话用户ID
    if (user.id !== sessionData.session.user.id) {
      console.warn('用户ID与会话用户ID不匹配，使用会话用户ID');
      user.id = sessionData.session.user.id;
    }

    // 下载用户设置

    const { data, error } = await supabase
      .from('user_settings')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('下载用户设置失败:', error);
      console.error('错误详情:', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint
      });
      throw error;
    }

    // 如果有数据，将下划线命名法转换为驼峰命名法
    if (data) {
      // 定义允许的数据库字段到设置字段的映射
      const fieldMapping: Record<string, string> = {
        'group_name_template': 'groupNameTemplate',
        'show_favicons': 'showFavicons',
        'show_tab_count': 'showTabCount',
        'confirm_before_delete': 'confirmBeforeDelete',
        'allow_duplicate_tabs': 'allowDuplicateTabs',
        'sync_enabled': 'syncEnabled',
        'layout_mode': 'layoutMode',
        'show_notifications': 'showNotifications',
        'sync_strategy': 'syncStrategy',
        'delete_strategy': 'deleteStrategy',
        'theme_mode': 'themeMode',
        'theme_style': 'themeStyle',
        'collect_pinned_tabs': 'collectPinnedTabs',
        'reorder_mode': 'reorderMode',
        // 向后兼容性：如果云端还有旧的字段，也要处理
        'use_double_column_layout': 'useDoubleColumnLayout'
      };

      const convertedSettings: Record<string, any> = {};
      for (const [key, value] of Object.entries(data)) {
        // 跳过非设置字段
        if (['user_id', 'device_id', 'last_sync'].includes(key)) {
          continue;
        }

        // 使用映射表转换字段名
        if (fieldMapping[key]) {
          convertedSettings[fieldMapping[key]] = value;
        } else {
          console.warn(`跳过未知的数据库字段: ${key}`);
        }
      }

      return convertedSettings;
    }

    return data;
  }
};
