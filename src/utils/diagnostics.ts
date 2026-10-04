/**
 * 诊断信息导出（工作包 B1）——本项目「反馈回路」的起点。
 *
 * 用户在反馈问题或换设备时，一键导出一份环境与行为快照，贴到 GitHub issue 上。
 * 这份文件会流向公开的 issue 附件，所以它的默认形态必须是**脱敏**的：
 * 里面只有规模、分布与环境，用户看了不能从任何一行反推出「他在访问什么」。
 *
 * 【为什么是白名单式脱敏，而不是黑名单式】
 * 黑名单式的做法是「把已知的敏感字段（url/title/name/...）列出来不许输出」，
 * 剩下的照发。它在下一次有人往 TabGroup 或 JournalEntry 上加一个字段
 * （比如 `group.memo`、`tab.snippet`）的那天就开始漏：新字段默认在允许集里，
 * 而漏出去的是浏览历史。白名单式反过来——输出结构由本文件的类型与
 * `buildDiagnosticsReport` 的字面量逐字段决定，采集层新加什么字段都与输出无关；
 * 想要输出新东西必须在这里显式加一行，代码评审能看见。
 * 同样的道理适用于事件名与 journal op 名：它们不是「校验后透传」，
 * 而是从代码里的封闭词表里取（见 PRODUCT_EVENT_NAMES / JOURNAL_OP_TYPES），
 * 因此输出里的动态键不可能来自存储内容。
 *
 * 【为什么分「采集」与「序列化」两层】
 * `readDiagnosticsSources` 只做 IO，拿回原始结构（里面确实有 URL、标题、会话名、
 * 设备号、payload——脱敏不在这一层做，这样「脱敏有没有生效」是一个可以单测的
 * 纯函数问题，而不是一个散落在 IO 里的副作用）。`buildDiagnosticsReport` 是纯函数：
 * 原始结构进、报告出，中间不碰任何 IO，**给定同样的输入与同一个 now 必然产出
 * 逐字节相同的 JSON**。用户复现问题时可以把两次导出直接 diff。
 *
 * 【journal 里没有「错误级别」这件事】
 * 原始需求假设 JournalEntry 带 message、可以筛出错误级别条目。实际读
 * src/utils/journal.ts:12-20 之后确认：JournalEntry 只有
 * { d(设备号), s(seq), ts, type, groupId, tabId, payload }，
 * **没有 message，也没有 level/severity**。journal 记的是语义命令（MutationOp），
 * 本身不存在「错误条目」这一说。所以本文件不带 message、也不带 groupId/tabId/d/payload，
 * 只按 `type` 聚合计数——`type` 是 src/core/mutationProtocol.ts 里 10 个字面量的
 * 封闭联合，代码常量，不是用户数据。若将来 journal 真的开始记 message，
 * message 里极可能混着 URL 与会话名（renameGroup 的 payload 就是会话名，
 * 见 tests/journal.test.ts:91），届时必须先分类再决定带不带，不许直接透传。
 *
 * 【最近错误计数：拿不到】
 * log.ts 只把日志打到 console，errorHandler 只做 console 输出，本地没有任何
 * 持久化错误日志。凭空造一个「最近错误数」等于编数据，所以输出里没有这一项。
 *
 * 【影子/门禁数据：本文件里最需要小心的一块】
 * v3 起输出 gate 段（V3 门禁判定）与 shadow 段（影子写入结果分布），
 * 来源是 y_audit_log / y_audit_daily / y_shadow_log。这三个键比 journal 危险得多：
 *   - AuditMismatch.ySide / localSide 装的是**真实字段值**——url 与 title 就是
 *     用户的浏览历史，name 是会话名；而 mismatch 恰恰是「两边对不上」的记录，
 *     越有问题越会出现在这里。
 *   - AuditLogEntry.sampleKey 是 `${userId}:${seq}`，直接带用户 id。
 *   - ShadowLogEntry.stamp.d 是设备号，outcome.error 是异常 message
 *     （message 里可能嵌着 URL）。
 * 所以这三个键**一条原始记录都不进输出**：审计日志只按 scope/field 两张封闭词表
 * 计数（field 只说「哪个字段对不上」，不说值），影子日志只按 outcome 种类与
 * op 名计数，聚合上限全都是数字。门禁判定（gate 段）读的是 y_audit_daily，
 * 那份本来就是纯数字（见 core/yGate.ts）。判定结果刻意是四态而非布尔：
 * 「没数据」不允许被读成「通过」。
 */

import { storage } from '@/utils/storage';
import { kvGet } from '@/storage/storageAdapter';
import { logWarn } from '@/utils/log';
import { getRuntimeVersion } from '@/utils/runtimeInfo';
import { formatExportStamp } from '@/utils/exportStamp';
import type { TabGroup, UserSettings } from '@/types/tab';
import type { JournalEntry } from '@/utils/journal';
import type { ProductEventName } from '@/utils/productEvents';
import type { MutationOp } from '@/shared/mutationProtocol';
import type { PerfSpan, SpanStep } from '@/utils/perfTrace';
import { PERF_SPAN_NAMES, SPAN_STEPS, perfTrace } from '@/utils/perfTrace';
import {
  evaluateShadowGate,
  gateVerdictLabel,
  isMismatchField,
  isMismatchScope,
  isShadowOutcomeKind,
} from '@/core/yGate';
import type {
  MismatchField,
  MismatchScope,
  ShadowGateVerdict,
  ShadowOutcomeKind,
} from '@/core/yGate';
import { Y_AUDIT_DAILY_KEY, Y_AUDIT_LOG_KEY, SHADOW_LOG_KEY } from '@/core/yShadowConfig';

/** span 名 / step 名的封闭词表集合（输出键只可能来自这里，理由同 PRODUCT_EVENT_NAMES）。 */
const PERF_SPAN_NAME_SET = new Set<string>(PERF_SPAN_NAMES);
const SPAN_STEP_SET = new Set<string>(SPAN_STEPS);

/** 诊断报告的 schema 标识。改动输出结构时同时 +1，老报告仍可被识别。 */
export const DIAGNOSTICS_SCHEMA = 'tapstack-diagnostics' as const;
// v2：新增 perf 段（性能 span 归因）。老报告仍可被 schemaVersion 识别。
// v3：新增 gate 段（V3 门禁判定）与 shadow 段（影子写入结果分布），
//     并新增 unavailable 取值 'shadowAudit'。
export const DIAGNOSTICS_SCHEMA_VERSION = 3;

/** 功能事件统计窗口（天）。 */
export const PRODUCT_EVENT_WINDOW_DAYS = 30;

// ── 封闭词表（输出的动态键只可能来自这里）────────────────────────────────

/**
 * 事件名白名单。
 *
 * 写成 `Record<ProductEventName, true>` 而不是 `ProductEventName[]`：
 * 联合类型新增一个字面量而这里漏了，tsc 直接报「缺少属性」（漏写/多写都红），
 * 而数组版本只会在运行时静默少统计一个事件。
 */
const PRODUCT_EVENT_NAMES: Record<ProductEventName, true> = {
  onboarding_completed: true,
  onboarding_skipped: true,
  session_saved: true,
  session_renamed: true,
  session_restored: true,
  session_restored_again: true,
  search_performed: true,
  search_filtered: true,
  session_favorited: true,
  session_note_saved: true,
  sync_upload_started: true,
  sync_upload_completed: true,
  sync_download_started: true,
  sync_download_completed: true,
  onetab_import_completed: true,
};

/**
 * journal op 名白名单，来源 src/core/mutationProtocol.ts 的 MutationOp['op']。
 * 漏写/多写同样由 tsc 拦下。
 */
const JOURNAL_OP_TYPES: Record<MutationOp['op'], true> = {
  saveGroup: true,
  removeTab: true,
  deleteGroup: true,
  deleteAllGroups: true,
  importGroups: true,
  renameGroup: true,
  toggleGroupLock: true,
  updateGroupFields: true,
  moveTab: true,
  cleanDuplicates: true,
};

/**
 * 同步策略白名单。与上面两张表同一个理由：这个值原样来自 storage，
 * 直接透传等于让存储内容决定输出内容。词表外一律记成 null（未知），不外带。
 */
const SYNC_STRATEGIES: Record<UserSettings['syncStrategy'], true> = {
  newest: true,
  local: true,
  remote: true,
  ask: true,
};

/** 标签数分布的分桶。上界闭区间，'21-100' 收了 100，'>100' 从 101 起，两桶不重叠。 */
export const TAB_COUNT_BUCKETS = ['0', '1-5', '6-20', '21-100', '>100'] as const;
export type TabCountBucket = (typeof TAB_COUNT_BUCKETS)[number];

/** 读失败的源名（封闭词表，不含任何来自存储的内容）。 */
export type UnavailableSource = 'groups' | 'settings' | 'pendingDeleteIds' | 'shadowAudit';

// ── 采集层：原始结构（含敏感数据，脱敏不在这里做）──────────────────────────

export interface DiagnosticsEnvironment {
  extensionVersion: string;
  userAgent: string;
  platform: string;
  language: string;
}

export interface DiagnosticsSources {
  /** 本地会话原始数据。null = 读取失败（不是「没有会话」）。 */
  groups: TabGroup[] | null;
  /** null = 读取失败。刻意不用 getSettingsForLocalUse 的降级默认值：把读失败
   *  报成 syncEnabled:false 是在编数据。 */
  settings: UserSettings | null;
  /** 原始事件（带 payload）。序列化时只取 name，payload 一律不看。 */
  productEvents: Array<Record<string, unknown>>;
  /** 原始 journal 条目（带 d/groupId/tabId/payload）。序列化时只取 type。 */
  journal: JournalEntry[];
  isAuthenticated: boolean;
  lastSyncTime: string | null;
  lastSyncedSeq: number;
  /** 待广播删除队列长度。null = 读取失败。 */
  pendingDeleteCount: number | null;
  pendingUpload: boolean;
  /**
   * 性能 span 原始记录（见 @/utils/perfTrace）。
   *
   * 采集层不做形状校验：脱敏与词表过滤是 buildPerfSummary 的职责（纯函数，
   * 可单测），这样「有没有漏出动态字符串」是一个能被测试钉住的问题。
   *
   * 【为什么它不在 unavailable 里】readPerfSpans 内部已把读失败降级成 []，
   * 本层拿不到「读失败」这个事实——与 productEvents / journal 同一处境
   * （见 readDiagnosticsSources 里的注释）。宣称一条永远观测不到的失败，
   * 等于给排障的人一个不会亮的指示灯；诚实的做法是把它归入「降级为空」，
   * 并让 spanCount=0 自己说明「没有观测数据」。
   */
  perfSpans: PerfSpan[];
  /**
   * 影子/对账三个 KV 键的**原始内容**，刻意声明为 unknown 而不是已解析类型。
   *
   * 类型断言的诱惑在这里必须挡住：断言成 AuditLogEntry[] 之后，序列化层就会
   * 顺手 `entry.result.mismatches[0].ySide` —— 那个字段就是用户的 URL。
   * 声明成 unknown 意味着任何读取都必须先过下面的词表校验，写错会在 tsc 阶段红。
   *
   * null = 读取失败（进 unavailable），与 groups/settings 同口径：这层能观测到失败，
   * 就不该把它压成「没有数据」——没有数据会被读成「影子没跑」，是相反的结论。
   */
  shadowAudit: {
    auditLog: unknown;
    auditDaily: unknown;
    shadowLog: unknown;
  } | null;
  environment: DiagnosticsEnvironment;
}

function readEnvironment(): DiagnosticsEnvironment {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    extensionVersion: getRuntimeVersion(),
    userAgent: nav?.userAgent ?? '',
    platform: nav?.platform ?? '',
    language: nav?.language ?? '',
  };
}

/** 等 SW 落盘 span 的上限。SW 可能已被回收，绝不能让诊断导出挂在这里。 */
const PERF_FLUSH_TIMEOUT_MS = 800;

/**
 * 请求 SW 把它内存缓冲里的性能 span 落盘。
 *
 * 【为什么必须显式请求】慢操作的计时记在 SW 进程，落盘有节流窗口（5s）；
 * 诊断导出跑在 UI 进程，只 flush 得到自己的缓冲。用户复现完立刻点导出时，
 * 要看的恰恰是刚刚那几秒——不先请 SW 落盘就会整段丢失，导出一份「什么都没测到」
 * 的报告，比没有报告更误导。
 *
 * 【为什么带超时】SW 可能已被 MV3 回收；sendMessage 会唤醒它，但唤醒 + 起 IndexedDB
 * 连接可能很慢，也可能根本没有 SW（网页版）。诊断导出是用户主动求助的动作，
 * 卡住不动比少几段观测数据糟糕得多，所以超时即放弃、按已落盘的内容出报告。
 */
async function requestSwPerfFlush(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      chrome.runtime.sendMessage({ type: 'PERF_FLUSH' }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('PERF_FLUSH timeout')), PERF_FLUSH_TIMEOUT_MS);
      }),
    ]);
  } catch {
    /* best-effort：拿不到就用已落盘的部分，不影响导出 */
  } finally {
    // 清掉定时器：不清的话这条 800ms 的 timeout 会一直挂着
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * 读取诊断所需的全部本地数据。只做 IO，不做脱敏，不做聚合。
 *
 * 可能失败的源各自兜住并记成 null：`getGroups` / `getSettings` 读失败时
 * 报告里对应字段是 null 并进 `unavailable`，而不是 0——把「读不到」写成
 * 「用户没有会话」会让排障的人往错误方向查。
 *
 * @param isAuthenticated 由 UI 从登录态传入；**只取布尔值**，不传 user 对象
 *        （user.email / user.id 一律不进诊断文件）。
 */
export async function readDiagnosticsSources(
  isAuthenticated = false
): Promise<DiagnosticsSources> {
  const [groups, settings, pendingDeleteCount] = await Promise.all([
    storage.getGroups().catch(() => null),
    storage.getSettings().catch(() => null),
    storage.getPendingDeleteIds().then(ids => ids.length).catch(() => null),
  ]);

  // 这四个 getter 自身已把读失败降级成空值/0/null（见 storage.ts 的实现），
  // 本层无法区分「本来就没有」与「读失败」，要区分得改 storage 的读取契约。
  const [productEvents, journal, lastSyncTime, lastSyncedSeq, pendingUpload] = await Promise.all([
    storage.getProductEvents(),
    storage.getJournal() as Promise<JournalEntry[]>,
    storage.getLastSyncTime(),
    storage.getLastSyncedSeq(),
    storage.getPendingUpload(),
  ]);

  // 顺序有依赖：先让 SW 落盘，再读共享键（read() 同时会 flush 本进程缓冲）。
  // 读失败降级成空数组（readPerfSpans 内部已兜住），因此不进 unavailable，
  // 与 productEvents / journal 同一口径。
  await requestSwPerfFlush();
  const perfSpans = await perfTrace().read();

  // 影子/对账三键。键不存在（kvGet → null）是正常状态：影子开关关掉、或还没跑过
  // 任何一条 mutation 时它们本来就不存在。但**读取抛错**是另一回事，两者对 V3 决策
  // 的含义相反（「影子没跑」vs「影子跑了但诊断读不到」），所以整体一个 try，
  // 抛错记成 null → 进 unavailable。
  let shadowAudit: DiagnosticsSources['shadowAudit'] = null;
  try {
    const [auditLog, auditDaily, shadowLog] = await Promise.all([
      kvGet(Y_AUDIT_LOG_KEY),
      kvGet(Y_AUDIT_DAILY_KEY),
      kvGet(SHADOW_LOG_KEY),
    ]);
    shadowAudit = { auditLog, auditDaily, shadowLog };
  } catch (error) {
    logWarn('[diagnostics] 影子/对账键读取失败（记入 unavailable）:', error);
    shadowAudit = null;
  }

  return {
    groups,
    settings,
    productEvents: Array.isArray(productEvents) ? productEvents : [],
    journal: Array.isArray(journal) ? journal : [],
    isAuthenticated,
    lastSyncTime,
    lastSyncedSeq,
    pendingDeleteCount,
    pendingUpload,
    perfSpans: Array.isArray(perfSpans) ? perfSpans : [],
    shadowAudit,
    environment: readEnvironment(),
  };
}

// ── 序列化层：白名单输出 ───────────────────────────────────────────────

export interface DiagnosticsReport {
  schema: typeof DIAGNOSTICS_SCHEMA;
  schemaVersion: number;
  /** ISO 时间。来源是调用方传入的 now（纯函数不许自己取当前时间）。 */
  generatedAt: string;
  environment: {
    extensionVersion: string;
    userAgent: string;
    platform: string;
    language: string;
  };
  data: {
    sessionCount: number | null;
    tabCount: number | null;
    /** 各桶的会话数；所有桶相加 === sessionCount。 */
    tabCountHistogram: Record<TabCountBucket, number> | null;
    favoriteSessionCount: number | null;
    lockedSessionCount: number | null;
  };
  productEvents: {
    windowDays: number;
    totalCount: number;
    /** 只出现事件名与次数，**没有 payload**。按名字排序保证输出稳定可比对。 */
    byName: Array<{ name: ProductEventName; count: number }>;
    /** 词表外的事件名条数：丢弃但记账，不静默。 */
    droppedUnknownNameCount: number;
    /** createdAt 缺失/不可解析、被窗口过滤掉的条数。 */
    outOfWindowCount: number;
  };
  journal: {
    entryCount: number;
    /** seq 大于 lastSyncedSeq 的条数（尚未被云端确认的本地操作数）。 */
    unconfirmedCount: number;
    /** 只出现 op 名与次数，**没有 deviceId / groupId / tabId / payload**。 */
    byType: Array<{ type: MutationOp['op']; count: number }>;
    droppedUnknownTypeCount: number;
  };
  sync: {
    authenticated: boolean;
    autoSyncEnabled: boolean | null;
    syncStrategy: string | null;
    /** 距上次同步的小时数（下取整）。从未同步过 = null。 */
    lastSyncAgeHours: number | null;
    pendingDeleteCount: number | null;
    pendingUpload: boolean;
  };
  /**
   * 性能归因：时间到底花在哪一段。
   *
   * 只输出**聚合数字**，不输出任何单条 span 的 ts/origin/id：
   * origin 是随机的上下文身份（无用户数据），但聚合后信息量足够定位，
   * 逐条罗列只会让诊断文件变大且更难读。
   */
  perf: {
    /** 参与统计的 span 条数（畸形条目不计入）。 */
    spanCount: number;
    /** 畸形/词表外条目数：丢弃但记账，不静默。 */
    malformedCount: number;
    /** 按 wait+run 降序的归因表（最慢的在最前）。 */
    byName: PerfSpanSummary[];
    /**
     * apply 段被钳到 0 的 span 名（非空 = 环形缓冲截断丢了部分 run 记录）。
     * 此时这些名字的 applyTotalMs 不可信，显式标出而不是让人误读成「纯计算不耗时」。
     */
    clampedApplyNames: string[];
  };
  /**
   * V3 门禁判定（docs/v2-plan.md 的 P1 验收：对账差异率 < 0.1% 持续 7 天）。
   *
   * 这是「V3 该不该开工」这个决策的唯一依据。**四态而非布尔**：
   * no_data / insufficient_coverage 都表示「还没测出来」，绝不能被读成「通过」。
   * 判定读 y_audit_daily（按天聚合），不是逐条 y_audit_log —— 后者只留 50 条，
   * 窗口比 7 天短，无法证明「持续」（见 core/yGate.ts）。
   */
  gate: ShadowGateVerdict;
  /** 影子写入结果分布（来源 y_shadow_log）。 */
  shadow: ShadowLogSummary;
  /**
   * 对账差异的形状分布（来源 y_audit_log）。**只有 scope/field 计数与条数**：
   * 一条差异里的 url/title/name 真实值与 sampleKey 一律不进输出。
   */
  audit: AuditLogSummary;
  /** 本次采集里读取失败的源名。 */
  unavailable: UnavailableSource[];
}

// ── 性能 span 聚合（诊断导出用）─────────────────────────────────────────

/**
 * 单个 span 名的耗时归因。
 *
 * 三个量的关系（这是整份聚合的意义所在）：
 *   感知耗时 ≈ waitMs + runMs
 *   runMs    ≈ applyTotalMs + Σ(在 run 窗口内的 stepsMs)
 * wait 大 → 头阻塞（在单写者队列里等别人的任务，典型是后台同步）；
 * run 大且 apply 占比高 → 纯计算/序列化；run 大且 write/read 占比高 → 全量 blob 搬运。
 * 三者的修法完全不同，所以必须分开输出，不能只给一个总耗时。
 */
export interface PerfSpanSummary {
  name: string;
  count: number;
  /** 入队到开始执行的累计等待（头阻塞）。 */
  waitTotalMs: number;
  waitMaxMs: number;
  /** 执行本身的累计耗时。 */
  runTotalMs: number;
  runMaxMs: number;
  /**
   * 纯计算段（apply）累计耗时 = runTotalMs − Σ各 step 累计。
   *
   * 【为什么是「总和相减」而不是「max 相减」】apply 没有 IO 可包，无法直接测。
   * 总和相减等于各次 apply 耗时之和，是精确的；max 相减会把不同次调用的极值
   * 混在一起（最慢那次的 run 未必包含最慢那次 read），得出的数字没有含义。
   */
  applyTotalMs: number;
  /** 各 IO 阶段累计耗时。键来自 SPAN_STEPS 封闭词表。 */
  stepsTotalMs: Partial<Record<SpanStep, number>>;
}

/**
 * span 数组 → 按 span 名聚合的归因表。**纯函数**（无 IO、不读全局时间）。
 *
 * @param spans 原始 span（可能有畸形条目，一律丢弃并计入 malformedCount）
 * @returns byName 按 waitTotalMs + runTotalMs 降序（最慢的排最前，用户一眼看到问题）
 */
export function buildPerfSummary(spans: unknown): {
  byName: PerfSpanSummary[];
  spanCount: number;
  malformedCount: number;
  /**
   * applyTotalMs 被钳到 0 的 span 名。
   *
   * 出现即说明「run 的总和 < 各在 run 窗口内 step 的总和」，只可能是环形缓冲截断
   * 丢掉了部分 run 记录（step 比 run 多，更容易被截）。此时 apply 不可信，
   * 因此**显式记账**而不是静默输出一个 0 —— 0 会被读成「纯计算不耗时」，
   * 那正是一个会误导优化的假信号。
   *
   * 注意：fire-and-forget 的 scheduleUpload 已被排除在推导之外（见 buildPerfSummary），
   * 所以这里出现名字就**真的**意味着丢了 run 记录，而不是一个可以忽略的正常现象。
   */
  clampedApplyNames: string[];
} {
  const list = Array.isArray(spans) ? spans : [];
  const byName = new Map<string, {
    count: number;
    waitTotalMs: number;
    waitMaxMs: number;
    runTotalMs: number;
    runMaxMs: number;
    stepsTotalMs: Map<SpanStep, number>;
  }>();
  let spanCount = 0;
  let malformedCount = 0;

  const ensure = (name: string) => {
    let e = byName.get(name);
    if (!e) {
      e = {
        count: 0,
        waitTotalMs: 0,
        waitMaxMs: 0,
        runTotalMs: 0,
        runMaxMs: 0,
        stepsTotalMs: new Map<SpanStep, number>(),
      };
      byName.set(name, e);
    }
    return e;
  };

  for (const raw of list) {
    const s = raw as Partial<PerfSpan> | null;
    // 畸形条目（非对象、缺字段、名字不在词表、耗时非法）一律丢弃并记账。
    // 名字必须过词表：这是流向公开 issue 的文件，不容许存储里的任意字符串成为输出键。
    if (!s || typeof s !== 'object') {
      malformedCount += 1;
      continue;
    }
    if (typeof s.name !== 'string' || !PERF_SPAN_NAME_SET.has(s.name)) {
      malformedCount += 1;
      continue;
    }
    if (typeof s.ms !== 'number' || !Number.isFinite(s.ms) || s.ms < 0) {
      malformedCount += 1;
      continue;
    }
    // 先判 phase 组合是否成立，再取聚合槽位：顺序反了会为畸形条目建出一个
    // count=0 的空记录混进输出，读报告的人会以为「这个命令跑过但没耗时」。
    const stepOk =
      s.phase === 'step' && typeof s.step === 'string' && SPAN_STEP_SET.has(s.step);
    if (s.phase !== 'wait' && s.phase !== 'run' && !stepOk) {
      malformedCount += 1;
      continue;
    }
    const e = ensure(s.name);
    if (s.phase === 'wait') {
      e.waitTotalMs += s.ms;
      e.waitMaxMs = Math.max(e.waitMaxMs, s.ms);
    } else if (s.phase === 'run') {
      e.runTotalMs += s.ms;
      e.runMaxMs = Math.max(e.runMaxMs, s.ms);
    } else {
      // step 名已在上面校验过合法
      e.stepsTotalMs.set(s.step as SpanStep, (e.stepsTotalMs.get(s.step as SpanStep) ?? 0) + s.ms);
    }
    // 只在成功归入某一段之后才计数：畸形组合不占 spanCount，
    // 否则「总数」与「各段之和」对不上，读报告的人会以为丢了数据。
    spanCount += 1;
    e.count += 1;
  }

  const clampedApplyNames: string[] = [];
  const out: PerfSpanSummary[] = [];
  for (const [name, e] of byName) {
    const stepsTotal = Object.fromEntries([...e.stepsTotalMs.entries()]) as Partial<
      Record<SpanStep, number>
    >;
    // 推导 apply 时**只减必然落在 run 窗口内**的 step。
    //
    // scheduleUpload 在删除类命令里是 await 的，但在 saveGroup / importGroups /
    // renameGroup / toggleGroupLock / updateGroupFields 五条路径上是 fire-and-forget
    //（见 mutationHandlers：`d.scheduleUpload(...)` 不带 await）。后者的 span 会在
    // run 段**结束之后**才落账，把它减掉就等于从 run 里扣一段根本不在其中的时间，
    // 得出负的 apply 并触发钳位 —— 报告里会出现「明明一切正常却报数据不可信」。
    //
    // 代价是这五条命令的 applyTotalMs 会把那次 pending_upload 写盘算进去（单次 KV 写，
    // 毫秒级）。宁可轻微高估 apply，也不产出假告警；scheduleUpload 的真实耗时
    // 仍单独列在 stepsTotalMs 里，需要时直接看那一栏。
    const stepsSum = [...e.stepsTotalMs.entries()]
      .filter(([step]) => step !== 'scheduleUpload')
      .reduce((a, [, ms]) => a + ms, 0);
    let applyTotalMs = round1(e.runTotalMs - stepsSum);
    if (applyTotalMs < 0) {
      // 见 clampedApplyNames 的说明：钳到 0 并记账，不静默输出假信号
      applyTotalMs = 0;
      clampedApplyNames.push(name);
    }
    out.push({
      name,
      count: e.count,
      waitTotalMs: round1(e.waitTotalMs),
      waitMaxMs: round1(e.waitMaxMs),
      runTotalMs: round1(e.runTotalMs),
      runMaxMs: round1(e.runMaxMs),
      applyTotalMs,
      stepsTotalMs: stepsTotal,
    });
  }
  // 最慢的排最前：wait + run 是用户感知耗时的主体
  out.sort((a, b) => b.waitTotalMs + b.runTotalMs - (a.waitTotalMs + a.runTotalMs));
  clampedApplyNames.sort();
  return { byName: out, spanCount, malformedCount, clampedApplyNames };
}

/** 保留 1 位小数（诊断输出稳定可比对，避免浮点噪声让两次导出 diff 不干净）。 */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ── 影子写入结果聚合（诊断导出用）───────────────────────────────────────

/**
 * 影子日志（y_shadow_log）的聚合。
 *
 * 【为什么不是逐条输出】ShadowLogEntry 带 stamp.d（设备号）、outcome.error
 * （异常 message，可能嵌 URL）、以及 op 的完整参数。这三样都不进输出：
 * 只留 outcome 种类与 op 名的计数，加几个数字。要看单条形状请本机读 KV。
 */
export interface ShadowLogSummary {
  /** 能解析出 outcome 种类的条数（主计数轴；byOutcome 求和 === 它）。 */
  entryCount: number;
  /** 无法解析的条数：丢弃但记账，不静默。 */
  malformedCount: number;
  byOutcome: Array<{ outcome: ShadowOutcomeKind; count: number }>;
  /**
   * 按 op 名计数。**求和可能小于 entryCount**：op 名要过封闭词表，
   * 词表外的条目计入 droppedUnknownOpCount 而不进这张表（差异由此字段解释）。
   */
  byOp: Array<{ op: MutationOp['op']; count: number }>;
  droppedUnknownOpCount: number;
  /** 成功写入 Y 的次数。 */
  okCount: number;
  /** Y update 增量字节累计/峰值：枷锁 #1 里「egress 爆炸」的直接观测值。 */
  totalUpdateBytes: number;
  maxUpdateBytes: number;
  /** 触发 compact 阈值的次数（>0 说明本地 update 日志已需要快照回填）。 */
  needsSnapshotCount: number;
  /** 样本时间跨度（小时）。远小于门禁窗口时，说明 FIFO 200 条覆盖得比想象的短。 */
  coverageHours: number | null;
  /** 最新样本距今小时数。null = 无可用时间戳。 */
  latestAgeHours: number | null;
}

function outcomeKindOf(outcome: unknown): ShadowOutcomeKind | null {
  if (!outcome || typeof outcome !== 'object') return null;
  const rec = outcome as { ok?: unknown; skipped?: unknown };
  if (rec.ok === true) return 'ok';
  if (rec.ok === false) return isShadowOutcomeKind(rec.skipped) ? rec.skipped : null;
  return null;
}

/**
 * 影子日志 → 聚合。**纯函数**（无 IO、时间由 now 传入）。
 *
 * @param raw y_shadow_log 原始内容（声明 unknown，必须先过词表）
 * @param nowMs 计算时间跨度用的当前毫秒（不自己取当前时间，保证可测且输出可比对）
 */
export function buildShadowSummary(raw: unknown, nowMs: number): ShadowLogSummary {
  const list = Array.isArray(raw) ? raw : [];
  const outcomeCounts = new Map<ShadowOutcomeKind, number>();
  const opCounts = new Map<MutationOp['op'], number>();
  let entryCount = 0;
  let malformedCount = 0;
  let droppedUnknownOpCount = 0;
  let okCount = 0;
  let totalUpdateBytes = 0;
  let maxUpdateBytes = 0;
  let needsSnapshotCount = 0;
  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = Number.NEGATIVE_INFINITY;

  for (const item of list) {
    const raw = item as { ts?: unknown; op?: unknown; outcome?: unknown } | null;
    if (!raw || typeof raw !== 'object') {
      malformedCount += 1;
      continue;
    }
    const kind = outcomeKindOf(raw.outcome);
    if (kind === null) {
      malformedCount += 1;
      continue;
    }
    entryCount += 1;
    outcomeCounts.set(kind, (outcomeCounts.get(kind) ?? 0) + 1);

    // op 名单独校验：词表外只记账，不影响本条的 outcome 计数（见 byOp 说明）
    if (isKnownJournalOpType(raw.op)) {
      opCounts.set(raw.op, (opCounts.get(raw.op) ?? 0) + 1);
    } else {
      droppedUnknownOpCount += 1;
    }

    if (kind === 'ok') {
      okCount += 1;
      const o = raw.outcome as { updateBytes?: unknown; needsSnapshot?: unknown };
      const bytes =
        typeof o.updateBytes === 'number' && Number.isFinite(o.updateBytes) && o.updateBytes >= 0
          ? o.updateBytes
          : 0;
      totalUpdateBytes += bytes;
      maxUpdateBytes = Math.max(maxUpdateBytes, bytes);
      if (o.needsSnapshot === true) needsSnapshotCount += 1;
    }

    const tsMs = parseTimestamp(raw.ts);
    if (tsMs !== null) {
      minTs = Math.min(minTs, tsMs);
      maxTs = Math.max(maxTs, tsMs);
    }
  }

  const hasTs = Number.isFinite(minTs) && Number.isFinite(maxTs);
  return {
    entryCount,
    malformedCount,
    // 按种类/名字排序，保证两次导出的 JSON 逐字节可比对
    byOutcome: [...outcomeCounts.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([outcome, count]) => ({ outcome, count })),
    byOp: [...opCounts.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([op, count]) => ({ op, count })),
    droppedUnknownOpCount,
    okCount,
    totalUpdateBytes,
    maxUpdateBytes,
    needsSnapshotCount,
    coverageHours: hasTs ? round1((maxTs - minTs) / (60 * 60 * 1000)) : null,
    latestAgeHours: hasTs ? round1(Math.max(0, (nowMs - maxTs) / (60 * 60 * 1000))) : null,
  };
}

// ── 对账差异聚合（诊断导出用）───────────────────────────────────────────

/**
 * 对账逐条日志（y_audit_log）的差异形状聚合。
 *
 * 【这一段的脱敏边界】一条 AuditMismatch 长这样：
 *   { scope:'tab', id:'g1:t7', field:'url', ySide:'https://…', localSide:'https://…' }
 * 只有 `scope` 与 `field` 是代码常量，`id` 是记录 id，`ySide`/`localSide` 是
 * **真实字段值**（url/title/name —— 用户的浏览历史）。所以这里只对前两者计数：
 * 「有多少条差异出在 url 字段上」是排障要的信息，「那些 url 是什么」不是。
 * sampleKey（含 userId）同样不读。
 */
export interface AuditLogSummary {
  /** 样本条数（能解析出 result 的）。 */
  entryCount: number;
  malformedCount: number;
  /** 有差异的样本数（result.match === false）。 */
  mismatchedSampleCount: number;
  byScope: Array<{ scope: MismatchScope; count: number }>;
  /**
   * 按差异字段名计数。求和 = 各样本 mismatches 之和，**但注意上游每条样本最多
   * 记 20 条差异**（yAudit.MAX_MISMATCHES_DEFAULT），所以这是「至少这么多」。
   */
  byField: Array<{ field: MismatchField; count: number }>;
  /** field/scope 不在封闭词表内的差异条数：丢弃但记账。 */
  droppedUnknownFieldCount: number;
  /** 逐条日志的时间跨度（小时）。用它判断 50 条 FIFO 实际覆盖多久。 */
  coverageHours: number | null;
  latestAgeHours: number | null;
}

export function buildAuditLogSummary(raw: unknown, nowMs: number): AuditLogSummary {
  const list = Array.isArray(raw) ? raw : [];
  const scopeCounts = new Map<MismatchScope, number>();
  const fieldCounts = new Map<MismatchField, number>();
  let entryCount = 0;
  let malformedCount = 0;
  let mismatchedSampleCount = 0;
  let droppedUnknownFieldCount = 0;
  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = Number.NEGATIVE_INFINITY;

  for (const item of list) {
    const raw = item as { ts?: unknown; result?: unknown } | null;
    if (!raw || typeof raw !== 'object') {
      malformedCount += 1;
      continue;
    }
    const result = raw.result as { match?: unknown; mismatches?: unknown } | null;
    if (!result || typeof result !== 'object') {
      malformedCount += 1;
      continue;
    }
    entryCount += 1;
    if (result.match === false) mismatchedSampleCount += 1;

    const mismatches = Array.isArray(result.mismatches) ? result.mismatches : [];
    for (const m of mismatches) {
      const item2 = m as { scope?: unknown; field?: unknown } | null;
      if (!item2 || typeof item2 !== 'object') {
        droppedUnknownFieldCount += 1;
        continue;
      }
      const scope = item2.scope;
      const field = item2.field;
      // 先取到局部变量再判定：类型守卫收窄的是被守卫的那个**局部 const**，
      // 直接写 `isMismatchScope(item2.scope)` 再在 if 里用 item2.scope，
      // tsc 不会把收窄结果沿可选属性路径传下去（会报 unknown 不能作 Map 键）。
      const scopeOk = isMismatchScope(scope);
      const fieldOk = isMismatchField(field);
      if (scopeOk) scopeCounts.set(scope, (scopeCounts.get(scope) ?? 0) + 1);
      if (fieldOk) fieldCounts.set(field, (fieldCounts.get(field) ?? 0) + 1);
      if (!scopeOk || !fieldOk) droppedUnknownFieldCount += 1;
    }

    const tsMs = parseTimestamp(raw.ts);
    if (tsMs !== null) {
      minTs = Math.min(minTs, tsMs);
      maxTs = Math.max(maxTs, tsMs);
    }
  }

  const hasTs = Number.isFinite(minTs) && Number.isFinite(maxTs);
  return {
    entryCount,
    malformedCount,
    mismatchedSampleCount,
    byScope: [...scopeCounts.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([scope, count]) => ({ scope, count })),
    byField: [...fieldCounts.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([field, count]) => ({ field, count })),
    droppedUnknownFieldCount,
    coverageHours: hasTs ? round1((maxTs - minTs) / (60 * 60 * 1000)) : null,
    latestAgeHours: hasTs ? round1(Math.max(0, (nowMs - maxTs) / (60 * 60 * 1000))) : null,
  };
}

export function bucketForTabCount(count: number): TabCountBucket {
  if (!(count > 0)) return '0';
  if (count <= 5) return '1-5';
  if (count <= 20) return '6-20';
  if (count <= 100) return '21-100';
  return '>100';
}

function buildTabCountHistogram(counts: readonly number[]): Record<TabCountBucket, number> {
  const histogram = Object.fromEntries(TAB_COUNT_BUCKETS.map(b => [b, 0])) as Record<
    TabCountBucket,
    number
  >;
  for (const count of counts) histogram[bucketForTabCount(count)] += 1;
  return histogram;
}

function isKnownProductEventName(name: unknown): name is ProductEventName {
  return typeof name === 'string' && name in PRODUCT_EVENT_NAMES;
}

function isKnownJournalOpType(type: unknown): type is MutationOp['op'] {
  return typeof type === 'string' && type in JOURNAL_OP_TYPES;
}

function isKnownSyncStrategy(value: unknown): value is UserSettings['syncStrategy'] {
  return typeof value === 'string' && value in SYNC_STRATEGIES;
}

/** ISO 时间 → 毫秒；不可解析返回 null（不返回 NaN，避免污染比较）。 */
function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * 原始结构 → 诊断报告。**纯函数**：无 IO、不读全局时间、输出逐字段白名单。
 * 同样的 sources + 同样的 now ⇒ 逐字节相同的 JSON（便于用户复现时 diff）。
 */
export function buildDiagnosticsReport(
  sources: DiagnosticsSources,
  now: Date
): DiagnosticsReport {
  const nowMs = now.getTime();

  // 数据规模：只数个数，不看任何一个 tab 的 url/title，也不看 group 的 name/notes/id。
  const groups = sources.groups;
  const tabCounts = groups ? groups.map(g => (Array.isArray(g?.tabs) ? g.tabs.length : 0)) : null;

  // 事件：只取 name 与 createdAt 两个字段，payload 不读、不带。
  const windowStartMs = nowMs - PRODUCT_EVENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const eventCounts = new Map<ProductEventName, number>();
  let eventTotal = 0;
  let droppedUnknownNameCount = 0;
  let outOfWindowCount = 0;
  for (const event of Array.isArray(sources.productEvents) ? sources.productEvents : []) {
    const raw = event as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object') {
      droppedUnknownNameCount += 1;
      continue;
    }
    if (!isKnownProductEventName(raw.name)) {
      // 词表外的名字直接丢弃而不是原样透传：透传等于把存储里的任意字符串
      // 当成输出键写进会流向公开 issue 的文件，没有理由信任它。
      droppedUnknownNameCount += 1;
      continue;
    }
    const createdAtMs = parseTimestamp(raw.createdAt);
    if (createdAtMs === null || createdAtMs < windowStartMs || createdAtMs > nowMs) {
      outOfWindowCount += 1;
      continue;
    }
    eventTotal += 1;
    eventCounts.set(raw.name, (eventCounts.get(raw.name) ?? 0) + 1);
  }

  // journal：只取 type 与 seq，d / groupId / tabId / payload / ts 一律不读。
  const journalEntries = Array.isArray(sources.journal) ? sources.journal : [];
  const opCounts = new Map<MutationOp['op'], number>();
  let droppedUnknownTypeCount = 0;
  let unconfirmedCount = 0;
  for (const entry of journalEntries) {
    const raw = entry as Partial<JournalEntry> | null;
    if (!raw || typeof raw !== 'object' || !isKnownJournalOpType(raw.type)) {
      droppedUnknownTypeCount += 1;
      continue;
    }
    opCounts.set(raw.type, (opCounts.get(raw.type) ?? 0) + 1);
    if (typeof raw.s === 'number' && raw.s > sources.lastSyncedSeq) unconfirmedCount += 1;
  }

  const lastSyncMs = parseTimestamp(sources.lastSyncTime);
  const perf = buildPerfSummary(sources.perfSpans);
  // 影子/对账：读失败（null）时按空处理，但**记入 unavailable**——
  // 空日志与读不到日志在决策上是相反的证据，不能长得一样。
  const shadowAudit = sources.shadowAudit;
  const shadow = buildShadowSummary(shadowAudit?.shadowLog, nowMs);
  const audit = buildAuditLogSummary(shadowAudit?.auditLog, nowMs);
  const gate = evaluateShadowGate(shadowAudit?.auditDaily, now);
  const unavailable: UnavailableSource[] = [];
  if (groups === null) unavailable.push('groups');
  if (sources.settings === null) unavailable.push('settings');
  if (sources.pendingDeleteCount === null) unavailable.push('pendingDeleteIds');
  // falsy 而不是 === null：undefined（老调用方构造的 sources、测试里的偏量对象）
  // 同样意味着「这次没读到」，不该被当成「读到了且是空的」。
  if (!shadowAudit) unavailable.push('shadowAudit');

  return {
    schema: DIAGNOSTICS_SCHEMA,
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    environment: {
      extensionVersion: sources.environment.extensionVersion,
      userAgent: sources.environment.userAgent,
      platform: sources.environment.platform,
      language: sources.environment.language,
    },
    data: {
      sessionCount: groups ? groups.length : null,
      tabCount: tabCounts ? tabCounts.reduce((sum, n) => sum + n, 0) : null,
      tabCountHistogram: tabCounts ? buildTabCountHistogram(tabCounts) : null,
      favoriteSessionCount: groups
        ? groups.filter(g => g?.isFavorite === true).length
        : null,
      lockedSessionCount: groups ? groups.filter(g => g?.isLocked === true).length : null,
    },
    productEvents: {
      windowDays: PRODUCT_EVENT_WINDOW_DAYS,
      totalCount: eventTotal,
      byName: [...eventCounts.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, count]) => ({ name, count })),
      droppedUnknownNameCount,
      outOfWindowCount,
    },
    journal: {
      entryCount: journalEntries.length,
      unconfirmedCount,
      byType: [...opCounts.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([type, count]) => ({ type, count })),
      droppedUnknownTypeCount,
    },
    sync: {
      authenticated: sources.isAuthenticated === true,
      autoSyncEnabled: sources.settings ? sources.settings.syncEnabled === true : null,
      syncStrategy:
        sources.settings && isKnownSyncStrategy(sources.settings.syncStrategy)
          ? sources.settings.syncStrategy
          : null,
      lastSyncAgeHours:
        lastSyncMs === null ? null : Math.max(0, Math.floor((nowMs - lastSyncMs) / (60 * 60 * 1000))),
      pendingDeleteCount: sources.pendingDeleteCount,
      pendingUpload: sources.pendingUpload === true,
    },
    perf: {
      spanCount: perf.spanCount,
      malformedCount: perf.malformedCount,
      byName: perf.byName,
      clampedApplyNames: perf.clampedApplyNames,
    },
    gate,
    shadow,
    audit,
    unavailable,
  };
}

/** 采集 + 序列化一步到位（UI 用这个）。now 可注入，便于测试。 */
export async function collectDiagnostics(options?: {
  isAuthenticated?: boolean;
  now?: Date;
}): Promise<DiagnosticsReport> {
  const sources = await readDiagnosticsSources(options?.isAuthenticated === true);
  return buildDiagnosticsReport(sources, options?.now ?? new Date());
}

/** 序列化成最终文件内容（缩进 2 空格，与既有备份导出一致）。 */
export function serializeDiagnosticsReport(report: DiagnosticsReport): string {
  return JSON.stringify(report, null, 2);
}

/**
 * 导出文件名：`tapstack-diagnostics-v<版本>-<日期>.json`。
 * 日期戳复用 formatExportStamp（导出文件名日期戳单源），
 * **必须传入载荷自己用的那个 Date**，跨零点时文件名与 generatedAt 才对得上。
 */
export function diagnosticsFileName(extensionVersion: string, generatedAt: Date): string {
  return `tapstack-diagnostics-v${extensionVersion}-${formatExportStamp(generatedAt)}.json`;
}

/**
 * 给「问题反馈」用的纯文本摘要（贴进 issue 正文）。
 * 只由 report 派生，因此自动继承同一套白名单——不可能带出 URL/标题/会话名。
 */
export function diagnosticsSummaryText(report: DiagnosticsReport): string {
  const lines: string[] = [];
  lines.push(
    `TapStack 诊断摘要（扩展 v${report.environment.extensionVersion}，生成于 ${report.generatedAt}）`
  );
  lines.push(
    `环境：${report.environment.platform || '未知平台'} / ${report.environment.language || '未知语言'}`
  );

  if (report.data.sessionCount === null) {
    lines.push('数据规模：读取失败（见诊断文件的 unavailable 字段）');
  } else {
    const hist = report.data.tabCountHistogram;
    const histText = hist
      ? TAB_COUNT_BUCKETS.map(b => `${b}×${hist[b]}`).join('，')
      : '未知';
    lines.push(
      `数据规模：${report.data.sessionCount} 个会话，${report.data.tabCount ?? 0} 个标签`
    );
    lines.push(`规模分布：${histText}`);
  }

  lines.push(
    `近 ${report.productEvents.windowDays} 天事件：${
      report.productEvents.byName.length > 0
        ? report.productEvents.byName.map(e => `${e.name}×${e.count}`).join('，')
        : '无'
    }`
  );
  lines.push(
    `journal：${report.journal.entryCount} 条，未确认 ${report.journal.unconfirmedCount} 条`
  );
  // 性能归因：只列最慢的一条，并说清时间花在「等队列」还是「自己执行」。
  // 这两个数字决定下一步该修什么，所以摘要里必须直接给出，而不是让人去翻 JSON。
  const slowest = report.perf.byName[0];
  if (!slowest) {
    lines.push('性能：暂无 span 记录（观测数据可能尚未落盘）');
  } else {
    const wait = slowest.waitTotalMs;
    const run = slowest.runTotalMs;
    const dominant = wait >= run ? '等队列（头阻塞）' : '自身执行';
    lines.push(
      `性能：最慢 ${slowest.name}（${slowest.count} 次，累计 等待 ${Math.round(wait)}ms / ` +
        `执行 ${Math.round(run)}ms，单次执行峰值 ${Math.round(slowest.runMaxMs)}ms）→ 主要耗时在${dominant}`
    );
    if (report.perf.clampedApplyNames.length > 0) {
      lines.push(
        `性能：${report.perf.clampedApplyNames.join('、')} 的纯计算耗时不可信` +
          `（环形缓冲截断丢了部分 run 记录，见 JSON 的 perf.clampedApplyNames）`
      );
    }
  }
  lines.push(
    `同步：${report.sync.authenticated ? '已登录' : '未登录'}；自动同步 ${
      report.sync.autoSyncEnabled === null ? '未知' : report.sync.autoSyncEnabled ? '开' : '关'
    }；上次同步 ${
      report.sync.lastSyncAgeHours === null ? '从未' : `${report.sync.lastSyncAgeHours} 小时前`
    }；待广播 ${report.sync.pendingDeleteCount ?? '未知'}`
  );
  // V3 门禁：摘要里给**判定 + 理由**，不只给数字。「覆盖不足」和「未达成」要修的
  // 东西完全不同（补采样窗口 vs 查分叉），只丢一个 rate 出来等于让人自己猜。
  lines.push(`V3 门禁（${gateVerdictLabel(report.gate.verdict)}）：${report.gate.reason}`);
  lines.push(
    `影子：${report.shadow.entryCount} 条写入记录（成功 ${report.shadow.okCount}，` +
      `Y 增量累计 ${Math.round(report.shadow.totalUpdateBytes / 1024)}KB）；` +
      `对账差异样本 ${report.audit.mismatchedSampleCount}/${report.audit.entryCount}`
  );
  lines.push('（本摘要只含规模与环境信息，不含任何标签 URL、标题或会话名）');
  return lines.join('\n');
}
