/**
 * 统一的日志工具
 * 在生产环境中自动过滤调试日志，只保留错误日志
 */

export interface LogContext {
  [key: string]: any;
}

class Logger {
  private isDevelopment = process.env.NODE_ENV === 'development';

  /**
   * 调试日志 - 仅在开发环境显示
   */
  debug(message: string, context?: LogContext): void {
    if (this.isDevelopment) {
      if (context) {
        console.log(`🔍 ${message}`, context);
      } else {
        console.log(`🔍 ${message}`);
      }
    }
  }

  /**
   * 信息日志 - 仅在开发环境显示
   */
  info(message: string, context?: LogContext): void {
    if (this.isDevelopment) {
      if (context) {
        console.info(`ℹ️ ${message}`, context);
      } else {
        console.info(`ℹ️ ${message}`);
      }
    }
  }

  /**
   * 警告日志 - 所有环境显示
   */
  warn(message: string, context?: LogContext): void {
    if (context) {
      console.warn(`⚠️ ${message}`, context);
    } else {
      console.warn(`⚠️ ${message}`);
    }
  }

  /**
   * 错误日志 - 所有环境显示
   */
  error(message: string, error?: any, context?: LogContext): void {
    if (context) {
      console.error(`❌ ${message}`, error, context);
    } else {
      console.error(`❌ ${message}`, error);
    }
  }

  /**
   * 成功日志 - 仅在开发环境显示
   */
  success(message: string, context?: LogContext): void {
    if (this.isDevelopment) {
      if (context) {
        console.log(`✅ ${message}`, context);
      } else {
        console.log(`✅ ${message}`);
      }
    }
  }

  /**
   * 同步操作相关日志 - 仅在开发环境显示
   */
  sync(message: string, context?: LogContext): void {
    if (this.isDevelopment) {
      if (context) {
        console.log(`🔄 ${message}`, context);
      } else {
        console.log(`🔄 ${message}`);
      }
    }
  }

  /**
   * 拖拽操作相关日志 - 仅在开发环境显示
   */
  dnd(message: string, context?: LogContext): void {
    if (this.isDevelopment) {
      if (context) {
        console.log(`🎯 ${message}`, context);
      } else {
        console.log(`🎯 ${message}`);
      }
    }
  }

  /**
   * 性能监控日志 - 仅在开发环境显示
   */
  perf(message: string, context?: LogContext): void {
    if (this.isDevelopment) {
      if (context) {
        console.log(`⚡ ${message}`, context);
      } else {
        console.log(`⚡ ${message}`);
      }
    }
  }
}

// 导出单例实例
export const logger = new Logger();

// 为了向后兼容，也导出类型
export { Logger };