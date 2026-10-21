/**
 * 「NOT NULL 违例」的降级判定（2026-10-20 审计 A-9 的相邻补丁）。
 *
 * ── 问题 ────────────────────────────────────────────────────────────────
 * `user_settings` 里有几列可能是 **NOT NULL 且没有默认值**。那样
 * Postgres 在 upsert 的 INSERT 阶段就抛 `23502 not_null_violation` ——
 * 哪怕这一行已存在、最终走的是 `ON CONFLICT DO UPDATE` 分支，
 * INSERT 阶段的检查先发生 ⇒ **整条设置同步直接断**。
 *
 * A-9 把五个退役列从上传载荷里去掉了（它们没有读取方）。
 * 「不再写」这件事本身**扩大**了 23502 的暴露面：以前我们写它们，
 * 写的是一个非 null 值；现在不写了，数据库那一列就成了 null。
 * 库上若是 NOT NULL 无默认 ⇒ 撞 23502。
 *
 * 修复前这里是一份**硬编码名单**（五个退役列的列名 + 各自的历史默认值），
 * 用「错误文本里包含列名」来判定撞的是哪一列。两个问题：
 *
 *   ① **只认这几个列**。任何别的 NOT NULL 无默认列（哪怕是我们自己
 *      写出去的活列，比如 `theme_style` 恰好被存成了 null）撞上 23502 时，
 *      降级**不命中** ⇒ 错误原样抛出 ⇒ 整条同步断掉。
 *   ② **子串匹配整个错误文本**。报错文本里只要出现某个列名（哪怕出现在
 *      别的上下文里）就当成「撞的是那列」⇒ 可能补错列。
 *
 * ── 修法 ────────────────────────────────────────────────────────────────
 * 从错误里**认出撞的是哪一列**，再用**我们确实知道的那个值**补齐后重试：
 *
 *   · 补的值来自一张**统一来源**的「列 → 默认值」表
 *     （`utils/storage.ts` 的 `SETTINGS_COLUMN_DEFAULTS`：活列取当前
 *     `DEFAULT_SETTINGS`，退役列取它们的历史默认值）；
 *   · 只补**我们确实知道默认值**的列 —— 不知道就不猜，让错误原样冒出去
 *     （猜一个值写进类型不对的列，比直接失败更糟）；
 *   · Postgres 一次只报一列撞规 ⇒ 重试后可能又冒出下一列 ⇒ **有界循环**。
 *
 * ── 为什么单独一个模块 ──────────────────────────────────────────────────
 * `upload.ts` 一进来就摸 supabase 客户端，在 node:test 里没法 import
 * （本仓测试纪律：没有 jsdom / happy-dom / testing-library）。
 * 把「认出撞的哪列」「补哪个值」「循环到什么时候停」抽成纯逻辑，
 * 才能用替身驱动**真实行为**来测，而不是靠读源码猜。
 */

interface PostgrestLikeError {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  hint?: unknown;
}

/** 把错误对象里所有可能带列名的文本字段拼起来（小写）。 */
export function collectNotNullErrorText(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const e = error as PostgrestLikeError;
  return [e.message, e.details, e.hint]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();
}

/**
 * 从 23502 错误里认出「撞规的那一列」，认不出返回 null。
 *
 * Postgres 的标准报文：
 *   `null value in column "theme_style" of relation "user_settings" violates not-null constraint`
 * 带引号与不带引号都要认。
 */
export function extractNotNullColumn(error: unknown): string | null {
  const text = collectNotNullErrorText(error);
  if (!text) return null;

  const quoted = text.match(/null value in column\s+"([a-z_]\w*)"/);
  if (quoted) return quoted[1];

  const unquoted = text.match(/null value in column\s+([a-z_]\w*)\s/);
  if (unquoted) return unquoted[1];

  // 兜底：报文形态不认得，但只要它说了「not-null」且提到某个列名，
  // 那个列名就是撞规的列。
  if (text.includes('not-null') || text.includes('not null')) {
    const generic = text.match(/column\s+"?([a-z_]\w*)"?/);
    if (generic) return generic[1];
  }
  return null;
}

/**
 * 这个错误是不是「NOT NULL 违例」。
 *
 * 只认 `23502`。别的错误码（RLS 拒绝、唯一约束、连接失败……）
 * 补值没有意义 —— 那是真故障，必须原样冒出去。
 */
export function isNotNullViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as PostgrestLikeError).code === '23502';
}

/**
 * 补齐撞规的列，返回重试用的新载荷。
 *
 * 返回 null = 这一列**补不了**（我们不知道它的默认值，或载荷里根本没有它）——
 * 调用方据此**停止**降级，把错误原样冒出去。
 *
 * 【为什么不猜默认值】我们只对**确实知道**的列补值：活列取当前
 * `DEFAULT_SETTINGS` 的值，退役列取它们的历史默认值。对一个我们不认识的
 * 列瞎填一个值，可能写进类型不对的列（text 列写 boolean）⇒ 换个姿势失败，
 * 而且把库里那一行改坏了。宁可失败，也不猜。
 */
export function buildNotNullFallbackBody(
  body: Record<string, unknown>,
  column: string,
  columnDefaults: Record<string, unknown>
): Record<string, unknown> | null {
  if (!column) return null;
  if (!(column in columnDefaults)) return null;
  const next = { ...body };
  next[column] = columnDefaults[column];
  return next;
}

/** upsert 的最小形状（本模块只依赖这两个字段，好让测试能用替身驱动）。 */
export interface UpsertOutcome {
  data: unknown;
  error: unknown;
}

/** upsert 替身：给一份载荷，返回一次结果。 */
export type UpsertFn = (body: Record<string, unknown>) => Promise<UpsertOutcome>;

export interface NotNullFallbackResult extends UpsertOutcome {
  /** 这一轮降级里被补齐的列（按补齐顺序）。 */
  filledColumns: string[];
}

/**
 * 「撞 NOT NULL 就补值再试」的上传包装。
 *
 * 循环是有界的、且每轮至少补齐一列：
 *   · 每轮若不是 23502 ⇒ 立刻停（真故障，原样冒出去）；
 *   · 每轮若认不出撞的是哪一列 ⇒ 停（不瞎猜）；
 *   · 每轮若那一列我们**不知道默认值** ⇒ 停（宁可失败，也不猜）；
 *   · 每轮若那一列**已经补过** ⇒ 停（再补一次是同一个值，没有意义 ⇒
 *     说明这一列根本不是「缺值」的问题，错误原样冒出去）；
 *   · 否则补齐它、重试。
 *
 * 上界保证终止：可补的列是有限的，补一个「占用」一个，
 * 所以循环不可能一直转下去。
 */
export async function upsertWithNotNullFallback(
  upsert: UpsertFn,
  payload: Record<string, unknown>,
  columnDefaults: Record<string, unknown>
): Promise<NotNullFallbackResult> {
  let body = payload;
  const filledColumns: string[] = [];

  let outcome = await upsert(body);
  for (let attempt = 0; attempt < 8; attempt++) {
    if (!isNotNullViolation(outcome.error)) break;
    const column = extractNotNullColumn(outcome.error);
    if (!column) break;
    // 同一列再补一次还是同一个值 ⇒ 补值没解决问题 ⇒ 别转了。
    if (filledColumns.includes(column)) break;
    const nextBody = buildNotNullFallbackBody(body, column, columnDefaults);
    if (!nextBody) break;
    filledColumns.push(column);
    body = nextBody;
    outcome = await upsert(body);
  }

  return { ...outcome, filledColumns };
}
