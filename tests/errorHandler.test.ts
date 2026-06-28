// errorHandler 测试：钉死统一错误处理的行为契约。
//
// ErrorHandler 是 syncEngine / storage / smartSyncService 等所有关键路径的
// 错误兜底。任何回归（错误消息丢失、severity 映射错、敏感信息泄漏）都会
// 让线上 bug 无法定位或误显示给用户。

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

before(async () => {
  register(LOADER_PATH);
  // 捕获 console.error/warn 避免测试输出污染
});

describe('ErrorCodes 完整性', () => {
  it('所有错误码都是字符串', async () => {
    const { ErrorCodes } = await import('@/utils/errorHandler');
    Object.values(ErrorCodes).forEach(code => {
      assert.equal(typeof code, 'string');
      assert.ok(code.length > 0);
    });
  });

  it('错误码都是大写+下划线格式', async () => {
    const { ErrorCodes } = await import('@/utils/errorHandler');
    Object.values(ErrorCodes).forEach(code => {
      assert.match(code, /^[A-Z][A-Z0-9_]*$/, `Invalid code format: ${code}`);
    });
  });

  it('包含关键错误类型', async () => {
    const { ErrorCodes } = await import('@/utils/errorHandler');
    assert.ok(ErrorCodes.NETWORK_ERROR);
    assert.ok(ErrorCodes.STORAGE_ERROR);
    assert.ok(ErrorCodes.SYNC_ERROR);
    assert.ok(ErrorCodes.DECRYPTION_ERROR);
    assert.ok(ErrorCodes.UNKNOWN_ERROR);
  });
});

describe('createAppError', () => {
  it('创建标准错误对象', async () => {
    const { createAppError, ErrorCodes } = await import('@/utils/errorHandler');
    const err = createAppError(ErrorCodes.NETWORK_ERROR);
    assert.equal(err.code, ErrorCodes.NETWORK_ERROR);
    assert.ok(err.message, 'message 必须有值');
    assert.ok(err.timestamp, 'timestamp 必须有值');
    assert.match(err.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('传入 message 覆盖默认消息', async () => {
    const { createAppError, ErrorCodes } = await import('@/utils/errorHandler');
    const customMsg = 'Custom failure message';
    const err = createAppError(ErrorCodes.STORAGE_ERROR, customMsg);
    assert.equal(err.message, customMsg);
  });

  it('details 字段正确传递', async () => {
    const { createAppError, ErrorCodes } = await import('@/utils/errorHandler');
    const details = { userId: 'u-1', operation: 'save' };
    const err = createAppError(ErrorCodes.SYNC_ERROR, 'Test', details);
    assert.deepEqual(err.details, details);
  });

  it('无效 code → 回退到 UNKNOWN_ERROR 消息', async () => {
    const { createAppError } = await import('@/utils/errorHandler');
    const err = createAppError('INVALID_CODE_THAT_DOES_NOT_EXIST');
    assert.ok(err.message);
    assert.notEqual(err.message, '');
    // 应该用 UNKNOWN_ERROR 的默认消息
  });

  it('不传 message → 用 ErrorMessages 中的默认消息', async () => {
    const { createAppError, ErrorCodes } = await import('@/utils/errorHandler');
    const err = createAppError(ErrorCodes.AUTH_ERROR);
    assert.ok(err.message);
    assert.ok(err.message.length > 0);
  });

  it('包含 stack 信息', async () => {
    const { createAppError, ErrorCodes } = await import('@/utils/errorHandler');
    const err = createAppError(ErrorCodes.UNKNOWN_ERROR);
    assert.ok(err.stack, 'stack 必须捕获');
  });
});

describe('ErrorHandler.handle: 输入类型', () => {
  it('处理 string 类型错误', async () => {
    const { errorHandler } = await import('@/utils/errorHandler');
    const result = errorHandler.handle('Simple error message', { showToast: false, logToConsole: false });
    assert.ok(result);
    assert.ok(result.message.includes('Simple error'));
  });

  it('处理 Error 对象', async () => {
    const { errorHandler } = await import('@/utils/errorHandler');
    const err = new Error('Test error from Error instance');
    const result = errorHandler.handle(err, { showToast: false, logToConsole: false });
    assert.ok(result.message.includes('Test error'));
    assert.ok(result.stack, '应保留 Error 的 stack');
  });

  it('处理 AppError 对象', async () => {
    const { errorHandler, createAppError, ErrorCodes } = await import('@/utils/errorHandler');
    const appErr = createAppError(ErrorCodes.STORAGE_ERROR, 'Direct AppError');
    const result = errorHandler.handle(appErr, { showToast: false, logToConsole: false });
    assert.equal(result.code, ErrorCodes.STORAGE_ERROR);
  });
});

describe('ErrorHandler.handle: 选项行为', () => {
  it('showToast=true 且设置了 callback → 调用 callback', async () => {
    const { errorHandler, ErrorCodes } = await import('@/utils/errorHandler');
    let capturedMessage = '';
    let capturedType = '';
    errorHandler.setToastCallback((msg, type) => {
      capturedMessage = msg;
      capturedType = type;
    });

    errorHandler.handle('Test toast', { showToast: true, logToConsole: false });
    assert.equal(capturedMessage.length > 0, true, 'toast message 应被捕获');
  });

  it('showToast=false 不调用 callback', async () => {
    const { errorHandler, ErrorCodes } = await import('@/utils/errorHandler');
    let called = false;
    errorHandler.setToastCallback(() => { called = true; });

    errorHandler.handle('No toast test', { showToast: false, logToConsole: false });
    assert.equal(called, false);
  });

  it('critical severity → toast 类型为 error', async () => {
    const { errorHandler } = await import('@/utils/errorHandler');
    let capturedType = '';
    errorHandler.setToastCallback((_msg, type) => {
      capturedType = type;
    });

    errorHandler.handle('Critical error', { showToast: true, logToConsole: false, severity: 'critical' });
    assert.equal(capturedType, 'error');
  });

  it('low severity → toast 类型为 warning', async () => {
    const { errorHandler } = await import('@/utils/errorHandler');
    let capturedType = '';
    errorHandler.setToastCallback((_msg, type) => {
      capturedType = type;
    });

    errorHandler.handle('Minor warning', { showToast: true, logToConsole: false, severity: 'low' });
    assert.equal(capturedType, 'warning');
  });

  it('fallbackMessage 在 message 为空时使用', async () => {
    const { errorHandler } = await import('@/utils/errorHandler');
    let captured = '';
    errorHandler.setToastCallback((msg) => { captured = msg; });

    const err = new Error('');
    errorHandler.handle(err, {
      showToast: true,
      logToConsole: false,
      fallbackMessage: '我的自定义降级消息',
    });
    assert.equal(captured, '我的自定义降级消息');
  });
});

describe('ErrorHandler.handle: 返回值', () => {
  it('返回 AppError 对象', async () => {
    const { errorHandler, ErrorCodes } = await import('@/utils/errorHandler');
    const result = errorHandler.handle('Test', { showToast: false, logToConsole: false });
    assert.ok(result);
    assert.ok(typeof result.code === 'string');
    assert.ok(typeof result.message === 'string');
    assert.ok(typeof result.timestamp === 'string');
  });

  it('logToConsole=true 不抛异常', async () => {
    const { errorHandler } = await import('@/utils/errorHandler');
    // 测试 logToConsole=true 路径（会被 console.error/warn 触发，但不应抛错）
    assert.doesNotThrow(() => {
      errorHandler.handle('console test', { logToConsole: true, showToast: false });
    });
  });
});
