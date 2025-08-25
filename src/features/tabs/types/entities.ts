/**
 * 标签管理领域实体定义
 * 遵循领域驱动设计(DDD)原则，定义核心业务实体和值对象
 */

/**
 * 标签实体 (Entity)
 * 标签是系统中的基本实体，具有唯一标识和生命周期
 */
export interface Tab {
  // 实体标识
  readonly id: string;
  
  // 核心属性
  url: string;
  title: string;
  favIconUrl?: string;
  
  // 时间戳
  readonly createdAt: string;
  lastAccessedAt: string;
  
  // 关联关系
  groupId?: string;
  
  // 元数据
  metadata: TabMetadata;
  
  // 同步状态
  syncInfo: SyncInfo;
}

/**
 * 标签组聚合根 (Aggregate Root)
 * 标签组是聚合根，管理其包含的标签集合
 */
export interface TabGroup {
  // 聚合根标识
  readonly id: string;
  
  // 核心属性
  name: string;
  description?: string;
  color: GroupColor;
  
  // 标签集合
  tabs: Tab[];
  
  // 时间戳
  readonly createdAt: string;
  updatedAt: string;
  
  // 业务规则
  isLocked: boolean;
  maxTabCount?: number;
  
  // 排序和显示
  order: number;
  isCollapsed: boolean;
  
  // 元数据
  metadata: GroupMetadata;
  
  // 同步状态
  syncInfo: SyncInfo;
  
  // 统计信息
  statistics: GroupStatistics;
}

/**
 * 标签元数据值对象 (Value Object)
 */
export interface TabMetadata {
  // 网站信息
  domain?: string;
  protocol?: string;
  
  // 用户行为
  visitCount: number;
  lastVisitDuration?: number;
  
  // 标记和分类
  tags: string[];
  isBookmarked: boolean;
  isPinned: boolean;
  
  // 技术信息
  userAgent?: string;
  viewport?: {
    width: number;
    height: number;
  };
  
  // 自定义属性
  customProperties: Record<string, any>;
}

/**
 * 标签组元数据值对象 (Value Object)
 */
export interface GroupMetadata {
  // 创建信息
  createdBy: string;
  createdFrom: 'manual' | 'auto-save' | 'import' | 'sync';
  
  // 分类信息
  category?: string;
  tags: string[];
  
  // 使用统计
  accessCount: number;
  lastAccessedAt?: string;
  
  // 自动化规则
  autoSaveRules?: AutoSaveRule[];
  
  // 自定义属性
  customProperties: Record<string, any>;
}

/**
 * 同步信息值对象 (Value Object)
 */
export interface SyncInfo {
  status: SyncStatus;
  lastSyncedAt?: string;
  syncVersion: number;
  conflictResolution?: ConflictResolution;
  deviceId?: string;
  userId?: string;
}

/**
 * 标签组统计信息值对象 (Value Object)
 */
export interface GroupStatistics {
  totalTabs: number;
  uniqueDomains: number;
  totalSize: number; // 字节
  averageLoadTime?: number;
  lastModified: string;
  
  // 使用模式
  usagePattern: {
    hourlyDistribution: number[]; // 24小时分布
    weeklyDistribution: number[]; // 7天分布
    peakUsageTime?: string;
  };
}

/**
 * 自动保存规则值对象 (Value Object)
 */
export interface AutoSaveRule {
  id: string;
  name: string;
  enabled: boolean;
  
  // 触发条件
  triggers: {
    domainPatterns?: string[];
    titlePatterns?: string[];
    tabCountThreshold?: number;
    timeThreshold?: number; // 分钟
  };
  
  // 执行动作
  actions: {
    groupName?: string;
    autoLock?: boolean;
    notification?: boolean;
  };
}

/**
 * 冲突解决策略值对象 (Value Object)
 */
export interface ConflictResolution {
  strategy: 'local' | 'remote' | 'merge' | 'manual';
  timestamp: string;
  resolvedBy?: string;
  details?: string;
}

/**
 * 枚举类型定义
 */

/**
 * 同步状态枚举
 */
export enum SyncStatus {
  SYNCED = 'synced',
  LOCAL_ONLY = 'local-only',
  REMOTE_ONLY = 'remote-only',
  CONFLICT = 'conflict',
  SYNCING = 'syncing',
  ERROR = 'error'
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
 * 标签相关事件
 */
export interface TabCreatedEvent extends DomainEvent {
  type: 'TabCreated';
  data: {
    tab: Tab;
    groupId?: string;
  };
}

export interface TabUpdatedEvent extends DomainEvent {
  type: 'TabUpdated';
  data: {
    tabId: string;
    changes: Partial<Tab>;
    previousVersion: Tab;
  };
}

export interface TabDeletedEvent extends DomainEvent {
  type: 'TabDeleted';
  data: {
    tabId: string;
    groupId?: string;
  };
}

/**
 * 标签组相关事件
 */
export interface TabGroupCreatedEvent extends DomainEvent {
  type: 'TabGroupCreated';
  data: {
    group: TabGroup;
  };
}

export interface TabGroupUpdatedEvent extends DomainEvent {
  type: 'TabGroupUpdated';
  data: {
    groupId: string;
    changes: Partial<TabGroup>;
    previousVersion: TabGroup;
  };
}

export interface TabGroupDeletedEvent extends DomainEvent {
  type: 'TabGroupDeleted';
  data: {
    groupId: string;
    tabCount: number;
  };
}

export interface TabMovedEvent extends DomainEvent {
  type: 'TabMoved';
  data: {
    tabId: string;
    fromGroupId?: string;
    toGroupId?: string;
    fromIndex: number;
    toIndex: number;
  };
}

/**
 * 业务规则验证接口
 */
export interface ValidationRule<T> {
  name: string;
  validate: (entity: T) => ValidationResult;
}

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
 * 领域服务接口
 */
export interface TabDomainService {
  createTab(data: CreateTabData): Promise<Tab>;
  updateTab(id: string, updates: Partial<Tab>): Promise<Tab>;
  deleteTab(id: string): Promise<void>;
  validateTab(tab: Tab): ValidationResult;
}

export interface TabGroupDomainService {
  createTabGroup(data: CreateTabGroupData): Promise<TabGroup>;
  updateTabGroup(id: string, updates: Partial<TabGroup>): Promise<TabGroup>;
  deleteTabGroup(id: string): Promise<void>;
  addTabToGroup(groupId: string, tab: Tab): Promise<TabGroup>;
  removeTabFromGroup(groupId: string, tabId: string): Promise<TabGroup>;
  validateTabGroup(group: TabGroup): ValidationResult;
}

/**
 * 创建数据传输对象
 */
export interface CreateTabData {
  url: string;
  title: string;
  favIconUrl?: string;
  groupId?: string;
  metadata?: Partial<TabMetadata>;
}

export interface CreateTabGroupData {
  name: string;
  description?: string;
  color?: GroupColor;
  tabs?: CreateTabData[];
  metadata?: Partial<GroupMetadata>;
}

/**
 * 查询对象
 */
export interface TabQuery {
  groupId?: string;
  domain?: string;
  tags?: string[];
  syncStatus?: SyncStatus;
  dateRange?: {
    start: string;
    end: string;
  };
  limit?: number;
  offset?: number;
  sortBy?: 'createdAt' | 'lastAccessedAt' | 'title' | 'url';
  sortOrder?: 'asc' | 'desc';
}

export interface TabGroupQuery {
  name?: string;
  color?: GroupColor;
  tags?: string[];
  syncStatus?: SyncStatus;
  isLocked?: boolean;
  dateRange?: {
    start: string;
    end: string;
  };
  limit?: number;
  offset?: number;
  sortBy?: 'createdAt' | 'updatedAt' | 'name' | 'order';
  sortOrder?: 'asc' | 'desc';
}

/**
 * 仓储接口定义
 */
export interface TabRepository {
  findById(id: string): Promise<Tab | null>;
  findByQuery(query: TabQuery): Promise<Tab[]>;
  save(tab: Tab): Promise<void>;
  delete(id: string): Promise<void>;
  count(query?: TabQuery): Promise<number>;
}

export interface TabGroupRepository {
  findById(id: string): Promise<TabGroup | null>;
  findByQuery(query: TabGroupQuery): Promise<TabGroup[]>;
  save(group: TabGroup): Promise<void>;
  delete(id: string): Promise<void>;
  count(query?: TabGroupQuery): Promise<number>;
}

/**
 * 工厂接口
 */
export interface TabFactory {
  createTab(data: CreateTabData): Tab;
  createTabFromBrowserTab(browserTab: chrome.tabs.Tab): Tab;
}

export interface TabGroupFactory {
  createTabGroup(data: CreateTabGroupData): TabGroup;
  createTabGroupFromTabs(tabs: Tab[], name?: string): TabGroup;
}
