/**
 * 性能 span 环形缓冲（诊断观测，不参与任何业务判定）。
 *
 * 【为什么需要它】「清理重复标签 / 删除会话有时特别慢」长期无法定位：SW 里一个
 * 计时点都没有，只能推断「大概是排队」或「大概是搬数据」，拿不到占比。
 * 没有占比就没法判断该修哪一条，改完也无法验证是否真的变快。
 * 本模块只回答一个问题：**这段时间花在了哪一段**。
 *
 * 【两段式：等待 vs 执行】单写者队列（@/background/mutationQueue）是全局 FIFO，
 * 用户点击的命令与后台同步排同一条队。把「入队到开始执行」与「执行本身」分开记，
 * 才能区分「头阻塞（别人占着队列）」与「这条命令自己慢」——两者的修法完全不同。
 *
 * 【step：一条命令内部的细分】run 段还可再拆成 journal / read / write /
 * noteDeleted / scheduleUpload 五个 IO 阶段（见 SPAN_STEPS）。纯计算段没有 IO
 * 可包，由聚合时用「run 总和 - 各 step 总和」推出（见 diagnostics.buildPerfSummary
 * 的 applyTotalMs）。这是精确的：总和相减等于各次 apply 耗时之和；
 * 绝不能改成「max 相减」，那是把不同次调用的极值混在一起的假数字。
 *
 * 【为什么写 KV 而不是只留内存】诊断导出发生在 UI 进程（管理页），队列与 mutation
 * 发生在 SW，两者是不同 JS realm，内存互不可见；且 MV3 的 SW 随时被回收。
 * 只有落到共享的 IndexedDB 才能让「用户复现之后导出诊断」拿到现场数据。
 *
 * 【为什么是读-合并-写而不是直接覆盖】同一个键有多个写方（SW 与 UI 各自持有
 * 内存缓冲）。整表覆盖会让后写的一方抹掉先写一方的记录，而慢操作恰恰横跨两个
 * 进程。合并按 (origin, id) 去重、按时间排序、截断到上限，两个进程的 span 都留得住。
 *
 * 【不变量】
 * - 记录**永不**影响被观测的操作：写失败只留在内存缓冲并告警，绝不向上抛。
 * - 落盘有节流：每 PERF_FLUSH_INTERVAL_MS 至多一次，且只在有新 span 时写。
 *   逐条落盘会把「观测成本」加回被观测路径，测出来的就不是原来的数字了。
 * - 节流窗口内的 span 暂存内存；SW 被回收会丢失至多一个窗口的记录。这是有意的取舍：
 *   为观测数据付每次写盘的代价，等于亲手制造要排查的那个卡顿。
 */
import { kvGet, kvSet, kvRemove } from '@/storage-kv/storageAdapter';
import { STORAGE_KEYS } from '@/storage-kv/keys';
import { getContextOrigin } from '@/core/contextOrigin';
import { logWarn } from './log';
import type { MutationOp } from '@/shared/mutationProtocol';

/**
 * span 名封闭词表。
 *
 * 与 diagnostics 的事件名白名单同一个理由：这些字符串会进入诊断文件（用户可能贴到
 * 公开 issue）。全部来自代码常量（MutationOp['op'] / 队列任务名），不含任何来自
 * 存储或用户输入的内容。词表外的名字一律拒记——宁可少一条观测，也不能让
 * 「某个动态字符串」成为流向公开文件的通道。
 */
export const PERF_SPAN_NAMES = [
  // 语义命令（与 MutationOp['op'] 同集）
  'saveGroup',
  'removeTab',
  'deleteGroup',
  'deleteAllGroups',
  'importGroups',
  'renameGroup',
  'toggleGroupLock',
  'updateGroupFields',
  'moveTab',
  'cleanDuplicates',
  // 队列任务名（非 mutation）
  'sync:upload',
  'sync:download',
  'opStampMigration',
  'saveAllTabs',
  'saveCurrentTab',
] as const;

/**
 * run 段内部可计时的 IO 阶段。
 *
 * 只列**真的被测**的阶段；纯计算段（apply）不在这里——它由聚合时相减推出
 * （见文件头）。把推导值也塞进这张表会让人误以为它被直接测过。
 */
export const SPAN_STEPS = [
  'journal',
  'read',
  'write',
  'noteDeleted',
  'scheduleUpload',
] as const;

export type SpanStep = (typeof SPAN_STEPS)[number];

/**
 * span 阶段：
 * - `wait`：入队到真正开始执行（在单写者队列里等前面的任务，即头阻塞）；
 * - `run`：执行本身；
 * - `step`：run 内部的某个 IO 阶段（必须带 step 名）。
 */
export type SpanPhase = 'wait' | 'run' | 'step';

const NAME_SET = new Set<string>(PERF_SPAN_NAMES);

/**
 * 编译期钉住：**每个语义命令都必须在 span 词表里**。
 *
 * 为什么用类型而不是运行时校验：新增一个 MutationOp 而忘了登记 span 名时，
 * recordSpan 的词表校验只会「静默丢弃这条观测」，没有任何报错——
 * 而缺失的恰恰可能是新命令的性能数据。
 *
 * 这里用条件类型把缺失项变成一个**编译错误**（赋不进 true 类型），
 * 与 diagnostics 的 JOURNAL_OP_TYPES / PRODUCT_EVENT_NAMES 是同一种防线。
 *
 * 【为什么不在模块加载时抛错】抛错会让整个 Service Worker 起不来，
 * 一个漏登记的观测名代价是「扩展不可用」——用编译期断言既能拦住同样的错误，
 * 又没有任何运行时风险与成本。
 */
type SpanName = (typeof PERF_SPAN_NAMES)[number];
/** 词表里缺失的语义命令名；全部登记时求值为 never。 */
type MissingSpanNames = Exclude<MutationOp['op'], SpanName>;
// 有缺失时右侧是 never，true 赋不进去 → tsc 报错并列出缺失的名字。
const _everyMutationOpIsSpanName: [MissingSpanNames] extends [never] ? true : MissingSpanNames[] = true;
void _everyMutationOpIsSpanName;

/** 诊断输出用的阶段键名 = `<span>.<phase>`。 */
export function phaseKeyOf(name: string, phase: SpanPhase): string {
  return `${name}.${phase}`;
}

/** step 阶段名 = `<span>.step.<step>`。 */
export function stepKeyOf(name: string, step: SpanStep): string {
  return `${name}.step.${step}`;
}

export interface PerfSpan {
  /** 封闭词表内的 span 名。 */
  name: string;
  phase: SpanPhase;
  /** step 阶段名；其它 phase 为 null。 */
  step: SpanStep | null;
  /** 毫秒，保留 1 位小数（更细的精度对定位没有意义，只会让 JSON 变大）。 */
  ms: number;
  /** ISO 时间。 */
  ts: string;
  /** 记录方上下文身份 + 进程内单调序号，合并时用于去重。 */
  origin: string;
  id: number;
}

/** 环形缓冲上限。200 条 × ~90B ≈ 18KB，远小于一次 groups 全量写。 */
export const PERF_SPAN_MAX = 200;

/** 落盘节流窗口（ms）。见文件头「不变量」。 */
export const PERF_FLUSH_INTERVAL_MS = 5000;

/** 超过此耗时的 span 额外打一条告警日志（logWarn 始终输出，生产也可见）。 */
export const SLOW_SPAN_WARN_MS = 300;

export interface PerfTracerDeps {
  kvGet<T>(key: string): Promise<T | null>;
  kvSet(key: string, value: unknown): Promise<void>;
  kvRemove(key: string): Promise<void>;
  /** 记录方上下文身份（生产 = @/core/contextOrigin）。 */
  getOrigin(): string;
  /** 当前时间。注入以便测试控制节流窗口与 ts 排序。 */
  now(): number;
}

export interface PerfTracer {
  recordSpan(name: string, phase: SpanPhase, ms: number, step?: SpanStep | null): void;
  measure<T>(name: string, step: SpanStep, fn: () => Promise<T> | T): Promise<T>;
  flush(): Promise<void>;
  read(): Promise<PerfSpan[]>;
  clear(): Promise<void>;
  /** 仅供测试：当前内存缓冲（未落盘的那部分）。 */
  peekBuffer(): PerfSpan[];
}

/**
 * 创建一个 tracer 实例（状态在实例内，不共享）。
 *
 * 为什么是工厂 + 依赖注入而不是模块级可变状态：本项目所有「带持久化的工具」
 * 都是这个形状（journal / seqRegistry / yShadow），node:test 没有 IndexedDB，
 * 注入内存 Map 才能直测「读-合并-写」「节流」「截断」这些真正容易出错的逻辑。
 * 生产单例见文件末尾的 defaultTracer。
 */
export function createPerfTracer(deps: PerfTracerDeps): PerfTracer {
  let buffer: PerfSpan[] = [];
  let dirtyCount = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;
  /** 本进程已持久化的 span 键集合。合并写时用它避免重复推入。 */
  let flushed = new Set<string>();

  const spanKey = (s: PerfSpan): string => `${s.origin}#${s.id}`;

  /** 只读已落盘的 span（不触发 flush）。 */
  async function readStored(): Promise<PerfSpan[]> {
    try {
      const raw = await deps.kvGet<unknown>(STORAGE_KEYS.PERF_SPANS);
      return Array.isArray(raw) ? (raw as PerfSpan[]) : [];
    } catch (error) {
      logWarn('[perf] span 读取失败（按空处理）:', error);
      return [];
    }
  }

  async function flush(): Promise<void> {
    if (dirtyCount === 0) return;
    const pending = buffer.filter(s => !flushed.has(spanKey(s)));
    if (pending.length === 0) {
      dirtyCount = 0;
      return;
    }
    try {
      const existing = await readStored();
      const seen = new Set(existing.map(spanKey));
      // 合并而非覆盖（理由见文件头）
      const merged = [...existing, ...pending.filter(s => !seen.has(spanKey(s)))]
        .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id - b.id))
        .slice(-PERF_SPAN_MAX);
      await deps.kvSet(STORAGE_KEYS.PERF_SPANS, merged);
      for (const s of pending) flushed.add(spanKey(s));
      dirtyCount = 0;
    } catch (error) {
      // 观测数据写不进去不能影响被观测的操作。span 留在内存缓冲里，下轮再试。
      logWarn('[perf] span 落盘失败（已保留内存缓冲）:', error);
    }
  }

  function scheduleFlush(): void {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush().catch(() => undefined);
    }, PERF_FLUSH_INTERVAL_MS);
    // 不让这个定时器吊住进程：SW 里本来也不会因为 pending timer 而延长存活，
    // 但在 node:test 下会让每个记过 span 的用例文件白等一个完整的节流窗口。
    // unref 是 Node 专有 API，浏览器/SW 下不存在，故用可选调用。
    (flushTimer as unknown as { unref?: () => void }).unref?.();
  }

  function record(span: PerfSpan): void {
    buffer.push(span);
    dirtyCount += 1;
    if (buffer.length > PERF_SPAN_MAX) {
      const dropped = buffer.splice(0, buffer.length - PERF_SPAN_MAX);
      // 被截断的 span 若已落盘，其 key 也要忘掉：它们已不在内存缓冲里，
      // 下次合并写时不该再被当成「本进程有、远端没有」而重新推入。
      for (const s of dropped) flushed.delete(spanKey(s));
    }
    if (span.ms >= SLOW_SPAN_WARN_MS) {
      const label = span.step ? stepKeyOf(span.name, span.step) : phaseKeyOf(span.name, span.phase);
      logWarn(`[perf] ${label} 耗时 ${span.ms.toFixed(0)}ms`);
    }
    scheduleFlush();
  }

  /**
   * 记一条已完成计时的 span。
   *
   * 独立函数（不放在返回对象里用 this）：调用方可能解构使用
   * （`const { measure } = perfTrace()`），this 绑定会丢。
   */
  function recordSpan(
    name: string,
    phase: SpanPhase,
    ms: number,
    step: SpanStep | null = null
  ): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    if (!NAME_SET.has(name)) {
      logWarn('[perf] 丢弃未登记的 span 名（不在封闭词表内）:', name);
      return;
    }
    // step 阶段必须带 step 名，否则聚合层无法归类（丢掉比归错好）
    if (phase === 'step' && !step) return;
    seq += 1;
    record({
      name,
      phase,
      step: phase === 'step' ? step : null,
      ms: Math.round(ms * 10) / 10,
      ts: new Date(deps.now()).toISOString(),
      origin: deps.getOrigin(),
      id: seq,
    });
  }


  return {
    recordSpan,

    async measure(name, step, fn) {
      const start = Date.now();
      try {
        return await fn();
      } finally {
        recordSpan(name, 'step', Date.now() - start, step);
      }
    },

    /**
     * 读取 span（先落盘本进程缓冲）。
     *
     * 为什么先 flush：诊断导出发生在用户复现问题之后，而慢操作的计时可能正是最近
     * 这几秒产生的，还在节流窗口里。不 flush 就会丢掉要看的现场。
     * 注意这只 flush **本进程**的缓冲；SW 的缓冲需要另发 PERF_FLUSH 消息
     * （见 service-worker.ts 与 diagnostics.readDiagnosticsSources）。
     */
    async read() {
      await flush();
      return readStored();
    },

    flush,

    async clear() {
      buffer = [];
      flushed = new Set();
      dirtyCount = 0;
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      try {
        await deps.kvRemove(STORAGE_KEYS.PERF_SPANS);
      } catch (error) {
        logWarn('[perf] span 清理失败:', error);
      }
    },

    peekBuffer() {
      return [...buffer];
    },
  };
}

/**
 * 生产单例。绑定真实 KV 与上下文身份。
 *
 * 导出的是**访问器**而非对象本身，调用方一律 `perfTrace().recordSpan(...)`：
 * import 顺序不影响初始化，测试也能整体重置绑定（见 __resetPerfTraceForTests）。
 */
let singleton: PerfTracer | null = null;

export function perfTrace(): PerfTracer {
  if (!singleton) {
    singleton = createPerfTracer({
      kvGet,
      kvSet,
      kvRemove,
      getOrigin: () => getContextOrigin(),
      now: () => Date.now(),
    });
  }
  return singleton;
}

/** 仅供测试：丢弃生产单例（跨用例不残留绑定）。 */
export function __resetPerfTraceForTests(): void {
  singleton = null;
}
