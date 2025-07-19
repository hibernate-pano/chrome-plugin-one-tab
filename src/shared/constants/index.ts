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

// 性能常量
export const PERFORMANCE = {
  // 渲染性能阈值
  RENDER_WARNING_THRESHOLD: 16, // 60fps
  RENDER_ERROR_THRESHOLD: 33, // 30fps
  SLOW_OPERATION_THRESHOLD: 100, // 毫秒

  // 内存使用阈值
  MEMORY_WARNING_THRESHOLD: 70, // 百分比
  MEMORY_CRITICAL_THRESHOLD: 90, // 百分比

  // 缓存配置
  DEFAULT_CACHE_SIZE: 100,
  MAX_CACHE_SIZE: 1000,
  CACHE_CLEANUP_INTERVAL: 5 * 60 * 1000, // 5分钟

  // 虚拟化配置
  VIRTUAL_LIST_OVERSCAN: 5,
  VIRTUAL_LIST_ITEM_HEIGHT: 50,
  VIRTUAL_GRID_ITEM_WIDTH: 320,
  VIRTUAL_GRID_ITEM_HEIGHT: 240,

  // 监控配置
  PERFORMANCE_HISTORY_SIZE: 100,
  RENDER_STATS_SAMPLE_SIZE: 50,
} as const;

// 搜索常量
export const SEARCH = {
  // 搜索配置
  MIN_SEARCH_LENGTH: 2,
  MAX_SEARCH_RESULTS: 50,
  SEARCH_DEBOUNCE_DELAY: 300,

  // 相似度阈值
  FUZZY_MATCH_THRESHOLD: 0.5,
  SIMILARITY_THRESHOLD: 0.3,

  // 高亮样式
  HIGHLIGHT_CLASS: 'search-highlight',

  // 搜索历史
  MAX_SEARCH_HISTORY: 20,
  SEARCH_HISTORY_STORAGE_KEY: 'search_history',
} as const;

// UI常量
export const UI = {
  // 动画时长
  ANIMATION_FAST: 150,
  ANIMATION_NORMAL: 200,
  ANIMATION_SLOW: 300,

  // 延迟时间
  TOOLTIP_DELAY: 500,
  HOVER_DELAY: 100,
  DEBOUNCE_DELAY: 300,
  THROTTLE_DELAY: 1000,

  // 尺寸
  SIDEBAR_WIDTH: 280,
  HEADER_HEIGHT: 60,
  FOOTER_HEIGHT: 40,

  // 间距
  SPACING_XS: 4,
  SPACING_SM: 8,
  SPACING_MD: 16,
  SPACING_LG: 24,
  SPACING_XL: 32,

  // 圆角
  BORDER_RADIUS_SM: 4,
  BORDER_RADIUS_MD: 8,
  BORDER_RADIUS_LG: 12,

  // 阴影层级
  Z_INDEX_DROPDOWN: 1000,
  Z_INDEX_MODAL: 1050,
  Z_INDEX_TOOLTIP: 1100,
  Z_INDEX_NOTIFICATION: 1200,
} as const;

// 验证常量
export const VALIDATION = {
  // URL验证
  URL_PATTERN: /^https?:\/\/.+/,

  // 邮箱验证
  EMAIL_PATTERN: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,

  // 长度限制
  MIN_PASSWORD_LENGTH: 8,
  MAX_PASSWORD_LENGTH: 128,
  MIN_USERNAME_LENGTH: 3,
  MAX_USERNAME_LENGTH: 30,

  // 特殊字符
  SPECIAL_CHARS_PATTERN: /[!@#$%^&*(),.?":{}|<>]/,

  // 文件类型
  ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  ALLOWED_EXPORT_FORMATS: ['json', 'csv', 'html', 'txt'],
  ALLOWED_IMPORT_FORMATS: ['json', 'html', 'csv'],
} as const;

// 网络常量
export const NETWORK = {
  // HTTP状态码
  STATUS_OK: 200,
  STATUS_CREATED: 201,
  STATUS_NO_CONTENT: 204,
  STATUS_BAD_REQUEST: 400,
  STATUS_UNAUTHORIZED: 401,
  STATUS_FORBIDDEN: 403,
  STATUS_NOT_FOUND: 404,
  STATUS_CONFLICT: 409,
  STATUS_INTERNAL_ERROR: 500,
  STATUS_SERVICE_UNAVAILABLE: 503,

  // 请求头
  CONTENT_TYPE_JSON: 'application/json',
  CONTENT_TYPE_FORM: 'application/x-www-form-urlencoded',
  CONTENT_TYPE_MULTIPART: 'multipart/form-data',

  // 超时配置
  DEFAULT_TIMEOUT: 30000, // 30秒
  UPLOAD_TIMEOUT: 120000, // 2分钟
  DOWNLOAD_TIMEOUT: 300000, // 5分钟

  // 重试配置
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000,
  RETRY_BACKOFF_FACTOR: 2,
} as const;

// 导出CSS类名常量
export * from './cssClasses';

// 导出反馈消息常量
export * from './feedbackMessages';

// 导出类型
export type ThemeMode = typeof THEME.MODES[number];
export type SyncStrategy = typeof SYNC.STRATEGIES[number];
export type SyncOperation = typeof SYNC.OPERATIONS[number];
export type SyncStatus = typeof SYNC.STATUSES[number];
export type AuthProvider = typeof AUTH.PROVIDERS[number];
export type AuthStatus = typeof AUTH.STATUSES[number];
export type DragType = typeof DRAG_DROP.TYPES[number];
export type ErrorType = keyof typeof ERROR_TYPES;