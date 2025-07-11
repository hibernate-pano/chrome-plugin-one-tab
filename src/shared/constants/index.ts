/**
 * 应用常量定义
 */

// 应用信息
export const APP_CONFIG = {
  name: 'OneTab Plus',
  version: '1.5.12',
  description: 'A better OneTab extension for Chrome',
  homepage: 'https://github.com/yourusername/onetab-plus',
  supportEmail: 'support@onetabplus.com',
} as const;

// 存储键名
export const STORAGE_KEYS = {
  // Chrome扩展存储
  GROUPS: 'onetab_groups',
  SETTINGS: 'onetab_settings',
  LAST_SYNC_TIME: 'onetab_last_sync',
  AUTH_CACHE: 'onetab_auth_cache',
  DEVICE_FINGERPRINT: 'onetab_device_fp',
  WECHAT_OAUTH_STATE: 'wechat_oauth_state',
  WECHAT_LOGIN_START_TIME: 'wechat_login_start_time',
  WECHAT_LOGIN_TIMEOUT_ID: 'wechat_login_timeout_id',
  
  // 本地存储
  THEME_PREFERENCE: 'onetab_theme',
  SYNC_PROMPT_SHOWN: 'onetab_sync_prompt_shown',
} as const;

// URL常量
export const URLS = {
  // OAuth重定向
  OAUTH_REDIRECT: chrome.identity?.getRedirectURL?.() || 'https://localhost',
  
  // 扩展页面
  POPUP: chrome.runtime?.getURL?.('src/popup/index.html') || '',
  OAUTH_CALLBACK: chrome.runtime?.getURL?.('src/pages/oauth-callback.html') || '',
  WECHAT_LOGIN: chrome.runtime?.getURL?.('src/pages/wechat-login.html') || '',
  
  // 外部链接
  GITHUB_REPO: 'https://github.com/yourusername/onetab-plus',
  PRIVACY_POLICY: 'https://onetabplus.com/privacy',
  TERMS_OF_SERVICE: 'https://onetabplus.com/terms',
  HELP_CENTER: 'https://help.onetabplus.com',
} as const;

// 时间常量（毫秒）
export const TIME_CONSTANTS = {
  // 短时间间隔
  DEBOUNCE_DELAY: 300,
  THROTTLE_DELAY: 1000,
  ANIMATION_DURATION: 200,
  
  // 中等时间间隔
  NOTIFICATION_DURATION: 3000,
  TOOLTIP_DELAY: 500,
  AUTO_SAVE_DELAY: 2000,
  
  // 长时间间隔
  SYNC_INTERVAL_MIN: 5 * 60 * 1000, // 5分钟
  SYNC_INTERVAL_DEFAULT: 10 * 60 * 1000, // 10分钟
  SYNC_INTERVAL_MAX: 60 * 60 * 1000, // 1小时
  
  // 超时时间
  API_TIMEOUT: 30 * 1000, // 30秒
  AUTH_SESSION_TIMEOUT: 7 * 24 * 60 * 60 * 1000, // 7天
  CACHE_EXPIRY: 30 * 24 * 60 * 60 * 1000, // 30天
  WECHAT_LOGIN_TIMEOUT: 2 * 60 * 1000, // 2分钟
  
  // 重试间隔
  RETRY_DELAY_BASE: 1000, // 1秒
  RETRY_DELAY_MAX: 60 * 1000, // 60秒
} as const;

// 限制常量
export const LIMITS = {
  // 数据限制
  MAX_GROUPS: 1000,
  MAX_TABS_PER_GROUP: 500,
  MAX_GROUP_NAME_LENGTH: 100,
  MAX_TAB_TITLE_LENGTH: 200,
  MAX_SEARCH_QUERY_LENGTH: 50,
  
  // UI限制
  MAX_RECENT_GROUPS: 10,
  MAX_TOAST_MESSAGES: 5,
  MAX_UNDO_HISTORY: 20,
  
  // 性能限制
  MAX_CONCURRENT_SYNCS: 3,
  MAX_RETRY_ATTEMPTS: 3,
  MAX_PERFORMANCE_HISTORY: 100,
  SLOW_OPERATION_THRESHOLD: 100, // 毫秒
  
  // 文件大小限制
  MAX_IMPORT_FILE_SIZE: 10 * 1024 * 1024, // 10MB
  MAX_EXPORT_FILE_SIZE: 50 * 1024 * 1024, // 50MB
} as const;

// 主题常量
export const THEME = {
  MODES: ['light', 'dark', 'auto'] as const,
  DEFAULT_MODE: 'auto' as const,
  
  COLORS: {
    PRIMARY: {
      50: '#eff6ff',
      100: '#dbeafe',
      500: '#3b82f6',
      600: '#2563eb',
      700: '#1d4ed8',
      900: '#1e3a8a',
    },
    SUCCESS: {
      50: '#f0fdf4',
      500: '#22c55e',
      700: '#15803d',
    },
    WARNING: {
      50: '#fffbeb',
      500: '#f59e0b',
      700: '#a16207',
    },
    ERROR: {
      50: '#fef2f2',
      500: '#ef4444',
      700: '#b91c1c',
    },
  },
} as const;

// 同步常量
export const SYNC = {
  STRATEGIES: ['newest', 'local', 'remote', 'ask'] as const,
  OPERATIONS: ['none', 'upload', 'download', 'merge'] as const,
  STATUSES: ['idle', 'syncing', 'success', 'error'] as const,
  
  DEFAULT_STRATEGY: 'newest' as const,
  DEFAULT_INTERVAL: 10, // 分钟
  
  PRIORITIES: {
    LOW: 1,
    NORMAL: 5,
    HIGH: 8,
    CRITICAL: 10,
  },
} as const;

// 认证常量
export const AUTH = {
  PROVIDERS: ['email', 'google', 'github', 'wechat'] as const,
  STATUSES: ['idle', 'loading', 'authenticated', 'unauthenticated', 'error'] as const,
  
  WECHAT_STATUSES: ['idle', 'pending', 'scanned', 'confirmed', 'expired', 'error'] as const,
  
  DEFAULT_PROVIDER: 'email' as const,
  
  OAUTH_SCOPES: {
    google: ['openid', 'email', 'profile'],
    github: ['user:email'],
    wechat: ['snsapi_login'],
  },
} as const;

// 拖拽常量
export const DRAG_DROP = {
  TYPES: ['tab', 'group'] as const,
  
  // 拖拽阈值
  DRAG_THRESHOLD: 5, // 像素
  HOVER_THRESHOLD: 100, // 毫秒
  
  // 动画时长
  ANIMATION_DURATION: 200, // 毫秒
  
  // 拖拽区域
  DROP_ZONES: {
    GROUP: 'group',
    TAB: 'tab',
    TRASH: 'trash',
  },
} as const;

// 错误类型
export const ERROR_TYPES = {
  NETWORK: 'NETWORK_ERROR',
  AUTH: 'AUTH_ERROR',
  STORAGE: 'STORAGE_ERROR',
  SYNC: 'SYNC_ERROR',
  VALIDATION: 'VALIDATION_ERROR',
  UNKNOWN: 'UNKNOWN_ERROR',
} as const;

// 事件名称
export const EVENTS = {
  // Chrome扩展事件
  TAB_SAVED: 'tab_saved',
  GROUP_CREATED: 'group_created',
  GROUP_DELETED: 'group_deleted',
  SYNC_COMPLETED: 'sync_completed',
  
  // 自定义事件
  THEME_CHANGED: 'theme_changed',
  AUTH_STATE_CHANGED: 'auth_state_changed',
  SETTINGS_UPDATED: 'settings_updated',
} as const;

// 快捷键
export const SHORTCUTS = {
  SAVE_ALL_TABS: 'Alt+Shift+S',
  SAVE_CURRENT_TAB: 'Alt+S',
  OPEN_EXTENSION: 'Ctrl+Shift+S',
  OPEN_EXTENSION_MAC: 'Command+Shift+S',
} as const;

// 导出类型
export type ThemeMode = typeof THEME.MODES[number];
export type SyncStrategy = typeof SYNC.STRATEGIES[number];
export type SyncOperation = typeof SYNC.OPERATIONS[number];
export type SyncStatus = typeof SYNC.STATUSES[number];
export type AuthProvider = typeof AUTH.PROVIDERS[number];
export type AuthStatus = typeof AUTH.STATUSES[number];
export type DragType = typeof DRAG_DROP.TYPES[number];
export type ErrorType = keyof typeof ERROR_TYPES;