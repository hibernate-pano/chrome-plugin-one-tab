/**
 * S3 拆分 · download：下行链路（全量下载/设置下载，含解密归一化）。
 * 方法体为原 `sync` 对象对应成员逐字搬运（含缩进），仅对象壳更名。
 *
 * 2026-09-29 补：下行链路的「读不出来就不碰」判据补齐到**部分**失败与
 * **形状**两个维度（见 MIN_RESTORABLE_TAB_RATIO 与 isUnrecoverableTabsShape）。
 * 原则不变：读不出来的一行绝不降级成「零标签的组」，因为 v1.22.0 起空组即物理
 * 删除、降级即等于删掉用户仅存于云端的那份数据。
 */
import type { TabGroup, TabData } from '@/types/tab';
import { decryptData, isEncrypted } from '../encryptionUtils';
import { sanitizeTabUrl } from '../inputValidation';
import { normalizeTabsData } from '@/core/normalizeTabsData';
import { deserializeTab } from '@/core/tabDataCodec';
import { supabase, checkSupabaseConfig } from './client';
import { supportsOpStamp } from './probe';
import { logError, logInfo, logWarn } from '../log';
import { CRYPTO_CONCURRENCY, mapWithConcurrency } from '../concurrency';

/**
 * 还原率阈值：云端一行里的标签有低于这个比例能还原成 Tab 时，这一行**整组跳过**。
 *
 * ── 为什么需要它（v1.22.0 无回收站，截断后回写 = 永久删除）────────────────
 * 一组 10 个标签、只有 1 个 https 能还原时，deserializeTab 会滤掉另外 9 个，
 * 产出「1 个标签的组」。这个截断组在 mergeOpStamped 里是赢家（云端 stamp 更新）
 * 就整组覆盖回云端，那 9 个标签在所有设备上同时消失。原有 fail-safe 只覆盖
 * 「一个都还原不出来」，部分失败完全没被接住。
 *
 * ── 0.5 这个数从哪来 ────────────────────────────────────────────────────
 * 两族「URL 过不了 sanitizeTabUrl」在比值上天然分离：
 *   A. 偶发异类链接（老版本 v1.17.0 之前 sanitizeTabUrl 白名单是死代码，
 *      file:/blob:/data: 会被存进云端；当前版本经 factory→filterValidTabs
 *      与导入链 applyImportGroups，两道门都不会再产生这类行）
 *      → 集中在「1~2 个 / 十几二十个」，比值贴着 1.0；
 *   B. 结构性坏行（整行被某个绕过 isInternalUrl 的写入方写成浏览器内部页：
 *      chrome:// / edge:// / chrome-extension://，或形状被别的版本改坏）
 *      → 主体全是滤不掉的，比值远低于 1。
 * 0.5 取两族之间的空档中点：离 A 的簇（>0.9）够远，离 B 的主体（<0.3）够远。
 * 它不是从某批云端真实数据里量出来的——那条样本拿不到，见包结果 remaining。
 * 判据本身刻意只看比值不看绝对数：一组 2 个标签掉 1 个（0.5）放行，
 * 一组 40 个掉 1 个（0.975）也放行，规则与组大小无关，调阈值只有一个旋钮。
 *
 * ── 宁可漏同步也不截断 ──────────────────────────────────────────────────
 * 低于阈值 → 整组跳过：不进下载结果、不参与合并、不登记 pendingDeleteIds，
 * 云端行原封保留，等问题修好（或对端重写）后自然重新出现。代价是「这一次
 * 同步窗口里看不见这一组」；反过来（截断后回写）的代价是「所有设备上永久
 * 丢失」。这两个代价不对称，所以偏向跳过。
 * 要调阈值只改这一个数。
 */
export const MIN_RESTORABLE_TAB_RATIO = 0.5;

/**
 * 一行的还原率是否可接受。
 * @param restorable 成功还原成 Tab 的数量
 * @param total      云端这一行声称的标签总数
 */
const isRestoreRateAcceptable = (restorable: number, total: number): boolean =>
  // total=0 不是「读不出来」，是「本来就没有标签」——空组的语义由下游空组规则
  // 统一处理（v1.22.0 起空组即删除），不在这里判定。
  total <= 0 || restorable / total >= MIN_RESTORABLE_TAB_RATIO;

/** 明确表示「没有标签」的标量写法：空串与两个空 JSON 文本 */
const EMPTY_TAB_DATA_LITERALS = new Set(['', '[]', '{}']);

/**
 * 归一化后一个标签都不剩时，判断这是「本来就没有标签」还是「形状读不出来」。
 * 只有后者必须让整组跳过。
 *
 * @param raw        解密/解析之后的原始值（不是 JSONB 原值：原值是加密串时这里放的是解出来的形状）
 * @param normalized normalizeTabsData 的结果（已确认长度为 0 时才有意义）
 */
const isUnrecoverableTabsShape = (raw: unknown, normalized: TabData[]): boolean => {
  if (normalized.length > 0) return false;
  // null/undefined = 这一行没有 tabs_data（老版本形态），不是读不出来：
  // 它要进结果，下面的兼容分支再去 tabs 表回填。
  if (raw == null) return false;
  if (Array.isArray(raw)) return raw.length > 0; // 非空数组会直通，归一化不会吃掉它
  if (typeof raw === 'object') return Object.keys(raw as object).length > 0;
  // 剩下的都是标量。合法形态只有数组与 wrapper 对象，标量一律是读不出来。
  return !EMPTY_TAB_DATA_LITERALS.has(String(raw));
};

/**
 * 解密一行的 tabs_data，得到「原始形状」（解密结果 / 明文 JSON 解析结果 / 原值）。
 *
 * 三条分支的语义与并发化前逐字一致：
 *  - 非字符串（JSONB 原值）→ 原样返回，交给下游 normalizeTabsData 做形状判据；
 *  - 字符串且解密成功 → 返回解密结果；
 *  - 解密失败 → **仅当** isEncrypted 判定为「本来就没加密」时才尝试 JSON.parse
 *    （老版本的明文行）；解析失败或本来就是密文时保持原字符串，
 *    由下游 isUnrecoverableTabsShape 判为不可恢复并整组跳过。
 *
 * 【为什么抽出来】下载循环体内混着 `continue`（还原率判据）与逐组 try/catch，
 * 整循环并发化要同时保住「顺序」「跳过语义」「错误隔离」三件事，改动面太大。
 * 把唯一 CPU 密集的一步（每组一次 PBKDF2-100k 解密，约 9ms）抽成可并发的预处理，
 * 循环体一行不改 —— 语义等价性因此可以直接验证，而不必重新论证整段容错逻辑。
 */
async function resolveTabsShape(groupAny: any, userId: string): Promise<unknown> {
  const rawTabsData: unknown = groupAny.tabs_data;
  if (typeof rawTabsData !== 'string') return rawTabsData;
  try {
    const decrypted = await decryptData<unknown>(rawTabsData, userId);
    logInfo(`标签组 ${groupAny.id} 的数据已成功解密`);
    return decrypted;
  } catch (error) {
    logError(`解密标签组 ${groupAny.id} 的数据失败:`, error);
    // 如果解密失败，尝试直接解析（可能是旧的未加密数据）
    try {
      if (!isEncrypted(rawTabsData)) {
        // 旧版本可能把非数组数据明文写入云端，解析结果同样要过下面的形状判据
        const parsed = JSON.parse(rawTabsData);
        logInfo(`标签组 ${groupAny.id} 的数据是旧的未加密格式，已成功解析`);
        return parsed;
      }
    } catch (jsonError) {
      logError(`解析标签组 ${groupAny.id} 的JSON数据失败:`, jsonError);
    }
    return rawTabsData;
  }
}

export const downloadSync = {
  // 下载标签组
  async downloadTabGroups() {
    checkSupabaseConfig();
    // 先检查会话是否有效
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();

    if (sessionError) {
      logError('获取会话失败:', sessionError);
      throw new Error(`获取会话失败: ${sessionError.message}`);
    }

    if (!sessionData.session) {
      logError('用户未登录或会话已过期');
      throw new Error('用户未登录或会话已过期，请重新登录');
    }

    // 获取用户信息
    const { data: { user }, error: userError } = await supabase.auth.getUser();

    if (userError) {
      logError('获取用户信息失败:', userError);
      throw new Error(`获取用户信息失败: ${userError.message}`);
    }

    if (!user) {
      logError('用户未登录');
      throw new Error('用户未登录');
    }

    if (!user.id) {
      logError('用户ID无效');
      throw new Error('用户ID无效');
    }

    try {

      // 确保用户已登录并且会话有效
      const { data: sessionCheck } = await supabase.auth.getSession();
      if (!sessionCheck.session) {
        logError('会话已过期，无法下载数据');
        throw new Error('会话已过期，请重新登录');
      }

      // 记录详细的会话信息
      logInfo('会话信息:', {
        userID: user.id,
        sessionUserID: sessionCheck.session.user.id,
        isSessionValid: !!sessionCheck.session
      });

      // 确保用户ID匹配会话用户ID
      if (user.id !== sessionCheck.session.user.id) {
        logWarn('用户ID与会话用户ID不匹配，使用会话用户ID');
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
        logError('获取标签组失败:', error);
        logError('错误详情:', {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint
        });
        throw error;
      }

      logInfo(`从云端获取到 ${groups.length} 个标签组`);

      // 记录每个云端标签组的基本信息
      groups.forEach((group: any, index) => {
        const tabsData = (group.tabs_data || []) as TabData[];
        logInfo(`云端标签组 ${index + 1}/${groups.length}:`, {
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

      // 并发解密预处理（见 resolveTabsShape 的说明）。
      //
      // 与上传侧同一个理由：每组一次 PBKDF2-100k（约 9ms 纯 CPU），串行跑 N 组
      // 就是 N×9ms，而这段时间全在 SW 的单写者队列里 —— 后台同步每 60s 一次，
      // 用户此刻点「删除会话 / 清理重复」必须排在它后面。
      // mapWithConcurrency 保证结果顺序与输入一致，因此可以按下标取用。
      //
      // 【代价与对策】并发解密会把**全部**结果同时留在内存里（resolvedShapes），
      // 而串行版本是「解密一组、处理一组、随即释放」。这会在原有峰值
      // （groups 密文 + tabGroups 成型数据）之上再多出一份解密明文副本。
      // 因此每处理完一组就把槽位置空，让 GC 能回收已消费的明文 ——
      // 峰值从「全部明文」降回「同时在飞的 8 组 + 尚未处理的」。
      const resolvedShapes = await mapWithConcurrency<unknown, unknown>(
        groups,
        CRYPTO_CONCURRENCY,
        group => resolveTabsShape(group as any, user.id)
      );

      for (const [index, group] of groups.entries()) {
        // 单行容错：一个坏组（形状异常/字段缺失）不应让整次下载/合并失败，
        // 跳过该组并告警，其余组继续处理
        try {
        const groupAny = group as any;
        // ── 取出「这一行声称的标签」，并把「真的空」与「读不出来」分开 ──────────
        //
        // 两条来源（加密串 / JSONB 原值）过去各写各的：只有 JSONB 分支带形状
        // fail-safe，加密串分支解密「成功」但结果不是数组时被直接归一化成空数组
        // 并当成零标签空组放行（→ 下游硬删 + 登记 purge）。同一个形状两种答案，
        // 现在合成一条判据，判据只看「归一化后是否还剩东西」。
        // 解密已在循环前并发完成（见 resolveTabsShape）；这里只按下标取结果。
        const rawShape: unknown = resolvedShapes[index];
        // 取走即释放：这份明文已被 normalizeTabsData 消费，留着只增加峰值内存
        resolvedShapes[index] = null;
        // decryptData 内部 JSON.parse 后 as T，无形状校验，必须在这里归一化
        const tabsData = normalizeTabsData(rawShape, String(groupAny.id));

        // 【读不出来 ≠ 是空的】这一行携带的是我们读不出的真实数据，绝不能降级成
        // 「零标签的组」——下游会把它当成空壳硬删除并登记云端 purge，那等于把用户
        // 仅存于云端的那份数据删掉（v1.22.0 无回收站）。
        // 原则：读不出来就不碰。整组跳过，不合入本地、不登记 purge，云端行原封
        // 保留，等问题修好后自然重新出现。
        if (isUnrecoverableTabsShape(rawShape, tabsData)) {
          logError(
            `标签组 ${groupAny.id} 的内容无法读取（解密与明文解析均失败，或形状不可恢复），` +
              `已跳过该组以保护云端数据不被误删`
          );
          continue;
        }

        // 处理标签组数据

        // 将 TabData 转换为 Tab 格式（还原 tab 级 op-stamp；sanitize 防线在 codec 内）
        const formattedTabs = tabsData
          .map((tab: TabData) => deserializeTab(tab, String(groupAny.id)))
          .filter((t): t is NonNullable<typeof t> => t !== null);

        // 【读不出来 ≠ 是空的 · 第二条，与上面那条同源同治】
        // tabs_data 明明有 N 个标签，却有大半还原不出来（被 sanitizeTabUrl 判为
        // 危险协议/非法 URL：chrome://、edge://、file:、blob:、data:…）——这不等于
        // 「这一组本来就没有那么多标签」。还原出来的截断组会被 mergeOpStamped 当
        // 赢家整组覆盖回云端，落差的标签在所有设备上一起消失；dropEmptyGroups 那条
        // 兜底也拦不住（截断组非空）。v1.22.0 起没有回收站 = 永久删除。
        // 读不出来就不碰：整组跳过，不合入本地、不登记 purge，云端行原封保留。
        // 判据用比值（MIN_RESTORABLE_TAB_RATIO，见文件顶部），全失败是它的 0 端；
        // 注意只在 tabs_data **非空**时判定——真的空组仍要进结果（老版本还没有
        // tabs_data 的组要在下面的兼容分支里回查 tabs 表）。
        if (tabsData.length > 0 && !isRestoreRateAcceptable(formattedTabs.length, tabsData.length)) {
          const lost = tabsData.length - formattedTabs.length;
          logError(
            `标签组 ${groupAny.id} 的 ${tabsData.length} 个标签有 ${lost} 个无法还原` +
              `（URL 未通过安全校验），还原率 ${(formattedTabs.length / tabsData.length).toFixed(2)} ` +
              `低于阈值 ${MIN_RESTORABLE_TAB_RATIO}，已跳过该组以保护云端数据不被截断回写`
          );
          continue;
        }

        tabGroups.push({
          id: String(groupAny.id),
          name: String(groupAny.name),
          tabs: formattedTabs,
          createdAt: String(groupAny.created_at),
          updatedAt: String(groupAny.updated_at),
          isLocked: Boolean(groupAny.is_locked),
          // 云端 tombstone：is_deleted 列存在时才有值；无列时 undefined → 视为未删除
          isDeleted: Boolean(groupAny.is_deleted),
          // D3：云端 deleted_at 列存在时才有值；缺失 → undefined → sweep 回退 updatedAt
          deletedAt:
            typeof (groupAny as { deleted_at?: unknown }).deleted_at === 'string'
              ? String((groupAny as { deleted_at?: unknown }).deleted_at)
              : undefined,
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
          logError(
            `处理标签组 ${(group as any)?.id} 失败，已跳过该组:`,
            groupError
          );
        }
      }

      // 兼容性处理：如果标签组没有 tabs_data，尝试从 tabs 表获取
      // 同样受还原率判据约束：tabs 表也是老版本的写入方，回填出截断组的后果与
      // tabs_data 路径完全一样（合并后整组回写云端 → 标签永久消失）。但这里不能
      // 「留空 tabs」了事——空组会被 dropEmptyGroups 硬删并登记 purge，与「读不出来
      // 就不碰」相反。只能把这一组从结果里整个拿掉。
      const truncatedByTabsTable = new Set<string>();
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
              if (!isRestoreRateAcceptable(safeTabs.length, tabs.length)) {
                logError(
                  `标签组 ${group.id} 从 tabs 表回填时 ${tabs.length} 行有 ${tabs.length - safeTabs.length} 行无法还原` +
                    `（URL 未通过安全校验），还原率 ${(safeTabs.length / tabs.length).toFixed(2)} ` +
                    `低于阈值 ${MIN_RESTORABLE_TAB_RATIO}，已跳过该组以保护云端数据不被截断回写`
                );
                truncatedByTabsTable.add(group.id);
                continue;
              }
              group.tabs = safeTabs;
            }
          } catch (e) {
            logWarn(`从 tabs 表获取标签失败，忽略错误:`, e);
          }
        }
      }

      return truncatedByTabsTable.size > 0
        ? tabGroups.filter(g => !truncatedByTabsTable.has(g.id))
        : tabGroups;
    } catch (error) {
      logError('下载标签组失败:', error);
      throw error;
    }
  },
  // 下载用户设置
  async downloadSettings() {
    checkSupabaseConfig();
    // 先检查会话是否有效
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();

    if (sessionError) {
      logError('获取会话失败:', sessionError);
      throw new Error(`获取会话失败: ${sessionError.message}`);
    }

    if (!sessionData.session) {
      logError('用户未登录或会话已过期');
      throw new Error('用户未登录或会话已过期，请重新登录');
    }

    // 获取用户信息
    const { data: { user }, error: userError } = await supabase.auth.getUser();

    if (userError) {
      logError('获取用户信息失败:', userError);
      throw new Error(`获取用户信息失败: ${userError.message}`);
    }

    if (!user) {
      logError('用户未登录');
      throw new Error('用户未登录');
    }

    if (!user.id) {
      logError('用户ID无效');
      throw new Error('用户ID无效');
    }

    // 确保用户ID匹配会话用户ID
    if (user.id !== sessionData.session.user.id) {
      logWarn('用户ID与会话用户ID不匹配，使用会话用户ID');
      user.id = sessionData.session.user.id;
    }

    // 下载用户设置

    const { data, error } = await supabase
      .from('user_settings')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (error && error.code !== 'PGRST116') {
      logError('下载用户设置失败:', error);
      logError('错误详情:', {
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
          logWarn(`跳过未知的数据库字段: ${key}`);
        }
      }

      return convertedSettings;
    }

    return data;
  }
};
