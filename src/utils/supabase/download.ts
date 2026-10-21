/**
 * S3 拆分 · download：下行链路（全量下载/设置下载，含解密归一化）。
 * 方法体为原 `sync` 对象对应成员逐字搬运（含缩进），仅对象壳更名。
 *
 * 2026-09-29 补：下行链路的「读不出来就不碰」判据补齐到**部分**失败与
 * **形状**两个维度（见 MIN_RESTORABLE_TAB_RATIO 与 isUnrecoverableTabsShape）。
 * 原则不变：读不出来的一行绝不降级成「零标签的组」，因为 v1.22.0 起空组即物理
 * 删除、降级即等于删掉用户仅存于云端的那份数据。
 */
import type { TabGroup, TabData, DownloadSkippedGroup, DownloadSkipReason } from '@/types/tab';
import { RETIRED_SETTING_COLUMNS } from '@/types/tab';
import { decryptData, isEncrypted } from '../encryptionUtils';
import { sanitizeTabUrl } from '../inputValidation';
import { normalizeTabsData } from '@/core/normalizeTabsData';
import { deserializeTab } from '@/core/tabDataCodec';
import { supabase, checkSupabaseConfig } from './client';
import { supportsOpStamp } from './probe';
import { DOWNLOAD_PAGE_SIZE } from './idBatches';
import { logError, logInfo, logWarn } from '../log';
import { CRYPTO_CONCURRENCY, mapWithConcurrency } from '../concurrency';

/**
 * 还原率阈值：云端一行里的标签有低于这个比例能还原成 Tab 时，这一行**整组跳过**。
 *
 * ── 为什么需要它（v1.22.0 无回收站，截断后回写 = 永久删除）────────────────
 * 一组 10 个标签、只有 1 个能还原时，deserializeTab 会滤掉另外 9 个，
 * 产出「1 个标签的组」。这个截断组在 mergeOpStamped 里是赢家（云端 stamp 更新）
 * 就整组覆盖回云端，那 9 个标签在所有设备上同时消失。原有 fail-safe 只覆盖
 * 「一个都还原不出来」，部分失败完全没被接住。
 *
 * ── 2026-10-05：这道判据的适用范围被收窄了 ────────────────────────────
 * 之前它挡的是「URL 过不了 sanitizeTabUrl」，而那道门把两件事混在一起：
 * 「危险 schema 该丢」与「本设备打不开但该留」。于是 file:/blob:/devtools:
 * 这类地址（用户保存时确实打得开）被算成「还原失败」，一个 3 标签的组里
 * 有 2 个 file: 就会 0.33 < 0.5，连同那个正常的 https 标签一起被整组隐藏——
 * 而不可还原是云端那行数据的**不可变属性**，没有任何代码会去修它，
 * 「对端重写」也救不了（serializeTab 不做消毒，写回去还是同一个 URL）。
 * 也就是说这道判据触发时，那一组是**永久**不可见，不是「暂时看不见」。
 *
 * 现在 deserializeTab 只对**危险 schema** 返回 null，file:/blob: 这类会
 * 带着 `unopenable: true` 正常返回、计入还原数。因此本判据回归到它本来的
 * 职责：只拦「结构性坏行」（整行被写成 chrome:// 内部页、形状被改坏、
 * 密钥不对导致整体解不出来），而不再误伤「本地文件 / blob 链接」这种常态。
 *
 * 判据只看比值不看绝对数：一组 2 个标签掉 1 个（0.5）放行，
 * 一组 40 个掉 1 个（0.975）也放行，规则与组大小无关，调阈值只有一个旋钮。
 *
 * ── 宁可漏同步也不截断 ──────────────────────────────────────────────────
 * 低于阈值 → 整组跳过：不进下载结果、不参与合并、不登记 pendingDeleteIds，
 * 云端行原封保留。代价是「这一组在修好前不可见」；反过来（截断后回写）的
 * 代价是「所有设备上永久丢失」。这两个代价不对称，所以偏向跳过。
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

/**
 * 最近一次 downloadTabGroups() 里「读不出来而被整组跳过」的会话。
 *
 * 跨方法传递「同一轮的结果」用的单一来源：downloadTabGroups 写它，
 * downloadSkippedGroups 读它。这样「读到了什么」与「哪些读不出来」
 * **必然来自同一轮**（见 supabaseAdapter.lastDownload 的同类论证）。
 *
 * null = 本进程还没下载过（此时 downloadSkippedGroups 返回空清单 ——
 * 「本轮没跳过任何会话」是**事实**，不是「不知道」）。
 *
 * ── 为什么下载**开始时**就要清空它（2026-10-20 D-6 复核补）───────────────
 * 原先只在下载**成功结束**时赋值（`lastDownloadSkipped = skipped`），
 * 于是「下载失败」这条路上它**保留着上一轮的值**：
 *   第 1 轮：云端有组 A 读不出来 ⇒ 清单 = [A]，下载成功
 *   第 2 轮：网络断了 ⇒ 下载抛错 ⇒ 清单**仍是 [A]**（上一轮的）
 *
 * 今天的调用顺序让这个坑踩不到（`downloadGroups()` 先跑、失败就整轮中止，
 * 清单压根不会被读），但那是**顺序的巧合**，不是结构上的保证 ——
 * 以后任何人调换顺序、或者加一条「先取清单」的路径，就会静默拿到上一轮的
 * 清单 ⇒ 覆盖下载会拿「上一轮读不出来的组」去保护本机 ⇒ 保护错了对象。
 *
 * 在下载**开始时**清空 ⇒ 「清单要么是本轮的，要么是空的」永远成立。
 *
 * ── 已知理论窗口：同一 realm 内的并发下载（2026-10-20 D-6 裁决 B）────────
 *
 * 这个模块级变量**不是**按调用方隔离的。若**同一个 JS realm** 里两次
 * `downloadTabGroups()` **并发**跑（而不是串行），后一轮开始时的清空会
 * 把前一轮还没被读走的清单抹掉 ⇒ 前一轮的调用方随后读到的清单**属于后一轮**
 * ⇒ 覆盖下载会拿「后一轮读不出来的组」去保护本机 ⇒ **保护错了对象**。
 *
 * ── 为什么今天**不可达**（三条理由，缺一不可）─────────────────────────
 *   1. **单写者锁**：`SyncEngine.downloadAndMerge` 全程持 `isSyncing`，
 *      同一 realm 里的第二轮下载会被拒（`syncEngine.ts` 的 isSyncing 检查）。
 *   2. **紧邻调用**：`downloadGroups()` → `downloadSkippedGroups()` 是
 *      `services/downloadWithSkippedGroups.ts` 里**紧邻的两次 await**，
 *      中间没有让出给另一轮下载的 await 间隙。
 *   3. **跨 realm 不共享**：引擎跑在 **service worker**、下载预览跑在
 *      **popup 页面** —— 两个**不同的 JS realm**，各有各的模块实例，
 *      **不共享**这个模块级变量。
 *
 * ── 一旦出现第二个并发调用方，该做什么 ────────────────────────────────
 * 加**轮次序号**防护：`downloadTabGroups()` 开头把 `lastDownloadRound` 自增，
 * 把本轮序号与清单一起存下；`downloadSkippedGroups()` 只接受**本轮**的清单
 * （序号不匹配 ⇒ 返回空清单 = 事实「本轮没跳过任何组」）。
 * 之所以**现在不加**：端口上还没有第二个并发使用方，加了等于为假想的未来
 * 付费（还让端口多出一个「轮次」概念）。真出现并发调用方时**必须**加 ——
 * 别以为这里没坑。
 */
let lastDownloadSkipped: DownloadSkippedGroup[] | null = null;

export const downloadSync = {
  /**
   * 本轮（或最近一轮）下载里**读不出来**而被整组跳过的会话（2026-10-20 D-6）。
   *
   * 「这一组存在于云端，但这一轮没能把它还原成可用的会话」：
   * 形状不可恢复 / 还原率不达标 / tabs 表回填被网关截断 / 单组处理异常。
   * 那些**云端行原封保留**（一个字节都没被动过）。
   *
   * 为什么必须把它报出去（而不是让它在返回值里消失）：
   * 覆盖下载（forceRemote）会用云端**替换**本地。若「这轮没读到」与
   * 「云端没有」无法区分，引擎就会把本机那一份物理清除 ⇒
   * 云端的数据被用户自己的下载吃掉，界面还报「下载成功」。
   */
  async downloadSkippedGroups(): Promise<DownloadSkippedGroup[]> {
    // 返回**副本**（不是内部数组的引用）：调用方若把返回的数组 push/splice 了，
    // 就会改掉这份模块级状态 ⇒ 下一轮读到的清单被上一轮的调用方污染。
    // 「清单是事实」⇒ 事实不该被读它的人改写。
    return (lastDownloadSkipped ?? []).map(s => ({ ...s }));
  },

  // 下载标签组
  async downloadTabGroups() {
    // 本轮的清单从零开始（见上面 lastDownloadSkipped 的注释）：
    // 下载失败时它必须是空的，不能是上一轮的残留。
    lastDownloadSkipped = [];
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
      // 分页下载（1.22.14）。
      //
      // 此前是单次全表 select：每组带加密后的 tabs_data，几百组的响应体可以到
      // 几 MB 甚至更大 —— 与上传整包 upsert 是同一类「大库同步永远超时」的根因。
      // DOWNLOAD_PAGE_SIZE 行/页让单响应体回到安全量级；任一页失败即整体失败
      // （fail-closed），绝不用半份数据继续合并 —— 半份下载 = 半库覆盖，那才是
      // 真正的数据丢失。
      //
      // 排序：created_at DESC + id DESC。
      //
      // 【为什么必须有 id 这个 tiebreaker】（2026-10-07 实测的数据丢失）
      // created_at 不是唯一键：OneTab 导入会给同一批所有组盖上同一个 `now`
      // （oneTabFormatParser），快速连续保存也会撞在同一毫秒。当并列行数超过
      // 一页时，Postgres 对「并列行之间」的跨查询顺序不给任何保证，offset 窗口
      // 会重叠/跳过 —— 实测 450 行同 created_at 时，三次下载分别漏掉
      // 113 / 114 / 105 个不同 id，而且因为是短页退出（page.length < PAGE_SIZE），
      // 没有任何报错。漏掉的行会被当成「云端不存在」，本地旧副本随后上传覆盖
      // 掉更新的云端版本 = 真丢失。
      //
      // 【id tiebreaker 消除的是什么、不消除的是什么】（1.22.15 如实化）
      // tiebreaker 消除的只是「并列行跨查询顺序不稳定」：id 唯一 → 排序成为全序，
      // 同一份冻结快照上反复执行同一窗口必然取到同一批行。
      // 它**不**消除 offset 窗口本身的漂移：云端不是冻结快照，分页期间若有行
      // 被并发写入/删除，窗口会整体平移，短页推断照样可能漏行或重行 —— 这类
      // 漂移无法在 offset 分页内自证，所以下面用首个请求带回的 count(exact)
      // 做交叉校验兜底：分页结束后累计行数 != 总行数即整体抛错（fail-closed），
      // 绝不拿半份数据继续合并。
      const groups: any[] = [];
      let totalCount: number | null = null;
      for (;;) {
        const isFirstPage = groups.length === 0;
        // 首个请求带 { count: 'exact' }：supabase-js 会在**同一个请求**里经
        // PostgREST 的 Content-Range 带回总行数（零额外请求）。分页结束后拿它
        // 与累计行数交叉校验 —— 它**只能检测净行数变化**（下方注释与上面
        // 「它不消除 offset 漂移」那段说清了盲区）。
        const { data: page, error, count } = await supabase
          .from('tab_groups')
          .select(selectColumns, isFirstPage ? { count: 'exact' } : {})
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(groups.length, groups.length + DOWNLOAD_PAGE_SIZE - 1);

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

        if (isFirstPage) totalCount = count ?? null;
        groups.push(...(page ?? []));

        // 短页 = 已取完：最后一页不足 PAGE_SIZE（或恰好为 0）时结束。
        if (!page || page.length < DOWNLOAD_PAGE_SIZE) break;
      }

        // 分页截断交叉校验（1.22.15）：tiebreaker 只保证「同一冻结快照上窗口
        // 稳定」，挡不住分页期间云端行数变化或网关 db-max-rows 截断。两者都
        // 会表现为「累计行数 != 首个请求带回的总行数」——此时绝不能把半份数据
        // 交给合并（半份下载 = 半库覆盖，后续回写即真丢失），整体失败重试。
        //
        // ── 2026-10-10 注释如实化：它**只检测净行数变化**，不是漂移的全网兜底 ──
        // 上一版注释声称这条校验是「offset 窗口漂移唯一能从客户端观测到的信号」，
        // 排障的人会据此以为任何漂移都能被挡住。**实测证否**（6 组漂移模型跑完，
        // 见 tests/downloadPaginationStability.test.ts 的「净零漂移」describe）：
        // 分页期间**净行数不变**的漂移一律放行。最典型的是「另一台设备新建 k 个组 +
        // 删除 k 个组」—— 首请求 count(exact) 的总行数与末页累计恰好相等，恒通过。
        // 反向漂移（先删后建、等量）同理。
        //
        // 【净零漂移的真实后果：延迟一轮可见，不是丢数据】
        // offset 窗口在净零漂移下仍可能重叠/跳过，但被跳过的**存量行**不会被静默
        // 吞掉：mergeOpStamped 按 id 归并幂等，「这轮没看到」只意味着本轮合并保留
        // 本地旧副本，下一轮同步（窗口重建）仍会拉到那个 id；本地旧副本也不会立刻
        // 覆盖云端（下载路径末尾会检查 pending_upload 并重调度上传，
        // 见 syncEngine.downloadAndMerge 的 stillPending 分支）。净结果 =
        // 并发新建的行延迟一轮可见（≤60s）+ 一次额外全量，**没有数据丢失**。
        // 这正是这条校验值得留着的理由：它真正拦住的是「网关静默截断」与「净行数
        // 变化了的漂移」这两个高危形态，而不是所有漂移。
        if (totalCount !== null && groups.length !== totalCount) {
          throw new Error(
            `[download] 分页结果不完整：累计 ${groups.length} 行 != 云端总行数 ${totalCount}，` +
              `分页期间云端行数发生变化或响应被网关截断。已中止本次下载（fail-closed）。`
          );
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
      // ── 2026-10-20 D-6：读不出来的那几组必须**被说出来** ─────────────────
      //
      // 修复前「读不出来」只体现在两处：continue（不进结果）与一条 console 日志。
      // 于是调用方看到的是一个「少了几组」的数组，**无法区分**：
      //   · 云端本来就只有这几组；
      //   · 云端还有几组，但这一轮读不出来（内容坏了 / 还原率不达标 / 回填被截断）。
      //
      // 覆盖下载（forceRemote）的语义是「云端完全镜像本地」：本地被整体替换。
      // 读不出来的那组不在结果里 ⇒ 它也不在合并结果里 ⇒ 本机那份**被物理清除**，
      // 而云端那一行原封保留 —— 云端的数据被用户自己的下载吃掉了，UI 还报成功。
      //
      // 现在把它们的 id 如实带出去（`skipped`），让上层据此决定：
      // 合并模式保留本地那份（现状，本来就是对的），覆盖模式**整体中止**。
      // 云端行本身**原封保留**（不写不删）—— 这不是丢数据，是「这一轮拿不到」。
      const skipped: DownloadSkippedGroup[] = [];
      /** 登记一个「读不出来」的组（同一 id 只登记一次，保留最先出现的原因）。 */
      const noteSkipped = (id: unknown, reason: DownloadSkipReason): void => {
        const key = String(id);
        if (skipped.some(s => s.id === key)) return;
        skipped.push({ id: key, reason });
      };

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
          noteSkipped(groupAny.id, 'unreadable_shape');
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
          noteSkipped(groupAny.id, 'restore_ratio');
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
          // D-6：这一组同样「读不出来」—— 必须让上层知道它存在过。
          noteSkipped((group as any)?.id, 'processing_error');
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
            // { count: 'exact' } 同样在这里拿总行数：网关 db-max-rows（默认
            // 1000）会静默截断这个响应 —— 拿**截断后**的 tabs.length 当分母，
            // 还原率恒为 1.0，判据被架空，截断组会被接受并回写云端。用云端
            // 自报的总行数交叉校验，截断的组并入 truncatedByTabsTable 整个拿掉
            // （与上面的「截断的组整组跳过」同一策略）。
            const { data: tabs, error: tabError, count: tabsCount } = await supabase
              .from('tabs')
              .select('*', { count: 'exact' })
              .eq('group_id', group.id as string);

            if (!tabError && tabs && tabs.length > 0) {
              if (tabsCount !== null && tabs.length !== tabsCount) {
                logError(
                  `标签组 ${group.id} 的 tabs 表回填被截断：取回 ${tabs.length} 行 != 云端总行数 ${tabsCount}` +
                    `（疑似网关 db-max-rows 截断）。已跳过该组以保护云端数据不被截断回写`
                );
                truncatedByTabsTable.add(group.id);
                noteSkipped(group.id, 'tabs_table_truncated');
                continue;
              }
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
              // 分母用云端自报的真实总行数（tabsCount），不是被截断后的
              // tabs.length —— 否则截断会把比值抬高到 1.0，判据形同虚设。
              const totalRows = tabsCount ?? tabs.length;
              if (!isRestoreRateAcceptable(safeTabs.length, totalRows)) {
                logError(
                  `标签组 ${group.id} 从 tabs 表回填时 ${totalRows} 行有 ${totalRows - safeTabs.length} 行无法还原` +
                    `（URL 未通过安全校验），还原率 ${(safeTabs.length / totalRows).toFixed(2)} ` +
                    `低于阈值 ${MIN_RESTORABLE_TAB_RATIO}，已跳过该组以保护云端数据不被截断回写`
                );
                truncatedByTabsTable.add(group.id);
                noteSkipped(group.id, 'tabs_table_ratio');
                continue;
              }
              group.tabs = safeTabs;
            }
          } catch (e) {
            logWarn(`从 tabs 表获取标签失败，忽略错误:`, e);
            // D-6：回填失败 = 这一组这一轮拿不到 ⇒ 如实登记。
            // 注意这里**不能**把它当「真的空组」放行：空组会被下游硬删并登记 purge。
            noteSkipped(group.id, 'tabs_table_ratio');
          }
        }
      }

      const downloaded = truncatedByTabsTable.size > 0
        ? tabGroups.filter(g => !truncatedByTabsTable.has(g.id))
        : tabGroups;
      // ── D-6：把「读不出来的那几组」记在本轮上，供 downloadSkippedGroups 取 ──
      //
      // 为什么单独一个方法而不是把返回值改成 { groups, skipped }：
      // downloadTabGroups() 是被大量既有代码与测试当「数组」用的（15 处调用点），
      // 改它的返回形状是一次纯机械的大面积改动，而**语义增量只有一行清单**。
      // 更重要的是：把两者合成一次返回，会让「读到的」与「读不出来的」**必须
      // 同轮**——那是好事，但它要求每一个调用点都改成解包对象。
      //
      // 现在这个设计反而更强：**同轮**由实现保证（见 download.ts 的实现注释），
      // 而既有调用点一行都不用改。
      lastDownloadSkipped = skipped;
      return downloaded;
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
      //
      // 2026-10-20 审计 A-9：已退役的设置列（group_name_template /
      // allow_duplicate_tabs / delete_strategy / sync_strategy / reorder_mode）
      // 从映射表里移除 —— 它们没有任何读取方，映射回来只是让「已下线的东西」
      // 重新出现在设置对象里。逐条删除理由见 `src/types/tab.ts`。
      const fieldMapping: Record<string, string> = {
        'show_favicons': 'showFavicons',
        'show_tab_count': 'showTabCount',
        'confirm_before_delete': 'confirmBeforeDelete',
        // 2026-10-11（1.23.0 自动同步档位）：云端列尚不存在时整行映射不受影响 ——
        // 未知列只是不会出现在 data 里，对应设置走 DEFAULT 合并（见 getSettings）。
        // 上传侧有 42703 降级（**任意**缺列都剔掉该列重试，不只 collect_pinned_tabs
        // 一列 —— 见 utils/supabase/missingColumn.ts），所以迁移前后都不阻塞同步。
        'sync_interval_minutes': 'syncIntervalMinutes',
        'sync_enabled': 'syncEnabled',
        'layout_mode': 'layoutMode',
        'show_notifications': 'showNotifications',
        'theme_mode': 'themeMode',
        'theme_style': 'themeStyle',
        'collect_pinned_tabs': 'collectPinnedTabs',
        // 向后兼容性：如果云端还有旧的字段，也要处理
        'use_double_column_layout': 'useDoubleColumnLayout'
      };

      // 已退役的列：数据库里可能还留着（客户端已经不再写它们）。
      // 这些列是**已知**的，不是「未知字段」—— 所以静默跳过，
      // 不打 warning（否则每次下载都刷一堆「跳过未知的数据库字段」噪声，
      // 真正的未知字段会被淹没在里面）。
      //
      // 名单来自 `types/tab.ts` 的 RETIRED_SETTING_COLUMNS —— 与上传侧的
      // 23502 降级表同源。原先这里手抄一份列名、upload.ts 又手抄一份，
      // 两份之间没有编译期关联：改一处忘另一处 ⇒ 要么把一个**还活着的**列
      // 当成退役列静默跳过（设置悄悄丢一项，用户毫不知情）。
      const retiredColumns = RETIRED_SETTING_COLUMNS;

      const convertedSettings: Record<string, any> = {};
      for (const [key, value] of Object.entries(data)) {
        // 跳过非设置字段
        if (['user_id', 'device_id', 'last_sync'].includes(key)) {
          continue;
        }

        // 使用映射表转换字段名
        if (fieldMapping[key]) {
          convertedSettings[fieldMapping[key]] = value;
        } else if (retiredColumns.has(key)) {
          // 已退役的列：静默跳过
        } else {
          logWarn(`跳过未知的数据库字段: ${key}`);
        }
      }

      return convertedSettings;
    }

    return data;
  }
};
