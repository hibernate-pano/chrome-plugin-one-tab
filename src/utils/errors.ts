/**
 * TabStack 错误分层（S1 §2）
 *
 * 五类错误都有类型 + 用户可读文案 + retryable 标记：
 *   - sync:     syncEngine.downloadAndMerge / upload 的失败路径（可重试）
 *   - storage:  storageAdapter / indexedDbClient IO 失败（真错，非空读，可重试）
 *   - decrypt:  decryptLocalBlob 失败（key 漂移 / blob 损坏，不可重试）
 *   - migration: runMigrations 失败（升级失败但旧数据保留，不可重试）
 *   - network:  supabase fetch 失败 / navigator.onLine=false（可重试）
 *
 * 约束：不引入任何依赖；模块必须可被纯 node test 直接加载。
 */

export type TabStackErrorKind = 'sync' | 'storage' | 'decrypt' | 'migration' | 'network';

export interface TabStackErrorOptions {
  /** 是否可重试（默认 true，decrypt/migration 工厂默认 false） */
  retryable?: boolean;
  /** 用户可读文案（zh）；缺省时按 kind 给出默认文案 */
  userMessage?: string;
  /** 原始错误（保留堆栈/上下文） */
  cause?: unknown;
}

// 各 kind 的默认用户文案（与 errorHandler 的 ErrorMessages 对齐）
const KIND_USER_MESSAGES: Record<TabStackErrorKind, string> = {
  sync: '同步失败，请稍后重试',
  storage: '存储操作失败，请稍后重试',
  decrypt: '数据解密失败，数据可能已损坏或密钥不匹配',
  migration: '升级失败，旧数据已保留',
  network: '网络连接失败，请检查网络设置',
};

export class TabStackError extends Error {
  readonly kind: TabStackErrorKind;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly cause?: unknown;

  constructor(kind: TabStackErrorKind, message: string, opts: TabStackErrorOptions = {}) {
    super(message);
    this.name = 'TabStackError';
    this.kind = kind;
    this.retryable = opts.retryable ?? true;
    this.userMessage = opts.userMessage ?? KIND_USER_MESSAGES[kind];
    if (opts.cause !== undefined) {
      this.cause = opts.cause;
    }
  }
}

// 便捷工厂
export const syncError = (msg: string, opts?: TabStackErrorOptions): TabStackError =>
  new TabStackError('sync', msg, opts);

export const storageError = (msg: string, opts?: TabStackErrorOptions): TabStackError =>
  new TabStackError('storage', msg, opts);

export const decryptError = (msg: string, opts?: TabStackErrorOptions): TabStackError =>
  new TabStackError('decrypt', msg, { retryable: false, ...opts });

export const migrationError = (msg: string, opts?: TabStackErrorOptions): TabStackError =>
  new TabStackError('migration', msg, { retryable: false, ...opts });

export const networkError = (msg: string, opts?: TabStackErrorOptions): TabStackError =>
  new TabStackError('network', msg, opts);

export function isTabStackError(e: unknown): e is TabStackError {
  return e instanceof TabStackError;
}

/**
 * 任意错误 → 用户可读文案。
 * TabStackError 返回其 userMessage；其余（Error / string / undefined…）返回通用文案。
 */
export function toUserMessage(e: unknown): string {
  if (isTabStackError(e)) return e.userMessage;
  return '操作失败，请稍后重试';
}
