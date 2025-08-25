/**
 * 同步领域实体定义
 * 遵循领域驱动设计(DDD)原则，定义同步相关的核心业务实体和值对象
 */

/**
 * 同步操作实体 (Entity)
 * 同步操作是同步领域的核心实体，记录每次同步的详细信息
 */
export interface SyncOperation {
  // 实体标识
  readonly id: string;
  
  // 操作信息
  type: SyncOperationType;
  direction: SyncDirection;
  status: SyncOperationStatus;
  
  // 关联信息
  userId: string;
  deviceId: string;
  sessionId?: string;
  
  // 数据信息
  dataType: SyncDataType;
  entityIds: string[];
  
  // 时间戳
  readonly createdAt: string;
  startedAt?: string;
  completedAt?: string;
  
  // 结果信息
  result?: SyncResult;
  error?: SyncError;
  
  // 元数据
  metadata: SyncMetadata;
  
  // 进度信息
  progress: SyncProgress;
}

/**
 * 同步冲突实体 (Entity)
 * 管理同步过程中发生的数据冲突
 */
export interface SyncConflict {
  // 实体标识
  readonly id: string;
  
  // 冲突信息
  entityType: SyncDataType;
  entityId: string;
  
  // 冲突数据
  localVersion: ConflictVersion;
  remoteVersion: ConflictVersion;
  
  // 解决信息
  resolution?: ConflictResolution;
  resolvedAt?: string;
  resolvedBy?: string;
  
  // 状态
  status: ConflictStatus;
  
  // 时间戳
  readonly createdAt: string;
  updatedAt: string;
  
  // 元数据
  metadata: ConflictMetadata;
}

/**
 * 同步策略值对象 (Value Object)
 * 定义同步的策略和规则
 */
export interface SyncStrategy {
  // 基本策略
  mode: SyncMode;
  direction: SyncDirection;
  
  // 冲突解决
  conflictResolution: ConflictResolutionStrategy;
  
  // 频率控制
  frequency: SyncFrequency;
  
  // 数据过滤
  dataFilters: SyncDataFilter[];
  
  // 性能控制
  batchSize: number;
  maxRetries: number;
  timeout: number; // milliseconds
  
  // 条件控制
  conditions: SyncCondition[];
}

/**
 * 同步状态值对象 (Value Object)
 * 表示当前的同步状态
 */
export interface SyncStatus {
  // 整体状态
  overall: OverallSyncStatus;
  
  // 各数据类型状态
  dataTypeStatus: Record<SyncDataType, DataTypeSyncStatus>;
  
  // 最后同步信息
  lastSync?: {
    timestamp: string;
    operationId: string;
    result: SyncResult;
  };
  
  // 下次同步信息
  nextSync?: {
    scheduledAt: string;
    estimatedDuration: number;
  };
  
  // 统计信息
  statistics: SyncStatistics;
}

/**
 * 同步结果值对象 (Value Object)
 */
export interface SyncResult {
  // 结果状态
  success: boolean;
  
  // 处理统计
  processed: {
    total: number;
    created: number;
    updated: number;
    deleted: number;
    skipped: number;
  };
  
  // 冲突信息
  conflicts: {
    total: number;
    resolved: number;
    pending: number;
  };
  
  // 性能信息
  performance: {
    duration: number; // milliseconds
    throughput: number; // items per second
    bandwidth: number; // bytes per second
  };
  
  // 错误信息
  errors: SyncError[];
  warnings: SyncWarning[];
}

/**
 * 同步错误值对象 (Value Object)
 */
export interface SyncError {
  code: string;
  message: string;
  details?: Record<string, any>;
  entityId?: string;
  retryable: boolean;
  timestamp: string;
}

/**
 * 同步警告值对象 (Value Object)
 */
export interface SyncWarning {
  code: string;
  message: string;
  details?: Record<string, any>;
  entityId?: string;
  timestamp: string;
}

/**
 * 同步元数据值对象 (Value Object)
 */
export interface SyncMetadata {
  // 客户端信息
  clientVersion: string;
  clientPlatform: string;
  
  // 网络信息
  networkType?: string;
  connectionQuality?: 'excellent' | 'good' | 'fair' | 'poor';
  
  // 数据信息
  dataSize: number; // bytes
  compressionRatio?: number;
  
  // 自定义属性
  customProperties: Record<string, any>;
}

/**
 * 同步进度值对象 (Value Object)
 */
export interface SyncProgress {
  // 进度信息
  current: number;
  total: number;
  percentage: number;
  
  // 当前阶段
  stage: SyncStage;
  stageProgress: number;
  
  // 时间估算
  estimatedTimeRemaining?: number; // milliseconds
  
  // 速度信息
  currentSpeed?: number; // items per second
  averageSpeed?: number; // items per second
}

/**
 * 冲突版本值对象 (Value Object)
 */
export interface ConflictVersion {
  data: Record<string, any>;
  version: number;
  timestamp: string;
  deviceId: string;
  userId: string;
  checksum: string;
}

/**
 * 冲突解决值对象 (Value Object)
 */
export interface ConflictResolution {
  strategy: ConflictResolutionStrategy;
  chosenVersion: 'local' | 'remote' | 'merged';
  mergedData?: Record<string, any>;
  reason?: string;
  automatic: boolean;
}

/**
 * 冲突元数据值对象 (Value Object)
 */
export interface ConflictMetadata {
  // 冲突类型
  conflictType: ConflictType;
  
  // 差异信息
  differences: FieldDifference[];
  
  // 影响评估
  impact: ConflictImpact;
  
  // 建议解决方案
  suggestedResolution?: ConflictResolutionStrategy;
}

/**
 * 字段差异值对象 (Value Object)
 */
export interface FieldDifference {
  field: string;
  localValue: any;
  remoteValue: any;
  type: 'added' | 'removed' | 'modified';
}

/**
 * 同步数据过滤器值对象 (Value Object)
 */
export interface SyncDataFilter {
  type: 'include' | 'exclude';
  criteria: {
    entityType?: SyncDataType;
    dateRange?: {
      start: string;
      end: string;
    };
    properties?: Record<string, any>;
    tags?: string[];
  };
}

/**
 * 同步条件值对象 (Value Object)
 */
export interface SyncCondition {
  type: 'network' | 'battery' | 'time' | 'data' | 'user';
  operator: 'equals' | 'not_equals' | 'greater_than' | 'less_than' | 'contains';
  value: any;
  required: boolean;
}

/**
 * 同步统计信息值对象 (Value Object)
 */
export interface SyncStatistics {
  // 总体统计
  totalOperations: number;
  successfulOperations: number;
  failedOperations: number;
  
  // 数据统计
  totalDataSynced: number; // bytes
  totalItemsSynced: number;
  
  // 时间统计
  totalSyncTime: number; // milliseconds
  averageSyncTime: number; // milliseconds
  
  // 冲突统计
  totalConflicts: number;
  resolvedConflicts: number;
  pendingConflicts: number;
  
  // 最近活动
  lastSuccessfulSync?: string;
  lastFailedSync?: string;
}

/**
 * 枚举类型定义
 */

/**
 * 同步操作类型枚举
 */
export enum SyncOperationType {
  FULL_SYNC = 'full-sync',
  INCREMENTAL_SYNC = 'incremental-sync',
  PUSH = 'push',
  PULL = 'pull',
  CONFLICT_RESOLUTION = 'conflict-resolution'
}

/**
 * 同步方向枚举
 */
export enum SyncDirection {
  BIDIRECTIONAL = 'bidirectional',
  UPLOAD_ONLY = 'upload-only',
  DOWNLOAD_ONLY = 'download-only'
}

/**
 * 同步操作状态枚举
 */
export enum SyncOperationStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  PAUSED = 'paused'
}

/**
 * 同步数据类型枚举
 */
export enum SyncDataType {
  TAB_GROUPS = 'tab-groups',
  TABS = 'tabs',
  SETTINGS = 'settings',
  USER_PROFILE = 'user-profile',
  SEARCH_HISTORY = 'search-history'
}

/**
 * 冲突状态枚举
 */
export enum ConflictStatus {
  PENDING = 'pending',
  RESOLVED = 'resolved',
  IGNORED = 'ignored',
  ESCALATED = 'escalated'
}

/**
 * 同步模式枚举
 */
export enum SyncMode {
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
  MANUAL = 'manual',
  MERGE = 'merge'
}

/**
 * 同步频率枚举
 */
export enum SyncFrequency {
  REAL_TIME = 'real-time',
  EVERY_MINUTE = 'every-minute',
  EVERY_5_MINUTES = 'every-5-minutes',
  EVERY_15_MINUTES = 'every-15-minutes',
  EVERY_30_MINUTES = 'every-30-minutes',
  HOURLY = 'hourly',
  DAILY = 'daily',
  WEEKLY = 'weekly',
  MANUAL = 'manual'
}

/**
 * 整体同步状态枚举
 */
export enum OverallSyncStatus {
  SYNCED = 'synced',
  SYNCING = 'syncing',
  OUT_OF_SYNC = 'out-of-sync',
  ERROR = 'error',
  DISABLED = 'disabled'
}

/**
 * 数据类型同步状态枚举
 */
export enum DataTypeSyncStatus {
  SYNCED = 'synced',
  SYNCING = 'syncing',
  PENDING = 'pending',
  ERROR = 'error',
  CONFLICT = 'conflict'
}

/**
 * 同步阶段枚举
 */
export enum SyncStage {
  INITIALIZING = 'initializing',
  FETCHING_CHANGES = 'fetching-changes',
  RESOLVING_CONFLICTS = 'resolving-conflicts',
  APPLYING_CHANGES = 'applying-changes',
  UPLOADING_CHANGES = 'uploading-changes',
  FINALIZING = 'finalizing'
}

/**
 * 冲突类型枚举
 */
export enum ConflictType {
  UPDATE_UPDATE = 'update-update',
  UPDATE_DELETE = 'update-delete',
  DELETE_UPDATE = 'delete-update',
  CREATE_CREATE = 'create-create'
}

/**
 * 冲突影响枚举
 */
export enum ConflictImpact {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical'
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
 * 同步相关事件
 */
export interface SyncOperationStartedEvent extends DomainEvent {
  type: 'SyncOperationStarted';
  data: {
    operation: SyncOperation;
  };
}

export interface SyncOperationCompletedEvent extends DomainEvent {
  type: 'SyncOperationCompleted';
  data: {
    operationId: string;
    result: SyncResult;
  };
}

export interface SyncOperationFailedEvent extends DomainEvent {
  type: 'SyncOperationFailed';
  data: {
    operationId: string;
    error: SyncError;
  };
}

export interface SyncConflictDetectedEvent extends DomainEvent {
  type: 'SyncConflictDetected';
  data: {
    conflict: SyncConflict;
  };
}

export interface SyncConflictResolvedEvent extends DomainEvent {
  type: 'SyncConflictResolved';
  data: {
    conflictId: string;
    resolution: ConflictResolution;
  };
}

/**
 * 创建数据传输对象
 */
export interface CreateSyncOperationData {
  type: SyncOperationType;
  direction: SyncDirection;
  dataType: SyncDataType;
  entityIds?: string[];
  strategy?: Partial<SyncStrategy>;
  metadata?: Partial<SyncMetadata>;
}

export interface CreateSyncConflictData {
  entityType: SyncDataType;
  entityId: string;
  localVersion: ConflictVersion;
  remoteVersion: ConflictVersion;
  metadata?: Partial<ConflictMetadata>;
}

/**
 * 查询对象
 */
export interface SyncOperationQuery {
  userId?: string;
  deviceId?: string;
  type?: SyncOperationType;
  status?: SyncOperationStatus;
  dataType?: SyncDataType;
  dateRange?: {
    start: string;
    end: string;
  };
  limit?: number;
  offset?: number;
  sortBy?: 'createdAt' | 'startedAt' | 'completedAt';
  sortOrder?: 'asc' | 'desc';
}

export interface SyncConflictQuery {
  entityType?: SyncDataType;
  status?: ConflictStatus;
  userId?: string;
  dateRange?: {
    start: string;
    end: string;
  };
  limit?: number;
  offset?: number;
  sortBy?: 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
}

/**
 * 仓储接口定义
 */
export interface SyncOperationRepository {
  findById(id: string): Promise<SyncOperation | null>;
  findByQuery(query: SyncOperationQuery): Promise<SyncOperation[]>;
  save(operation: SyncOperation): Promise<void>;
  delete(id: string): Promise<void>;
  count(query?: SyncOperationQuery): Promise<number>;
}

export interface SyncConflictRepository {
  findById(id: string): Promise<SyncConflict | null>;
  findByQuery(query: SyncConflictQuery): Promise<SyncConflict[]>;
  save(conflict: SyncConflict): Promise<void>;
  delete(id: string): Promise<void>;
  count(query?: SyncConflictQuery): Promise<number>;
}

/**
 * 领域服务接口
 */
export interface SyncDomainService {
  createSyncOperation(data: CreateSyncOperationData): Promise<SyncOperation>;
  executeSyncOperation(operationId: string): Promise<SyncResult>;
  cancelSyncOperation(operationId: string): Promise<void>;
  getSyncStatus(userId: string): Promise<SyncStatus>;
}

export interface ConflictResolutionService {
  createConflict(data: CreateSyncConflictData): Promise<SyncConflict>;
  resolveConflict(conflictId: string, resolution: ConflictResolution): Promise<void>;
  getConflictSuggestion(conflictId: string): Promise<ConflictResolutionStrategy>;
}

/**
 * 工厂接口
 */
export interface SyncOperationFactory {
  createSyncOperation(data: CreateSyncOperationData): SyncOperation;
}

export interface SyncConflictFactory {
  createSyncConflict(data: CreateSyncConflictData): SyncConflict;
}
