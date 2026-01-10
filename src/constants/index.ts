/**
 * 应用常量定义
 * 集中管理所有常量值
 */

// ==================== 存储相关 ====================

export const STORAGE_KEYS = {
  GROUPS: 'tabGroups',
  SETTINGS: 'userSettings',
  LAST_SYNC_TIME: 'lastSyncTime',
  AUTH_TOKEN: 'authToken',
  USER_ID: 'userId',
} as const;

// ==================== 同步相关 ====================

export const SYNC_STATUS = {
  IDLE: 'idle',
  SYNCING: 'syncing',
  SUCCESS: 'success',
  ERROR: 'error',
} as const;

export const SYNC_OPERATION = {
  NONE: 'none',
  UPLOAD: 'upload',
  DOWNLOAD: 'download',
} as const;

export const SYNC_STRATEGY = {
  NEWEST: 'newest',
  LOCAL: 'local',
  REMOTE: 'remote',
  ASK: 'ask',
} as const;

// ==================== 主题相关 ====================

export const THEME_MODE = {
  LIGHT: 'light',
  DARK: 'dark',
  AUTO: 'auto',
} as const;

export const THEME_STYLE = {
  CLASSIC: 'classic',
  REFINED: 'refined',
  AURORA: 'aurora',
  LEGACY: 'legacy',
} as const;

// ==================== 布局相关 ====================

export const LAYOUT_MODE = {
  SINGLE: 'single',
  DOUBLE: 'double',
} as const;

// ==================== 快捷键相关 ====================

export const KEYBOARD_SHORTCUTS = {
  SAVE_ALL_TABS: 'Alt+Shift+S',
  SAVE_CURRENT_TAB: 'Alt+S',
  OPEN_POPUP: 'Ctrl+Shift+S', // Mac: Cmd+Shift+S
} as const;

// ==================== 动画时长 ====================

export const ANIMATION_DURATION = {
  FAST: 150,
  NORMAL: 300,
  SLOW: 500,
} as const;

// ==================== 性能相关 ====================

export const PERFORMANCE = {
  DEBOUNCE_DELAY: 300,
  THROTTLE_DELAY: 100,
  VIRTUAL_LIST_ITEM_HEIGHT: 40,
  VIRTUAL_LIST_OVERSCAN: 5,
  MAX_VISIBLE_TABS: 100,
  SEARCH_MIN_LENGTH: 2,
} as const;

// ==================== 限制相关 ====================

export const LIMITS = {
  MAX_GROUP_NAME_LENGTH: 100,
  MAX_TABS_PER_GROUP: 1000,
  MAX_GROUPS: 500,
  MAX_SEARCH_RESULTS: 50,
} as const;

// ==================== URL 模式 ====================

export const URL_PATTERNS = {
  CHROME_INTERNAL: /^chrome:\/\//,
  CHROME_EXTENSION: /^chrome-extension:\/\//,
  NEW_TAB: /^chrome:\/\/newtab/,
  LOADING: /^loading:\/\//,
  INVALID: /^(about:|data:|javascript:|file:)/,
} as const;

// ==================== 默认值 ====================

export const DEFAULTS = {
  GROUP_NAME_TEMPLATE: '{date} - {count} tabs',
  THEME_MODE: THEME_MODE.AUTO,
  THEME_STYLE: THEME_STYLE.LEGACY,
  LAYOUT_MODE: LAYOUT_MODE.SINGLE,
  SYNC_STRATEGY: SYNC_STRATEGY.NEWEST,
} as const;
