/**
 * 设置领域实体定义
 * 遵循领域驱动设计(DDD)原则，定义设置相关的核心业务实体和值对象
 */

/**
 * 用户设置聚合根 (Aggregate Root)
 * 用户设置是设置领域的聚合根，管理所有用户偏好设置
 */
export interface UserSettings {
  // 聚合根标识
  readonly id: string;
  
  // 关联用户
  userId: string;
  
  // 应用设置
  application: ApplicationSettings;
  
  // 界面设置
  interface: InterfaceSettings;
  
  // 同步设置
  sync: SyncSettings;
  
  // 隐私设置
  privacy: PrivacySettings;
  
  // 通知设置
  notifications: NotificationSettings;
  
  // 高级设置
  advanced: AdvancedSettings;
  
  // 时间戳
  readonly createdAt: string;
  updatedAt: string;
  
  // 版本控制
  version: number;
  
  // 同步状态
  syncInfo: SettingsSyncInfo;
}

/**
 * 应用设置值对象 (Value Object)
 */
export interface ApplicationSettings {
  // 基本行为
  confirmBeforeDelete: boolean;
  allowDuplicateTabs: boolean;
  autoSaveEnabled: boolean;
  autoSaveInterval: number; // minutes
  
  // 标签组设置
  groupNameTemplate: string;
  defaultGroupColor: GroupColor;
  maxTabsPerGroup?: number;
  
  // 搜索设置
  searchHistoryEnabled: boolean;
  maxSearchHistoryItems: number;
  searchSuggestionsEnabled: boolean;
  
  // 导入导出设置
  defaultExportFormat: ExportFormat;
  includeMetadataInExport: boolean;
  compressionEnabled: boolean;
}

/**
 * 界面设置值对象 (Value Object)
 */
export interface InterfaceSettings {
  // 主题设置
  theme: ThemeSettings;
  
  // 布局设置
  layout: LayoutSettings;
  
  // 显示设置
  display: DisplaySettings;
  
  // 交互设置
  interaction: InteractionSettings;
  
  // 可访问性设置
  accessibility: AccessibilitySettings;
}

/**
 * 主题设置值对象 (Value Object)
 */
export interface ThemeSettings {
  mode: ThemeMode;
  customColors?: CustomColorScheme;
  fontSize: FontSize;
  fontFamily: string;
  borderRadius: BorderRadius;
  animations: AnimationSettings;
}

/**
 * 布局设置值对象 (Value Object)
 */
export interface LayoutSettings {
  useDoubleColumnLayout: boolean;
  sidebarPosition: 'left' | 'right';
  sidebarWidth: number; // pixels
  compactMode: boolean;
  showHeader: boolean;
  showFooter: boolean;
}

/**
 * 显示设置值对象 (Value Object)
 */
export interface DisplaySettings {
  showFavicons: boolean;
  showTabCount: boolean;
  showTimestamps: boolean;
  showTooltips: boolean;
  showBadges: boolean;
  itemsPerPage: number;
  thumbnailSize: ThumbnailSize;
}

/**
 * 交互设置值对象 (Value Object)
 */
export interface InteractionSettings {
  doubleClickToOpen: boolean;
  dragAndDropEnabled: boolean;
  keyboardShortcutsEnabled: boolean;
  contextMenuEnabled: boolean;
  hoverEffectsEnabled: boolean;
  clickDelay: number; // milliseconds
}

/**
 * 可访问性设置值对象 (Value Object)
 */
export interface AccessibilitySettings {
  highContrastMode: boolean;
  reducedMotion: boolean;
  screenReaderSupport: boolean;
  keyboardNavigation: boolean;
  focusIndicators: boolean;
  alternativeText: boolean;
}

/**
 * 同步设置值对象 (Value Object)
 */
export interface SyncSettings {
  enabled: boolean;
  autoSyncEnabled: boolean;
  syncInterval: number; // minutes
  strategy: SyncStrategy;
  conflictResolution: ConflictResolutionStrategy;
  dataTypes: SyncDataTypeSettings;
  conditions: SyncConditionSettings;
}

/**
 * 隐私设置值对象 (Value Object)
 */
export interface PrivacySettings {
  dataCollection: DataCollectionSettings;
  sharing: DataSharingSettings;
  retention: DataRetentionSettings;
  encryption: EncryptionSettings;
}

/**
 * 通知设置值对象 (Value Object)
 */
export interface NotificationSettings {
  enabled: boolean;
  types: NotificationTypeSettings;
  delivery: NotificationDeliverySettings;
  schedule: NotificationScheduleSettings;
}

/**
 * 高级设置值对象 (Value Object)
 */
export interface AdvancedSettings {
  performance: PerformanceSettings;
  debugging: DebuggingSettings;
  experimental: ExperimentalSettings;
  developer: DeveloperSettings;
}

/**
 * 自定义颜色方案值对象 (Value Object)
 */
export interface CustomColorScheme {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  surface: string;
  text: string;
  border: string;
}

/**
 * 动画设置值对象 (Value Object)
 */
export interface AnimationSettings {
  enabled: boolean;
  duration: AnimationDuration;
  easing: AnimationEasing;
  reducedMotion: boolean;
}

/**
 * 同步数据类型设置值对象 (Value Object)
 */
export interface SyncDataTypeSettings {
  tabGroups: boolean;
  tabs: boolean;
  settings: boolean;
  searchHistory: boolean;
  userProfile: boolean;
}

/**
 * 同步条件设置值对象 (Value Object)
 */
export interface SyncConditionSettings {
  wifiOnly: boolean;
  batteryLevel: number; // percentage
  storageSpace: number; // MB
  timeRestrictions: TimeRestriction[];
}

/**
 * 数据收集设置值对象 (Value Object)
 */
export interface DataCollectionSettings {
  analytics: boolean;
  crashReports: boolean;
  performanceMetrics: boolean;
  usageStatistics: boolean;
  diagnostics: boolean;
}

/**
 * 数据共享设置值对象 (Value Object)
 */
export interface DataSharingSettings {
  thirdPartyServices: boolean;
  researchPurposes: boolean;
  productImprovement: boolean;
  marketing: boolean;
}

/**
 * 数据保留设置值对象 (Value Object)
 */
export interface DataRetentionSettings {
  tabHistory: number; // days
  searchHistory: number; // days
  syncHistory: number; // days
  errorLogs: number; // days
  automaticCleanup: boolean;
}

/**
 * 加密设置值对象 (Value Object)
 */
export interface EncryptionSettings {
  enabled: boolean;
  algorithm: EncryptionAlgorithm;
  keyRotation: boolean;
  localEncryption: boolean;
  transitEncryption: boolean;
}

/**
 * 通知类型设置值对象 (Value Object)
 */
export interface NotificationTypeSettings {
  sync: boolean;
  errors: boolean;
  updates: boolean;
  reminders: boolean;
  achievements: boolean;
}

/**
 * 通知传递设置值对象 (Value Object)
 */
export interface NotificationDeliverySettings {
  browser: boolean;
  email: boolean;
  push: boolean;
  sound: boolean;
  vibration: boolean;
}

/**
 * 通知计划设置值对象 (Value Object)
 */
export interface NotificationScheduleSettings {
  quietHours: {
    enabled: boolean;
    start: string; // HH:mm
    end: string; // HH:mm
  };
  weekends: boolean;
  timezone: string;
}

/**
 * 性能设置值对象 (Value Object)
 */
export interface PerformanceSettings {
  cacheSize: number; // MB
  maxConcurrentOperations: number;
  backgroundProcessing: boolean;
  memoryOptimization: boolean;
  networkOptimization: boolean;
}

/**
 * 调试设置值对象 (Value Object)
 */
export interface DebuggingSettings {
  enabled: boolean;
  logLevel: LogLevel;
  verboseLogging: boolean;
  performanceMonitoring: boolean;
  errorReporting: boolean;
}

/**
 * 实验性设置值对象 (Value Object)
 */
export interface ExperimentalSettings {
  enabled: boolean;
  features: Record<string, boolean>;
  betaUpdates: boolean;
  feedbackCollection: boolean;
}

/**
 * 开发者设置值对象 (Value Object)
 */
export interface DeveloperSettings {
  devMode: boolean;
  apiEndpoint?: string;
  debugConsole: boolean;
  mockData: boolean;
  testMode: boolean;
}

/**
 * 时间限制值对象 (Value Object)
 */
export interface TimeRestriction {
  days: number[]; // 0-6 (Sunday-Saturday)
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  timezone: string;
}

/**
 * 设置同步信息值对象 (Value Object)
 */
export interface SettingsSyncInfo {
  lastSyncedAt?: string;
  syncVersion: number;
  conflictCount: number;
  pendingChanges: string[];
}

/**
 * 枚举类型定义
 */

/**
 * 主题模式枚举
 */
export enum ThemeMode {
  LIGHT = 'light',
  DARK = 'dark',
  AUTO = 'auto',
  CUSTOM = 'custom'
}

/**
 * 字体大小枚举
 */
export enum FontSize {
  SMALL = 'small',
  MEDIUM = 'medium',
  LARGE = 'large',
  EXTRA_LARGE = 'extra-large'
}

/**
 * 边框圆角枚举
 */
export enum BorderRadius {
  NONE = 'none',
  SMALL = 'small',
  MEDIUM = 'medium',
  LARGE = 'large',
  FULL = 'full'
}

/**
 * 动画持续时间枚举
 */
export enum AnimationDuration {
  FAST = 'fast',
  NORMAL = 'normal',
  SLOW = 'slow',
  DISABLED = 'disabled'
}

/**
 * 动画缓动枚举
 */
export enum AnimationEasing {
  LINEAR = 'linear',
  EASE = 'ease',
  EASE_IN = 'ease-in',
  EASE_OUT = 'ease-out',
  EASE_IN_OUT = 'ease-in-out'
}

/**
 * 缩略图大小枚举
 */
export enum ThumbnailSize {
  SMALL = 'small',
  MEDIUM = 'medium',
  LARGE = 'large',
  DISABLED = 'disabled'
}

/**
 * 标签组颜色枚举
 */
export enum GroupColor {
  BLUE = 'blue',
  GREEN = 'green',
  RED = 'red',
  YELLOW = 'yellow',
  PURPLE = 'purple',
  PINK = 'pink',
  INDIGO = 'indigo',
  GRAY = 'gray'
}

/**
 * 导出格式枚举
 */
export enum ExportFormat {
  JSON = 'json',
  CSV = 'csv',
  HTML = 'html',
  MARKDOWN = 'markdown',
  XML = 'xml'
}

/**
 * 同步策略枚举
 */
export enum SyncStrategy {
  AUTOMATIC = 'automatic',
  MANUAL = 'manual',
  SCHEDULED = 'scheduled',
  REAL_TIME = 'real-time'
}

/**
 * 冲突解决策略枚举
 */
export enum ConflictResolutionStrategy {
  LOCAL_WINS = 'local-wins',
  REMOTE_WINS = 'remote-wins',
  NEWEST_WINS = 'newest-wins',
  MANUAL = 'manual'
}

/**
 * 加密算法枚举
 */
export enum EncryptionAlgorithm {
  AES_256 = 'aes-256',
  AES_128 = 'aes-128',
  RSA_2048 = 'rsa-2048',
  RSA_4096 = 'rsa-4096'
}

/**
 * 日志级别枚举
 */
export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug',
  TRACE = 'trace'
}

/**
 * 领域事件定义
 */

/**
 * 基础领域事件接口
 */
export interface DomainEvent {
  readonly id: string;
  readonly type: string;
  readonly aggregateId: string;
  readonly timestamp: string;
  readonly version: number;
  readonly data: Record<string, any>;
}

/**
 * 设置相关事件
 */
export interface SettingsUpdatedEvent extends DomainEvent {
  type: 'SettingsUpdated';
  data: {
    userId: string;
    changes: Partial<UserSettings>;
    previousSettings: UserSettings;
  };
}

export interface ThemeChangedEvent extends DomainEvent {
  type: 'ThemeChanged';
  data: {
    userId: string;
    newTheme: ThemeSettings;
    previousTheme: ThemeSettings;
  };
}

export interface SyncSettingsChangedEvent extends DomainEvent {
  type: 'SyncSettingsChanged';
  data: {
    userId: string;
    newSyncSettings: SyncSettings;
    previousSyncSettings: SyncSettings;
  };
}

/**
 * 创建数据传输对象
 */
export interface CreateUserSettingsData {
  userId: string;
  application?: Partial<ApplicationSettings>;
  interface?: Partial<InterfaceSettings>;
  sync?: Partial<SyncSettings>;
  privacy?: Partial<PrivacySettings>;
  notifications?: Partial<NotificationSettings>;
  advanced?: Partial<AdvancedSettings>;
}

/**
 * 查询对象
 */
export interface UserSettingsQuery {
  userId?: string;
  version?: number;
  dateRange?: {
    start: string;
    end: string;
  };
  limit?: number;
  offset?: number;
  sortBy?: 'createdAt' | 'updatedAt' | 'version';
  sortOrder?: 'asc' | 'desc';
}

/**
 * 仓储接口定义
 */
export interface UserSettingsRepository {
  findById(id: string): Promise<UserSettings | null>;
  findByUserId(userId: string): Promise<UserSettings | null>;
  findByQuery(query: UserSettingsQuery): Promise<UserSettings[]>;
  save(settings: UserSettings): Promise<void>;
  delete(id: string): Promise<void>;
  count(query?: UserSettingsQuery): Promise<number>;
}

/**
 * 领域服务接口
 */
export interface SettingsDomainService {
  createUserSettings(data: CreateUserSettingsData): Promise<UserSettings>;
  updateUserSettings(id: string, updates: Partial<UserSettings>): Promise<UserSettings>;
  resetUserSettings(userId: string): Promise<UserSettings>;
  validateSettings(settings: UserSettings): ValidationResult;
  migrateSettings(settings: UserSettings, targetVersion: number): Promise<UserSettings>;
}

/**
 * 验证结果接口
 */
export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  field: string;
  message: string;
  code: string;
}

export interface ValidationWarning {
  field: string;
  message: string;
  code: string;
}

/**
 * 工厂接口
 */
export interface UserSettingsFactory {
  createUserSettings(data: CreateUserSettingsData): UserSettings;
  createDefaultSettings(userId: string): UserSettings;
}
