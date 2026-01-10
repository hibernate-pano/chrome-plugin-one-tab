export const APP_CONFIG = {
  VERSION: '1.9.7',
  NAME: 'TabVault Pro',
  DESCRIPTION: '一个高效的Chrome标签页管理扩展',
} as const;

export const STORAGE_CONFIG = {
  VERSION: 2,
  KEYS: {
    VERSION: 'storage_version',
    GROUPS: 'tab_groups',
    SETTINGS: 'user_settings',
    DELETED_GROUPS: 'deleted_tab_groups',
    DELETED_TABS: 'deleted_tabs',
    LAST_SYNC_TIME: 'last_sync_time',
    MIGRATION_FLAGS: 'migration_flags',
  } as const,
  CLEANUP_DAYS: 30,
} as const;

export const SYNC_CONFIG = {
  RETRY_COUNT: 3,
  RETRY_DELAY: 200,
  MAX_BATCH_SIZE: 100,
} as const;

export const UI_CONFIG = {
  DEBOUNCE_DELAY: 300,
  TOAST_DURATION: 3000,
  CONFIRM_DURATION: 5000,
  MAX_SUGGESTIONS: 10,
  MIN_SEARCH_LENGTH: 2,
  ANIMATION_DURATION: 150,
} as const;

export const SEARCH_CONFIG = {
  FUZZY_THRESHOLD: 0.4,
  MIN_KEYWORD_LENGTH: 3,
  MAX_SUGGESTIONS: 10,
} as const;

export const THEME_CONFIG = {
  VALID_MODES: ['light', 'dark', 'auto'] as const,
  VALID_STYLES: ['classic', 'refined', 'aurora', 'legacy'] as const,
  DEFAULT_MODE: 'auto' as const,
  DEFAULT_STYLE: 'legacy' as const,
} as const;

export const LAYOUT_CONFIG = {
  MODES: ['single', 'double'] as const,
  DEFAULT_MODE: 'single' as const,
} as const;

export const SYNC_STRATEGY_CONFIG = {
  VALID_STRATEGIES: ['newest', 'local', 'remote', 'ask'] as const,
  DEFAULT_STRATEGY: 'newest' as const,
} as const;

export const DELETE_STRATEGY_CONFIG = {
  VALID_STRATEGIES: ['everywhere', 'local-only'] as const,
  DEFAULT_STRATEGY: 'everywhere' as const,
} as const;

export const VALIDATION_CONFIG = {
  MAX_TABS_PER_GROUP: 500,
  MAX_GROUPS: 1000,
  MAX_NAME_LENGTH: 100,
  MIN_NAME_LENGTH: 1,
} as const;

export const URL_PATTERNS = {
  INTERNAL: ['chrome://', 'chrome-extension://', 'edge://', 'about:', 'loading://'] as const,
  FAVICON: /^(https?:\/\/)/i,
} as const;

export const KEYBOARD_SHORTCUTS = {
  SAVE_TABS: { key: 's', ctrlKey: true, shiftKey: true },
  SEARCH: { key: 'k', ctrlKey: true, shiftKey: true },
  CLEAR_SEARCH: { key: 'Escape' },
  TOGGLE_LAYOUT: { key: 'l', ctrlKey: true, altKey: true },
  CLEAN_DUPLICATES: { key: 'd', ctrlKey: true, altKey: true },
} as const;

export const ERROR_MESSAGES = {
  STORAGE_GET_FAILED: '获取数据失败',
  STORAGE_SET_FAILED: '保存数据失败',
  SYNC_FAILED: '同步失败',
  LOAD_GROUPS_FAILED: '加载标签组失败',
  DELETE_GROUP_FAILED: '删除标签组失败',
  SAVE_TABS_FAILED: '保存标签页失败',
  IMPORT_FAILED: '导入数据失败',
  EXPORT_FAILED: '导出数据失败',
  NETWORK_ERROR: '网络错误',
  AUTH_ERROR: '认证失败',
} as const;

export const SUCCESS_MESSAGES = {
  SAVE_TABS_SUCCESS: '标签页保存成功',
  SYNC_SUCCESS: '同步成功',
  DELETE_SUCCESS: '删除成功',
  IMPORT_SUCCESS: '导入成功',
  EXPORT_SUCCESS: '导出成功',
  CLEAN_SUCCESS: '清理完成',
} as const;

export const TOAST_TYPES = {
  SUCCESS: 'success',
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
} as const;

export const CONFIRM_TYPES = {
  DANGER: 'danger',
  WARNING: 'warning',
  INFO: 'info',
} as const;
