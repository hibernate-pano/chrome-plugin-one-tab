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
 */

import { storage } from '@/utils/storage';
import { getRuntimeVersion } from '@/utils/runtimeInfo';
import { formatExportStamp } from '@/utils/exportStamp';
import type { TabGroup, UserSettings } from '@/types/tab';
import type { JournalEntry } from '@/utils/journal';
import type { ProductEventName } from '@/utils/productEvents';
import type { MutationOp } from '@/shared/mutationProtocol';

/** 诊断报告的 schema 标识。改动输出结构时同时 +1，老报告仍可被识别。 */
export const DIAGNOSTICS_SCHEMA = 'tapstack-diagnostics' as const;
export const DIAGNOSTICS_SCHEMA_VERSION = 1;

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
export type UnavailableSource = 'groups' | 'settings' | 'pendingDeleteIds';

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

/**
 * 读取诊断所需的全部本地数据。只做 IO，不做脱敏，不做聚合。
 *
 * 三个可能抛错的源各自兜住并记成 null：`getGroups` / `getSettings` 读失败时
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
  /** 本次采集里读取失败的源名。 */
  unavailable: UnavailableSource[];
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
  const unavailable: UnavailableSource[] = [];
  if (groups === null) unavailable.push('groups');
  if (sources.settings === null) unavailable.push('settings');
  if (sources.pendingDeleteCount === null) unavailable.push('pendingDeleteIds');

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
  lines.push(
    `同步：${report.sync.authenticated ? '已登录' : '未登录'}；自动同步 ${
      report.sync.autoSyncEnabled === null ? '未知' : report.sync.autoSyncEnabled ? '开' : '关'
    }；上次同步 ${
      report.sync.lastSyncAgeHours === null ? '从未' : `${report.sync.lastSyncAgeHours} 小时前`
    }；待广播 ${report.sync.pendingDeleteCount ?? '未知'}`
  );
  lines.push('（本摘要只含规模与环境信息，不含任何标签 URL、标题或会话名）');
  return lines.join('\n');
}
