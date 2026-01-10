/**
 * 日志过滤模块 - 过滤敏感信息
 * 
 * 功能：
 * 1. 自动过滤日志中的敏感信息（userId、deviceId、token 等）
 * 2. 根据环境控制日志级别
 * 3. 提供安全的日志方法
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface SensitivePattern {
  pattern: RegExp;
  replacement: string;
}

// 敏感信息模式列表
const SENSITIVE_PATTERNS: SensitivePattern[] = [
  // 用户 ID
  { pattern: /userId[=:]\s*["']?[\w-]+["']?/gi, replacement: 'userId=[REDACTED]' },
  { pattern: /user_id[=:]\s*["']?[\w-]+["']?/gi, replacement: 'user_id=[REDACTED]' },
  { pattern: /"userId"\s*:\s*"[^"]+"/gi, replacement: '"userId":"[REDACTED]"' },
  { pattern: /"user_id"\s*:\s*"[^"]+"/gi, replacement: '"user_id":"[REDACTED]"' },
  
  // 设备 ID
  { pattern: /deviceId[=:]\s*["']?[\w-]+["']?/gi, replacement: 'deviceId=[REDACTED]' },
  { pattern: /device_id[=:]\s*["']?[\w-]+["']?/gi, replacement: 'device_id=[REDACTED]' },
  { pattern: /"deviceId"\s*:\s*"[^"]+"/gi, replacement: '"deviceId":"[REDACTED]"' },
  { pattern: /"device_id"\s*:\s*"[^"]+"/gi, replacement: '"device_id":"[REDACTED]"' },
  
  // Token
  { pattern: /token[=:]\s*["']?[\w.-]+["']?/gi, replacement: 'token=[REDACTED]' },
  { pattern: /access_token[=:]\s*["']?[\w.-]+["']?/gi, replacement: 'access_token=[REDACTED]' },
  { pattern: /refresh_token[=:]\s*["']?[\w.-]+["']?/gi, replacement: 'refresh_token=[REDACTED]' },
  { pattern: /"token"\s*:\s*"[^"]+"/gi, replacement: '"token":"[REDACTED]"' },
  { pattern: /"access_token"\s*:\s*"[^"]+"/gi, replacement: '"access_token":"[REDACTED]"' },
  { pattern: /"refresh_token"\s*:\s*"[^"]+"/gi, replacement: '"refresh_token":"[REDACTED]"' },
  
  // 邮箱
  { pattern: /email[=:]\s*["']?[\w@.+-]+["']?/gi, replacement: 'email=[REDACTED]' },
  { pattern: /"email"\s*:\s*"[^"]+"/gi, replacement: '"email":"[REDACTED]"' },
  
  // 密码
  { pattern: /password[=:]\s*["']?[^"'\s]+["']?/gi, replacement: 'password=[REDACTED]' },
  { pattern: /"password"\s*:\s*"[^"]+"/gi, replacement: '"password":"[REDACTED]"' },
  
  // API 密钥
  { pattern: /api[_-]?key[=:]\s*["']?[\w-]+["']?/gi, replacement: 'api_key=[REDACTED]' },
  { pattern: /"api[_-]?key"\s*:\s*"[^"]+"/gi, replacement: '"api_key":"[REDACTED]"' },
  
  // UUID 格式（可能是敏感 ID）
  { pattern: /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, replacement: '[UUID-REDACTED]' },
];

// 日志级别优先级
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * 日志过滤器类
 */
class LogSanitizer {
  private minLevel: LogLevel;
  private isProduction: boolean;

  constructor() {
    // 检测是否为生产环境
    this.isProduction = this.detectProduction();
    // 生产环境只输出 warn 和 error
    this.minLevel = this.isProduction ? 'warn' : 'debug';
  }

  /**
   * 检测是否为生产环境
   */
  private detectProduction(): boolean {
    // 检查多种环境变量
    if (typeof process !== 'undefined' && process.env) {
      if (process.env.NODE_ENV === 'production') return true;
    }
    // Chrome 扩展中检查是否从商店安装
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      const manifest = chrome.runtime.getManifest?.();
      // 如果有 update_url，说明是从商店安装的
      if (manifest && 'update_url' in manifest) {
        return true;
      }
    }
    return false;
  }

  /**
   * 检查是否为生产环境
   */
  isProductionEnv(): boolean {
    return this.isProduction;
  }

  /**
   * 设置最小日志级别
   */
  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  /**
   * 过滤敏感信息
   */
  sanitize(message: string): string {
    if (typeof message !== 'string') {
      return String(message);
    }

    let sanitized = message;
    for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
      sanitized = sanitized.replace(pattern, replacement);
    }
    return sanitized;
  }

  /**
   * 将参数转换为安全的字符串
   */
  private sanitizeArgs(args: unknown[]): string[] {
    return args.map(arg => {
      if (arg === null) return 'null';
      if (arg === undefined) return 'undefined';
      if (typeof arg === 'string') return this.sanitize(arg);
      if (arg instanceof Error) {
        // 只返回错误消息，不返回堆栈
        return this.sanitize(arg.message);
      }
      try {
        return this.sanitize(JSON.stringify(arg));
      } catch {
        return '[Object]';
      }
    });
  }

  /**
   * 检查是否应该输出该级别的日志
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.minLevel];
  }

  /**
   * 调试日志
   */
  debug(...args: unknown[]): void {
    if (this.shouldLog('debug')) {
      console.debug('[DEBUG]', ...this.sanitizeArgs(args));
    }
  }

  /**
   * 信息日志
   */
  info(...args: unknown[]): void {
    if (this.shouldLog('info')) {
      console.info('[INFO]', ...this.sanitizeArgs(args));
    }
  }

  /**
   * 警告日志
   */
  warn(...args: unknown[]): void {
    if (this.shouldLog('warn')) {
      console.warn('[WARN]', ...this.sanitizeArgs(args));
    }
  }

  /**
   * 错误日志
   */
  error(...args: unknown[]): void {
    if (this.shouldLog('error')) {
      console.error('[ERROR]', ...this.sanitizeArgs(args));
    }
  }

  /**
   * 通用日志方法
   */
  log(level: LogLevel, ...args: unknown[]): void {
    switch (level) {
      case 'debug':
        this.debug(...args);
        break;
      case 'info':
        this.info(...args);
        break;
      case 'warn':
        this.warn(...args);
        break;
      case 'error':
        this.error(...args);
        break;
    }
  }
}

// 导出单例实例
export const logSanitizer = new LogSanitizer();

// 导出类型
export type { LogLevel };
