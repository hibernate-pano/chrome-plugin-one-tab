/**
 * Jest测试环境设置
 * 配置全局测试环境和模拟对象
 */

import '@testing-library/jest-dom';
import { TextEncoder, TextDecoder } from 'util';

// 全局变量设置
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

// Chrome扩展API模拟
const mockChrome = {
  runtime: {
    id: 'test-extension-id',
    getManifest: jest.fn(() => ({
      version: '1.5.12',
      name: 'OneTab Plus'
    })),
    sendMessage: jest.fn(),
    onMessage: {
      addListener: jest.fn(),
      removeListener: jest.fn()
    },
    lastError: null
  },
  storage: {
    local: {
      get: jest.fn((keys, callback) => {
        callback({});
      }),
      set: jest.fn((items, callback) => {
        if (callback) callback();
      }),
      remove: jest.fn((keys, callback) => {
        if (callback) callback();
      }),
      clear: jest.fn((callback) => {
        if (callback) callback();
      })
    },
    sync: {
      get: jest.fn((keys, callback) => {
        callback({});
      }),
      set: jest.fn((items, callback) => {
        if (callback) callback();
      }),
      remove: jest.fn((keys, callback) => {
        if (callback) callback();
      }),
      clear: jest.fn((callback) => {
        if (callback) callback();
      })
    }
  },
  tabs: {
    query: jest.fn((queryInfo, callback) => {
      callback([]);
    }),
    create: jest.fn((createProperties, callback) => {
      if (callback) callback({ id: 1, url: createProperties.url });
    }),
    remove: jest.fn((tabIds, callback) => {
      if (callback) callback();
    }),
    update: jest.fn((tabId, updateProperties, callback) => {
      if (callback) callback({ id: tabId, ...updateProperties });
    })
  },
  windows: {
    getCurrent: jest.fn((callback) => {
      callback({ id: 1, focused: true });
    }),
    getAll: jest.fn((callback) => {
      callback([{ id: 1, focused: true }]);
    })
  },
  action: {
    setBadgeText: jest.fn(),
    setBadgeBackgroundColor: jest.fn()
  }
};

// 设置全局chrome对象
Object.defineProperty(global, 'chrome', {
  value: mockChrome,
  writable: true
});

// 模拟IntersectionObserver
global.IntersectionObserver = class IntersectionObserver {
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.options = options;
  }

  callback: IntersectionObserverCallback;
  options?: IntersectionObserverInit;

  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
};

// 模拟ResizeObserver
global.ResizeObserver = class ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  callback: ResizeObserverCallback;

  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
};

// 模拟matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(), // deprecated
    removeListener: jest.fn(), // deprecated
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

// 模拟localStorage
const localStorageMock = {
  getItem: jest.fn((key: string) => null),
  setItem: jest.fn((key: string, value: string) => {}),
  removeItem: jest.fn((key: string) => {}),
  clear: jest.fn(() => {}),
  length: 0,
  key: jest.fn((index: number) => null)
};

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock
});

// 模拟sessionStorage
Object.defineProperty(window, 'sessionStorage', {
  value: localStorageMock
});

// 模拟URL.createObjectURL
Object.defineProperty(URL, 'createObjectURL', {
  writable: true,
  value: jest.fn(() => 'mocked-object-url')
});

Object.defineProperty(URL, 'revokeObjectURL', {
  writable: true,
  value: jest.fn()
});

// 模拟fetch
global.fetch = jest.fn(() =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
    blob: () => Promise.resolve(new Blob()),
  })
) as jest.Mock;

// 模拟crypto
Object.defineProperty(global, 'crypto', {
  value: {
    getRandomValues: jest.fn((arr: any) => {
      for (let i = 0; i < arr.length; i++) {
        arr[i] = Math.floor(Math.random() * 256);
      }
      return arr;
    }),
    randomUUID: jest.fn(() => 'mocked-uuid'),
    subtle: {
      generateKey: jest.fn(),
      importKey: jest.fn(),
      exportKey: jest.fn(),
      encrypt: jest.fn(),
      decrypt: jest.fn(),
      sign: jest.fn(),
      verify: jest.fn(),
      digest: jest.fn(),
      deriveBits: jest.fn(),
      deriveKey: jest.fn(),
      wrapKey: jest.fn(),
      unwrapKey: jest.fn()
    }
  }
});

// 模拟performance
Object.defineProperty(global, 'performance', {
  value: {
    now: jest.fn(() => Date.now()),
    mark: jest.fn(),
    measure: jest.fn(),
    getEntriesByName: jest.fn(() => []),
    getEntriesByType: jest.fn(() => []),
    clearMarks: jest.fn(),
    clearMeasures: jest.fn()
  }
});

// 模拟requestAnimationFrame
global.requestAnimationFrame = jest.fn((callback) => {
  setTimeout(callback, 16);
  return 1;
});

global.cancelAnimationFrame = jest.fn();

// 模拟requestIdleCallback
global.requestIdleCallback = jest.fn((callback) => {
  setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 50 }), 1);
  return 1;
});

global.cancelIdleCallback = jest.fn();

// 控制台输出过滤
const originalError = console.error;
const originalWarn = console.warn;

console.error = (...args: any[]) => {
  // 过滤掉一些已知的测试警告
  const message = args[0];
  if (
    typeof message === 'string' &&
    (
      message.includes('Warning: ReactDOM.render is no longer supported') ||
      message.includes('Warning: validateDOMNesting') ||
      message.includes('Warning: Each child in a list should have a unique "key" prop')
    )
  ) {
    return;
  }
  originalError.apply(console, args);
};

console.warn = (...args: any[]) => {
  const message = args[0];
  if (
    typeof message === 'string' &&
    (
      message.includes('componentWillReceiveProps has been renamed') ||
      message.includes('componentWillMount has been renamed')
    )
  ) {
    return;
  }
  originalWarn.apply(console, args);
};

// 测试工具函数
export const testUtils = {
  // 等待异步操作完成
  waitFor: (ms: number = 0) => new Promise(resolve => setTimeout(resolve, ms)),
  
  // 模拟用户交互
  mockUserInteraction: () => {
    // 模拟用户激活状态
    Object.defineProperty(document, 'hasFocus', {
      value: jest.fn(() => true)
    });
  },
  
  // 清理所有模拟
  clearAllMocks: () => {
    jest.clearAllMocks();
    localStorageMock.getItem.mockClear();
    localStorageMock.setItem.mockClear();
    localStorageMock.removeItem.mockClear();
    localStorageMock.clear.mockClear();
  },
  
  // 模拟Chrome扩展环境
  mockChromeExtension: () => {
    return mockChrome;
  }
};

// 全局测试钩子
beforeEach(() => {
  // 清理DOM
  document.body.innerHTML = '';
  
  // 重置模拟
  jest.clearAllMocks();
  
  // 重置localStorage
  localStorageMock.getItem.mockClear();
  localStorageMock.setItem.mockClear();
  localStorageMock.removeItem.mockClear();
  localStorageMock.clear.mockClear();
});

afterEach(() => {
  // 清理定时器
  jest.clearAllTimers();
  
  // 清理事件监听器
  document.removeEventListener = jest.fn();
  window.removeEventListener = jest.fn();
});

// 导出测试工具
export { mockChrome };
export default testUtils;
