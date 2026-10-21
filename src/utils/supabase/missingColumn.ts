/**
 * 「云端缺列」的降级判定（2026-10-20 审计 A-9 的相邻补丁）。
 *
 * ── 问题 ────────────────────────────────────────────────────────────────
 * `user_settings` 这张表是早期直接在 Supabase Dashboard 建的，仓库里**没有
 * CREATE TABLE**，它的列靠一份份 ALTER 迁移往上加：
 *
 *   · theme_style            —— 20260125071141_add_theme_style_to_user_settings.sql
 *   · collect_pinned_tabs    —— 20260210072717_add_collect_pinned_tabs_to_user_settings.sql
 *   · sync_interval_minutes  —— 20261011190000_add_sync_interval_minutes_to_user_settings.sql
 *
 * 没跑迁移的库，**没有那一列**。而 PostgREST 的 upsert 会把整行一次性发过去
 * ⇒ Postgres 直接抛 `42703 undefined_column` ⇒ **整条设置同步死掉**。
 *
 * 修复前只有 `collect_pinned_tabs` 一列有降级（剔掉该列重试一次）。
 * `sync_interval_minutes` 与 `theme_style` 没有 ⇒ 它们的库照样断。
 * 而 `download.ts` 的注释写着「上传侧有 42703 降级（缺列则忽略该字段重试），
 * 所以迁移前后都不阻塞同步」—— **那句话对除 collect_pinned_tabs 外的列不准确**。
 *
 * ── 修法 ────────────────────────────────────────────────────────────────
 * 把「缺哪列就剔哪列」做成**通用**规则，而不是给每一列各写一个分支：
 *
 *   ① 从错误里认出**是哪一列**（PostgREST 的 `column` 字段，或报文里的
 *      `column xxx does not exist`）；
 *   ② 认不出来时，退一步在报文里找载荷中出现过的列名（历史实现对
 *      collect_pinned_tabs 就是这么找的）；
 *   ③ 剔除后重试；**重试还报 42703 就再剔一列**（可能同时缺好几列，
 *      一次只剔一列会卡在第二列上）—— 所以调用方是个**有界循环**。
 *
 * ── 安全边界 ────────────────────────────────────────────────────────────
 * 只有「载荷里的设置列」可以被剔。`user_id` 是这张表的主键/冲突键，
 * 剔掉它 upsert 就不是 upsert 了 —— 所以它（连同 device_id / last_sync）
 * 是一份**受保护名单**，永不剔除。
 *
 * 抽成纯函数是为了能被单测直接覆盖：`upload.ts` 一进来就摸 supabase 客户端，
 * 在 node:test 里没法 import（见本仓测试纪律：没有 jsdom / testing-library）。
 */

/**
 * 载荷里**永不剔除**的列。
 *
 * · `user_id` —— 表的主键，也是 upsert 的 onConflict 目标。剔掉它就不是
 *   upsert 了（会变成插新行），而且 RLS 会直接拒绝。
 * · `device_id` / `last_sync` —— 行级元信息，剔掉它们不致命，但它们
 *   **本来也不可能缺**（早期 Dashboard 建表时就在），剔了只会掩盖真问题。
 */
export const PROTECTED_UPLOAD_COLUMNS = ['user_id', 'device_id', 'last_sync'] as const;

/**
 * 一次设置上传里最多允许剔除几列。
 *
 * 上界 = 设置列的实际个数（11 个左右），留一点余量即可。
 * 有界是为了不让「认错列」变成无限循环：每一轮要么成功，要么至少剔掉一列，
 * 而载荷里的可剔列是有限的 ⇒ 循环必然终止。
 */
export const MAX_COLUMN_DOWNGRADE_ATTEMPTS = 8;

interface PostgrestLikeError {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  hint?: unknown;
  column?: unknown;
}

/** 把错误对象里所有可能带列名的文本字段拼起来（小写）。 */
export function collectErrorText(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const e = error as PostgrestLikeError;
  return [e.message, e.details, e.hint]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();
}

/**
 * 从错误里认出「云端缺的那一列」，认不出返回 null。
 *
 * 认法一：PostgREST 有时把列名直接放在 `error.column`。
 * 认法二：报文里那句 `column user_settings.sync_interval_minutes does not exist`
 *         （带表名前缀、带不带引号都要认）。
 */
export function extractMissingColumn(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const e = error as PostgrestLikeError;

  if (typeof e.column === 'string' && /^[A-Za-z_]\w*$/.test(e.column)) {
    return e.column.toLowerCase();
  }

  const match = collectErrorText(error).match(
    /column\s+(?:[A-Za-z_]\w*\.)?"?([A-Za-z_]\w*)"?\s+does\s+not\s+exist/i
  );
  return match ? match[1].toLowerCase() : null;
}

/**
 * 在载荷里找出「报错提到的那一列」。
 *
 * 认法一失败时的兜底：报文里只要提到了载荷中的某个列名，那大概率就是它
 * （历史实现对 collect_pinned_tabs 就是这么找的）。
 * 受保护列直接跳过 —— 报文里出现 `user_id` 不代表 `user_id` 缺。
 *
 * 认错列不是灾难：调用方重试后会再报 42703，那时就能认出真正的列了
 * （或者认出列后剔除、重试成功）。循环有界，所以不会失控。
 */
export function findDroppableColumn(
  error: unknown,
  body: Record<string, unknown>
): string | null {
  const explicit = extractMissingColumn(error);
  if (explicit && explicit in body && !isProtectedColumn(explicit)) {
    return explicit;
  }

  const text = collectErrorText(error);
  if (!text) return null;
  for (const key of Object.keys(body)) {
    if (isProtectedColumn(key)) continue;
    if (text.includes(key.toLowerCase())) return key.toLowerCase();
  }
  return null;
}

/** 该列是不是受保护（永远不剔）。 */
export function isProtectedColumn(column: string): boolean {
  return (PROTECTED_UPLOAD_COLUMNS as readonly string[]).includes(column);
}

/**
 * 剔除指定列，得到重试用的新载荷。
 *
 * 返回 null = 这一列不该剔（受保护 / 载荷里根本没有它）——
 * 调用方据此**停止**降级，而不是硬删一个不存在的键（那会让重试带上同样的错误）。
 */
export function buildDowngradedBody(
  body: Record<string, unknown>,
  column: string
): Record<string, unknown> | null {
  if (isProtectedColumn(column)) return null;
  if (!(column in body)) return null;
  const next = { ...body };
  delete next[column];
  return next;
}

/**
 * 这个错误是不是「云端缺列」（可以降级重试）。
 *
 * 只认 `42703`（undefined_column）。别的错误码（RLS 拒绝、唯一约束、
 * 连接失败……）降级没有意义 —— 那是真故障，必须原样冒出去。
 */
export function isUndefinedColumnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as PostgrestLikeError).code === '42703';
}

/** upsert 的最小形状（本模块只依赖这两个字段，好让测试能用替身驱动）。 */
export interface UpsertOutcome {
  data: unknown;
  error: unknown;
}

/** upsert 替身：给一份载荷，返回一次结果。 */
export type UpsertFn = (body: Record<string, unknown>) => Promise<UpsertOutcome>;

export interface MissingColumnFallbackResult extends UpsertOutcome {
  /** 这一轮降级里被剔掉的列（按剔除顺序）。 */
  droppedColumns: string[];
}

/**
 * 「缺列就剔掉再试」的上传包装（**本模块的主入口**）。
 *
 * 循环是有界的、且每轮至少剔掉一列：
 *   · 每轮若不是 42703 ⇒ 立刻停（真故障，原样冒出去）；
 *   · 每轮若认不出该剔哪一列 ⇒ 停（不瞎猜、不盲删）；
 *   · 每轮若那一列不可剔（受保护 / 载荷里没有）⇒ 停；
 *   · 否则剔掉它、重试。
 *
 * 上界 `MAX_COLUMN_DOWNGRADE_ATTEMPTS` 保证终止：载荷里可剔的列是有限的，
 * 剔一个少一个，所以循环不可能一直转下去。
 *
 * 为什么要「循环」而不是「重试一次」：Postgres 只会报**第一个**缺列。
 * 库里同时缺 theme_style 和 sync_interval_minutes 时，一次只剔一列的话，
 * 第二次重试会在另一列上再报一次 42703 —— 而那一列没有降级分支，整条同步照断。
 */
export async function upsertWithMissingColumnFallback(
  upsert: UpsertFn,
  payload: Record<string, unknown>
): Promise<MissingColumnFallbackResult> {
  let body = payload;
  const droppedColumns: string[] = [];

  let outcome = await upsert(body);
  for (let attempt = 0; attempt < MAX_COLUMN_DOWNGRADE_ATTEMPTS; attempt++) {
    if (!isUndefinedColumnError(outcome.error)) break;
    const column = findDroppableColumn(outcome.error, body);
    if (!column) break;
    const nextBody = buildDowngradedBody(body, column);
    if (!nextBody) break;
    droppedColumns.push(column);
    body = nextBody;
    outcome = await upsert(body);
  }

  return { ...outcome, droppedColumns };
}
