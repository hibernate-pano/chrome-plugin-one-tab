/**
 * 错误处理工具函数
 */

/**
 * 格式化错误信息，确保错误对象能够正确序列化
 * @param error 错误对象
 * @returns 格式化后的错误信息字符串
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  
  if (typeof error === 'string') {
    return error;
  }
  
  if (error && typeof error === 'object') {
    // 处理 Supabase 错误对象
    if ('message' in error) {
      return String(error.message);
    }
    
    // 尝试 JSON 序列化
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  
  return String(error);
}

/**
 * 创建带有前缀的错误信息
 * @param prefix 错误前缀
 * @param error 错误对象
 * @returns 格式化后的错误信息
 */
export function createErrorMessage(prefix: string, error: unknown): string {
  const errorMessage = formatError(error);
  return `${prefix}: ${errorMessage}`;
}

/**
 * 安全地记录错误到控制台
 * @param message 错误消息
 * @param error 错误对象
 */
export function logError(message: string, error: unknown): void {
  console.error(message, error);
  
  // 如果是对象，尝试展开详细信息
  if (error && typeof error === 'object' && 'code' in error) {
    console.error('错误详情:', {
      code: (error as any).code,
      message: (error as any).message,
      details: (error as any).details,
      hint: (error as any).hint
    });
  }
}

/**
 * 创建包含更多信息的错误对象
 * @param message 基础错误消息
 * @param originalError 原始错误
 * @param context 上下文信息
 * @returns 新的错误对象
 */
export function createEnhancedError(
  message: string, 
  originalError: unknown, 
  context?: Record<string, any>
): Error {
  const errorMessage = formatError(originalError);
  let fullMessage = `${message}: ${errorMessage}`;
  
  if (context) {
    const contextStr = JSON.stringify(context);
    fullMessage += ` (上下文: ${contextStr})`;
  }
  
  const error = new Error(fullMessage);
  
  // 保留原始错误的堆栈信息
  if (originalError instanceof Error) {
    error.stack = originalError.stack;
  }
  
  return error;
}