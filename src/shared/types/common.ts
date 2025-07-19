/**
 * 通用类型定义
 * 提供项目中常用的基础类型和工具类型
 */

/**
 * 基础实体接口
 * 所有实体都应该继承此接口
 */
export interface BaseEntity {
  readonly id: string;
  readonly createdAt: string;
  updatedAt: string;
}

/**
 * 基础值对象接口
 * 所有值对象都应该实现此接口
 */
export interface ValueObject {
  equals(other: ValueObject): boolean;
}

/**
 * 分页查询参数
 */
export interface PaginationParams {
  page: number;
  pageSize: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

/**
 * 分页查询结果
 */
export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

/**
 * API响应基础结构
 */
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, any>;
  };
  metadata?: {
    timestamp: string;
    requestId: string;
    version: string;
  };
}

/**
 * 异步操作状态
 */
export interface AsyncState<T = any> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  lastUpdated: string | null;
}

/**
 * 操作结果
 */
export interface OperationResult<T = any> {
  success: boolean;
  data?: T;
  error?: Error;
  message?: string;
  metadata?: Record<string, any>;
}

/**
 * 验证结果
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
  value?: any;
}

export interface ValidationWarning {
  field: string;
  message: string;
  code: string;
  value?: any;
}

/**
 * 配置接口基类
 */
export interface BaseConfig {
  enabled: boolean;
  timeout?: number;
  retries?: number;
  debug?: boolean;
}

/**
 * 事件接口
 */
export interface BaseEvent {
  readonly id: string;
  readonly type: string;
  readonly timestamp: string;
  readonly source: string;
  readonly data: Record<string, any>;
}

/**
 * 错误类型枚举
 */
export enum ErrorType {
  VALIDATION = 'validation',
  NETWORK = 'network',
  AUTH = 'auth',
  PERMISSION = 'permission',
  NOT_FOUND = 'not_found',
  CONFLICT = 'conflict',
  SERVER = 'server',
  CLIENT = 'client',
  UNKNOWN = 'unknown'
}

/**
 * 状态枚举
 */
export enum Status {
  IDLE = 'idle',
  PENDING = 'pending',
  SUCCESS = 'success',
  ERROR = 'error',
  CANCELLED = 'cancelled'
}

/**
 * 优先级枚举
 */
export enum Priority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical'
}

/**
 * 工具类型定义
 */

/**
 * 深度只读类型
 */
export type DeepReadonly<T> = {
  readonly [P in keyof T]: T[P] extends object ? DeepReadonly<T[P]> : T[P];
};

/**
 * 深度可选类型
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

/**
 * 非空类型
 */
export type NonNullable<T> = T extends null | undefined ? never : T;

/**
 * 提取Promise的返回类型
 */
export type PromiseType<T> = T extends Promise<infer U> ? U : T;

/**
 * 函数参数类型
 */
export type FunctionArgs<T> = T extends (...args: infer A) => any ? A : never;

/**
 * 函数返回类型
 */
export type FunctionReturn<T> = T extends (...args: any[]) => infer R ? R : never;

/**
 * 键值对类型
 */
export type KeyValuePair<K extends string | number | symbol = string, V = any> = {
  [key in K]: V;
};

/**
 * 字符串字面量联合类型
 */
export type StringLiteral<T> = T extends string ? (string extends T ? never : T) : never;

/**
 * 数组元素类型
 */
export type ArrayElement<T> = T extends (infer U)[] ? U : never;

/**
 * 对象值类型
 */
export type ObjectValues<T> = T[keyof T];

/**
 * 条件类型工具
 */
export type If<C extends boolean, T, F> = C extends true ? T : F;

/**
 * 排除指定键的类型
 */
export type OmitByValue<T, V> = {
  [K in keyof T as T[K] extends V ? never : K]: T[K];
};

/**
 * 选择指定键的类型
 */
export type PickByValue<T, V> = {
  [K in keyof T as T[K] extends V ? K : never]: T[K];
};

/**
 * 可选键类型
 */
export type OptionalKeys<T> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? K : never;
}[keyof T];

/**
 * 必需键类型
 */
export type RequiredKeys<T> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? never : K;
}[keyof T];

/**
 * 创建可选字段的类型
 */
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/**
 * 创建必需字段的类型
 */
export type MakeRequired<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>;

/**
 * 递归键路径类型（限制深度避免无限递归）
 */
export type KeyPath<T, Depth extends number = 3> = Depth extends 0
  ? never
  : {
      [K in keyof T]: T[K] extends object
        ? K | `${K & string}.${KeyPath<T[K], Prev<Depth>> & string}`
        : K;
    }[keyof T];

// 辅助类型：递减数字
type Prev<T extends number> = T extends 0
  ? never
  : T extends 1
  ? 0
  : T extends 2
  ? 1
  : T extends 3
  ? 2
  : T extends 4
  ? 3
  : never;

/**
 * 根据键路径获取值类型
 */
export type GetByPath<T, P extends string> = P extends `${infer K}.${infer Rest}`
  ? K extends keyof T
    ? GetByPath<T[K], Rest>
    : never
  : P extends keyof T
  ? T[P]
  : never;

/**
 * 事件处理器类型
 */
export type EventHandler<T = any> = (event: T) => void | Promise<void>;

/**
 * 异步函数类型
 */
export type AsyncFunction<T extends any[] = any[], R = any> = (...args: T) => Promise<R>;

/**
 * 回调函数类型
 */
export type Callback<T = void> = () => T;
export type CallbackWithArgs<T extends any[] = any[], R = void> = (...args: T) => R;

/**
 * 订阅者类型
 */
export type Subscriber<T = any> = (data: T) => void;

/**
 * 取消订阅函数类型
 */
export type Unsubscribe = () => void;

/**
 * 比较函数类型
 */
export type Comparator<T> = (a: T, b: T) => number;

/**
 * 过滤函数类型
 */
export type Predicate<T> = (item: T) => boolean;

/**
 * 映射函数类型
 */
export type Mapper<T, R> = (item: T, index?: number) => R;

/**
 * 归约函数类型
 */
export type Reducer<T, R> = (accumulator: R, current: T, index?: number) => R;

/**
 * 选择器类型
 */
export type Selector<T, R> = (state: T) => R;

/**
 * 动作类型
 */
export interface Action<T = any> {
  type: string;
  payload?: T;
  meta?: Record<string, any>;
  error?: boolean;
}

/**
 * 动作创建器类型
 */
export type ActionCreator<T = any> = (...args: any[]) => Action<T>;

/**
 * 中间件类型
 */
export type Middleware<T = any> = (context: T) => (next: Function) => (action: any) => any;

/**
 * 配置提供者类型
 */
export interface ConfigProvider<T = any> {
  get<K extends keyof T>(key: K): T[K];
  set<K extends keyof T>(key: K, value: T[K]): void;
  has<K extends keyof T>(key: K): boolean;
  delete<K extends keyof T>(key: K): boolean;
  clear(): void;
  getAll(): T;
}

/**
 * 缓存接口
 */
export interface Cache<K = string, V = any> {
  get(key: K): V | undefined;
  set(key: K, value: V, ttl?: number): void;
  has(key: K): boolean;
  delete(key: K): boolean;
  clear(): void;
  size(): number;
  keys(): K[];
  values(): V[];
}

/**
 * 日志级别
 */
export enum LogLevel {
  TRACE = 'trace',
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
  FATAL = 'fatal'
}

/**
 * 日志记录接口
 */
export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  context?: string;
  data?: Record<string, any>;
  error?: Error;
}

/**
 * 日志记录器接口
 */
export interface Logger {
  trace(message: string, data?: any): void;
  debug(message: string, data?: any): void;
  info(message: string, data?: any): void;
  warn(message: string, data?: any): void;
  error(message: string, error?: Error, data?: any): void;
  fatal(message: string, error?: Error, data?: any): void;
}

/**
 * 环境变量类型
 */
export interface Environment {
  NODE_ENV: 'development' | 'production' | 'test';
  API_URL?: string;
  DEBUG?: boolean;
  VERSION?: string;
}

/**
 * 浏览器信息类型
 */
export interface BrowserInfo {
  name: string;
  version: string;
  userAgent: string;
  platform: string;
  language: string;
  cookieEnabled: boolean;
  onLine: boolean;
}

/**
 * 设备信息类型
 */
export interface DeviceInfo {
  type: 'desktop' | 'mobile' | 'tablet' | 'unknown';
  os: string;
  browser: BrowserInfo;
  screen: {
    width: number;
    height: number;
    pixelRatio: number;
  };
  timezone: string;
  locale: string;
}

/**
 * 位置信息类型
 */
export interface LocationInfo {
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  country?: string;
  region?: string;
  city?: string;
  timezone?: string;
}

/**
 * 文件信息类型
 */
export interface FileInfo {
  name: string;
  size: number;
  type: string;
  lastModified: number;
  path?: string;
  url?: string;
}

/**
 * 网络状态类型
 */
export interface NetworkStatus {
  online: boolean;
  type?: 'wifi' | 'cellular' | 'ethernet' | 'unknown';
  effectiveType?: 'slow-2g' | '2g' | '3g' | '4g';
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}
