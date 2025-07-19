/**
 * 错误处理Hook测试
 */

import { renderHook, act } from '@testing-library/react';
import { useErrorHandling, ErrorType } from '../useErrorHandling';

// 模拟logger
jest.mock('../../../shared/utils/logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }
}));

describe('useErrorHandling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const defaultConfig = {
    context: 'TestComponent',
    enableRetry: true,
    maxRetries: 3,
    retryDelay: 1000
  };

  describe('初始状态', () => {
    it('应该有正确的初始状态', () => {
      const { result } = renderHook(() => useErrorHandling(defaultConfig));

      expect(result.current.error).toBeNull();
      expect(result.current.errorType).toBeNull();
      expect(result.current.isRetrying).toBe(false);
      expect(result.current.retryCount).toBe(0);
      expect(result.current.canRetry).toBe(false);
      expect(result.current.lastErrorTime).toBeNull();
    });
  });

  describe('handleError', () => {
    it('应该正确处理网络错误', () => {
      const { result } = renderHook(() => useErrorHandling(defaultConfig));
      const networkError = new Error('Network timeout');

      act(() => {
        result.current.handleError(networkError);
      });

      expect(result.current.error).toBe(networkError);
      expect(result.current.errorType).toBe(ErrorType.NETWORK);
      expect(result.current.canRetry).toBe(true);
      expect(result.current.lastErrorTime).toBeTruthy();
    });

    it('应该正确处理认证错误', () => {
      const { result } = renderHook(() => useErrorHandling(defaultConfig));
      const authError = new Error('Unauthorized access');

      act(() => {
        result.current.handleError(authError);
      });

      expect(result.current.error).toBe(authError);
      expect(result.current.errorType).toBe(ErrorType.AUTH);
      expect(result.current.canRetry).toBe(false); // 认证错误不可重试
    });

    it('应该正确处理验证错误', () => {
      const { result } = renderHook(() => useErrorHandling(defaultConfig));
      const validationError = new Error('Invalid input data');

      act(() => {
        result.current.handleError(validationError);
      });

      expect(result.current.error).toBe(validationError);
      expect(result.current.errorType).toBe(ErrorType.VALIDATION);
      expect(result.current.canRetry).toBe(false); // 验证错误不可重试
    });

    it('应该调用自定义错误处理器', () => {
      const customHandler = jest.fn();
      const config = {
        ...defaultConfig,
        customHandlers: {
          [ErrorType.NETWORK]: customHandler
        }
      };

      const { result } = renderHook(() => useErrorHandling(config));
      const networkError = new Error('Network error');

      act(() => {
        result.current.handleError(networkError);
      });

      expect(customHandler).toHaveBeenCalledWith(networkError);
    });

    it('应该调用onError回调', () => {
      const onError = jest.fn();
      const config = {
        ...defaultConfig,
        onError
      };

      const { result } = renderHook(() => useErrorHandling(config));
      const error = new Error('Test error');

      act(() => {
        result.current.handleError(error);
      });

      expect(onError).toHaveBeenCalledWith(error, ErrorType.UNKNOWN);
    });
  });

  describe('retry', () => {
    it('应该能够重试操作', async () => {
      const mockOperation = jest.fn().mockResolvedValue('success');
      const { result } = renderHook(() => useErrorHandling(defaultConfig));

      // 先触发一个错误
      act(() => {
        result.current.handleError(new Error('Network error'), mockOperation);
      });

      expect(result.current.canRetry).toBe(true);

      // 执行重试
      await act(async () => {
        await result.current.retry();
      });

      // 快进时间以完成重试延迟
      act(() => {
        jest.advanceTimersByTime(1000);
      });

      expect(result.current.isRetrying).toBe(false);
      expect(result.current.retryCount).toBe(1);
      expect(mockOperation).toHaveBeenCalledTimes(1);
    });

    it('应该在重试失败时递增重试计数', async () => {
      const mockOperation = jest.fn().mockRejectedValue(new Error('Still failing'));
      const { result } = renderHook(() => useErrorHandling(defaultConfig));

      // 先触发一个错误
      act(() => {
        result.current.handleError(new Error('Network error'), mockOperation);
      });

      // 执行重试
      await act(async () => {
        await result.current.retry();
      });

      // 快进时间以完成重试延迟
      act(() => {
        jest.advanceTimersByTime(1000);
      });

      expect(result.current.retryCount).toBe(1);
      expect(result.current.error?.message).toBe('Still failing');
    });

    it('应该在达到最大重试次数时调用onMaxRetriesReached', () => {
      const onMaxRetriesReached = jest.fn();
      const config = {
        ...defaultConfig,
        maxRetries: 1,
        onMaxRetriesReached
      };

      const { result } = renderHook(() => useErrorHandling(config));
      const error = new Error('Network error');

      // 触发错误并达到最大重试次数
      act(() => {
        result.current.handleError(error);
      });

      // 模拟已经重试了最大次数
      act(() => {
        // 手动设置重试计数为最大值
        result.current.handleError(error);
      });

      expect(onMaxRetriesReached).toHaveBeenCalledWith(error);
    });

    it('应该在没有可重试操作时不执行重试', async () => {
      const { result } = renderHook(() => useErrorHandling(defaultConfig));

      await act(async () => {
        await result.current.retry();
      });

      expect(result.current.isRetrying).toBe(false);
      expect(result.current.retryCount).toBe(0);
    });
  });

  describe('clearError', () => {
    it('应该清除错误状态', () => {
      const { result } = renderHook(() => useErrorHandling(defaultConfig));

      // 先设置一个错误
      act(() => {
        result.current.handleError(new Error('Test error'));
      });

      expect(result.current.error).toBeTruthy();

      // 清除错误
      act(() => {
        result.current.clearError();
      });

      expect(result.current.error).toBeNull();
      expect(result.current.errorType).toBeNull();
      expect(result.current.isRetrying).toBe(false);
      expect(result.current.retryCount).toBe(0);
      expect(result.current.canRetry).toBe(false);
      expect(result.current.lastErrorTime).toBeNull();
    });
  });

  describe('safeExecute', () => {
    it('应该安全执行成功的操作', async () => {
      const { result } = renderHook(() => useErrorHandling(defaultConfig));
      const mockOperation = jest.fn().mockResolvedValue('success');

      let operationResult;
      await act(async () => {
        operationResult = await result.current.safeExecute(mockOperation);
      });

      expect(operationResult).toBe('success');
      expect(result.current.error).toBeNull();
      expect(mockOperation).toHaveBeenCalledTimes(1);
    });

    it('应该安全执行失败的操作并返回fallback值', async () => {
      const { result } = renderHook(() => useErrorHandling(defaultConfig));
      const mockOperation = jest.fn().mockRejectedValue(new Error('Operation failed'));
      const fallbackValue = 'fallback';

      let operationResult;
      await act(async () => {
        operationResult = await result.current.safeExecute(mockOperation, fallbackValue);
      });

      expect(operationResult).toBe(fallbackValue);
      expect(result.current.error).toBeTruthy();
      expect(result.current.error?.message).toBe('Operation failed');
    });
  });

  describe('工具方法', () => {
    it('应该正确识别错误类型', () => {
      const { result } = renderHook(() => useErrorHandling(defaultConfig));

      act(() => {
        result.current.handleError(new Error('Network timeout'));
      });

      expect(result.current.isNetworkError()).toBe(true);
      expect(result.current.isAuthError()).toBe(false);
      expect(result.current.isValidationError()).toBe(false);
      expect(result.current.hasError()).toBe(true);
    });

    it('应该返回正确的错误消息', () => {
      const { result } = renderHook(() => useErrorHandling(defaultConfig));
      const errorMessage = 'Test error message';

      act(() => {
        result.current.handleError(new Error(errorMessage));
      });

      expect(result.current.getErrorMessage()).toBe(errorMessage);
    });

    it('应该计算正确的重试延迟', () => {
      const config = {
        ...defaultConfig,
        retryBackoff: true,
        retryDelay: 1000
      };

      const { result } = renderHook(() => useErrorHandling(config));

      // 初始延迟
      expect(result.current.getRetryDelay()).toBe(1000);

      // 模拟重试后的延迟（应该是指数退避）
      act(() => {
        result.current.handleError(new Error('Test'));
      });

      // 第一次重试后的延迟应该是 1000 * 2^1 = 2000
      // 注意：这里需要模拟重试计数的增加
    });
  });

  describe('配置选项', () => {
    it('应该支持禁用重试', () => {
      const config = {
        ...defaultConfig,
        enableRetry: false
      };

      const { result } = renderHook(() => useErrorHandling(config));

      act(() => {
        result.current.handleError(new Error('Network error'));
      });

      expect(result.current.canRetry).toBe(false);
    });

    it('应该支持自定义错误分类器', () => {
      const customErrorClassifier = jest.fn().mockReturnValue(ErrorType.SERVER);
      const config = {
        ...defaultConfig,
        errorClassifier: customErrorClassifier
      };

      const { result } = renderHook(() => useErrorHandling(config));
      const error = new Error('Custom error');

      act(() => {
        result.current.handleError(error);
      });

      expect(customErrorClassifier).toHaveBeenCalledWith(error);
      expect(result.current.errorType).toBe(ErrorType.SERVER);
    });

    it('应该支持自定义重试条件', () => {
      const config = {
        ...defaultConfig,
        maxRetries: 2
      };

      const { result } = renderHook(() => useErrorHandling(config));

      // 触发多次错误以测试重试限制
      act(() => {
        result.current.handleError(new Error('Network error'));
      });

      expect(result.current.canRetry).toBe(true);

      // 模拟达到重试限制
      act(() => {
        // 这里需要模拟重试计数达到最大值的情况
        result.current.handleError(new Error('Network error'));
      });
    });
  });
});
